import { decryptJson, encryptJson, sha256hex } from "@dayotter/core";
import { type Database, and, eq, getDb, inArray, isNull, schema } from "@dayotter/db";
import type Stripe from "stripe";
import { releaseTerminalCouponReservation } from "../booking/coupon-uses";
import {
  PAYMENT_ATTEMPT_ID_PATTERN,
  type PaymentAttempt,
  canonicalJson,
  decodeAttempt,
  validateAttemptSession,
} from "./attempt-terms";
import { bindAttemptSession } from "./attempts";
import { validatePaymentIntentTerms } from "./payment-success";
import {
  fulfillObservedPayment,
  observePaymentSuccess,
  requirePaymentReview,
} from "./payment-work";
import { retryAt } from "./recovery-backoff";
import { PaymentContradictionError, PaymentRoutingError } from "./routing";
import { retrieveSession, sessionForPaymentIntent } from "./stripe";

export const APPOINTMENT_PAYMENT_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "payment_intent.succeeded",
]);
export type PaymentEventResult =
  | "fulfilled"
  | "already_fulfilled"
  | "waiting_payment"
  | "retry"
  | "requires_review";

/** Called only AFTER SDK raw-body signature and environment verification. */
export async function receiveAppointmentEvent(
  event: Stripe.Event,
  db: Database = getDb(),
): Promise<string | null> {
  if (!APPOINTMENT_PAYMENT_EVENTS.has(event.type)) return null;
  const object = event.data.object as Stripe.Checkout.Session | Stripe.PaymentIntent;
  let attemptId = object.metadata?.attemptId;
  if (!attemptId) {
    // Missing metadata must not send a known durable payment through Redis.
    const byIdentity = await db.query.paymentAttempts.findFirst({
      where: event.type.startsWith("checkout.session.")
        ? eq(schema.paymentAttempts.checkoutSessionId, object.id)
        : eq(schema.paymentAttempts.paymentIntentId, object.id),
    });
    attemptId = byIdentity?.id;
    if (!attemptId && event.type.startsWith("checkout.session.")) {
      const reference = (object as Stripe.Checkout.Session).client_reference_id;
      if (reference && PAYMENT_ATTEMPT_ID_PATTERN.test(reference)) {
        const byReference = await db.query.paymentAttempts.findFirst({
          where: eq(schema.paymentAttempts.id, reference),
        });
        attemptId = byReference?.id;
      }
    }
    if (!attemptId) return null; // Explicit legacy/Pro/package boundary.
  }
  if (!PAYMENT_ATTEMPT_ID_PATTERN.test(attemptId))
    throw new PaymentRoutingError("Malformed durable payment relationship", 400);
  const attempt = await db.query.paymentAttempts.findFirst({
    where: eq(schema.paymentAttempts.id, attemptId),
  });
  if (!attempt) throw new PaymentRoutingError("Durable payment attempt is missing");
  const hash = sha256hex(canonicalJson(event));
  const [inserted] = await db
    .insert(schema.paymentEvents)
    .values({
      attemptId,
      stripeEventId: event.id,
      environment: event.livemode ? "live" : "test",
      chargeAccountId: attempt.chargeAccountId,
      eventType: event.type,
      payload: encryptJson(event),
      payloadHash: hash,
    })
    .onConflictDoNothing({
      target: [
        schema.paymentEvents.environment,
        schema.paymentEvents.chargeAccountId,
        schema.paymentEvents.stripeEventId,
      ],
    })
    .returning();
  const receipt =
    inserted ??
    (await db.query.paymentEvents.findFirst({
      where: and(
        eq(schema.paymentEvents.stripeEventId, event.id),
        eq(schema.paymentEvents.environment, event.livemode ? "live" : "test"),
        eq(schema.paymentEvents.chargeAccountId, attempt.chargeAccountId),
      ),
    }));
  if (!receipt) throw new Error("Webhook receipt could not be saved");
  if (
    receipt.attemptId !== attemptId ||
    receipt.payloadHash !== hash ||
    event.livemode !== (attempt.environment === "live") ||
    (event.account && event.account !== attempt.chargeAccountId)
  ) {
    await requirePaymentReview(attemptId, "webhook_identity_contradiction", db);
    await db
      .update(schema.paymentEvents)
      .set({ state: "requires_review", reviewCode: "webhook_identity_contradiction" })
      .where(
        and(eq(schema.paymentEvents.id, receipt.id), eq(schema.paymentEvents.state, "pending")),
      );
  }
  return receipt.id;
}

/** Re-read Stripe's canonical Session under saved account routing, including async settlement. */
export async function reconcileSession(
  attempt: PaymentAttempt,
  session: Stripe.Checkout.Session,
  db: Database = getDb(),
) {
  validateAttemptSession(attempt, session);
  if (attempt.bookingId) {
    const result = await fulfillObservedPayment(attempt.id, db);
    return result?.uid ? ("already_fulfilled" as const) : ("retry" as const);
  }
  if (session.payment_status === "paid") {
    const saved = await observePaymentSuccess(attempt, session, db);
    const result = await fulfillObservedPayment(saved.id, db);
    if (result?.state === "requires_review") return "requires_review" as const;
    return result?.uid
      ? attempt.bookingId
        ? ("already_fulfilled" as const)
        : ("fulfilled" as const)
      : ("retry" as const);
  }
  // Stale expiration/failure/completion must never regress an observed financial obligation.
  if (attempt.successFacts) {
    const result = await fulfillObservedPayment(attempt.id, db);
    return result?.uid
      ? ("already_fulfilled" as const)
      : result?.state === "requires_review"
        ? ("requires_review" as const)
        : ("retry" as const);
  }
  const bound = await bindAttemptSession(attempt, session, db);
  if (bound.successFacts || bound.bookingId) {
    const result = await fulfillObservedPayment(bound.id, db);
    return result.uid
      ? ("already_fulfilled" as const)
      : result.state === "requires_review"
        ? ("requires_review" as const)
        : ("retry" as const);
  }
  if (bound.state === "requires_review") return "requires_review" as const;
  return "waiting_payment" as const;
}

export async function processAppointmentEvent(
  receiptId: string,
  db: Database = getDb(),
): Promise<PaymentEventResult> {
  const receipt = await db.query.paymentEvents.findFirst({
    where: eq(schema.paymentEvents.id, receiptId),
  });
  if (!receipt) throw new Error("Webhook receipt is missing");
  if (receipt.state === "requires_review") return "requires_review" as const;
  if (receipt.state === "completed") {
    const previous = await db.query.paymentAttempts.findFirst({
      where: eq(schema.paymentAttempts.id, receipt.attemptId),
    });
    if (previous?.bookingId || previous?.successFacts) {
      const result = await fulfillObservedPayment(previous.id, db);
      if (result.uid) return "already_fulfilled" as const;
      return result.state === "requires_review" ? ("requires_review" as const) : ("retry" as const);
    }
    if (previous?.state === "requires_review") return "requires_review" as const;
    // A previously acknowledged unpaid event is not proof that settlement is
    // still unpaid. Re-read canonical Stripe state and discharge any new obligation.
  }
  try {
    const attempt = await db.query.paymentAttempts.findFirst({
      where: eq(schema.paymentAttempts.id, receipt.attemptId),
    });
    if (!attempt) throw new PaymentRoutingError("Payment attempt is missing");
    const event = decryptJson<Stripe.Event>(receipt.payload);
    if (sha256hex(canonicalJson(event)) !== receipt.payloadHash)
      throw new PaymentContradictionError("Webhook receipt integrity mismatch");
    const object = event.data.object as Stripe.Checkout.Session | Stripe.PaymentIntent;
    const route = decodeAttempt(attempt).route;
    let session: Stripe.Checkout.Session;
    if (event.type.startsWith("checkout.session.")) {
      const snapshot = object as Stripe.Checkout.Session;
      // Earlier unpaid snapshots may legitimately omit a later-bound PaymentIntent.
      validateAttemptSession({ ...attempt, paymentIntentId: null }, snapshot);
      const snapshotPi =
        typeof snapshot.payment_intent === "string"
          ? snapshot.payment_intent
          : snapshot.payment_intent?.id;
      if (snapshotPi && attempt.paymentIntentId && snapshotPi !== attempt.paymentIntentId)
        throw new PaymentContradictionError(
          "Webhook PaymentIntent identity contradicts the attempt",
        );
      session = await retrieveSession(snapshot.id, route);
    } else {
      const pi = object as Stripe.PaymentIntent;
      validatePaymentIntentTerms(attempt, attempt.paymentIntentId ?? pi.id, pi);
      session = attempt.checkoutSessionId
        ? await retrieveSession(attempt.checkoutSessionId, route)
        : await sessionForPaymentIntent(pi.id, route);
      const sessionPi =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent?.id;
      if (sessionPi !== pi.id)
        throw new PaymentContradictionError(
          "Webhook PaymentIntent does not belong to the Checkout Session",
        );
    }
    const result = await reconcileSession(attempt, session, db);
    if (result === "retry") {
      await db
        .update(schema.paymentEvents)
        .set({ failures: receipt.failures + 1, nextRecoveryAt: retryAt(receipt.failures + 1) })
        .where(
          and(eq(schema.paymentEvents.id, receipt.id), eq(schema.paymentEvents.state, "pending")),
        );
    } else {
      if (
        event.type === "checkout.session.async_payment_failed" &&
        result === "waiting_payment" &&
        !attempt.successFacts &&
        session.status === "complete"
      ) {
        await db
          .update(schema.paymentAttempts)
          .set({ state: "payment_failed" })
          .where(
            and(
              eq(schema.paymentAttempts.id, attempt.id),
              isNull(schema.paymentAttempts.successFacts),
              isNull(schema.paymentAttempts.bookingId),
              inArray(schema.paymentAttempts.state, ["prepared", "open", "payment_failed"]),
            ),
          );
        await releaseTerminalCouponReservation(attempt.id, db);
      }
      await db
        .update(schema.paymentEvents)
        .set({
          state: result === "requires_review" ? "requires_review" : "completed",
          reviewCode: result === "requires_review" ? "booking_obligation_requires_review" : null,
        })
        .where(
          and(eq(schema.paymentEvents.id, receipt.id), eq(schema.paymentEvents.state, "pending")),
        );
    }
    return result;
  } catch (err) {
    if (err instanceof PaymentContradictionError) {
      await requirePaymentReview(receipt.attemptId, "stripe_terms_contradiction", db);
      await db
        .update(schema.paymentEvents)
        .set({ state: "requires_review", reviewCode: "stripe_terms_contradiction" })
        .where(
          and(eq(schema.paymentEvents.id, receipt.id), eq(schema.paymentEvents.state, "pending")),
        );
      return "requires_review" as const;
    }
    await db
      .update(schema.paymentEvents)
      .set({ failures: receipt.failures + 1, nextRecoveryAt: retryAt(receipt.failures + 1) })
      .where(
        and(eq(schema.paymentEvents.id, receipt.id), eq(schema.paymentEvents.state, "pending")),
      );
    return "retry" as const;
  }
}
