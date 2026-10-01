import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), status: vi.fn(), env: {} as Record<string, string | undefined> }));
vi.mock("@dayotter/db", () => ({
  eq: vi.fn(), schema: { users: { id: "id" } },
  getDb: () => ({ query: { users: { findFirst: mocks.user } } }),
}));
vi.mock("../server/env", () => ({ env: mocks.env }));
vi.mock("./stripe", () => ({ retrieveConnectStatus: mocks.status }));
import { checkoutRouteForOrganization } from "./connect";

const organizationId = "00000000-0000-4000-8000-000000000001";
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(mocks.env, {
    NODE_ENV: "test", STRIPE_PAYMENT_MODE: "direct", STRIPE_PAYMENT_ENVIRONMENT: "test",
    STRIPE_SECRET_KEY: "sk_test_fixture", STRIPE_WEBHOOK_SECRET: "whsec_fixture",
    STRIPE_ACCOUNT_ID: "acct_merchant", STRIPE_DIRECT_ORGANIZATION_ID: organizationId,
  });
  mocks.user.mockResolvedValue({ stripeAccountId: "acct_host", stripeChargesEnabled: true });
  mocks.status.mockResolvedValue({ chargesEnabled: true, transfersEnabled: true });
});

it("does not look up stale host Connect state when selecting a direct merchant", async () => {
  await expect(checkoutRouteForOrganization(organizationId, "stale-host", 5000)).resolves.toMatchObject({ mode: "direct" });
  expect(mocks.user).not.toHaveBeenCalled();
  expect(mocks.status).not.toHaveBeenCalled();
});

it("rejects another direct organization before any host lookup", async () => {
  await expect(checkoutRouteForOrganization("00000000-0000-4000-8000-000000000002", "stale-host", 5000)).rejects.toThrow("cannot sell");
  expect(mocks.user).not.toHaveBeenCalled();
});

it("requires an owner and ready stored/fresh account state in Connect mode", async () => {
  mocks.env.STRIPE_PAYMENT_MODE = "connect";
  await expect(checkoutRouteForOrganization(organizationId, null, 5000)).rejects.toThrow("owner");
  mocks.user.mockResolvedValueOnce(undefined);
  await expect(checkoutRouteForOrganization(organizationId, "host", 5000)).rejects.toThrow("no ready");
  mocks.status.mockResolvedValueOnce({ chargesEnabled: false, transfersEnabled: true });
  await expect(checkoutRouteForOrganization(organizationId, "host", 5000)).rejects.toThrow("ready Stripe Connect");
  await expect(checkoutRouteForOrganization(organizationId, "host", 5000)).resolves.toMatchObject({ mode: "connect", destinationAccountId: "acct_host" });
});
