import type { schema } from "@dayotter/db";
import type Stripe from "stripe";
import { type PaymentAttempt, validateAttemptSession } from "./attempt-terms";
import { PaymentContradictionError } from "./routing";

function id(value: string | { id: string } | null | undefined) {
  return typeof value === "string" ? value : (value?.id ?? null);
}

/** Verify static Intent routing even for a signed snapshot with an unexpanded charge. */
export function validatePaymentIntentTerms(
  attempt: PaymentAttempt,
  expectedId: string,
  pi: Stripe.PaymentIntent,
) {
  const m = pi.metadata;
  const destination = id(pi.transfer_data?.destination);
  const fee = pi.application_fee_amount ?? 0;
  if (
    pi.id !== expectedId ||
    pi.livemode !== (attempt.environment === "live") ||
    pi.amount !== attempt.amount ||
    pi.currency !== attempt.currency ||
    m.attemptId !== attempt.id ||
    m.quoteHash !== attempt.quoteHash ||
    m.organizationId !== attempt.organizationId ||
    m.paymentMode !== attempt.paymentMode ||
    m.chargeAccountId !== attempt.chargeAccountId ||
    m.paymentEnvironment !== attempt.environment ||
    m.credentialContext !== attempt.credentialContext ||
    (m.dest || null) !== attempt.destinationAccountId ||
    destination !== attempt.destinationAccountId ||
    fee !== attempt.applicationFeeAmount ||
    pi.on_behalf_of ||
    (attempt.paymentMode === "direct" &&
      (pi.transfer_data || pi.application_fee_amount !== null)) ||
    (pi.transfer_data?.amount != null && pi.transfer_data.amount !== attempt.amount)
  ) {
    throw new PaymentContradictionError(
      "PaymentIntent does not match the original checkout routing and terms",
    );
  }
  return { destination, fee };
}

/** Facts come from an authenticated account-scoped SDK read, never redirect parameters. */
export function verifiedPaymentFacts(
  attempt: PaymentAttempt,
  session: Stripe.Checkout.Session,
  pi: Stripe.PaymentIntent,
): schema.PaymentSuccessFacts {
  const expectedId = validateAttemptSession(attempt, session, true);
  const { destination, fee } = validatePaymentIntentTerms(attempt, expectedId!, pi);
  if (pi.status !== "succeeded") throw new Error("Stripe payment success is not yet verifiable");
  if (pi.amount_received !== attempt.amount)
    throw new PaymentContradictionError("Captured amount does not match the saved quote");
  const charge = pi.latest_charge;
  if (!charge || typeof charge === "string") throw new Error("Stripe charge is not yet available");
  if (
    charge.livemode !== pi.livemode ||
    !charge.paid ||
    !charge.captured ||
    charge.status !== "succeeded" ||
    id(charge.payment_intent) !== pi.id ||
    charge.amount !== attempt.amount ||
    charge.currency !== attempt.currency ||
    charge.amount_refunded > 0
  ) {
    throw new PaymentContradictionError("Successful charge requires reconciliation");
  }
  return {
    version: 1,
    sessionId: session.id,
    paymentIntentId: pi.id,
    chargeId: charge.id,
    amount: pi.amount_received,
    currency: pi.currency,
    environment: attempt.environment,
    chargeAccountId: attempt.chargeAccountId,
    credentialContext: attempt.credentialContext,
    paymentMode: attempt.paymentMode,
    destinationAccountId: destination,
    applicationFeeAmount: fee,
  };
}
