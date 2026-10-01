import { logger } from "@dayotter/core";
import { and, eq, getDb, inArray, isNull, schema } from "@dayotter/db";
import type Stripe from "stripe";
import { BookingError, createBooking } from "../booking/create-booking";
import { type PaymentAttempt, decodeAttempt, validateAttemptSession } from "./attempt-terms";
import { bindAttemptSession } from "./attempts";
import { claimPendingBooking } from "./pending";
import { PaymentRoutingError } from "./routing";
import { refundPayment, retrieveSession } from "./stripe";

/**
 * Turn a paid Checkout Session into a confirmed booking. New appointment Sessions
 * use durable saved terms and a transactional attempt/booking binding. Older
 * Sessions retain the legacy Redis GETDEL path and PaymentIntent lookup below.
 * Durable webhook and post-commit finalization recovery remain Slice 3.
 *
 * Returns the booking uid, or `pending: true` when the other handler is mid-flight.
 */
export async function fulfillCheckout(
  sessionId: string,
): Promise<{ uid: string | null; pending: boolean }> {
  const db = getDb();
  const known = await db.query.paymentAttempts.findFirst({
    where: eq(schema.paymentAttempts.checkoutSessionId, sessionId),
  });
  const session = await retrieveSession(sessionId, known ? decodeAttempt(known).route : undefined);
  if (known || session.metadata?.attemptId) {
    const attempt =
      known ??
      (await db.query.paymentAttempts.findFirst({
        where: eq(schema.paymentAttempts.id, session.metadata!.attemptId!),
      }));
    if (!attempt) throw new PaymentRoutingError("Durable checkout intent is missing");
    // Response-loss recovery must verify the saved credential/account even when no Session ID was bound.
    const verified = known
      ? session
      : await retrieveSession(sessionId, decodeAttempt(attempt).route);
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

/** Minimal saved-terms handoff; durable event/finalization recovery remains Slice 3. */
async function fulfillDurableAppointment(
  attempt: PaymentAttempt,
  session: Stripe.Checkout.Session,
) {
  const terms = decodeAttempt(attempt);
  const saved = await bindAttemptSession(attempt, session);
  if (session.payment_status !== "paid") return { uid: null, pending: true };
  const pi = validateAttemptSession(saved, session, true)!;
  const db = getDb();
  if (saved.bookingId) {
    const booking = await db.query.bookings.findFirst({
      where: eq(schema.bookings.id, saved.bookingId),
    });
    if (!booking || booking.paymentIntentId !== pi)
      throw new PaymentRoutingError("Saved booking settlement is inconsistent");
    return { uid: booking.uid, pending: false };
  }
  if (!["prepared", "open"].includes(saved.state))
    throw new PaymentRoutingError("Payment attempt requires reconciliation");
  try {
    const result = await createBooking({
      ...terms.input,
      paymentAttemptId: saved.id,
      pricingQuote: terms.quote,
      quotedDurationMinutes: terms.resolvedDurationMinutes,
      payment: {
        paymentIntentId: pi,
        amountPaid: saved.amount,
        currency: saved.currency,
        destinationAccountId: saved.destinationAccountId ?? undefined,
      },
    });
    return { uid: result.uid, pending: false };
  } catch (err) {
    // Booking creation binds the attempt in the same transaction. Never compensate
    // a booking committed before finalization failed, or a concurrent winner.
    const latest = await db.query.paymentAttempts.findFirst({
      where: eq(schema.paymentAttempts.id, saved.id),
    });
    if (latest?.bookingId) {
      const booking = await db.query.bookings.findFirst({
        where: eq(schema.bookings.id, latest.bookingId),
      });
      if (booking) return { uid: booking.uid, pending: false };
    }
    if (err instanceof BookingError) {
      const claimed = await db
        .update(schema.paymentAttempts)
        .set({ state: "requires_review" })
        .where(
          and(
            eq(schema.paymentAttempts.id, saved.id),
            inArray(schema.paymentAttempts.state, ["prepared", "open"]),
            isNull(schema.paymentAttempts.bookingId),
          ),
        )
        .returning();
      // Retain the existing best-effort compensation, using original typed routing.
      // This state is NOT proof of a refund; retries/reconciliation are Slice 4.
      if (claimed.length) await refundPayment(pi, terms.route);
    }
    throw err;
  }
}
