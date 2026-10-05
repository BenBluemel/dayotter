import { randomUUID } from "node:crypto";
import { encryptJson, sha256hex } from "@dayotter/core";
import {
  type Database,
  and,
  eq,
  getDb,
  inArray,
  isNotNull,
  isNull,
  schema,
  withResourceTransaction,
} from "@dayotter/db";
import { BookingError } from "../booking/booking-logic";
import { canonicalJson, decodeAttempt } from "./attempt-terms";
import { fulfillObservedPayment } from "./payment-work";
import { executeRefundOperation } from "./refunds";

export interface PaidReviewCommand {
  id: string;
  attemptId: string;
  actorUserId: string;
  method: "retry" | "refund";
  /** Customer contact and consent to retry the original time or issue a full refund. */
  evidence: string;
}
export async function resolvePaidReview(command: PaidReviewCommand, db: Database = getDb()) {
  const fingerprint = sha256hex(canonicalJson(command));
  const decision = await withResourceTransaction(db, async (tx) => {
    const [attempt] = await tx
      .select()
      .from(schema.paymentAttempts)
      .where(eq(schema.paymentAttempts.id, command.attemptId))
      .for("update");
    if (!attempt) throw new BookingError("Payment review not found", 404);
    const member = await tx.query.memberships.findFirst({
      where: and(
        eq(schema.memberships.organizationId, attempt.organizationId),
        eq(schema.memberships.userId, command.actorUserId),
        inArray(schema.memberships.role, ["owner", "admin"]),
      ),
    });
    if (!member) throw new BookingError("Not authorized to resolve this payment", 403);
    const previous = await tx.query.paymentReviewActions.findFirst({
      where: eq(schema.paymentReviewActions.id, command.id),
    });
    if (previous) {
      if (previous.requestFingerprint !== fingerprint)
        throw new BookingError("This resolution request was already used", 409);
      return {
        action: previous,
        refund: await tx.query.refundOperations.findFirst({
          where: eq(schema.refundOperations.attemptId, attempt.id),
        }),
      };
    }
    const existingRefund = await tx.query.refundOperations.findFirst({
      where: eq(schema.refundOperations.attemptId, attempt.id),
    });
    if (existingRefund)
      throw new BookingError(
        "Refund resolution has already started; retry the original resolution request",
        409,
      );
    if (
      attempt.bookingId ||
      !attempt.successFacts ||
      attempt.state !== "requires_review" ||
      attempt.reviewCode !== "booking_obligation_requires_review"
    )
      throw new BookingError("This obligation is not actionable scheduling review", 409);
    const unresolved = await tx.query.paymentReviewActions.findFirst({
      where: and(
        eq(schema.paymentReviewActions.attemptId, attempt.id),
        eq(schema.paymentReviewActions.state, "active"),
      ),
    });
    if (unresolved)
      throw new BookingError(
        "A resolution is already in progress; retry its original request",
        409,
      );
    const [action] = await tx
      .insert(schema.paymentReviewActions)
      .values({
        id: command.id,
        organizationId: attempt.organizationId,
        attemptId: attempt.id,
        actorUserId: command.actorUserId,
        method: command.method,
        requestFingerprint: fingerprint,
        evidence: encryptJson({ contact: command.evidence }),
      })
      .returning();
    if (command.method === "retry") {
      await tx
        .update(schema.paymentAttempts)
        .set({ state: "payment_succeeded", reviewCode: null, nextRecoveryAt: new Date() })
        .where(eq(schema.paymentAttempts.id, attempt.id));
      return { action: action!, refund: undefined };
    }
    const facts = attempt.successFacts;
    const id = randomUUID();
    const [refund] = await tx
      .insert(schema.refundOperations)
      .values({
        id,
        organizationId: attempt.organizationId,
        bookingId: null,
        purpose: "unbooked_obligation",
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
    return { action: action!, refund };
  });
  if (decision.action.state === "active") {
    if (command.method === "refund" && decision.refund)
      await executeRefundOperation(decision.refund.id, db);
    else if (command.method === "retry") await fulfillObservedPayment(command.attemptId, db);
  }
  const action = await db.query.paymentReviewActions.findFirst({
    where: eq(schema.paymentReviewActions.id, command.id),
  });
  return { id: action!.id, state: action!.state };
}
export async function listPaidReview(
  organizationId: string,
  actorUserId: string,
  db: Database = getDb(),
) {
  const member = await db.query.memberships.findFirst({
    where: and(
      eq(schema.memberships.organizationId, organizationId),
      eq(schema.memberships.userId, actorUserId),
      inArray(schema.memberships.role, ["owner", "admin"]),
    ),
  });
  if (!member) throw new BookingError("Not authorized to review payments", 403);
  const attempts = await db.query.paymentAttempts.findMany({
    where: and(
      eq(schema.paymentAttempts.organizationId, organizationId),
      inArray(schema.paymentAttempts.state, ["payment_succeeded", "fulfilling", "requires_review"]),
      isNull(schema.paymentAttempts.bookingId),
      isNotNull(schema.paymentAttempts.successFacts),
    ),
  });
  const results = [];
  for (const attempt of attempts) {
    const refund = await db.query.refundOperations.findFirst({
      where: eq(schema.refundOperations.attemptId, attempt.id),
    });
    if (refund?.state === "succeeded") continue;
    const actions = await db.query.paymentReviewActions.findMany({
      where: eq(schema.paymentReviewActions.attemptId, attempt.id),
      orderBy: (actions, { desc }) => [desc(actions.createdAt)],
    });
    let terms: ReturnType<typeof decodeAttempt> | null = null;
    try {
      terms = decodeAttempt(attempt);
    } catch {
      /* Technical review remains discoverable; cannot resolve as contention. */
    }

    results.push({
      id: attempt.id,
      eventTypeId: attempt.eventTypeId,
      start: terms?.input.start ?? null,
      customer: terms?.input.attendee ?? null,
      reviewCode: attempt.reviewCode,
      state: attempt.state,
      amount: attempt.successFacts!.amount,
      currency: attempt.currency,
      paymentIntentId: attempt.successFacts!.paymentIntentId,
      chargeId: attempt.successFacts!.chargeId,
      route: {
        paymentMode: attempt.paymentMode,
        environment: attempt.environment,
        chargeAccountId: attempt.chargeAccountId,
        destinationAccountId: attempt.destinationAccountId,
        applicationFeeAmount: attempt.applicationFeeAmount,
      },
      actions: actions.map(({ id, method, state, actorUserId, createdAt, resolvedAt }) => ({
        id,
        method,
        state,
        actorUserId,
        createdAt,
        resolvedAt,
      })),
      refundState: refund?.state ?? null,
      actionable:
        Boolean(terms) &&
        attempt.state === "requires_review" &&
        attempt.reviewCode === "booking_obligation_requires_review" &&
        !refund &&
        !actions.some((action) => action.state === "active"),
    });
  }
  return results;
}
