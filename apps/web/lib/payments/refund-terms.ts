import type { schema } from "@dayotter/db";
import type Stripe from "stripe";
import { PaymentContradictionError, type PaymentRoute } from "./routing";

export type RefundOperation = typeof schema.refundOperations.$inferSelect;
export const REFUND_REPLAY_WINDOW_MS = 20 * 60 * 60 * 1000;

export function refundRoute(operation: RefundOperation): PaymentRoute {
  const context = {
    organizationId: operation.organizationId,
    environment: operation.environment,
    chargeAccountId: operation.chargeAccountId,
    credentialContext: operation.credentialContext,
  };
  return operation.paymentMode === "direct"
    ? { ...context, mode: "direct" }
    : {
        ...context,
        mode: "connect",
        destinationAccountId: operation.destinationAccountId!,
        applicationFeeAmount: operation.applicationFeeAmount,
      };
}

export function stripeObjectId(value: string | { id: string } | null | undefined) {
  return typeof value === "string" ? value : (value?.id ?? null);
}

export interface RefundEvidence {
  refund: Stripe.Refund;
  charge: Stripe.Charge;
  /** Account identity verified by the authenticated SDK boundary, not metadata. */
  chargeAccountId: string;
  environment: "test" | "live";
}

export function verifyRefundCharge(operation: RefundOperation, charge: Stripe.Charge) {
  if (
    charge.id !== operation.chargeId ||
    stripeObjectId(charge.payment_intent) !== operation.paymentIntentId ||
    charge.amount !== operation.amount ||
    charge.currency !== operation.currency ||
    charge.livemode !== (operation.environment === "live") ||
    !charge.paid ||
    !charge.captured ||
    charge.status !== "succeeded" ||
    (charge.application_fee_amount ?? 0) !== operation.applicationFeeAmount ||
    !Number.isSafeInteger(charge.amount_refunded) ||
    charge.amount_refunded < 0 ||
    charge.amount_refunded > operation.amount
  ) {
    throw new PaymentContradictionError("Refund charge contradicts saved payment facts");
  }
  const transfer = charge.transfer;
  if (operation.paymentMode === "connect") {
    if (
      !transfer ||
      typeof transfer === "string" ||
      transfer.amount !== operation.amount ||
      transfer.currency !== operation.currency ||
      transfer.livemode !== charge.livemode ||
      stripeObjectId(transfer.destination) !== operation.destinationAccountId ||
      stripeObjectId(transfer.source_transaction) !== charge.id
    ) {
      throw new PaymentContradictionError("Refund transfer contradicts saved destination facts");
    }
  } else if (transfer || charge.application_fee) {
    throw new PaymentContradictionError("Direct refund charge contains Connect money movement");
  }
}

/** Metadata is only correlation: account-scoped charge and reversal relationships also have to match. */
export function verifyRefundEvidence(operation: RefundOperation, evidence: RefundEvidence) {
  const { refund, charge } = evidence;
  verifyRefundCharge(operation, charge);
  if (
    evidence.chargeAccountId !== operation.chargeAccountId ||
    evidence.environment !== operation.environment ||
    !/^re_[A-Za-z0-9]+$/.test(refund.id) ||
    (operation.stripeRefundId && refund.id !== operation.stripeRefundId) ||
    stripeObjectId(refund.charge) !== operation.chargeId ||
    stripeObjectId(refund.payment_intent) !== operation.paymentIntentId ||
    refund.amount !== operation.amount ||
    refund.currency !== operation.currency ||
    refund.metadata?.refundOperationId !== operation.id ||
    refund.metadata?.paymentAttemptId !== operation.attemptId
  ) {
    throw new PaymentContradictionError("Refund contradicts its durable operation");
  }
  if (
    !["pending", "requires_action", "succeeded", "failed", "canceled"].includes(refund.status ?? "")
  )
    throw new PaymentContradictionError("Refund status is unknown");
  if (
    operation.paymentMode === "direct" &&
    (refund.transfer_reversal || refund.source_transfer_reversal)
  )
    throw new PaymentContradictionError("Direct refund contains an unexpected reversal");
  if (refund.status !== "succeeded") return refund.status!;
  if (charge.amount_refunded !== operation.amount)
    throw new PaymentContradictionError("Refunded charge amount requires reconciliation");
  if (operation.paymentMode === "connect") {
    const reversal = refund.transfer_reversal;
    if (
      !reversal ||
      typeof reversal === "string" ||
      reversal.amount !== operation.amount ||
      reversal.currency !== operation.currency ||
      stripeObjectId(reversal.transfer) !== stripeObjectId(charge.transfer) ||
      (reversal.source_refund && stripeObjectId(reversal.source_refund) !== refund.id)
    ) {
      throw new PaymentContradictionError("Connect refund lacks a verified full transfer reversal");
    }
    if (operation.applicationFeeAmount > 0) {
      const fee = charge.application_fee;
      if (
        !fee ||
        typeof fee === "string" ||
        fee.amount !== operation.applicationFeeAmount ||
        fee.amount_refunded !== operation.applicationFeeAmount ||
        fee.currency !== operation.currency ||
        fee.livemode !== charge.livemode ||
        stripeObjectId(fee.charge) !== charge.id
      ) {
        throw new PaymentContradictionError(
          "Connect application fee refund requires reconciliation",
        );
      }
    }
  }
  return "succeeded";
}
