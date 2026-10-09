import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { fixtureAttempt, fixturePaidSession, fixturePaymentIntent } from "./attempt-fixtures";
import type { PaymentAttempt } from "./attempt-terms";
import { verifiedPaymentFacts } from "./payment-success";
import type { RefundEvidence, RefundOperation } from "./refund-terms";

export function fixtureRefundOperation(attempt = fixtureAttempt()): RefundOperation {
  const session = fixturePaidSession(attempt);
  const facts =
    attempt.successFacts ??
    verifiedPaymentFacts(attempt, session, fixturePaymentIntent(attempt, session));
  const id = randomUUID();
  return {
    id,
    organizationId: attempt.organizationId,
    attemptId: attempt.id,
    bookingId: attempt.bookingId ?? randomUUID(),
    purpose: "cancellation",
    paymentIntentId: facts.paymentIntentId,
    chargeId: facts.chargeId,
    amount: facts.amount,
    currency: facts.currency,
    environment: facts.environment,
    chargeAccountId: facts.chargeAccountId,
    credentialContext: facts.credentialContext,
    paymentMode: facts.paymentMode,
    destinationAccountId: facts.destinationAccountId,
    applicationFeeAmount: facts.applicationFeeAmount,
    idempotencyKey: `appointment-refund:${id}:v1`,
    state: "owed",
    stripeRefundId: null,
    stripeStatus: null,
    firstSubmittedAt: null,
    succeededAt: null,
    failures: 0,
    nextRecoveryAt: new Date(),
    reviewCode: null,
    createdAt: new Date(),
  };
}

export function fixtureRefundCharge(operation: RefundOperation, refunded = false): Stripe.Charge {
  return {
    id: operation.chargeId,
    payment_intent: operation.paymentIntentId,
    amount: operation.amount,
    currency: operation.currency,
    amount_refunded: refunded ? operation.amount : 0,
    livemode: operation.environment === "live",
    paid: true,
    captured: true,
    status: "succeeded",
    application_fee_amount:
      operation.paymentMode === "connect" ? operation.applicationFeeAmount : null,
    application_fee:
      operation.applicationFeeAmount > 0
        ? {
            id: "fee_saved",
            amount: operation.applicationFeeAmount,
            amount_refunded: refunded ? operation.applicationFeeAmount : 0,
            currency: operation.currency,
            livemode: operation.environment === "live",
            charge: operation.chargeId,
          }
        : null,
    transfer:
      operation.paymentMode === "connect"
        ? {
            id: "tr_saved",
            amount: operation.amount,
            currency: operation.currency,
            livemode: operation.environment === "live",
            destination: operation.destinationAccountId,
            source_transaction: operation.chargeId,
          }
        : null,
  } as unknown as Stripe.Charge;
}

export function fixtureRefundEvidence(
  operation: RefundOperation,
  status = "succeeded",
): RefundEvidence {
  const id = operation.stripeRefundId ?? `re_${operation.id.replaceAll("-", "")}`;
  return {
    chargeAccountId: operation.chargeAccountId,
    environment: operation.environment,
    charge: fixtureRefundCharge(operation, status === "succeeded"),
    refund: {
      id,
      object: "refund",
      amount: operation.amount,
      currency: operation.currency,
      charge: operation.chargeId,
      payment_intent: operation.paymentIntentId,
      status,
      metadata: { refundOperationId: operation.id, paymentAttemptId: operation.attemptId },
      source_transfer_reversal: null,
      transfer_reversal:
        operation.paymentMode === "connect"
          ? {
              id: "trr_saved",
              amount: operation.amount,
              currency: operation.currency,
              transfer: "tr_saved",
              source_refund: id,
            }
          : null,
    } as unknown as Stripe.Refund,
  };
}

export function directRefundAttempt(): PaymentAttempt {
  return {
    ...fixtureAttempt(),
    paymentMode: "direct",
    destinationAccountId: null,
    applicationFeeAmount: 0,
  };
}
