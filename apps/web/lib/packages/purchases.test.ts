import { beforeEach, expect, it, vi } from "vitest";
vi.mock("../server/env", () => ({ env: { APP_URL: "https://example.test" } }));
vi.mock("../payments/stripe", () => ({
  createCheckoutSession: vi.fn(),
  retrievePaymentIntent: vi.fn(),
  retrieveSession: vi.fn(),
  sessionForPaymentIntent: vi.fn(),
}));
import { sha256hex } from "@dayotter/core";
import { canonicalJson } from "../payments/attempt-terms";
import { fulfillPackagePurchase } from "./fulfill";
import { packageIntent, packageSession, purchaseFixture } from "./purchase-fixtures";
import { purchaseRoute, validatePackageSession, verifyPackagePayment } from "./purchases";
let purchase = purchaseFixture();
beforeEach(() => {
  purchase = purchaseFixture();
});
it("accepts only the original package owner/count/financial route", () => {
  const s = packageSession(purchase);
  expect(verifyPackagePayment(purchase, s, packageIntent(purchase, s))).toMatchObject({
    amount: 5000,
    paymentMode: "direct",
    applicationFeeAmount: 0,
  });
});
it.each([
  "amount",
  "currency",
  "environment",
  "account",
  "destination",
  "fee",
  "owner",
  "intent",
  "charge",
])("rejects contradictory %s", (field) => {
  const s = packageSession(purchase);
  const pi = packageIntent(purchase, s);
  if (field === "amount") pi.amount_received--;
  if (field === "currency") pi.currency = "eur";
  if (field === "environment") pi.livemode = true;
  if (field === "account") pi.metadata.chargeAccountId = "acct_wrong";
  if (field === "destination") pi.transfer_data = { destination: "acct_wrong" };
  if (field === "fee") pi.application_fee_amount = 1;
  if (field === "owner") pi.metadata.ownerUserId = "wrong";
  if (field === "intent") pi.id = "pi_wrong";
  if (field === "charge")
    (pi.latest_charge as { payment_intent: string }).payment_intent = "pi_wrong";
  expect(() => verifyPackagePayment(purchase, s, pi)).toThrow();
});
it.each([
  "processing",
  "requires_action",
  "requires_payment_method",
  "requires_capture",
  "canceled",
] as const)("does not grant for %s Intent", (status) => {
  const pi = packageIntent(purchase);
  pi.status = status;
  expect(() => verifyPackagePayment(purchase, packageSession(purchase), pi)).toThrow();
});
it("rejects unpaid, conflicting Session and missing metadata", () => {
  const s = packageSession(purchase);
  s.payment_status = "unpaid";
  expect(() => verifyPackagePayment(purchase, s, packageIntent(purchase, s))).toThrow();
  purchase.checkoutSessionId = "cs_other";
  expect(() => validatePackageSession(purchase, s)).toThrow();
  purchase.checkoutSessionId = null;
  s.metadata = null;
  expect(() => validatePackageSession(purchase, s)).toThrow();
});
it.each([0, 175])(
  "retains historical Connect fee %s independently of current configuration",
  (fee) => {
    purchase.terms.route = {
      ...purchase.terms.route,
      mode: "connect",
      destinationAccountId: "acct_destination",
      applicationFeeAmount: fee,
    };
    purchase.termsHash = sha256hex(canonicalJson(purchase.terms));
    expect(purchaseRoute(purchase)).toMatchObject({ mode: "connect", applicationFeeAmount: fee });
    expect(
      verifyPackagePayment(purchase, packageSession(purchase), packageIntent(purchase)),
    ).toMatchObject({ applicationFeeAmount: fee, destinationAccountId: "acct_destination" });
  },
);
it("old Sessions cannot automatically invent entitlement ownership", async () => {
  await expect(fulfillPackagePurchase(packageSession(purchase))).rejects.toThrow(
    "manual reconciliation",
  );
});
