import { withdrawMinimum } from "@/lib/booking/money";
import { logger } from "@dayotter/core";
import Stripe from "stripe";
import { env } from "../server/env";
import {
  type PaymentRoute,
  PaymentRoutingError,
  type StripeContext,
  assertCheckoutRoute,
  assertStripeKeyEnvironment,
  paymentRoutingConfig,
  refundRoutingParameters,
} from "./routing";

/**
 * The single Stripe layer. New sales use explicit routing; historical operations
 * and Pro billing can keep using credentials when new sales are disabled.
 * Every payment path goes through here - no route instantiates its own client.
 */
export const stripeConfigured = Boolean(env.STRIPE_SECRET_KEY);
export const paymentsEnabled = stripeConfigured && env.STRIPE_PAYMENT_MODE !== "disabled";

/** Historical/Pro operations use the primary key's context, never the current sales mode. */
function primaryStripeEnvironment(): "test" | "live" {
  const environment = /^(sk|rk)_live_/.test(env.STRIPE_SECRET_KEY ?? "") ? "live" : "test";
  assertStripeKeyEnvironment(env.STRIPE_SECRET_KEY, environment);
  if (environment === "live" && env.NODE_ENV !== "production") {
    throw new PaymentRoutingError("Live Stripe operations require a production runtime");
  }
  return environment;
}

let client: Stripe | null = null;
let clientKey: string | undefined;
function stripe(): Stripe {
  const key = env.STRIPE_SECRET_KEY;
  primaryStripeEnvironment();
  if (!key) throw new Error("Stripe is not configured");
  if (!client || clientKey !== key) {
    client = new Stripe(key);
    clientKey = key;
  }
  return client;
}

async function stripeForContext(context: StripeContext): Promise<Stripe> {
  if (context.credentialContext !== "primary")
    throw new PaymentRoutingError("Unknown Stripe credential context");
  if (context.environment === "live" && env.NODE_ENV !== "production") {
    throw new PaymentRoutingError("Live Stripe operations require a production runtime");
  }
  assertStripeKeyEnvironment(env.STRIPE_SECRET_KEY, context.environment);
  const gateway = stripe();
  // Authentication/permission errors can contain credential details. Expose only
  // a safe routing error to callers, which may log or return the error message.
  const account = await gateway.accounts.retrieve().catch(() => {
    throw new PaymentRoutingError(
      "Unable to verify the Stripe charge account; check account-read access",
    );
  });
  if (account.id !== context.chargeAccountId) {
    throw new PaymentRoutingError(
      "Stripe credentials do not belong to the expected charge account",
    );
  }
  return gateway;
}

async function connectStripe(target?: { accountId: string }): Promise<Stripe> {
  const config = paymentRoutingConfig(env);
  if (config.mode !== "connect") throw new PaymentRoutingError("Stripe Connect is disabled");
  if (
    target &&
    (!/^acct_[A-Za-z0-9]+$/.test(target.accountId) || target.accountId === config.chargeAccountId)
  ) {
    throw new PaymentRoutingError("A separate valid Stripe Connect account is required");
  }
  return stripeForContext(config);
}

export interface CheckoutParams {
  amount: number; // minor units
  currency: string;
  productName: string;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string;
  /** Opaque data echoed back on the session so the webhook can create the booking. */
  metadata: Record<string, string>;
  /** Resolved on the server from service organization and deployment configuration. */
  route: PaymentRoute;
  /** Durable appointment attempts freeze these before the first external request. */
  idempotencyKey?: string;
  expiresAt?: number;
  clientReferenceId?: string;
}

/** Create a one-off Checkout Session and return its hosted URL + id. */
export async function createCheckoutSession(
  params: CheckoutParams,
): Promise<{ id: string; url: string; session: Stripe.Checkout.Session }> {
  const route = params.route;
  assertCheckoutRoute(route, paymentRoutingConfig(env), params.amount);
  const gateway = await stripeForContext(route);
  if (route.mode === "connect") {
    const destination = await gateway.accounts.retrieve(route.destinationAccountId);
    if (destination.charges_enabled !== true || destination.capabilities?.transfers !== "active") {
      throw new PaymentRoutingError("The Connect destination is not ready to receive payments");
    }
  }
  // Reserved routing metadata comes from the route, including removal of stale dest.
  const businessMetadata = Object.fromEntries(
    Object.entries(params.metadata).filter(([key]) => key !== "dest"),
  );
  const metadata = {
    ...businessMetadata,
    paymentMode: route.mode,
    organizationId: route.organizationId,
    chargeAccountId: route.chargeAccountId,
    paymentEnvironment: route.environment,
    credentialContext: route.credentialContext,
    ...(route.mode === "connect" ? { dest: route.destinationAccountId } : {}),
  };
  const session = await gateway.checkout.sessions.create(
    {
      mode: "payment",
      ...(params.expiresAt ? { expires_at: params.expiresAt } : {}),
      ...(params.clientReferenceId ? { client_reference_id: params.clientReferenceId } : {}),
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: params.currency,
            unit_amount: params.amount,
            product_data: { name: params.productName },
          },
        },
      ],
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      customer_email: params.customerEmail,
      metadata,
      payment_intent_data: {
        metadata,
        // Destination charge: money lands on the host's connected account; the
        // platform keeps `application_fee_amount`. Refunds reverse both.
        ...(route.mode === "connect"
          ? {
              transfer_data: { destination: route.destinationAccountId },
              ...(route.applicationFeeAmount > 0
                ? { application_fee_amount: route.applicationFeeAmount }
                : {}),
            }
          : {}),
      },
    },
    params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : undefined,
  );
  return { id: session.id, url: session.url ?? "", session };
}

/** Historical route context is independent of the mode accepting new sales. */
export async function retrieveSession(
  id: string,
  route?: PaymentRoute,
): Promise<Stripe.Checkout.Session> {
  const gateway = route ? await stripeForContext(route) : stripe();
  return gateway.checkout.sessions.retrieve(id);
}

/** Refund a captured payment (best-effort). Returns true on success. For a
 *  destination charge, supply its saved route so the host's balance is debited too. Legacy callers
 *  retain their recorded destination/boolean convention; current mode is irrelevant. */
export async function refundPayment(
  paymentIntentId: string,
  routing: boolean | PaymentRoute = false,
): Promise<boolean> {
  try {
    const gateway = typeof routing === "boolean" ? stripe() : await stripeForContext(routing);
    const parameters =
      typeof routing === "boolean"
        ? routing
          ? { reverse_transfer: true, refund_application_fee: true }
          : {}
        : refundRoutingParameters(routing);
    await gateway.refunds.create({
      payment_intent: paymentIntentId,
      ...parameters,
    });
    return true;
  } catch (err) {
    logger.error("stripe refund failed", { event: "stripe_refund_failed", err });
    return false;
  }
}

/** Verify + parse a webhook payload. Throws if the signature is invalid. */
export function constructWebhookEvent(payload: string, signature: string): Stripe.Event {
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  const environment = primaryStripeEnvironment();
  const event = stripe().webhooks.constructEvent(payload, signature, secret);
  if (event.livemode !== (environment === "live")) {
    throw new PaymentRoutingError(
      "Stripe webhook environment does not match the configured credentials",
    );
  }
  return event;
}

// ---- Subscription billing (cloud Pro plan, $9/seat/mo) ----

/** The recurring Stripe Price for the Pro plan; billing is disabled without it. */
export const proPriceId = process.env.STRIPE_PRICE_PRO ?? "";
export const subscriptionsEnabled = stripeConfigured && Boolean(proPriceId);

/**
 * Start a per-seat Pro subscription checkout for an org. `quantity` = seat count.
 * Reuses/creates the org's Stripe customer so the portal + webhooks line up.
 */
export async function createSubscriptionCheckout(params: {
  organizationId: string;
  quantity: number;
  customerId?: string | null;
  customerEmail?: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ url: string; customerReset?: boolean }> {
  const base = {
    mode: "subscription",
    line_items: [{ price: proPriceId, quantity: Math.max(1, params.quantity) }],
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    client_reference_id: params.organizationId,
    subscription_data: { metadata: { organizationId: params.organizationId } },
    metadata: { organizationId: params.organizationId },
    allow_promotion_codes: true,
  } satisfies Stripe.Checkout.SessionCreateParams;

  try {
    const session = await stripe().checkout.sessions.create({
      ...base,
      ...(params.customerId
        ? { customer: params.customerId }
        : { customer_email: params.customerEmail }),
    });
    return { url: session.url ?? "" };
  } catch (err) {
    // The stored customer belongs to a different Stripe account/mode (e.g. the
    // STRIPE_SECRET_KEY changed between deploys, or the customer was deleted).
    // Don't wedge checkout on a stale id - mint a fresh customer and signal the
    // caller to clear the bad id. The completion webhook restores the new id.
    if (params.customerId && isMissingCustomer(err, params.customerId)) {
      logger.warn("stripe: stored customer missing, retrying with a fresh one", {
        event: "billing_customer_reset",
        organizationId: params.organizationId,
        customerId: params.customerId,
      });
      const session = await stripe().checkout.sessions.create({
        ...base,
        ...(params.customerEmail ? { customer_email: params.customerEmail } : {}),
      });
      return { url: session.url ?? "", customerReset: true };
    }
    throw err;
  }
}

/** True when a Stripe error is "No such customer" for the id we passed. */
function isMissingCustomer(err: unknown, customerId: string): boolean {
  return (
    err instanceof Stripe.errors.StripeInvalidRequestError &&
    err.code === "resource_missing" &&
    (err.param === "customer" || (err.message ?? "").includes(customerId))
  );
}

/** Billing-portal session so a customer can update seats, card, or cancel. */
export async function createBillingPortalSession(
  customerId: string,
  returnUrl: string,
): Promise<{ url: string }> {
  const session = await stripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  return { url: session.url };
}

/** Fetch a subscription (webhook enrichment). */
export function retrieveSubscription(id: string): Promise<Stripe.Subscription> {
  return stripe().subscriptions.retrieve(id);
}

// ---- Stripe Connect (Express) - hosts get paid directly ----

/** New Connect operations require explicit Connect mode. Historical refunds do not. */
export const connectEnabled = paymentsEnabled && env.STRIPE_PAYMENT_MODE === "connect";

/** Platform's percentage cut on each host transaction (0 = none). Env-configurable. */
export const platformFeePercent = Math.max(
  0,
  Math.min(100, connectEnabled ? Number(env.STRIPE_PLATFORM_FEE_PERCENT ?? "0") || 0 : 0),
);

/** The USD withdrawal minimum ($100), for surfaces that show a single figure
 *  (the status route / mobile). The withdraw gate itself is per-currency - see
 *  `withdrawMinimum()` in lib/booking/money. */
export const WITHDRAW_MINIMUM = withdrawMinimum("usd");

/** The platform fee (minor units) for a charge of `amount`. */
export function platformFee(amount: number): number {
  return Math.round((amount * platformFeePercent) / 100);
}

/** Create an Express connected account for a host, with MANUAL payouts (so the
 *  host withdraws deliberately once they hit the minimum, per product design). */
export async function createConnectAccount(email?: string): Promise<string> {
  const account = await (await connectStripe()).accounts.create({
    type: "express",
    ...(email ? { email } : {}),
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    settings: { payouts: { schedule: { interval: "manual" } } },
  });
  return account.id;
}

/** Hosted onboarding link for an Express account. */
export async function createAccountLink(
  accountId: string,
  refreshUrl: string,
  returnUrl: string,
): Promise<string> {
  const link = await (await connectStripe({ accountId })).accountLinks.create({
    account: accountId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: "account_onboarding",
  });
  return link.url;
}

/** Login link to the Express dashboard (view payouts history, update bank). */
export async function createExpressLoginLink(accountId: string): Promise<string> {
  const link = await (await connectStripe({ accountId })).accounts.createLoginLink(accountId);
  return link.url;
}

export interface ConnectStatus {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  transfersEnabled: boolean;
}

/** Current capability status of a connected account (drives the settings UI). */
export async function retrieveConnectStatus(accountId: string): Promise<ConnectStatus> {
  const a = await (await connectStripe({ accountId })).accounts.retrieve(accountId);
  return {
    chargesEnabled: Boolean(a.charges_enabled),
    payoutsEnabled: Boolean(a.payouts_enabled),
    detailsSubmitted: Boolean(a.details_submitted),
    transfersEnabled: a.capabilities?.transfers === "active",
  };
}

export interface CurrencyBalance {
  currency: string;
  /** Minor units clear to withdraw now. */
  available: number;
  /** Minor units still in Stripe's hold period ("on the way"). */
  pending: number;
}

/** Balances on a host's connected account, one entry per currency they hold.
 *  A host taking payments in multiple currencies has a bucket for each - we must
 *  not collapse to `available[0]` or other-currency funds get stranded. */
export async function connectedBalances(accountId: string): Promise<CurrencyBalance[]> {
  const bal = await (await connectStripe({ accountId })).balance.retrieve({
    stripeAccount: accountId,
  });
  const byCurrency = new Map<string, CurrencyBalance>();
  for (const a of bal.available) {
    const e = byCurrency.get(a.currency) ?? { currency: a.currency, available: 0, pending: 0 };
    e.available += a.amount;
    byCurrency.set(a.currency, e);
  }
  for (const p of bal.pending) {
    const e = byCurrency.get(p.currency) ?? { currency: p.currency, available: 0, pending: 0 };
    e.pending += p.amount;
    byCurrency.set(p.currency, e);
  }
  return [...byCurrency.values()];
}

/** Pay out a host's balance to their bank (manual payout). `idempotencyKey`
 *  guards against a double-submit creating two payouts for the same intent. */
export async function createConnectedPayout(
  accountId: string,
  amount: number,
  currency: string,
  idempotencyKey?: string,
): Promise<{ id: string }> {
  const payout = await (await connectStripe({ accountId })).payouts.create(
    { amount, currency },
    { stripeAccount: accountId, ...(idempotencyKey ? { idempotencyKey } : {}) },
  );
  return { id: payout.id };
}
