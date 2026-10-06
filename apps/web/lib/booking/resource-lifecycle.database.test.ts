import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Slot } from "@dayotter/core";
import { and, classifyResourceError, createDatabase, eq, schema, sql } from "@dayotter/db";
import type { ResourceOpeningHours } from "@dayotter/db/schema";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { grantPackageToCustomer } from "../packages/credits";
import { decideBookingCancellation } from "../payments/refunds";
import { eventConstraints, getEventTypeAvailability, hostSlots } from "./availability";
import { cancelBookingWithResult } from "./cancel-booking";
import { approveBooking, declineBooking } from "./confirm-booking";
import { createBooking } from "./create-booking";
import { createHostBooking } from "./host-booking";
import { admitBookingReschedule } from "./reschedule-admission";
import { rescheduleBooking } from "./reschedule-booking";
import {
  acceptedBookingResourceAvailable,
  filterResourceAvailability,
} from "./resource-availability";
const mock = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof createDatabase>,
  calendar: vi.fn(async () => undefined),
  hostId: "",
}));
vi.mock("@dayotter/db", async (original) => ({
  ...(await original<typeof import("@dayotter/db")>()),
  getDb: () => mock.db,
}));
vi.mock("../server/env", () => ({ env: { APP_URL: "https://example.test" } }));
vi.mock("../calendar/host-calendar", () => ({
  writeBookingToCalendar: async () => null,
  updateBookingCalendarEvent: mock.calendar,
  deleteBookingFromCalendar: vi.fn(),
}));
vi.mock("./finalize-booking", () => ({ finalizeConfirmedBooking: vi.fn() }));
vi.mock("./reminders", () => ({
  scheduleBookingReminders: vi.fn(),
  clearBookingReminders: vi.fn(),
  scheduleWorkflowMessages: vi.fn(),
  reminderOffsetsForHost: async () => [],
  hostWantsOverflowNotice: async () => false,
  hostWantsScribe: async () => false,
  scheduleOverflowCheck: vi.fn(),
  scheduleScribe: vi.fn(),
}));
vi.mock("./lifecycle", () => ({ fanOutBookingLifecycle: vi.fn() }));
vi.mock("./travel", () => ({ reserveTravelBlocks: vi.fn() }));
vi.mock("../automation/apply-rules", () => ({ reserveRuleBlocks: vi.fn(async () => {}) }));
vi.mock("@dayotter/emails", () => ({
  bookingRescheduled: vi.fn(),
  bookingCancellation: vi.fn(),
  bookingDeclined: vi.fn(),
  bookingRequested: vi.fn(),
  newBookingRequest: vi.fn(),
  sendEmail: vi.fn(),
}));
vi.mock("@/lib/server/rate-limit", () => ({ enforceRateLimit: async () => null }));
vi.mock("@/lib/server/http", () => ({
  jsonError: (error: string, status: number) => Response.json({ error }, { status }),
  withUser:
    (handler: (user: { id: string }, request: Request, context: unknown) => Promise<Response>) =>
    (request: Request, context: unknown) =>
      handler({ id: mock.hostId }, request, context),
}));
import { POST as cancelRoute } from "../../app/api/bookings/[uid]/cancel/route";
import { POST as declineRoute } from "../../app/api/bookings/[uid]/decline/route";
import { POST as noShowRoute } from "../../app/api/bookings/[uid]/no-show/route";
import { POST as rescheduleRoute } from "../../app/api/bookings/[uid]/reschedule/route";
const url = process.env.RESOURCES_TEST_DATABASE_URL;
describe.skipIf(!url)("Resource booking lifecycle PostgreSQL", () => {
  const databaseName = `dayotter_resources_test_${randomUUID().replaceAll("-", "")}`;
  let admin: ReturnType<typeof createDatabase>;
  let db: ReturnType<typeof createDatabase>;
  let created = false;
  const org = randomUUID();
  const clientUser = randomUUID();
  const otherOrg = randomUUID();
  const at = (time: string) => new Date(`2030-01-01T${time}:00.000Z`);
  const slot = (start = "10:00", end = "10:30"): Slot => ({ start: at(start), end: at(end) });
  const hours = (from = "10:00", to = "11:00", timezone = "UTC"): ResourceOpeningHours => ({
    timezone,
    rules: Array.from({ length: 7 }, (_, dayOfWeek) => ({
      dayOfWeek,
      startTime: from,
      endTime: to,
    })),
    overrides: [],
  });
  beforeAll(async () => {
    const target = new URL(url!);
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
      target.pathname !== "/dayotter_resources_test"
    )
      throw new Error("Use the guarded loopback Resource test database");
    admin = createDatabase(target.toString());
    await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    target.pathname = `/${databaseName}`;
    db = createDatabase(target.toString());
    mock.db = db;
    const directory = new URL("../../../../packages/db/drizzle/", import.meta.url);
    const journal = JSON.parse(
      await readFile(new URL("meta/_journal.json", directory), "utf8"),
    ) as { entries: { tag: string }[] };
    const client = await db.$client.connect();
    try {
      for (const { tag } of journal.entries) {
        await client.query("BEGIN");
        for (const statement of (await readFile(new URL(`${tag}.sql`, directory), "utf8")).split(
          "--> statement-breakpoint",
        ))
          if (statement.trim()) await client.query(statement);
        await client.query("COMMIT");
      }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    await db.insert(schema.users).values({
      id: clientUser,
      email: "client@example.test",
      emailVerified: true,
      timezone: "UTC",
    });
    await db.insert(schema.organizations).values([
      { id: org, name: "Availability tests", slug: randomUUID() },
      { id: otherOrg, name: "Other availability tests", slug: randomUUID() },
    ]);
  }, 180000);
  afterAll(async () => {
    await db?.$client.end();
    if (created) await admin.$client.query(`DROP DATABASE "${databaseName}"`);
    await admin?.$client.end();
  });
  async function resource(
    capacity = 1,
    openingHours: ResourceOpeningHours | null = null,
    organizationId = org,
  ) {
    const [r] = await db
      .insert(schema.resources)
      .values({ organizationId, name: "Test equipment", capacity, openingHours })
      .returning();
    return r!.id;
  }
  async function service(
    requirements: { id: string; quantity?: number }[] = [],
    organizationId = org,
  ) {
    const host = randomUUID();
    const schedule = randomUUID();
    await db
      .insert(schema.users)
      .values({ id: host, email: `${host}@example.test`, timezone: "UTC" });
    await db.insert(schema.memberships).values({ organizationId, userId: host, role: "owner" });
    await db
      .insert(schema.schedules)
      .values({ id: schedule, userId: host, timezone: "UTC", isDefault: true });
    await db.insert(schema.availabilityRules).values(
      Array.from({ length: 7 }, (_, dayOfWeek) => ({
        scheduleId: schedule,
        dayOfWeek,
        startTime: "08:00",
        endTime: "18:00",
      })),
    );
    const [e] = await db
      .insert(schema.eventTypes)
      .values({
        organizationId,
        ownerId: host,
        scheduleId: schedule,
        title: "Treatment",
        slug: randomUUID(),
        durationMinutes: 30,
        minimumNoticeMinutes: 0,
        bookingWindowDays: null,
        location: "in_person",
      })
      .returning();
    for (const r of requirements)
      await db.insert(schema.eventTypeResourceRequirements).values({
        organizationId,
        eventTypeId: e!.id,
        resourceId: r.id,
        quantity: r.quantity ?? 1,
      });
    if (requirements.length)
      await db
        .update(schema.eventTypes)
        .set({ resourceAdmissionEpoch: 1 })
        .where(eq(schema.eventTypes.id, e!.id));
    return (await db.query.eventTypes.findFirst({ where: eq(schema.eventTypes.id, e!.id) }))!;
  }
  async function book(
    e: typeof schema.eventTypes.$inferSelect,
    start = at("10:00"),
    end = at("10:30"),
  ) {
    const result = await createHostBooking({
      userId: e.ownerId!,
      eventTypeSlug: e.slug,
      requestId: randomUUID(),
      title: "Treatment",
      start,
      end,
      timezone: "UTC",
    });
    return (await db.query.bookings.findFirst({ where: eq(schema.bookings.uid, result!.uid) }))!;
  }
  const reload = (id: string) => db.query.bookings.findFirst({ where: eq(schema.bookings.id, id) });
  const claims = (id: string) =>
    db.query.bookingResourceClaims.findMany({
      where: eq(schema.bookingResourceClaims.bookingId, id),
      orderBy: (c, { asc }) => [asc(c.allocationRevision), asc(c.resourceId)],
    });
  const move = (
    b: typeof schema.bookings.$inferSelect,
    e: typeof schema.eventTypes.$inferSelect,
    from = "11:00",
    to = "11:30",
  ) => admitBookingReschedule(db, b, e, at(from), at(to));
  const offered = (e: typeof schema.eventTypes.$inferSelect, from = "10:00", to = "10:30") =>
    filterResourceAvailability(e, [slot(from, to)], db);
  it("customer/staff/SMS common reschedule moves claims and availability atomically", async () => {
    const r = await resource();
    const e = await service([{ id: r }]);
    const b = await book(e);
    const observer = await service([{ id: r }]);
    expect(await offered(observer)).toEqual([]);
    await rescheduleBooking(b.uid, at("11:00").toISOString(), "Move");
    expect((await reload(b.id))!.allocationRevision).toBe(2);
    expect(await offered(observer)).toEqual([slot()]);
    expect(await offered(observer, "11:00", "11:30")).toEqual([]);
    const history = await claims(b.id);
    expect(history).toHaveLength(2);
    expect(history[0]!.releaseReason).toBe("rescheduled");
    expect(history[1]!.predecessorId).toBe(history[0]!.id);
    expect(history[1]!.releasedAt).toBeNull();
    expect(history[0]!.startsAt).toEqual(at("10:00"));
  });
  it("resource-less bookings preserve duration and ordinary lifecycle", async () => {
    const e = await service();
    const b = await book(e);
    await rescheduleBooking(b.uid, at("11:00").toISOString());
    expect((await reload(b.id))!.startsAt).toEqual(at("11:00"));
    expect(await claims(b.id)).toEqual([]);
    expect((await cancelBookingWithResult(b.uid))!.changed).toBe(true);
  });
  it("capacity failure rolls back terms, revision and the complete original claims", async () => {
    const r = await resource();
    const e = await service([{ id: r }]);
    const b = await book(e);
    await book(await service([{ id: r }]), at("11:00"), at("11:30"));
    const before = await claims(b.id);
    await expect(rescheduleBooking(b.uid, at("11:00").toISOString())).rejects.toMatchObject({
      status: 409,
    });
    expect(await reload(b.id)).toEqual(b);
    expect(await claims(b.id)).toEqual(before);
  });
  it("closed resource fails atomically even after a tentative time UPDATE", async () => {
    const r = await resource(1, hours("10:00", "10:30"));
    const e = await service([{ id: r }]);
    const b = await book(e);
    const before = await claims(b.id);
    await expect(move(b, e)).rejects.toSatisfy(
      (error: unknown) => classifyResourceError(error)?.category === "conflict",
    );
    expect(await reload(b.id)).toEqual(b);
    expect(await claims(b.id)).toEqual(before);
  });
  it("multiple-resource conflict replaces none; a valid move replaces all", async () => {
    const r = await resource();
    const s = await resource();
    const e = await service([{ id: r }, { id: s }]);
    const b = await book(e);
    const blocker = await book(await service([{ id: s }]), at("11:00"), at("11:30"));
    const before = await claims(b.id);
    await expect(move(b, e)).rejects.toBeDefined();
    expect(await claims(b.id)).toEqual(before);
    await decideBookingCancellation(blocker.uid, undefined, db);
    await move(b, e);
    const history = await claims(b.id);
    expect(history.filter((c) => !c.releasedAt)).toHaveLength(2);
    expect(history.filter((c) => c.releaseReason === "rescheduled")).toHaveLength(2);
  });
  it("quantity two fits capacity three with one destination unit; a fourth cannot fit", async () => {
    const r = await resource(3);
    const e = await service([{ id: r, quantity: 2 }]);
    const b = await book(e);
    await book(await service([{ id: r }]), at("11:00"), at("11:30"));
    await move(b, e);
    const second = await book(await service([{ id: r }]));
    await expect(
      move(
        second,
        (await db.query.eventTypes.findFirst({
          where: eq(schema.eventTypes.id, second.eventTypeId),
        }))!,
      ),
    ).rejects.toBeDefined();
    expect((await claims(b.id)).filter((c) => !c.releasedAt)[0]!.quantity).toBe(2);
  });
  it("half-open adjacent destination fits and self-overlapping movement excludes old claims", async () => {
    const r = await resource();
    const e = await service([{ id: r }]);
    const b = await book(e);
    await book(await service([{ id: r }]), at("11:30"), at("12:00"));
    await move(b, e);
    expect((await reload(b.id))!.startsAt).toEqual(at("11:00"));
    await expect(move((await reload(b.id))!, e, "11:15", "11:45")).rejects.toBeDefined();
    expect((await reload(b.id))!.startsAt).toEqual(at("11:00"));
    await move((await reload(b.id))!, e, "10:45", "11:15");
    expect((await reload(b.id))!.startsAt).toEqual(at("10:45"));
  });
  it("frozen resource quantities and buffers survive mutable service edits", async () => {
    const r = await resource(2);
    let e = await service([{ id: r, quantity: 2 }]);
    await db
      .update(schema.eventTypes)
      .set({ bufferBeforeMinutes: 10, bufferAfterMinutes: 15 })
      .where(eq(schema.eventTypes.id, e.id));
    e = (await db.query.eventTypes.findFirst({ where: eq(schema.eventTypes.id, e.id) }))!;
    const b = await book(e);
    await db.execute(
      sql`select resource_set_requirements(${e.id}::uuid,${JSON.stringify([{ id: r, quantity: 1 }])}::jsonb)`,
    );
    await db
      .update(schema.eventTypes)
      .set({ bufferBeforeMinutes: 0, bufferAfterMinutes: 0 })
      .where(eq(schema.eventTypes.id, e.id));
    e = (await db.query.eventTypes.findFirst({ where: eq(schema.eventTypes.id, e.id) }))!;
    await rescheduleBooking(b.uid, at("11:00").toISOString());
    expect((await reload(b.id))!.schedulingPlan).toEqual(b.schedulingPlan);
    const c = (await claims(b.id)).find((c) => !c.releasedAt)!;
    expect(c.startsAt).toEqual(at("10:50"));
    expect(c.endsAt).toEqual(at("11:45"));
    expect(c.quantity).toBe(2);
    expect(await offered(await service([{ id: r }]), "11:30", "12:00")).toEqual([]);
  });
  it("destination resource hours cover buffers, not merely the appointment", async () => {
    const r = await resource(1, hours("08:00", "11:30"));
    let e = await service([{ id: r }]);
    await db
      .update(schema.eventTypes)
      .set({ bufferAfterMinutes: 15 })
      .where(eq(schema.eventTypes.id, e.id));
    e = (await db.query.eventTypes.findFirst({ where: eq(schema.eventTypes.id, e.id) }))!;
    const b = await book(e);
    await expect(move(b, e)).rejects.toBeDefined();
    expect((await reload(b.id))!.startsAt).toEqual(b.startsAt);
  });
  it("accepted schedule identity is retained when service schedule changes", async () => {
    const e = await service([{ id: await resource() }]);
    const b = await book(e);
    const alternate = randomUUID();
    await db
      .insert(schema.schedules)
      .values({ id: alternate, userId: e.ownerId!, timezone: "UTC", isDefault: false });
    await db
      .update(schema.eventTypes)
      .set({ scheduleId: alternate })
      .where(eq(schema.eventTypes.id, e.id));
    await rescheduleBooking(b.uid, at("11:00").toISOString());
    expect((await reload(b.id))!.schedulingPlan!.scheduleId).toBe(e.scheduleId);
  });
  it("accepted schedule live hours are used without default fallback", async () => {
    const e = await service([{ id: await resource() }]);
    const b = await book(e);
    await db
      .update(schema.availabilityRules)
      .set({ endTime: "10:30" })
      .where(eq(schema.availabilityRules.scheduleId, e.scheduleId!));
    await expect(rescheduleBooking(b.uid, at("11:00").toISOString())).rejects.toMatchObject({
      status: 409,
    });
    expect((await reload(b.id))!.startsAt).toEqual(b.startsAt);
  });
  it("inactive resources block moves but do not prevent release", async () => {
    const r = await resource();
    const e = await service([{ id: r }]);
    const b = await book(e);
    await db.update(schema.resources).set({ enabled: false }).where(eq(schema.resources.id, r));
    await expect(move(b, e)).rejects.toBeDefined();
    await decideBookingCancellation(b.uid, undefined, db);
    expect((await claims(b.id))[0]!.releaseReason).toBe("cancelled");
  });
  it("service admission epoch/configuration race rejects without adopting new terms", async () => {
    const r = await resource();
    const e = await service([{ id: r }]);
    const b = await book(e);
    await db.execute(
      sql`select resource_set_requirements(${e.id}::uuid,${JSON.stringify([{ id: r, quantity: 1 }])}::jsonb)`,
    );
    await expect(move(b, e)).rejects.toMatchObject({ status: 409 });
    expect(await reload(b.id)).toEqual(b);
    expect(await claims(b.id)).toHaveLength(1);
  });
  it("resource activation does not silently adopt a legacy booking on move", async () => {
    let e = await service();
    const b = await book(e);
    const r = await resource();
    await db
      .insert(schema.eventTypeResourceRequirements)
      .values({ organizationId: org, eventTypeId: e.id, resourceId: r });
    e = (await db.query.eventTypes.findFirst({ where: eq(schema.eventTypes.id, e.id) }))!;
    await expect(move(b, e)).rejects.toMatchObject({ status: 409 });
    expect(await reload(b.id)).toEqual(b);
    await decideBookingCancellation(b.uid, undefined, db);
    expect((await reload(b.id))!.status).toBe("cancelled");
  });
  it("simultaneous different moves of one revision admit exactly one", async () => {
    const e = await service([{ id: await resource() }]);
    const b = await book(e);
    const outcomes = await Promise.allSettled([move(b, e), move(b, e, "12:00", "12:30")]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect((await reload(b.id))!.allocationRevision).toBe(2);
    expect(await claims(b.id)).toHaveLength(2);
  });
  it("duplicate concurrent same-target moves converge without duplicate claims", async () => {
    const e = await service([{ id: await resource() }]);
    const b = await book(e);
    await Promise.all([move(b, e), move(b, e)]);
    expect((await reload(b.id))!.allocationRevision).toBe(2);
    expect(await claims(b.id)).toHaveLength(2);
  });
  it("two bookings compete for one resource destination, opposite requirement ordering", async () => {
    const r = await resource();
    const s = await resource();
    const a = await service([{ id: r }, { id: s }]);
    const b = await service([{ id: s }, { id: r }]);
    const first = await book(a);
    const second = await book(b, at("09:00"), at("09:30"));
    const outcomes = await Promise.allSettled([move(first, a), move(second, b)]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const active = [...(await claims(first.id)), ...(await claims(second.id))].filter(
      (c) => !c.releasedAt && c.startsAt.getTime() === at("11:00").getTime(),
    );
    expect(active).toHaveLength(2);
    const loser = outcomes[0]!.status === "rejected" ? first : second;
    expect(await reload(loser.id)).toEqual(loser);
  });
  it("fresh admission vs reschedule admits at most capacity", async () => {
    const r = await resource();
    const e = await service([{ id: r }]);
    const b = await book(e);
    const fresh = await service([{ id: r }]);
    const outcomes = await Promise.allSettled([move(b, e), book(fresh, at("11:00"), at("11:30"))]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
  });
  it("cancellation vs reschedule leaves one complete terminal state", async () => {
    const e = await service([{ id: await resource() }]);
    const b = await book(e);
    await Promise.allSettled([move(b, e), decideBookingCancellation(b.uid, undefined, db)]);
    expect((await reload(b.id))!.status).toBe("cancelled");
    const history = await claims(b.id);
    expect(history.every((c) => c.releasedAt)).toBe(true);
    expect(history.filter((c) => c.releaseReason === "cancelled")).toHaveLength(1);
  });
  it("cancellation releases capacity once with durable history and immediate availability", async () => {
    const r = await resource();
    const e = await service([{ id: r }]);
    const b = await book(e);
    const observer = await service([{ id: r }]);
    const decisions = await Promise.all([
      decideBookingCancellation(b.uid, "cancel", db),
      decideBookingCancellation(b.uid, "duplicate", db),
    ]);
    expect(decisions.filter((d) => d!.changed)).toHaveLength(1);
    const history = await claims(b.id);
    expect(history).toHaveLength(1);
    expect(history[0]!.releaseReason).toBe("cancelled");
    expect(await offered(observer)).toEqual([slot()]);
    await decideBookingCancellation(b.uid, undefined, db);
    expect(await claims(b.id)).toEqual(history);
  });
  it("cancel vs fresh admission cannot overbook, and retry after release succeeds", async () => {
    const r = await resource();
    const e = await service([{ id: r }]);
    const b = await book(e);
    const fresh = await service([{ id: r }]);
    const [, admission] = await Promise.allSettled([
      decideBookingCancellation(b.uid, undefined, db),
      book(fresh),
    ]);
    if (admission.status === "rejected") await book(fresh);
    expect(await offered(await service([{ id: r }]))).toEqual([]);
    expect((await claims(b.id))[0]!.releasedAt).not.toBeNull();
  });
  it("pending requests move claims; concurrent decline releases them and stays terminal", async () => {
    const e = await service([{ id: await resource() }]);
    const b = await book(e);
    await db.update(schema.bookings).set({ status: "pending" }).where(eq(schema.bookings.id, b.id));
    const pending = (await reload(b.id))!;
    await move(pending, e);
    const results = await Promise.all([
      declineBooking(b.uid, e.ownerId!),
      declineBooking(b.uid, e.ownerId!),
    ]);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect((await reload(b.id))!.status).toBe("rejected");
    expect((await claims(b.id)).every((c) => c.releasedAt)).toBe(true);
    expect(await approveBooking(b.uid, e.ownerId!)).toBe("not_pending");
    expect((await decideBookingCancellation(b.uid, undefined, db))!.changed).toBe(false);
  });
  it("raw time/status writers cannot bypass deferred resource completeness", async () => {
    const e = await service([{ id: await resource() }]);
    const b = await book(e);
    await expect(
      db
        .update(schema.bookings)
        .set({ startsAt: at("11:00"), endsAt: at("11:30"), allocationRevision: 2 })
        .where(eq(schema.bookings.id, b.id)),
    ).rejects.toBeDefined();
    await expect(
      db.update(schema.bookings).set({ status: "cancelled" }).where(eq(schema.bookings.id, b.id)),
    ).rejects.toBeDefined();
    expect(await reload(b.id)).toEqual(b);
  });
  it("organization isolation: another organization's claim cannot block movement", async () => {
    const r = await resource();
    const other = await resource(1, null, otherOrg);
    const e = await service([{ id: r }]);
    const b = await book(e);
    await book(await service([{ id: other }], otherOrg), at("11:00"), at("11:30"));
    await move(b, e);
    expect((await reload(b.id))!.allocationRevision).toBe(2);
  });
  it("DST spring gap and fall fold use the same SQL opening resolver on moves", async () => {
    for (const [day, start, destination] of [
      ["2030-03-10", "07:00", "07:30"],
      ["2030-11-03", "06:00", "07:30", "08:00"],
    ]) {
      const r = await resource(1, hours("02:30", "04:00", "America/New_York"));
      const e = await service([{ id: r }]);
      // Original allocation uses unrestricted hours, then admission enforces the live DST rules.
      await db
        .update(schema.resources)
        .set({ openingHours: null })
        .where(eq(schema.resources.id, r));
      const b = await book(
        e,
        new Date(`${day}T${start}:00Z`),
        new Date(new Date(`${day}T${start}:00Z`).getTime() + 1800000),
      );
      await db
        .update(schema.resources)
        .set({ openingHours: hours("02:30", "04:00", "America/New_York") })
        .where(eq(schema.resources.id, r));
      const target = new Date(`${day}T${destination}:00Z`);
      await admitBookingReschedule(db, b, e, target, new Date(target.getTime() + 1800000));
      expect((await reload(b.id))!.startsAt).toEqual(target);
    }
  });
  const intent = (e: typeof schema.eventTypes.$inferSelect) => ({
    eventTypeId: e.id,
    start: at("10:00").toISOString(),
    attendee: { name: "Client", email: "client@example.test", timezone: "UTC" },
    bookingRequestId: randomUUID(),
  });
  it("declining a pending zero-cash coupon booking restores its use and resource capacity exactly once", async () => {
    const migrations = new URL("../../../../packages/db/drizzle/", import.meta.url);
    const legacy = await readFile(new URL("0069_appointment_coupons.sql", migrations), "utf8");
    // Seed the already-accepted pending booking with the actual pre-0074 guards.
    for (const name of ["guard_coupon_restoration", "check_coupon_booking"]) {
      const start = legacy.indexOf(`CREATE FUNCTION ${name}(`);
      const end = legacy.indexOf("END $$;", start) + "END $$;".length;
      await db.$client.query(
        legacy.slice(start, end).replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION"),
      );
    }
    const r = await resource();
    const e = await service([{ id: r }]);
    await db
      .update(schema.eventTypes)
      .set({ price: 5000, currency: "usd", requiresConfirmation: true })
      .where(eq(schema.eventTypes.id, e.id));
    const [coupon] = await db
      .insert(schema.appointmentCoupons)
      .values({
        organizationId: org,
        code: `C${randomUUID().replaceAll("-", "").toUpperCase()}`,
        discountKind: "percentage",
        startsAt: new Date("2029-01-01Z"),
        endsAt: new Date("2031-01-01Z"),
        validityTimezone: "UTC",
        discountValue: 10000,
        globalLimit: 1,
        perCustomerLimit: 1,
      })
      .returning();
    await db
      .insert(schema.appointmentCouponEventTypes)
      .values({ organizationId: org, couponId: coupon!.id, eventTypeId: e.id });
    const observer = await service([{ id: r }]);
    const input = {
      ...intent(e),
      couponCode: coupon!.code,
      couponCustomerUserId: clientUser,
      bookingRequestId: randomUUID(),
    };
    const result = await createBooking(input);
    const b = (await db.query.bookings.findFirst({ where: eq(schema.bookings.uid, result.uid) }))!;
    await db.$client.query(
      await readFile(new URL("0074_resource_decline_coupon_restoration.sql", migrations), "utf8"),
    );
    expect(await reload(b.id)).toEqual(b); // Function-only upgrade preserves accepted rows.
    expect(b.status).toBe("pending");
    expect(await offered(observer)).toEqual([]);
    // Even a raw rejection with released resource claims must restore the coupon.
    await expect(
      db.transaction(async (tx) => {
        await tx
          .update(schema.bookings)
          .set({ status: "rejected" })
          .where(eq(schema.bookings.id, b.id));
        await tx.execute(sql`select resource_release_booking(${b.id}::uuid)`);
      }),
    ).rejects.toBeDefined();
    expect((await reload(b.id))!.status).toBe("pending");
    expect((await claims(b.id))[0]!.releasedAt).toBeNull();
    const results = await Promise.all([
      declineBooking(b.uid, e.ownerId!),
      declineBooking(b.uid, e.ownerId!),
    ]);
    expect(results.filter((result) => result === "ok")).toHaveLength(1);
    expect((await reload(b.id))!.status).toBe("rejected");
    expect((await claims(b.id))[0]!.releaseReason).toBe("rejected");
    expect(await offered(observer)).toEqual([slot()]);
    expect(
      await db.query.appointmentCouponRestorations.findMany({
        where: eq(schema.appointmentCouponRestorations.bookingId, b.id),
      }),
    ).toHaveLength(1);
    expect(
      (await db.query.appointmentCouponUses.findFirst({
        where: eq(schema.appointmentCouponUses.bookingId, b.id),
      }))!.status,
    ).toBe("restored");
    expect(await approveBooking(b.uid, e.ownerId!)).toBe("not_pending");
    await createBooking({ ...input, bookingRequestId: randomUUID() });
    expect(await offered(observer)).toEqual([]);
    expect(
      (
        await db.query.appointmentCouponUses.findMany({
          where: eq(schema.appointmentCouponUses.couponId, coupon!.id),
        })
      )
        .map((use) => use.status)
        .sort(),
    ).toEqual(["redeemed", "restored"]);
  });
  it("reschedule preserves pricing and limited coupon; concurrent cancellation restores exactly once", async () => {
    const e = await service([{ id: await resource() }]);
    await db
      .update(schema.eventTypes)
      .set({ price: 5000, currency: "usd" })
      .where(eq(schema.eventTypes.id, e.id));
    const [coupon] = await db
      .insert(schema.appointmentCoupons)
      .values({
        organizationId: org,
        code: `C${randomUUID().replaceAll("-", "").toUpperCase()}`,
        discountKind: "percentage",
        startsAt: new Date("2029-01-01Z"),
        endsAt: new Date("2031-01-01Z"),
        validityTimezone: "UTC",
        discountValue: 10000,
        globalLimit: 1,
        perCustomerLimit: 1,
      })
      .returning();
    await db
      .insert(schema.appointmentCouponEventTypes)
      .values({ organizationId: org, couponId: coupon!.id, eventTypeId: e.id });
    const result = await createBooking({
      ...intent(e),
      couponCode: coupon!.code,
      couponCustomerUserId: clientUser,
    });
    const b = (await db.query.bookings.findFirst({ where: eq(schema.bookings.uid, result.uid) }))!;
    const snapshot = await db.query.bookingPricingSnapshots.findFirst({
      where: eq(schema.bookingPricingSnapshots.bookingId, b.id),
    });
    await db
      .update(schema.appointmentCoupons)
      .set({ isActive: false })
      .where(eq(schema.appointmentCoupons.id, coupon!.id));
    await db.update(schema.eventTypes).set({ price: 9900 }).where(eq(schema.eventTypes.id, e.id));
    await rescheduleBooking(b.uid, at("11:00").toISOString());
    expect(
      await db.query.bookingPricingSnapshots.findFirst({
        where: eq(schema.bookingPricingSnapshots.bookingId, b.id),
      }),
    ).toEqual(snapshot);
    const uses = await db.query.appointmentCouponUses.findMany({
      where: eq(schema.appointmentCouponUses.bookingId, b.id),
    });
    expect(uses).toHaveLength(1);
    expect(uses[0]!.status).toBe("redeemed");
    await Promise.all([
      decideBookingCancellation(b.uid, undefined, db),
      decideBookingCancellation(b.uid, undefined, db),
    ]);
    expect(
      await db.query.appointmentCouponRestorations.findMany({
        where: eq(schema.appointmentCouponRestorations.bookingId, b.id),
      }),
    ).toHaveLength(1);
    expect(
      (await db.query.appointmentCouponUses.findFirst({
        where: eq(schema.appointmentCouponUses.bookingId, b.id),
      }))!.status,
    ).toBe("restored");
  });
  it("package move consumes no extra credit, preserves paid state, and cancellation restores once", async () => {
    const e = await service([{ id: await resource() }]);
    await db
      .update(schema.eventTypes)
      .set({ price: 5000, currency: "usd" })
      .where(eq(schema.eventTypes.id, e.id));
    const [p] = await db
      .insert(schema.sessionPackages)
      .values({
        organizationId: org,
        eventTypeId: e.id,
        name: "Two sessions",
        sessionCount: 2,
        priceAmount: 5000,
      })
      .returning();
    const credit = await grantPackageToCustomer(
      e.ownerId!,
      p!.id,
      "client@example.test",
      randomUUID(),
      db,
    );
    const result = await createBooking({
      ...intent(e),
      redeemCredit: true,
      creditOwnerUserId: clientUser,
      creditRequestId: randomUUID(),
    });
    const b = (await db.query.bookings.findFirst({ where: eq(schema.bookings.uid, result.uid) }))!;
    await rescheduleBooking(b.uid, at("11:00").toISOString());
    expect((await reload(b.id))!.paymentStatus).toBe("paid");
    expect(
      (await db.query.packageCredits.findFirst({ where: eq(schema.packageCredits.id, credit) }))!
        .usedCredits,
    ).toBe(1);
    await Promise.all([
      decideBookingCancellation(b.uid, undefined, db),
      decideBookingCancellation(b.uid, undefined, db),
    ]);
    expect(
      (await db.query.packageCredits.findFirst({ where: eq(schema.packageCredits.id, credit) }))!
        .usedCredits,
    ).toBe(0);
    const mutations = await db.query.packageCreditMutations.findMany({
      where: eq(schema.packageCreditMutations.bookingId, b.id),
    });
    expect(mutations.filter((m) => m.kind === "redemption")).toHaveLength(1);
    expect(mutations.filter((m) => m.kind === "restoration")).toHaveLength(1);
  });
  it("prediction excludes only owned reserved blocks and exact calendar mirrors", async () => {
    const e = await service([{ id: await resource() }]);
    const b = await book(e);
    const [connection] = await db
      .insert(schema.calendarConnections)
      .values({
        userId: e.ownerId!,
        provider: "google",
        externalAccountId: randomUUID(),
        credentials: "test-only-unused",
      })
      .returning();
    const [calendar] = await db
      .insert(schema.calendars)
      .values({
        connectionId: connection!.id,
        externalId: randomUUID(),
        name: "Test calendar",
        checkForConflicts: true,
      })
      .returning();
    const external = randomUUID();
    await db.insert(schema.bookingReferences).values({
      bookingId: b.id,
      calendarId: calendar!.id,
      provider: "google",
      externalEventId: external,
    });
    await db.insert(schema.busyBlocks).values({
      calendarId: calendar!.id,
      externalEventId: external,
      startsAt: at("10:00"),
      endsAt: at("10:30"),
    });
    await db.insert(schema.timeBlocks).values({
      userId: e.ownerId!,
      bookingId: b.id,
      title: "Owned buffer",
      kind: "buffer",
      startsAt: at("10:00"),
      endsAt: at("10:30"),
    });
    const slots = await hostSlots(
      e.ownerId!,
      e.scheduleId,
      eventConstraints(e),
      at("09:00"),
      at("11:00"),
      0,
      b.id,
    );
    expect(slots.some((s) => s.start.getTime() === at("10:00").getTime())).toBe(true);
    await db.insert(schema.busyBlocks).values({
      calendarId: calendar!.id,
      externalEventId: randomUUID(),
      startsAt: at("10:00"),
      endsAt: at("10:30"),
    });
    const blocked = await hostSlots(
      e.ownerId!,
      e.scheduleId,
      eventConstraints(e),
      at("09:00"),
      at("11:00"),
      0,
      b.id,
    );
    expect(blocked.some((s) => s.start.getTime() === at("10:00").getTime())).toBe(false);
  });
  it("monthly/yearly and pending caps are rechecked before accepting a move", async () => {
    let e = await service([{ id: await resource(2) }]);
    const b = await book(e);
    const blocker = await book(e, at("12:00"), at("12:30"));
    await db
      .update(schema.bookings)
      .set({ status: "pending" })
      .where(eq(schema.bookings.id, blocker.id));
    for (const cap of [
      { monthlyBookingLimit: 1 },
      { yearlyBookingLimit: 1 },
      { dailyBookingLimit: 1 },
      { weeklyBookingLimit: 1 },
    ]) {
      await db
        .update(schema.eventTypes)
        .set({
          monthlyBookingLimit: null,
          yearlyBookingLimit: null,
          dailyBookingLimit: null,
          weeklyBookingLimit: null,
          ...cap,
        })
        .where(eq(schema.eventTypes.id, e.id));
      e = (await db.query.eventTypes.findFirst({ where: eq(schema.eventTypes.id, e.id) }))!;
      await expect(move(b, e)).rejects.toMatchObject({ status: 409 });
      expect(await reload(b.id)).toEqual(b);
    }
  });
  it("whole-transaction serialization retry restores old claims before trying again", async () => {
    const e = await service([{ id: await resource() }]);
    const b = await book(e);
    let runs = 0;
    const retryDb = new Proxy(db, {
      get(target, key) {
        if (key !== "transaction") return Reflect.get(target, key);
        return (operation: Parameters<typeof db.transaction>[0]) =>
          db.transaction(async (tx) => {
            const result = await operation(tx);
            runs++;
            if (runs === 1)
              await tx.execute(
                sql`DO $$ BEGIN RAISE EXCEPTION 'test serialization failure' USING ERRCODE='40001'; END $$`,
              );
            return result;
          });
      },
    });
    await admitBookingReschedule(retryDb, b, e, at("11:00"), at("11:30"));
    expect(runs).toBe(2);
    expect((await reload(b.id))!.allocationRevision).toBe(2);
    expect(await claims(b.id)).toHaveLength(2);
  });
  it("minimum person gap is frozen for managed moves and rechecked under the person mutex", async () => {
    let e = await service([{ id: await resource(2) }]);
    await db
      .update(schema.eventTypes)
      .set({ minimumGapMinutes: 15 })
      .where(eq(schema.eventTypes.id, e.id));
    e = (await db.query.eventTypes.findFirst({ where: eq(schema.eventTypes.id, e.id) }))!;
    const b = await book(e);
    await book(e, at("11:30"), at("12:00"));
    await db
      .update(schema.eventTypes)
      .set({ minimumGapMinutes: 0 })
      .where(eq(schema.eventTypes.id, e.id));
    e = (await db.query.eventTypes.findFirst({ where: eq(schema.eventTypes.id, e.id) }))!;
    await expect(move(b, e)).rejects.toMatchObject({ status: 409 });
    expect(await reload(b.id)).toEqual(b);
    await move(b, e, "10:45", "11:15");
    expect((await reload(b.id))!.startsAt).toEqual(at("10:45"));
  });
  const request = (body: unknown) =>
    new Request("https://example.test/lifecycle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  it("customer capability route and staff decline route use durable resource lifecycle", async () => {
    const e = await service([{ id: await resource() }]);
    const b = await book(e);
    const ctx = { params: Promise.resolve({ uid: b.uid }) };
    expect((await rescheduleRoute(request({ start: at("11:00").toISOString() }), ctx)).status).toBe(
      200,
    );
    expect((await claims(b.id)).filter((c) => !c.releasedAt)[0]!.startsAt).toEqual(at("11:00"));
    expect((await cancelRoute(request({}), ctx)).status).toBe(200);
    expect((await claims(b.id)).every((c) => c.releasedAt)).toBe(true);
    expect((await cancelRoute(request({}), ctx)).status).toBe(200);
    expect(await claims(b.id)).toHaveLength(2);
    const pending = await book(e);
    await db
      .update(schema.bookings)
      .set({ status: "pending" })
      .where(eq(schema.bookings.id, pending.id));
    mock.hostId = e.ownerId!;
    expect(
      (
        await declineRoute(request({ reason: "Unavailable" }), {
          params: Promise.resolve({ uid: pending.uid }),
        })
      ).status,
    ).toBe(200);
    expect((await claims(pending.id))[0]!.releaseReason).toBe("rejected");
  });
  it("host no-show retains finite claims and cannot revive a cancelled booking", async () => {
    const e = await service([{ id: await resource() }]);
    const b = await book(e);
    mock.hostId = e.ownerId!;
    const ctx = { params: Promise.resolve({ uid: b.uid }) };
    expect((await noShowRoute(request({ noShow: true }), ctx)).status).toBe(200);
    expect((await claims(b.id))[0]!.releasedAt).toBeNull();
    expect((await noShowRoute(request({ noShow: false }), ctx)).status).toBe(200);
    await decideBookingCancellation(b.uid, undefined, db);
    expect((await noShowRoute(request({ noShow: false }), ctx)).status).toBe(409);
    expect((await reload(b.id))!.status).toBe("cancelled");
    expect((await claims(b.id))[0]!.releasedAt).not.toBeNull();
  });
  it("move prediction uses frozen quantities and excludes only its own old commitment", async () => {
    const r = await resource(2);
    const e = await service([{ id: r, quantity: 2 }]);
    const b = await book(e);
    expect(await acceptedBookingResourceAvailable(b, at("10:15"), at("10:45"), db)).toBe(true);
    const other = await service([{ id: r }]);
    await book(other, at("11:00"), at("11:30"));
    await db.execute(
      sql`select resource_set_requirements(${e.id}::uuid,${JSON.stringify([{ id: r, quantity: 1 }])}::jsonb)`,
    );
    expect(await acceptedBookingResourceAvailable(b, at("11:00"), at("11:30"), db)).toBe(false);
    expect(await acceptedBookingResourceAvailable(b, at("11:30"), at("12:00"), db)).toBe(true);
  });
  it("concurrent service edit wins admission lock and rejects stale move terms safely", async () => {
    const r = await resource();
    const e = await service([{ id: r }]);
    const b = await book(e);
    const before = await claims(b.id);
    const connection = await db.$client.connect();
    try {
      await connection.query("BEGIN");
      await connection.query("SELECT id FROM event_types WHERE id=$1 FOR UPDATE", [e.id]);
      const moving = move(b, e);
      const observed = moving.then(
        () => ({ ok: true }),
        (error) => ({ ok: false, error }),
      );
      let waiting = false;
      for (let poll = 0; poll < 100; poll++) {
        const result = await db.$client.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%event_types%'",
        );
        if (result.rows[0].n > 0) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await connection.query("UPDATE event_types SET title='Changed during move' WHERE id=$1", [
        e.id,
      ]);
      await connection.query("COMMIT");
      expect(waiting).toBe(true);
      expect(await observed).toMatchObject({ ok: false, error: { status: 409 } });
      expect(await reload(b.id)).toEqual(b);
      expect(await claims(b.id)).toEqual(before);
    } finally {
      await connection.query("ROLLBACK");
      connection.release();
    }
  });
  it("unsupported paid pending decline explicitly fails closed through the staff route", async () => {
    const e = await service([{ id: await resource() }]);
    const b = await book(e);
    mock.hostId = e.ownerId!;
    await db
      .update(schema.bookings)
      .set({ status: "pending", paymentStatus: "paid" })
      .where(eq(schema.bookings.id, b.id));
    const response = await declineRoute(request({}), { params: Promise.resolve({ uid: b.uid }) });
    expect(response.status).toBe(409);
    expect((await reload(b.id))!.status).toBe("pending");
    expect((await claims(b.id))[0]!.releasedAt).toBeNull();
  });
});
