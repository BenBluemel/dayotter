import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createDatabase, eq, schema } from "@dayotter/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fixtureSession } from "../payments/attempt-fixtures";
import { appointmentRequestIdentity, decodeAttempt } from "../payments/attempt-terms";
import { bindAttemptSession, prepareAppointmentAttempt } from "../payments/attempts";
import { decideBookingCancellation } from "../payments/refunds";
import {
  couponCapacityMessage,
  redeemReservedCouponUse,
  releaseTerminalCouponReservation,
  reserveCouponUse,
} from "./coupon-uses";
import { persistBookingPricingSnapshot, quoteAppointmentPrice } from "./pricing";

vi.mock("../server/env", () => ({ env: { APP_URL: "https://example.test" } }));
vi.mock("../payments/connect", () => ({
  checkoutRouteForOrganization: async (organizationId: string) => ({
    mode: "direct",
    organizationId,
    environment: "test",
    chargeAccountId: "acct_merchant",
    credentialContext: "primary",
  }),
}));
const testUrl = process.env.PAYMENTS_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("coupons PostgreSQL integrity and lifecycle", () => {
  const name = `dayotter_payments_test_${randomUUID().replaceAll("-", "")}`;
  let admin: ReturnType<typeof createDatabase>;
  let db: ReturnType<typeof createDatabase>;
  let created = false;
  const oldKey = process.env.ENCRYPTION_KEY;
  const org = randomUUID();
  const otherOrg = randomUUID();
  const host = randomUUID();
  const alice = randomUUID();
  const bob = randomUUID();
  const event = randomUUID();
  const otherEvent = randomUUID();
  const start = "2026-10-15T15:00:00.000Z";
  const input = (code: string, userId: string, when = start) => ({
    eventTypeId: event,
    start: when,
    attendee: { name: "Client", email: "anyone@example.test", timezone: "UTC" },
    couponCode: code,
    couponCustomerUserId: userId,
  });
  async function createCoupon(
    code: string,
    options: Partial<typeof schema.appointmentCoupons.$inferInsert> = {},
  ) {
    const [row] = await db
      .insert(schema.appointmentCoupons)
      .values({
        organizationId: org,
        code,
        startsAt: new Date("2026-10-01Z"),
        endsAt: new Date("2026-11-01Z"),
        validityTimezone: "America/Boise",
        discountKind: "percentage",
        discountValue: 5000,
        ...options,
      })
      .returning();
    await db
      .insert(schema.appointmentCouponEventTypes)
      .values({ couponId: row!.id, eventTypeId: event, organizationId: org });
    return row!;
  }
  async function bookingFor(
    price: Awaited<ReturnType<typeof quoteAppointmentPrice>>,
    settle: (
      tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
      bookingId: string,
    ) => Promise<unknown>,
  ) {
    return db.transaction(async (tx) => {
      const [booking] = await tx
        .insert(schema.bookings)
        .values({
          organizationId: org,
          eventTypeId: event,
          hostId: host,
          title: "Light",
          uid: randomUUID(),
          startsAt: new Date(price.appointmentStartsAt),
          endsAt: new Date(new Date(price.appointmentStartsAt).getTime() + 1800000),
          timezone: "UTC",
          allowOverlap: true,
        })
        .returning();
      await persistBookingPricingSnapshot(booking!.id, price, tx);
      await settle(tx, booking!.id);
      return booking!;
    });
  }
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.pathname !== "/dayotter_payments_test"
    )
      throw new Error("Use a disposable loopback payments test database");
    process.env.ENCRYPTION_KEY = "ab".repeat(32);
    admin = createDatabase(url.toString());
    await admin.$client.query(`CREATE DATABASE "${name}"`);
    created = true;
    url.pathname = `/${name}`;
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
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    await db.insert(schema.organizations).values([
      { id: org, name: "Light", slug: randomUUID() },
      { id: otherOrg, name: "Other", slug: randomUUID() },
    ]);
    await db.insert(schema.users).values([
      { id: host, email: "host@example.test" },
      { id: alice, email: "alice@example.test" },
      { id: bob, email: "bob@example.test" },
    ]);
    await db.insert(schema.eventTypes).values([
      {
        id: event,
        organizationId: org,
        ownerId: host,
        slug: "light",
        title: "Light",
        price: 5000,
        currency: "usd",
        depositAmount: 4500,
      },
      {
        id: otherEvent,
        organizationId: otherOrg,
        ownerId: host,
        slug: "other",
        title: "Other",
        price: 5000,
        currency: "usd",
      },
    ]);
  }, 60000);
  afterAll(async () => {
    if (db) await db.$client.end();
    if (created) await admin.$client.query(`DROP DATABASE "${name}"`);
    if (admin) await admin.$client.end();
    if (oldKey === undefined) Reflect.deleteProperty(process.env, "ENCRYPTION_KEY");
    else process.env.ENCRYPTION_KEY = oldKey;
  });
  it("enforces canonical scoped uniqueness and rejects foreign services", async () => {
    await createCoupon("UNIQUE50");
    await expect(
      db.insert(schema.appointmentCoupons).values({
        organizationId: org,
        code: "UNIQUE50",
        startsAt: new Date("2026-10-01Z"),
        endsAt: new Date("2026-11-01Z"),
        validityTimezone: "America/Boise",
        discountKind: "percentage",
        discountValue: 5000,
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(schema.appointmentCoupons).values({
        organizationId: org,
        code: " unique50 ",
        startsAt: new Date("2026-10-01Z"),
        endsAt: new Date("2026-11-01Z"),
        validityTimezone: "America/Boise",
        discountKind: "percentage",
        discountValue: 5000,
      }),
    ).rejects.toThrow();
    const coupon = await createCoupon("SCOPED50");
    await expect(
      db
        .insert(schema.appointmentCouponEventTypes)
        .values({ couponId: coupon.id, eventTypeId: otherEvent, organizationId: org }),
    ).rejects.toThrow();
  });
  it("enforces service, appointment date, minimum and active state from authenticated quote", async () => {
    const c = await createCoupon("RULES50", { minimumBasePrice: 5000 });
    const quote = () =>
      quoteAppointmentPrice(
        {
          organizationId: org,
          eventTypeId: event,
          appointmentStartsAt: new Date(start),
          settlement: "cash",
          couponCode: " rules50 ",
          couponCustomerUserId: alice,
        },
        db,
      );
    expect(await quote()).toMatchObject({
      version: 2,
      basePrice: 5000,
      effectivePrice: 2500,
      amountToCollect: 2500,
      coupon: { code: "RULES50" },
    });
    await expect(
      quoteAppointmentPrice(
        {
          organizationId: org,
          eventTypeId: event,
          appointmentStartsAt: new Date(start),
          settlement: "cash",
          couponCode: "RULES50",
        },
        db,
      ),
    ).rejects.toThrow("Sign in");
    await expect(
      quoteAppointmentPrice(
        {
          organizationId: org,
          eventTypeId: event,
          appointmentStartsAt: new Date("2026-11-01Z"),
          settlement: "cash",
          couponCode: "RULES50",
          couponCustomerUserId: alice,
        },
        db,
      ),
    ).rejects.toThrow("outside");
    await db
      .update(schema.appointmentCoupons)
      .set({ minimumBasePrice: 5001 })
      .where(eq(schema.appointmentCoupons.id, c.id));
    await expect(quote()).rejects.toThrow("minimum");
    await db
      .update(schema.appointmentCoupons)
      .set({ minimumBasePrice: 5000, isActive: false })
      .where(eq(schema.appointmentCoupons.id, c.id));
    await expect(quote()).rejects.toThrow("inactive");
  });
  it("reserves one global last use across customers and reuses the same checkout request", async () => {
    await createCoupon("GLOBAL50", { globalLimit: 1 });
    const one = input("GLOBAL50", alice);
    const two = input("GLOBAL50", bob);
    const raced = await Promise.allSettled([
      prepareAppointmentAttempt(one, "/", randomUUID(), db),
      prepareAppointmentAttempt(two, "/", randomUUID(), db),
    ]);
    expect(raced.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const winner = raced.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<
      Awaited<ReturnType<typeof prepareAppointmentAttempt>>
    >;
    const saved = winner.value.attempt!;
    await expect(
      db.insert(schema.paymentAttempts).values({
        ...saved,
        id: randomUUID(),
        requestKey: `appointment:${randomUUID()}`,
      }),
    ).rejects.toThrow();
    expect(decodeAttempt(saved).quote).toMatchObject({
      effectivePrice: 2500,
      amountToCollect: 2500,
      coupon: { code: "GLOBAL50" },
    });
    const original = decodeAttempt(saved).input;
    const replay = await prepareAppointmentAttempt(
      original,
      "/",
      saved.requestKey.slice("appointment:".length),
      db,
    );
    expect(replay.attempt?.id).toBe(saved.id);
    expect(await couponCapacityMessage(decodeAttempt(saved).quote, bob, db)).toMatch(/no uses/);
    const expired = { ...fixtureSession(saved), status: "expired" as const, url: null };
    await bindAttemptSession(saved, expired, db);
    const [use] = await db
      .select()
      .from(schema.appointmentCouponUses)
      .where(eq(schema.appointmentCouponUses.paymentAttemptId, saved.id));
    expect(use?.status).toBe("released");
    const next = await prepareAppointmentAttempt(input("GLOBAL50", bob), "/", randomUUID(), db);
    expect(next.attempt?.id).toBeTruthy();
    expect(await releaseTerminalCouponReservation(next.attempt!.id, db)).toBe(false);
    // Simulate a stop after recording terminal checkout state, before release.
    await db
      .update(schema.paymentAttempts)
      .set({ state: "expired" })
      .where(eq(schema.paymentAttempts.id, next.attempt!.id));
    expect(await releaseTerminalCouponReservation(next.attempt!.id, db)).toBe(true);
    expect(await releaseTerminalCouponReservation(next.attempt!.id, db)).toBe(false);
  });
  it("uses fixed amount and lets automatic promotions win equal or better prices without reservation", async () => {
    await createCoupon("FIXED15", { discountKind: "fixed", discountValue: 1500, currency: "usd" });
    const fixed = await quoteAppointmentPrice(
      {
        organizationId: org,
        eventTypeId: event,
        appointmentStartsAt: new Date(start),
        settlement: "cash",
        couponCode: "fixed15",
        couponCustomerUserId: alice,
      },
      db,
    );
    expect(fixed).toMatchObject({
      effectivePrice: 3500,
      amountToCollect: 3500,
      coupon: { code: "FIXED15" },
    });
    const promoId = randomUUID();
    await db.insert(schema.appointmentPromotions).values({
      id: promoId,
      organizationId: org,
      label: "October",
      startsAt: new Date("2026-10-01Z"),
      endsAt: new Date("2026-11-01Z"),
      discountKind: "fixed",
      discountValue: 1500,
      currency: "usd",
    });
    await db
      .insert(schema.appointmentPromotionEventTypes)
      .values({ promotionId: promoId, organizationId: org, eventTypeId: event });
    const tied = await quoteAppointmentPrice(
      {
        organizationId: org,
        eventTypeId: event,
        appointmentStartsAt: new Date(start),
        settlement: "cash",
        couponCode: "FIXED15",
        couponCustomerUserId: alice,
      },
      db,
    );
    expect(tied.coupon).toBeUndefined();
    expect(tied).toMatchObject({
      version: 1,
      promotion: { id: promoId },
      effectivePrice: 3500,
    });
    const prepared = await prepareAppointmentAttempt(
      input("FIXED15", alice),
      "/",
      randomUUID(),
      db,
    );
    expect(prepared.attempt).toBeTruthy();
    expect(
      await db.query.appointmentCouponUses.findFirst({
        where: eq(schema.appointmentCouponUses.paymentAttemptId, prepared.attempt!.id),
      }),
    ).toBeUndefined();
    await db
      .update(schema.appointmentPromotions)
      .set({ discountValue: 2000 })
      .where(eq(schema.appointmentPromotions.id, promoId));
    const betterPromo = await quoteAppointmentPrice(
      {
        organizationId: org,
        eventTypeId: event,
        appointmentStartsAt: new Date(start),
        settlement: "cash",
        couponCode: "FIXED15",
        couponCustomerUserId: alice,
      },
      db,
    );
    expect(betterPromo.promotion?.id).toBe(promoId);
    await db
      .update(schema.appointmentPromotions)
      .set({ discountValue: 500 })
      .where(eq(schema.appointmentPromotions.id, promoId));
    const betterCoupon = await quoteAppointmentPrice(
      {
        organizationId: org,
        eventTypeId: event,
        appointmentStartsAt: new Date(start),
        settlement: "cash",
        couponCode: "FIXED15",
        couponCustomerUserId: alice,
      },
      db,
    );
    expect(betterCoupon.coupon?.code).toBe("FIXED15");
    await db
      .update(schema.appointmentPromotions)
      .set({ isActive: false })
      .where(eq(schema.appointmentPromotions.id, promoId));
  });
  it("prepares one committed discount revision when coupon and promotion edits race", async () => {
    const coupon = await createCoupon("COHERENT", {
      discountKind: "fixed",
      discountValue: 1000,
      currency: "usd",
      globalLimit: 1,
    });
    const promotionId = randomUUID();
    await db.insert(schema.appointmentPromotions).values({
      id: promotionId,
      organizationId: org,
      label: "Coherent revision",
      startsAt: new Date("2026-10-01Z"),
      endsAt: new Date("2026-11-01Z"),
      discountKind: "fixed",
      discountValue: 2000,
      currency: "usd",
    });
    await db.insert(schema.appointmentPromotionEventTypes).values({
      promotionId,
      organizationId: org,
      eventTypeId: event,
    });
    const quoteRequest = {
      organizationId: org,
      eventTypeId: event,
      appointmentStartsAt: new Date(start),
      settlement: "cash" as const,
      couponCode: coupon.code,
      couponCustomerUserId: alice,
    };
    const revisionA = await quoteAppointmentPrice(quoteRequest, db);
    expect(revisionA).toMatchObject({
      version: 1,
      effectivePrice: 3000,
      promotion: { id: promotionId, discount: { amount: 2000 } },
    });
    expect(revisionA.coupon).toBeUndefined();

    // Give the real preparation transaction a dedicated pooled connection. Pause
    // delivery of its first coupon-bearing SELECT only after PostgreSQL has read
    // revision A; commit revision B on another connection before resuming. No
    // values/rows are mocked, and no sleeps determine the interleaving.
    const client = await db.$client.connect();
    const originalQuery = client.query;
    let editCommitted = false;
    let readCommitted = false;
    const reader = vi.spyOn(client, "query");
    reader.mockImplementation((async (...args: Parameters<typeof originalQuery>) => {
      const query = args[0] as string | { text: string };
      const text = typeof query === "string" ? query : query.text;
      if (text === "begin isolation level read committed") readCommitted = true;
      const result = await Reflect.apply(originalQuery, client, args);
      if (!editCommitted && text?.startsWith("select") && text.includes('"appointment_coupons"')) {
        await db.transaction(async (tx) => {
          await tx
            .update(schema.appointmentCoupons)
            .set({ discountValue: 4000 })
            .where(eq(schema.appointmentCoupons.id, coupon.id));
          await tx
            .update(schema.appointmentPromotions)
            .set({ discountValue: 3000 })
            .where(eq(schema.appointmentPromotions.id, promotionId));
        });
        editCommitted = true;
      }
      return result;
    }) as typeof originalQuery);
    const connection = vi.spyOn(db.$client, "connect");
    connection.mockImplementationOnce((async () => client) as typeof db.$client.connect);
    try {
      const prepared = await prepareAppointmentAttempt(
        input(coupon.code, alice),
        "/",
        randomUUID(),
        db,
      );
      expect(editCommitted).toBe(true);
      expect(readCommitted).toBe(true);
      expect(prepared.attempt).toBeTruthy();
      expect(
        await db.query.appointmentCouponUses.findMany({
          where: eq(schema.appointmentCouponUses.couponId, coupon.id),
        }),
      ).toEqual([]);
      reader.mockRestore();
      expect(await quoteAppointmentPrice(quoteRequest, db)).toMatchObject({
        version: 2,
        effectivePrice: 1000,
        promotion: null,
        coupon: { id: coupon.id, discount: { amount: 4000 } },
      });
      // A mixed read chooses B's 3000 promotion, which wins in neither revision:
      // A's winner is its 2000 promotion; B's winner is its 4000 coupon.
      expect(prepared.quote).toEqual(revisionA);
      expect(decodeAttempt(prepared.attempt!).quote).toEqual(revisionA);
    } finally {
      reader.mockRestore();
      connection.mockRestore();
      await db
        .update(schema.appointmentPromotions)
        .set({ isActive: false })
        .where(eq(schema.appointmentPromotions.id, promotionId));
    }
  });
  it("quotes service, coupon identity and applicability from the same revision", async () => {
    const coupon = await createCoupon("COHERENT_SCOPE", {
      discountKind: "fixed",
      discountValue: 1000,
      currency: "usd",
    });
    const promotionId = randomUUID();
    const replacementId = randomUUID();
    await db.insert(schema.appointmentPromotions).values({
      id: promotionId,
      organizationId: org,
      label: "Coherent scope",
      startsAt: new Date("2026-10-01Z"),
      endsAt: new Date("2026-11-01Z"),
      discountKind: "fixed",
      discountValue: 2000,
      currency: "usd",
    });
    await db.insert(schema.appointmentPromotionEventTypes).values({
      promotionId,
      organizationId: org,
      eventTypeId: event,
    });
    const request = {
      organizationId: org,
      eventTypeId: event,
      appointmentStartsAt: new Date(start),
      settlement: "cash" as const,
      couponCode: coupon.code,
      couponCustomerUserId: alice,
    };
    const revisionA = await quoteAppointmentPrice(request, db);
    expect(revisionA).toMatchObject({ basePrice: 5000, effectivePrice: 3000 });
    const originalQuery = db.$client.query;
    const reader = vi.spyOn(db.$client, "query");
    let editCommitted = false;
    // Pause the first real read. Replace the code's definition/applicability and
    // change service/promotion terms atomically before any subsequent read.
    reader.mockImplementationOnce((async (...args: Parameters<typeof originalQuery>) => {
      const result = await Reflect.apply(originalQuery, db.$client, args);
      await db.transaction(async (tx) => {
        await tx
          .update(schema.eventTypes)
          .set({ price: 8000 })
          .where(eq(schema.eventTypes.id, event));
        await tx
          .update(schema.appointmentPromotions)
          .set({ discountValue: 3000 })
          .where(eq(schema.appointmentPromotions.id, promotionId));
        await tx
          .update(schema.appointmentCoupons)
          .set({ code: "COHERENT_SCOPE_OLD" })
          .where(eq(schema.appointmentCoupons.id, coupon.id));
        await tx
          .delete(schema.appointmentCouponEventTypes)
          .where(eq(schema.appointmentCouponEventTypes.couponId, coupon.id));
        await tx.insert(schema.appointmentCoupons).values({
          id: replacementId,
          organizationId: org,
          code: coupon.code,
          startsAt: coupon.startsAt,
          endsAt: coupon.endsAt,
          validityTimezone: coupon.validityTimezone,
          discountKind: "fixed",
          discountValue: 4000,
          currency: "usd",
        });
        await tx.insert(schema.appointmentCouponEventTypes).values({
          couponId: replacementId,
          eventTypeId: event,
          organizationId: org,
        });
      });
      editCommitted = true;
      return result;
    }) as typeof originalQuery);
    try {
      expect(await quoteAppointmentPrice(request, db)).toEqual(revisionA);
      expect(editCommitted).toBe(true);
      reader.mockRestore();
      expect(await quoteAppointmentPrice(request, db)).toMatchObject({
        version: 2,
        basePrice: 8000,
        effectivePrice: 4000,
        amountToCollect: 4000,
        promotion: null,
        coupon: { id: replacementId, discount: { amount: 4000 } },
      });
    } finally {
      reader.mockRestore();
      await db.transaction(async (tx) => {
        await tx
          .update(schema.eventTypes)
          .set({ price: 5000 })
          .where(eq(schema.eventTypes.id, event));
        await tx
          .update(schema.appointmentPromotions)
          .set({ isActive: false })
          .where(eq(schema.appointmentPromotions.id, promotionId));
      });
    }
  });
  it("retains unknown-coupon and missing-service error precedence", async () => {
    const coupon = await createCoupon("KNOWN_COUPON");
    const request = {
      organizationId: org,
      eventTypeId: randomUUID(),
      appointmentStartsAt: new Date(start),
      settlement: "cash" as const,
      couponCustomerUserId: alice,
    };
    await expect(
      quoteAppointmentPrice({ ...request, couponCode: "UNKNOWN_COUPON" }, db),
    ).rejects.toMatchObject({ message: "Coupon code not recognized", status: 400 });
    await expect(
      quoteAppointmentPrice({ ...request, couponCode: coupon.code }, db),
    ).rejects.toMatchObject({ message: "Event type not found", status: 404 });
    await expect(quoteAppointmentPrice(request, db)).rejects.toMatchObject({
      message: "Event type not found",
      status: 404,
    });
  });
  it("enforces per-customer and combined limits without a mutable counter", async () => {
    const c = await createCoupon("PERSON50", { globalLimit: 2, perCustomerLimit: 1 });
    const result = await Promise.allSettled([
      prepareAppointmentAttempt(input(c.code, alice), "/", randomUUID(), db),
      prepareAppointmentAttempt(input(c.code, alice), "/", randomUUID(), db),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (await prepareAppointmentAttempt(input(c.code, bob), "/", randomUUID(), db)).attempt,
    ).toBeTruthy();
    await expect(
      prepareAppointmentAttempt(input(c.code, bob), "/", randomUUID(), db),
    ).rejects.toThrow(/no uses|maximum/);
  });
  it("retains accepted coupon terms through edit, reschedule and exactly-once cancellation", async () => {
    const c = await createCoupon("HISTORY50", { globalLimit: 1, perCustomerLimit: 1 });
    const request = input(c.code, alice);
    const id = randomUUID();
    const prepared = await prepareAppointmentAttempt(request, "/", id, db);
    const attempt = prepared.attempt!;
    const price = decodeAttempt(attempt).quote;
    await db
      .update(schema.appointmentCoupons)
      .set({
        code: "EDITED50",
        isActive: false,
        discountValue: 1000,
        startsAt: new Date("2026-09-01Z"),
        endsAt: new Date("2026-10-02Z"),
      })
      .where(eq(schema.appointmentCoupons.id, c.id));
    // Fulfillment honors the accepted reservation after edits/expiry; it never
    // consults the current definition to reconstruct the paid price.
    const booking = await bookingFor(price, (tx, bookingId) =>
      redeemReservedCouponUse(tx, attempt.id, bookingId, price, alice),
    );
    const initialSnapshot = await db.query.bookingPricingSnapshots.findFirst({
      where: eq(schema.bookingPricingSnapshots.bookingId, booking.id),
    });
    await expect(
      db.insert(schema.bookingPricingSnapshots).values({
        ...initialSnapshot!,
        id: randomUUID(),
        discountSource: null,
      }),
    ).rejects.toMatchObject({ constraint: "booking_pricing_coupon_check" });
    await db
      .update(schema.bookings)
      .set({ startsAt: new Date("2027-02-01Z") })
      .where(eq(schema.bookings.id, booking.id));
    await db
      .update(schema.bookings)
      .set({ startsAt: new Date("2027-03-01Z") })
      .where(eq(schema.bookings.id, booking.id));
    const snapshot = await db.query.bookingPricingSnapshots.findFirst({
      where: eq(schema.bookingPricingSnapshots.bookingId, booking.id),
    });
    expect(snapshot).toMatchObject({
      couponCode: "HISTORY50",
      couponDiscountValue: 5000,
      effectivePrice: 2500,
    });
    expect(
      (
        await db.query.appointmentCouponUses.findFirst({
          where: eq(schema.appointmentCouponUses.bookingId, booking.id),
        })
      )?.status,
    ).toBe("redeemed");
    await expect(
      db
        .update(schema.bookings)
        .set({ status: "cancelled" })
        .where(eq(schema.bookings.id, booking.id)),
    ).rejects.toThrow();
    await Promise.all(
      Array.from({ length: 3 }, () => decideBookingCancellation(booking.uid, undefined, db)),
    );
    await decideBookingCancellation(booking.uid, undefined, db);
    expect(
      await db.query.appointmentCouponRestorations.findMany({
        where: eq(schema.appointmentCouponRestorations.bookingId, booking.id),
      }),
    ).toHaveLength(1);
    expect(
      (
        await db.query.appointmentCouponUses.findFirst({
          where: eq(schema.appointmentCouponUses.bookingId, booking.id),
        })
      )?.status,
    ).toBe("restored");
    expect(await couponCapacityMessage(price, alice, db)).toBeNull();
    expect(
      (
        await db.query.appointmentCoupons.findFirst({
          where: eq(schema.appointmentCoupons.id, c.id),
        })
      )?.isActive,
    ).toBe(false);
  });
  it("records unlimited and zero-cash coupon uses without Stripe", async () => {
    const c = await createCoupon("FREE100", { discountValue: 10000 });
    const price = await quoteAppointmentPrice(
      {
        organizationId: org,
        eventTypeId: event,
        appointmentStartsAt: new Date(start),
        settlement: "cash",
        couponCode: c.code,
        couponCustomerUserId: alice,
      },
      db,
    );
    expect(price.amountToCollect).toBe(0);
    const request = input(c.code, alice);
    const identity = appointmentRequestIdentity(request, "/", randomUUID());
    const booking = await bookingFor(price, (tx, bookingId) =>
      reserveCouponUse(tx, price, alice, identity.key, identity.fingerprint, {
        bookingId,
      }),
    );
    const first = (await db.query.appointmentCouponUses.findFirst({
      where: eq(schema.appointmentCouponUses.bookingId, booking.id),
    }))!;
    const again = await db.transaction((tx) =>
      reserveCouponUse(tx, price, alice, identity.key, identity.fingerprint, {
        bookingId: booking.id,
      }),
    );
    expect(again.id).toBe(first.id);
    await expect(bookingFor(price, async () => {})).rejects.toThrow();
    await expect(
      db.delete(schema.appointmentCouponUses).where(eq(schema.appointmentCouponUses.id, first.id)),
    ).rejects.toThrow();
    await db
      .update(schema.eventTypes)
      .set({ recurringCount: 2 })
      .where(eq(schema.eventTypes.id, event));
    await expect(
      prepareAppointmentAttempt(input(c.code, alice), "/", randomUUID(), db),
    ).rejects.toThrow(/recurring/);
  });
});
