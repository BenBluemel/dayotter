import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createDatabase, eq, schema } from "@dayotter/db";
import type { ResourceOpeningHours } from "@dayotter/db/schema";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { inboxData } from "../calendar/inbox";
import { decideBookingCancellation } from "../payments/refunds";
import { getEventTypeAvailability } from "./availability";
import { approveBooking, declineBooking } from "./confirm-booking";
import { createBooking } from "./create-booking";
import { createHostBooking } from "./host-booking";
import { admitBookingReschedule } from "./reschedule-admission";
import { rescheduleBooking } from "./reschedule-booking";
import { filterResourceAvailability } from "./resource-availability";
import { teamSchedule } from "./team-schedule";
const mock = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof createDatabase>,
  calendar: vi.fn(async () => undefined),
  hostId: "",
  writeCalendar: vi.fn(async () => null),
  email: vi.fn(),
  overflow: vi.fn(),
}));
vi.mock("@dayotter/db", async (original) => ({
  ...(await original<typeof import("@dayotter/db")>()),
  getDb: () => mock.db,
}));
vi.mock("../server/env", () => ({ env: { APP_URL: "https://example.test" } }));
vi.mock("../calendar/host-calendar", () => ({
  writeBookingToCalendar: mock.writeCalendar,
  updateBookingCalendarEvent: mock.calendar,
  deleteBookingFromCalendar: vi.fn(),
}));
vi.mock("./reminders", () => ({
  scheduleBookingReminders: vi.fn(),
  clearBookingReminders: vi.fn(),
  scheduleWorkflowMessages: vi.fn(),
  reminderOffsetsForHost: async () => [],
  hostWantsOverflowNotice: async () => false,
  hostWantsScribe: async () => false,
  hostBookingPrefs: async () => ({ wantsOverflow: true, wantsScribe: false, reminderOffsets: [] }),
  scheduleBookingFollowUp: vi.fn(),
  scheduleOverflowCheck: mock.overflow,
  scheduleScribe: vi.fn(),
}));
vi.mock("./lifecycle", () => ({ fanOutBookingLifecycle: vi.fn() }));
vi.mock("@dayotter/emails", () => ({
  bookingRescheduled: vi.fn(),
  bookingCancellation: vi.fn(),
  bookingDeclined: vi.fn(),
  bookingRequested: vi.fn(),
  newBookingRequest: vi.fn(),
  bookingConfirmation: vi.fn(() => ({ subject: "Booking", html: "Test confirmation" })),
  sendEmail: mock.email,
}));
vi.mock("@/lib/server/rate-limit", () => ({ enforceRateLimit: async () => null }));
vi.mock("@/lib/server/http", () => ({
  jsonError: (error: string, status: number) => Response.json({ error }, { status }),
  withUser:
    (handler: (user: { id: string }, request: Request, context: unknown) => Promise<Response>) =>
    (request: Request, context: unknown) =>
      handler({ id: mock.hostId }, request, context),
}));
import { POST as noShowRoute } from "../../app/api/bookings/[uid]/no-show/route";
vi.mock("@/lib/server/api-key", () => ({
  withApiKey:
    (handler: (caller: { userId: string }, request: Request, ctx: unknown) => Promise<Response>) =>
    (request: Request, ctx: unknown) =>
      handler({ userId: mock.hostId }, request, ctx),
}));
vi.mock("@/lib/ai/llm", () => ({
  aiEnabled: true,
  extract: async (input: { user: string }) => {
    const line = input.user.split("\n").find((v) => v.includes("Jan 1") && v.includes("10:00"));
    return { message: "Available", picks: line ? [Number(line.match(/#(\d+)/)![1])] : [] };
  },
}));
vi.mock("@dayotter/jobs", () => ({ rateLimit: async () => ({ ok: true }) }));
import { POST as assistant } from "../../app/api/public/booking-assistant/route";
import { GET as apiAvailability } from "../../app/api/v1/event-types/[id]/availability/route";
const url = process.env.RESOURCES_TEST_DATABASE_URL;
describe.skipIf(!url)("Slice 6 resource-only scheduling PostgreSQL", () => {
  const databaseName = `dayotter_resources_test_${randomUUID().replaceAll("-", "")}`;
  let admin: ReturnType<typeof createDatabase>;
  let db: ReturnType<typeof createDatabase>;
  let created = false;
  const org = randomUUID();
  const clientUser = randomUUID();
  const otherOrg = randomUUID();
  const at = (time: string) => new Date(`2030-01-01T${time}:00.000Z`);
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
  const publicBook = async (e: typeof schema.eventTypes.$inferSelect, from = "10:00") => {
    const result = await createBooking({
      eventTypeId: e.id,
      start: at(from).toISOString(),
      attendee: { name: "Client", email: "client@example.test", timezone: "UTC" },
      bookingRequestId: randomUUID(),
    });
    return (await db.query.bookings.findFirst({ where: eq(schema.bookings.uid, result.uid) }))!;
  };
  const reloadService = async (id: string) =>
    (await db.query.eventTypes.findFirst({ where: eq(schema.eventTypes.id, id) }))!;
  const resourceOnly = async (e: typeof schema.eventTypes.$inferSelect) => {
    await db
      .update(schema.eventTypes)
      .set({ requiresHost: false })
      .where(eq(schema.eventTypes.id, e.id));
    return reloadService(e.id);
  };
  const sibling = async (e: typeof schema.eventTypes.$inferSelect, r?: string) => {
    const [s] = await db
      .insert(schema.eventTypes)
      .values({
        organizationId: e.organizationId,
        ownerId: e.ownerId,
        scheduleId: e.scheduleId,
        title: r ? "Resource treatment" : "Energy Session",
        slug: randomUUID(),
        durationMinutes: 30,
        minimumNoticeMinutes: 0,
        bookingWindowDays: null,
        location: "in_person",
      })
      .returning();
    if (r) {
      await db.insert(schema.eventTypeResourceRequirements).values({
        organizationId: e.organizationId,
        eventTypeId: s!.id,
        resourceId: r,
        quantity: 1,
      });
      await db
        .update(schema.eventTypes)
        .set({ resourceAdmissionEpoch: 1 })
        .where(eq(schema.eventTypes.id, s!.id));
    }
    return reloadService(s!.id);
  };
  const available = async (e: typeof schema.eventTypes.$inferSelect, from = "10:00") =>
    (await getEventTypeAvailability(e.id, at(from), new Date(at(from).getTime() + 1800000)))!.some(
      (s) => s.start.getTime() === at(from).getTime(),
    );

  it("Energy + Light + PEMF coexist at 10:00; duplicate Energy, Light and PEMF are unavailable and rejected", async () => {
    const light = await resource();
    const mat = await resource();
    const energy = await service();
    const lightService = await resourceOnly(await sibling(energy, light));
    const pemf = await resourceOnly(await sibling(energy, mat));
    expect(energy.requiresHost).toBe(true);
    const energyBooking = await publicBook(energy);
    expect(await available(lightService)).toBe(true);
    expect(await available(pemf)).toBe(true);
    const lightBooking = await publicBook(lightService);
    const pemfBooking = await publicBook(pemf);
    expect([energyBooking, lightBooking, pemfBooking].map((b) => b.hostId)).toEqual([
      energy.ownerId,
      energy.ownerId,
      energy.ownerId,
    ]);
    expect([energyBooking, lightBooking, pemfBooking].map((b) => b.requiresHost)).toEqual([
      true,
      false,
      false,
    ]);
    expect(lightBooking.schedulingPlan).toMatchObject({
      requiresHost: false,
      requiredHostIds: [],
      scheduleOwnerId: energy.ownerId,
    });
    expect((await claims(lightBooking.id))[0]!.resourceId).toBe(light);
    expect((await claims(pemfBooking.id))[0]!.resourceId).toBe(mat);
    for (const e of [energy, lightService, pemf]) {
      expect(await available(e)).toBe(false);
      await expect(publicBook(e)).rejects.toMatchObject({ status: 409 });
    }
    // Staff skips advisory public slots, so these hit final database admission.
    await expect(book(energy)).rejects.toMatchObject({ status: 409 });
    await expect(book(lightService)).rejects.toMatchObject({ status: 409 });
    await expect(book(pemf)).rejects.toMatchObject({ status: 409 });
  });
  it("resource-only occupancy leaves an attended service free even with a cached calendar mirror", async () => {
    const e = await resourceOnly(await service([{ id: await resource() }]));
    const b = await publicBook(e);
    const energy = await sibling(e);
    const [conn] = await db
      .insert(schema.calendarConnections)
      .values({
        userId: e.ownerId!,
        provider: "google",
        externalAccountId: randomUUID(),
        credentials: "test-only-unused",
      })
      .returning();
    const [cal] = await db
      .insert(schema.calendars)
      .values({
        connectionId: conn!.id,
        externalId: randomUUID(),
        name: "Awareness",
        checkForConflicts: true,
      })
      .returning();
    const external = randomUUID();
    await db.insert(schema.bookingReferences).values({
      bookingId: b.id,
      calendarId: cal!.id,
      provider: "google",
      externalEventId: external,
    });
    await db.insert(schema.busyBlocks).values({
      calendarId: cal!.id,
      externalEventId: external,
      startsAt: at("10:00"),
      endsAt: at("10:30"),
    });
    expect(await available(energy)).toBe(true);
    await publicBook(energy);
    expect(
      (
        await teamSchedule(
          [{ userId: e.ownerId!, name: "Owner", email: "owner@example.test" }],
          at("10:00"),
          at("10:30"),
        )
      )[0]!.intervals,
    ).toHaveLength(1);
  });
  it("external busy, personal blocks, lunch, out-of-office and focus caps do not reserve a resource-only owner", async () => {
    const e = await resourceOnly(await service([{ id: await resource() }]));
    const energy = await sibling(e);
    const [conn] = await db
      .insert(schema.calendarConnections)
      .values({
        userId: e.ownerId!,
        provider: "google",
        externalAccountId: randomUUID(),
        credentials: "unused",
      })
      .returning();
    const [cal] = await db
      .insert(schema.calendars)
      .values({
        connectionId: conn!.id,
        externalId: randomUUID(),
        name: "Busy",
        checkForConflicts: true,
      })
      .returning();
    await db.insert(schema.busyBlocks).values({
      calendarId: cal!.id,
      externalEventId: randomUUID(),
      startsAt: at("09:00"),
      endsAt: at("12:00"),
    });
    await db.insert(schema.timeBlocks).values({
      userId: e.ownerId!,
      title: "Personal",
      kind: "focus",
      startsAt: at("09:00"),
      endsAt: at("12:00"),
    });
    await db.insert(schema.userPreferences).values({
      userId: e.ownerId!,
      adaptiveAvailability: true,
      maxMeetingsPerDay: 0,
      lunchEnabled: true,
      lunchStartMinute: 540,
      lunchEndMinute: 720,
    });
    await db.insert(schema.outOfOfficePeriods).values({
      userId: e.ownerId!,
      startDate: "2030-01-01",
      endDate: "2030-01-01",
      reason: "Away",
    });
    expect(await available(energy)).toBe(false);
    expect(await available(e)).toBe(true);
    expect((await publicBook(e)).requiresHost).toBe(false);
    await db.insert(schema.calendarEvents).values({
      calendarId: cal!.id,
      externalEventId: randomUUID(),
      title: "Personal meeting",
      startsAt: at("10:00"),
      endsAt: at("10:30"),
      transparency: "opaque",
    });
    expect((await inboxData(e.ownerId!)).conflicts).toEqual([]);
  });
  it("resource-only still enforces service hours, date overrides, notice and booking window", async () => {
    const e = await resourceOnly(await service([{ id: await resource() }]));
    expect(await available(e, "07:00")).toBe(false);
    await db
      .insert(schema.dateOverrides)
      .values({ scheduleId: e.scheduleId!, date: "2030-01-01", startTime: null, endTime: null });
    expect(await available(e)).toBe(false);
    await db.delete(schema.dateOverrides).where(eq(schema.dateOverrides.scheduleId, e.scheduleId!));
    await db
      .update(schema.eventTypes)
      .set({ bookingWindowDays: 1 })
      .where(eq(schema.eventTypes.id, e.id));
    expect(await available(e)).toBe(false);
    await db
      .update(schema.eventTypes)
      .set({ bookingWindowDays: null, minimumNoticeMinutes: 10000000 })
      .where(eq(schema.eventTypes.id, e.id));
    expect(await available(e)).toBe(false);
    await expect(publicBook(e)).rejects.toMatchObject({ status: 409 });
  });
  it("resource opening hours, service buffers and weighted equipment claims remain enforced", async () => {
    const r = await resource(1, hours("10:00", "11:00"));
    let e = await resourceOnly(await service([{ id: r }]));
    await db
      .update(schema.eventTypes)
      .set({ bufferBeforeMinutes: 15, bufferAfterMinutes: 15, slotIntervalMinutes: 15 })
      .where(eq(schema.eventTypes.id, e.id));
    e = await reloadService(e.id);
    expect(await available(e)).toBe(false);
    expect(await available(e, "10:15")).toBe(true);
    const b = await publicBook(e, "10:15");
    expect((await claims(b.id))[0]).toMatchObject({ startsAt: at("10:00"), endsAt: at("11:00") });
    const observer = await resourceOnly(await service([{ id: r }]));
    expect(await available(observer, "10:45")).toBe(false);
    await expect(book(observer, at("10:45"), at("11:15"))).rejects.toMatchObject({ status: 409 });
  });
  it("one capacity-1 winner is admitted after stale availability under concurrent same-owner requests", async () => {
    const e = await resourceOnly(await service([{ id: await resource() }]));
    expect(await available(e)).toBe(true);
    const results = await Promise.allSettled([publicBook(e), publicBook(e)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(
      await db.query.bookings.findMany({ where: eq(schema.bookings.eventTypeId, e.id) }),
    ).toHaveLength(1);
    expect(
      await db.query.bookingResourceClaims.findMany({
        where: eq(schema.bookingResourceClaims.eventTypeId, e.id),
      }),
    ).toHaveLength(1);
  });
  it("resource-only acceptance and approval never wait on the person's admission mutex", async () => {
    const e = await resourceOnly(await service([{ id: await resource() }]));
    await db
      .update(schema.eventTypes)
      .set({ requiresConfirmation: true })
      .where(eq(schema.eventTypes.id, e.id));
    const connection = await db.$client.connect();
    try {
      await connection.query("BEGIN");
      await connection.query("select pg_advisory_xact_lock(hashtext($1))", [
        `booking-person:${e.ownerId}`,
      ]);
      const bounded = async <T>(work: Promise<T>) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            work,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("Resource-only admission waited on person capacity")),
                4000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      const b = await bounded(publicBook(e));
      expect(b.status).toBe("pending");
      expect(await bounded(approveBooking(b.uid, e.ownerId!))).toBe("ok");
      expect((await reload(b.id))!.requiresHost).toBe(false);
    } finally {
      await connection.query("ROLLBACK");
      connection.release();
    }
  }, 10000);
  it("staged attendance does not bypass activation; unconstrained definitions and forged attendance fail closed", async () => {
    const r = await resource();
    const e = await service();
    await expect(
      db
        .update(schema.eventTypes)
        .set({ requiresHost: false })
        .where(eq(schema.eventTypes.id, e.id)),
    ).rejects.toBeDefined();
    await db
      .insert(schema.eventTypeResourceRequirements)
      .values({ organizationId: org, eventTypeId: e.id, resourceId: r, quantity: 1 });
    await resourceOnly(await reloadService(e.id));
    expect(await available(e)).toBe(false);
    await expect(publicBook(e)).rejects.toMatchObject({ status: 409 });
    await expect(book(e)).rejects.toMatchObject({ status: 409 });
    await expect(
      db.insert(schema.bookings).values({
        organizationId: org,
        eventTypeId: e.id,
        hostId: e.ownerId!,
        title: "Forged",
        uid: randomUUID(),
        startsAt: at("10:00"),
        endsAt: at("10:30"),
        timezone: "UTC",
        requiresHost: false,
      }),
    ).rejects.toBeDefined();
  });
  it("reschedule ignores owner conflict, preserves accepted policy after edits and rolls back resource failure", async () => {
    const r = await resource();
    const e = await resourceOnly(await service([{ id: r }]));
    const b = await publicBook(e);
    const energy = await sibling(e);
    await publicBook(energy, "11:00");
    await db
      .update(schema.eventTypes)
      .set({ requiresHost: true })
      .where(eq(schema.eventTypes.id, e.id));
    await rescheduleBooking(b.uid, at("11:00").toISOString());
    const moved = (await reload(b.id))!;
    expect(moved.requiresHost).toBe(false);
    expect(moved.schedulingPlan).toEqual(b.schedulingPlan);
    const blocker = await resourceOnly(await service([{ id: r }]));
    await publicBook(blocker, "12:00");
    const before = await claims(b.id);
    await expect(rescheduleBooking(b.uid, at("12:00").toISOString())).rejects.toMatchObject({
      status: 409,
    });
    expect(await reload(b.id)).toEqual(moved);
    expect(await claims(b.id)).toEqual(before);
    await expect(move(moved, await reloadService(e.id), "12:00", "12:30")).rejects.toBeDefined();
    expect(await reload(b.id)).toEqual(moved);
    expect(await claims(b.id)).toEqual(before);
  });
  it("an attended accepted booking keeps its person commitment after the service becomes resource-only", async () => {
    const e = await service([{ id: await resource(2) }]);
    const b = await publicBook(e);
    await resourceOnly(e);
    const energy = await sibling(e);
    await publicBook(energy, "11:00");
    expect(await available(energy)).toBe(false);
    await expect(rescheduleBooking(b.uid, at("11:00").toISOString())).rejects.toMatchObject({
      status: 409,
    });
    expect((await reload(b.id))!.requiresHost).toBe(true);
    expect((await reload(b.id))!.schedulingPlan).toEqual(b.schedulingPlan);
  });
  it("pending resource-only approval retains claims and decline releases them once", async () => {
    const e = await resourceOnly(await service([{ id: await resource() }]));
    await db
      .update(schema.eventTypes)
      .set({ requiresConfirmation: true })
      .where(eq(schema.eventTypes.id, e.id));
    const b = await publicBook(e);
    const energy = await sibling(e);
    await publicBook(energy);
    await db
      .update(schema.eventTypes)
      .set({ requiresHost: true })
      .where(eq(schema.eventTypes.id, e.id));
    expect(await approveBooking(b.uid, e.ownerId!)).toBe("ok");
    expect((await reload(b.id))!.requiresHost).toBe(false);
    expect((await claims(b.id))[0]!.releasedAt).toBeNull();
    await decideBookingCancellation(b.uid, undefined, db);
    expect((await claims(b.id))[0]!.releasedAt).not.toBeNull();
    await resourceOnly(await reloadService(e.id));
    const pending = await publicBook(e);
    expect(await declineBooking(pending.uid, e.ownerId!)).toBe("ok");
    expect(await declineBooking(pending.uid, e.ownerId!)).toBe("not_pending");
    expect((await claims(pending.id))[0]!.releaseReason).toBe("rejected");
  });
  it("no-show retains resource capacity and cancellation releases history idempotently", async () => {
    const e = await resourceOnly(await service([{ id: await resource() }]));
    const b = await publicBook(e);
    mock.hostId = e.ownerId!;
    const ctx = { params: Promise.resolve({ uid: b.uid }) };
    expect(
      (
        await noShowRoute(
          new Request("https://example.test", {
            method: "POST",
            body: JSON.stringify({ noShow: true }),
          }),
          ctx,
        )
      ).status,
    ).toBe(200);
    expect((await claims(b.id))[0]!.releasedAt).toBeNull();
    expect(await available(e)).toBe(false);
    await Promise.all([
      decideBookingCancellation(b.uid, undefined, db),
      decideBookingCancellation(b.uid, undefined, db),
    ]);
    expect(await claims(b.id)).toHaveLength(1);
    expect((await claims(b.id))[0]!.releasedAt).not.toBeNull();
    expect(await available(e)).toBe(true);
  });
  it("owner notifications and free calendar visibility remain without prep or travel reservations", async () => {
    const e = await resourceOnly(await service([{ id: await resource() }]));
    await db.insert(schema.userPreferences).values({ userId: e.ownerId!, travelBufferMinutes: 20 });
    await db
      .insert(schema.automationRules)
      .values({ userId: e.ownerId!, name: "Prep", action: "prep_block", offsetMinutes: 15 });
    const b = await publicBook(e);
    expect(mock.writeCalendar).toHaveBeenCalledWith(
      e.ownerId,
      expect.objectContaining({ transparency: "transparent" }),
    );
    const owner = (await db.query.users.findFirst({ where: eq(schema.users.id, e.ownerId!) }))!;
    expect(mock.email).toHaveBeenCalledWith(expect.objectContaining({ to: owner.email }));
    expect(
      await db.query.timeBlocks.findMany({ where: eq(schema.timeBlocks.bookingId, b.id) }),
    ).toEqual([]);
    expect(mock.overflow.mock.calls.some(([id]) => id === b.id)).toBe(false);
    await rescheduleBooking(b.uid, at("11:00").toISOString());
    expect(mock.calendar).toHaveBeenCalledWith(
      b.id,
      expect.objectContaining({ transparency: "transparent" }),
    );
    expect(
      await db.query.timeBlocks.findMany({ where: eq(schema.timeBlocks.bookingId, b.id) }),
    ).toEqual([]);
  });
  it("service caps still count resource-only bookings and hold their own service period lock", async () => {
    const e = await resourceOnly(await service([{ id: await resource(3) }]));
    await db
      .update(schema.eventTypes)
      .set({ dailyBookingLimit: 1 })
      .where(eq(schema.eventTypes.id, e.id));
    await publicBook(e);
    await expect(publicBook(e, "11:00")).rejects.toMatchObject({ status: 409 });
  });
  it("cross-organization equipment requirements cannot be used to exempt a provider", async () => {
    const e = await service();
    const foreign = await resource(1, null, otherOrg);
    await expect(
      db.transaction(async (tx) => {
        await tx
          .insert(schema.eventTypeResourceRequirements)
          .values({ organizationId: org, eventTypeId: e.id, resourceId: foreign, quantity: 1 });
        await tx
          .update(schema.eventTypes)
          .set({ requiresHost: false })
          .where(eq(schema.eventTypes.id, e.id));
      }),
    ).rejects.toBeDefined();
    expect((await reloadService(e.id)).requiresHost).toBe(true);
  });
  it("API-key availability and booking assistant derive attendance from the service and ignore caller flags", async () => {
    const energy = await service();
    await publicBook(energy);
    const e = await resourceOnly(await sibling(energy, await resource()));
    mock.hostId = e.ownerId!;
    const ctx = { params: Promise.resolve({ id: e.id }) };
    const response = await apiAvailability(
      new Request(
        `https://example.test/api/v1/event-types/${e.id}/availability?from=${at("10:00").toISOString()}&to=${at("10:30").toISOString()}&requiresHost=true`,
      ),
      ctx,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).slots).toEqual([
      { start: at("10:00").toISOString(), end: at("10:30").toISOString() },
    ]);
    const attended = await apiAvailability(
      new Request(
        `https://example.test/api/v1/event-types/${energy.id}/availability?from=${at("10:00").toISOString()}&to=${at("10:30").toISOString()}&requiresHost=false`,
      ),
      { params: Promise.resolve({ id: energy.id }) },
    );
    expect((await attended.json()).slots).toEqual([]);
    mock.hostId = clientUser;
    expect(
      (
        await apiAvailability(
          new Request(
            `https://example.test?from=${at("10:00").toISOString()}&to=${at("10:30").toISOString()}`,
          ),
          ctx,
        )
      ).status,
    ).toBe(404);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at("09:00"));
    try {
      const result = await assistant(
        new Request("https://example.test/api/public/booking-assistant", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            eventTypeId: e.id,
            query: "Soonest",
            tz: "UTC",
            requiresHost: true,
          }),
        }),
      );
      expect(result.status).toBe(200);
      // The mocked model chooses only an existing returned slot, including 10:00 occupied by the owner.
      expect((await result.json()).slots).toEqual([
        { start: at("10:00").toISOString(), end: at("10:30").toISOString() },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
  it("restoring attendance while removing resources rejects stale resource-only candidates", async () => {
    const e = await resourceOnly(await service([{ id: await resource() }]));
    const candidates = [{ start: at("10:00"), end: at("10:30") }];
    expect(await filterResourceAvailability(e, candidates, db)).toEqual(candidates);
    await db.transaction(async (tx) => {
      await tx.select().from(schema.eventTypes).where(eq(schema.eventTypes.id, e.id)).for("update");
      await tx
        .update(schema.eventTypes)
        .set({ requiresHost: true })
        .where(eq(schema.eventTypes.id, e.id));
      await tx
        .delete(schema.eventTypeResourceRequirements)
        .where(eq(schema.eventTypeResourceRequirements.eventTypeId, e.id));
    });
    expect(await filterResourceAvailability(e, candidates, db)).toEqual([]);
  });
});
