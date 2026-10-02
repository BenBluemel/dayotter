import { type AppointmentPrice, decryptJson, sha256hex } from "@dayotter/core";
import type { schema } from "@dayotter/db";
import type Stripe from "stripe";
import { z } from "zod";
import type { CreateBookingInput } from "../booking/create-booking";
import { canonicalJson } from "./canonical-json";
import { PaymentContradictionError, type PaymentRoute } from "./routing";

export const PAYMENT_ATTEMPT_ID_PATTERN = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export type PaymentAttempt = typeof schema.paymentAttempts.$inferSelect;
export const CHECKOUT_LIFETIME_SECONDS = 2 * 60 * 60;
export const CREATION_RETRY_SECONDS = 15 * 60;

export { canonicalJson } from "./canonical-json";

export function appointmentRequestIdentity(
  input: CreateBookingInput,
  returnPath: string,
  requestId?: string,
) {
  const fingerprint = sha256hex(canonicalJson({ input, returnPath }));
  // UUIDs are operation identity, never authorization. Old callers get stable exact-input deduplication.
  return {
    fingerprint,
    key: requestId ? `appointment:${requestId.toLowerCase()}` : `appointment:legacy:${fingerprint}`,
  };
}

const instant = z.string().datetime({ offset: true });
const discount = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("percentage"), basisPoints: z.number().int().min(1).max(10000) })
    .strict(),
  z
    .object({
      kind: z.literal("fixed"),
      amount: z.number().int().positive(),
      currency: z.string().regex(/^[a-z]{3}$/),
    })
    .strict(),
]);
const quoteSchema = z
  .object({
    version: z.literal(1),
    organizationId: z.string().uuid(),
    eventTypeId: z.string().uuid(),
    appointmentStartsAt: instant,
    settlement: z.literal("cash"),
    basePrice: z.number().int().nonnegative(),
    effectivePrice: z.number().int().nonnegative(),
    amountToCollect: z.number().int().positive(),
    currency: z.string().regex(/^[a-z]{3}$/),
    promotion: z
      .object({
        id: z.string().uuid(),
        label: z.string().min(1),
        startsAt: instant,
        endsAt: instant,
        discount,
      })
      .strict()
      .nullable(),
  })
  .strict();

export function attemptRoute(attempt: PaymentAttempt): PaymentRoute {
  const context = {
    organizationId: attempt.organizationId,
    chargeAccountId: attempt.chargeAccountId,
    environment: attempt.environment,
    credentialContext: attempt.credentialContext,
  };
  if (attempt.paymentMode === "direct") {
    if (attempt.destinationAccountId || attempt.applicationFeeAmount !== 0)
      throw new PaymentContradictionError("Invalid saved direct routing");
    return { ...context, mode: "direct" };
  }
  if (!attempt.destinationAccountId || attempt.destinationAccountId === attempt.chargeAccountId)
    throw new PaymentContradictionError("Invalid saved Connect routing");
  return {
    ...context,
    mode: "connect",
    destinationAccountId: attempt.destinationAccountId,
    applicationFeeAmount: attempt.applicationFeeAmount,
  };
}

export function decodeAttempt(attempt: PaymentAttempt) {
  const quote = quoteSchema.parse(attempt.quote) as AppointmentPrice;
  const payload = decryptJson<{
    input: CreateBookingInput;
    returnPath: string;
    resolvedDurationMinutes: number;
  }>(attempt.bookingIntent);
  const input = payload.input;
  if (
    input.payment ||
    input.redeemCredit ||
    input.pricingQuote ||
    input.paymentAttemptId ||
    input.quotedDurationMinutes ||
    !Number.isInteger(payload.resolvedDurationMinutes) ||
    payload.resolvedDurationMinutes < 5 ||
    payload.resolvedDurationMinutes > 1440 ||
    appointmentRequestIdentity(input, payload.returnPath).fingerprint !==
      attempt.requestFingerprint ||
    sha256hex(canonicalJson(quote)) !== attempt.quoteHash ||
    quote.organizationId !== attempt.organizationId ||
    quote.eventTypeId !== attempt.eventTypeId ||
    input.eventTypeId !== attempt.eventTypeId ||
    new Date(input.start).toISOString() !== quote.appointmentStartsAt ||
    quote.amountToCollect !== attempt.amount ||
    quote.currency !== attempt.currency
  ) {
    throw new PaymentContradictionError("Saved checkout intent and pricing terms disagree");
  }
  // Integrity check of immutable numbers only; never run quote/promotion selection at fulfillment.
  const p = quote.promotion;
  const saving = p
    ? p.discount.kind === "percentage"
      ? Math.round((quote.basePrice * p.discount.basisPoints) / 10000)
      : Math.min(quote.basePrice, p.discount.amount)
    : 0;
  if (
    quote.effectivePrice !== quote.basePrice - saving ||
    quote.amountToCollect > quote.effectivePrice ||
    (p &&
      (saving <= 0 ||
        new Date(quote.appointmentStartsAt) < new Date(p.startsAt) ||
        new Date(quote.appointmentStartsAt) >= new Date(p.endsAt) ||
        (p.discount.kind === "fixed" && p.discount.currency !== quote.currency)))
  ) {
    throw new PaymentContradictionError("Invalid saved pricing arithmetic");
  }
  return {
    input,
    quote,
    route: attemptRoute(attempt),
    resolvedDurationMinutes: payload.resolvedDurationMinutes,
  };
}

/** Validation applies to create/retrieve/fulfillment, not only a webhook's metadata. */
export function validateAttemptSession(
  attempt: PaymentAttempt,
  session: Stripe.Checkout.Session,
  requirePaid = false,
) {
  decodeAttempt(attempt);
  const metadata = session.metadata;
  const pi =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : (session.payment_intent?.id ?? null);
  if (
    session.mode !== "payment" ||
    session.livemode !== (attempt.environment === "live") ||
    session.client_reference_id !== attempt.id ||
    metadata?.attemptId !== attempt.id ||
    metadata?.quoteHash !== attempt.quoteHash ||
    metadata?.paymentMode !== attempt.paymentMode ||
    metadata?.organizationId !== attempt.organizationId ||
    metadata?.chargeAccountId !== attempt.chargeAccountId ||
    metadata?.paymentEnvironment !== attempt.environment ||
    metadata?.credentialContext !== attempt.credentialContext ||
    (metadata?.dest || null) !== attempt.destinationAccountId ||
    session.amount_total !== attempt.amount ||
    session.currency !== attempt.currency ||
    session.expires_at !== Math.floor(attempt.expiresAt.getTime() / 1000) ||
    (attempt.checkoutSessionId && session.id !== attempt.checkoutSessionId) ||
    (attempt.paymentIntentId && pi !== attempt.paymentIntentId) ||
    (requirePaid && (session.status !== "complete" || session.payment_status !== "paid" || !pi))
  ) {
    throw new PaymentContradictionError("Stripe Session does not match the saved checkout terms");
  }
  return pi;
}

export function mayCreateSession(attempt: PaymentAttempt, now = new Date()) {
  return (
    attempt.state === "prepared" && !attempt.checkoutSessionId && now < attempt.creationDeadline
  );
}
