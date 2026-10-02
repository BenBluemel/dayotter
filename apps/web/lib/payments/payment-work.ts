import { type Database, and, eq, getDb, inArray, isNull, schema } from "@dayotter/db";
import type Stripe from "stripe";
import { BookingError, createBooking } from "../booking/create-booking";
import {
  type PaymentAttempt,
  canonicalJson,
  decodeAttempt,
  validateAttemptSession,
} from "./attempt-terms";
import { finalizePaymentBooking } from "./payment-finalization";
import { verifiedPaymentFacts } from "./payment-success";
import { retryAt } from "./recovery-backoff";
import { PaymentContradictionError, PaymentRoutingError } from "./routing";
import { retrievePaymentIntent } from "./stripe";

export async function requirePaymentReview(
  attemptId: string,
  code: string,
  db: Database = getDb(),
) {
  await db.transaction(async (tx) => {
    const [attempt] = await tx
      .select()
      .from(schema.paymentAttempts)
      .where(eq(schema.paymentAttempts.id, attemptId))
      .for("update");
    if (!attempt) return;
    // A creation-time decision may have raced a successful Session binding/observation.
    if (
      code === "creation_ambiguous" &&
      (attempt.checkoutSessionId || attempt.successFacts || attempt.bookingId)
    )
      return;
    await tx
      .update(schema.paymentAttempts)
      .set({
        state: attempt.bookingId ? "fulfilled" : "requires_review",
        reviewCode: code,
      })
      .where(eq(schema.paymentAttempts.id, attemptId));
  });
}

/** Observation commits independently of booking creation and remains owed after a crash. */
export async function observePaymentSuccess(
  attempt: PaymentAttempt,
  session: Stripe.Checkout.Session,
  db: Database = getDb(),
) {
  const piId = validateAttemptSession(attempt, session, true)!;
  const pi = await retrievePaymentIntent(piId, decodeAttempt(attempt).route);
  const facts = verifiedPaymentFacts(attempt, session, pi);
  return db
    .transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.paymentAttempts)
        .where(eq(schema.paymentAttempts.id, attempt.id))
        .for("update");
      if (!current) throw new PaymentRoutingError("Payment attempt is missing");
      validateAttemptSession(current, session, true);
      if (current.successFacts && canonicalJson(current.successFacts) !== canonicalJson(facts)) {
        throw new PaymentContradictionError("Previously observed payment facts contradict Stripe");
      }
      const state = current.bookingId
        ? "fulfilled"
        : current.state === "requires_review" && current.reviewCode !== "creation_ambiguous"
          ? "requires_review"
          : current.state === "fulfilling"
            ? "fulfilling"
            : "payment_succeeded";
      const [saved] = await tx
        .update(schema.paymentAttempts)
        .set({
          checkoutSessionId: session.id,
          checkoutUrl: current.checkoutUrl ?? session.url,
          paymentIntentId: pi.id,
          successFacts: facts,
          paymentSucceededAt: current.paymentSucceededAt ?? new Date(),
          state,
          nextRecoveryAt: new Date(),
          reviewCode: current.reviewCode === "creation_ambiguous" ? null : current.reviewCode,
        })
        .where(eq(schema.paymentAttempts.id, attempt.id))
        .returning();
      return saved!;
    })
    .catch((error: unknown) => {
      const failure = error as {
        code?: string;
        constraint?: string;
        cause?: { code?: string; constraint?: string };
      };
      const detail = failure.cause ?? failure;
      if (
        detail.code === "23505" &&
        ["payment_attempt_session_idx", "payment_attempt_intent_idx"].includes(
          detail.constraint ?? "",
        )
      ) {
        throw new PaymentContradictionError(
          "Stripe identity is already bound to another payment attempt",
        );
      }
      throw error;
    });
}

/** All callers (webhook, browser, polling) converge on the same database obligation. */
export async function fulfillObservedPayment(attemptId: string, db: Database = getDb()) {
  const attempt = await db.query.paymentAttempts.findFirst({
    where: eq(schema.paymentAttempts.id, attemptId),
  });
  if (!attempt) throw new PaymentRoutingError("Payment attempt is missing");
  if (attempt.bookingId) {
    const booking = await db.query.bookings.findFirst({
      where: eq(schema.bookings.id, attempt.bookingId),
    });
    if (!booking || booking.paymentIntentId !== attempt.paymentIntentId)
      throw new PaymentRoutingError("Payment booking binding requires reconciliation");
    await finalizePaymentBooking(attempt.id, db);
    return { uid: booking.uid, pending: false, state: "fulfilled" as const };
  }
  if (
    !attempt.successFacts ||
    !attempt.paymentSucceededAt ||
    !["payment_succeeded", "fulfilling"].includes(attempt.state)
  ) {
    return { uid: null, pending: true, state: attempt.state };
  }
  const terms = decodeAttempt(attempt);
  await db
    .update(schema.paymentAttempts)
    .set({ state: "fulfilling" })
    .where(
      and(
        eq(schema.paymentAttempts.id, attempt.id),
        isNull(schema.paymentAttempts.bookingId),
        inArray(schema.paymentAttempts.state, ["payment_succeeded", "fulfilling"]),
      ),
    );
  try {
    const result = await createBooking({
      ...terms.input,
      paymentAttemptId: attempt.id,
      pricingQuote: terms.quote,
      quotedDurationMinutes: terms.resolvedDurationMinutes,
      payment: {
        paymentIntentId: attempt.successFacts.paymentIntentId,
        amountPaid: attempt.successFacts.amount,
        currency: attempt.successFacts.currency,
        destinationAccountId: attempt.destinationAccountId ?? undefined,
      },
    });
    await finalizePaymentBooking(attempt.id, db);
    return { uid: result.uid, pending: false, state: "fulfilled" as const };
  } catch (err) {
    const latest = await db.query.paymentAttempts.findFirst({
      where: eq(schema.paymentAttempts.id, attempt.id),
    });
    if (latest?.bookingId) {
      const booking = await db.query.bookings.findFirst({
        where: eq(schema.bookings.id, latest.bookingId),
      });
      if (booking) return { uid: booking.uid, pending: false, state: "fulfilled" as const };
    }
    if (
      (err instanceof BookingError && err.status < 500) ||
      err instanceof PaymentContradictionError
    ) {
      // No ambiguous best-effort refund here. The paid obligation remains visible;
      // durable compensation and financial resolution belong to Slice 4.
      await requirePaymentReview(attempt.id, "booking_obligation_requires_review", db);
    } else {
      await db
        .update(schema.paymentAttempts)
        .set({
          state: "payment_succeeded",
          recoveryFailures: attempt.recoveryFailures + 1,
          nextRecoveryAt: retryAt(attempt.recoveryFailures + 1),
        })
        .where(
          and(
            eq(schema.paymentAttempts.id, attempt.id),
            isNull(schema.paymentAttempts.bookingId),
            inArray(schema.paymentAttempts.state, ["payment_succeeded", "fulfilling"]),
          ),
        );
    }
    return {
      uid: null,
      pending: true,
      state:
        (err instanceof BookingError && err.status < 500) ||
        err instanceof PaymentContradictionError
          ? ("requires_review" as const)
          : ("payment_succeeded" as const),
    };
  }
}
