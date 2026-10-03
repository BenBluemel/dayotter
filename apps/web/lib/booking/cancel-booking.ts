import { env } from "@/lib/server/env";
import { logger } from "@dayotter/core";
import { and, eq, getDb, gte, schema } from "@dayotter/db";
import { bookingCancellation, sendEmail } from "@dayotter/emails";
import { deleteBookingFromCalendar } from "../calendar/host-calendar";
import { originalBookingRefundRoute } from "../payments/booking-routing";
import {
  type PublicRefundState,
  decideBookingCancellation,
  executeRefundOperation,
} from "../payments/refunds";
import { refundPayment, stripeConfigured } from "../payments/stripe";
import { fanOutBookingLifecycle } from "./lifecycle";
import { clearBookingReminders } from "./reminders";

/** Accept cancellation, durably retaining cash refund work before external I/O. */
export async function cancelBookingWithResult(
  uid: string,
  reason?: string,
): Promise<{ changed: boolean; refund: PublicRefundState } | null> {
  const db = getDb();
  const decision = await decideBookingCancellation(uid, reason, db);
  if (!decision) return null;
  let refund: PublicRefundState = decision.creditRestoration
    ? "refunded"
    : !decision.durable && decision.booking.paymentStatus === "paid"
      ? "legacy_unknown"
      : "none";
  if (decision.operation) refund = await executeRefundOperation(decision.operation.id, db);
  // A duplicate request still drives refund recovery, but never repeats cleanup.
  if (!decision.changed) return { changed: false, refund };
  const booking = await db.query.bookings.findFirst({
    where: eq(schema.bookings.id, decision.booking.id),
    with: { attendees: true, host: true },
  });
  if (!booking) return { changed: true, refund };

  // Refund a paid booking (best-effort, after the claim so only the winner pays).
  let refunded = false;
  if (
    !decision.durable &&
    stripeConfigured &&
    booking.paymentStatus === "paid" &&
    booking.paymentIntentId
  ) {
    // Destination charge: reverse the transfer so the host's balance is debited
    // too, otherwise the platform eats the refund while the host keeps the funds.
    try {
      const attempt = await db.query.paymentAttempts.findFirst({
        where: eq(schema.paymentAttempts.bookingId, booking.id),
      });
      refunded = await refundPayment(
        booking.paymentIntentId,
        originalBookingRefundRoute(booking, attempt),
      );
    } catch {
      // Failed lookup/binding must not fall back to guessing new payment topology.
      logger.error("cancelled booking requires payment reconciliation", {
        event: "cancel_payment_context_failed",
        bookingId: booking.id,
      });
    }
    if (refunded) {
      logger.info("booking payment refunded on cancel", {
        event: "booking_refunded",
        bookingId: booking.id,
      });
    }
  } else if (
    !decision.durable &&
    !decision.creditRestoration &&
    booking.paymentStatus === "paid" &&
    !booking.paymentIntentId
  ) {
    // Legacy email-only settlement cannot identify an original redemption.
    refund = "legacy_unknown";
  }

  if (refunded) {
    await db
      .update(schema.bookings)
      .set({ paymentStatus: "refunded" })
      .where(eq(schema.bookings.id, booking.id));
  }

  if (!decision.durable && booking.paymentIntentId && booking.paymentStatus === "paid") {
    refund = refunded ? "refunded" : "legacy_unknown";
  }

  // Financial work is already durable. Cleanup can fail without losing it.
  try {
    // Remove from the host's calendar (best-effort).
    await deleteBookingFromCalendar(booking.id);

    // Cancel any pending reminder jobs.
    await clearBookingReminders(booking.id);

    // Release travel / prep / buffer blocks this booking reserved (else the time
    // stays blocked forever).
    await db
      .delete(schema.timeBlocks)
      .where(eq(schema.timeBlocks.bookingId, booking.id))
      .catch(() => {});

    // Smart rescheduling: if the host opted in, reclaim a cancelled FUTURE 1:1's
    // freed time as a focus block rather than re-opening it for booking. Group
    // events are skipped (other attendees may still hold the slot). Standalone
    // block (no bookingId) so the host can drop it from the block manager.
    if (booking.hostId && !booking.isGroup && booking.startsAt.getTime() > Date.now()) {
      const prefs = await db.query.userPreferences.findFirst({
        where: eq(schema.userPreferences.userId, booking.hostId),
        columns: { reclaimCancelledTime: true },
      });
      if (prefs?.reclaimCancelledTime) {
        await db
          .insert(schema.timeBlocks)
          .values({
            userId: booking.hostId,
            title: "Focus (freed up)",
            kind: "focus",
            source: "reclaimed",
            startsAt: booking.startsAt,
            endsAt: booking.endsAt,
          })
          .catch((err) =>
            logger.warn("reclaim focus block failed", { event: "reclaim_failed", err }),
          );
      }
    }

    if (booking.hostId) {
      const startsAt = booking.startsAt.toISOString();
      const endsAt = booking.endsAt.toISOString();
      await fanOutBookingLifecycle(
        "cancelled",
        {
          bookingId: booking.id,
          uid,
          hostId: booking.hostId,
          eventTypeId: booking.eventTypeId,
          title: booking.title,
          startsAt,
          endsAt,
          attendees: booking.attendees.map((a) => ({ name: a.name, email: a.email })),
          reason: reason ?? null,
        },
        {
          uid,
          eventTypeId: booking.eventTypeId,
          title: booking.title,
          startsAt,
          endsAt,
          reason: reason ?? null,
        },
      );
    }

    // Notify attendees.
    try {
      await Promise.all(
        booking.attendees.map((a) =>
          sendEmail({
            ...bookingCancellation({
              eventTitle: booking.title,
              start: booking.startsAt,
              end: booking.endsAt,
              timezone: a.timezone ?? booking.timezone,
              hostName: booking.host?.name ?? "your host",
              attendeeName: a.name ?? a.email,
              manageUrl: `${env.APP_URL}/booking/${uid}`,
              reason: reason ?? null,
            }),
            to: a.email,
          }),
        ),
      );
    } catch (err) {
      logger.error("cancellation email failed", {
        event: "cancel_email_failed",
        bookingId: booking.id,
        err,
      });
    }
  } catch {
    logger.warn("cancelled booking cleanup requires review", {
      event: "cancel_cleanup_incomplete",
      bookingId: booking.id,
    });
  }
  return { changed: true, refund };
}

/** Boolean compatibility for Otter/series callers counts newly cancelled bookings. */
export async function cancelBooking(uid: string, reason?: string): Promise<boolean> {
  return (await cancelBookingWithResult(uid, reason))?.changed ?? false;
}

/**
 * Cancel a booking AND every later occurrence in its recurring series ("this and
 * following"). Falls back to a single cancel for a non-recurring booking. Each
 * occurrence is cancelled through the normal path (refund, calendar, emails).
 * Returns how many bookings were cancelled.
 */
export async function cancelBookingSeries(uid: string, reason?: string): Promise<number> {
  const db = getDb();
  const target = await db.query.bookings.findFirst({
    where: eq(schema.bookings.uid, uid),
    columns: { recurrenceUid: true, startsAt: true },
  });
  if (!target) return 0;

  // One-off booking: just cancel it.
  if (!target.recurrenceUid) return (await cancelBooking(uid, reason)) ? 1 : 0;

  // Include cancelled occurrences so repeated requests can drive outstanding refunds.
  const siblings = await db.query.bookings.findMany({
    where: and(
      eq(schema.bookings.recurrenceUid, target.recurrenceUid),
      gte(schema.bookings.startsAt, target.startsAt),
    ),
    columns: { uid: true },
    orderBy: schema.bookings.startsAt,
  });

  let cancelled = 0;
  for (const s of siblings) {
    if (await cancelBooking(s.uid, reason)) cancelled++;
  }
  return cancelled;
}
