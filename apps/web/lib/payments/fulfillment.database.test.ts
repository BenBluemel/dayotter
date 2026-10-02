import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { decryptJson, encryptJson, sha256hex } from "@dayotter/core";
import { createDatabase, eq, schema } from "@dayotter/db";
import type Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureAttempt, fixturePaidSession, fixturePaymentIntent } from "./attempt-fixtures";
import type { PaymentAttempt } from "./attempt-terms";

const mock = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof createDatabase>,
  session: vi.fn(),
  pi: vi.fn(),
  piSession: vi.fn(),
  finalize: vi.fn(),
  slots: vi.fn(),
}));
vi.mock("@dayotter/db", async (original) => ({
  ...(await original<typeof import("@dayotter/db")>()),
  getDb: () => mock.db,
}));
vi.mock("../server/env", () => ({ env: { APP_URL: "https://example.test" } }));
vi.mock("./connect", () => ({
  checkoutRouteForOrganization: async (organizationId: string) => ({
    mode: "direct",
    organizationId,
    environment: "test",
    chargeAccountId: "acct_merchant",
    credentialContext: "primary",
  }),
}));
vi.mock("./stripe", () => ({
  retrieveSession: mock.session,
  retrievePaymentIntent: mock.pi,
  sessionForPaymentIntent: mock.piSession,
  createCheckoutSession: vi.fn(),
  refundPayment: vi.fn(),
}));
vi.mock("../booking/finalize-booking", () => ({ finalizeConfirmedBooking: mock.finalize }));
vi.mock("../booking/availability", () => ({
  SLOT_REVALIDATION_WINDOW_MS: 60000,
  isAllowedDuration: () => true,
  eventTypeHostSlots: mock.slots,
  combineHostSlots: (perHost: unknown[][]) => perHost.flat(),
}));
vi.mock("@dayotter/emails", () => ({
  sendEmail: vi.fn(),
  bookingRequested: vi.fn(),
  newBookingRequest: vi.fn(),
}));
import { createBooking } from "../booking/create-booking";
import { appointmentRequestIdentity, canonicalJson, decodeAttempt } from "./attempt-terms";
import { bindAttemptSession, prepareAppointmentAttempt } from "./attempts";
import { fulfillCheckout } from "./fulfill";
import { processAppointmentEvent, receiveAppointmentEvent } from "./payment-events";
import { finalizePaymentBooking } from "./payment-finalization";
import {
  fulfillObservedPayment,
  observePaymentSuccess,
  requirePaymentReview,
} from "./payment-work";
import { recoverAppointmentPayments } from "./recovery";

const testUrl = process.env.PAYMENTS_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("durable fulfillment PostgreSQL integration", () => {
  const databaseName = `dayotter_payments_test_${randomUUID().replaceAll("-", "")}`;
  let admin: ReturnType<typeof createDatabase>;
  let db: ReturnType<typeof createDatabase>;
  let created = false;
  const oldKey = process.env.ENCRYPTION_KEY;
  const organizationId = randomUUID();
  const ownerId = randomUUID();
  const eventTypeId = randomUUID();
  let sequence = 0;
  let legacyId: string;
  let legacyUid: string;
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
    mock.db = db;
    const directory = new URL("../../../../packages/db/drizzle/", import.meta.url);
    const journal = JSON.parse(
      await readFile(new URL("meta/_journal.json", directory), "utf8"),
    ) as { entries: { tag: string }[] };
    for (const { tag } of journal.entries) {
      if (tag === "0065_payment_fulfillment") {
        await seedTenant();
        await seedSlice2Booking();
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
  async function seedTenant() {
    await db
      .insert(schema.organizations)
      .values({ id: organizationId, name: "Test merchant", slug: randomUUID() });
    await db.insert(schema.users).values({ id: ownerId, email: "host@example.test" });
    await db.insert(schema.eventTypes).values({
      id: eventTypeId,
      organizationId,
      ownerId,
      slug: "test",
      title: "Test",
      price: 5000,
      currency: "usd",
      durationMinutes: 30,
      location: "in_person",
      locationDetail: "Test room",
    });
  }
  async function seedSlice2Booking() {
    const original = fixtureAttempt();
    const input = { ...decodeAttempt(original).input, eventTypeId };
    const quote = { ...(original.quote as object), organizationId, eventTypeId } as ReturnType<
      typeof decodeAttempt
    >["quote"];
    const legacy = {
      ...original,
      organizationId,
      eventTypeId,
      quote,
      quoteHash: sha256hex(canonicalJson(quote)),
      bookingIntent: encryptJson({ input, returnPath: "/", resolvedDurationMinutes: 30 }),
      requestFingerprint: appointmentRequestIdentity(input, "/").fingerprint,
    };
    legacyId = legacy.id;
    legacyUid = randomUUID();
    // Raw insert uses only 0064 columns: this fixture genuinely predates 0065.
    const keys = [
      "id",
      "requestKey",
      "requestFingerprint",
      "purpose",
      "organizationId",
      "eventTypeId",
      "bookingIntent",
      "quote",
      "quoteHash",
      "amount",
      "currency",
      "settlement",
      "expectedPaymentStatus",
      "paymentMode",
      "environment",
      "chargeAccountId",
      "credentialContext",
      "destinationAccountId",
      "applicationFeeAmount",
      "productName",
      "successUrl",
      "cancelUrl",
      "expiresAt",
      "creationDeadline",
      "createdAt",
    ] as const;
    const columns = keys.map((key) =>
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
    );
    await db.$client.query(
      `INSERT INTO payment_attempts (${columns.join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")})`,
      keys.map((key) => (key === "quote" ? JSON.stringify(legacy[key]) : legacy[key])),
    );
    const { persistBookingPricingSnapshot } = await import("../booking/pricing");
    const bookingId = randomUUID();
    const session = fixturePaidSession(legacy);
    await db.transaction(async (tx) => {
      await tx.insert(schema.bookings).values({
        id: bookingId,
        uid: legacyUid,
        organizationId,
        eventTypeId,
        hostId: ownerId,
        title: "Historical",
        startsAt: new Date(input.start),
        endsAt: new Date(new Date(input.start).getTime() + 1800000),
        timezone: "UTC",
      });
      await persistBookingPricingSnapshot(bookingId, quote, tx);
      await tx
        .update(schema.bookings)
        .set({
          paymentStatus: "paid",
          paymentIntentId: session.payment_intent as string,
          amountPaid: legacy.amount,
          paymentCurrency: legacy.currency,
          destinationAccountId: legacy.destinationAccountId,
        })
        .where(eq(schema.bookings.id, bookingId));
      await tx
        .update(schema.paymentAttempts)
        .set({
          state: "fulfilled",
          bookingId,
          checkoutSessionId: session.id,
          paymentIntentId: session.payment_intent as string,
        })
        .where(eq(schema.paymentAttempts.id, legacy.id));
    });
  }
  afterAll(async () => {
    if (db) await db.$client.end();
    if (created) await admin.$client.query(`DROP DATABASE "${databaseName}"`);
    if (admin) await admin.$client.end();
    if (oldKey === undefined) Reflect.deleteProperty(process.env, "ENCRYPTION_KEY");
    else process.env.ENCRYPTION_KEY = oldKey;
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mock.finalize.mockResolvedValue(undefined);
  });
  async function fresh() {
    const start = new Date(Date.UTC(2026, 10, 1) + sequence++ * 3600000);
    const input = {
      eventTypeId,
      start: start.toISOString(),
      attendee: { name: "Client", email: "client@example.test", timezone: "UTC" },
    };
    const { attempt } = await prepareAppointmentAttempt(input, "/", randomUUID(), db);
    const session = fixturePaidSession(attempt!);
    const pi = fixturePaymentIntent(attempt!, session);
    mock.session.mockResolvedValue(session);
    mock.pi.mockResolvedValue(pi);
    mock.piSession.mockResolvedValue(session);
    mock.slots.mockResolvedValue({
      hostIds: [ownerId],
      perHost: [[{ start, end: new Date(start.getTime() + 1800000) }]],
    });
    return { attempt: attempt!, session, pi };
  }
  function event(
    session: Stripe.Checkout.Session,
    type = "checkout.session.completed",
  ): Stripe.Event {
    return {
      id: `evt_${randomUUID().replaceAll("-", "")}`,
      type,
      livemode: false,
      data: { object: session },
    } as Stripe.Event;
  }
  const load = (id: string) =>
    db.query.paymentAttempts.findFirst({ where: eq(schema.paymentAttempts.id, id) });

  it("0065 preserves historical Slice 2 booking bindings without fabricating success or finalization", async () => {
    const legacy = (await load(legacyId))!;
    expect(legacy).toMatchObject({
      state: "fulfilled",
      successFacts: null,
      paymentSucceededAt: null,
      finalizationContext: null,
      finalizationState: null,
    });
    expect(await fulfillObservedPayment(legacyId, db)).toMatchObject({ uid: legacyUid });
    expect(mock.finalize).not.toHaveBeenCalled();
  });
  it("concurrent deliveries of the same receipt cannot duplicate a booking", async () => {
    const { attempt, session } = await fresh();
    const receipt = (await receiveAppointmentEvent(event(session), db))!;
    const results = await Promise.all([
      processAppointmentEvent(receipt, db),
      processAppointmentEvent(receipt, db),
    ]);
    expect(results.every((result) => ["fulfilled", "already_fulfilled"].includes(result))).toBe(
      true,
    );
    expect((await load(attempt.id))!.bookingId).not.toBeNull();
    expect(mock.finalize).toHaveBeenCalledTimes(1);
  });
  it("duplicate success events save one observation and booking; Redis is unnecessary", async () => {
    const { attempt, session } = await fresh();
    const e = event(session);
    const first = await receiveAppointmentEvent(e, db);
    const second = await receiveAppointmentEvent(e, db);
    expect(first).toBe(second);
    expect(await processAppointmentEvent(first!, db)).toBe("fulfilled");
    expect(await processAppointmentEvent(second!, db)).toBe("already_fulfilled");
    const saved = await load(attempt.id);
    expect(saved).toMatchObject({
      state: "fulfilled",
      finalizationState: "attempted",
      successFacts: { amount: 5000 },
    });
    expect(saved!.finalizationContext).not.toContain("client@example.test");
    expect(mock.finalize).toHaveBeenCalledTimes(1);
    const snapshot = await db.query.bookingPricingSnapshots.findFirst({
      where: eq(schema.bookingPricingSnapshots.bookingId, saved!.bookingId!),
    });
    expect(snapshot!.effectivePrice).toBe(5000);
    const receipt = await db.query.paymentEvents.findFirst({
      where: eq(schema.paymentEvents.id, first!),
    });
    expect(receipt!.payload).not.toContain("client@example.test");
    expect(decryptJson<Stripe.Event>(receipt!.payload).id).toBe(e.id);
  });
  it("concurrent fulfillment cannot create two bookings or invoke finalization twice", async () => {
    const { attempt, session } = await fresh();
    await observePaymentSuccess(attempt, session, db);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => fulfillObservedPayment(attempt.id, db)),
    );
    expect(new Set(results.map((r) => r!.uid)).size).toBe(1);
    expect(results.every((r) => r!.uid)).toBe(true);
    expect(mock.finalize).toHaveBeenCalledTimes(1);
  });
  it("browser and webhook reconciliation race safely", async () => {
    const { attempt, session } = await fresh();
    await bindAttemptSession(attempt, session, db);
    const receipt = await receiveAppointmentEvent(event(session), db);
    const [webhook, browser] = await Promise.all([
      processAppointmentEvent(receipt!, db),
      fulfillCheckout(session.id),
    ]);
    expect(["fulfilled", "already_fulfilled"]).toContain(webhook);
    expect(browser.uid).toBeTruthy();
    expect(mock.finalize).toHaveBeenCalledTimes(1);
  });
  it("a stale creation-ambiguity decision cannot erase an observed success", async () => {
    const { attempt, session } = await fresh();
    await observePaymentSuccess(attempt, session, db);
    await requirePaymentReview(attempt.id, "creation_ambiguous", db);
    expect((await load(attempt.id))!.state).toBe("payment_succeeded");
    await fulfillObservedPayment(attempt.id, db);
  });
  it("recovery resumes a crash after observation, without another Stripe read", async () => {
    const { attempt, session } = await fresh();
    await observePaymentSuccess(attempt, session, db);
    mock.session.mockRejectedValue(new Error("API offline"));
    mock.pi.mockRejectedValue(new Error("API offline"));
    await recoverAppointmentPayments(100, db);
    expect((await load(attempt.id))!.state).toBe("fulfilled");
  });
  it("booking transaction failure rolls back binding and leaves the paid obligation retryable", async () => {
    const { attempt, session } = await fresh();
    await observePaymentSuccess(attempt, session, db);
    await db.$client.query(
      `CREATE FUNCTION fail_test_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${attempt.id}' AND NEW.booking_id IS NOT NULL THEN RAISE EXCEPTION 'temporary DB failure'; END IF; RETURN NEW; END; $$; CREATE TRIGGER zz_test_binding BEFORE UPDATE ON payment_attempts FOR EACH ROW EXECUTE FUNCTION fail_test_binding()`,
    );
    try {
      expect(await fulfillObservedPayment(attempt.id, db)).toMatchObject({
        uid: null,
        state: "payment_succeeded",
      });
      expect((await load(attempt.id))!.bookingId).toBeNull();
    } finally {
      await db.$client.query(
        "DROP TRIGGER zz_test_binding ON payment_attempts; DROP FUNCTION fail_test_binding()",
      );
    }
    expect((await fulfillObservedPayment(attempt.id, db))!.uid).toBeTruthy();
  });
  it("retry after booking commit resumes pending finalization without recreating the booking", async () => {
    const { attempt, session } = await fresh();
    const observed = await observePaymentSuccess(attempt, session, db);
    const terms = decodeAttempt(observed);
    const booking = await createBooking({
      ...terms.input,
      paymentAttemptId: attempt.id,
      pricingQuote: terms.quote,
      quotedDurationMinutes: terms.resolvedDurationMinutes,
      payment: {
        paymentIntentId: observed.paymentIntentId!,
        amountPaid: observed.amount,
        currency: observed.currency,
      },
    });
    expect((await load(attempt.id))!.finalizationState).toBe("pending");
    expect(mock.finalize).not.toHaveBeenCalled();
    expect((await fulfillObservedPayment(attempt.id, db))!.uid).toBe(booking.uid);
    expect(mock.finalize).toHaveBeenCalledTimes(1);
    expect((await fulfillObservedPayment(attempt.id, db))!.uid).toBe(booking.uid);
    expect(mock.finalize).toHaveBeenCalledTimes(1);
  });
  it("interrupted external finalization becomes discoverable review without replay", async () => {
    const { attempt, session } = await fresh();
    const observed = await observePaymentSuccess(attempt, session, db);
    const terms = decodeAttempt(observed);
    await createBooking({
      ...terms.input,
      paymentAttemptId: attempt.id,
      pricingQuote: terms.quote,
      quotedDurationMinutes: terms.resolvedDurationMinutes,
      payment: {
        paymentIntentId: observed.paymentIntentId!,
        amountPaid: observed.amount,
        currency: observed.currency,
      },
    });
    await db
      .update(schema.paymentAttempts)
      .set({
        finalizationState: "running",
        finalizationStartedAt: new Date(Date.now() - 11 * 60000),
      })
      .where(eq(schema.paymentAttempts.id, attempt.id));
    await finalizePaymentBooking(attempt.id, db);
    expect((await load(attempt.id))!.finalizationReviewCode).toBe(
      "interrupted_finalization_ambiguous",
    );
    expect(mock.finalize).not.toHaveBeenCalled();
    expect((await load(attempt.id))!.bookingId).not.toBeNull();
  });
  it("expiration does not discard the intent; a contradictory later success is still inspectable", async () => {
    const { attempt, session } = await fresh();
    const expired = {
      ...session,
      status: "expired" as const,
      payment_status: "unpaid" as const,
      payment_intent: null,
    };
    mock.session.mockResolvedValue(expired);
    const receipt = await receiveAppointmentEvent(event(expired, "checkout.session.expired"), db);
    expect(await processAppointmentEvent(receipt!, db)).toBe("waiting_payment");
    expect((await load(attempt.id))!.state).toBe("expired");
    mock.session.mockResolvedValue(session);
    expect(
      await processAppointmentEvent((await receiveAppointmentEvent(event(session), db))!, db),
    ).toBe("fulfilled");
  });
  it("post-commit finalization failure retains booking and records review, never a refund", async () => {
    const { attempt, session } = await fresh();
    await observePaymentSuccess(attempt, session, db);
    mock.finalize.mockRejectedValue(new Error("provider failure"));
    const first = await fulfillObservedPayment(attempt.id, db);
    expect(first!.uid).toBeTruthy();
    expect((await load(attempt.id))!.finalizationState).toBe("requires_review");
    expect((await fulfillObservedPayment(attempt.id, db))!.uid).toBe(first!.uid);
    expect(mock.finalize).toHaveBeenCalledTimes(1);
  });
  it("an active finalizer is not treated as a crash by concurrent callers", async () => {
    const { attempt, session } = await fresh();
    await observePaymentSuccess(attempt, session, db);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    mock.finalize.mockImplementation(() => {
      entered();
      return new Promise<void>((r) => {
        release = r;
      });
    });
    const first = fulfillObservedPayment(attempt.id, db);
    await started;
    await fulfillObservedPayment(attempt.id, db);
    expect((await load(attempt.id))!.finalizationState).toBe("running");
    release();
    await first;
    expect((await load(attempt.id))!.finalizationState).toBe("attempted");
    expect(mock.finalize).toHaveBeenCalledTimes(1);
  });
  it("booking availability failure records the paid obligation for review", async () => {
    const { attempt, session } = await fresh();
    await observePaymentSuccess(attempt, session, db);
    mock.slots.mockResolvedValue({ hostIds: [ownerId], perHost: [[]] });
    expect(await fulfillObservedPayment(attempt.id, db)).toMatchObject({
      uid: null,
      state: "requires_review",
    });
    expect((await load(attempt.id))!.successFacts).not.toBeNull();
  });
  it.each([
    ["amount", { amount_total: 1 }],
    ["currency", { currency: "eur" }],
    ["environment", { livemode: true }],
    ["account", { metadata: { chargeAccountId: "acct_other" } }],
  ])("contradictory %s requires review without creating a booking", async (_, override) => {
    const { attempt, session } = await fresh();
    const wrong = {
      ...session,
      ...override,
      metadata: { ...session.metadata, ...("metadata" in override ? override.metadata : {}) },
    } as Stripe.Checkout.Session;
    mock.session.mockResolvedValue(wrong);
    const id = await receiveAppointmentEvent(event(wrong), db);
    expect(await processAppointmentEvent(id!, db)).toBe("requires_review");
    expect((await load(attempt.id))!.bookingId).toBeNull();
  });
  it.each(["session", "intent"])("write-once %s conflicts are reviewable", async (kind) => {
    const { attempt, session } = await fresh();
    await bindAttemptSession(attempt, session, db);
    const wrong = {
      ...session,
      ...(kind === "session" ? { id: "cs_conflict" } : { payment_intent: "pi_conflict" }),
    };
    const id = await receiveAppointmentEvent(event(wrong), db);
    expect(await processAppointmentEvent(id!, db)).toBe("requires_review");
    expect((await load(attempt.id))!.bookingId).toBeNull();
  });
  it("one Stripe payment cannot satisfy two independent attempts", async () => {
    const first = await fresh();
    await observePaymentSuccess(first.attempt, first.session, db);
    await fulfillObservedPayment(first.attempt.id, db);
    const second = await fresh();
    const conflictingSession = { ...second.session, payment_intent: first.pi.id };
    mock.session.mockResolvedValue(conflictingSession);
    mock.pi.mockResolvedValue({
      ...second.pi,
      id: first.pi.id,
      latest_charge: { ...(second.pi.latest_charge as Stripe.Charge), payment_intent: first.pi.id },
    });
    const receipt = await receiveAppointmentEvent(event(conflictingSession), db);
    expect(await processAppointmentEvent(receipt!, db)).toBe("requires_review");
    expect((await load(second.attempt.id))!.bookingId).toBeNull();
  });
  it("transient Stripe retrieval failure retains the event and retries safely", async () => {
    const { attempt, session } = await fresh();
    const id = await receiveAppointmentEvent(event(session), db);
    mock.session.mockRejectedValueOnce(new Error("API down"));
    expect(await processAppointmentEvent(id!, db)).toBe("retry");
    expect((await load(attempt.id))!.bookingId).toBeNull();
    expect(await processAppointmentEvent(id!, db)).toBe("fulfilled");
  });
  it("delayed payments wait after Checkout completion, then fulfill on async success", async () => {
    const { attempt, session } = await fresh();
    const unpaid = { ...session, payment_status: "unpaid" as const };
    mock.session.mockResolvedValue(unpaid);
    const completed = await receiveAppointmentEvent(event(unpaid), db);
    expect(await processAppointmentEvent(completed!, db)).toBe("waiting_payment");
    expect((await load(attempt.id))!.successFacts).toBeNull();
    mock.session.mockResolvedValue(session);
    const succeeded = await receiveAppointmentEvent(
      event(session, "checkout.session.async_payment_succeeded"),
      db,
    );
    expect(await processAppointmentEvent(succeeded!, db)).toBe("fulfilled");
    expect(await processAppointmentEvent(completed!, db)).toBe("already_fulfilled");
  });
  it("an acknowledged unpaid receipt still re-drives later observed success after a crash", async () => {
    const { attempt, session } = await fresh();
    const unpaid = { ...session, payment_status: "unpaid" as const };
    mock.session.mockResolvedValue(unpaid);
    const receipt = (await receiveAppointmentEvent(event(unpaid), db))!;
    expect(await processAppointmentEvent(receipt, db)).toBe("waiting_payment");
    await observePaymentSuccess((await load(attempt.id))!, session, db);
    mock.session.mockRejectedValue(new Error("Stripe offline"));
    expect(await processAppointmentEvent(receipt, db)).toBe("already_fulfilled");
    expect((await load(attempt.id))!.bookingId).not.toBeNull();
  });
  it("incomplete PaymentIntent never satisfies success, even if Session says paid", async () => {
    const { attempt, session, pi } = await fresh();
    mock.pi.mockResolvedValue({ ...pi, status: "processing", amount_received: 0 });
    const id = await receiveAppointmentEvent(event(session), db);
    expect(await processAppointmentEvent(id!, db)).toBe("retry");
    expect((await load(attempt.id))!.successFacts).toBeNull();
  });
  it("asynchronous failure and expiration remain distinguishable from observed success", async () => {
    const { attempt, session } = await fresh();
    const unpaid = { ...session, payment_status: "unpaid" as const };
    mock.session.mockResolvedValue(unpaid);
    const failed = await receiveAppointmentEvent(
      event(unpaid, "checkout.session.async_payment_failed"),
      db,
    );
    expect(await processAppointmentEvent(failed!, db)).toBe("waiting_payment");
    expect((await load(attempt.id))!.state).toBe("payment_failed");
    mock.session.mockResolvedValue(session);
    expect(
      await processAppointmentEvent(
        (await receiveAppointmentEvent(
          event(session, "checkout.session.async_payment_succeeded"),
          db,
        ))!,
        db,
      ),
    ).toBe("fulfilled");
  });
  it("PaymentIntent events require an authenticated Session relationship", async () => {
    const { attempt, session, pi } = await fresh();
    const e = {
      ...event(session, "payment_intent.succeeded"),
      data: { object: pi },
    } as Stripe.Event;
    const id = await receiveAppointmentEvent(e, db);
    expect(await processAppointmentEvent(id!, db)).toBe("fulfilled");
    expect(mock.piSession).toHaveBeenCalledWith(
      pi.id,
      expect.objectContaining({ chargeAccountId: "acct_merchant" }),
    );
    expect((await load(attempt.id))!.paymentIntentId).toBe(pi.id);
  });
  it.each(["bound", "unbound"])(
    "missing metadata cannot downgrade a %s durable Session into Redis",
    async (binding) => {
      const { attempt, session } = await fresh();
      if (binding === "bound") await bindAttemptSession(attempt, session, db);
      const missing: Stripe.Checkout.Session = {
        ...session,
        metadata: binding === "unbound" ? { attemptId: "" } : {},
      };
      mock.session.mockResolvedValue(missing);
      const id = await receiveAppointmentEvent(event(missing), db);
      await expect(fulfillCheckout(session.id)).resolves.toMatchObject({
        state: "requires_review",
        uid: null,
      });
      expect(id).toBeTruthy();
      expect(await processAppointmentEvent(id!, db)).toBe("requires_review");
    },
  );
  it("legacy, unknown and malformed webhook relationships stay explicit", async () => {
    const { session } = await fresh();
    expect(
      await receiveAppointmentEvent(
        event({
          ...session,
          id: "cs_legacy",
          client_reference_id: null,
          metadata: { token: "legacy" },
        }),
        db,
      ),
    ).toBeNull();
    await expect(
      receiveAppointmentEvent(event({ ...session, metadata: { attemptId: "malformed" } }), db),
    ).rejects.toThrow("Malformed");
    await expect(
      receiveAppointmentEvent(event({ ...session, metadata: { attemptId: randomUUID() } }), db),
    ).rejects.toThrow("missing");
  });
  it("financial success facts, inbox facts, and progress are guarded in PostgreSQL", async () => {
    const { attempt, session } = await fresh();
    await observePaymentSuccess(attempt, session, db);
    const saved = (await load(attempt.id))!;
    const receipt = await receiveAppointmentEvent(event(session), db);
    await expect(
      db.insert(schema.paymentAttempts).values({
        ...saved,
        id: randomUUID(),
        requestKey: randomUUID(),
        checkoutSessionId: null,
        paymentIntentId: null,
        bookingId: null,
        successFacts: null,
        paymentSucceededAt: null,
        state: "requires_review",
      }),
    ).rejects.toThrow();
    await expect(
      db
        .update(schema.paymentAttempts)
        .set({ successFacts: { ...saved.successFacts!, chargeId: "ch_changed" } })
        .where(eq(schema.paymentAttempts.id, attempt.id)),
    ).rejects.toThrow();
    await expect(
      db
        .update(schema.paymentAttempts)
        .set({ state: "open" })
        .where(eq(schema.paymentAttempts.id, attempt.id)),
    ).rejects.toThrow();
    await expect(
      db
        .update(schema.paymentEvents)
        .set({ payload: encryptJson({ changed: true }) })
        .where(eq(schema.paymentEvents.id, receipt!)),
    ).rejects.toThrow();
    await expect(
      db.delete(schema.paymentEvents).where(eq(schema.paymentEvents.id, receipt!)),
    ).rejects.toThrow();
  });
  it("current mode changes do not alter durable route, quote or duration", async () => {
    const { attempt, session } = await fresh();
    const oldMode = process.env.STRIPE_PAYMENT_MODE;
    process.env.STRIPE_PAYMENT_MODE = "disabled";
    try {
      await db
        .update(schema.eventTypes)
        .set({ price: 9000 })
        .where(eq(schema.eventTypes.id, eventTypeId));
      await observePaymentSuccess(attempt, session, db);
      expect((await fulfillObservedPayment(attempt.id, db))!.uid).toBeTruthy();
      expect(mock.pi).toHaveBeenCalledWith(
        session.payment_intent,
        expect.objectContaining({ mode: "direct", chargeAccountId: "acct_merchant" }),
      );
    } finally {
      await db
        .update(schema.eventTypes)
        .set({ price: 5000 })
        .where(eq(schema.eventTypes.id, eventTypeId));
      if (oldMode === undefined) Reflect.deleteProperty(process.env, "STRIPE_PAYMENT_MODE");
      else process.env.STRIPE_PAYMENT_MODE = oldMode;
    }
  });
});
