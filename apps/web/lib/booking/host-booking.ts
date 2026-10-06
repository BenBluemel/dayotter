import { createHash, randomUUID } from "node:crypto";
import { primaryOrg } from "@/lib/billing/entitlements";
import { writeBookingToCalendar } from "@/lib/calendar/host-calendar";
import { logger } from "@dayotter/core";
import {
  allocateBookingResources,
  and,
  eq,
  getDb,
  schema,
  sql,
  withResourceTransaction,
} from "@dayotter/db";
import { BookingError, mapInsertError } from "./booking-logic";
import { calendarLocationFields } from "./event-type-input";
import type { LocationTypeValue } from "./event-type-input";
import { PERSONAL_EVENT_TYPE_SLUG } from "./personal-event-type";
import { persistBookingPricingSnapshot, quoteAppointmentPrice } from "./pricing";
import {
  hostWantsOverflowNotice,
  hostWantsScribe,
  reminderOffsetsForHost,
  scheduleBookingReminders,
  scheduleOverflowCheck,
  scheduleScribe,
} from "./reminders";

import { canonicalJson } from "../payments/attempt-terms";
import {
  captureSchedulingPlan,
  lockPersonAdmission,
  rejectManagedRecurrence,
} from "./resource-acceptance";

const PERSONAL_SLUG = PERSONAL_EVENT_TYPE_SLUG;

export async function getOrCreatePersonalEventType(
  userId: string,
  organizationId: string,
): Promise<string> {
  const db = getDb();
  const existing = await db.query.eventTypes.findFirst({
    where: and(eq(schema.eventTypes.ownerId, userId), eq(schema.eventTypes.slug, PERSONAL_SLUG)),
    columns: { id: true, organizationId: true, price: true, isPrivate: true, isActive: true },
  });
  if (existing) {
    if (
      existing.organizationId !== organizationId ||
      (existing.price ?? 0) !== 0 ||
      !existing.isPrivate ||
      existing.isActive
    )
      throw new BookingError("Personal booking configuration requires review", 409);
    return existing.id;
  }
  const [row] = await db
    .insert(schema.eventTypes)
    .values({
      organizationId,
      ownerId: userId,
      slug: PERSONAL_SLUG,
      title: "Personal",
      durationMinutes: 30,
      isPrivate: true,
      isActive: false,
    })
    .returning({ id: schema.eventTypes.id });
  return row!.id;
}

export interface HostBookingInput {
  userId: string;
  requestId?: string;
  title: string;
  start: Date;
  end: Date;
  timezone: string;
  notes?: string;
  attendees?: { email: string; name?: string }[];
  /** Slug of a real event type this maps to (so its workflows apply); else the
   * hidden Personal type. */
  eventTypeSlug?: string;
  /** Ad-hoc meeting location the host asked for ("on Zoom / Meet / phone"), when
   * this isn't tied to an event type's own location. Auto-conference types get a
   * provider link; the rest carry `locationDetail` (a URL / number / address). */
  location?: LocationTypeValue;
  locationDetail?: string;
  /** Shared across a recurring series so the whole set can be cancelled/moved
   * together (cancel_bookings scope "series"). Null/undefined = a single booking. */
  recurrenceUid?: string;
}

export interface HostBookingResult {
  uid: string;
  meetingUrl?: string;
}

/**
 * Create a real DayOtter booking on behalf of the host - the path Otter's
 * "book / hold" confirmations run through (and any future manual "add event").
 * Unlike a public booking it skips availability gating (the host is
 * deliberately blocking their own time) but it gets the full treatment: a
 * `bookings` row (so it shows in the app), a best-effort calendar write, and
 * reminders/overflow/scribe. Returns null only if the host has no organization.
 */
export async function createHostBooking(
  input: HostBookingInput,
): Promise<HostBookingResult | null> {
  const db = getDb();
  const fingerprint = createHash("sha256")
    .update(
      canonicalJson({
        ...input,
        start: input.start.toISOString(),
        end: input.end.toISOString(),
        requestId: undefined,
      }),
    )
    .digest("hex");
  const operationKey = `host-booking:${input.userId.toLowerCase()}:${input.requestId?.toLowerCase() ?? fingerprint}`;
  const previous = await db.query.bookings.findFirst({
    where: eq(schema.bookings.creationOperationKey, operationKey),
  });
  if (previous) {
    if (previous.creationFingerprint !== fingerprint)
      throw new BookingError("This request was already used for another appointment", 409);
    return { uid: previous.uid, meetingUrl: previous.meetingUrl ?? undefined };
  }
  const org = await primaryOrg(input.userId);
  if (!org) return null;

  // Resolve the event type: a real matched one (so its workflows apply), else a
  // hidden per-user Personal type.
  let eventTypeId: string | null = null;
  const commercial = Boolean(input.eventTypeSlug && input.eventTypeSlug !== PERSONAL_SLUG);
  if (commercial) {
    const et = await db.query.eventTypes.findFirst({
      where: and(
        eq(schema.eventTypes.ownerId, input.userId),
        eq(schema.eventTypes.slug, input.eventTypeSlug!),
        eq(schema.eventTypes.organizationId, org.id),
      ),
      columns: { id: true },
    });
    if (!et) throw new BookingError("Event type not found", 404);
    eventTypeId = et.id;
  }
  if (!eventTypeId) eventTypeId = await getOrCreatePersonalEventType(input.userId, org.id);

  const uid = randomUUID();
  const attendees = (input.attendees ?? []).filter((a) => a.email.includes("@"));
  let replayed = false;
  let booking: typeof schema.bookings.$inferSelect;
  try {
    booking = await withResourceTransaction(db, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${operationKey}))`);
      const [previous] = await tx
        .select()
        .from(schema.bookings)
        .where(eq(schema.bookings.creationOperationKey, operationKey));
      if (previous) {
        if (previous.creationFingerprint !== fingerprint)
          throw new BookingError("This request was already used for another appointment", 409);
        replayed = true;
        return previous;
      }
      // Host creation has no payment collection workflow. A commercial service
      // must have an authoritative zero-cash quote, just like the public path.
      const [service] = await tx
        .select()
        .from(schema.eventTypes)
        .where(eq(schema.eventTypes.id, eventTypeId!))
        .for("share");
      if (!service || service.organizationId !== org.id || service.ownerId !== input.userId)
        throw new BookingError("Event type not found", 404);
      if (!commercial && ((service.price ?? 0) !== 0 || !service.isPrivate || service.isActive))
        throw new BookingError("Personal booking configuration requires review", 409);
      rejectManagedRecurrence(service, Boolean(input.recurrenceUid));
      const duration = (input.end.getTime() - input.start.getTime()) / 60_000;
      const schedulingPlan = await captureSchedulingPlan(tx, service, duration, input.userId);
      await lockPersonAdmission(tx, (schedulingPlan?.requiresHost ?? true) ? [input.userId] : []);
      const quote = commercial
        ? await quoteAppointmentPrice(
            {
              organizationId: org.id,
              eventTypeId: service.id,
              appointmentStartsAt: input.start,
              settlement: "cash",
            },
            tx,
          )
        : null;
      if (quote && quote.amountToCollect > 0)
        throw new BookingError("A payment is required; book through the public checkout", 402);
      if (quote && quote.basePrice > 0 && input.recurrenceUid)
        throw new BookingError("Commercial recurring checkout is not supported yet", 409);
      const [row] = await tx
        .insert(schema.bookings)
        .values({
          organizationId: org.id,
          eventTypeId: service.id,
          hostId: input.userId,
          title: input.title,
          description: input.notes,
          startsAt: input.start,
          endsAt: input.end,
          timezone: input.timezone,
          status: "confirmed",
          locationType: input.location ?? null,
          location: input.locationDetail ?? null,
          recurrenceUid: input.recurrenceUid ?? null,
          uid,
          schedulingPlan,
          allocationRevision: schedulingPlan ? 1 : null,
          creationOperationKey: schedulingPlan ? operationKey : null,
          creationFingerprint: schedulingPlan ? fingerprint : null,
        })
        .returning();
      if (!row) throw new BookingError("Couldn't create booking", 500);
      if (quote) await persistBookingPricingSnapshot(row.id, quote, tx);
      if (attendees.length)
        await tx.insert(schema.bookingAttendees).values(
          attendees.map((a) => ({
            bookingId: row.id,
            email: a.email,
            name: a.name ?? null,
            timezone: input.timezone,
          })),
        );
      if (schedulingPlan)
        await allocateBookingResources(tx, row.id, "staff_creation", input.userId);
      return row;
    });
  } catch (error) {
    mapInsertError(error);
  }
  if (replayed) return { uid: booking.uid, meetingUrl: booking.meetingUrl ?? undefined };

  // Calendar write (best-effort) + record the reference for later move/delete.
  let meetingUrl: string | undefined;
  try {
    const written = await writeBookingToCalendar(input.userId, {
      title: input.title,
      description: input.notes,
      start: input.start,
      end: input.end,
      timezone: input.timezone,
      transparency: booking.requiresHost ? "opaque" : "transparent",
      attendees: attendees.map((a) => ({ email: a.email, name: a.name })),
      ...calendarLocationFields(input.location, input.locationDetail),
    });
    if (written) {
      meetingUrl = written.meetingUrl;
      if (meetingUrl) {
        await db
          .update(schema.bookings)
          .set({ meetingUrl })
          .where(eq(schema.bookings.id, booking.id));
      }
      await db.insert(schema.bookingReferences).values({
        bookingId: booking.id,
        calendarId: written.calendarId,
        provider: written.provider,
        externalEventId: written.externalEventId,
      });
    }
  } catch (err) {
    logger.error("host booking calendar write failed", {
      event: "host_booking_calendar_failed",
      bookingId: booking.id,
      err,
    });
  }

  // Full lifecycle: reminders, plus overflow / scribe when opted in.
  await scheduleBookingReminders(
    booking.id,
    input.start,
    await reminderOffsetsForHost(input.userId),
  );
  if (booking.requiresHost && (await hostWantsOverflowNotice(input.userId))) {
    await scheduleOverflowCheck(booking.id, input.end);
  }
  if (await hostWantsScribe(input.userId)) {
    await scheduleScribe(booking.id, input.end);
  }

  return { uid, meetingUrl };
}
