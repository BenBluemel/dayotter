/** Nonsecret payment identity, suitable for a future durable PaymentAttempt. */
export interface StripeContext {
  chargeAccountId: string;
  environment: "test" | "live";
  credentialContext: "primary";
}

export type PaymentRoute = StripeContext & { organizationId: string } & (
  | { mode: "direct" }
  | { mode: "connect"; destinationAccountId: string; applicationFeeAmount: number }
);

export type PaymentRoutingConfig =
  | { mode: "disabled" }
  | (StripeContext & { mode: "direct"; organizationId: string })
  | (StripeContext & { mode: "connect"; platformFeePercent: number });

export class PaymentRoutingError extends Error {
  constructor(message: string, public readonly status = 503) {
    super(message);
    this.name = "PaymentRoutingError";
  }
}

interface RoutingEnvironment {
  STRIPE_PAYMENT_MODE?: string;
  STRIPE_PAYMENT_ENVIRONMENT?: string;
  STRIPE_ACCOUNT_ID?: string;
  STRIPE_DIRECT_ORGANIZATION_ID?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?: string;
  STRIPE_PLATFORM_FEE_PERCENT?: string;
  NODE_ENV?: string;
}

export function assertStripeKeyEnvironment(key: string | undefined, environment: "test" | "live") {
  // Account-scoped secret/restricted keys only; organization keys require a
  // different account-context design. Never echo credential values in errors.
  if (!key || !new RegExp(`^(sk|rk)_${environment}_[A-Za-z0-9]+$`).test(key)) {
    throw new PaymentRoutingError("Stripe API key does not match the expected payment environment");
  }
}

/** Missing mode disables new sales. Validation occurs at use, allowing builds without secrets. */
export function paymentRoutingConfig(input: RoutingEnvironment): PaymentRoutingConfig {
  const mode = input.STRIPE_PAYMENT_MODE ?? "disabled";
  if (mode === "disabled") return { mode };
  if (mode !== "direct" && mode !== "connect") {
    throw new PaymentRoutingError("Invalid STRIPE_PAYMENT_MODE");
  }
  const environment = input.STRIPE_PAYMENT_ENVIRONMENT;
  if (environment !== "test" && environment !== "live") {
    throw new PaymentRoutingError("STRIPE_PAYMENT_ENVIRONMENT must explicitly be test or live");
  }
  if (environment === "live" && input.NODE_ENV !== "production") {
    throw new PaymentRoutingError("Live Stripe sales require a production runtime");
  }
  assertStripeKeyEnvironment(input.STRIPE_SECRET_KEY, environment);
  if (!input.STRIPE_WEBHOOK_SECRET?.startsWith("whsec_")) {
    throw new PaymentRoutingError("Stripe sales require a webhook signing secret");
  }
  const publishable = input.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  if (publishable && !new RegExp(`^pk_${environment}_[A-Za-z0-9]+$`).test(publishable)) {
    throw new PaymentRoutingError("Stripe publishable key does not match the payment environment");
  }
  const chargeAccountId = input.STRIPE_ACCOUNT_ID;
  if (!chargeAccountId || !/^acct_[A-Za-z0-9]+$/.test(chargeAccountId)) {
    throw new PaymentRoutingError("Stripe sales require an explicit STRIPE_ACCOUNT_ID");
  }
  const context = { chargeAccountId, environment, credentialContext: "primary" as const };
  if (mode === "direct") {
    const organizationId = input.STRIPE_DIRECT_ORGANIZATION_ID;
    if (!organizationId || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(organizationId)) {
      throw new PaymentRoutingError("Direct Stripe sales require STRIPE_DIRECT_ORGANIZATION_ID");
    }
    return { ...context, mode, organizationId };
  }
  const platformFeePercent = Number(input.STRIPE_PLATFORM_FEE_PERCENT ?? "0");
  if (!Number.isFinite(platformFeePercent) || platformFeePercent < 0 || platformFeePercent > 100) {
    throw new PaymentRoutingError("STRIPE_PLATFORM_FEE_PERCENT must be between 0 and 100");
  }
  return { ...context, mode, platformFeePercent };
}

export interface DestinationState {
  accountId: string;
  chargesEnabled: boolean;
  transfersEnabled: boolean;
}

export function resolvePaymentRoute(
  config: PaymentRoutingConfig,
  input: { organizationId: string; amount: number; destination?: DestinationState },
): PaymentRoute {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0 || input.amount > 2_147_483_647) {
    throw new PaymentRoutingError("Checkout requires a positive integer cash amount", 400);
  }
  if (config.mode === "disabled") throw new PaymentRoutingError("Cash checkout is disabled");
  if (!input.organizationId) throw new PaymentRoutingError("Checkout organization is required", 403);
  if (config.mode === "direct") {
    if (input.organizationId !== config.organizationId) {
      throw new PaymentRoutingError("This organization cannot sell through the configured merchant", 403);
    }
    // Do not spread input or destination state: stale Connect fields are ignored.
    return {
      mode: "direct", organizationId: config.organizationId,
      chargeAccountId: config.chargeAccountId, environment: config.environment,
      credentialContext: config.credentialContext,
    };
  }
  const destination = input.destination;
  if (!destination || !/^acct_[A-Za-z0-9]+$/.test(destination.accountId)
    || destination.accountId === config.chargeAccountId
    || !destination.chargesEnabled || !destination.transfersEnabled) {
    throw new PaymentRoutingError("A ready Stripe Connect destination is required");
  }
  return {
    mode: "connect", organizationId: input.organizationId,
    chargeAccountId: config.chargeAccountId, environment: config.environment,
    credentialContext: config.credentialContext,
    destinationAccountId: destination.accountId,
    applicationFeeAmount: Math.round(input.amount * config.platformFeePercent / 100),
  };
}

/** Recheck a new-sale route at the gateway; historical operations never use this check. */
export function assertCheckoutRoute(route: PaymentRoute, config: PaymentRoutingConfig, amount: number) {
  const expected = resolvePaymentRoute(config, {
    organizationId: route.organizationId, amount,
    destination: route.mode === "connect" ? {
      accountId: route.destinationAccountId, chargesEnabled: true, transfersEnabled: true,
    } : undefined,
  });
  if (route.mode !== expected.mode || route.chargeAccountId !== expected.chargeAccountId
    || route.environment !== expected.environment || route.credentialContext !== expected.credentialContext
    || (route.mode === "connect" && expected.mode === "connect"
      && route.applicationFeeAmount !== expected.applicationFeeAmount)) {
    throw new PaymentRoutingError("Checkout routing no longer matches deployment configuration");
  }
}

/** Preserve historical facts; this function deliberately has no deployment mode input. */
export function refundRoutingParameters(route: PaymentRoute) {
  return route.mode === "connect"
    ? { reverse_transfer: true, ...(route.applicationFeeAmount > 0 ? { refund_application_fee: true } : {}) }
    : {};
}
