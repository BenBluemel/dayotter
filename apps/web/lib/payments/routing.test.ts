import { describe, expect, it } from "vitest";
import {
  paymentRoutingConfig, resolvePaymentRoute, refundRoutingParameters,
} from "./routing";

const organizationId = "00000000-0000-4000-8000-000000000001";
const otherOrganizationId = "00000000-0000-4000-8000-000000000002";
const configuration = {
  NODE_ENV: "test", STRIPE_PAYMENT_MODE: "direct",
  STRIPE_PAYMENT_ENVIRONMENT: "test", STRIPE_SECRET_KEY: "sk_test_fixture",
  STRIPE_WEBHOOK_SECRET: "whsec_fixture", STRIPE_ACCOUNT_ID: "acct_merchant",
  STRIPE_DIRECT_ORGANIZATION_ID: organizationId, STRIPE_PLATFORM_FEE_PERCENT: "5",
};
const ready = { accountId: "acct_host", chargesEnabled: true, transfersEnabled: true };

describe("explicit payment configuration and routing", () => {
  it("defaults new sales to disabled even with existing Stripe credentials", () => {
    const config = paymentRoutingConfig({ ...configuration, STRIPE_PAYMENT_MODE: undefined });
    expect(config).toEqual({ mode: "disabled" });
    expect(() => resolvePaymentRoute(config, { organizationId, amount: 5000 })).toThrow("disabled");
  });

  it("binds direct payments to the configured organization and ignores Connect state/fees", () => {
    const config = paymentRoutingConfig({ ...configuration, STRIPE_PLATFORM_FEE_PERCENT: "stale" });
    expect(resolvePaymentRoute(config, { organizationId, amount: 5000, destination: ready })).toEqual({
      mode: "direct", organizationId, chargeAccountId: "acct_merchant",
      environment: "test", credentialContext: "primary",
    });
    expect(() => resolvePaymentRoute(config, { organizationId: otherOrganizationId, amount: 5000 })).toThrow("cannot sell");
  });

  it("preserves destination charges and minor-unit fee rounding in Connect mode", () => {
    const config = paymentRoutingConfig({ ...configuration, STRIPE_PAYMENT_MODE: "connect" });
    expect(resolvePaymentRoute(config, { organizationId, amount: 5001, destination: ready })).toMatchObject({
      mode: "connect", destinationAccountId: "acct_host", applicationFeeAmount: 250,
    });
  });

  it.each([
    undefined, { ...ready, accountId: "invalid" }, { ...ready, accountId: "acct_merchant" },
    { ...ready, chargesEnabled: false }, { ...ready, transfersEnabled: false },
  ])("rejects missing or invalid Connect destination state: %j", (destination) => {
    const config = paymentRoutingConfig({ ...configuration, STRIPE_PAYMENT_MODE: "connect" });
    expect(() => resolvePaymentRoute(config, { organizationId, amount: 5000, destination })).toThrow("ready Stripe Connect");
  });

  it.each([
    { STRIPE_PAYMENT_ENVIRONMENT: undefined },
    { STRIPE_SECRET_KEY: "sk_live_fixture" },
    { STRIPE_SECRET_KEY: "sk_org_fixture" },
    { NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_live_fixture" },
    { STRIPE_WEBHOOK_SECRET: undefined },
    { STRIPE_ACCOUNT_ID: undefined },
    { STRIPE_DIRECT_ORGANIZATION_ID: undefined },
    { STRIPE_PAYMENT_ENVIRONMENT: "live", STRIPE_SECRET_KEY: "sk_live_fixture" },
  ])("fails closed for incomplete or mismatched configuration: %j", (change) => {
    expect(() => paymentRoutingConfig({ ...configuration, ...change })).toThrow();
  });

  it("allows explicit live credentials only in a production runtime, and accepts restricted keys", () => {
    expect(paymentRoutingConfig({ ...configuration, STRIPE_SECRET_KEY: "rk_test_fixture" })).toMatchObject({ environment: "test" });
    expect(paymentRoutingConfig({ ...configuration, NODE_ENV: "production", STRIPE_PAYMENT_ENVIRONMENT: "live", STRIPE_SECRET_KEY: "rk_live_fixture" })).toMatchObject({ environment: "live" });
  });

  it("does not reinterpret saved refund routing when current mode changes", () => {
    const oldConnect = resolvePaymentRoute(paymentRoutingConfig({ ...configuration, STRIPE_PAYMENT_MODE: "connect" }), { organizationId, amount: 5000, destination: ready });
    const oldDirect = resolvePaymentRoute(paymentRoutingConfig(configuration), { organizationId, amount: 5000 });
    for (const mode of ["disabled", "direct", "connect"]) {
      paymentRoutingConfig({ ...configuration, STRIPE_PAYMENT_MODE: mode });
      expect(refundRoutingParameters(oldConnect)).toEqual({ reverse_transfer: true, refund_application_fee: true });
      expect(refundRoutingParameters(oldDirect)).toEqual({});
    }
  });
});
