import { randomUUID } from "node:crypto";
import { calculateAppointmentPrice, encryptJson, sha256hex } from "@dayotter/core";
import type Stripe from "stripe";
import { type PaymentAttempt, appointmentRequestIdentity, canonicalJson } from "./attempt-terms";

export function fixtureAttempt(): PaymentAttempt {
  const organizationId = "00000000-0000-4000-8000-000000000001";
  const eventTypeId = "00000000-0000-4000-8000-000000000002";
  const input = {
    eventTypeId,
    start: "2026-10-15T15:00:00.000Z",
    attendee: { name: "Client", email: "client@example.test", timezone: "UTC" },
    accessCode: "private-code",
  };
  const quote = calculateAppointmentPrice({
    eventType: {
      id: eventTypeId,
      organizationId,
      price: 5000,
      currency: "usd",
      depositAmount: 3500,
    },
    appointmentStartsAt: new Date(input.start),
    settlement: "cash",
    promotions: [
      {
        id: "00000000-0000-4000-8000-000000000003",
        organizationId,
        label: "October",
        isActive: true,
        startsAt: new Date("2026-10-01Z"),
        endsAt: new Date("2026-11-01Z"),
        eventTypeIds: [eventTypeId],
        discount: { kind: "percentage", basisPoints: 2000 },
      },
    ],
  });
  const identity = appointmentRequestIdentity(input, "/", randomUUID());
  const createdAt = new Date("2026-10-01T00:00:00Z");
  return {
    id: randomUUID(),
    requestKey: identity.key,
    requestFingerprint: identity.fingerprint,
    organizationId,
    eventTypeId,
    bookingIntent: encryptJson({ input, returnPath: "/", resolvedDurationMinutes: 30 }),
    quote,
    quoteHash: sha256hex(canonicalJson(quote)),
    amount: 3500,
    currency: "usd",
    purpose: "appointment",
    settlement: "cash",
    expectedPaymentStatus: "paid",
    paymentMode: "connect",
    environment: "test",
    chargeAccountId: "acct_platform",
    credentialContext: "primary",
    destinationAccountId: "acct_host",
    applicationFeeAmount: 175,
    productName: "Light",
    successUrl: "https://example.test/paid",
    cancelUrl: "https://example.test/",
    createdAt,
    creationDeadline: new Date(createdAt.getTime() + 900000),
    expiresAt: new Date(createdAt.getTime() + 7200000),
    paymentSucceededAt: null,
    successFacts: null,
    nextRecoveryAt: createdAt,
    recoveryFailures: 0,
    reviewCode: null,
    finalizationContext: null,
    finalizationState: null,
    finalizationReviewCode: null,
    finalizationStartedAt: null,
    state: "prepared",
    checkoutSessionId: null,
    checkoutUrl: null,
    paymentIntentId: null,
    bookingId: null,
    schedulingPlan: null,
    schedulingDurationMinutes: null,
  };
}

export function fixtureSession(attempt: PaymentAttempt): Stripe.Checkout.Session {
  return {
    id: "cs_saved",
    mode: "payment",
    status: "open",
    payment_status: "unpaid",
    payment_intent: null,
    livemode: false,
    amount_total: attempt.amount,
    currency: attempt.currency,
    client_reference_id: attempt.id,
    expires_at: Math.floor(attempt.expiresAt.getTime() / 1000),
    url: "https://checkout.example.test/saved",
    metadata: {
      attemptId: attempt.id,
      quoteHash: attempt.quoteHash,
      paymentMode: attempt.paymentMode,
      organizationId: attempt.organizationId,
      chargeAccountId: attempt.chargeAccountId,
      paymentEnvironment: attempt.environment,
      credentialContext: attempt.credentialContext,
      ...(attempt.destinationAccountId ? { dest: attempt.destinationAccountId } : {}),
    },
  } as unknown as Stripe.Checkout.Session;
}

export function fixturePaidSession(attempt: PaymentAttempt): Stripe.Checkout.Session {
  return {
    ...fixtureSession(attempt),
    id: attempt.checkoutSessionId ?? `cs_${attempt.id.replaceAll("-", "")}`,
    status: "complete",
    payment_status: "paid",
    payment_intent: attempt.paymentIntentId ?? `pi_${attempt.id.replaceAll("-", "")}`,
  };
}

export function fixturePaymentIntent(
  attempt: PaymentAttempt,
  session = fixturePaidSession(attempt),
): Stripe.PaymentIntent {
  const piId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent!.id;
  return {
    id: piId,
    status: "succeeded",
    amount: attempt.amount,
    amount_received: attempt.amount,
    currency: attempt.currency,
    livemode: attempt.environment === "live",
    metadata: { ...session.metadata },
    application_fee_amount: attempt.paymentMode === "connect" ? attempt.applicationFeeAmount : null,
    transfer_data: attempt.destinationAccountId
      ? { destination: attempt.destinationAccountId }
      : null,
    on_behalf_of: null,
    latest_charge: {
      id: `ch_${attempt.id.replaceAll("-", "")}`,
      livemode: attempt.environment === "live",
      paid: true,
      captured: true,
      status: "succeeded",
      payment_intent: piId,
      amount: attempt.amount,
      currency: attempt.currency,
      amount_refunded: 0,
    },
  } as unknown as Stripe.PaymentIntent;
}
