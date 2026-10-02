import type Stripe from "stripe";
import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  construct: vi.fn(),
  receive: vi.fn(),
  process: vi.fn(),
  legacy: vi.fn(),
  packages: vi.fn(),
  account: vi.fn(),
}));
vi.mock("./stripe", () => ({ stripeConfigured: true, constructWebhookEvent: mock.construct }));
vi.mock("./payment-events", () => ({
  receiveAppointmentEvent: mock.receive,
  processAppointmentEvent: mock.process,
}));
vi.mock("./fulfill", () => ({ fulfillCheckout: mock.legacy }));
vi.mock("./connect", () => ({ syncConnectAccountStatus: mock.account }));
vi.mock("../packages/fulfill", () => ({ fulfillPackagePurchase: mock.packages }));
vi.mock("../billing/subscription", () => ({
  syncSubscriptionById: vi.fn(),
  syncOrgSubscription: vi.fn(),
}));
import { POST } from "../../app/api/webhooks/stripe/route";
const request = (signature = true) =>
  new Request("https://example.test/api/webhooks/stripe", {
    method: "POST",
    body: "signed fixture",
    headers: signature ? { "stripe-signature": "fixture" } : {},
  });
beforeEach(() => {
  vi.resetAllMocks();
  mock.construct.mockReturnValue({
    type: "checkout.session.completed",
    data: { object: { id: "cs_saved", metadata: { attemptId: "saved" } } },
  } as unknown as Stripe.Event);
  mock.receive.mockResolvedValue("receipt");
});
it("missing or invalid signatures never reach durable intake", async () => {
  expect((await POST(request(false))).status).toBe(400);
  mock.construct.mockImplementation(() => {
    throw new Error("bad signature");
  });
  expect((await POST(request())).status).toBe(400);
  expect(mock.receive).not.toHaveBeenCalled();
});
it.each(["fulfilled", "already_fulfilled", "waiting_payment", "requires_review"])(
  "acknowledges durably resolved %s",
  async (state) => {
    mock.process.mockResolvedValue(state);
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state });
    expect(mock.legacy).not.toHaveBeenCalled();
  },
);
it("transient or incomplete durable processing requests a Stripe retry", async () => {
  mock.process.mockResolvedValue("retry");
  expect((await POST(request())).status).toBe(500);
});
it("a database intake failure requests retry without claiming Redis", async () => {
  mock.receive.mockRejectedValue(new Error("DB offline"));
  expect((await POST(request())).status).toBe(500);
  expect(mock.legacy).not.toHaveBeenCalled();
});
it("legacy and package events retain their explicit existing boundary", async () => {
  mock.receive.mockResolvedValue(null);
  expect((await POST(request())).status).toBe(200);
  expect(mock.legacy).toHaveBeenCalledWith("cs_saved");
  mock.construct.mockReturnValue({
    type: "checkout.session.completed",
    data: { object: { metadata: { kind: "package" } } },
  });
  await POST(request());
  expect(mock.packages).toHaveBeenCalledTimes(1);
});
it("disabled sales mode does not gate signed historical event processing", async () => {
  const previous = process.env.STRIPE_PAYMENT_MODE;
  process.env.STRIPE_PAYMENT_MODE = "disabled";
  try {
    mock.process.mockResolvedValue("fulfilled");
    expect((await POST(request())).status).toBe(200);
    expect(mock.receive).toHaveBeenCalledTimes(1);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "STRIPE_PAYMENT_MODE");
    else process.env.STRIPE_PAYMENT_MODE = previous;
  }
});
