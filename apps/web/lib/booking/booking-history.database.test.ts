import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createDatabase, schema, sql } from "@dayotter/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadBookingHistory } from "./booking-history";

const mock = vi.hoisted(() => ({
  db: null as unknown as Omit<ReturnType<typeof createDatabase>, "$client">,
}));
vi.mock("@dayotter/db", async (original) => ({
  ...(await original<typeof import("@dayotter/db")>()),
  getDb: () => mock.db,
}));
const url = process.env.BOOKING_HISTORY_TEST_DATABASE_URL;
describe.skipIf(!url)("booking history PostgreSQL 17", () => {
  const databaseName = `dayotter_history_test_${randomUUID().replaceAll("-", "")}`;
  let admin: ReturnType<typeof createDatabase>;
  let db: ReturnType<typeof createDatabase>;
  let created = false;
  const org = randomUUID();
  const host = randomUUID();
  const otherHost = randomUUID();
  const service = randomUUID();
  let sequence = 0;
  beforeAll(async () => {
    const target = new URL(url!);
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
      target.pathname !== "/dayotter_history_test"
    )
      throw new Error("Use only the guarded loopback history test database");
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
    await db
      .insert(schema.organizations)
      .values({ id: org, name: "History test", slug: randomUUID() });
    await db
      .insert(schema.users)
      .values([host, otherHost].map((id) => ({ id, email: `${id}@example.test` })));
    await db.insert(schema.eventTypes).values({
      id: service,
      ownerId: host,
      organizationId: org,
      slug: "history",
      title: "History",
      durationMinutes: 30,
    });
  }, 180000);
  afterAll(async () => {
    await db?.$client.end();
    if (created) await admin.$client.query(`DROP DATABASE "${databaseName}"`);
    await admin?.$client.end();
  });
  async function booking(
    title: string,
    options: {
      hostId?: string;
      attendees?: { name?: string; email: string }[];
      status?: typeof schema.bookings.$inferSelect.status;
    } = {},
  ) {
    const startsAt = new Date(Date.UTC(2035, 0, 1 + sequence++));
    const [row] = await db
      .insert(schema.bookings)
      .values({
        organizationId: org,
        eventTypeId: service,
        hostId: options.hostId ?? host,
        title,
        uid: randomUUID(),
        startsAt,
        endsAt: new Date(startsAt.getTime() + 1800000),
        timezone: "UTC",
        status: options.status ?? "completed",
      })
      .returning();
    if (options.attendees?.length)
      await db
        .insert(schema.bookingAttendees)
        .values(options.attendees.map((a) => ({ ...a, bookingId: row!.id })));
    return row!;
  }
  const ids = (result: Awaited<ReturnType<typeof loadBookingHistory>>) =>
    result.rows.map((b) => b.id);

  it("runs against PostgreSQL 17 and matches a misspelled word inside a full name", async () => {
    const version = await db.execute(sql`show server_version_num`);
    expect(Number(version.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(170000);
    expect(Number(version.rows[0]?.server_version_num)).toBeLessThan(180000);
    const row = await booking("Fuzzy visit", {
      attendees: [{ name: "Kimberly Johnson", email: "fuzzy@example.test" }],
    });
    expect(ids(await loadBookingHistory(host, "Kimberley"))).toContain(row.id);
    expect(ids(await loadBookingHistory(host, "kImBeRlY"))).toContain(row.id);
    expect(ids(await loadBookingHistory(host, "fuzzy@example"))).toContain(row.id);
    const literalOnly = await booking("Kimberly", {
      attendees: [{ email: "kimberly@example.test" }],
    });
    // An email fragment must not also match Kimberly's name through pg_trgm.
    expect(ids(await loadBookingHistory(host, "  KiMbErLy@  "))).toEqual([literalOnly.id]);
    expect(ids(await loadBookingHistory(host, "Kimberley"))).not.toContain(literalOnly.id);
  });
  it("escapes literal wildcards and escape characters across all fields", async () => {
    const title = await booking("Title 50%_!\\ done");
    const name = await booking("Name visit", {
      attendees: [{ name: "50%_!\\", email: "name@example.test" }],
    });
    const email = await booking("Email visit", { attendees: [{ email: "50%_!\\@example.test" }] });
    await booking("Title 50anythingX!\\ done");
    expect(ids(await loadBookingHistory(host, "50%_!\\"))).toEqual([name.id, email.id, title.id]);
    const punctuation = await booking("Literal %_!");
    await booking("Literal abc!");
    expect(ids(await loadBookingHistory(host, "%_!"))).toContain(punctuation.id);
    expect(
      (await loadBookingHistory(host, "%_!")).rows.every(
        (b) =>
          b.title.includes("%_!") ||
          b.attendees.some((a) => `${a.name ?? ""}${a.email}`.includes("%_!")),
      ),
    ).toBe(true);
  });
  it("isolates hosts in title, literal attendee and fuzzy attendee branches", async () => {
    const own = await booking("ScopeTarget");
    const foreign = await booking("ScopeTarget", {
      hostId: otherHost,
      attendees: [{ name: "Kimberly Johnson", email: "ForeignContact@example.test" }],
    });
    expect(ids(await loadBookingHistory(host, "ScopeTarget"))).toEqual([own.id]);
    expect(ids(await loadBookingHistory(host, "ForeignContact"))).toEqual([]);
    expect(ids(await loadBookingHistory(host, "Kimberly Johnson"))).not.toContain(foreign.id);
    expect(ids(await loadBookingHistory(host, "Kimberley"))).not.toContain(foreign.id);
    expect((await loadBookingHistory(host)).rows.every((b) => b.hostId === host)).toBe(true);
  });
  it("ranks exact, prefix, substring and fuzzy and deduplicates matching attendees", async () => {
    const exact = await booking("Tier visit", {
      attendees: [
        { name: "Alexandra", email: "alexandra@example.test" },
        { name: "Alexandra", email: "second@example.test" },
      ],
    });
    const prefix = await booking("Alexandra consultation");
    const substring = await booking("Visit Alexandra");
    const fuzzy = await booking("Tier fuzzy", {
      attendees: [{ name: "Alexandre Jones", email: "tier@example.test" }],
    });
    const weaker = await booking("Tier weaker fuzzy", {
      attendees: [{ name: "Alexanndra Jones", email: "weak@example.test" }],
    });
    expect(ids(await loadBookingHistory(host, "Alexandra"))).toEqual([
      exact.id,
      prefix.id,
      substring.id,
      fuzzy.id,
      weaker.id,
    ]);
  });
  it("deduplicates before 101, displays 100, and filters statuses before the limit", async () => {
    // This pending match is older than every completed match: post-limit
    // filtering would incorrectly lose it entirely.
    const filtered = await booking("Limitneedle", { status: "pending" });
    const rows = [];
    for (let i = 0; i < 100; i++)
      rows.push(
        await booking("Limitneedle", {
          attendees: [
            { name: "Limitneedle", email: `${i}@example.test` },
            { name: "Limitneedle", email: `duplicate${i}@example.test` },
          ],
        }),
      );
    expect(await loadBookingHistory(host, "Limitneedle", "completed")).toMatchObject({
      hasMore: false,
    });
    rows.push(await booking("Limitneedle"));
    const result = await loadBookingHistory(host, "Limitneedle", "completed");
    expect(result.hasMore).toBe(true);
    expect(ids(result)).toEqual(
      rows
        .slice(1)
        .reverse()
        .map((b) => b.id),
    );
    const pending = await loadBookingHistory(host, "Limitneedle", "pending");
    expect(ids(pending)).toEqual([filtered.id]);
    expect(pending.hasMore).toBe(false);
    expect(ids(await loadBookingHistory(host, "", "pending"))).toEqual([filtered.id]);
    expect(await loadBookingHistory(host, "no-such-needle")).toMatchObject({
      rows: [],
      hasMore: false,
    });
  });
  it("maps Cancelled to cancelled and rejected and trims search text", async () => {
    const cancelled = await booking("Statusneedle", { status: "cancelled" });
    const rejected = await booking("Statusneedle", { status: "rejected" });
    await booking("Statusneedle", { status: "confirmed" });
    expect(ids(await loadBookingHistory(host, "  Statusneedle  ", "cancelled"))).toEqual([
      rejected.id,
      cancelled.id,
    ]);
  });
  it("sets the similarity threshold locally and restores a pooled connection's prior value", async () => {
    const client = await db.$client.connect();
    const original = mock.db;
    // Pin this test to one connection so a different pooled connection cannot mask a leak.
    const { drizzle } = await import("drizzle-orm/node-postgres");
    mock.db = drizzle(client, { schema, casing: "snake_case" });
    try {
      await client.query("set pg_trgm.word_similarity_threshold = 0.99");
      expect(
        (await client.query("select 'kimberley' <% 'kimberly johnson' as matched")).rows[0].matched,
      ).toBe(false);
      expect((await loadBookingHistory(host, "Kimberley")).rows.length).toBeGreaterThan(0);
      expect(
        (
          await client.query(
            "select current_setting('pg_trgm.word_similarity_threshold') as threshold",
          )
        ).rows[0].threshold,
      ).toBe("0.99");
    } finally {
      await client.query("reset pg_trgm.word_similarity_threshold");
      mock.db = original;
      client.release();
    }
  });
  it("verifies operator direction and GIN compatibility for name, email and title", async () => {
    const direction = await db.execute(
      sql`select word_similarity('kimberley', 'kimberly johnson') as forward, word_similarity('kimberly johnson', 'kimberley') as reverse`,
    );
    expect(Number(direction.rows[0]?.forward)).toBeGreaterThan(Number(direction.rows[0]?.reverse));
    await db.transaction(async (tx) => {
      // Disable sequential scans only for this capability test, not in the application.
      await tx.execute(sql`set local enable_seqscan = off`);
      await tx.execute(sql`select set_config('pg_trgm.word_similarity_threshold', '0.5', true)`);
      for (const [query, index] of [
        [
          sql`explain select id from booking_attendees where 'kimberley' <% lower(name)`,
          "booking_attendees_name_search_trgm_idx",
        ],
        [
          sql`explain select id from booking_attendees where lower(name) like '%kimberly%'`,
          "booking_attendees_name_search_trgm_idx",
        ],
        [
          sql`explain select id from booking_attendees where lower(email) like '%example%'`,
          "booking_attendees_email_search_trgm_idx",
        ],
        [
          sql`explain select id from bookings where lower(title) like '%visit%'`,
          "bookings_title_search_trgm_idx",
        ],
      ] as const) {
        expect(JSON.stringify((await tx.execute(query)).rows)).toContain(index);
      }
    });
  });
});
