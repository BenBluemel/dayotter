import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { classifyResourceError, createDatabase, eq, schema } from "@dayotter/db";
import type Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { grantPackageToCustomer } from "../packages/credits";
import {
  fixturePaidSession,
  fixturePaymentIntent,
  fixtureSession,
} from "../payments/attempt-fixtures";
import { bindAttemptSession, prepareAppointmentAttempt } from "../payments/attempts";
import { listPaidReview, resolvePaidReview } from "../payments/paid-review";
import { processAppointmentEvent, receiveAppointmentEvent } from "../payments/payment-events";
import { finalizePaymentBooking } from "../payments/payment-finalization";
import { fulfillObservedPayment, observePaymentSuccess } from "../payments/payment-work";
import { recoverAppointmentPayments } from "../payments/recovery";
import { fixtureRefundCharge, fixtureRefundEvidence } from "../payments/refund-fixtures";
import { decideBookingCancellation, executeRefundOperation } from "../payments/refunds";
import { ResourceInvariantError } from "./booking-logic";
import { approveBooking } from "./confirm-booking";
import { createBooking } from "./create-booking";
import { createHostBooking } from "./host-booking";
import { createInternalTeamBooking } from "./internal-team-booking";
import { createOtterEvent } from "./otter-create";
import { admitBookingReschedule } from "./reschedule-admission";
const mock = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof createDatabase>,
  pi: vi.fn(),
  session: vi.fn(),
  refund: vi.fn(),
  refundRead: vi.fn(),
  mode: "direct" as "direct" | "connect",
  fee: 0,
  finalize: vi.fn(),
  apiUser: "",
}));
vi.mock("@dayotter/db", async (original) => ({
  ...(await original<typeof import("@dayotter/db")>()),
  getDb: () => mock.db,
}));
vi.mock("../server/env", () => ({ env: { APP_URL: "https://example.test" } }));
vi.mock("../payments/connect", () => ({
  checkoutRouteForOrganization: async (organizationId: string) => ({
    mode: mock.mode,
    ...(mock.mode === "connect"
      ? { destinationAccountId: "acct_host", applicationFeeAmount: mock.fee }
      : {}),
    organizationId,
    environment: "test",
    chargeAccountId: "acct_merchant",
    credentialContext: "primary",
  }),
}));
vi.mock("./availability", () => ({
  SLOT_REVALIDATION_WINDOW_MS: 60000,
  isAllowedDuration: () => true,
  eventTypeHostSlots: async (
    e: typeof schema.eventTypes.$inferSelect,
    from: Date,
    _to: Date,
    duration: number,
  ) => ({
    hostIds: [e.ownerId],
    perHost: [
      [
        {
          start: new Date(from.getTime() + 60000),
          end: new Date(from.getTime() + 60000 + duration * 60000),
        },
      ],
    ],
  }),
  combineHostSlots: (p: unknown[][]) => p.flat(),
}));
vi.mock("./finalize-booking", () => ({ finalizeConfirmedBooking: mock.finalize }));
vi.mock("../calendar/host-calendar", () => ({ writeBookingToCalendar: async () => null }));
vi.mock("./reminders", () => ({
  scheduleBookingReminders: vi.fn(),
  reminderOffsetsForHost: async () => [],
  hostWantsOverflowNotice: async () => false,
  hostWantsScribe: async () => false,
  scheduleOverflowCheck: vi.fn(),
  scheduleScribe: vi.fn(),
}));
vi.mock("../payments/stripe", () => ({
  retrievePaymentIntent: mock.pi,
  retrieveSession: mock.session,
  listOperationRefunds: async () => [],
  retrieveRefundCharge: async (op: typeof schema.refundOperations.$inferSelect) =>
    fixtureRefundCharge(op),
  createOperationRefund: mock.refund,
  retrieveOperationRefund: mock.refundRead,
}));
vi.mock("@/lib/server/api-key", () => ({
  withApiKey:
    (handler: (caller: { userId: string }, request: Request) => Promise<Response>) =>
    (request: Request) =>
      handler({ userId: mock.apiUser }, request),
}));
import { POST as apiCreate } from "../../app/api/v1/bookings/route";
const url = process.env.RESOURCES_TEST_DATABASE_URL;
describe.skipIf(!url)("Resource booking acceptance PostgreSQL", () => {
  const databaseName = `dayotter_resources_test_${randomUUID().replaceAll("-", "")}`;
  let admin: ReturnType<typeof createDatabase>;
  let db: ReturnType<typeof createDatabase>;
  let created = false;
  const org = randomUUID();
  const client = randomUUID();
  const oldKey = process.env.ENCRYPTION_KEY;
  const start = "2030-01-01T10:00:00.000Z";
  const email = "client@example.test";
  beforeAll(async () => {
    const at = new URL(url!);
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(at.hostname) ||
      at.pathname !== "/dayotter_resources_test"
    )
      throw new Error("Use the guarded loopback Resource test database");
    process.env.ENCRYPTION_KEY = "ab".repeat(32);
    admin = createDatabase(at.toString());
    await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    at.pathname = `/${databaseName}`;
    db = createDatabase(at.toString());
    mock.db = db;
    const directory = new URL("../../../../packages/db/drizzle/", import.meta.url);
    const journal = JSON.parse(
      await readFile(new URL("meta/_journal.json", directory), "utf8"),
    ) as { entries: { tag: string }[] };
    const connection = await db.$client.connect();
    try {
      for (const { tag } of journal.entries) {
        await connection.query("BEGIN");
        for (const statement of (await readFile(new URL(`${tag}.sql`, directory), "utf8")).split(
          "--> statement-breakpoint",
        ))
          if (statement.trim()) await connection.query(statement);
        await connection.query("COMMIT");
      }
    } finally {
      await connection.query("ROLLBACK");
      connection.release();
    }
    await db
      .insert(schema.organizations)
      .values({ id: org, name: "Resource tests", slug: randomUUID() });
    await db
      .insert(schema.users)
      .values({ id: client, email, emailVerified: true, timezone: "UTC" });
    mock.refund.mockImplementation(async () => ({ id: `re_${randomUUID().replaceAll("-", "")}` }));
    mock.refundRead.mockImplementation(async (op, id) => {
      const evidence = fixtureRefundEvidence(op);
      evidence.refund.id = id;
      if (
        evidence.refund.transfer_reversal &&
        typeof evidence.refund.transfer_reversal !== "string"
      )
        evidence.refund.transfer_reversal.source_refund = id;
      return evidence;
    });
  }, 60000);
  afterAll(async () => {
    await db?.$client.end();
    if (created) await admin.$client.query(`DROP DATABASE "${databaseName}"`);
    await admin?.$client.end();
    // Restore absence exactly; assigning undefined leaves the string "undefined".
    // biome-ignore lint/performance/noDelete: process.env requires deletion to unset a variable
    if (oldKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = oldKey;
  });
  async function resource(capacity = 1) {
    const [r] = await db
      .insert(schema.resources)
      .values({ organizationId: org, name: "Light", capacity })
      .returning();
    return r!.id;
  }
  async function service(
    resources: { id: string; quantity?: number }[] = [],
    price = 0,
    managed = true,
    requiresHost = true,
  ) {
    const host = randomUUID();
    const schedule = randomUUID();
    await db
      .insert(schema.users)
      .values({ id: host, email: `${host}@example.test`, timezone: "UTC" });
    await db
      .insert(schema.memberships)
      .values({ organizationId: org, userId: host, role: "owner" });
    await db
      .insert(schema.schedules)
      .values({ id: schedule, userId: host, timezone: "UTC", isDefault: true });
    const [e] = await db
      .insert(schema.eventTypes)
      .values({
        organizationId: org,
        ownerId: host,
        scheduleId: schedule,
        slug: randomUUID(),
        title: "Treatment",
        price,
        currency: "usd",
        durationMinutes: 30,
      })
      .returning();
    for (const r of resources)
      await db.insert(schema.eventTypeResourceRequirements).values({
        organizationId: org,
        eventTypeId: e!.id,
        resourceId: r.id,
        quantity: r.quantity ?? 1,
      });
    if (managed && resources.length)
      await db
        .update(schema.eventTypes)
        .set({ resourceAdmissionEpoch: 1 })
        .where(eq(schema.eventTypes.id, e!.id));
    if (!requiresHost)
      await db
        .update(schema.eventTypes)
        .set({ requiresHost: false })
        .where(eq(schema.eventTypes.id, e!.id));
    return (await db.query.eventTypes.findFirst({ where: eq(schema.eventTypes.id, e!.id) }))!;
  }
  const intent = (e: typeof schema.eventTypes.$inferSelect, when = start) => ({
    eventTypeId: e.id,
    start: when,
    attendee: { name: "Client", email, timezone: "UTC" },
    bookingRequestId: randomUUID(),
  });
  async function book(e: typeof schema.eventTypes.$inferSelect, when = start) {
    const result = await createBooking(intent(e, when));
    return (await db.query.bookings.findFirst({ where: eq(schema.bookings.uid, result.uid) }))!;
  }
  async function counts(eid: string) {
    return (
      await db.$client.query(
        "select (select count(*)::int from bookings where event_type_id=$1) b,(select count(*)::int from booking_resource_claims where event_type_id=$1)c",
        [eid],
      )
    ).rows[0];
  }
  async function occupied(r: string) {
    const e = await service([{ id: r }]);
    return book(e);
  }
  async function coupon(e: typeof schema.eventTypes.$inferSelect, percent = 10000) {
    const [c] = await db
      .insert(schema.appointmentCoupons)
      .values({
        organizationId: org,
        code: `C${randomUUID().replaceAll("-", "").toUpperCase()}`,
        discountKind: "percentage",
        discountValue: percent,
        startsAt: new Date("2029-01-01Z"),
        endsAt: new Date("2031-01-01Z"),
        validityTimezone: "UTC",
        globalLimit: 1,
        perCustomerLimit: 1,
      })
      .returning();
    await db
      .insert(schema.appointmentCouponEventTypes)
      .values({ organizationId: org, couponId: c!.id, eventTypeId: e.id });
    return c!;
  }
  async function paid(e: typeof schema.eventTypes.$inferSelect, code?: string) {
    const input = {
      ...intent(e),
      ...(code ? { couponCode: code, couponCustomerUserId: client } : {}),
    };
    const prepared = await prepareAppointmentAttempt(input, "/", randomUUID(), db);
    const session = {
      ...fixtureSession(prepared.attempt!),
      id: `cs_${prepared.attempt!.id.replaceAll("-", "")}`,
    };
    const bound = await bindAttemptSession(prepared.attempt!, session, db);
    const complete = fixturePaidSession(bound);
    mock.pi.mockResolvedValue(fixturePaymentIntent(bound, complete));
    await observePaymentSuccess(bound, complete, db);
    return (await db.query.paymentAttempts.findFirst({
      where: eq(schema.paymentAttempts.id, bound.id),
    }))!;
  }
  it("unmanaged services retain the original booking without an empty managed plan", async () => {
    const e = await service();
    const b = await book(e);
    expect(b.schedulingPlan).toBeNull();
    expect(await counts(e.id)).toEqual({ b: 1, c: 0 });
  });
  it("ordinary capped creation still waits on the existing reschedule host/week mutex", async () => {
    const e = await service();
    await db
      .update(schema.eventTypes)
      .set({ dailyBookingLimit: 1 })
      .where(eq(schema.eventTypes.id, e.id));
    const connection = await db.$client.connect();
    await connection.query("BEGIN");
    await connection.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `${e.ownerId}:2029-12-31`,
    ]);
    const completion = book(e).then(
      (booking) => ({ booking, error: null }),
      (error) => ({ booking: null, error }),
    );
    try {
      let blocked = false;
      for (let n = 0; n < 200 && !blocked; n++) {
        const result = await db.$client.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%'",
        );
        blocked = result.rows.length > 0;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(blocked).toBe(true);
      expect(await counts(e.id)).toEqual({ b: 0, c: 0 });
      await connection.query("COMMIT");
      expect((await completion).error).toBeNull();
      await expect(book(e, "2030-01-01T12:00:00.000Z")).rejects.toMatchObject({ status: 409 });
      expect(await counts(e.id)).toEqual({ b: 1, c: 0 });
    } finally {
      await connection.query("ROLLBACK");
      connection.release();
      await completion;
    }
  });
  it("ordinary public admission rechecks person buffers against committed managed bookings", async () => {
    const managed = await service([{ id: await resource() }]);
    await book(managed);
    const ordinary = await service();
    await db
      .update(schema.eventTypes)
      .set({ ownerId: managed.ownerId, scheduleId: managed.scheduleId, bufferBeforeMinutes: 10 })
      .where(eq(schema.eventTypes.id, ordinary.id));
    await expect(book(ordinary, "2030-01-01T10:35:00.000Z")).rejects.toMatchObject({ status: 409 });
    expect(await counts(ordinary.id)).toEqual({ b: 0, c: 0 });
  });
  it.each([true, false])(
    "pending managed acceptance owns claims and approval retains them (requiresHost=%s)",
    async (requiresHost) => {
      const e = await service([{ id: await resource() }], 0, true, requiresHost);
      await db
        .update(schema.eventTypes)
        .set({ requiresConfirmation: true })
        .where(eq(schema.eventTypes.id, e.id));
      const booking = await book(e);
      expect(booking.status).toBe("pending");
      const claims = await db.query.bookingResourceClaims.findMany({
        where: eq(schema.bookingResourceClaims.bookingId, booking.id),
      });
      expect(claims).toHaveLength(1);
      expect(await approveBooking(booking.uid, e.ownerId!)).toBe("ok");
      expect(await approveBooking(booking.uid, e.ownerId!)).toBe("not_pending");
      expect(
        await db.query.bookingResourceClaims.findMany({
          where: eq(schema.bookingResourceClaims.bookingId, booking.id),
        }),
      ).toEqual(claims);
      expect(await counts(e.id)).toEqual({ b: 1, c: 1 });
    },
  );
  it("managed free acceptance creates immutable plan, weighted claims and settlement atomically", async () => {
    const r = await resource(2);
    const e = await service([{ id: r, quantity: 2 }]);
    const b = await book(e);
    expect(b.schedulingPlan?.resources).toEqual([{ id: r, name: "Light", quantity: 2 }]);
    expect(b.allocationRevision).toBe(1);
    expect(await counts(e.id)).toEqual({ b: 1, c: 1 });
    const claims = await db.query.bookingResourceClaims.findMany({
      where: eq(schema.bookingResourceClaims.bookingId, b.id),
    });
    expect(claims[0]?.quantity).toBe(2);
  });
  it.each(["occupied", "disabled"])("%s capacity creates no booking or claims", async (reason) => {
    const r = await resource();
    if (reason === "occupied") await occupied(r);
    const e = await service([{ id: r }]);
    if (reason === "disabled")
      await db.update(schema.resources).set({ enabled: false }).where(eq(schema.resources.id, r));
    await expect(book(e)).rejects.toMatchObject({ status: 409 });
    expect(await counts(e.id)).toEqual({ b: 0, c: 0 });
  });
  it("multi-resource failure rolls back all allocation and booking writes", async () => {
    const x = await resource();
    const y = await resource();
    await occupied(y);
    const e = await service([{ id: x }, { id: y }]);
    await expect(book(e)).rejects.toMatchObject({ status: 409 });
    expect(await counts(e.id)).toEqual({ b: 0, c: 0 });
    expect(
      (
        await db.query.bookingResourceClaims.findMany({
          where: eq(schema.bookingResourceClaims.resourceId, x),
        })
      ).length,
    ).toBe(0);
  });
  it.each([1, 2])(
    "concurrent acceptance preserves pooled capacity %i and host indexes",
    async (capacity) => {
      const r = await resource(capacity);
      const events = await Promise.all(
        Array.from({ length: capacity + 1 }, () => service([{ id: r }])),
      );
      const results = await Promise.allSettled(events.map((e) => book(e)));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(capacity);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    },
  );
  it("accepted plans survive requirement removal and resource rename", async () => {
    const r = await resource();
    const e = await service([{ id: r }]);
    const b = await book(e);
    await db
      .delete(schema.eventTypeResourceRequirements)
      .where(eq(schema.eventTypeResourceRequirements.eventTypeId, e.id));
    await db.update(schema.resources).set({ name: "Renamed" }).where(eq(schema.resources.id, r));
    expect(
      (await db.query.bookings.findFirst({ where: eq(schema.bookings.id, b.id) }))?.schedulingPlan,
    ).toEqual(b.schedulingPlan);
  });
  it.each([true, false])(
    "100% coupon acceptance and replay use one coupon and one allocation without Stripe (requiresHost=%s)",
    async (requiresHost) => {
      const e = await service([{ id: await resource() }], 5000, true, requiresHost);
      const c = await coupon(e);
      const input = { ...intent(e), couponCode: c.code, couponCustomerUserId: client };
      const a = await createBooking(input);
      const b = await createBooking(input);
      expect(a.uid).toBe(b.uid);
      expect(await counts(e.id)).toEqual({ b: 1, c: 1 });
      expect(
        (
          await db.query.appointmentCouponUses.findMany({
            where: eq(schema.appointmentCouponUses.couponId, c.id),
          })
        ).map((u) => u.status),
      ).toEqual(["redeemed"]);
    },
  );
  it.each([true, false])(
    "resource conflict rolls back zero-cash coupon use and settlement (requiresHost=%s)",
    async (requiresHost) => {
      const r = await resource();
      await occupied(r);
      const e = await service([{ id: r }], 5000, true, requiresHost);
      const c = await coupon(e);
      await expect(
        createBooking({ ...intent(e), couponCode: c.code, couponCustomerUserId: client }),
      ).rejects.toMatchObject({ status: 409 });
      expect(await counts(e.id)).toEqual({ b: 0, c: 0 });
      expect(
        await db.query.appointmentCouponUses.findMany({
          where: eq(schema.appointmentCouponUses.couponId, c.id),
        }),
      ).toHaveLength(0);
    },
  );
  async function packageInput(e: typeof schema.eventTypes.$inferSelect) {
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
    const id = await grantPackageToCustomer(e.ownerId!, p!.id, email, randomUUID(), db);
    return {
      credit: id,
      input: {
        ...intent(e),
        redeemCredit: true,
        creditOwnerUserId: client,
        creditRequestId: randomUUID(),
      },
    };
  }
  it.each([true, false])(
    "package booking and replay consume one credit and allocate once (requiresHost=%s)",
    async (requiresHost) => {
      const e = await service([{ id: await resource() }], 5000, true, requiresHost);
      const p = await packageInput(e);
      const a = await createBooking(p.input);
      const b = await createBooking(p.input);
      expect(a.uid).toBe(b.uid);
      expect(
        (await db.query.packageCredits.findFirst({ where: eq(schema.packageCredits.id, p.credit) }))
          ?.usedCredits,
      ).toBe(1);
      expect(await counts(e.id)).toEqual({ b: 1, c: 1 });
    },
  );
  it.each([true, false])(
    "resource conflict consumes no package credit (requiresHost=%s)",
    async (requiresHost) => {
      const r = await resource();
      await occupied(r);
      const e = await service([{ id: r }], 5000, true, requiresHost);
      const p = await packageInput(e);
      await expect(createBooking(p.input)).rejects.toMatchObject({ status: 409 });
      expect(
        (await db.query.packageCredits.findFirst({ where: eq(schema.packageCredits.id, p.credit) }))
          ?.usedCredits,
      ).toBe(0);
      expect(await counts(e.id)).toEqual({ b: 0, c: 0 });
    },
  );
  it.each([true, false])(
    "checkout freezes terms without claims; fulfillment uses accepted resources after edits (requiresHost=%s)",
    async (requiresHost) => {
      const old = await resource();
      const replacement = await resource();
      const e = await service([{ id: old }], 5000, true, requiresHost);
      const a = await paid(e);
      expect(a.schedulingPlan?.resources[0]?.id).toBe(old);
      expect(await counts(e.id)).toEqual({ b: 0, c: 0 });
      await db
        .update(schema.eventTypeResourceRequirements)
        .set({ resourceId: replacement })
        .where(eq(schema.eventTypeResourceRequirements.eventTypeId, e.id));
      await db
        .update(schema.eventTypes)
        .set({ requiresHost: !requiresHost })
        .where(eq(schema.eventTypes.id, e.id));
      const result = await fulfillObservedPayment(a.id, db);
      const frozenBooking = await db.query.bookings.findFirst({
        where: eq(schema.bookings.uid, result.uid!),
      });
      expect(frozenBooking?.requiresHost).toBe(requiresHost);
      expect(result.state).toBe("fulfilled");
      expect(await fulfillObservedPayment(a.id, db)).toMatchObject({
        uid: result.uid,
        state: "fulfilled",
      });
      const b = await db.query.bookings.findFirst({ where: eq(schema.bookings.uid, result.uid!) });
      expect(b?.schedulingPlan).toEqual(a.schedulingPlan);
      expect(await counts(e.id)).toEqual({ b: 1, c: 1 });
    },
  );
  it.each([true, false])(
    "payment success survives lost-slot review; automatic replay does not allocate (requiresHost=%s)",
    async (requiresHost) => {
      const r = await resource();
      const e = await service([{ id: r }], 5000, true, requiresHost);
      const a = await paid(e);
      await occupied(r);
      expect(await fulfillObservedPayment(a.id, db)).toMatchObject({
        state: "requires_review",
        uid: null,
      });
      expect(await fulfillObservedPayment(a.id, db)).toMatchObject({
        state: "requires_review",
        uid: null,
      });
      const owed = await db.query.paymentAttempts.findFirst({
        where: eq(schema.paymentAttempts.id, a.id),
      });
      expect(owed?.successFacts).toEqual(a.successFacts);
      expect(owed?.reviewCode).toBe("booking_obligation_requires_review");
      expect(await counts(e.id)).toEqual({ b: 0, c: 0 });
    },
  );
  async function review(couponCode = false) {
    const r = await resource();
    const e = await service([{ id: r }], 5000);
    const c = couponCode ? await coupon(e, 5000) : null;
    const a = await paid(e, c?.code);
    const blocking = await occupied(r);
    await fulfillObservedPayment(a.id, db);
    return { r, e, a, c, blocking };
  }
  it("authorized original-time retry resolves once and prevents a later refund", async () => {
    const { e, a, blocking } = await review();
    await db.transaction(async (tx) => {
      await tx
        .update(schema.bookings)
        .set({ status: "cancelled" })
        .where(eq(schema.bookings.id, blocking.id));
      await tx.execute(
        (await import("@dayotter/db")).sql`select resource_release_booking(${blocking.id}::uuid)`,
      );
    });
    const cmd = {
      id: randomUUID(),
      attemptId: a.id,
      actorUserId: e.ownerId!,
      method: "retry" as const,
      evidence: "Contacted customer; consent to original appointment",
    };
    expect(await resolvePaidReview(cmd, db)).toMatchObject({ state: "booked" });
    expect(await resolvePaidReview(cmd, db)).toMatchObject({ state: "booked" });
    expect(await counts(e.id)).toEqual({ b: 1, c: 1 });
    await expect(
      resolvePaidReview({ ...cmd, id: randomUUID(), method: "refund" }, db),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("unbooked refund uses saved route, releases coupon once and cannot create a booking", async () => {
    const { e, a, c } = await review(true);
    const cmd = {
      id: randomUUID(),
      attemptId: a.id,
      actorUserId: e.ownerId!,
      method: "refund" as const,
      evidence: "Contacted customer; requested full original payment refund",
    };
    expect(
      (
        await db.query.appointmentCouponUses.findFirst({
          where: eq(schema.appointmentCouponUses.couponId, c!.id),
        })
      )?.status,
    ).toBe("reserved");
    expect(await resolvePaidReview(cmd, db)).toMatchObject({ state: "refunded" });
    expect(await resolvePaidReview(cmd, db)).toMatchObject({ state: "refunded" });
    const op = await db.query.refundOperations.findFirst({
      where: eq(schema.refundOperations.attemptId, a.id),
    });
    expect(op).toMatchObject({
      bookingId: null,
      purpose: "unbooked_obligation",
      state: "succeeded",
      chargeAccountId: a.chargeAccountId,
    });
    expect(mock.refund.mock.calls.filter(([o]) => o.attemptId === a.id)).toHaveLength(1);
    expect(
      (
        await db.query.appointmentCouponUses.findFirst({
          where: eq(schema.appointmentCouponUses.couponId, c!.id),
        })
      )?.status,
    ).toBe("released");
    expect(await fulfillObservedPayment(a.id, db)).toMatchObject({
      state: "requires_review",
      uid: null,
    });
    expect(await counts(e.id)).toEqual({ b: 0, c: 0 });
    expect((await listPaidReview(org, e.ownerId!, db)).some((o) => o.id === a.id)).toBe(false);
  });
  it("unauthorized operator cannot list or resolve paid obligations", async () => {
    const { a } = await review();
    await expect(listPaidReview(org, client, db)).rejects.toMatchObject({ status: 403 });
    await expect(
      resolvePaidReview(
        {
          id: randomUUID(),
          attemptId: a.id,
          actorUserId: client,
          method: "refund",
          evidence: "Unauthorized request",
        },
        db,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("staff writer and AI/SMS convergence allocate once with stable replay", async () => {
    const e = await service([{ id: await resource() }]);
    const input = {
      userId: e.ownerId!,
      title: "Staff treatment",
      start: new Date(start),
      end: new Date(new Date(start).getTime() + 1800000),
      timezone: "UTC",
      eventTypeSlug: e.slug,
      requestId: randomUUID(),
    };
    const a = await createHostBooking(input);
    const b = await createHostBooking(input);
    expect(a?.uid).toBe(b?.uid);
    expect(await counts(e.id)).toEqual({ b: 1, c: 1 });
  });
  it("staff resource conflict cannot bypass capacity", async () => {
    const r = await resource();
    await occupied(r);
    const e = await service([{ id: r }]);
    await expect(
      createHostBooking({
        userId: e.ownerId!,
        title: "Treatment",
        start: new Date(start),
        end: new Date(new Date(start).getTime() + 1800000),
        timezone: "UTC",
        eventTypeSlug: e.slug,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await counts(e.id)).toEqual({ b: 0, c: 0 });
  });
  it("staff recurrence and focus holds fail before occurrence one", async () => {
    const e = await service([{ id: await resource() }]);
    for (const options of [
      { recurrenceFreq: "daily" as const, recurrenceCount: 3 },
      { kind: "focus" as const },
      { kind: "reminder" as const },
    ])
      await expect(
        createOtterEvent({
          userId: e.ownerId!,
          title: "Series",
          start: new Date(start),
          durationMinutes: 30,
          timezone: "UTC",
          eventTypeSlug: e.slug,
          ...options,
        }),
      ).rejects.toMatchObject({ status: 409 });
    expect(await counts(e.id)).toEqual({ b: 0, c: 0 });
  });
  it("managed configuration rejects recurrence and raw writers without proven plans", async () => {
    const e = await service([{ id: await resource() }]);
    await expect(
      db.update(schema.eventTypes).set({ recurringCount: 3 }).where(eq(schema.eventTypes.id, e.id)),
    ).rejects.toThrow();
    try {
      await db.insert(schema.bookings).values({
        organizationId: org,
        eventTypeId: e.id,
        hostId: e.ownerId!,
        title: "Forged",
        uid: randomUUID(),
        startsAt: new Date(start),
        endsAt: new Date(new Date(start).getTime() + 1800000),
        timezone: "UTC",
      });
      throw new Error("admitted");
    } catch (error) {
      expect(classifyResourceError(error)).toMatchObject({
        category: "invariant",
        identity: "resource_plan_completeness_violation",
      });
    }
    expect(await counts(e.id)).toEqual({ b: 0, c: 0 });
  });
  it("API derives resources, ignores forged empty/cross-org allocation and replays the operation", async () => {
    const r = await resource();
    const e = await service([{ id: r }]);
    mock.apiUser = e.ownerId!;
    const payload = {
      ...intent(e),
      checkoutRequestId: randomUUID(),
      requiresHost: false,
      schedulingPlan: { resources: [] },
      resourceIds: [randomUUID()],
    };
    const request = () =>
      new Request("https://example.test/api/v1/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    const response = await apiCreate(request(), undefined);
    expect(response.status).toBe(201);
    const result = await response.json();
    const again = await apiCreate(request(), undefined);
    expect(again.status).toBe(201);
    expect((await again.json()).uid).toBe(result.uid);
    const b = await db.query.bookings.findFirst({ where: eq(schema.bookings.uid, result.uid) });
    expect(b?.requiresHost).toBe(true);
    expect(b?.schedulingPlan?.resources).toEqual([{ id: r, quantity: 1, name: "Light" }]);
    expect(await counts(e.id)).toEqual({ b: 1, c: 1 });
  });
  it("API resource conflict is 409 and no booking commits", async () => {
    const r = await resource();
    await occupied(r);
    const e = await service([{ id: r }]);
    mock.apiUser = e.ownerId!;
    const response = await apiCreate(
      new Request("https://example.test/api/v1/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(intent(e)),
      }),
      undefined,
    );
    expect(response.status).toBe(409);
    expect(await counts(e.id)).toEqual({ b: 0, c: 0 });
  });
  it("opposite requirement order remains atomic through actual creation", async () => {
    const x = await resource(2);
    const y = await resource(2);
    const a = await service([{ id: x }, { id: y }]);
    const b = await service([{ id: y }, { id: x }]);
    const results = await Promise.allSettled([book(a), book(b)]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await counts(a.id)).toEqual({ b: 1, c: 2 });
    expect(await counts(b.id)).toEqual({ b: 1, c: 2 });
  });
  it("simultaneous same-host create still admits only one occupied interval", async () => {
    const e = await service([{ id: await resource(2) }]);
    const results = await Promise.allSettled([book(e), book(e)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await counts(e.id)).toEqual({ b: 1, c: 1 });
  });
  it.each([true, false])(
    "paid coupon fulfillment and response-loss replay redeem and allocate once (requiresHost=%s)",
    async (requiresHost) => {
      const e = await service([{ id: await resource() }], 5000, true, requiresHost);
      const c = await coupon(e, 5000);
      await db
        .update(schema.eventTypes)
        .set({ depositAmount: 1000 })
        .where(eq(schema.eventTypes.id, e.id));
      const a = await paid(e, c.code);
      expect(a.amount).toBe(1000);
      const result = await fulfillObservedPayment(a.id, db);
      expect(result.state).toBe("fulfilled");
      expect(await fulfillObservedPayment(a.id, db)).toMatchObject({
        uid: result.uid,
        state: "fulfilled",
      });
      expect(
        (
          await db.query.appointmentCouponUses.findFirst({
            where: eq(schema.appointmentCouponUses.couponId, c.id),
          })
        )?.status,
      ).toBe("redeemed");
      expect(await counts(e.id)).toEqual({ b: 1, c: 1 });
    },
  );
  it.each(["direct", "webhook"])(
    "0071 malformed claim under competing demand becomes technical review through %s",
    async (surface) => {
      const r = await resource(2);
      const e = await service([{ id: r }], 5000);
      const a = await paid(e);
      await occupied(r);
      await db.$client.query(
        "CREATE FUNCTION resource_test_malformed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.quantity:=NEW.quantity+1; RETURN NEW; END $$",
      );
      await db.$client.query(
        `CREATE TRIGGER a_resource_test_malformed BEFORE INSERT ON booking_resource_claims FOR EACH ROW WHEN (NEW.event_type_id='${e.id}'::uuid) EXECUTE FUNCTION resource_test_malformed()`,
      );
      try {
        if (surface === "webhook") {
          const session = fixturePaidSession(a);
          mock.session.mockResolvedValue(session);
          const event = {
            id: `evt_${randomUUID().replaceAll("-", "")}`,
            type: "checkout.session.completed",
            livemode: false,
            data: { object: session },
          } as Stripe.Event;
          const receiptId = (await receiveAppointmentEvent(event, db))!;
          expect(await processAppointmentEvent(receiptId, db)).toBe("requires_review");
          expect(await processAppointmentEvent(receiptId, db)).toBe("requires_review");
          const receipt = await db.query.paymentEvents.findFirst({
            where: eq(schema.paymentEvents.id, receiptId),
          });
          expect(receipt?.reviewCode).toBe("resource_invariant_requires_review");
        }
        expect(await fulfillObservedPayment(a.id, db)).toMatchObject({
          state: "requires_review",
          uid: null,
        });
        const attempt = await db.query.paymentAttempts.findFirst({
          where: eq(schema.paymentAttempts.id, a.id),
        });
        expect(attempt?.reviewCode).toBe("resource_invariant_requires_review");
        expect(attempt?.successFacts).toEqual(a.successFacts);
        expect(await counts(e.id)).toEqual({ b: 0, c: 0 });
        await expect(
          resolvePaidReview(
            {
              id: randomUUID(),
              attemptId: a.id,
              actorUserId: e.ownerId!,
              method: "retry",
              evidence: "This must not authorize corruption as contention",
            },
            db,
          ),
        ).rejects.toMatchObject({ status: 409 });
      } finally {
        await db.$client.query("DROP TRIGGER a_resource_test_malformed ON booking_resource_claims");
        await db.$client.query("DROP FUNCTION resource_test_malformed()");
      }
    },
  );
  it("checkout and direct retries freeze one scheduling operation", async () => {
    const e = await service([{ id: await resource() }], 5000);
    const input = intent(e);
    const id = randomUUID();
    const [a, b] = await Promise.all([
      prepareAppointmentAttempt(input, "/", id, db),
      prepareAppointmentAttempt(input, "/", id, db),
    ]);
    expect(a.attempt!.id).toBe(b.attempt!.id);
    expect(a.attempt!.schedulingPlan).toEqual(b.attempt!.schedulingPlan);
    expect(await counts(e.id)).toEqual({ b: 0, c: 0 });
  });
  it("configuration edits wait on serialized acceptance rather than mixing requirements", async () => {
    const x = await resource();
    const y = await resource();
    const e = await service([{ id: x }]);
    const connection = await db.$client.connect();
    await connection.query("BEGIN");
    await connection.query("SELECT id FROM event_types WHERE id=$1 FOR UPDATE", [e.id]);
    const creating = book(e);
    const completion = creating.then(
      (b) => ({ b, error: null }),
      (error) => ({ b: null, error }),
    );
    try {
      let blocked = false;
      for (let n = 0; n < 200 && !blocked; n++) {
        const result = await db.$client.query(
          "select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%event_types%'",
        );
        blocked = result.rows.length > 0;
        if (!blocked) await new Promise((r) => setTimeout(r, 5));
      }
      expect(blocked).toBe(true);
      await connection.query(
        "UPDATE event_type_resource_requirements SET resource_id=$1 WHERE event_type_id=$2",
        [y, e.id],
      );
      await connection.query("COMMIT");
      const result = await completion;
      if (result.error) {
        expect(result.error).toMatchObject({ status: 409 });
        const b = await book(
          (await db.query.eventTypes.findFirst({ where: eq(schema.eventTypes.id, e.id) }))!,
        );
        expect(b.schedulingPlan?.resources[0]?.id).toBe(y);
      } else expect(result.b?.schedulingPlan?.resources[0]?.id).toBe(y);
    } finally {
      await connection.query("ROLLBACK");
      connection.release();
      await completion;
    }
  });
  it("disabled definitions reject checkout before an attempt or payment is created", async () => {
    const r = await resource();
    const e = await service([{ id: r }], 5000);
    await db.update(schema.resources).set({ enabled: false }).where(eq(schema.resources.id, r));
    await expect(prepareAppointmentAttempt(intent(e), "/", randomUUID(), db)).rejects.toMatchObject(
      { status: 409 },
    );
    expect(
      await db.query.paymentAttempts.findMany({
        where: eq(schema.paymentAttempts.eventTypeId, e.id),
      }),
    ).toHaveLength(0);
  });
  it("capacity mutation waits for acceptance and cannot reduce below a committed claim", async () => {
    const r = await resource(2);
    const e = await service([{ id: r, quantity: 2 }]);
    const c = await db.$client.connect();
    await c.query("BEGIN");
    await c.query("SELECT resource_fence(ARRAY[$1::uuid])", [r]);
    const allocating = book(e);
    const completion = allocating.then(
      (b) => ({ b, error: null }),
      (error) => ({ b: null, error }),
    );
    try {
      let blocked = false;
      for (let n = 0; n < 200 && !blocked; n++) {
        const result = await db.$client.query(
          "select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%resource_allocate_booking%'",
        );
        blocked = result.rows.length > 0;
        if (!blocked) await new Promise((r) => setTimeout(r, 5));
      }
      expect(blocked).toBe(true);
      await c.query("UPDATE resources SET enabled=false,capacity=1 WHERE id=$1", [r]);
      await c.query("COMMIT");
      expect((await completion).error).toMatchObject({ status: 409 });
      expect(await counts(e.id)).toEqual({ b: 0, c: 0 });
    } finally {
      await c.query("ROLLBACK");
      c.release();
      await completion;
    }
  });
  it("frozen attempts retain resolved schedule history and reject organization reassignment", async () => {
    const e = await service([{ id: await resource() }], 5000);
    await paid(e);
    await expect(
      db.delete(schema.schedules).where(eq(schema.schedules.id, e.scheduleId!)),
    ).rejects.toThrow();
    const other = randomUUID();
    await db.insert(schema.organizations).values({ id: other, name: "Other", slug: randomUUID() });
    await db
      .delete(schema.eventTypeResourceRequirements)
      .where(eq(schema.eventTypeResourceRequirements.eventTypeId, e.id));
    await expect(
      db
        .update(schema.eventTypes)
        .set({ organizationId: other })
        .where(eq(schema.eventTypes.id, e.id)),
    ).rejects.toThrow();
  });
  it("failed authorized retry preserves coupon reservation and needs a new operator action", async () => {
    const { e, a, c } = await review(true);
    const command = {
      id: randomUUID(),
      attemptId: a.id,
      actorUserId: e.ownerId!,
      method: "retry" as const,
      evidence: "Customer consented to retry original time",
    };
    expect(await resolvePaidReview(command, db)).toMatchObject({ state: "failed" });
    expect(await resolvePaidReview(command, db)).toMatchObject({ state: "failed" });
    expect(
      (
        await db.query.appointmentCouponUses.findFirst({
          where: eq(schema.appointmentCouponUses.couponId, c!.id),
        })
      )?.status,
    ).toBe("reserved");
    expect(await counts(e.id)).toEqual({ b: 0, c: 0 });
  });
  it("frozen duration and buffers survive service edits at fulfillment", async () => {
    const r = await resource();
    const e = await service([{ id: r }], 5000);
    await db
      .update(schema.eventTypes)
      .set({ bufferBeforeMinutes: 10, bufferAfterMinutes: 20 })
      .where(eq(schema.eventTypes.id, e.id));
    const a = await paid(e);
    await db
      .update(schema.eventTypes)
      .set({ durationMinutes: 60, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 })
      .where(eq(schema.eventTypes.id, e.id));
    const result = await fulfillObservedPayment(a.id, db);
    expect(result.state).toBe("fulfilled");
    const b = await db.query.bookings.findFirst({ where: eq(schema.bookings.uid, result.uid!) });
    expect(b?.schedulingPlan).toEqual(a.schedulingPlan);
    expect(b!.endsAt.getTime() - b!.startsAt.getTime()).toBe(1800000);
    const claim = await db.query.bookingResourceClaims.findFirst({
      where: eq(schema.bookingResourceClaims.bookingId, b!.id),
    });
    expect(claim!.startsAt.getTime()).toBe(b!.startsAt.getTime() - 600000);
    expect(claim!.endsAt.getTime()).toBe(b!.endsAt.getTime() + 1200000);
  });
  it("crash after claim insertion rolls back and the paid operation converges on retry", async () => {
    const e = await service([{ id: await resource() }], 5000);
    const c = await coupon(e, 5000);
    const a = await paid(e, c.code);
    await db.$client.query(
      "CREATE FUNCTION resource_test_crash() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test interruption' USING ERRCODE='XX000'; END $$",
    );
    await db.$client.query(
      `CREATE TRIGGER z_resource_test_crash AFTER INSERT ON booking_resource_claims FOR EACH ROW WHEN (NEW.event_type_id='${e.id}'::uuid) EXECUTE FUNCTION resource_test_crash()`,
    );
    try {
      expect(await fulfillObservedPayment(a.id, db)).toMatchObject({
        state: "payment_succeeded",
        uid: null,
      });
      expect(await counts(e.id)).toEqual({ b: 0, c: 0 });
      expect(
        (
          await db.query.appointmentCouponUses.findFirst({
            where: eq(schema.appointmentCouponUses.couponId, c.id),
          })
        )?.status,
      ).toBe("reserved");
    } finally {
      await db.$client.query("DROP TRIGGER z_resource_test_crash ON booking_resource_claims");
      await db.$client.query("DROP FUNCTION resource_test_crash()");
    }
    const result = await fulfillObservedPayment(a.id, db);
    expect(result.state).toBe("fulfilled");
    expect(await fulfillObservedPayment(a.id, db)).toMatchObject({
      uid: result.uid,
      state: "fulfilled",
    });
    expect(await counts(e.id)).toEqual({ b: 1, c: 1 });
  });
  it("provider failure after booking/claims commit retains exactly one financial result", async () => {
    const e = await service([{ id: await resource() }], 5000);
    const a = await paid(e);
    mock.finalize.mockRejectedValueOnce(new Error("post-commit provider interruption"));
    const result = await fulfillObservedPayment(a.id, db);
    expect(result.state).toBe("fulfilled");
    expect(await fulfillObservedPayment(a.id, db)).toMatchObject({
      uid: result.uid,
      state: "fulfilled",
    });
    expect(await counts(e.id)).toEqual({ b: 1, c: 1 });
    const after = await db.query.paymentAttempts.findFirst({
      where: eq(schema.paymentAttempts.id, a.id),
    });
    expect(after?.successFacts).toEqual(a.successFacts);
    expect(after?.finalizationState).toBe("requires_review");
  });
  it.each([false, true])(
    "malformed empty plan is invariant even with unrelated demand=%s",
    async (busy) => {
      const r = await resource(2);
      const e = await service([{ id: r }]);
      if (busy) await occupied(r);
      const plan = (
        await db.$client.query("select resource_accept_plan($1,30,$2) plan", [e.id, e.ownerId])
      ).rows[0].plan;
      await expect(
        db.transaction(async (tx) => {
          try {
            await tx.insert(schema.bookings).values({
              organizationId: org,
              eventTypeId: e.id,
              hostId: e.ownerId!,
              title: "Malformed",
              uid: randomUUID(),
              startsAt: new Date(start),
              endsAt: new Date(new Date(start).getTime() + 1800000),
              timezone: "UTC",
              schedulingPlan: { ...plan, resources: [] },
              allocationRevision: 1,
            });
          } catch (error) {
            expect(classifyResourceError(error)).toMatchObject({
              category: "invariant",
              identity: "resource_plan_completeness_violation",
            });
            throw error;
          }
        }),
      ).rejects.toThrow();
      expect(await counts(e.id)).toEqual({ b: 0, c: 0 });
    },
  );
  it("AI/SMS shared single-event writer allocates and converges on the confirmed request", async () => {
    const e = await service([{ id: await resource() }]);
    const input = {
      userId: e.ownerId!,
      requestId: randomUUID(),
      title: "Treatment",
      start: new Date(start),
      durationMinutes: 30,
      timezone: "UTC",
      eventTypeSlug: e.slug,
    };
    const a = await createOtterEvent(input);
    const b = await createOtterEvent(input);
    expect(a.uid).toBe(b.uid);
    expect(await counts(e.id)).toEqual({ b: 1, c: 1 });
  });
  it("internal team resource-free creation remains unmanaged, and Personal cannot be activated", async () => {
    const e = await service();
    const teamId = randomUUID();
    await db
      .insert(schema.teams)
      .values({ id: teamId, organizationId: org, name: "Test team", slug: randomUUID() });
    await db.insert(schema.teamMembers).values({ teamId, userId: e.ownerId!, role: "owner" });
    const result = await createInternalTeamBooking({
      teamId,
      organizerId: e.ownerId!,
      memberIds: [],
      title: "Internal",
      start: new Date(start),
      durationMinutes: 30,
      timezone: "UTC",
    });
    expect(result?.uid).toBeTruthy();
    const b = await db.query.bookings.findFirst({ where: eq(schema.bookings.uid, result!.uid) });
    expect(b?.schedulingPlan).toBeNull();
    await expect(
      db.insert(schema.eventTypeResourceRequirements).values({
        organizationId: org,
        eventTypeId: b!.eventTypeId,
        resourceId: await resource(),
        quantity: 1,
      }),
    ).rejects.toThrow();
    await expect(
      db
        .update(schema.eventTypes)
        .set({ isActive: true, resourceAdmissionEpoch: 1 })
        .where(eq(schema.eventTypes.id, b!.eventTypeId)),
    ).rejects.toThrow();
  });
  it("resolved unbooked refund rejects new resolution identities without another refund", async () => {
    const { e, a } = await review();
    const command = {
      id: randomUUID(),
      attemptId: a.id,
      actorUserId: e.ownerId!,
      method: "refund" as const,
      evidence: "Customer requested full payment refund",
    };
    expect(await resolvePaidReview(command, db)).toMatchObject({ state: "refunded" });
    await expect(resolvePaidReview({ ...command, id: randomUUID() }, db)).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      resolvePaidReview({ ...command, id: randomUUID(), method: "retry" }, db),
    ).rejects.toMatchObject({ status: 409 });
    expect(mock.refund.mock.calls.filter(([op]) => op.attemptId === a.id)).toHaveLength(1);
  });
  it("inactive service completion preserves finite accepted claims and history", async () => {
    const e = await service([{ id: await resource() }]);
    const b = await book(e);
    await db
      .update(schema.eventTypes)
      .set({ isActive: false })
      .where(eq(schema.eventTypes.id, e.id));
    await db
      .update(schema.bookings)
      .set({ status: "completed" })
      .where(eq(schema.bookings.id, b.id));
    const after = await db.query.bookings.findFirst({ where: eq(schema.bookings.id, b.id) });
    expect(after?.schedulingPlan).toEqual(b.schedulingPlan);
    expect(await counts(e.id)).toEqual({ b: 1, c: 1 });
  });
  it("raw managed group flags fail as invariants before allocation", async () => {
    const e = await service([{ id: await resource() }]);
    const plan = (
      await db.$client.query("select resource_accept_plan($1,30,$2) plan", [e.id, e.ownerId])
    ).rows[0].plan;
    try {
      await db.insert(schema.bookings).values({
        organizationId: org,
        eventTypeId: e.id,
        hostId: e.ownerId!,
        title: "Forged group",
        uid: randomUUID(),
        startsAt: new Date(start),
        endsAt: new Date(Date.parse(start) + 1800000),
        timezone: "UTC",
        schedulingPlan: plan,
        allocationRevision: 1,
        isGroup: true,
      });
      throw new Error("admitted");
    } catch (error) {
      expect(classifyResourceError(error)).toMatchObject({
        category: "invariant",
        identity: "resource_plan_completeness_violation",
      });
    }
    expect(await counts(e.id)).toEqual({ b: 0, c: 0 });
  });
  it("activation refuses legacy bookings and unbound frozen-empty paid attempts", async () => {
    for (const kind of ["booking", "attempt"] as const) {
      const e = await service([], kind === "attempt" ? 5000 : 0);
      if (kind === "booking") await book(e);
      else await paid(e);
      await db.insert(schema.eventTypeResourceRequirements).values({
        organizationId: org,
        eventTypeId: e.id,
        resourceId: await resource(),
        quantity: 1,
      });
      try {
        await db
          .update(schema.eventTypes)
          .set({ resourceAdmissionEpoch: 1 })
          .where(eq(schema.eventTypes.id, e.id));
        throw new Error("activated");
      } catch (error) {
        expect(classifyResourceError(error)).toMatchObject({
          identity: "resource_adoption_required",
        });
      }
      expect(
        (await db.query.eventTypes.findFirst({ where: eq(schema.eventTypes.id, e.id) }))
          ?.resourceAdmissionEpoch,
      ).toBe(0);
    }
  });
  it("adding resources back censuses accepted-empty paid custody", async () => {
    const e = await service([{ id: await resource() }], 5000);
    await db
      .delete(schema.eventTypeResourceRequirements)
      .where(eq(schema.eventTypeResourceRequirements.eventTypeId, e.id));
    const a = await paid(e);
    expect(a.schedulingPlan?.resources).toEqual([]);
    await expect(
      db.insert(schema.eventTypeResourceRequirements).values({
        organizationId: org,
        eventTypeId: e.id,
        resourceId: await resource(),
        quantity: 1,
      }),
    ).rejects.toThrow();
    expect(await counts(e.id)).toEqual({ b: 0, c: 0 });
  });
  it("historical unmanaged rows cannot move into managed future occupancy", async () => {
    const e = await service([{ id: await resource() }], 0, false);
    const b = await book(e, "2020-01-01T10:00:00.000Z");
    await db
      .update(schema.bookings)
      .set({ status: "cancelled" })
      .where(eq(schema.bookings.id, b.id));
    await db
      .update(schema.eventTypes)
      .set({ resourceAdmissionEpoch: 1 })
      .where(eq(schema.eventTypes.id, e.id));
    try {
      await db
        .update(schema.bookings)
        .set({
          status: "confirmed",
          startsAt: new Date(start),
          endsAt: new Date(Date.parse(start) + 1800000),
        })
        .where(eq(schema.bookings.id, b.id));
      throw new Error("admitted");
    } catch (error) {
      expect(classifyResourceError(error)).toMatchObject({
        identity: "resource_adoption_required",
      });
    }
    expect(
      (await db.query.bookings.findFirst({ where: eq(schema.bookings.id, b.id) }))?.status,
    ).toBe("cancelled");
  });
  it("concurrent retry and refund actions choose one durable resolution", async () => {
    const { e, a } = await review(true);
    const command = {
      attemptId: a.id,
      actorUserId: e.ownerId!,
      evidence: "Customer consents to original retry or full refund",
    };
    const results = await Promise.allSettled([
      resolvePaidReview({ ...command, id: randomUUID(), method: "retry" }, db),
      resolvePaidReview({ ...command, id: randomUUID(), method: "refund" }, db),
    ]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    const actions = await db.query.paymentReviewActions.findMany({
      where: eq(schema.paymentReviewActions.attemptId, a.id),
    });
    const refunds = await db.query.refundOperations.findMany({
      where: eq(schema.refundOperations.attemptId, a.id),
    });
    expect(refunds.length).toBeLessThanOrEqual(1);
    expect(actions.filter((action) => action.state === "active").length).toBeLessThanOrEqual(1);
    expect(await counts(e.id)).toEqual({ b: 0, c: 0 });
    expect(await fulfillObservedPayment(a.id, db)).toMatchObject({
      uid: null,
      state: "requires_review",
    });
  });
  it("pending refund preserves custody and recovery completes the same operation", async () => {
    const { e, a, c } = await review(true);
    mock.refundRead.mockImplementationOnce(async (op, id) => {
      const evidence = fixtureRefundEvidence(op, "pending");
      evidence.refund.id = id;
      return evidence;
    });
    const command = {
      id: randomUUID(),
      attemptId: a.id,
      actorUserId: e.ownerId!,
      method: "refund" as const,
      evidence: "Customer requested full original refund",
    };
    expect(await resolvePaidReview(command, db)).toMatchObject({ state: "active" });
    expect(
      (
        await db.query.appointmentCouponUses.findFirst({
          where: eq(schema.appointmentCouponUses.couponId, c!.id),
        })
      )?.status,
    ).toBe("reserved");
    const queue = (await listPaidReview(org, e.ownerId!, db)).find((item) => item.id === a.id)!;
    expect(queue).toMatchObject({
      actionable: false,
      refundState: "pending",
      chargeId: a.successFacts!.chargeId,
      actions: [{ id: command.id, state: "active" }],
    });
    const op = (await db.query.refundOperations.findFirst({
      where: eq(schema.refundOperations.attemptId, a.id),
    }))!;
    expect(await executeRefundOperation(op.id, db)).toBe("refunded");
    expect(await resolvePaidReview(command, db)).toMatchObject({ state: "refunded" });
    expect(mock.refund.mock.calls.filter(([op]) => op.attemptId === a.id)).toHaveLength(1);
  });
  it.each([0, 200])(
    "unbooked Connect refund retains historical routing and verified reversal, fee %i",
    async (fee) => {
      mock.mode = "connect";
      mock.fee = fee;
      try {
        const { e, a } = await review();
        mock.mode = "direct";
        expect(
          await resolvePaidReview(
            {
              id: randomUUID(),
              attemptId: a.id,
              actorUserId: e.ownerId!,
              method: "refund",
              evidence: "Customer requested full historical Connect refund",
            },
            db,
          ),
        ).toMatchObject({ state: "refunded" });
        const op = (await db.query.refundOperations.findFirst({
          where: eq(schema.refundOperations.attemptId, a.id),
        }))!;
        expect(op).toMatchObject({
          paymentMode: "connect",
          destinationAccountId: "acct_host",
          applicationFeeAmount: fee,
          state: "succeeded",
        });
        expect(mock.refund.mock.calls.filter(([op]) => op.attemptId === a.id)).toHaveLength(1);
      } finally {
        mock.mode = "direct";
        mock.fee = 0;
      }
    },
  );
  it("recovery stops retrying technical resource errors before payment observation", async () => {
    const e = await service([{ id: await resource() }], 5000);
    const prepared = await prepareAppointmentAttempt(intent(e), "/", randomUUID(), db);
    const session = {
      ...fixtureSession(prepared.attempt!),
      id: `cs_${prepared.attempt!.id.replaceAll("-", "")}`,
    };
    const attempt = await bindAttemptSession(prepared.attempt!, session, db);
    mock.session.mockImplementation(async (id) => {
      if (id === session.id)
        throw new ResourceInvariantError(
          "resource_plan_completeness_violation",
          new Error("Test scheduling custody failure"),
        );
      return session;
    });
    await recoverAppointmentPayments(100, db);
    const after = await db.query.paymentAttempts.findFirst({
      where: eq(schema.paymentAttempts.id, attempt.id),
    });
    expect(after).toMatchObject({
      state: "requires_review",
      reviewCode: "resource_invariant_requires_review",
      bookingId: null,
      successFacts: null,
    });
    expect(after?.recoveryFailures).toBe(0);
    expect(await counts(e.id)).toEqual({ b: 0, c: 0 });
  });
  it.each([true, false])(
    "paid resource move preserves accepted settlement; capacity failure leaves the paid booking intact (requiresHost=%s)",
    async (requiresHost) => {
      const r = await resource();
      const e = await service([{ id: r }], 5000, true, requiresHost);
      const c = await coupon(e, 5000);
      const a = await paid(e, c.code);
      const result = await fulfillObservedPayment(a.id, db);
      await finalizePaymentBooking(a.id, db);
      const b = (await db.query.bookings.findFirst({
        where: eq(schema.bookings.uid, result.uid!),
      }))!;
      const snapshot = await db.query.bookingPricingSnapshots.findFirst({
        where: eq(schema.bookingPricingSnapshots.bookingId, b.id),
      });
      const savedAttempt = await db.query.paymentAttempts.findFirst({
        where: eq(schema.paymentAttempts.id, a.id),
      });
      const to = new Date("2030-01-01T11:00:00Z");
      await admitBookingReschedule(db, b, e, to, new Date(to.getTime() + 1800000));
      expect(
        await db.query.bookingPricingSnapshots.findFirst({
          where: eq(schema.bookingPricingSnapshots.bookingId, b.id),
        }),
      ).toEqual(snapshot);
      expect(
        await db.query.paymentAttempts.findFirst({ where: eq(schema.paymentAttempts.id, a.id) }),
      ).toEqual(savedAttempt);
      expect(
        (await db.query.bookings.findFirst({ where: eq(schema.bookings.id, b.id) }))!.paymentStatus,
      ).toBe("paid");
      const blocker = await service([{ id: r }]);
      await book(blocker, "2030-01-01T12:00:00Z");
      const current = (await db.query.bookings.findFirst({ where: eq(schema.bookings.id, b.id) }))!;
      await expect(
        admitBookingReschedule(
          db,
          current,
          e,
          new Date("2030-01-01T12:00:00Z"),
          new Date("2030-01-01T12:30:00Z"),
        ),
      ).rejects.toBeDefined();
      expect(await db.query.bookings.findFirst({ where: eq(schema.bookings.id, b.id) })).toEqual(
        current,
      );
      expect(
        await db.query.refundOperations.findMany({
          where: eq(schema.refundOperations.bookingId, b.id),
        }),
      ).toHaveLength(0);
      const decisions = await Promise.all([
        decideBookingCancellation(b.uid, undefined, db),
        decideBookingCancellation(b.uid, undefined, db),
      ]);
      expect(decisions.filter((d) => d!.changed)).toHaveLength(1);
      expect(decisions.every((d) => d!.operation?.id === decisions[0]!.operation!.id)).toBe(true);
      expect(
        await db.query.appointmentCouponRestorations.findMany({
          where: eq(schema.appointmentCouponRestorations.bookingId, b.id),
        }),
      ).toHaveLength(1);
      expect(
        (
          await db.query.bookingResourceClaims.findMany({
            where: eq(schema.bookingResourceClaims.bookingId, b.id),
          })
        ).every((c) => c.releasedAt),
      ).toBe(true);
      expect(await executeRefundOperation(decisions[0]!.operation!.id, db)).toBe("refunded");
    },
  );
});
