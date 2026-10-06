import {
  type Database,
  allocateBookingResources,
  and,
  eq,
  inArray,
  ne,
  schema,
  sql,
  withResourceTransaction,
} from "@dayotter/db";
import { DateTime } from "luxon";
import { BookingError } from "./booking-logic";
import { lockPersonAdmission, lockServiceAdmission } from "./resource-acceptance";

type Booking = typeof schema.bookings.$inferSelect;
type Service = typeof schema.eventTypes.$inferSelect;

/** No provider effects here: retry the whole admission, never a released claim
 * fragment. The accepted plan and settlement stay immutable on ordinary moves.
 */
export async function admitBookingReschedule(
  db: Database,
  expected: Booking,
  predictedService: Service,
  startsAt: Date,
  endsAt: Date,
  reason?: string,
) {
  return withResourceTransaction(db, async (tx) => {
    const [attempt] = await tx
      .select()
      .from(schema.paymentAttempts)
      .where(eq(schema.paymentAttempts.bookingId, expected.id))
      .for("update");
    const service = await lockServiceAdmission(tx, expected.eventTypeId);
    if (
      service.resourceAdmissionEpoch > 0 &&
      (service.resourceAdmissionEpoch !== predictedService.resourceAdmissionEpoch ||
        service.resourceConfigurationRevision !== predictedService.resourceConfigurationRevision ||
        !service.isActive ||
        service.schedulingType !== "individual" ||
        service.maxAttendees !== 1 ||
        service.recurringCount !== 1)
    )
      throw new BookingError("Service configuration changed; retry rescheduling", 409);
    if (!expected.schedulingPlan) {
      const requirement = await tx.query.eventTypeResourceRequirements.findFirst({
        where: eq(schema.eventTypeResourceRequirements.eventTypeId, service.id),
      });
      if (requirement)
        throw new BookingError("This booking requires scheduling adoption review", 409);
    }
    await lockPersonAdmission(
      tx,
      expected.requiresHost && expected.hostId ? [expected.hostId] : [],
    );
    const plan = expected.schedulingPlan;
    const host = expected.hostId
      ? await tx.query.users.findFirst({ where: eq(schema.users.id, expected.hostId) })
      : null;
    const prefs =
      expected.requiresHost && !expected.isGroup && expected.hostId
        ? await tx.query.userPreferences.findFirst({
            where: eq(schema.userPreferences.userId, expected.hostId),
          })
        : null;
    const zone = plan?.capTimezone ?? host?.timezone ?? "UTC";
    const at = DateTime.fromJSDate(startsAt).setZone(zone);
    if (!at.isValid) throw new BookingError("Scheduling timezone requires review", 409);
    const limits = [
      ["day", service.dailyBookingLimit],
      ["week", service.weeklyBookingLimit],
      ["month", service.monthlyBookingLimit],
      ["year", service.yearlyBookingLimit],
    ] as const;
    const keys: string[] = [];
    if (limits.some(([, limit]) => limit != null) || prefs?.adaptiveAvailability) {
      if (expected.requiresHost)
        keys.push(
          `${expected.hostId}:${DateTime.fromJSDate(startsAt)
            .setZone(host?.timezone || "UTC")
            .startOf("week")
            .toISODate()}`,
        );
      for (const [unit, limit] of limits)
        if (limit != null)
          keys.push(`service-cap:${service.id}:${zone}:${unit}:${at.startOf(unit).toISODate()}`);
      if (prefs?.adaptiveAvailability)
        keys.push(`person-cap:${expected.hostId}:${zone}:day:${at.startOf("day").toISODate()}`);
    }
    for (const key of keys.sort())
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
    const [current] = await tx
      .select()
      .from(schema.bookings)
      .where(eq(schema.bookings.id, expected.id))
      .for("update");
    if (!current || !["pending", "confirmed"].includes(current.status))
      throw new BookingError("Booking is not available for rescheduling", 409);
    // A concurrent identical request converges without creating another revision.
    if (
      current.startsAt.getTime() === startsAt.getTime() &&
      current.endsAt.getTime() === endsAt.getTime()
    )
      return null;
    if (
      current.startsAt.getTime() !== expected.startsAt.getTime() ||
      current.endsAt.getTime() !== expected.endsAt.getTime() ||
      current.allocationRevision !== expected.allocationRevision ||
      current.status !== expected.status
    )
      throw new BookingError("Booking changed; reload before rescheduling", 409);
    if (current.hostId !== expected.hostId || current.eventTypeId !== expected.eventTypeId)
      throw new BookingError("Booking configuration changed", 409);
    if (plan) {
      const schedule = await tx.query.schedules.findFirst({
        where: eq(schema.schedules.id, plan.scheduleId),
      });
      if (
        !schedule ||
        schedule.userId !== plan.scheduleOwnerId ||
        plan.scheduleOwnerId !== current.hostId ||
        (plan.requiresHost && !plan.requiredHostIds.includes(current.hostId!))
      )
        throw new BookingError("Accepted scheduling terms require review", 409);
      if (endsAt.getTime() - startsAt.getTime() !== plan.durationMinutes * 60000)
        throw new BookingError("Accepted duration requires review", 409);
    }
    if (
      attempt &&
      ["pending", "running", "requires_review"].includes(attempt.finalizationState ?? "")
    )
      throw new BookingError(
        "This paid booking needs finalization review before rescheduling",
        409,
      );
    const redemption = await tx.query.packageCreditMutations.findFirst({
      where: and(
        eq(schema.packageCreditMutations.bookingId, current.id),
        eq(schema.packageCreditMutations.kind, "redemption"),
      ),
    });
    if (
      redemption &&
      ["pending", "running", "requires_review"].includes(redemption.finalizationState ?? "")
    )
      throw new BookingError(
        "This prepaid booking needs finalization review before rescheduling",
        409,
      );
    if (current.requiresHost && !current.isGroup && current.hostId) {
      const before = plan?.bufferBeforeMinutes ?? service.bufferBeforeMinutes;
      const after = plan?.bufferAfterMinutes ?? service.bufferAfterMinutes;
      const gap = plan?.minimumGapMinutes ?? service.minimumGapMinutes;
      const conflicts = await tx
        .select({ id: schema.bookings.id })
        .from(schema.bookings)
        .where(
          and(
            eq(schema.bookings.hostId, current.hostId),
            eq(schema.bookings.requiresHost, true),
            ne(schema.bookings.id, current.id),
            inArray(schema.bookings.status, ["pending", "confirmed"]),
            sql`${schema.bookings.startsAt} - ${gap} * interval '1 minute' < ${new Date(endsAt.getTime() + after * 60000)}`,
            sql`${schema.bookings.endsAt} + ${gap} * interval '1 minute' > ${new Date(startsAt.getTime() - before * 60000)}`,
          ),
        )
        .limit(1);
      if (conflicts.length) throw new BookingError("That time is no longer available", 409);
    }
    for (const [unit, limit] of limits)
      if (limit != null) {
        const beginning = at.startOf(unit);
        const next = beginning.plus({
          [unit === "day"
            ? "days"
            : unit === "week"
              ? "weeks"
              : unit === "month"
                ? "months"
                : "years"]: 1,
        });
        const result = await tx.execute<{
          count: number;
        }>(sql`select count(*)::int as count from bookings
        where event_type_id=${service.id}::uuid and id<>${current.id}::uuid and status in ('pending','confirmed')
        and starts_at>=${beginning.toJSDate()} and starts_at<${next.toJSDate()}`);
        if (result.rows[0]!.count >= limit)
          throw new BookingError("That period is fully booked", 409);
      }
    if (prefs?.adaptiveAvailability) {
      const beginning = at.startOf("day");
      const result = await tx.execute<{
        count: number;
      }>(sql`select count(*)::int as count from bookings
        where requires_host AND host_id=${current.hostId}::uuid and id<>${current.id}::uuid and status in ('pending','confirmed')
        and starts_at>=${beginning.toJSDate()} and starts_at<${beginning.plus({ days: 1 }).toJSDate()}`);
      if (result.rows[0]!.count >= (prefs.maxMeetingsPerDay ?? 5))
        throw new BookingError("That day is protected for focus", 409);
    }
    // Tentative host-index update BEFORE resource fences. Failure anywhere below
    // restores this row and every previous claim, including the old revision.
    const [moved] = await tx
      .update(schema.bookings)
      .set({
        startsAt,
        endsAt,
        rescheduleReason: reason ?? null,
        ...(plan ? { allocationRevision: current.allocationRevision! + 1 } : {}),
      })
      .where(eq(schema.bookings.id, current.id))
      .returning();
    if (plan) await allocateBookingResources(tx, current.id, "reschedule");
    return moved!;
  });
}
