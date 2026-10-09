import { randomUUID } from "node:crypto";
import { sha256hex } from "@dayotter/core";
import type Stripe from "stripe";
import { canonicalJson } from "../payments/attempt-terms";
import type { PackagePurchase } from "./purchases";
export function purchaseFixture(): PackagePurchase {
  const id = randomUUID();
  const organizationId = randomUUID();
  const ownerUserId = randomUUID();
  const packageId = randomUUID();
  const eventTypeId = randomUUID();
  const createdAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  const terms: PackagePurchase["terms"] = {
    version: 1,
    organizationId,
    ownerUserId,
    packageId,
    eventTypeId,
    clientEmail: "owner@example.test",
    amount: 5000,
    totalCredits: 5,
    currency: "usd",
    productName: "Five sessions",
    successUrl: "https://example.test/thanks",
    cancelUrl: "https://example.test",
    route: {
      mode: "direct",
      organizationId,
      chargeAccountId: "acct_original",
      credentialContext: "primary",
      environment: "test",
    },
  };
  return {
    id,
    packageId,
    eventTypeId,
    organizationId,
    ownerUserId,
    terms,
    termsHash: sha256hex(canonicalJson(terms)),
    requestKey: `package-purchase:${id}`,
    requestFingerprint: sha256hex(id),
    environment: "test",
    chargeAccountId: "acct_original",
    state: "prepared",
    checkoutSessionId: null,
    checkoutUrl: null,
    paymentIntentId: null,
    successFacts: null,
    creditId: null,
    createdAt,
    expiresAt: new Date(createdAt.getTime() + 3600000),
    creationDeadline: new Date(createdAt.getTime() + 60000),
    failures: 0,
    nextRecoveryAt: createdAt,
    reviewCode: null,
  };
}
export function packageSession(p: PackagePurchase): Stripe.Checkout.Session {
  const r = p.terms.route;
  return {
    id: `cs_${p.id.replaceAll("-", "")}`,
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    amount_total: p.terms.amount,
    amount_subtotal: p.terms.amount,
    currency: p.terms.currency,
    livemode: false,
    expires_at: Math.floor(p.expiresAt.getTime() / 1000),
    client_reference_id: p.id,
    payment_intent: `pi_${p.id.replaceAll("-", "")}`,
    metadata: {
      kind: "package",
      purchaseId: p.id,
      termsHash: p.termsHash,
      ownerUserId: p.ownerUserId,
      organizationId: p.organizationId,
      paymentMode: r.mode,
      chargeAccountId: r.chargeAccountId,
      paymentEnvironment: r.environment,
      credentialContext: r.credentialContext,
      ...(r.mode === "connect" ? { dest: r.destinationAccountId! } : {}),
    },
    url: "https://checkout.example.test",
  } as unknown as Stripe.Checkout.Session;
}
export function packageIntent(p: PackagePurchase, s = packageSession(p)): Stripe.PaymentIntent {
  const pi = String(s.payment_intent);
  return {
    id: pi,
    status: "succeeded",
    amount: p.terms.amount,
    amount_received: p.terms.amount,
    currency: p.terms.currency,
    livemode: false,
    metadata: s.metadata,
    application_fee_amount: p.terms.route.applicationFeeAmount ?? null,
    transfer_data:
      p.terms.route.mode === "connect" ? { destination: p.terms.route.destinationAccountId } : null,
    on_behalf_of: null,
    latest_charge: {
      id: `ch_${p.id.replaceAll("-", "")}`,
      payment_intent: pi,
      paid: true,
      captured: true,
      status: "succeeded",
      amount: p.terms.amount,
      currency: p.terms.currency,
      livemode: false,
      amount_refunded: 0,
    },
  } as Stripe.PaymentIntent;
}
