import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createDatabase, eq, schema } from "@dayotter/db";
import type Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  db: null as ReturnType<typeof createDatabase> | null,
  finalize: vi.fn(),
  read: vi.fn(),
  pi: vi.fn(),
  create: vi.fn(),
  routeMode: "direct" as "direct" | "connect",
  fee: 0,
}));
vi.mock("@dayotter/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dayotter/db")>()),
  getDb: () => mock.db,
}));
vi.mock("../server/env", () => ({ env: { APP_URL: "https://example.test" } }));
vi.mock("../payments/connect", () => ({
  checkoutRouteForOrganization: async (organizationId: string) => ({
    mode: mock.routeMode,
    organizationId,
    environment: "test",
    chargeAccountId: "acct_original",
    credentialContext: "primary",
    ...(mock.routeMode === "connect"
      ? { destinationAccountId: "acct_destination", applicationFeeAmount: mock.fee }
      : {}),
  }),
}));
vi.mock("../payments/stripe", () => ({
  createCheckoutSession: mock.create,
  retrieveSession: mock.read,
  retrievePaymentIntent: mock.pi,
  sessionForPaymentIntent: vi.fn(),
  stripeConfigured: false,
}));
vi.mock("../booking/availability", () => ({
  SLOT_REVALIDATION_WINDOW_MS: 60000,
  isAllowedDuration: () => true,
  eventConstraints: () => ({}),
  hostSlots: async (_h: unknown, _s: unknown, _c: unknown, start: Date) => [
    { start: new Date(start.getTime() + 60000), end: new Date(start.getTime() + 1860000) },
  ],
  eventTypeHostSlots: async (_e: unknown, start: Date) => ({
    hostIds: [],
    perHost: [
      [{ start: new Date(start.getTime() + 60000), end: new Date(start.getTime() + 1860000) }],
    ],
  }),
  combineHostSlots: (slots: unknown[][]) => slots.flat(),
}));
vi.mock("../booking/finalize-booking", () => ({ finalizeConfirmedBooking: mock.finalize }));
vi.mock("../calendar/host-calendar", () => ({
  deleteBookingFromCalendar: vi.fn(),
  updateBookingCalendarEvent: vi.fn(),
}));
vi.mock("../booking/reminders", () => ({
  clearBookingReminders: vi.fn(),
  scheduleBookingReminders: vi.fn(),
  reminderOffsetsForHost: async () => [],
  scheduleWorkflowMessages: vi.fn(),
  hostWantsOverflowNotice: async () => false,
  hostWantsScribe: async () => false,
  scheduleOverflowCheck: vi.fn(),
  scheduleScribe: vi.fn(),
}));
vi.mock("../booking/lifecycle", () => ({ fanOutBookingLifecycle: vi.fn() }));
vi.mock("../booking/travel", () => ({ reserveTravelBlocks: vi.fn() }));
vi.mock("../automation/apply-rules", () => ({
  reserveRuleBlocks: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@dayotter/emails", () => ({
  sendEmail: vi.fn(),
  bookingCancellation: vi.fn(),
  bookingRescheduled: vi.fn(),
  bookingRequested: vi.fn(),
  newBookingRequest: vi.fn(),
}));
import { cancelBookingWithResult } from "../booking/cancel-booking";
import { type CreateBookingInput, createBooking } from "../booking/create-booking";
import { persistBookingPricingSnapshot, quoteAppointmentPrice } from "../booking/pricing";
import { rescheduleBooking } from "../booking/reschedule-booking";
import { prepareAppointmentAttempt } from "../payments/attempts";
import {
  creditBalance,
  grantCreditsInTransaction,
  grantPackageToCustomer,
  recoverCreditFinalizations,
  redeemBookingCredit,
  requirePackageOwner,
  restoreBookingCredit,
} from "./credits";
import { packageIntent, packageSession } from "./purchase-fixtures";
import {
  bindPackageSession,
  grantObservedPackage,
  observePackagePayment,
  packageCheckout,
  preparePackagePurchase,
  receivePackageEvent,
  reconcilePackagePurchase,
  recoverPackagePurchases,
} from "./purchases";
const url = process.env.PACKAGES_TEST_DATABASE_URL;
const oldEncryptionKey = process.env.ENCRYPTION_KEY;
describe.skipIf(!url)("package integrity PostgreSQL", () => {
  const name = `dayotter_packages_test_${randomUUID().replaceAll("-", "")}`;
  let admin: ReturnType<typeof createDatabase>;
  let db: ReturnType<typeof createDatabase>;
  let created = false;
  const org = randomUUID();
  const host = randomUUID();
  const event = randomUUID();
  const legacy = randomUUID();
  let sequence = 0;
  beforeAll(async () => {
    const u = new URL(url!);
    if (u.hostname !== "127.0.0.1" || u.pathname !== "/dayotter_packages_test")
      throw new Error("Use disposable loopback dayotter_packages_test");
    process.env.ENCRYPTION_KEY = "ab".repeat(32);
    admin = createDatabase(u.toString());
    await admin.$client.query(`CREATE DATABASE "${name}"`);
    created = true;
    u.pathname = `/${name}`;
    db = createDatabase(u.toString());
    mock.db = db;
    const directory = new URL("../../../../packages/db/drizzle/", import.meta.url);
    const journal = JSON.parse(
      await readFile(new URL("meta/_journal.json", directory), "utf8"),
    ) as { entries: { tag: string }[] };
    for (const { tag } of journal.entries) {
      if (tag === "0067_package_integrity") {
        await db
          .insert(schema.organizations)
          .values({ id: org, name: "Package test", slug: randomUUID() });
        await db
          .insert(schema.users)
          .values({ id: host, email: `${host}@example.test`, emailVerified: true });
        await db.insert(schema.eventTypes).values({
          id: event,
          organizationId: org,
          ownerId: host,
          title: "Sessions",
          slug: "sessions",
          price: 5000,
          currency: "usd",
          durationMinutes: 30,
          location: "in_person",
          locationDetail: "Test",
        });
        // Slice 4 schema: insert through SQL because new columns do not exist yet.
        await db.$client.query(
          "INSERT INTO package_credits(id,organization_id,event_type_id,client_email,total_credits,used_credits) VALUES($1,$2,$3,$4,5,2)",
          [legacy, org, event, `${host}@example.test`],
        );
      }
      const client = await db.$client.connect();
      try {
        await client.query("BEGIN");
        for (const statement of (await readFile(new URL(`${tag}.sql`, directory), "utf8")).split(
          "--> statement-breakpoint",
        ))
          if (statement.trim()) {
            try {
              await client.query(statement);
            } catch (err) {
              throw new Error(
                `Migration ${tag} statement ${statement.slice(0, 100).trim()}: ${String(err)}`,
                { cause: err },
              );
            }
          }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }
  }, 60000);
  afterAll(async () => {
    if (db) await db.$client.end();
    if (created) await admin.$client.query(`DROP DATABASE "${name}"`);
    if (admin) await admin.$client.end();
    if (oldEncryptionKey === undefined) Reflect.deleteProperty(process.env, "ENCRYPTION_KEY");
    else process.env.ENCRYPTION_KEY = oldEncryptionKey;
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    mock.routeMode = "direct";
    mock.fee = 0;
    mock.finalize.mockResolvedValue(undefined);
    await db
      .update(schema.eventTypes)
      .set({ recurringCount: 1, price: 5000, currency: "usd" })
      .where(eq(schema.eventTypes.id, event));
  });
  async function owned(count = 1) {
    const id = randomUUID();
    const email = `${id}@example.test`;
    await db.insert(schema.users).values({ id, email, emailVerified: true });
    const [pkg] = await db
      .insert(schema.sessionPackages)
      .values({
        organizationId: org,
        eventTypeId: event,
        name: "Bundle",
        sessionCount: count,
        priceAmount: 5000,
        currency: "usd",
      })
      .returning();
    const creditId = await grantPackageToCustomer(host, pkg!.id, email, randomUUID(), db);
    const input: CreateBookingInput = {
      eventTypeId: event,
      start: new Date(Date.UTC(2035, 0, 1 + sequence++, 12)).toISOString(),
      attendee: { name: "Client", email, timezone: "UTC" },
      redeemCredit: true,
      creditOwnerUserId: id,
      creditRequestId: randomUUID(),
    };
    return { id, email, pkg: pkg!, creditId, input };
  }
  async function balance(creditId: string) {
    return (await db.query.packageCredits.findFirst({
      where: eq(schema.packageCredits.id, creditId),
    }))!;
  }
  async function purchased() {
    const owner = await owned();
    const p = await preparePackagePurchase(owner.pkg.id, owner.id, randomUUID(), db);
    const session = packageSession(p);
    const pi = packageIntent(p, session);
    mock.read.mockResolvedValue(session);
    mock.pi.mockResolvedValue(pi);
    return { ...owner, p, session, pi };
  }
  it("migration preserves legacy opening balances without claiming ownership", async () => {
    const c = await balance(legacy);
    expect(c).toMatchObject({
      totalCredits: 5,
      usedCredits: 2,
      openingTotalCredits: 5,
      openingUsedCredits: 2,
      integrityVersion: 0,
      ownerUserId: null,
    });
    expect(await creditBalance(event, host, db)).toBe(0);
    await expect(
      db.insert(schema.packageCredits).values({
        organizationId: org,
        eventTypeId: event,
        clientEmail: "legacy@example.test",
        totalCredits: 10,
      }),
    ).rejects.toThrow();
    await expect(
      db
        .update(schema.packageCredits)
        .set({ ownerUserId: host, integrityVersion: 1 })
        .where(eq(schema.packageCredits.id, legacy)),
    ).rejects.toThrow();
  });
  it("verified owners redeem with durable booking and quote provenance", async () => {
    const a = await owned();
    const result = await createBooking(a.input);
    const b = await db.query.bookings.findFirst({ where: eq(schema.bookings.uid, result.uid) });
    const m = await db.query.packageCreditMutations.findFirst({
      where: eq(schema.packageCreditMutations.bookingId, b!.id),
    });
    expect(m).toMatchObject({
      ownerUserId: a.id,
      creditId: a.creditId,
      quantity: 1,
      kind: "redemption",
      finalizationState: "complete",
    });
    expect(b!.paymentStatus).toBe("paid");
    expect((await balance(a.creditId)).usedCredits).toBe(1);
    expect(
      await db.query.bookingPricingSnapshots.findFirst({
        where: eq(schema.bookingPricingSnapshots.bookingId, b!.id),
      }),
    ).toMatchObject({ settlement: "package_credit", promotionId: null, amountToCollect: 0 });
  });
  it("knowing the owner's email cannot authorize spending or reveal package details", async () => {
    const a = await owned();
    const other = await owned();
    await expect(createBooking({ ...a.input, creditOwnerUserId: other.id })).rejects.toMatchObject({
      status: 403,
      message: "Sign in with your verified account to use prepaid sessions",
    });
    await expect(requirePackageOwner(undefined, a.email, db)).rejects.toMatchObject({
      status: 403,
    });
    expect((await balance(a.creditId)).usedCredits).toBe(0);
  });
  it("concurrent requests spending the final credit allow exactly one booking", async () => {
    const a = await owned();
    const result = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        createBooking({
          ...a.input,
          start: new Date(Date.UTC(2035, 0, 1 + sequence++, 12)).toISOString(),
          creditRequestId: randomUUID(),
        }),
      ),
    );
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await balance(a.creditId)).usedCredits).toBe(1);
  });
  it("concurrent retries and response-loss retries converge on the original booking", async () => {
    const a = await owned();
    const results = await Promise.all(Array.from({ length: 10 }, () => createBooking(a.input)));
    expect(new Set(results.map((r) => r.uid)).size).toBe(1);
    const again = await createBooking(a.input);
    expect(again.uid).toBe(results[0]!.uid);
    expect((await balance(a.creditId)).usedCredits).toBe(1);
    await expect(createBooking({ ...a.input, notes: "changed" })).rejects.toMatchObject({
      status: 409,
    });
  });
  it("rollback loses neither a credit nor its booking/snapshot", async () => {
    const a = await owned();
    const bid = randomUUID();
    await expect(
      db.transaction(async (tx) => {
        const [b] = await tx
          .insert(schema.bookings)
          .values({
            id: bid,
            uid: randomUUID(),
            organizationId: org,
            eventTypeId: event,
            hostId: host,
            title: "Test",
            startsAt: new Date(a.input.start),
            endsAt: new Date(new Date(a.input.start).getTime() + 1800000),
            timezone: "UTC",
            status: "confirmed",
          })
          .returning();
        const q = await quoteAppointmentPrice(
          {
            organizationId: org,
            eventTypeId: event,
            appointmentStartsAt: new Date(a.input.start),
            settlement: "package_credit",
          },
          tx,
        );
        await persistBookingPricingSnapshot(bid, q, tx);
        await redeemBookingCredit(tx, a.input, b!);
        throw new Error("crash");
      }),
    ).rejects.toThrow("crash");
    expect((await balance(a.creditId)).usedCredits).toBe(0);
    expect(
      await db.query.bookings.findFirst({ where: eq(schema.bookings.id, bid) }),
    ).toBeUndefined();
  });
  it("duplicate/concurrent cancellation restores exactly the original redemption once", async () => {
    const a = await owned();
    const { uid } = await createBooking(a.input);
    const result = await Promise.all(
      Array.from({ length: 10 }, () => cancelBookingWithResult(uid)),
    );
    expect(result.every((r) => r?.refund === "refunded")).toBe(true);
    const b = await db.query.bookings.findFirst({ where: eq(schema.bookings.uid, uid) });
    const rows = await db.query.packageCreditMutations.findMany({
      where: eq(schema.packageCreditMutations.bookingId, b!.id),
    });
    expect(rows).toHaveLength(2);
    const redemption = rows.find((r) => r.kind === "redemption")!;
    const restoration = rows.find((r) => r.kind === "restoration")!;
    expect(restoration).toMatchObject({
      reversesId: redemption.id,
      creditId: redemption.creditId,
      quantity: redemption.quantity,
      ownerUserId: a.id,
    });
    expect((await balance(a.creditId)).usedCredits).toBe(0);
    expect(b!.paymentStatus).toBe("refunded");
    expect((await cancelBookingWithResult(uid))!.refund).toBe("refunded");
  });
  it("a cancellation decision without restoration cannot commit", async () => {
    const a = await owned();
    const { uid } = await createBooking(a.input);
    await expect(
      db.update(schema.bookings).set({ status: "cancelled" }).where(eq(schema.bookings.uid, uid)),
    ).rejects.toThrow();
    expect((await balance(a.creditId)).usedCredits).toBe(1);
  });
  it("restoration uses historical quantity after definition changes", async () => {
    const a = await owned(3);
    const { uid } = await createBooking(a.input);
    await db
      .update(schema.sessionPackages)
      .set({ sessionCount: 99, priceAmount: 1 })
      .where(eq(schema.sessionPackages.id, a.pkg.id));
    await cancelBookingWithResult(uid);
    expect(await balance(a.creditId)).toMatchObject({ totalCredits: 3, usedCredits: 0 });
  });
  it("same-booking rescheduling preserves the existing redemption", async () => {
    const a = await owned();
    const { uid } = await createBooking(a.input);
    const original = await db.query.bookings.findFirst({ where: eq(schema.bookings.uid, uid) });
    const quote = await db.query.bookingPricingSnapshots.findFirst({
      where: eq(schema.bookingPricingSnapshots.bookingId, original!.id),
    });
    await db.update(schema.eventTypes).set({ price: 9900 }).where(eq(schema.eventTypes.id, event));
    const newStart = new Date(Date.UTC(2038, 0, 1 + sequence++, 12)).toISOString();
    await rescheduleBooking(uid, newStart);
    await rescheduleBooking(uid, newStart);
    expect(
      await db.query.bookingPricingSnapshots.findFirst({
        where: eq(schema.bookingPricingSnapshots.bookingId, original!.id),
      }),
    ).toEqual(quote);
    expect((await balance(a.creditId)).usedCredits).toBe(1);
    expect(
      await db.query.packageCreditMutations.findMany({
        where: eq(schema.packageCreditMutations.creditId, a.creditId),
      }),
    ).toHaveLength(2);
  });
  it("unsupported package recurring creation fails before spending", async () => {
    const a = await owned();
    await db
      .update(schema.eventTypes)
      .set({ recurringCount: 3 })
      .where(eq(schema.eventTypes.id, event));
    await expect(createBooking(a.input)).rejects.toMatchObject({ status: 409 });
    expect((await balance(a.creditId)).usedCredits).toBe(0);
  });
  it("unrelated entitlement and direct counter/provenance mutations fail closed", async () => {
    const a = await owned();
    const other = await owned();
    await expect(
      db
        .update(schema.packageCredits)
        .set({ totalCredits: 99 })
        .where(eq(schema.packageCredits.id, a.creditId)),
    ).rejects.toThrow();
    const [grant] = await db.query.packageCreditMutations.findMany({
      where: eq(schema.packageCreditMutations.creditId, a.creditId),
    });
    await expect(
      db
        .update(schema.packageCreditMutations)
        .set({ quantity: 2 })
        .where(eq(schema.packageCreditMutations.id, grant!.id)),
    ).rejects.toThrow();
    await expect(
      db
        .delete(schema.packageCreditMutations)
        .where(eq(schema.packageCreditMutations.id, grant!.id)),
    ).rejects.toThrow();
    await expect(
      db
        .insert(schema.packageCreditMutations)
        .values({ ...grant!, id: randomUUID(), operationKey: randomUUID(), ownerUserId: other.id }),
    ).rejects.toThrow();
  });
  it("legacy cancellation does not guess a restore from email", async () => {
    const uid = randomUUID();
    await db.insert(schema.bookings).values({
      organizationId: org,
      eventTypeId: event,
      hostId: host,
      title: "Legacy",
      startsAt: new Date(Date.UTC(2040, 0, 1 + sequence++)),
      endsAt: new Date(Date.UTC(2040, 0, 1 + sequence++, 1)),
      timezone: "UTC",
      uid,
      status: "confirmed",
      paymentStatus: "paid",
    });
    expect((await cancelBookingWithResult(uid))!.refund).toBe("legacy_unknown");
    expect((await balance(legacy)).usedCredits).toBe(2);
  });
  it("manual grants are idempotent and bind caller input despite later package edits", async () => {
    const a = await owned();
    const op = randomUUID();
    const c = await grantPackageToCustomer(host, a.pkg.id, a.email, op, db);
    await db
      .update(schema.sessionPackages)
      .set({ sessionCount: 99 })
      .where(eq(schema.sessionPackages.id, a.pkg.id));
    expect(await grantPackageToCustomer(host, a.pkg.id, a.email, op, db)).toBe(c);
    expect((await balance(c)).totalCredits).toBe(1);
    await expect(
      grantPackageToCustomer(host, a.pkg.id, "another@example.test", op, db),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("duplicate and concurrent paid fulfillment grant once", async () => {
    const a = await purchased();
    await observePackagePayment(a.p, a.session, a.pi, db);
    await Promise.all(Array.from({ length: 12 }, () => grantObservedPackage(a.p.id, db)));
    const p = await db.query.packagePurchases.findFirst({
      where: eq(schema.packagePurchases.id, a.p.id),
    });
    expect(p!.state).toBe("granted");
    expect((await balance(p!.creditId!)).totalCredits).toBe(a.p.terms.totalCredits);
    expect(
      await db.query.packageCreditMutations.findMany({
        where: eq(schema.packageCreditMutations.purchaseId, a.p.id),
      }),
    ).toHaveLength(1);
    expect(
      await receivePackageEvent(
        {
          type: "checkout.session.completed",
          livemode: false,
          data: { object: a.session },
        } as unknown as Stripe.Event,
        db,
      ),
    ).toBe("granted");
  });
  it("crash after payment observation is recoverable without another Stripe read", async () => {
    const a = await purchased();
    await observePackagePayment(a.p, a.session, a.pi, db);
    mock.read.mockRejectedValue(new Error("offline"));
    await recoverPackagePurchases(100, db);
    const p = await db.query.packagePurchases.findFirst({
      where: eq(schema.packagePurchases.id, a.p.id),
    });
    expect(p!.state).toBe("granted");
    expect(mock.read).not.toHaveBeenCalled();
  });
  it("unpaid completion grants nothing and later async success grants once", async () => {
    const a = await purchased();
    const unpaid = { ...a.session, payment_status: "unpaid" as const };
    mock.read.mockResolvedValue(unpaid);
    expect(await reconcilePackagePurchase(a.p.id, a.session.id, db)).toBe("waiting_payment");
    expect(await grantObservedPackage(a.p.id, db)).toBe("waiting_payment");
    mock.read.mockResolvedValue(a.session);
    expect(
      await receivePackageEvent(
        {
          type: "checkout.session.async_payment_succeeded",
          livemode: false,
          data: { object: a.session },
        } as unknown as Stripe.Event,
        db,
      ),
    ).toBe("granted");
  });
  it("price/count/owner/routing changes cannot redefine a historical paid grant", async () => {
    const a = await purchased();
    await db
      .update(schema.sessionPackages)
      .set({ priceAmount: 99, sessionCount: 50 })
      .where(eq(schema.sessionPackages.id, a.pkg.id));
    await db
      .update(schema.users)
      .set({ email: `new-${a.email}` })
      .where(eq(schema.users.id, a.id));
    mock.routeMode = "connect";
    mock.fee = 99;
    expect(await reconcilePackagePurchase(a.p.id, a.session.id, db)).toBe("granted");
    const p = await db.query.packagePurchases.findFirst({
      where: eq(schema.packagePurchases.id, a.p.id),
    });
    expect(await balance(p!.creditId!)).toMatchObject({ ownerUserId: a.id, totalCredits: 1 });
    expect(mock.pi).toHaveBeenCalledWith(a.pi.id, a.p.terms.route);
  });
  it("timeouts/response loss replay the original Stripe creation identity", async () => {
    const a = await purchased();
    mock.create
      .mockRejectedValueOnce(new Error("accepted but timeout"))
      .mockResolvedValue({ session: a.session, url: a.session.url });
    await expect(packageCheckout(a.p, db)).rejects.toThrow();
    const again = await preparePackagePurchase(
      a.pkg.id,
      a.id,
      a.p.requestKey.split(":").at(-1)!,
      db,
    );
    expect(again.id).toBe(a.p.id);
    await packageCheckout(again, db);
    expect(mock.create.mock.calls[0]![0]).toEqual(mock.create.mock.calls[1]![0]);
    expect(mock.create.mock.calls[0]![0].idempotencyKey).toBe(`package-checkout:${a.p.id}:v1`);
  });
  it("Stripe contradictions preserve a visible review obligation", async () => {
    const a = await purchased();
    mock.pi.mockResolvedValue({ ...a.pi, currency: "eur" });
    expect(await reconcilePackagePurchase(a.p.id, a.session.id, db)).toBe("requires_review");
    expect(
      (await db.query.packagePurchases.findFirst({
        where: eq(schema.packagePurchases.id, a.p.id),
      }))!.creditId,
    ).toBeNull();
  });
  it("write-once purchase terms and IDs cannot be replaced", async () => {
    const a = await purchased();
    await bindPackageSession(a.p, a.session, db);
    await expect(
      db
        .update(schema.packagePurchases)
        .set({ checkoutSessionId: "cs_other" })
        .where(eq(schema.packagePurchases.id, a.p.id)),
    ).rejects.toThrow();
    await expect(
      db
        .update(schema.packagePurchases)
        .set({ terms: { ...a.p.terms, totalCredits: 100 } })
        .where(eq(schema.packagePurchases.id, a.p.id)),
    ).rejects.toThrow();
    await expect(
      db.delete(schema.packagePurchases).where(eq(schema.packagePurchases.id, a.p.id)),
    ).rejects.toThrow();
  });
  it("external finalization failure retains settlement and durable review, with no replay", async () => {
    const a = await owned();
    mock.finalize.mockRejectedValueOnce(new Error("calendar down"));
    const { uid } = await createBooking(a.input);
    expect((await createBooking(a.input)).uid).toBe(uid);
    expect(mock.finalize).toHaveBeenCalledTimes(1);
    const b = await db.query.bookings.findFirst({ where: eq(schema.bookings.uid, uid) });
    expect(
      await db.query.packageCreditMutations.findFirst({
        where: eq(schema.packageCreditMutations.bookingId, b!.id),
      }),
    ).toMatchObject({ finalizationState: "requires_review" });
    expect((await balance(a.creditId)).usedCredits).toBe(1);
  });
  it("cancellation during external finalization restores once and cannot be resurrected by completion", async () => {
    const a = await owned();
    let release!: () => void;
    let entered!: (id: string) => void;
    const reached = new Promise<string>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    mock.finalize.mockImplementationOnce(async ({ booking }) => {
      entered(booking.uid);
      await barrier;
    });
    const creating = createBooking(a.input);
    const uid = await reached;
    try {
      expect((await createBooking(a.input)).uid).toBe(uid);
      expect((await cancelBookingWithResult(uid))!.refund).toBe("refunded");
    } finally {
      release();
    }
    expect((await creating).uid).toBe(uid);
    const b = await db.query.bookings.findFirst({ where: eq(schema.bookings.uid, uid) });
    expect(b).toMatchObject({ status: "cancelled", paymentStatus: "refunded" });
    expect((await balance(a.creditId)).usedCredits).toBe(0);
    const rows = await db.query.packageCreditMutations.findMany({
      where: eq(schema.packageCreditMutations.bookingId, b!.id),
    });
    expect(rows.find((m) => m.kind === "redemption")!.finalizationState).toBe("requires_review");
    expect(rows.filter((m) => m.kind === "restoration")).toHaveLength(1);
    expect(mock.finalize).toHaveBeenCalledTimes(1);
  });
  it("interrupted external delivery is discoverable without replaying or spending again", async () => {
    const a = await owned();
    // Capture a real committed redemption before finalization claims it.
    let release!: () => void;
    let entered!: (id: string) => void;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    const reached = new Promise<string>((r) => {
      entered = r;
    });
    mock.finalize.mockImplementationOnce(async ({ booking }) => {
      entered(booking.uid);
      await barrier;
    });
    const creating = createBooking(a.input);
    const uid = await reached;
    const b = await db.query.bookings.findFirst({ where: eq(schema.bookings.uid, uid) });
    // The review query remains PostgreSQL based; a fresh in-flight job is not prematurely reviewed.
    await recoverCreditFinalizations(100, db);
    expect(
      (await db.query.packageCreditMutations.findFirst({
        where: eq(schema.packageCreditMutations.bookingId, b!.id),
      }))!.finalizationState,
    ).toBe("running");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 16 * 60 * 1000);
      await recoverCreditFinalizations(100, db);
      expect(
        (await db.query.packageCreditMutations.findFirst({
          where: eq(schema.packageCreditMutations.bookingId, b!.id),
        }))!.finalizationState,
      ).toBe("requires_review");
    } finally {
      vi.useRealTimers();
      release();
    }
    await creating;
    expect((await createBooking(a.input)).uid).toBe(uid);
    expect(mock.finalize).toHaveBeenCalledTimes(1);
  });
  it("a purchase grant rollback cannot consume the durable paid obligation", async () => {
    const a = await purchased();
    await observePackagePayment(a.p, a.session, a.pi, db);
    await expect(
      db.transaction(async (tx) => {
        await grantCreditsInTransaction(
          {
            organizationId: org,
            eventTypeId: event,
            ownerUserId: a.id,
            clientEmail: a.email,
            totalCredits: a.p.terms.totalCredits,
            packageId: a.pkg.id,
            operationKey: `package-grant:${a.p.id}`,
            purchaseId: a.p.id,
            stripePaymentIntentId: a.pi.id,
          },
          tx,
        );
        throw new Error("crash before binding");
      }),
    ).rejects.toThrow("crash before binding");
    expect(
      await db.query.packageCreditMutations.findMany({
        where: eq(schema.packageCreditMutations.purchaseId, a.p.id),
      }),
    ).toHaveLength(0);
    expect(await grantObservedPackage(a.p.id, db)).toBe("granted");
  });
  it("transient Stripe retrieval remains recoverable and duplicate success reuses the grant", async () => {
    const a = await purchased();
    mock.read.mockRejectedValueOnce(new Error("temporary Stripe outage"));
    expect(await reconcilePackagePurchase(a.p.id, a.session.id, db)).toBe("retry");
    expect(
      (await db.query.packagePurchases.findFirst({
        where: eq(schema.packagePurchases.id, a.p.id),
      }))!.state,
    ).toBe("prepared");
    expect(await reconcilePackagePurchase(a.p.id, a.session.id, db)).toBe("granted");
    expect(await reconcilePackagePurchase(a.p.id, a.session.id, db)).toBe("granted");
  });
  it("malformed and unknown webhook relationships cannot grant or mutate another purchase", async () => {
    const a = await purchased();
    for (const purchaseId of ["not-a-uuid", randomUUID()]) {
      await expect(
        receivePackageEvent(
          {
            type: "checkout.session.completed",
            livemode: false,
            data: {
              object: {
                ...a.session,
                id: "cs_unknown",
                client_reference_id: null,
                metadata: { kind: "package", purchaseId },
              },
            },
          } as unknown as Stripe.Event,
          db,
        ),
      ).rejects.toThrow("manual reconciliation");
    }
    expect(
      (await db.query.packagePurchases.findFirst({
        where: eq(schema.packagePurchases.id, a.p.id),
      }))!.state,
    ).toBe("prepared");
  });
  it("Intent webhook retrieval failures return a sanitized retry and cannot grant prematurely", async () => {
    const a = await purchased();
    await bindPackageSession(a.p, a.session, db);
    mock.read.mockRejectedValueOnce(new Error("raw SDK error containing sensitive configuration"));
    expect(
      await receivePackageEvent(
        {
          type: "payment_intent.succeeded",
          livemode: false,
          data: { object: a.pi },
        } as unknown as Stripe.Event,
        db,
      ),
    ).toBe("retry");
    expect(
      (await db.query.packagePurchases.findFirst({
        where: eq(schema.packagePurchases.id, a.p.id),
      }))!.creditId,
    ).toBeNull();
    expect(
      await receivePackageEvent(
        {
          type: "payment_intent.succeeded",
          livemode: false,
          data: { object: a.pi },
        } as unknown as Stripe.Event,
        db,
      ),
    ).toBe("granted");
  });
  it("wrong grant/restore relationship, duplicate restore, and incomplete evidence are rejected by PostgreSQL", async () => {
    const a = await owned();
    const { uid } = await createBooking(a.input);
    await cancelBookingWithResult(uid);
    const b = await db.query.bookings.findFirst({ where: eq(schema.bookings.uid, uid) });
    const rows = await db.query.packageCreditMutations.findMany({
      where: eq(schema.packageCreditMutations.bookingId, b!.id),
    });
    const restore = rows.find((m) => m.kind === "restoration")!;
    await expect(
      db.insert(schema.packageCreditMutations).values({ ...restore, id: randomUUID() }),
    ).rejects.toThrow();
    await expect(
      db.insert(schema.packageCreditMutations).values({
        ...restore,
        id: randomUUID(),
        reversesId: randomUUID(),
        operationKey: randomUUID(),
      }),
    ).rejects.toThrow();
    const purchase = await purchased();
    const facts = {
      version: 1,
      sessionId: purchase.session.id,
      paymentIntentId: purchase.pi.id,
      amount: 5000,
      currency: "usd",
      environment: "test",
      chargeAccountId: "acct_original",
      credentialContext: "primary",
      paymentMode: "direct",
      destinationAccountId: null,
      applicationFeeAmount: 0,
    };
    await expect(
      db
        .update(schema.packagePurchases)
        .set({
          state: "payment_succeeded",
          checkoutSessionId: purchase.session.id,
          paymentIntentId: purchase.pi.id,
          successFacts: facts as typeof purchase.p.successFacts,
        })
        .where(eq(schema.packagePurchases.id, purchase.p.id)),
    ).rejects.toThrow();
  });
  it("expired checkout grants nothing and cannot be reused as a fresh financial operation", async () => {
    const a = await purchased();
    mock.read.mockResolvedValue({ ...a.session, status: "expired", payment_status: "unpaid" });
    expect(await reconcilePackagePurchase(a.p.id, a.session.id, db)).toBe("expired");
    const same = await preparePackagePurchase(
      a.pkg.id,
      a.id,
      a.p.requestKey.split(":").at(-1)!,
      db,
    );
    expect(same.id).toBe(a.p.id);
    expect((await packageCheckout(same, db)).state).toBe("expired");
    expect(mock.create).not.toHaveBeenCalled();
  });

  it("unknown Stripe creation past the bounded replay window enters review without a new Session", async () => {
    const a = await purchased();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(a.p.creationDeadline.getTime() + 1000);
      expect((await packageCheckout(a.p, db)).state).toBe("requires_review");
      expect(mock.create).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("cash checkout and credit booking raced under one request cannot both claim financial settlement", async () => {
    for (let n = 0; n < 5; n++) {
      const a = await owned();
      const { creditOwnerUserId, creditRequestId, redeemCredit, ...cashInput } = a.input;
      const results = await Promise.allSettled([
        prepareAppointmentAttempt(cashInput, "/", creditRequestId, db),
        createBooking(a.input),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const claim = await db.query.bookingSettlementClaims.findFirst({
        where: eq(schema.bookingSettlementClaims.operationKey, `appointment:${creditRequestId}`),
      });
      expect(claim).toBeDefined();
      const attempt = await db.query.paymentAttempts.findFirst({
        where: eq(schema.paymentAttempts.requestKey, claim!.operationKey),
      });
      const redemption = await db.query.packageCreditMutations.findFirst({
        where: eq(schema.packageCreditMutations.operationKey, claim!.operationKey),
      });
      expect(Boolean(attempt)).not.toBe(Boolean(redemption));
      expect((await balance(a.creditId)).usedCredits).toBe(redemption ? 1 : 0);
    }
  });
  it("a proven credit booking cannot be retried as an independent cash attempt", async () => {
    const a = await owned();
    await createBooking(a.input);
    const { creditOwnerUserId, creditRequestId, redeemCredit, ...cashInput } = a.input;
    await expect(
      prepareAppointmentAttempt(cashInput, "/", creditRequestId, db),
    ).rejects.toMatchObject({ status: 409 });
    expect((await balance(a.creditId)).usedCredits).toBe(1);
  });
  it("competing last-credit bookings demonstrably wait on PostgreSQL, not process locks", async () => {
    const a = await owned();
    let release!: () => void;
    let ready!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const locked = new Promise<void>((r) => {
      ready = r;
    });
    const holding = db.transaction(async (tx) => {
      await tx
        .select()
        .from(schema.packageCredits)
        .where(eq(schema.packageCredits.id, a.creditId))
        .for("update");
      ready();
      await held;
    });
    await locked;
    const candidates = Array.from({ length: 2 }, () => ({
      ...a.input,
      start: new Date(Date.UTC(2035, 0, 1 + sequence++, 12)).toISOString(),
      creditRequestId: randomUUID(),
    }));
    const finishing = Promise.allSettled(candidates.map(createBooking));
    try {
      let waiters = 0;
      for (let n = 0; n < 100 && waiters < 2; n++) {
        const { rows } = await db.$client.query(
          "SELECT count(*)::int as n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%package_credits%'",
        );
        waiters = rows[0].n;
        if (waiters < 2) await new Promise((r) => setTimeout(r, 10));
      }
      expect(waiters).toBe(2);
    } finally {
      release();
      await holding;
    }
    expect((await finishing).filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await balance(a.creditId)).usedCredits).toBe(1);
  });
  it("a crash during cancellation/restoration rolls both back and retry restores the obligation", async () => {
    const a = await owned();
    const { uid } = await createBooking(a.input);
    const b = (await db.query.bookings.findFirst({ where: eq(schema.bookings.uid, uid) }))!;
    await expect(
      db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(schema.bookings)
          .where(eq(schema.bookings.id, b.id))
          .for("update");
        await tx
          .update(schema.bookings)
          .set({ status: "cancelled" })
          .where(eq(schema.bookings.id, b.id));
        await restoreBookingCredit(tx, current!);
        throw new Error("crash before cancellation commit");
      }),
    ).rejects.toThrow("crash before cancellation commit");
    expect((await balance(a.creditId)).usedCredits).toBe(1);
    expect(
      (await db.query.bookings.findFirst({ where: eq(schema.bookings.id, b.id) }))!.status,
    ).toBe("confirmed");
    expect((await cancelBookingWithResult(uid))!.refund).toBe("refunded");
    expect((await balance(a.creditId)).usedCredits).toBe(0);
  });
  it("a not-yet-settled Intent preserves Session recovery identity without a grant or terminal review", async () => {
    const a = await purchased();
    mock.pi.mockResolvedValueOnce({
      ...a.pi,
      status: "processing",
      amount_received: 0,
      latest_charge: null,
    });
    expect(await reconcilePackagePurchase(a.p.id, a.session.id, db)).toBe("retry");
    expect(
      await db.query.packagePurchases.findFirst({ where: eq(schema.packagePurchases.id, a.p.id) }),
    ).toMatchObject({
      checkoutSessionId: a.session.id,
      paymentIntentId: a.pi.id,
      state: "open",
      creditId: null,
      reviewCode: null,
    });
    expect(await reconcilePackagePurchase(a.p.id, undefined, db)).toBe("granted");
  });
  it("database guards prevent hiding paid obligations behind unrelated state or fake grant binding", async () => {
    const a = await purchased();
    await observePackagePayment(a.p, a.session, a.pi, db);
    await expect(
      db
        .update(schema.packagePurchases)
        .set({ state: "open" })
        .where(eq(schema.packagePurchases.id, a.p.id)),
    ).rejects.toThrow();
    await expect(
      db
        .update(schema.packagePurchases)
        .set({ creditId: a.creditId })
        .where(eq(schema.packagePurchases.id, a.p.id)),
    ).rejects.toThrow();
    await expect(
      db
        .update(schema.packagePurchases)
        .set({ state: "granted", creditId: a.creditId })
        .where(eq(schema.packagePurchases.id, a.p.id)),
    ).rejects.toThrow();
    expect(await grantObservedPackage(a.p.id, db)).toBe("granted");
  });
  it("historical owner/package and terminal finalization markers cannot be erased", async () => {
    const a = await owned();
    const { uid } = await createBooking(a.input);
    const b = (await db.query.bookings.findFirst({ where: eq(schema.bookings.uid, uid) }))!;
    const m = (await db.query.packageCreditMutations.findFirst({
      where: eq(schema.packageCreditMutations.bookingId, b.id),
    }))!;
    await expect(
      db
        .update(schema.packageCreditMutations)
        .set({ finalizationState: null })
        .where(eq(schema.packageCreditMutations.id, m.id)),
    ).rejects.toThrow();
    await expect(
      db.delete(schema.sessionPackages).where(eq(schema.sessionPackages.id, a.pkg.id)),
    ).rejects.toThrow();
    await expect(db.delete(schema.users).where(eq(schema.users.id, a.id))).rejects.toThrow();
    expect((await balance(a.creditId)).usedCredits).toBe(1);
  });
  it("equivalent UUID casing cannot create an independent package-purchase intent", async () => {
    const a = await purchased();
    const same = await preparePackagePurchase(
      a.pkg.id.toUpperCase(),
      a.id.toUpperCase(),
      a.p.requestKey.split(":").at(-1)!.toUpperCase(),
      db,
    );
    expect(same.id).toBe(a.p.id);
  });
  it("purchase configuration waiting on a concurrent administration edit captures one committed revision", async () => {
    const a = await owned();
    let release!: () => void;
    let ready!: () => void;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    const locked = new Promise<void>((r) => {
      ready = r;
    });
    const editing = db.transaction(async (tx) => {
      await tx
        .update(schema.sessionPackages)
        .set({ sessionCount: 7, priceAmount: 9400, currency: "eur" })
        .where(eq(schema.sessionPackages.id, a.pkg.id));
      await tx
        .update(schema.eventTypes)
        .set({ currency: "eur" })
        .where(eq(schema.eventTypes.id, event));
      ready();
      await barrier;
    });
    await locked;
    const preparing = preparePackagePurchase(a.pkg.id, a.id, randomUUID(), db);
    try {
      let waiting = false;
      for (let n = 0; n < 100 && !waiting; n++) {
        const { rows } = await db.$client.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%session_packages%'",
        );
        waiting = rows.length > 0;
        if (!waiting) await new Promise((r) => setTimeout(r, 10));
      }
      expect(waiting).toBe(true);
    } finally {
      release();
      await editing;
    }
    expect((await preparing).terms).toMatchObject({
      amount: 9400,
      totalCredits: 7,
      currency: "eur",
      ownerUserId: a.id,
    });
  });
  it("concurrent staff-grant retries reuse one immutable grant even under configuration snapshots", async () => {
    const a = await owned();
    const op = randomUUID();
    const ids = await Promise.all(
      Array.from({ length: 8 }, () => grantPackageToCustomer(host, a.pkg.id, a.email, op, db)),
    );
    expect(new Set(ids).size).toBe(1);
    expect((await balance(ids[0]!)).totalCredits).toBe(1);
  });
});
