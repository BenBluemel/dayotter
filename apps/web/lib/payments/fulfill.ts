import { logger } from "@dayotter/core";
import { eq, getDb, schema } from "@dayotter/db";
import type Stripe from "stripe";
import { ResourceInvariantError } from "../booking/booking-logic";
import { BookingError, createBooking } from "../booking/create-booking";
import { PAYMENT_ATTEMPT_ID_PATTERN, type PaymentAttempt, attemptRoute } from "./attempt-terms";
import { reconcileSession } from "./payment-events";
import { requirePaymentReview } from "./payment-work";
import { claimPendingBooking } from "./pending";
import { PaymentContradictionError, PaymentRoutingError } from "./routing";
import { refundPayment, retrieveSession } from "./stripe";

/**
 * Turn a paid Checkout Session into a confirmed booking. New appointment Sessions
 * use durable saved terms and a transactional attempt/booking binding. Older
 * Sessions retain the legacy Redis GETDEL path and PaymentIntent lookup below.
 * Durable event receipts and success observations make new attempts recoverable.
 *
 * Returns the booking uid, or `pending: true` when the other handler is mid-flight.
 */
export async function fulfillCheckout(
  sessionId: string,
): Promise<{ uid: string | null; pending: boolean; state?: string }> {
  const db = getDb();
  const known = await db.query.paymentAttempts.findFirst({
    where: eq(schema.paymentAttempts.checkoutSessionId, sessionId),
  });
  const session = await retrieveSession(sessionId, known ? attemptRoute(known) : undefined);
  const reference = session.metadata?.attemptId || session.client_reference_id;
  const referenced =
    !known && reference && PAYMENT_ATTEMPT_ID_PATTERN.test(reference)
      ? await db.query.paymentAttempts.findFirst({
          where: eq(schema.paymentAttempts.id, reference),
        })
      : null;
  if (known || referenced || session.metadata?.attemptId) {
    const attempt = known ?? referenced;
    if (!attempt) throw new PaymentRoutingError("Durable checkout intent is missing");
    // Response-loss recovery must verify the saved credential/account even when no Session ID was bound.
    const verified = known ? session : await retrieveSession(sessionId, attemptRoute(attempt));
    return fulfillDurableAppointment(attempt, verified);
  }
  if (session.payment_status !== "paid") return { uid: null, pending: true };

  const pi =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : (session.payment_intent?.id ?? null);
  if (!pi) return { uid: null, pending: false };

  const existing = await db.query.bookings.findFirst({
    where: eq(schema.bookings.paymentIntentId, pi),
  });
  if (existing) return { uid: existing.uid, pending: false };

  const token = session.metadata?.token;
  if (!token) return { uid: null, pending: false };

  const input = await claimPendingBooking(token);
  if (!input) {
    // The other handler claimed the payload; it may still be creating the row.
    const again = await db.query.bookings.findFirst({
      where: eq(schema.bookings.paymentIntentId, pi),
    });
    return { uid: again?.uid ?? null, pending: !again };
  }

  const resourceReview = async () => {
    const service = await db.query.eventTypes.findFirst({
      where: eq(schema.eventTypes.id, input.eventTypeId),
    });
    if (!service?.resourceAdmissionEpoch) return false;
    logger.error("Legacy paid checkout requires operator reconciliation", {
      event: "legacy_resource_payment_review",
      paymentIntentId: pi,
      eventTypeId: service.id,
    });
    return true;
  };
  if (await resourceReview())
    return { uid: null, pending: true, state: "requires_review" as const };
  const destinationAccountId = session.metadata?.dest || undefined;
  try {
    const { uid } = await createBooking({
      ...input,
      payment: {
        paymentIntentId: pi,
        amountPaid: session.amount_total ?? 0,
        currency: session.currency ?? "usd",
        destinationAccountId,
      },
    });
    return { uid, pending: false };
  } catch (err) {
    // Slot was taken between checkout and fulfillment. If the other handler won
    // the race, use its booking; otherwise the payment can't be honoured → refund.
    if (err instanceof BookingError) {
      const raced = await db.query.bookings.findFirst({
        where: eq(schema.bookings.paymentIntentId, pi),
      });
      if (raced) return { uid: raced.uid, pending: false };
      // Admission may have changed since the legacy preflight. Do not guess a
      // refund route for a resource obligation lacking durable accepted terms.
      if (await resourceReview())
        return { uid: null, pending: true, state: "requires_review" as const };
      logger.error("paid booking failed after payment - refunding", {
        event: "paid_booking_refunded",
        paymentIntentId: pi,
        err,
      });
      await refundPayment(pi, Boolean(destinationAccountId));
      throw err;
    }
    throw err;
  }
}

/** Browser reconciliation uses authenticated Stripe reads, just like event processing. */
async function fulfillDurableAppointment(
  attempt: PaymentAttempt,
  session: Stripe.Checkout.Session,
) {
  try {
    const state = await reconcileSession(attempt, session);
    const saved = await getDb().query.paymentAttempts.findFirst({
      where: eq(schema.paymentAttempts.id, attempt.id),
    });
    if (saved?.bookingId) {
      const booking = await getDb().query.bookings.findFirst({
        where: eq(schema.bookings.id, saved.bookingId),
      });
      if (booking && booking.paymentIntentId === saved.paymentIntentId)
        return { uid: booking.uid, pending: false, state };
    }
    return { uid: null, pending: true, state };
  } catch (err) {
    if (err instanceof ResourceInvariantError || err instanceof PaymentContradictionError) {
      await requirePaymentReview(
        attempt.id,
        err instanceof ResourceInvariantError
          ? "resource_invariant_requires_review"
          : "stripe_terms_contradiction",
      );
      return { uid: null, pending: true, state: "requires_review" };
    }
    throw err;
  }
}
