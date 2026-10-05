import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { type Slot, computeAvailability } from "@dayotter/core";
import { classifyResourceError, createDatabase, eq, schema, sql } from "@dayotter/db";
import type { ResourceOpeningHours } from "@dayotter/db/schema";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eventConstraints, getEventTypeAvailability, troubleshootHostDay } from "./availability";
import { ResourceInvariantError } from "./booking-logic";
import { createHostBooking } from "./host-booking";
import { filterResourceAvailability } from "./resource-availability";

const mock = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createDatabase> }));
vi.mock("@dayotter/db", async (original) => ({
  ...(await original<typeof import("@dayotter/db")>()),
  getDb: () => mock.db,
}));
vi.mock("../server/env", () => ({ env: { APP_URL: "https://example.test" } }));
vi.mock("../calendar/host-calendar", () => ({ writeBookingToCalendar: async () => null }));
vi.mock("./reminders", () => ({
  scheduleBookingReminders: vi.fn(),
  reminderOffsetsForHost: async () => [],
  hostWantsOverflowNotice: async () => false,
  hostWantsScribe: async () => false,
  scheduleOverflowCheck: vi.fn(),
  scheduleScribe: vi.fn(),
}));

const url = process.env.RESOURCES_TEST_DATABASE_URL;
describe.skipIf(!url)("Resource availability PostgreSQL", () => {
  const databaseName = `dayotter_resources_test_${randomUUID().replaceAll("-", "")}`;
  let admin: ReturnType<typeof createDatabase>;
  let db: ReturnType<typeof createDatabase>;
  let created = false;
  const org = randomUUID();
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
  const offered = (e: typeof schema.eventTypes.$inferSelect, slots = [slot()]) =>
    filterResourceAvailability(e, slots, db);
  async function occupied(id: string, quantity = 1, start = at("10:00"), end = at("10:30")) {
    return book(await service([{ id, quantity }]), start, end);
  }
  it("no resource requirements preserve the actual person availability path", async () => {
    const e = await service();
    const expected = computeAvailability({
      schedule: {
        timezone: "UTC",
        rules: Array.from({ length: 7 }, (_, dayOfWeek) => ({
          dayOfWeek,
          startTime: "08:00",
          endTime: "18:00",
        })),
        overrides: [],
      },
      busy: [],
      event: eventConstraints(e),
      rangeStart: at("09:00"),
      rangeEnd: at("12:00"),
      now: new Date(),
    });
    expect(await getEventTypeAvailability(e.id, at("09:00"), at("12:00"))).toEqual(expected);
    expect(await offered(e)).toEqual([slot()]);
  });
  it("capacity 1 removes overlapping slots through the shared availability path", async () => {
    const r = await resource();
    await occupied(r);
    const e = await service([{ id: r }]);
    expect(await getEventTypeAvailability(e.id, at("10:00"), at("11:00"))).toEqual([
      slot("10:30", "11:00"),
    ]);
  });
  it("an unrelated Light claim leaves PEMF availability unchanged", async () => {
    await occupied(await resource());
    const e = await service([{ id: await resource() }]);
    expect(await offered(e)).toEqual([slot()]);
  });
  it("capacity 2 with one unit claimed still admits quantity 1", async () => {
    const r = await resource(2);
    await occupied(r);
    expect(await offered(await service([{ id: r }]))).toEqual([slot()]);
  });
  it("capacity 2 fully claimed excludes a candidate", async () => {
    const r = await resource(2);
    await occupied(r);
    await occupied(r);
    expect(await offered(await service([{ id: r }]))).toEqual([]);
  });
  it("quantity 2 cannot use the single remaining unit", async () => {
    const r = await resource(2);
    await occupied(r);
    expect(await offered(await service([{ id: r, quantity: 2 }]))).toEqual([]);
  });
  it.each([0, 1])(
    "conflict in required resource %s excludes a multi-resource service",
    async (i) => {
      const rs = [await resource(), await resource()];
      await occupied(rs[i]!);
      expect(await offered(await service(rs.map((id) => ({ id }))))).toEqual([]);
    },
  );
  it("adjacent half-open claims are neither added together nor candidate conflicts", async () => {
    const r = await resource(2);
    await occupied(r, 1, at("09:30"), at("10:00"));
    await occupied(r, 1, at("10:00"), at("10:30"));
    const e = await service([{ id: r }]);
    expect(await offered(e, [slot("09:45", "10:15")])).toHaveLength(1);
    expect(
      await offered(await service([{ id: r, quantity: 2 }]), [slot("10:30", "11:00")]),
    ).toHaveLength(1);
  });
  it("peak demand respects staggered overlaps rather than summing an entire window", async () => {
    const r = await resource(3);
    await occupied(r, 1, at("09:00"), at("10:10"));
    await occupied(r, 1, at("09:30"), at("10:20"));
    await occupied(r, 1, at("10:10"), at("11:00"));
    expect(await offered(await service([{ id: r }]))).toHaveLength(1); // peak is 2
    expect(await offered(await service([{ id: r, quantity: 2 }]))).toEqual([]);
  });
  it("accepted claim buffers and candidate buffers each apply exactly once across range edges", async () => {
    const r = await resource();
    const busy = await service([{ id: r }]);
    await db
      .update(schema.eventTypes)
      .set({ bufferAfterMinutes: 10 })
      .where(eq(schema.eventTypes.id, busy.id));
    await book(busy, at("09:00"), at("10:00"));
    let e = await service([{ id: r }]);
    await db
      .update(schema.eventTypes)
      .set({ bufferBeforeMinutes: 10 })
      .where(eq(schema.eventTypes.id, e.id));
    e = (await db.query.eventTypes.findFirst({ where: eq(schema.eventTypes.id, e.id) }))!;
    expect(await offered(e, [slot("10:15", "10:45"), slot("10:20", "10:50")])).toEqual([
      slot("10:20", "10:50"),
    ]);
  });
  it("explicit opening hours cover the complete buffered interval and permit valid acceptance", async () => {
    const r = await resource(1, hours());
    const e = await service([{ id: r }]);
    expect(await offered(e, [slot("09:30", "10:00"), slot(), slot("10:45", "11:15")])).toEqual([
      slot(),
    ]);
    await expect(book(e)).resolves.toMatchObject({ status: "confirmed" });
    await expect(book(e, at("11:00"), at("11:30"))).rejects.toMatchObject({ status: 409 });
  });
  it("opening-hour boundaries include setup and cleanup buffers", async () => {
    const e = await service([{ id: await resource(1, hours()) }]);
    await db
      .update(schema.eventTypes)
      .set({ bufferBeforeMinutes: 10, bufferAfterMinutes: 10 })
      .where(eq(schema.eventTypes.id, e.id));
    const updated = (await db.query.eventTypes.findFirst({
      where: eq(schema.eventTypes.id, e.id),
    }))!;
    expect(
      await offered(updated, [slot(), slot("10:10", "10:40"), slot("10:30", "11:00")]),
    ).toEqual([slot("10:10", "10:40")]);
    await expect(book(updated)).rejects.toMatchObject({ status: 409 });
  });
  it("adjacent opening windows merge, but gaps do not", async () => {
    const opening = hours();
    opening.rules = [
      { dayOfWeek: 2, startTime: "10:00", endTime: "10:15" },
      { dayOfWeek: 2, startTime: "10:15", endTime: "10:30" },
    ];
    const r = await resource(1, opening);
    const e = await service([{ id: r }]);
    expect(await offered(e)).toHaveLength(1);
    opening.rules[1]!.startTime = "10:16";
    await db
      .update(schema.resources)
      .set({ openingHours: opening })
      .where(eq(schema.resources.id, r));
    expect(await offered(e)).toEqual([]);
  });
  it("date overrides replace weekly hours and explicit empty hours close the resource", async () => {
    const opening = hours();
    opening.overrides = [{ date: "2030-01-01", startTime: null, endTime: null }];
    const r = await resource(1, opening);
    const e = await service([{ id: r }]);
    expect(await offered(e)).toEqual([]);
    opening.overrides = [{ date: "2030-01-01", startTime: "10:00", endTime: "10:30" }];
    await db
      .update(schema.resources)
      .set({ openingHours: opening })
      .where(eq(schema.resources.id, r));
    expect(await offered(e)).toHaveLength(1);
    await db
      .update(schema.resources)
      .set({ openingHours: { timezone: "UTC", rules: [], overrides: [] } })
      .where(eq(schema.resources.id, r));
    expect(await offered(e)).toEqual([]);
  });
  it.each([
    ["2030-03-09T14:00:00Z", "2030-03-10T13:00:00Z"],
    ["2030-11-02T13:00:00Z", "2030-11-03T14:00:00Z"],
  ])("local opening hours follow DST across %s", async (before, after) => {
    const e = await service([
      { id: await resource(1, hours("09:00", "10:00", "America/New_York")) },
    ]);
    const candidates = [before, after].map((s) => ({
      start: new Date(s),
      end: new Date(new Date(s).getTime() + 30 * 60000),
    }));
    expect(await offered(e, candidates)).toEqual(candidates);
    const wrong = candidates.map((s) => ({
      start: new Date(s.start.getTime() - 3600000),
      end: new Date(s.end.getTime() - 3600000),
    }));
    expect(await offered(e, wrong)).toEqual([]);
  });
  it("a fold uses the same PostgreSQL boundary choice for prediction and acceptance", async () => {
    const e = await service([
      { id: await resource(1, hours("01:00", "02:00", "America/New_York")) },
    ]);
    const early = {
      start: new Date("2030-11-03T05:00:00Z"),
      end: new Date("2030-11-03T05:30:00Z"),
    };
    const late = { start: new Date("2030-11-03T06:00:00Z"), end: new Date("2030-11-03T06:30:00Z") };
    expect(await offered(e, [early, late])).toEqual([late]);
    await expect(book(e, early.start, early.end)).rejects.toMatchObject({ status: 409 });
    await expect(book(e, late.start, late.end)).resolves.toBeDefined();
  });
  it("spring-forward missing boundaries use the same resolution for display and allocation", async () => {
    const e = await service([
      { id: await resource(1, hours("02:00", "04:00", "America/New_York")) },
    ]);
    const valid = {
      start: new Date("2030-03-10T07:00:00Z"),
      end: new Date("2030-03-10T07:30:00Z"),
    };
    const outside = {
      start: new Date("2030-03-10T06:30:00Z"),
      end: new Date("2030-03-10T07:00:00Z"),
    };
    expect(await offered(e, [outside, valid])).toEqual([valid]);
    await expect(book(e, outside.start, outside.end)).rejects.toMatchObject({ status: 409 });
    await expect(book(e, valid.start, valid.end)).resolves.toBeDefined();
  });
  it("disabled resources and inactive services fail closed", async () => {
    const r = await resource();
    const e = await service([{ id: r }]);
    await db.update(schema.resources).set({ enabled: false }).where(eq(schema.resources.id, r));
    expect(await offered(e)).toEqual([]);
    const activeResource = await resource();
    const inactive = await service([{ id: activeResource }]);
    await db
      .update(schema.eventTypes)
      .set({ isActive: false })
      .where(eq(schema.eventTypes.id, inactive.id));
    const updated = (await db.query.eventTypes.findFirst({
      where: eq(schema.eventTypes.id, inactive.id),
    }))!;
    expect(await offered(updated)).toEqual([]);
  });
  it("staged requirements cannot advertise supported resource acceptance before admission", async () => {
    const e = await service();
    await db.insert(schema.eventTypeResourceRequirements).values({
      organizationId: org,
      eventTypeId: e.id,
      resourceId: await resource(),
      quantity: 1,
    });
    const updated = (await db.query.eventTypes.findFirst({
      where: eq(schema.eventTypes.id, e.id),
    }))!;
    expect(await offered(updated)).toEqual([]);
  });
  it("completed/no-show unreleased claims still consume capacity; released claims do not", async () => {
    const r = await resource();
    const booking = await occupied(r);
    const e = await service([{ id: r }]);
    for (const status of ["pending", "confirmed", "completed", "no_show"] as const) {
      await db.update(schema.bookings).set({ status }).where(eq(schema.bookings.id, booking.id));
      expect(await offered(e)).toEqual([]);
    }
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT 1 FROM event_types WHERE id=${booking.eventTypeId}::uuid FOR SHARE`,
      );
      await tx
        .update(schema.bookings)
        .set({ status: "cancelled" })
        .where(eq(schema.bookings.id, booking.id));
      await tx.execute(sql`SELECT resource_release_booking(${booking.id}::uuid)`);
    });
    expect(await offered(e)).toEqual([slot()]);
  });
  it("organization isolation and scoped requirements are enforced", async () => {
    const other = await resource(1, null, otherOrg);
    await book(await service([{ id: other }], otherOrg));
    expect(await offered(await service([{ id: await resource() }]))).toEqual([slot()]);
    const e = await service();
    await expect(
      db
        .insert(schema.eventTypeResourceRequirements)
        .values({ organizationId: org, eventTypeId: e.id, resourceId: other }),
    ).rejects.toSatisfy((error: unknown) => {
      const diagnostic = classifyResourceError(error);
      return (
        diagnostic?.category === "invariant" && diagnostic.identity === "resource_scope_violation"
      );
    });
  });
  it("corrupt missing resources and impossible quantities cannot be silently omitted", async () => {
    const r = await resource();
    const e = await service([{ id: r }]);
    // Test-only corruption injection is isolated to a disposable transaction.
    const client = await db.$client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query("DELETE FROM resources WHERE id=$1", [r]);
      await client.query("COMMIT");
      await expect(offered(e)).rejects.toMatchObject({ identity: "resource_scope_violation" });
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "INSERT INTO resources(id,organization_id,name,capacity) VALUES($1,$2,'Corruption fixture',1)",
        [r, org],
      );
      await client.query(
        "UPDATE event_type_resource_requirements SET quantity=2 WHERE event_type_id=$1",
        [e.id],
      );
      await client.query("COMMIT");
      expect(await offered(e)).toEqual([]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
  it.each([
    { timezone: "Invalid/Zone", rules: [], overrides: [] },
    {
      timezone: "UTC",
      rules: [{ dayOfWeek: 9, startTime: "10:00", endTime: "11:00" }],
      overrides: [],
    },
    {
      timezone: "UTC",
      rules: [],
      overrides: [{ date: "2030-02-30", startTime: null, endTime: null }],
    },
    {
      timezone: "UTC",
      rules: [],
      overrides: [{ date: "2030-01-01", startTime: "10:00", endTime: null }],
    },
  ])("invalid opening-hours configuration fails durably closed: %j", async (opening) => {
    await expect(
      db
        .insert(schema.resources)
        .values({ organizationId: org, name: "Invalid", openingHours: opening }),
    ).rejects.toSatisfy((error: unknown) => {
      const diagnostic = classifyResourceError(error);
      return (
        diagnostic?.category === "invariant" &&
        diagnostic.identity === "resource_plan_completeness_violation"
      );
    });
  });
  it("availability may race, but competing acceptance has exactly one winner", async () => {
    const r = await resource();
    const a = await service([{ id: r }]);
    const b = await service([{ id: r }]);
    expect(await offered(a)).toHaveLength(1);
    expect(await offered(b)).toHaveLength(1);
    const results = await Promise.allSettled([book(a), book(b)]);
    expect(results.filter((v) => v.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((v) => v.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ status: 409 });
    expect(await offered(a)).toEqual([]);
    expect(await offered(b)).toEqual([]);
  });
  it("sub-millisecond claim endpoints still conflict with a millisecond-grid candidate", async () => {
    const r = await resource();
    const booking = await occupied(r);
    const e = await service([{ id: r }]);
    const client = await db.$client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "UPDATE bookings SET starts_at=starts_at+interval '1 microsecond',ends_at=ends_at+interval '1 microsecond' WHERE id=$1",
        [booking.id],
      );
      await client.query(
        "UPDATE booking_resource_claims SET starts_at=starts_at+interval '1 microsecond',ends_at=ends_at+interval '1 microsecond' WHERE booking_id=$1",
        [booking.id],
      );
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    expect(await offered(e, [slot("10:30", "11:00"), slot("10:31", "11:01")])).toEqual([
      slot("10:31", "11:01"),
    ]);
  });
  it("the host diagnostic reports slots lost to resources without exposing claims", async () => {
    const r = await resource();
    await occupied(r);
    const e = await service([{ id: r }]);
    const diagnosis = await troubleshootHostDay(
      e.ownerId!,
      e.scheduleId,
      eventConstraints(e),
      at("12:00"),
      0,
      e,
    );
    expect(diagnosis).toMatchObject({ bookableSlots: 19, blockedByResources: 1 });
    expect(diagnosis?.reasons.some((reason) => reason.includes("required resources"))).toBe(true);
  });
  it("slot count does not multiply resource queries, and the GiST index supports the overlap predicate", async () => {
    const r = await resource();
    await occupied(r);
    const e = await service([{ id: r }]);
    const client = await db.$client.connect();
    const query = vi.spyOn(client, "query");
    client.release();
    try {
      await offered(
        e,
        Array.from({ length: 1000 }, () => slot()),
      );
      expect(query).toHaveBeenCalledTimes(4); // BEGIN, context, window profile, COMMIT
      const texts = query.mock.calls.map(([config]) =>
        typeof config === "string" ? config : (config as { text: string }).text,
      );
      expect(texts[0]).toContain("read only");
      expect(texts.filter((text) => text.includes("WITH claims"))).toHaveLength(1);
    } finally {
      query.mockRestore();
    }
    const planner = await db.$client.connect();
    try {
      await planner.query("BEGIN");
      await planner.query("SET LOCAL enable_seqscan=off");
      const plan = await planner.query(
        `EXPLAIN (FORMAT JSON) SELECT quantity FROM booking_resource_claims
        WHERE organization_id=$1 AND resource_id=ANY($2::uuid[]) AND released_at IS NULL
        AND tstzrange(starts_at,ends_at,'[)') && tstzrange($3::timestamptz,$4::timestamptz,'[)')`,
        [org, [r], at("10:00"), at("11:00")],
      );
      expect(JSON.stringify(plan.rows)).toContain("resource_claim_range_idx");
    } finally {
      await planner.query("ROLLBACK");
      planner.release();
    }
  });
  it("a zero slot cadence fails closed before the availability engine can loop", async () => {
    const e = await service([{ id: await resource() }]);
    await db
      .update(schema.eventTypes)
      .set({ slotIntervalMinutes: 0 })
      .where(eq(schema.eventTypes.id, e.id));
    expect(await getEventTypeAvailability(e.id, at("10:00"), at("11:00"))).toEqual([]);
  });
  it.each(["closed", "disabled"])(
    "a resource becoming %s after display still fails authoritative acceptance",
    async (state) => {
      const r = await resource();
      const e = await service([{ id: r }]);
      expect(await offered(e)).toHaveLength(1);
      await db
        .update(schema.resources)
        .set(
          state === "disabled"
            ? { enabled: false }
            : {
                openingHours: { timezone: "UTC", rules: [], overrides: [] },
              },
        )
        .where(eq(schema.resources.id, r));
      await expect(book(e)).rejects.toMatchObject({ status: 409 });
      expect(
        await db.query.bookings.findMany({ where: eq(schema.bookings.eventTypeId, e.id) }),
      ).toEqual([]);
    },
  );
  it("a pinned schedule owned by another person fails the accepted-term proof", async () => {
    const e = await service([{ id: await resource() }]);
    const other = await service();
    await db
      .update(schema.eventTypes)
      .set({ scheduleId: other.scheduleId })
      .where(eq(schema.eventTypes.id, e.id));
    const updated = (await db.query.eventTypes.findFirst({
      where: eq(schema.eventTypes.id, e.id),
    }))!;
    await expect(offered(updated)).rejects.toMatchObject({
      identity: "resource_plan_completeness_violation",
    });
  });
  it("a definition change after person candidates were computed does not mix configurations", async () => {
    const e = await service([{ id: await resource() }]);
    await db
      .update(schema.eventTypes)
      .set({ bufferBeforeMinutes: 10 })
      .where(eq(schema.eventTypes.id, e.id));
    expect(await offered(e)).toEqual([]);
  });
  it("a corrupt opening-hours document is a technical invariant, not bookable slots", async () => {
    const r = await resource();
    const e = await service([{ id: r }]);
    const client = await db.$client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query("UPDATE resources SET opening_hours='[]'::jsonb WHERE id=$1", [r]);
      await client.query("COMMIT");
      await expect(offered(e)).rejects.toBeInstanceOf(ResourceInvariantError);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
