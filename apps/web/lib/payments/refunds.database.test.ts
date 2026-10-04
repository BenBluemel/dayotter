import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createDatabase, eq, schema } from "@dayotter/db";
import type Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fixturePaidSession, fixturePaymentIntent } from "./attempt-fixtures";
import { withPreResourceSchedulingSchema } from "./legacy-scheduling-fixture";
import { insertHistoricalPricingSnapshot } from "./legacy-snapshot-fixture";
import { fixtureRefundCharge, fixtureRefundEvidence } from "./refund-fixtures";
import type { RefundEvidence, RefundOperation } from "./refund-terms";

const mock = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof createDatabase>,
  pi: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  charge: vi.fn(),
  read: vi.fn(),
  finalize: vi.fn(),
  slots: vi.fn(),
  legacyRefund: vi.fn(),
  cleanup: vi.fn(),
  credit: vi.fn(),
  mode: "direct" as "direct" | "connect",
  fee: 0,
}));
vi.mock("@dayotter/db", async (original) => ({
  ...(await original<typeof import("@dayotter/db")>()),
  getDb: () => mock.db,
}));
vi.mock("../server/env", () => ({ env: { APP_URL: "https://example.test" } }));
vi.mock("./connect", () => ({
  checkoutRouteForOrganization: async (organizationId: string) => ({
    mode: mock.mode,
    organizationId,
    environment: "test",
    chargeAccountId: "acct_merchant",
    credentialContext: "primary",
    ...(mock.mode === "connect"
      ? { destinationAccountId: "acct_host", applicationFeeAmount: mock.fee }
      : {}),
  }),
}));
vi.mock("./stripe", () => ({
  retrievePaymentIntent: mock.pi,
  createOperationRefund: mock.create,
  listOperationRefunds: mock.list,
  retrieveRefundCharge: mock.charge,
  retrieveOperationRefund: mock.read,
  refundPayment: mock.legacyRefund,
  stripeConfigured: true,
}));
vi.mock("../booking/finalize-booking", () => ({ finalizeConfirmedBooking: mock.finalize }));
vi.mock("../booking/availability", () => ({
  SLOT_REVALIDATION_WINDOW_MS: 60000,
  isAllowedDuration: () => true,
  eventTypeHostSlots: mock.slots,
  combineHostSlots: (perHost: unknown[][]) => perHost.flat(),
}));
vi.mock("../calendar/host-calendar", () => ({ deleteBookingFromCalendar: mock.cleanup }));
vi.mock("../booking/reminders", () => ({ clearBookingReminders: vi.fn() }));
vi.mock("../booking/lifecycle", () => ({ fanOutBookingLifecycle: vi.fn() }));
vi.mock("../packages/credits", () => ({ restoreBookingCredit: async () => null }));
vi.mock("@dayotter/emails", () => ({
  sendEmail: vi.fn(),
  bookingRequested: vi.fn(),
  newBookingRequest: vi.fn(),
  bookingCancellation: vi.fn(),
}));
import { cancelBookingWithResult } from "../booking/cancel-booking";
import { createBooking } from "../booking/create-booking";
import { decodeAttempt } from "./attempt-terms";
import { prepareAppointmentAttempt } from "./attempts";
import { finalizePaymentBooking } from "./payment-finalization";
import { fulfillObservedPayment, observePaymentSuccess } from "./payment-work";
import { REFUND_REPLAY_WINDOW_MS } from "./refund-terms";
import {
  bookingRefundState,
  decideBookingCancellation,
  executeRefundOperation,
  recoverRefundOperations,
} from "./refunds";

const testUrl = process.env.PAYMENTS_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("durable refunds PostgreSQL integration", () => {
  const name = `dayotter_payments_test_${randomUUID().replaceAll("-", "")}`;
  let admin: ReturnType<typeof createDatabase>;
  let db: ReturnType<typeof createDatabase>;
  let created = false;
  const oldKey = process.env.ENCRYPTION_KEY;
  const organizationId = randomUUID();
  const ownerId = randomUUID();
  const eventTypeId = randomUUID();
  let sequence = 0;
  let upgrade: Awaited<ReturnType<typeof fresh>>;
  let upgradeInconsistent: Awaited<ReturnType<typeof fresh>>;
  const payments = new Map<string, Stripe.PaymentIntent>();
  const refunds = new Map<string, RefundEvidence>();
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.pathname !== "/dayotter_payments_test"
    )
      throw new Error("Use a disposable loopback database named dayotter_payments_test");
    process.env.ENCRYPTION_KEY = "ab".repeat(32);
    admin = createDatabase(url.toString());
    await admin.$client.query(`CREATE DATABASE "${name}"`);
    created = true;
    url.pathname = `/${name}`;
    db = createDatabase(url.toString());
    mock.db = db;
    const directory = new URL("../../../../packages/db/drizzle/", import.meta.url);
    const journal = JSON.parse(
      await readFile(new URL("meta/_journal.json", directory), "utf8"),
    ) as { entries: { tag: string }[] };
    for (const { tag } of journal.entries) {
      if (tag === "0066_refund_operations") {
        await withPreResourceSchedulingSchema(async () => {
          await db.$client.query("INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3)", [
            organizationId,
            "Refund test",
            randomUUID(),
          ]);
          await db.insert(schema.users).values({ id: ownerId, email: "host@example.test" });
          await db.insert(schema.eventTypes).values({
            id: eventTypeId,
            organizationId,
            ownerId,
            slug: "test",
            title: "Test",
            price: 5000,
            depositAmount: 2000,
            currency: "usd",
            durationMinutes: 30,
            location: "in_person",
            locationDetail: "Test room",
          });
          upgrade = await fresh(true);
          // Genuine Slice 3 cancelled row with no refund operation: migration must
          // preserve it, and bounded recovery may safely reconstruct the obligation.
          await db
            .update(schema.bookings)
            .set({ status: "cancelled" })
            .where(eq(schema.bookings.id, upgrade.booking.id));
          upgradeInconsistent = await fresh(true);
          await db
            .update(schema.bookings)
            .set({ status: "cancelled", paymentCurrency: "eur" })
            .where(eq(schema.bookings.id, upgradeInconsistent.booking.id));
        });
      }
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
  }, 60000);
  afterAll(async () => {
    if (db) await db.$client.end();
    if (created) await admin.$client.query(`DROP DATABASE "${name}"`);
    if (admin) await admin.$client.end();
    if (oldKey === undefined) Reflect.deleteProperty(process.env, "ENCRYPTION_KEY");
    else process.env.ENCRYPTION_KEY = oldKey;
  });
  beforeEach(() => {
    vi.clearAllMocks();
    refunds.clear();
    mock.mode = "direct";
    mock.fee = 0;
    mock.finalize.mockResolvedValue(undefined);
    mock.cleanup.mockResolvedValue(undefined);
    mock.list.mockImplementation(async (operation: RefundOperation) => {
      const evidence = refunds.get(operation.id);
      return evidence ? [evidence.refund] : [];
    });
    mock.charge.mockImplementation(
      async (operation: RefundOperation) =>
        refunds.get(operation.id)?.charge ?? fixtureRefundCharge(operation),
    );
    mock.create.mockImplementation(async (operation: RefundOperation) => {
      // Simulated Stripe idempotency: every concurrent caller sees the same object.
      if (!refunds.has(operation.id)) refunds.set(operation.id, fixtureRefundEvidence(operation));
      return refunds.get(operation.id)!.refund;
    });
    mock.read.mockImplementation(async (operation: RefundOperation, id: string) => {
      const evidence = refunds.get(operation.id) ?? fixtureRefundEvidence(operation);
      return { ...evidence, refund: { ...evidence.refund, id } };
    });
  });
  async function fresh(historical = false) {
    const start = new Date(Date.UTC(2027, 0, 1) + sequence++ * 3600000);
    const input = {
      eventTypeId,
      start: start.toISOString(),
      attendee: { name: "Client", email: "client@example.test", timezone: "UTC" },
    };
    const { attempt } = await prepareAppointmentAttempt(input, "/", randomUUID(), db);
    const session = fixturePaidSession(attempt!);
    const pi = fixturePaymentIntent(attempt!, session);
    payments.set(pi.id, pi);
    mock.pi.mockImplementation(async (id: string) => payments.get(id)!);
    mock.slots.mockResolvedValue({
      hostIds: [ownerId],
      perHost: [[{ start, end: new Date(start.getTime() + 1800000) }]],
    });
    await observePaymentSuccess(attempt!, session, db);
    const terms = decodeAttempt(attempt!);
    if (historical) {
      const bookingId = randomUUID();
      const uid = randomUUID();
      await db.transaction(async (tx) => {
        await tx.insert(schema.bookings).values({
          id: bookingId,
          uid,
          organizationId,
          eventTypeId,
          hostId: ownerId,
          title: "Historical",
          startsAt: start,
          endsAt: new Date(start.getTime() + 1800000),
          timezone: "UTC",
          allowOverlap: true,
        });
        await insertHistoricalPricingSnapshot(tx, bookingId, terms.quote);
        await tx
          .update(schema.bookings)
          .set({
            paymentStatus: "paid",
            paymentIntentId: pi.id,
            amountPaid: attempt!.amount,
            paymentCurrency: attempt!.currency,
            destinationAccountId: attempt!.destinationAccountId,
          })
          .where(eq(schema.bookings.id, bookingId));
        await tx
          .update(schema.paymentAttempts)
          .set({
            state: "fulfilled",
            bookingId,
            finalizationContext: "historical-test-context",
            finalizationState: "pending",
          })
          .where(eq(schema.paymentAttempts.id, attempt!.id));
      });
      const booking = (await db.query.bookings.findFirst({
        where: eq(schema.bookings.id, bookingId),
      }))!;
      return { attempt: attempt!, session, pi, booking };
    }
    const result = await createBooking({
      ...terms.input,
      paymentAttemptId: attempt!.id,
      pricingQuote: terms.quote,
      quotedDurationMinutes: 30,
      payment: {
        paymentIntentId: pi.id,
        amountPaid: attempt!.amount,
        currency: attempt!.currency,
        destinationAccountId: attempt!.destinationAccountId ?? undefined,
      },
    });
    const booking = (await db.query.bookings.findFirst({
      where: eq(schema.bookings.uid, result.uid),
    }))!;
    return { attempt: attempt!, session, pi, booking };
  }
  const load = async (id: string) =>
    (await db.query.refundOperations.findFirst({ where: eq(schema.refundOperations.id, id) }))!;
  async function owed() {
    const paid = await fresh();
    const decision = await decideBookingCancellation(paid.booking.uid, "Requested", db);
    return { ...paid, operation: decision!.operation! };
  }

  it("migrates Slice 3 without fabricating history and recovers an old cancelled obligation", async () => {
    expect(
      await db.query.refundOperations.findFirst({
        where: eq(schema.refundOperations.attemptId, upgrade.attempt.id),
      }),
    ).toBeUndefined();
    await recoverRefundOperations(100, db);
    const operation = (await db.query.refundOperations.findFirst({
      where: eq(schema.refundOperations.attemptId, upgrade.attempt.id),
    }))!;
    expect(operation.amount).toBe(2000); // Captured deposit, never current service price.
    expect(operation.state).toBe("succeeded");
    expect(
      (await db.query.paymentAttempts.findFirst({
        where: eq(schema.paymentAttempts.id, upgradeInconsistent.attempt.id),
      }))!.reviewCode,
    ).toBe("refund_obligation_binding_requires_review");
    expect(await bookingRefundState(upgradeInconsistent.booking.id, db)).toBe("requires_review");
    expect(
      await db.query.refundOperations.findFirst({
        where: eq(schema.refundOperations.attemptId, upgradeInconsistent.attempt.id),
      }),
    ).toBeUndefined();
  });
  it("applies the complete journal to a clean disposable database", async () => {
    const cleanName = `dayotter_payments_test_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(testUrl!);
    url.pathname = `/${cleanName}`;
    await admin.$client.query(`CREATE DATABASE "${cleanName}"`);
    const clean = createDatabase(url.toString());
    try {
      const directory = new URL("../../../../packages/db/drizzle/", import.meta.url);
      const journal = JSON.parse(
        await readFile(new URL("meta/_journal.json", directory), "utf8"),
      ) as { entries: { tag: string }[] };
      for (const { tag } of journal.entries) {
        const text = await readFile(new URL(`${tag}.sql`, directory), "utf8");
        const client = await clean.$client.connect();
        try {
          await client.query("BEGIN");
          for (const statement of text.split("--> statement-breakpoint"))
            if (statement.trim()) await client.query(statement);
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
      }
      expect(await clean.query.refundOperations.findMany()).toEqual([]);
    } finally {
      await clean.$client.end();
      await admin.$client.query(`DROP DATABASE "${cleanName}"`);
    }
  }, 60000);
  it("duplicate and concurrent cancellations reuse one operation, even when already cancelled", async () => {
    const paid = await fresh();
    const decisions = await Promise.all(
      Array.from({ length: 12 }, () => decideBookingCancellation(paid.booking.uid, undefined, db)),
    );
    expect(decisions.filter((d) => d!.changed)).toHaveLength(1);
    expect(new Set(decisions.map((d) => d!.operation!.id)).size).toBe(1);
    const again = await decideBookingCancellation(paid.booking.uid, undefined, db);
    expect(again!.changed).toBe(false);
    expect(again!.operation!.state).toBe("owed");
  });
  it("crash after obligation commit leaves owed work discoverable independently of Redis", async () => {
    const { operation, booking } = await owed();
    expect(mock.create).not.toHaveBeenCalled();
    expect((await load(operation.id)).state).toBe("owed");
    await recoverRefundOperations(100, db);
    expect((await load(operation.id)).state).toBe("succeeded");
    expect(
      (await db.query.bookings.findFirst({ where: eq(schema.bookings.id, booking.id) }))!
        .paymentStatus,
    ).toBe("refunded");
  });
  it("two workers and cancellation/recovery races yield exactly one financial refund", async () => {
    const { operation, booking } = await owed();
    await Promise.all([
      executeRefundOperation(operation.id, db),
      executeRefundOperation(operation.id, db),
      cancelBookingWithResult(booking.uid),
      recoverRefundOperations(100, db),
    ]);
    expect(refunds.size).toBe(1);
    expect((await load(operation.id)).state).toBe("succeeded");
    expect(new Set(mock.create.mock.calls.map(([o]) => o.idempotencyKey)).size).toBeLessThanOrEqual(
      1,
    );
    expect(mock.legacyRefund).not.toHaveBeenCalled();
  });
  it("ambiguous API response after acceptance reconciles the existing refund without a new create", async () => {
    const { operation } = await owed();
    mock.create.mockImplementationOnce(async (o: RefundOperation) => {
      refunds.set(o.id, fixtureRefundEvidence(o));
      throw new Error("timeout after accept");
    });
    expect(await executeRefundOperation(operation.id, db)).toBe("processing");
    expect((await load(operation.id)).state).toBe("retryable");
    expect(await executeRefundOperation(operation.id, db)).toBe("refunded");
    expect(mock.create).toHaveBeenCalledTimes(1);
  });
  it("retry after an unresolved request reuses identical key and historical parameters", async () => {
    const { operation } = await owed();
    mock.create.mockRejectedValueOnce(new Error("network timeout"));
    await executeRefundOperation(operation.id, db);
    await executeRefundOperation(operation.id, db);
    const [first, second] = mock.create.mock.calls.map(([o]) => o);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.firstSubmittedAt.getTime()).toBe(first.firstSubmittedAt.getTime());
    expect(second.amount).toBe(2000);
    expect(second.chargeId).toBe(first.chargeId);
  });
  it("crash after Stripe success before local success commit reconciles the bound Refund ID", async () => {
    const { operation } = await owed();
    await db.$client.query(
      `CREATE FUNCTION fail_test_refund_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${operation.id}' AND NEW.state = 'succeeded' THEN RAISE EXCEPTION 'temporary DB failure'; END IF; RETURN NEW; END; $$; CREATE TRIGGER zz_test_refund_commit BEFORE UPDATE ON refund_operations FOR EACH ROW EXECUTE FUNCTION fail_test_refund_commit()`,
    );
    try {
      await executeRefundOperation(operation.id, db);
      expect((await load(operation.id)).state).toBe("retryable");
      expect((await load(operation.id)).stripeRefundId).toBeTruthy();
    } finally {
      await db.$client.query(
        "DROP TRIGGER zz_test_refund_commit ON refund_operations; DROP FUNCTION fail_test_refund_commit()",
      );
    }
    expect(await executeRefundOperation(operation.id, db)).toBe("refunded");
    expect(mock.create).toHaveBeenCalledTimes(1);
  });
  it("known pending ID and transient retrieval failures remain recoverable without creating again", async () => {
    const { operation } = await owed();
    mock.create.mockImplementationOnce(async (o: RefundOperation) => {
      const e = fixtureRefundEvidence(o, "pending");
      refunds.set(o.id, e);
      return e.refund;
    });
    expect(await executeRefundOperation(operation.id, db)).toBe("processing");
    expect((await load(operation.id)).state).toBe("pending");
    mock.read.mockRejectedValueOnce(new Error("temporary read failure"));
    expect(await executeRefundOperation(operation.id, db)).toBe("processing");
    refunds.set(operation.id, fixtureRefundEvidence(operation));
    expect(await executeRefundOperation(operation.id, db)).toBe("refunded");
    expect(mock.create).toHaveBeenCalledTimes(1);
  });
  it("an older pending observation cannot regress a concurrently verified success", async () => {
    const { operation } = await owed();
    const evidence = fixtureRefundEvidence(operation);
    await db
      .update(schema.refundOperations)
      .set({ stripeRefundId: evidence.refund.id })
      .where(eq(schema.refundOperations.id, operation.id));
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    mock.read.mockImplementationOnce(async () => {
      entered();
      await new Promise<void>((r) => {
        release = r;
      });
      return fixtureRefundEvidence(operation, "pending");
    });
    const stale = executeRefundOperation(operation.id, db);
    await started;
    expect(await executeRefundOperation(operation.id, db)).toBe("refunded");
    release();
    expect(await stale).toBe("refunded");
    expect((await load(operation.id)).stripeStatus).toBe("succeeded");
  });
  it.each(["failed", "canceled", "requires_action"])(
    "Stripe %s retains a visible obligation requiring review",
    async (status) => {
      const { operation } = await owed();
      refunds.set(operation.id, fixtureRefundEvidence(operation, status));
      expect(await executeRefundOperation(operation.id, db)).toBe("requires_review");
      expect((await load(operation.id)).stripeStatus).toBe(status);
      expect(mock.create).not.toHaveBeenCalled();
    },
  );
  it("creation ambiguity beyond the replay window fails closed without a replacement key", async () => {
    const { operation } = await owed();
    await db
      .update(schema.refundOperations)
      .set({
        state: "submitting",
        firstSubmittedAt: new Date(Date.now() - REFUND_REPLAY_WINDOW_MS - 1),
      })
      .where(eq(schema.refundOperations.id, operation.id));
    expect(await executeRefundOperation(operation.id, db)).toBe("requires_review");
    expect(mock.create).not.toHaveBeenCalled();
  });
  it("an existing matching refund is reconciled even after the replay window", async () => {
    const { operation } = await owed();
    await db
      .update(schema.refundOperations)
      .set({
        state: "submitting",
        firstSubmittedAt: new Date(Date.now() - REFUND_REPLAY_WINDOW_MS - 1),
      })
      .where(eq(schema.refundOperations.id, operation.id));
    refunds.set(operation.id, fixtureRefundEvidence(operation));
    expect(await executeRefundOperation(operation.id, db)).toBe("refunded");
    expect(mock.create).not.toHaveBeenCalled();
  });
  it.each(["id", "amount", "currency", "intent", "charge", "account", "environment"])(
    "contradictory refund %s enters review without marking booking refunded",
    async (kind) => {
      const { operation, booking } = await owed();
      const e = fixtureRefundEvidence(operation);
      if (kind === "id") {
        await db
          .update(schema.refundOperations)
          .set({ stripeRefundId: "re_original" })
          .where(eq(schema.refundOperations.id, operation.id));
        e.refund.id = "re_conflicting";
      }
      if (kind === "amount") e.refund.amount++;
      if (kind === "currency") e.refund.currency = "eur";
      if (kind === "intent") e.refund.payment_intent = "pi_wrong";
      if (kind === "charge") e.refund.charge = "ch_wrong";
      if (kind === "account") e.chargeAccountId = "acct_wrong";
      if (kind === "environment") e.environment = "live";
      mock.read.mockResolvedValueOnce(e);
      expect(await executeRefundOperation(operation.id, db)).toBe("requires_review");
      expect(
        (await db.query.bookings.findFirst({ where: eq(schema.bookings.id, booking.id) }))!
          .paymentStatus,
      ).toBe("paid");
    },
  );
  it.each(["direct", "connect-zero", "connect-fee"])(
    "preserves historical %s routing despite changed current configuration",
    async (mode) => {
      mock.mode = mode === "direct" ? "direct" : "connect";
      mock.fee = mode === "connect-fee" ? 123 : 0;
      const { operation } = await owed();
      mock.mode = mode === "direct" ? "connect" : "direct";
      mock.fee = 999;
      const oldMode = process.env.STRIPE_PAYMENT_MODE;
      process.env.STRIPE_PAYMENT_MODE = "disabled";
      try {
        expect(await executeRefundOperation(operation.id, db)).toBe("refunded");
      } finally {
        if (oldMode === undefined) Reflect.deleteProperty(process.env, "STRIPE_PAYMENT_MODE");
        else process.env.STRIPE_PAYMENT_MODE = oldMode;
      }
      expect(mock.create).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentMode: mode === "direct" ? "direct" : "connect",
          applicationFeeAmount: mode === "connect-fee" ? 123 : 0,
        }),
      );
    },
  );
  it("fulfillment recovery cannot resurrect or duplicate a cancelled booking", async () => {
    const { operation, booking, attempt } = await owed();
    await Promise.all([
      fulfillObservedPayment(attempt.id, db),
      executeRefundOperation(operation.id, db),
    ]);
    expect(
      (await db.query.bookings.findFirst({ where: eq(schema.bookings.id, booking.id) }))!.status,
    ).toBe("cancelled");
    expect(mock.finalize).not.toHaveBeenCalled();
    expect((await fulfillObservedPayment(attempt.id, db))!.uid).toBe(booking.uid);
    await expect(
      db
        .update(schema.bookings)
        .set({ status: "confirmed" })
        .where(eq(schema.bookings.id, booking.id)),
    ).rejects.toThrow();
  });
  it("cancellation racing active finalization records cleanup review while refund remains durable", async () => {
    const paid = await fresh();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    mock.finalize.mockImplementationOnce(() => {
      entered();
      return new Promise<void>((r) => {
        release = r;
      });
    });
    const running = finalizePaymentBooking(paid.attempt.id, db);
    await started;
    const decision = await decideBookingCancellation(paid.booking.uid, undefined, db);
    expect(decision!.operation).toBeTruthy();
    expect(
      (await db.query.paymentAttempts.findFirst({
        where: eq(schema.paymentAttempts.id, paid.attempt.id),
      }))!.finalizationReviewCode,
    ).toBe("cancelled_during_finalization");
    release();
    await running;
    expect(await executeRefundOperation(decision!.operation!.id, db)).toBe("refunded");
  });
  it("failed cancellation transaction rolls back booking status with the missing obligation", async () => {
    const paid = await fresh();
    await db.$client.query(
      `CREATE FUNCTION fail_test_refund_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'temporary DB failure'; END; $$; CREATE TRIGGER zz_test_refund_insert BEFORE INSERT ON refund_operations FOR EACH ROW EXECUTE FUNCTION fail_test_refund_insert()`,
    );
    try {
      await expect(decideBookingCancellation(paid.booking.uid, undefined, db)).rejects.toThrow();
    } finally {
      await db.$client.query(
        "DROP TRIGGER zz_test_refund_insert ON refund_operations; DROP FUNCTION fail_test_refund_insert()",
      );
    }
    expect(
      (await db.query.bookings.findFirst({ where: eq(schema.bookings.id, paid.booking.id) }))!
        .status,
    ).toBe("confirmed");
  });
  it("database guards reject missing obligations, fake completion, term mutation, duplicate full refunds and deletion", async () => {
    const paid = await fresh();
    await expect(
      db
        .update(schema.bookings)
        .set({ status: "cancelled" })
        .where(eq(schema.bookings.id, paid.booking.id)),
    ).rejects.toThrow();
    const operation = (await decideBookingCancellation(paid.booking.uid, undefined, db))!
      .operation!;
    await expect(
      db
        .update(schema.refundOperations)
        .set({ amount: operation.amount + 1 })
        .where(eq(schema.refundOperations.id, operation.id)),
    ).rejects.toThrow();
    await expect(
      db
        .insert(schema.refundOperations)
        .values({ ...operation, id: randomUUID(), idempotencyKey: "bad-key" }),
    ).rejects.toThrow();
    const id = randomUUID();
    await expect(
      db
        .insert(schema.refundOperations)
        .values({ ...operation, id, idempotencyKey: `appointment-refund:${id}:v1` }),
    ).rejects.toThrow();
    await expect(
      db
        .update(schema.refundOperations)
        .set({
          state: "succeeded",
          stripeRefundId: "re_fake",
          stripeStatus: "succeeded",
          succeededAt: new Date(),
        })
        .where(eq(schema.refundOperations.id, operation.id)),
    ).rejects.toThrow();
    await expect(
      db
        .update(schema.bookings)
        .set({ paymentStatus: "refunded" })
        .where(eq(schema.bookings.id, paid.booking.id)),
    ).rejects.toThrow();
    await expect(
      db.delete(schema.refundOperations).where(eq(schema.refundOperations.id, operation.id)),
    ).rejects.toThrow();
    expect((await load(operation.id)).state).toBe("owed");
  });
  it("database guards bind refund identifiers once and preserve terminal success", async () => {
    const { operation } = await owed();
    await executeRefundOperation(operation.id, db);
    const saved = await load(operation.id);
    await expect(
      db
        .update(schema.refundOperations)
        .set({ stripeRefundId: "re_other" })
        .where(eq(schema.refundOperations.id, operation.id)),
    ).rejects.toThrow();
    await expect(
      db
        .update(schema.refundOperations)
        .set({ firstSubmittedAt: new Date(saved.firstSubmittedAt!.getTime() + 1) })
        .where(eq(schema.refundOperations.id, operation.id)),
    ).rejects.toThrow();
    await expect(
      db
        .update(schema.refundOperations)
        .set({ state: "owed" })
        .where(eq(schema.refundOperations.id, operation.id)),
    ).rejects.toThrow();
  });
  it("another organization or an excessive amount cannot become refund truth", async () => {
    const { operation } = await owed();
    const otherOrg = randomUUID();
    await db
      .insert(schema.organizations)
      .values({ id: otherOrg, name: "Other", slug: randomUUID() });
    for (const override of [{ organizationId: otherOrg }, { amount: operation.amount + 1 }]) {
      const id = randomUUID();
      await expect(
        db
          .insert(schema.refundOperations)
          .values({ ...operation, ...override, id, idempotencyKey: `appointment-refund:${id}:v1` }),
      ).rejects.toThrow();
    }
  });
  it("external or partial refunds require review; full-refund recovery never calculates a remainder", async () => {
    const { operation } = await owed();
    const external = fixtureRefundEvidence(operation);
    external.refund.metadata = {};
    mock.list.mockResolvedValueOnce([external.refund]);
    expect(await executeRefundOperation(operation.id, db)).toBe("requires_review");
    expect(mock.create).not.toHaveBeenCalled();
  });
  it("cancellation API helper reports processing and repeat requests drive incomplete refunds", async () => {
    const paid = await fresh();
    mock.create.mockRejectedValueOnce(new Error("timeout"));
    expect(await cancelBookingWithResult(paid.booking.uid)).toEqual({
      changed: true,
      refund: "processing",
    });
    expect(await cancelBookingWithResult(paid.booking.uid)).toEqual({
      changed: false,
      refund: "refunded",
    });
    expect(mock.legacyRefund).not.toHaveBeenCalled();
  });
  it("cleanup failure cannot undo a committed cancellation/refund", async () => {
    const paid = await fresh();
    mock.cleanup.mockRejectedValueOnce(new Error("calendar offline"));
    expect(await cancelBookingWithResult(paid.booking.uid)).toEqual({
      changed: true,
      refund: "refunded",
    });
    expect(
      (await db.query.refundOperations.findFirst({
        where: eq(schema.refundOperations.bookingId, paid.booking.id),
      }))!.state,
    ).toBe("succeeded");
  });
  it("legacy cash cancellation remains separate and never fabricates a durable operation", async () => {
    const start = new Date(Date.UTC(2027, 0, 1) + sequence++ * 3600000);
    const [booking] = await db
      .insert(schema.bookings)
      .values({
        uid: randomUUID(),
        organizationId,
        eventTypeId,
        hostId: ownerId,
        title: "Legacy",
        startsAt: start,
        endsAt: new Date(start.getTime() + 1800000),
        timezone: "UTC",
        paymentIntentId: "pi_legacy",
        paymentStatus: "paid",
        amountPaid: 2000,
        paymentCurrency: "usd",
        destinationAccountId: "acct_legacy",
      })
      .returning();
    mock.legacyRefund.mockResolvedValueOnce(true);
    expect(await cancelBookingWithResult(booking!.uid)).toEqual({
      changed: true,
      refund: "refunded",
    });
    expect(mock.legacyRefund).toHaveBeenCalledWith("pi_legacy", true);
    expect(
      await db.query.refundOperations.findFirst({
        where: eq(schema.refundOperations.bookingId, booking!.id),
      }),
    ).toBeUndefined();
  });
});
