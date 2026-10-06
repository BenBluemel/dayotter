import { env } from "@/lib/server/env";
import { logger } from "@dayotter/core";
import { and, eq, getDb, schema } from "@dayotter/db";
import { bookingRescheduled, sendEmail } from "@dayotter/emails";
import { reserveRuleBlocks } from "../automation/apply-rules";
import { updateBookingCalendarEvent } from "../calendar/host-calendar";
import { SLOT_REVALIDATION_WINDOW_MS, eventConstraints, hostSlots } from "./availability";
import { BookingError, mapInsertError } from "./booking-logic";
import { AUTO_CONFERENCE } from "./event-type-input";
import { fanOutBookingLifecycle } from "./lifecycle";
import {
  clearBookingReminders,
  hostWantsOverflowNotice,
  hostWantsScribe,
  reminderOffsetsForHost,
  scheduleBookingReminders,
  scheduleOverflowCheck,
  scheduleScribe,
  scheduleWorkflowMessages,
} from "./reminders";
import { admitBookingReschedule } from "./reschedule-admission";
import { acceptedBookingResourceAvailable } from "./resource-availability";
import { reserveTravelBlocks } from "./travel";

export class RescheduleError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Move a booking to a new start time: validate, update, move the calendar event,
 * reschedule reminders, and notify attendees. */
export async function rescheduleBooking(
  uid: string,
  newStartISO: string,
  reason?: string,
): Promise<void> {
  const db = getDb();

  const booking = await db.query.bookings.findFirst({
    where: eq(schema.bookings.uid, uid),
    with: { attendees: true, host: true },
  });
  if (!booking || !["pending", "confirmed"].includes(booking.status)) {
    throw new RescheduleError("Booking not found", 404);
  }
  const eventType = await db.query.eventTypes.findFirst({
    where: eq(schema.eventTypes.id, booking.eventTypeId),
  });
  if (!eventType) throw new RescheduleError("Event type not found", 404);

  // Honor the location the booker chose (persisted on the booking) over the event
  // type's primary - mirrors finalizeConfirmedBooking - so a reschedule keeps the
  // booker's chosen meeting type/link instead of silently resetting to the default.
  if (booking.locationType) {
    eventType.location = booking.locationType;
    eventType.locationDetail = booking.location;
  }

  const newStart = new Date(newStartISO);
  if (Number.isNaN(newStart.getTime())) throw new RescheduleError("Invalid time", 400);
  // Preserve the booking's ACTUAL length (multi-duration event types), not the
  // event type's default - otherwise a 15-min booking silently becomes 30.
  const durationMs = booking.endsAt.getTime() - booking.startsAt.getTime();
  const newEnd = new Date(newStart.getTime() + durationMs);

  if (newStart.getTime() === booking.startsAt.getTime()) return; // no-op

  // Validate the new slot against the booking's actual host only (not the whole
  // team) - the host is already fixed, so there's no need to fan out. Validate at
  // the booking's real duration, too.
  const plan = booking.schedulingPlan;
  const scheduleId =
    plan?.scheduleId ?? (eventType.ownerId === booking.hostId ? eventType.scheduleId : null);
  if (plan) {
    const schedule = await db.query.schedules.findFirst({
      where: eq(schema.schedules.id, plan.scheduleId),
    });
    if (!schedule || schedule.userId !== plan.scheduleOwnerId)
      throw new RescheduleError("Accepted scheduling terms require review", 409);
  }
  const constraints = {
    ...eventConstraints(eventType),
    durationMinutes: Math.round(durationMs / 60_000),
    ...(plan
      ? {
          bufferBeforeMinutes: plan.bufferBeforeMinutes,
          bufferAfterMinutes: plan.bufferAfterMinutes,
        }
      : {}),
  };
  const slots = await hostSlots(
    booking.hostId,
    scheduleId,
    constraints,
    new Date(newStart.getTime() - SLOT_REVALIDATION_WINDOW_MS),
    new Date(newStart.getTime() + SLOT_REVALIDATION_WINDOW_MS),
    plan?.minimumGapMinutes ?? eventType.minimumGapMinutes,
    booking.id, // don't let the booking being moved block its own new slot
    undefined,
    booking.requiresHost,
  );
  if (!slots.some((s) => s.start.getTime() === newStart.getTime())) {
    throw new RescheduleError("That time is no longer available", 409);
  }

  if (!(await acceptedBookingResourceAvailable(booking, newStart, newEnd, db)))
    throw new RescheduleError("That appointment is unavailable", 409);

  let moved: typeof booking | typeof schema.bookings.$inferSelect | null;
  try {
    moved = await admitBookingReschedule(db, booking, eventType, newStart, newEnd, reason);
  } catch (error) {
    try {
      mapInsertError(error);
    } catch (mapped) {
      if (mapped instanceof BookingError) throw new RescheduleError(mapped.message, mapped.status);
      throw mapped;
    }
  }
  if (!moved) return;
  // Pending requests hold capacity but have no provider event/reminder suite yet.
  if (moved.status === "pending") return;
  const stillCurrent = async () => {
    const current = await db.query.bookings.findFirst({
      where: eq(schema.bookings.id, booking.id),
    });
    return (
      current?.status === "confirmed" &&
      current.startsAt.getTime() === newStart.getTime() &&
      current.endsAt.getTime() === newEnd.getTime() &&
      current.allocationRevision === moved.allocationRevision
    );
  };
  if (!(await stillCurrent())) return;

  // Move the calendar event (best-effort).
  const meetingUrl = await updateBookingCalendarEvent(booking.id, {
    title: booking.title,
    description: booking.description ?? undefined,
    start: newStart,
    end: newEnd,
    timezone: booking.timezone,
    attendees: booking.attendees.map((a) => ({ email: a.email, name: a.name ?? undefined })),
    location: eventType.locationDetail ?? undefined,
    createConference: AUTO_CONFERENCE.includes(eventType.location),
    transparency: booking.requiresHost ? "opaque" : "transparent",
  });
  if (!(await stillCurrent())) return;
  if (meetingUrl) {
    await db
      .update(schema.bookings)
      .set({ meetingUrl })
      .where(
        and(
          eq(schema.bookings.id, booking.id),
          eq(schema.bookings.status, "confirmed"),
          eq(schema.bookings.startsAt, newStart),
          eq(schema.bookings.endsAt, newEnd),
          ...(moved.allocationRevision == null
            ? []
            : [eq(schema.bookings.allocationRevision, moved.allocationRevision)]),
        ),
      );
  }

  // Replace reminders at the host's preferred lead times.
  await clearBookingReminders(booking.id);
  await scheduleBookingReminders(
    booking.id,
    newStart,
    await reminderOffsetsForHost(booking.hostId),
  );
  // Re-schedule workflow messages against the new time window.
  await scheduleWorkflowMessages(
    booking.id,
    eventType.organizationId,
    eventType.id,
    newStart,
    newEnd,
  );
  // clearBookingReminders wiped the overflow + scribe jobs too - re-add them at
  // the new end time under the host's same opt-in, else the host silently loses
  // the "running late" notice and post-meeting recap for a moved booking.
  if (booking.hostId) {
    if (booking.requiresHost && (await hostWantsOverflowNotice(booking.hostId))) {
      await scheduleOverflowCheck(booking.id, newEnd);
    }
    if (await hostWantsScribe(booking.hostId)) {
      await scheduleScribe(booking.id, newEnd);
    }
  }

  if (!(await stillCurrent())) return;
  // Move the booking's reserved travel / prep / buffer blocks to the new time
  // (else the old ones linger and new ones would double up).
  await db
    .delete(schema.timeBlocks)
    .where(eq(schema.timeBlocks.bookingId, booking.id))
    .catch(() => {});
  await reserveRuleBlocks({
    bookingId: booking.id,
    hostId: booking.hostId,
    title: booking.title,
    requiresHost: booking.requiresHost,
    startsAt: newStart,
    endsAt: newEnd,
  }).catch(() => {});
  await reserveTravelBlocks({
    hostId: booking.hostId,
    bookingId: booking.id,
    location: eventType.location,
    startsAt: newStart,
    endsAt: newEnd,
    place: eventType.locationDetail,
    requiresHost: booking.requiresHost,
  });

  if (!(await stillCurrent())) return;
  logger.info("booking rescheduled", {
    event: "booking_rescheduled",
    bookingId: booking.id,
    uid,
    hostId: booking.hostId,
  });

  if (booking.hostId) {
    const startsAt = newStart.toISOString();
    const endsAt = newEnd.toISOString();
    await fanOutBookingLifecycle(
      "rescheduled",
      {
        bookingId: booking.id,
        uid,
        hostId: booking.hostId,
        eventTypeId: booking.eventTypeId,
        title: booking.title,
        startsAt,
        endsAt,
        attendees: booking.attendees.map((a) => ({ name: a.name, email: a.email })),
      },
      { uid, eventTypeId: booking.eventTypeId, title: booking.title, startsAt, endsAt },
    );
  }

  // Notify.
  const appUrl = env.APP_URL;
  try {
    await Promise.all(
      [
        ...booking.attendees.map((a) => ({
          email: a.email,
          name: a.name,
          tz: a.timezone ?? booking.timezone,
        })),
        ...(booking.host?.email
          ? [{ email: booking.host.email, name: booking.host.name, tz: booking.host.timezone }]
          : []),
      ].map((r) =>
        sendEmail({
          ...bookingRescheduled({
            eventTitle: booking.title,
            start: newStart,
            end: newEnd,
            timezone: r.tz,
            hostName: booking.host?.name ?? "your host",
            attendeeName: r.name ?? r.email,
            meetingUrl: meetingUrl ?? booking.meetingUrl ?? undefined,
            location: eventType.locationDetail ?? undefined,
            manageUrl: `${appUrl}/booking/${uid}`,
            reason: reason ?? null,
          }),
          to: r.email,
        }),
      ),
    );
  } catch (err) {
    logger.error("reschedule email failed", {
      event: "reschedule_email_failed",
      bookingId: booking.id,
      err,
    });
  }
}
