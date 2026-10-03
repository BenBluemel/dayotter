import { randomUUID } from "node:crypto";
import {
  type Database,
  and,
  eq,
  getDb,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  schema,
} from "@dayotter/db";
import { restoreBookingCredit } from "../packages/credits";
import { originalBookingRefundRoute } from "./booking-routing";
import { validatePaymentIntentTerms } from "./payment-success";
import { requirePaymentReview } from "./payment-work";
import { retryAt } from "./recovery-backoff";
import {
  REFUND_REPLAY_WINDOW_MS,
  type RefundOperation,
  refundRoute,
  verifyRefundCharge,
  verifyRefundEvidence,
} from "./refund-terms";
import { PaymentContradictionError } from "./routing";
import {
  createOperationRefund,
  listOperationRefunds,
  retrieveOperationRefund,
  retrievePaymentIntent,
  retrieveRefundCharge,
} from "./stripe";

export type PublicRefundState =
  | "none"
  | "processing"
  | "refunded"
  | "requires_review"
  | "legacy_unknown";
export function publicRefundState(operation: RefundOperation): PublicRefundState {
  if (operation.state === "requires_review" || operation.reviewCode) return "requires_review";
  return operation.state === "succeeded" ? "refunded" : "processing";
}

/** Existing authorization lives at the capability-UID/API callers. Lock order is
 * attempt -> booking -> operation, shared with fulfillment/finalization. No Stripe I/O here. */
export async function decideBookingCancellation(
  uid: string,
  reason?: string,
  db: Database = getDb(),
) {
  return db.transaction(async (tx) => {
    const candidate = await tx.query.bookings.findFirst({ where: eq(schema.bookings.uid, uid) });
    if (!candidate) return null;
    const [attempt] = await tx
      .select()
      .from(schema.paymentAttempts)
      .where(eq(schema.paymentAttempts.bookingId, candidate.id))
      .for("update");
    const [booking] = await tx
      .select()
      .from(schema.bookings)
      .where(eq(schema.bookings.id, candidate.id))
      .for("update");
    if (!booking) return null;
    const changed = booking.status !== "cancelled";
    // 0064 fulfilled attempts lack verified charge facts. They remain explicitly
    // legacy rather than inventing a RefundOperation snapshot from today's config.
    const durable = Boolean(attempt?.successFacts);
    if (durable) {
      try {
        originalBookingRefundRoute(booking, attempt);
      } catch {
        throw new PaymentContradictionError(
          "Booking settlement does not match its original payment",
        );
      }
    }
    if (durable && !["paid", "refunded"].includes(booking.paymentStatus))
      throw new PaymentContradictionError(
        "Booking settlement requires refund review before cancellation",
      );
    if (changed)
      await tx
        .update(schema.bookings)
        .set({ status: "cancelled", cancelledAt: new Date(), cancelReason: reason ?? null })
        .where(eq(schema.bookings.id, booking.id));
    const creditRestoration = await restoreBookingCredit(tx, booking);
    let operation: RefundOperation | undefined;
    if (durable && attempt) {
      operation = await tx.query.refundOperations.findFirst({
        where: eq(schema.refundOperations.attemptId, attempt.id),
      });
      if (!operation) {
        const id = randomUUID();
        const facts = attempt.successFacts!;
        [operation] = await tx
          .insert(schema.refundOperations)
          .values({
            id,
            organizationId: attempt.organizationId,
            bookingId: booking.id,
            attemptId: attempt.id,
            paymentIntentId: facts.paymentIntentId,
            chargeId: facts.chargeId,
            amount: facts.amount,
            currency: facts.currency,
            paymentMode: facts.paymentMode,
            environment: facts.environment,
            chargeAccountId: facts.chargeAccountId,
            credentialContext: facts.credentialContext,
            destinationAccountId: facts.destinationAccountId,
            applicationFeeAmount: facts.applicationFeeAmount,
            idempotencyKey: `appointment-refund:${id}:v1`,
          })
          .returning();
        if (booking.paymentStatus === "refunded") {
          [operation] = await tx
            .update(schema.refundOperations)
            .set({ state: "requires_review", reviewCode: "historical_refund_without_operation" })
            .where(eq(schema.refundOperations.id, id))
            .returning();
        }
      }
      // Stop pending finalization from starting after cancellation. An already
      // running provider call cannot be undone; preserve visible cleanup review.
      if (attempt.finalizationState === "pending" || attempt.finalizationState === "running")
        await tx
          .update(schema.paymentAttempts)
          .set({
            finalizationState: "requires_review",
            finalizationReviewCode:
              attempt.finalizationState === "running"
                ? "cancelled_during_finalization"
                : "cancelled_before_finalization",
          })
          .where(eq(schema.paymentAttempts.id, attempt.id));
    }
    return { booking, changed, durable, operation, creditRestoration };
  });
}

async function recordRefundReview(id: string, code: string, db: Database) {
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(schema.refundOperations)
      .where(eq(schema.refundOperations.id, id))
      .for("update");
    if (!current) return;
    await tx
      .update(schema.refundOperations)
      .set({
        state: current.state === "succeeded" ? "succeeded" : "requires_review",
        reviewCode: code,
      })
      .where(eq(schema.refundOperations.id, id));
  });
}

/** Idempotency covers concurrent outbound calls; row locks serialize observations.
 * No process lease or open DB transaction is held while waiting for Stripe. */
export async function executeRefundOperation(
  id: string,
  db: Database = getDb(),
): Promise<PublicRefundState> {
  const operation = await db.query.refundOperations.findFirst({
    where: eq(schema.refundOperations.id, id),
  });
  if (!operation) throw new Error("Refund operation is missing");
  if (["succeeded", "requires_review"].includes(operation.state))
    return publicRefundState(operation);
  try {
    let refundId = operation.stripeRefundId;
    if (!refundId) {
      const refunds = await listOperationRefunds(operation);
      const matches = refunds.filter(
        (refund) => refund.metadata?.refundOperationId === operation.id,
      );
      if (refunds.length !== matches.length || matches.length > 1)
        throw new PaymentContradictionError("External or conflicting refunds require review");
      if (matches.length) refundId = matches[0]!.id;
      else {
        const attempt = await db.query.paymentAttempts.findFirst({
          where: eq(schema.paymentAttempts.id, operation.attemptId),
        });
        if (!attempt?.successFacts)
          throw new PaymentContradictionError("Refund payment facts are missing");
        const pi = await retrievePaymentIntent(operation.paymentIntentId, refundRoute(operation));
        validatePaymentIntentTerms(attempt, operation.paymentIntentId, pi);
        if (pi.status !== "succeeded" || pi.amount_received !== operation.amount)
          throw new PaymentContradictionError("Refund payment has not settled as expected");
        const charge = await retrieveRefundCharge(operation);
        verifyRefundCharge(operation, charge);
        if (charge.amount_refunded !== 0) {
          // Another worker may have created the refund between our list and
          // charge reads. Retry reconciliation, never classify that race as a
          // contradiction or submit a new financial operation.
          const latest = await db.query.refundOperations.findFirst({
            where: eq(schema.refundOperations.id, id),
          });
          if (latest && ["succeeded", "requires_review"].includes(latest.state))
            return publicRefundState(latest);
          if (
            !latest?.firstSubmittedAt ||
            Date.now() >= latest.firstSubmittedAt.getTime() + REFUND_REPLAY_WINDOW_MS
          )
            throw new PaymentContradictionError(
              "Refunded charge has no reconcilable operation identity",
            );
          throw new Error(
            "Refund became visible during reconciliation; retry the original operation",
          );
        }
        const claimed = await db.transaction(async (tx) => {
          const [current] = await tx
            .select()
            .from(schema.refundOperations)
            .where(eq(schema.refundOperations.id, id))
            .for("update");
          if (
            !current ||
            ["succeeded", "requires_review"].includes(current.state) ||
            current.stripeRefundId
          )
            return current;
          if (
            current.firstSubmittedAt &&
            Date.now() >= current.firstSubmittedAt.getTime() + REFUND_REPLAY_WINDOW_MS
          ) {
            const [review] = await tx
              .update(schema.refundOperations)
              .set({
                state: "requires_review",
                reviewCode: "refund_creation_ambiguous_after_replay_window",
              })
              .where(eq(schema.refundOperations.id, id))
              .returning();
            return review;
          }
          const [saved] = await tx
            .update(schema.refundOperations)
            .set({
              state: "submitting",
              firstSubmittedAt: current.firstSubmittedAt ?? new Date(),
              reviewCode: null,
            })
            .where(eq(schema.refundOperations.id, id))
            .returning();
          return saved;
        });
        if (!claimed) throw new Error("Refund operation is missing");
        if (["succeeded", "requires_review"].includes(claimed.state))
          return publicRefundState(claimed);
        refundId = claimed.stripeRefundId ?? (await createOperationRefund(claimed)).id;
        // Bind immediately, even before the verification read, so a read outage
        // never sends another create for a known Refund. Guards make IDs write-once.
      }
    }
    await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.refundOperations)
        .where(eq(schema.refundOperations.id, id))
        .for("update");
      if (!current) throw new Error("Refund operation is missing");
      if (current.stripeRefundId && current.stripeRefundId !== refundId)
        throw new PaymentContradictionError("Refund ID conflicts with the original operation");
      await tx
        .update(schema.refundOperations)
        .set({ stripeRefundId: refundId })
        .where(eq(schema.refundOperations.id, id));
    });
    const evidence = await retrieveOperationRefund(operation, refundId!);
    await db.transaction(async (tx) => {
      // Same order as cancellation/finalization; no lock inversion at completion.
      await tx
        .select()
        .from(schema.paymentAttempts)
        .where(eq(schema.paymentAttempts.id, operation.attemptId))
        .for("update");
      const [booking] = await tx
        .select()
        .from(schema.bookings)
        .where(eq(schema.bookings.id, operation.bookingId))
        .for("update");
      const [current] = await tx
        .select()
        .from(schema.refundOperations)
        .where(eq(schema.refundOperations.id, id))
        .for("update");
      if (!current) throw new Error("Refund operation is missing");
      const status = verifyRefundEvidence(current, evidence);
      if (!booking || booking.status !== "cancelled")
        throw new PaymentContradictionError("Refund booking is not cancelled");
      if (current.state === "requires_review") return;
      // An older pending read must not overwrite another worker's success.
      if (current.state === "succeeded") return;
      const state =
        status === "succeeded" ? "succeeded" : status === "pending" ? "pending" : "requires_review";
      await tx
        .update(schema.refundOperations)
        .set({
          state,
          stripeStatus: status,
          succeededAt: status === "succeeded" ? new Date() : null,
          reviewCode: state === "requires_review" ? `stripe_refund_${status}` : null,
          nextRecoveryAt: new Date(Date.now() + 60000),
        })
        .where(eq(schema.refundOperations.id, id));
      if (status === "succeeded")
        await tx
          .update(schema.bookings)
          .set({ paymentStatus: "refunded" })
          .where(eq(schema.bookings.id, booking.id));
    });
  } catch (err) {
    if (err instanceof PaymentContradictionError)
      await recordRefundReview(id, "refund_facts_or_creation_contradiction", db);
    else
      await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(schema.refundOperations)
          .where(eq(schema.refundOperations.id, id))
          .for("update");
        if (!current || ["succeeded", "requires_review"].includes(current.state)) return;
        await tx
          .update(schema.refundOperations)
          .set({
            state: "retryable",
            failures: current.failures + 1,
            nextRecoveryAt: retryAt(current.failures + 1),
            reviewCode: null,
          })
          .where(eq(schema.refundOperations.id, id));
      });
  }
  return publicRefundState(
    (await db.query.refundOperations.findFirst({ where: eq(schema.refundOperations.id, id) }))!,
  );
}

/** Bounded, database-only work discovery. Pending IDs are retrieved, never recreated. */
export async function recoverRefundOperations(limit = 25, db: Database = getDb()) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Recovery limit must be 1..100");
  // Upgrade repair for Slice 3-era cancellations that predate the obligation
  // guard. Only verified durable attempts qualify; missing legacy facts are never
  // manufactured. Already-refunded rows become explicit review, not another refund.
  const missing = await db
    .select({ uid: schema.bookings.uid, attemptId: schema.paymentAttempts.id })
    .from(schema.paymentAttempts)
    .innerJoin(schema.bookings, eq(schema.paymentAttempts.bookingId, schema.bookings.id))
    .leftJoin(
      schema.refundOperations,
      eq(schema.refundOperations.attemptId, schema.paymentAttempts.id),
    )
    .where(
      and(
        eq(schema.bookings.status, "cancelled"),
        isNotNull(schema.paymentAttempts.successFacts),
        isNull(schema.refundOperations.id),
        or(
          isNull(schema.paymentAttempts.reviewCode),
          ne(schema.paymentAttempts.reviewCode, "refund_obligation_binding_requires_review"),
        ),
      ),
    )
    .orderBy(schema.paymentAttempts.createdAt)
    .limit(limit);
  for (const booking of missing) {
    try {
      await decideBookingCancellation(booking.uid, undefined, db);
    } catch (err) {
      if (!(err instanceof PaymentContradictionError)) throw err;
      // A corrupt pre-upgrade binding cannot be turned into guessed refund terms,
      // and must not keep blocking recovery of other already durable obligations.
      await requirePaymentReview(
        booking.attemptId,
        "refund_obligation_binding_requires_review",
        db,
      );
    }
  }
  const operations = await db.query.refundOperations.findMany({
    where: and(
      inArray(schema.refundOperations.state, ["owed", "submitting", "pending", "retryable"]),
      lte(schema.refundOperations.nextRecoveryAt, new Date()),
    ),
    orderBy: (t, { asc }) => [asc(t.nextRecoveryAt)],
    limit,
  });
  for (const operation of operations) await executeRefundOperation(operation.id, db);
  return { refunds: operations.length, repairedCancellations: missing.length };
}

export async function bookingRefundState(
  bookingId: string,
  db: Database = getDb(),
): Promise<PublicRefundState> {
  const operation = await db.query.refundOperations.findFirst({
    where: eq(schema.refundOperations.bookingId, bookingId),
  });
  if (operation) return publicRefundState(operation);
  const attempt = await db.query.paymentAttempts.findFirst({
    where: eq(schema.paymentAttempts.bookingId, bookingId),
  });
  return attempt?.reviewCode === "refund_obligation_binding_requires_review"
    ? "requires_review"
    : "none";
}
