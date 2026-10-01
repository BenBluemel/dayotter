import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createDatabase, eq, schema } from "@dayotter/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { consumeCredit } from "../packages/credits";
import { persistBookingPricingSnapshot, quoteAppointmentPrice } from "./pricing";

// Never fall back to DATABASE_URL. This suite creates its own database, applies
// the real migration history, and drops only the database it created.
const testUrl = process.env.PROMOTIONS_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("appointment pricing PostgreSQL integration", () => {
  const name = `dayotter_promotions_test_${randomUUID().replaceAll("-", "")}`;
  let admin: ReturnType<typeof createDatabase>;
  let db: ReturnType<typeof createDatabase>;
  let created = false;
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const hostId = randomUUID();
  const eventId = randomUUID();
  const otherEventId = randomUUID();
  const promoId = "00000000-0000-4000-8000-000000000001";
  const secondPromoId = "00000000-0000-4000-8000-000000000002";
  const legacyId = randomUUID();
  const startsAt = new Date("2026-10-15T15:00:00Z");

  const quote = (start = startsAt, settlement: "cash" | "package_credit" = "cash") =>
    quoteAppointmentPrice(
      { organizationId: orgId, eventTypeId: eventId, appointmentStartsAt: start, settlement },
      db,
    );

  const makeBooking = async (
    start = startsAt,
    extra: Partial<typeof schema.bookings.$inferInsert> = {},
  ) => {
    const [row] = await db
      .insert(schema.bookings)
      .values({
        organizationId: orgId,
        eventTypeId: eventId,
        hostId,
        title: "Light",
        startsAt: start,
        endsAt: new Date(start.getTime() + 30 * 60_000),
        timezone: "UTC",
        uid: randomUUID(),
        // Isolate pricing from host conflict tests, which have their own coverage.
        allowOverlap: true,
        ...extra,
      })
      .returning();
    return row!;
  };

  const save = async (bookingId: string, price: Awaited<ReturnType<typeof quote>>) =>
    db.transaction((tx) => persistBookingPricingSnapshot(bookingId, price, tx));

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.pathname !== "/dayotter_promotions_test"
    ) {
      throw new Error("Use a disposable loopback database named dayotter_promotions_test");
    }
    admin = createDatabase(url.toString());
    await admin.$client.query(`CREATE DATABASE "${name}"`);
    created = true;
    url.pathname = `/${name}`;
    db = createDatabase(url.toString());
    const directory = new URL("../../../../packages/db/drizzle/", import.meta.url);
    const journal = JSON.parse(
      await readFile(new URL("meta/_journal.json", directory), "utf8"),
    ) as { entries: { tag: string }[] };
    for (const { tag } of journal.entries.filter((e) => Number(e.tag.slice(0, 4)) < 63)) {
      const migration = await readFile(new URL(`${tag}.sql`, directory), "utf8");
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await db.$client.query(statement);
      }
    }
    await db.insert(schema.organizations).values([
      { id: orgId, name: "Light & Balance", slug: randomUUID() },
      { id: otherOrgId, name: "Other", slug: randomUUID() },
    ]);
    await db.insert(schema.users).values({ id: hostId, email: "host@example.test" });
    await db.insert(schema.eventTypes).values([
      {
        id: eventId,
        organizationId: orgId,
        ownerId: hostId,
        slug: "light",
        title: "Light",
        price: 5000,
        currency: "usd",
        depositAmount: 4500,
      },
      { id: otherEventId, organizationId: otherOrgId, slug: "other", title: "Other" },
    ]);
    await makeBooking(startsAt, {
      id: legacyId,
      paymentStatus: "paid",
      amountPaid: 2000,
      paymentIntentId: "pi_legacy",
    });
    const migration = await readFile(new URL("0063_appointment_promotions.sql", directory), "utf8");
    const client = await db.$client.connect();
    try {
      await client.query("BEGIN");
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await client.query(statement);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    for (const { tag } of journal.entries.filter((e) => Number(e.tag.slice(0, 4)) > 63)) {
      const migration = await readFile(new URL(`${tag}.sql`, directory), "utf8");
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await db.$client.query(statement);
      }
    }
    await db.insert(schema.appointmentPromotions).values([
      {
        id: promoId,
        organizationId: orgId,
        label: "October",
        startsAt: new Date("2026-10-01Z"),
        endsAt: new Date("2026-11-01Z"),
        discountKind: "percentage",
        discountValue: 2000,
      },
      {
        id: secondPromoId,
        organizationId: orgId,
        label: "Fixed",
        startsAt: new Date("2026-10-01Z"),
        endsAt: new Date("2026-11-01Z"),
        discountKind: "fixed",
        discountValue: 1000,
        currency: "usd",
      },
    ]);
    await db.insert(schema.appointmentPromotionEventTypes).values([
      { promotionId: promoId, eventTypeId: eventId, organizationId: orgId },
      { promotionId: secondPromoId, eventTypeId: eventId, organizationId: orgId },
    ]);
  }, 60000);

  afterAll(async () => {
    if (db) await db.$client.end();
    if (created) await admin.$client.query(`DROP DATABASE "${name}"`);
    if (admin) await admin.$client.end();
  });

  it("migrates legacy paid bookings without fabricating pricing history", async () => {
    const [booking] = await db
      .select()
      .from(schema.bookings)
      .where(eq(schema.bookings.id, legacyId));
    expect(booking).toMatchObject({ amountPaid: 2000, paymentIntentId: "pi_legacy" });
    expect(
      await db
        .select()
        .from(schema.bookingPricingSnapshots)
        .where(eq(schema.bookingPricingSnapshots.bookingId, legacyId)),
    ).toEqual([]);
    await expect(save(legacyId, await quote())).rejects.toThrow("explicit pricing adjustment");
  });

  it("loads authoritative rules and chooses the largest saving with stable ties", async () => {
    expect(await quote()).toMatchObject({
      basePrice: 5000,
      effectivePrice: 4000,
      amountToCollect: 4000,
      promotion: { id: promoId },
    });
    await db
      .update(schema.appointmentPromotions)
      .set({ discountValue: 1500 })
      .where(eq(schema.appointmentPromotions.id, secondPromoId));
    expect(await quote()).toMatchObject({
      effectivePrice: 3500,
      amountToCollect: 3500,
      promotion: { id: secondPromoId },
    });
    await db
      .update(schema.appointmentPromotions)
      .set({ discountValue: 1000 })
      .where(eq(schema.appointmentPromotions.id, secondPromoId));
  });

  it("quotes one committed revision when administration changes price and promotions concurrently", async () => {
    const originalQuery = db.$client.query;
    const reader = vi.spyOn(db.$client, "query");
    let editCommitted = false;
    // Pause delivery of the first real PostgreSQL read while a separate connection
    // commits an atomic admin edit. Two READ COMMITTED selects would mix revisions.
    reader.mockImplementationOnce((async (...args: Parameters<typeof originalQuery>) => {
      const result = await Reflect.apply(originalQuery, db.$client, args);
      await db.transaction(async (tx) => {
        await tx
          .update(schema.eventTypes)
          .set({ price: 8000 })
          .where(eq(schema.eventTypes.id, eventId));
        await tx
          .update(schema.appointmentPromotions)
          .set({ discountValue: 5000 })
          .where(eq(schema.appointmentPromotions.id, promoId));
      });
      editCommitted = true;
      return result;
    }) as typeof originalQuery);
    try {
      const price = await quote();
      expect(editCommitted).toBe(true);
      expect(price).toMatchObject({
        basePrice: 5000,
        effectivePrice: 4000,
        amountToCollect: 4000,
        promotion: { id: promoId, discount: { kind: "percentage", basisPoints: 2000 } },
      });
      reader.mockRestore();
      expect(await quote()).toMatchObject({
        basePrice: 8000,
        effectivePrice: 4000,
        amountToCollect: 4000,
        promotion: { id: promoId, discount: { kind: "percentage", basisPoints: 5000 } },
      });
    } finally {
      reader.mockRestore();
      await db.transaction(async (tx) => {
        await tx
          .update(schema.eventTypes)
          .set({ price: 5000 })
          .where(eq(schema.eventTypes.id, eventId));
        await tx
          .update(schema.appointmentPromotions)
          .set({ discountValue: 2000 })
          .where(eq(schema.appointmentPromotions.id, promoId));
      });
    }
  });

  it("enforces service selection, organization scope, active rules, and interval endpoints", async () => {
    await expect(
      quoteAppointmentPrice(
        {
          organizationId: otherOrgId,
          eventTypeId: eventId,
          appointmentStartsAt: startsAt,
          settlement: "cash",
        },
        db,
      ),
    ).rejects.toThrow("not found");
    const unselected = await quoteAppointmentPrice(
      {
        organizationId: otherOrgId,
        eventTypeId: otherEventId,
        appointmentStartsAt: startsAt,
        settlement: "cash",
      },
      db,
    );
    expect(unselected.promotion).toBeNull();
    expect((await quote(new Date("2026-10-01T00:00:00Z"))).promotion?.id).toBe(promoId);
    expect((await quote(new Date("2026-11-01T00:00:00Z"))).promotion).toBeNull();
    await db
      .update(schema.appointmentPromotions)
      .set({ isActive: false })
      .where(eq(schema.appointmentPromotions.id, promoId));
    expect((await quote()).promotion?.id).toBe(secondPromoId);
    await db
      .update(schema.appointmentPromotions)
      .set({ isActive: true })
      .where(eq(schema.appointmentPromotions.id, promoId));
  });

  it("protects tenant links, duplicate applicability, and invalid promotion rules", async () => {
    await expect(
      db
        .insert(schema.appointmentPromotionEventTypes)
        .values({ promotionId: promoId, eventTypeId: otherEventId, organizationId: orgId }),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      db
        .insert(schema.appointmentPromotionEventTypes)
        .values({ promotionId: promoId, eventTypeId: eventId, organizationId: orgId }),
    ).rejects.toMatchObject({ code: "23505" });
    for (const change of [
      { discountValue: 10001 },
      { label: " " },
      { endsAt: new Date("2026-09-01Z") },
      { currency: "usd" },
    ]) {
      await expect(
        db
          .update(schema.appointmentPromotions)
          .set(change)
          .where(eq(schema.appointmentPromotions.id, promoId)),
      ).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("persists the accepted quote even if a promotion changes before the booking is written", async () => {
    const accepted = await quote();
    await db
      .update(schema.appointmentPromotions)
      .set({ label: "New campaign", discountValue: 5000 })
      .where(eq(schema.appointmentPromotions.id, promoId));
    expect((await quote()).effectivePrice).toBe(2500);
    const booking = await makeBooking();
    const saved = await save(booking.id, accepted);
    expect(saved).toMatchObject({
      effectivePrice: 4000,
      amountToCollect: 4000,
      promotionLabel: "October",
      promotionDiscountValue: 2000,
    });
    await db
      .update(schema.appointmentPromotions)
      .set({ label: "October", discountValue: 2000 })
      .where(eq(schema.appointmentPromotions.id, promoId));
  });

  it("persists fixed-discount currency and rejects incompatible attribution", async () => {
    await db
      .update(schema.appointmentPromotions)
      .set({ discountValue: 1500 })
      .where(eq(schema.appointmentPromotions.id, secondPromoId));
    const booking = await makeBooking();
    const saved = await save(booking.id, await quote());
    expect(saved).toMatchObject({
      effectivePrice: 3500,
      promotionDiscountKind: "fixed",
      promotionDiscountValue: 1500,
      promotionCurrency: "usd",
    });
    await expect(
      db
        .insert(schema.bookingPricingSnapshots)
        .values({ ...saved, id: randomUUID(), promotionCurrency: "eur" }),
    ).rejects.toMatchObject({ code: "23514" });
    await db
      .update(schema.appointmentPromotions)
      .set({ discountValue: 1000 })
      .where(eq(schema.appointmentPromotions.id, secondPromoId));
  });

  it("persists independent immutable snapshots across edits and recurring appointment times", async () => {
    const first = await makeBooking();
    const later = await makeBooking(new Date("2026-11-15T15:00:00Z"));
    const saved = await save(first.id, await quote());
    const laterSaved = await save(later.id, await quote(later.startsAt));
    expect(saved).toMatchObject({
      basePrice: 5000,
      effectivePrice: 4000,
      promotionId: promoId,
      promotionLabel: "October",
      promotionDiscountValue: 2000,
    });
    expect(laterSaved).toMatchObject({ basePrice: 5000, effectivePrice: 5000, promotionId: null });
    await db
      .update(schema.appointmentPromotions)
      .set({ label: "Edited", discountValue: 3000 })
      .where(eq(schema.appointmentPromotions.id, promoId));
    const [stored] = await db
      .select()
      .from(schema.bookingPricingSnapshots)
      .where(eq(schema.bookingPricingSnapshots.id, saved.id));
    expect(stored).toEqual(saved);
    await expect(
      db
        .update(schema.bookingPricingSnapshots)
        .set({ promotionLabel: "Changed" })
        .where(eq(schema.bookingPricingSnapshots.id, saved.id)),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db
        .delete(schema.bookingPricingSnapshots)
        .where(eq(schema.bookingPricingSnapshots.id, saved.id)),
    ).rejects.toMatchObject({ code: "23514" });
    await db
      .update(schema.appointmentPromotions)
      .set({ label: "October", discountValue: 2000 })
      .where(eq(schema.appointmentPromotions.id, promoId));
  });

  it("keeps every unpaid reschedule quote and blocks automatic repricing after collection", async () => {
    const booking = await makeBooking();
    const initial = await save(booking.id, await quote());
    const newStart = new Date("2026-11-15T10:00:00Z");
    await db
      .update(schema.bookings)
      .set({ startsAt: newStart, endsAt: new Date(newStart.getTime() + 1800000) })
      .where(eq(schema.bookings.id, booking.id));
    await expect(save(booking.id, await quote())).rejects.toThrow("does not match");
    const updated = await save(booking.id, await quote(newStart));
    expect(updated.effectivePrice).toBe(5000);
    await db
      .update(schema.bookings)
      .set({ paymentStatus: "paid", amountPaid: 4500, paymentIntentId: "pi_collected" })
      .where(eq(schema.bookings.id, booking.id));
    await expect(save(booking.id, await quote(newStart))).rejects.toThrow(
      "explicit pricing adjustment",
    );
    const [stored] = await db
      .select()
      .from(schema.bookingPricingSnapshots)
      .where(eq(schema.bookingPricingSnapshots.id, initial.id));
    expect(stored).toEqual(initial);
    const [paid] = await db
      .select()
      .from(schema.bookings)
      .where(eq(schema.bookings.id, booking.id));
    expect(paid).toMatchObject({ amountPaid: 4500, paymentIntentId: "pi_collected" });
  });

  it("keeps credit settlement distinct and rejects cash payment facts on it", async () => {
    const booking = await makeBooking();
    const credit = await save(booking.id, await quote(startsAt, "package_credit"));
    expect(credit).toMatchObject({
      settlement: "package_credit",
      effectivePrice: 5000,
      amountToCollect: 0,
      promotionId: null,
    });
    await expect(
      db.update(schema.bookings).set({ amountPaid: 1 }).where(eq(schema.bookings.id, booking.id)),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db
        .update(schema.bookings)
        .set({ paymentIntentId: "pi_bad" })
        .where(eq(schema.bookings.id, booking.id)),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(save(booking.id, await quote())).rejects.toMatchObject({ code: "23514" });
    await db
      .update(schema.bookings)
      .set({ paymentStatus: "paid" })
      .where(eq(schema.bookings.id, booking.id));
  });

  it("allows zero-price cash with no credit or Stripe requirement and preserves history after deleting a rule", async () => {
    const [free] = await db
      .insert(schema.appointmentPromotions)
      .values({
        organizationId: orgId,
        label: "Free day",
        startsAt: new Date("2026-10-01Z"),
        endsAt: new Date("2026-11-01Z"),
        discountKind: "percentage",
        discountValue: 10000,
      })
      .returning();
    await db
      .insert(schema.appointmentPromotionEventTypes)
      .values({ promotionId: free!.id, eventTypeId: eventId, organizationId: orgId });
    const booking = await makeBooking();
    const saved = await save(booking.id, await quote());
    expect(saved).toMatchObject({ settlement: "cash", effectivePrice: 0, amountToCollect: 0 });
    await db
      .delete(schema.appointmentPromotions)
      .where(eq(schema.appointmentPromotions.id, free!.id));
    expect(
      (
        await db
          .select()
          .from(schema.bookingPricingSnapshots)
          .where(eq(schema.bookingPricingSnapshots.id, saved.id))
      )[0],
    ).toEqual(saved);
    await db.delete(schema.bookings).where(eq(schema.bookings.id, booking.id));
    expect(
      await db
        .select()
        .from(schema.bookingPricingSnapshots)
        .where(eq(schema.bookingPricingSnapshots.id, saved.id)),
    ).toEqual([]);
  });

  it("rejects invalid snapshot amounts, scope, partial promotion data, and cash-credit mixes", async () => {
    const booking = await makeBooking();
    const saved = await save(booking.id, await quote());
    for (const change of [
      { basePrice: -1 },
      { amountToCollect: 4001 },
      { effectivePrice: 3999 },
      { promotionLabel: null },
      { promotionDiscountKind: null },
      { settlement: "package_credit" as const },
    ]) {
      await expect(
        db.insert(schema.bookingPricingSnapshots).values({ ...saved, id: randomUUID(), ...change }),
      ).rejects.toMatchObject({ code: "23514" });
    }
    await expect(
      db
        .insert(schema.bookingPricingSnapshots)
        .values({ ...saved, id: randomUUID(), organizationId: otherOrgId }),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("rolls snapshots and credit redemption back with the booking transaction", async () => {
    const email = `${randomUUID()}@example.test`;
    const [grant] = await db
      .insert(schema.packageCredits)
      .values({ organizationId: orgId, eventTypeId: eventId, clientEmail: email, totalCredits: 1 })
      .returning();
    const booking = await makeBooking();
    await expect(
      db.transaction(async (tx) => {
        expect(await consumeCredit(eventId, email, tx)).toBe(true);
        await persistBookingPricingSnapshot(
          booking.id,
          await quote(startsAt, "package_credit"),
          tx,
        );
        throw new Error("Simulated booking failure");
      }),
    ).rejects.toThrow("Simulated booking failure");
    expect(
      (
        await db.select().from(schema.packageCredits).where(eq(schema.packageCredits.id, grant!.id))
      )[0]?.usedCredits,
    ).toBe(0);
    expect(
      await db
        .select()
        .from(schema.bookingPricingSnapshots)
        .where(eq(schema.bookingPricingSnapshots.bookingId, booking.id)),
    ).toEqual([]);
  });

  it("serializes competing redemptions of the last credit", async () => {
    const email = `${randomUUID()}@example.test`;
    const [grant] = await db
      .insert(schema.packageCredits)
      .values({ organizationId: orgId, eventTypeId: eventId, clientEmail: email, totalCredits: 1 })
      .returning();
    // A held transaction guarantees overlap; observe PostgreSQL's lock waiter
    // before releasing it, rather than hoping Promise.all creates a race.
    let release!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const first = db.transaction(async (tx) => {
      const result = await consumeCredit(eventId, email.toUpperCase(), tx);
      acquired();
      await held;
      return result;
    });
    await ready;
    const second = consumeCredit(eventId, email, db);
    try {
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        const { rows } = await db.$client.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
        );
        if (rows.length) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
    } finally {
      release();
    }
    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(
      (
        await db.select().from(schema.packageCredits).where(eq(schema.packageCredits.id, grant!.id))
      )[0]?.usedCredits,
    ).toBe(1);
  });
});
