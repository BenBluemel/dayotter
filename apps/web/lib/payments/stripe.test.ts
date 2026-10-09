import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { paymentRoutingConfig, resolvePaymentRoute } from "./routing";

const mocks = vi.hoisted(() => ({
  checkout: vi.fn(),
  retrieve: vi.fn(),
  intent: vi.fn(),
  sessions: vi.fn(),
  account: vi.fn(),
  refund: vi.fn(),
  refundRead: vi.fn(),
  refundList: vi.fn(),
  charge: vi.fn(),
  balance: vi.fn(),
  payout: vi.fn(),
  webhook: vi.fn(),
  env: {} as Record<string, string | undefined>,
}));
vi.mock("../server/env", () => ({ env: mocks.env }));
vi.mock("stripe", () => ({
  default: class {
    checkout = {
      sessions: { create: mocks.checkout, retrieve: mocks.retrieve, list: mocks.sessions },
    };
    paymentIntents = { retrieve: mocks.intent };
    accounts = { retrieve: mocks.account };
    refunds = { create: mocks.refund, retrieve: mocks.refundRead, list: mocks.refundList };
    charges = { retrieve: mocks.charge };
    balance = { retrieve: mocks.balance };
    payouts = { create: mocks.payout };
    webhooks = { constructEvent: mocks.webhook };
  },
}));
import { directRefundAttempt, fixtureRefundOperation } from "./refund-fixtures";
import {
  connectedBalances,
  constructWebhookEvent,
  createCheckoutSession,
  createConnectedPayout,
  createOperationRefund,
  createSubscriptionCheckout,
  listOperationRefunds,
  refundPayment,
  retrieveOperationRefund,
  retrievePaymentIntent,
  retrieveSession,
  sessionForPaymentIntent,
} from "./stripe";

const organizationId = "00000000-0000-4000-8000-000000000001";
const originalEncryptionKey = process.env.ENCRYPTION_KEY;
afterAll(() => {
  if (originalEncryptionKey === undefined) Reflect.deleteProperty(process.env, "ENCRYPTION_KEY");
  else process.env.ENCRYPTION_KEY = originalEncryptionKey;
});
const ready = { accountId: "acct_host", chargesEnabled: true, transfersEnabled: true };
const params = {
  amount: 5000,
  currency: "usd",
  productName: "Appointment",
  successUrl: "https://example.test/paid",
  cancelUrl: "https://example.test/cancel",
  metadata: { token: "token", dest: "acct_stale", paymentMode: "connect" },
};
const route = () =>
  resolvePaymentRoute(paymentRoutingConfig(mocks.env), {
    organizationId,
    amount: params.amount,
    destination: ready,
  });

beforeEach(() => {
  process.env.ENCRYPTION_KEY = "ab".repeat(32);
  vi.clearAllMocks();
  for (const key of Object.keys(mocks.env)) delete mocks.env[key];
  Object.assign(mocks.env, {
    NODE_ENV: "test",
    STRIPE_PAYMENT_MODE: "direct",
    STRIPE_PAYMENT_ENVIRONMENT: "test",
    STRIPE_SECRET_KEY: "sk_test_fixture",
    STRIPE_WEBHOOK_SECRET: "whsec_fixture",
    STRIPE_ACCOUNT_ID: "acct_merchant",
    STRIPE_DIRECT_ORGANIZATION_ID: organizationId,
    STRIPE_PLATFORM_FEE_PERCENT: "5",
  });
  mocks.checkout.mockResolvedValue({ id: "cs_fixture", url: "https://checkout.example.test" });
  mocks.refund.mockResolvedValue({ id: "re_fixture" });
  mocks.retrieve.mockResolvedValue({ id: "cs_historical" });
  mocks.account.mockImplementation(async (id?: string) =>
    id
      ? { id, charges_enabled: true, capabilities: { transfers: "active" } }
      : { id: "acct_merchant" },
  );
});

describe("durable refund SDK boundary", () => {
  it.each(["direct", "connect", "connect-zero"])(
    "uses immutable %s route, fee and Stripe key despite deployment changes",
    async (mode) => {
      const operation = fixtureRefundOperation(
        mode === "direct" ? directRefundAttempt() : undefined,
      );
      operation.chargeAccountId = "acct_merchant";
      if (mode === "connect-zero") operation.applicationFeeAmount = 0;
      operation.firstSubmittedAt = new Date();
      mocks.env.STRIPE_PAYMENT_MODE = "disabled";
      mocks.env.STRIPE_ACCOUNT_ID = "acct_new_deployment";
      mocks.env.STRIPE_PLATFORM_FEE_PERCENT = "99";
      await createOperationRefund(operation);
      const [request, options] = mocks.refund.mock.calls[0]!;
      expect(request).toEqual({
        charge: operation.chargeId,
        amount: operation.amount,
        reason: "requested_by_customer",
        metadata: { refundOperationId: operation.id, paymentAttemptId: operation.attemptId },
        ...(mode === "direct" ? {} : { reverse_transfer: true }),
        ...(mode === "connect" ? { refund_application_fee: true } : {}),
      });
      expect(options).toEqual({ idempotencyKey: operation.idempotencyKey });
      await createOperationRefund(operation);
      expect(mocks.refund.mock.calls[1]![1]).toEqual(options);
      expect(options).not.toHaveProperty("stripeAccount");
    },
  );
  it("retrieves known refunds under the original account with reversal evidence", async () => {
    const operation = fixtureRefundOperation(directRefundAttempt());
    operation.chargeAccountId = "acct_merchant";
    mocks.refundRead.mockResolvedValue({ id: "re_saved" });
    mocks.charge.mockResolvedValue({ id: operation.chargeId });
    const evidence = await retrieveOperationRefund(operation, "re_saved");
    expect(evidence.chargeAccountId).toBe("acct_merchant");
    expect(mocks.refundRead).toHaveBeenCalledWith("re_saved", { expand: ["transfer_reversal"] });
    expect(mocks.charge).toHaveBeenCalledWith(operation.chargeId, {
      expand: ["transfer", "application_fee"],
    });
  });
  it("refuses new creation after the replay window and refuses another merchant/environment", async () => {
    const operation = fixtureRefundOperation(directRefundAttempt());
    operation.chargeAccountId = "acct_merchant";
    operation.firstSubmittedAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await expect(createOperationRefund(operation)).rejects.toMatchObject({ status: 409 });
    operation.firstSubmittedAt = new Date();
    mocks.account.mockResolvedValue({ id: "acct_other" });
    await expect(createOperationRefund(operation)).rejects.toThrow("expected charge account");
    mocks.env.STRIPE_SECRET_KEY = "sk_live_fixture";
    await expect(createOperationRefund(operation)).rejects.toThrow("expected payment environment");
    expect(mocks.refund).not.toHaveBeenCalled();
  });
  it("lists refunds by original charge, rejects incomplete listing and sanitizes errors", async () => {
    const operation = fixtureRefundOperation(directRefundAttempt());
    operation.chargeAccountId = "acct_merchant";
    mocks.refundList.mockResolvedValue({ data: [], has_more: false });
    await expect(listOperationRefunds(operation)).resolves.toEqual([]);
    expect(mocks.refundList).toHaveBeenCalledWith({ charge: operation.chargeId, limit: 100 });
    mocks.refundList.mockResolvedValue({ data: [], has_more: true });
    await expect(listOperationRefunds(operation)).rejects.toMatchObject({ status: 409 });
    operation.firstSubmittedAt = new Date();
    mocks.refund.mockRejectedValue(new Error(`Invalid API key: ${mocks.env.STRIPE_SECRET_KEY}`));
    const error = await createOperationRefund(operation).catch((value: unknown) => value);
    expect(String(error)).not.toContain(mocks.env.STRIPE_SECRET_KEY);
    expect(error).not.toHaveProperty("cause");
  });
});

it("verifies the original merchant and expands the charge while current sales are disabled", async () => {
  const saved = route();
  mocks.env.STRIPE_PAYMENT_MODE = "disabled";
  mocks.env.STRIPE_ACCOUNT_ID = "acct_new_deployment";
  mocks.env.STRIPE_PAYMENT_ENVIRONMENT = "live";
  mocks.intent.mockResolvedValue({ id: "pi_saved" });
  await expect(retrievePaymentIntent("pi_saved", saved)).resolves.toMatchObject({ id: "pi_saved" });
  expect(mocks.intent).toHaveBeenCalledWith("pi_saved", { expand: ["latest_charge"] });
  mocks.account.mockResolvedValue({ id: "acct_wrong" });
  await expect(retrievePaymentIntent("pi_saved", saved)).rejects.toThrow("expected charge account");
});
it("new payment verification errors do not expose Stripe credential details", async () => {
  const saved = route();
  mocks.intent.mockRejectedValue(new Error(`Invalid API key: ${mocks.env.STRIPE_SECRET_KEY}`));
  const error = await retrievePaymentIntent("pi_saved", saved).catch((value: unknown) => value);
  expect(String(error)).not.toContain(mocks.env.STRIPE_SECRET_KEY);
  expect(error).toMatchObject({ status: 503 });
  expect(error).not.toHaveProperty("cause");
  mocks.sessions.mockRejectedValue(new Error(`Invalid API key: ${mocks.env.STRIPE_SECRET_KEY}`));
  const relationshipError = await sessionForPaymentIntent("pi_saved", saved).catch(
    (value: unknown) => value,
  );
  expect(String(relationshipError)).not.toContain(mocks.env.STRIPE_SECRET_KEY);
  expect(relationshipError).toMatchObject({ status: 503 });
});

it("looks up the unique Checkout Session under saved context, without connected-account headers", async () => {
  const saved = route();
  mocks.env.STRIPE_PAYMENT_MODE = "disabled";
  mocks.sessions.mockResolvedValue({ data: [{ id: "cs_saved" }], has_more: false });
  await expect(sessionForPaymentIntent("pi_saved", saved)).resolves.toMatchObject({
    id: "cs_saved",
  });
  expect(mocks.sessions).toHaveBeenCalledWith({ payment_intent: "pi_saved", limit: 2 });
});
it("distinguishes an unavailable relationship from contradictory duplicate Sessions", async () => {
  const saved = route();
  mocks.sessions.mockResolvedValue({ data: [], has_more: false });
  await expect(sessionForPaymentIntent("pi_saved", saved)).rejects.toMatchObject({ status: 503 });
  mocks.sessions.mockResolvedValue({ data: [{ id: "cs_one" }, { id: "cs_two" }], has_more: false });
  await expect(sessionForPaymentIntent("pi_saved", saved)).rejects.toMatchObject({ status: 409 });
});

describe("Stripe routing at the SDK boundary", () => {
  it("rejects live credentials outside production on legacy retrieval and Pro checkout", async () => {
    mocks.env.STRIPE_PAYMENT_MODE = "disabled";
    mocks.env.STRIPE_SECRET_KEY = "sk_live_fixture";
    await expect(retrieveSession("cs_legacy")).rejects.toThrow("production runtime");
    await expect(
      createSubscriptionCheckout({
        organizationId,
        quantity: 1,
        successUrl: params.successUrl,
        cancelUrl: params.cancelUrl,
      }),
    ).rejects.toThrow("production runtime");
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.checkout).not.toHaveBeenCalled();
  });

  it("preserves independent Pro billing with test credentials while booking sales are disabled", async () => {
    mocks.env.STRIPE_PAYMENT_MODE = "disabled";
    await expect(
      createSubscriptionCheckout({
        organizationId,
        quantity: 1,
        successUrl: params.successUrl,
        cancelUrl: params.cancelUrl,
      }),
    ).resolves.toMatchObject({ url: "https://checkout.example.test" });
    const [request, options] = mocks.checkout.mock.calls[0]!;
    expect(request.mode).toBe("subscription");
    expect(request).not.toHaveProperty("payment_intent_data");
    expect(request.subscription_data).not.toHaveProperty("application_fee_percent");
    expect(request.subscription_data).not.toHaveProperty("transfer_data");
    expect(options).toBeUndefined();
  });

  it("fails closed on account-read failure without exposing credential details", async () => {
    const saved = route();
    mocks.account.mockRejectedValue(new Error(`Invalid API key: ${mocks.env.STRIPE_SECRET_KEY}`));
    const error = await createCheckoutSession({ ...params, route: saved }).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("account-read access");
    expect(String(error)).not.toContain(mocks.env.STRIPE_SECRET_KEY);
    expect(error).not.toHaveProperty("cause");
    expect(mocks.checkout).not.toHaveBeenCalled();
  });

  it.each(["acct_merchant", "invalid", "", undefined as unknown as string])(
    "rejects platform/invalid Connect balance and payout targets: %s",
    async (accountId) => {
      mocks.env.STRIPE_PAYMENT_MODE = "connect";
      await expect(connectedBalances(accountId)).rejects.toThrow("separate valid");
      await expect(createConnectedPayout(accountId, 10000, "usd")).rejects.toThrow(
        "separate valid",
      );
      expect(mocks.balance).not.toHaveBeenCalled();
      expect(mocks.payout).not.toHaveBeenCalled();
      expect(mocks.account).not.toHaveBeenCalled();
    },
  );

  it("never sends Connect fields/headers or stale destination metadata for direct payments", async () => {
    const direct = { ...route(), destinationAccountId: "acct_stale", applicationFeeAmount: 999 };
    await createCheckoutSession({ ...params, route: direct });
    expect(mocks.checkout).toHaveBeenCalledTimes(1);
    const [request, options] = mocks.checkout.mock.calls[0]!;
    expect(options).toBeUndefined();
    expect(request.payment_intent_data).not.toHaveProperty("transfer_data");
    expect(request.payment_intent_data).not.toHaveProperty("application_fee_amount");
    expect(request).not.toHaveProperty("on_behalf_of");
    expect(request.metadata).not.toHaveProperty("dest");
    expect(request.metadata).toMatchObject({
      paymentMode: "direct",
      chargeAccountId: "acct_merchant",
      organizationId,
    });
    expect(request.payment_intent_data.metadata).toEqual(request.metadata);
    expect(mocks.account).toHaveBeenCalledTimes(1);
    expect(mocks.account).toHaveBeenCalledWith();
  });

  it("passes immutable attempt identity, exact expiration, and Stripe idempotency without Connect headers", async () => {
    await createCheckoutSession({
      ...params,
      route: route(),
      idempotencyKey: "appointment-checkout:attempt:v1",
      expiresAt: 1790848800,
      clientReferenceId: "attempt",
    });
    const [request, options] = mocks.checkout.mock.calls[0]!;
    expect(request).toMatchObject({ expires_at: 1790848800, client_reference_id: "attempt" });
    expect(options).toEqual({ idempotencyKey: "appointment-checkout:attempt:v1" });
    expect(request.payment_intent_data).not.toHaveProperty("transfer_data");
  });

  it("retains Connect destination and fee without connected-account headers", async () => {
    mocks.env.STRIPE_PAYMENT_MODE = "connect";
    await createCheckoutSession({ ...params, route: route() });
    const [request, options] = mocks.checkout.mock.calls[0]!;
    expect(options).toBeUndefined();
    expect(request.payment_intent_data).toMatchObject({
      transfer_data: { destination: "acct_host" },
      application_fee_amount: 250,
    });
    expect(request.metadata.dest).toBe("acct_host");
  });

  it.each([
    { charges_enabled: false, capabilities: { transfers: "active" } },
    { charges_enabled: true, capabilities: { transfers: "inactive" } },
  ])("rechecks actual Connect capability state before checkout: %j", async (state) => {
    mocks.env.STRIPE_PAYMENT_MODE = "connect";
    const saved = route();
    mocks.account.mockImplementation(async (id?: string) =>
      id ? { id, ...state } : { id: "acct_merchant" },
    );
    await expect(createCheckoutSession({ ...params, route: saved })).rejects.toThrow("not ready");
    expect(mocks.checkout).not.toHaveBeenCalled();
  });

  it("omits application-fee refund flags for a saved zero-fee Connect route", async () => {
    mocks.env.STRIPE_PAYMENT_MODE = "connect";
    mocks.env.STRIPE_PLATFORM_FEE_PERCENT = "0";
    const saved = route();
    mocks.env.STRIPE_PAYMENT_MODE = "direct";
    mocks.env.STRIPE_PLATFORM_FEE_PERCENT = "25";
    await expect(refundPayment("pi_zero_fee", saved)).resolves.toBe(true);
    expect(mocks.refund).toHaveBeenCalledWith({
      payment_intent: "pi_zero_fee",
      reverse_transfer: true,
    });
  });

  it("rejects cash checkout when disabled even with a previously resolved route", async () => {
    const saved = route();
    mocks.env.STRIPE_PAYMENT_MODE = "disabled";
    await expect(createCheckoutSession({ ...params, route: saved })).rejects.toThrow("disabled");
    expect(mocks.checkout).not.toHaveBeenCalled();
    expect(mocks.account).not.toHaveBeenCalled();
  });

  it("rejects another organization and a key belonging to another merchant", async () => {
    const saved = route();
    await expect(
      createCheckoutSession({
        ...params,
        route: { ...saved, organizationId: "00000000-0000-4000-8000-000000000002" },
      }),
    ).rejects.toThrow("cannot sell");
    mocks.account.mockResolvedValue({ id: "acct_other" });
    await expect(createCheckoutSession({ ...params, route: saved })).rejects.toThrow(
      "expected charge account",
    );
    expect(mocks.checkout).not.toHaveBeenCalled();
  });

  it("uses historical routes for refunds after a mode change, including disabled", async () => {
    const direct = route();
    mocks.env.STRIPE_PAYMENT_MODE = "connect";
    const connect = route();
    for (const mode of ["disabled", "direct", "connect"]) {
      mocks.env.STRIPE_PAYMENT_MODE = mode;
      await expect(retrieveSession("cs_historical", connect)).resolves.toMatchObject({
        id: "cs_historical",
      });
      await expect(refundPayment("pi_connect", connect)).resolves.toBe(true);
      await expect(refundPayment("pi_direct", direct)).resolves.toBe(true);
    }
    expect(mocks.refund.mock.calls.map(([request]) => request)).toEqual(
      Array.from({ length: 3 }, () => [
        { payment_intent: "pi_connect", reverse_transfer: true, refund_application_fee: true },
        { payment_intent: "pi_direct" },
      ]).flat(),
    );
  });

  it("rejects signed webhook events from the wrong test/live context even with new sales disabled", () => {
    mocks.env.STRIPE_PAYMENT_MODE = "disabled";
    mocks.webhook.mockReturnValue({ livemode: true });
    expect(() => constructWebhookEvent("payload", "signature")).toThrow("webhook environment");
    mocks.webhook.mockReturnValue({ livemode: false });
    expect(constructWebhookEvent("payload", "signature")).toEqual({ livemode: false });
  });

  it("retains legacy destination refund flags and gates connected balances in direct mode", async () => {
    await expect(refundPayment("pi_legacy", true)).resolves.toBe(true);
    expect(mocks.refund).toHaveBeenCalledWith({
      payment_intent: "pi_legacy",
      reverse_transfer: true,
      refund_application_fee: true,
    });
    await expect(connectedBalances("acct_stale")).rejects.toThrow("Connect is disabled");
    expect(mocks.balance).not.toHaveBeenCalled();
  });
});
