import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createDatabase, eq, schema } from "@dayotter/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalJson, decodeAttempt } from "./attempt-terms";

const mock = vi.hoisted(() => ({ mode: "direct" as "direct" | "disabled" }));
vi.mock("../server/env", () => ({ env: { APP_URL: "https://example.test" } }));
vi.mock("./connect", () => ({
  checkoutRouteForOrganization: async (organizationId: string) => {
    if (mock.mode === "disabled") throw new Error("Cash checkout is disabled");
    return {
      mode: "direct",
      organizationId,
      environment: "test",
      chargeAccountId: "acct_merchant",
      credentialContext: "primary",
    };
  },
}));
import { fixturePaymentIntent, fixtureSession } from "./attempt-fixtures";
import { bindAttemptSession, findAppointmentAttempt, prepareAppointmentAttempt } from "./attempts";

// Only a disposable loopback test database. Never DATABASE_URL or production fallback.
const testUrl = process.env.PAYMENTS_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("durable appointment intents PostgreSQL integration", () => {
  const databaseName = `dayotter_payments_test_${randomUUID().replaceAll("-", "")}`;
  let admin: ReturnType<typeof createDatabase>;
  let db: ReturnType<typeof createDatabase>;
  let created = false;
  const oldKey = process.env.ENCRYPTION_KEY;
  const organizationId = randomUUID();
  const ownerId = randomUUID();
  const eventTypeId = randomUUID();
  const promotionId = randomUUID();
  const input = {
    eventTypeId,
    start: "2026-10-15T15:00:00.000Z",
    attendee: { name: "Client", email: "client@example.test", timezone: "UTC" },
  };

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.pathname !== "/dayotter_payments_test"
    )
      throw new Error("Use a disposable loopback database named dayotter_payments_test");
    process.env.ENCRYPTION_KEY = "ab".repeat(32);
    admin = createDatabase(url.toString());
    await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    url.pathname = `/${databaseName}`;
    db = createDatabase(url.toString());
    const directory = new URL("../../../../packages/db/drizzle/", import.meta.url);
    const journal = JSON.parse(
      await readFile(new URL("meta/_journal.json", directory), "utf8"),
    ) as { entries: { tag: string }[] };
    for (const { tag } of journal.entries) {
      const migration = await readFile(new URL(`${tag}.sql`, directory), "utf8");
      const client = await db.$client.connect();
      try {
        await client.query("BEGIN");
        for (const statement of migration.split("--> statement-breakpoint"))
          if (statement.trim()) await client.query(statement);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }
    await db
      .insert(schema.organizations)
      .values({ id: organizationId, name: "Merchant", slug: randomUUID() });
    await db.insert(schema.users).values({ id: ownerId, email: "host@example.test" });
    await db.insert(schema.eventTypes).values({
      id: eventTypeId,
      organizationId,
      ownerId,
      slug: "light",
      title: "Light",
      price: 5000,
      currency: "usd",
      depositAmount: 4500,
    });
    await db.insert(schema.appointmentPromotions).values({
      id: promotionId,
      organizationId,
      label: "October",
      startsAt: new Date("2026-10-01Z"),
      endsAt: new Date("2026-11-01Z"),
      discountKind: "percentage",
      discountValue: 2000,
    });
    await db
      .insert(schema.appointmentPromotionEventTypes)
      .values({ promotionId, organizationId, eventTypeId });
  }, 60000);
  afterAll(async () => {
    if (db) await db.$client.end();
    if (created) await admin.$client.query(`DROP DATABASE "${databaseName}"`);
    if (admin) await admin.$client.end();
    if (oldKey === undefined) Reflect.deleteProperty(process.env, "ENCRYPTION_KEY");
    else process.env.ENCRYPTION_KEY = oldKey;
  });

  it("persists one complete attempt for concurrent retries before any Stripe creation", async () => {
    const requestId = randomUUID();
    const results = await Promise.all([
      prepareAppointmentAttempt(input, "/", requestId, db),
      prepareAppointmentAttempt(input, "/", requestId, db),
    ]);
    expect(results[0].attempt!.id).toBe(results[1].attempt!.id);
    expect(results[0].attempt!.checkoutSessionId).toBeNull();
    const attempt = await findAppointmentAttempt(input, "/", requestId, db);
    expect(decodeAttempt(attempt!).quote).toMatchObject({
      effectivePrice: 4000,
      amountToCollect: 4000,
    });
    await expect(
      findAppointmentAttempt({ ...input, notes: "changed" }, "/", requestId, db),
    ).rejects.toThrow("different booking input");
  });

  it("rejects direct SQL mutations/deletion of financial terms and identifiers", async () => {
    const { attempt } = await prepareAppointmentAttempt(input, "/", randomUUID(), db);
    await expect(
      db
        .update(schema.paymentAttempts)
        .set({ amount: 1 })
        .where(eq(schema.paymentAttempts.id, attempt!.id)),
    ).rejects.toThrow();
    await expect(
      db
        .update(schema.paymentAttempts)
        .set({ quote: { ...(attempt!.quote as object), effectivePrice: 1 } })
        .where(eq(schema.paymentAttempts.id, attempt!.id)),
    ).rejects.toThrow();
    await expect(
      db.delete(schema.paymentAttempts).where(eq(schema.paymentAttempts.id, attempt!.id)),
    ).rejects.toThrow();
    await bindAttemptSession(attempt!, fixtureSession(attempt!), db);
    await expect(
      db
        .update(schema.paymentAttempts)
        .set({ checkoutSessionId: "cs_changed" })
        .where(eq(schema.paymentAttempts.id, attempt!.id)),
    ).rejects.toThrow();
  });

  it("copies the frozen quote before settlement and binds the booking atomically", async () => {
    const { attempt } = await prepareAppointmentAttempt(input, "/", randomUUID(), db);
    const session = {
      ...fixtureSession(attempt!),
      id: `cs_${attempt!.id}`,
      payment_status: "paid" as const,
      payment_intent: `pi_${attempt!.id}`,
      status: "complete" as const,
    };
    const bound = await bindAttemptSession(attempt!, session, db);
    const { verifiedPaymentFacts } = await import("./payment-success");
    await db
      .update(schema.paymentAttempts)
      .set({
        state: "payment_succeeded",
        paymentSucceededAt: new Date(),
        successFacts: verifiedPaymentFacts(bound, session, fixturePaymentIntent(bound, session)),
      })
      .where(eq(schema.paymentAttempts.id, bound.id));
    const { persistBookingPricingSnapshot } = await import("../booking/pricing");
    const bookingId = randomUUID();
    await db.transaction(async (tx) => {
      await tx
        .select()
        .from(schema.paymentAttempts)
        .where(eq(schema.paymentAttempts.id, bound.id))
        .for("update");
      await tx.insert(schema.bookings).values({
        id: bookingId,
        organizationId,
        eventTypeId,
        hostId: ownerId,
        title: "Light",
        uid: randomUUID(),
        startsAt: new Date(input.start),
        endsAt: new Date(new Date(input.start).getTime() + 1800000),
        timezone: "UTC",
        allowOverlap: true,
      });
      await persistBookingPricingSnapshot(bookingId, decodeAttempt(bound).quote, tx);
      await tx
        .update(schema.bookings)
        .set({
          paymentStatus: "paid",
          paymentIntentId: session.payment_intent,
          amountPaid: bound.amount,
          paymentCurrency: bound.currency,
        })
        .where(eq(schema.bookings.id, bookingId));
      await tx
        .update(schema.paymentAttempts)
        .set({
          state: "fulfilled",
          bookingId,
          finalizationContext: "encrypted-test-context",
          finalizationState: "pending",
        })
        .where(eq(schema.paymentAttempts.id, bound.id));
    });
    const stored = await db.query.paymentAttempts.findFirst({
      where: eq(schema.paymentAttempts.id, bound.id),
    });
    const snapshot = await db.query.bookingPricingSnapshots.findFirst({
      where: eq(schema.bookingPricingSnapshots.bookingId, bookingId),
    });
    expect(stored).toMatchObject({ state: "fulfilled", bookingId });
    expect(snapshot).toMatchObject({
      basePrice: 5000,
      effectivePrice: 4000,
      amountToCollect: 4000,
      promotionLabel: "October",
    });
    await expect(
      db
        .update(schema.paymentAttempts)
        .set({ state: "open" })
        .where(eq(schema.paymentAttempts.id, bound.id)),
    ).rejects.toThrow();
  });

  it("reuses frozen terms after committed service/promotion edits and mode changes", async () => {
    const requestId = randomUUID();
    const first = await prepareAppointmentAttempt(input, "/", requestId, db);
    await db.transaction(async (tx) => {
      await tx
        .update(schema.eventTypes)
        .set({ price: 8000 })
        .where(eq(schema.eventTypes.id, eventTypeId));
      await tx
        .update(schema.appointmentPromotions)
        .set({ discountValue: 5000 })
        .where(eq(schema.appointmentPromotions.id, promotionId));
    });
    mock.mode = "disabled";
    const replay = await prepareAppointmentAttempt(input, "/", requestId, db);
    expect(replay.attempt!.id).toBe(first.attempt!.id);
    expect(canonicalJson(replay.quote)).toBe(canonicalJson(first.quote));
    expect(decodeAttempt(replay.attempt!).route.mode).toBe("direct");
    await expect(prepareAppointmentAttempt(input, "/", randomUUID(), db)).rejects.toThrow(
      "disabled",
    );
    mock.mode = "direct";
  });

  it("saves a coherent revision while concurrent administration commits a price/promotion edit", async () => {
    await db.transaction(async (tx) => {
      await tx
        .update(schema.eventTypes)
        .set({ price: 5000 })
        .where(eq(schema.eventTypes.id, eventTypeId));
      await tx
        .update(schema.appointmentPromotions)
        .set({ discountValue: 2000 })
        .where(eq(schema.appointmentPromotions.id, promotionId));
    });
    const requestId = randomUUID();
    // Capture a snapshot, then commit an admin revision before quote loading.
    const reader = Object.create(db) as typeof db;
    let edited = false;
    reader.transaction = async (callback, configuration) =>
      db.transaction(async (tx) => {
        await tx.select().from(schema.eventTypes).where(eq(schema.eventTypes.id, eventTypeId));
        if (!edited) {
          await db.transaction(async (editor) => {
            await editor
              .update(schema.eventTypes)
              .set({ price: 8000 })
              .where(eq(schema.eventTypes.id, eventTypeId));
            await editor
              .update(schema.appointmentPromotions)
              .set({ discountValue: 5000 })
              .where(eq(schema.appointmentPromotions.id, promotionId));
          });
          edited = true;
        }
        return callback(tx);
      }, configuration);
    const prepared = await prepareAppointmentAttempt(input, "/", requestId, reader);
    // Old and new revisions both collect 4000. Mixed revisions would yield 2500/6400.
    expect(prepared.quote.effectivePrice).toBe(4000);
    expect([5000, 8000]).toContain(prepared.quote.basePrice);
    expect(decodeAttempt(prepared.attempt!).quote).toEqual(prepared.quote);
  });
});
