import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  directRefundAttempt,
  fixtureRefundEvidence,
  fixtureRefundOperation,
} from "./refund-fixtures";
import { refundOutcome, refundRoute, verifyRefundEvidence } from "./refund-terms";
import { refundRoutingParameters } from "./routing";

const oldKey = process.env.ENCRYPTION_KEY;
beforeAll(() => {
  process.env.ENCRYPTION_KEY = "ab".repeat(32);
});
afterAll(() => {
  if (oldKey === undefined) Reflect.deleteProperty(process.env, "ENCRYPTION_KEY");
  else process.env.ENCRYPTION_KEY = oldKey;
});

describe("immutable refund verification", () => {
  it.each(["direct", "connect", "zero-fee"])("verifies a full historical %s refund", (mode) => {
    const operation = fixtureRefundOperation(mode === "direct" ? directRefundAttempt() : undefined);
    if (mode === "zero-fee") operation.applicationFeeAmount = 0;
    const evidence = fixtureRefundEvidence(operation);
    expect(verifyRefundEvidence(operation, evidence)).toBe("succeeded");
    expect(refundRoutingParameters(refundRoute(operation))).toEqual(
      mode === "direct"
        ? {}
        : mode === "zero-fee"
          ? { reverse_transfer: true }
          : { reverse_transfer: true, refund_application_fee: true },
    );
  });
  it.each(["pending", "requires_action", "failed", "canceled"])(
    "does not treat %s as refund completion",
    (status) => {
      const operation = fixtureRefundOperation();
      expect(verifyRefundEvidence(operation, fixtureRefundEvidence(operation, status))).toBe(
        status,
      );
    },
  );
  it.each([
    ["succeeded", "succeeded", null],
    ["pending", "pending", null],
    ["requires_action", "requires_review", "stripe_refund_requires_action"],
    ["failed", "requires_review", "stripe_refund_failed"],
    ["canceled", "requires_review", "stripe_refund_canceled"],
  ] as const)("maps verified %s to its durable outcome", (status, state, reviewCode) => {
    const operation = fixtureRefundOperation();
    const verified = verifyRefundEvidence(operation, fixtureRefundEvidence(operation, status));
    expect(refundOutcome(verified)).toEqual({ state, reviewCode });
  });
  it.each(["unknown", "", null, undefined, 42, {}, "SUCCEEDED"])(
    "rejects unexpected runtime status %j at the evidence boundary",
    (status) => {
      const operation = fixtureRefundOperation();
      const evidence = fixtureRefundEvidence(operation);
      Object.assign(evidence.refund, { status });
      expect(() => verifyRefundEvidence(operation, evidence)).toThrow("Refund status is unknown");
    },
  );
  it.each([
    "refund-id",
    "amount",
    "currency",
    "intent",
    "charge",
    "account",
    "environment",
    "metadata",
    "fee",
    "reversal",
    "destination",
    "captured-amount",
  ])("rejects contradictory %s", (kind) => {
    const operation = fixtureRefundOperation();
    const evidence = fixtureRefundEvidence(operation);
    switch (kind) {
      case "refund-id":
        operation.stripeRefundId = "re_original";
        break;
      case "amount":
        evidence.refund.amount++;
        break;
      case "currency":
        evidence.refund.currency = "eur";
        break;
      case "intent":
        evidence.refund.payment_intent = "pi_wrong";
        break;
      case "charge":
        evidence.refund.charge = "ch_wrong";
        break;
      case "account":
        evidence.chargeAccountId = "acct_other";
        break;
      case "environment":
        evidence.environment = "live";
        break;
      case "metadata":
        evidence.refund.metadata = { refundOperationId: "wrong" };
        break;
      case "fee":
        if (typeof evidence.charge.application_fee === "object" && evidence.charge.application_fee)
          evidence.charge.application_fee.amount_refunded = 0;
        break;
      case "reversal":
        evidence.refund.transfer_reversal = null;
        break;
      case "destination":
        if (typeof evidence.charge.transfer === "object" && evidence.charge.transfer)
          evidence.charge.transfer.destination = "acct_wrong";
        break;
      case "captured-amount":
        evidence.charge.amount++;
        break;
    }
    expect(() => verifyRefundEvidence(operation, evidence)).toThrow();
  });
  it("cannot inject Connect reversal facts into a direct refund", () => {
    const operation = fixtureRefundOperation(directRefundAttempt());
    const evidence = fixtureRefundEvidence(operation);
    evidence.refund.transfer_reversal = "trr_stale";
    expect(() => verifyRefundEvidence(operation, evidence)).toThrow("unexpected reversal");
  });
});
