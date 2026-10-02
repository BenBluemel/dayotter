import type Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtureAttempt, fixturePaidSession, fixturePaymentIntent } from "./attempt-fixtures";
import { verifiedPaymentFacts } from "./payment-success";

const oldKey = process.env.ENCRYPTION_KEY;
beforeAll(() => {
  process.env.ENCRYPTION_KEY = "ab".repeat(32);
});
afterAll(() => {
  if (oldKey === undefined) Reflect.deleteProperty(process.env, "ENCRYPTION_KEY");
  else process.env.ENCRYPTION_KEY = oldKey;
});

it("normalizes immutable cash/routing facts from successful Session, Intent and charge", () => {
  const a = fixtureAttempt();
  const s = fixturePaidSession(a);
  expect(verifiedPaymentFacts(a, s, fixturePaymentIntent(a, s))).toMatchObject({
    sessionId: s.id,
    paymentIntentId: s.payment_intent,
    amount: 3500,
    paymentMode: "connect",
    applicationFeeAmount: 175,
  });
});
it("preserves zero-fee Connect and does not reinterpret the current disabled mode", () => {
  const a = { ...fixtureAttempt(), applicationFeeAmount: 0 };
  const s = fixturePaidSession(a);
  const oldMode = process.env.STRIPE_PAYMENT_MODE;
  process.env.STRIPE_PAYMENT_MODE = "disabled";
  try {
    expect(verifiedPaymentFacts(a, s, fixturePaymentIntent(a, s))).toMatchObject({
      paymentMode: "connect",
      applicationFeeAmount: 0,
      destinationAccountId: "acct_host",
    });
  } finally {
    if (oldMode === undefined) Reflect.deleteProperty(process.env, "STRIPE_PAYMENT_MODE");
    else process.env.STRIPE_PAYMENT_MODE = oldMode;
  }
});
it("accepts ordinary Direct payments and rejects stale transfer or application fee", () => {
  const a = {
    ...fixtureAttempt(),
    paymentMode: "direct" as const,
    destinationAccountId: null,
    applicationFeeAmount: 0,
  };
  const s = fixturePaidSession(a);
  const pi = fixturePaymentIntent(a, s);
  expect(verifiedPaymentFacts(a, s, pi).paymentMode).toBe("direct");
  expect(() =>
    verifiedPaymentFacts(a, s, { ...pi, transfer_data: { destination: "acct_host" } }),
  ).toThrow();
  expect(() => verifiedPaymentFacts(a, s, { ...pi, application_fee_amount: 0 })).toThrow();
});
describe("reject contradictory Session facts", () => {
  it.each([
    ["session ID", { id: "cs_wrong" }],
    ["intent ID", { payment_intent: "pi_wrong" }],
    ["amount", { amount_total: 1 }],
    ["currency", { currency: "eur" }],
    ["environment", { livemode: true }],
    ["unpaid", { payment_status: "unpaid" }],
    ["incomplete", { status: "open" }],
  ])("%s", (_, override) => {
    const a = { ...fixtureAttempt(), checkoutSessionId: "cs_saved", paymentIntentId: "pi_saved" };
    const s = fixturePaidSession(a);
    expect(() =>
      verifiedPaymentFacts(
        a,
        { ...s, ...override } as Stripe.Checkout.Session,
        fixturePaymentIntent(a, s),
      ),
    ).toThrow();
  });
  it("rejects a different account even with a matching amount", () => {
    const a = fixtureAttempt();
    const s = fixturePaidSession(a);
    expect(() =>
      verifiedPaymentFacts(
        a,
        { ...s, metadata: { ...s.metadata, chargeAccountId: "acct_other" } },
        fixturePaymentIntent(a, s),
      ),
    ).toThrow();
  });
});
describe("reject contradictory Intent or charge facts", () => {
  it.each([
    ["intent ID", { id: "pi_other" }],
    ["amount", { amount: 1 }],
    ["captured amount", { amount_received: 1 }],
    ["currency", { currency: "eur" }],
    ["environment", { livemode: true }],
    ["destination", { transfer_data: { destination: "acct_other" } }],
    ["fee", { application_fee_amount: 1 }],
    ["on behalf", { on_behalf_of: "acct_other" }],
  ])("%s", (_, override) => {
    const a = fixtureAttempt();
    const s = fixturePaidSession(a);
    const pi = fixturePaymentIntent(a, s);
    expect(() =>
      verifiedPaymentFacts(a, s, { ...pi, ...override } as Stripe.PaymentIntent),
    ).toThrow();
  });
  it.each(["processing", "requires_action", "requires_capture", "canceled"])(
    "does not treat %s as settled success",
    (status) => {
      const a = fixtureAttempt();
      const s = fixturePaidSession(a);
      expect(() =>
        verifiedPaymentFacts(a, s, {
          ...fixturePaymentIntent(a, s),
          status,
          amount_received: 0,
        } as Stripe.PaymentIntent),
      ).toThrow("not yet verifiable");
    },
  );
  it.each([
    { paid: false },
    { captured: false },
    { payment_intent: "pi_other" },
    { amount: 1 },
    { currency: "eur" },
    { amount_refunded: 100 },
    { livemode: true },
  ])("rejects charge disagreement %j", (override) => {
    const a = fixtureAttempt();
    const s = fixturePaidSession(a);
    const pi = fixturePaymentIntent(a, s);
    expect(() =>
      verifiedPaymentFacts(a, s, {
        ...pi,
        latest_charge: { ...(pi.latest_charge as Stripe.Charge), ...override },
      }),
    ).toThrow();
  });
});
