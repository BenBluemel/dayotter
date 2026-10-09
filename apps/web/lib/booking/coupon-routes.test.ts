import { describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  user: null as null | { id: string; email: string; name: string | null },
}));
vi.mock("@/lib/auth/session", () => ({
  getSession: async () => (mock.user ? { user: mock.user } : null),
}));
vi.mock("@/lib/server/rate-limit", () => ({
  enforceRateLimit: async () => null,
  verifyCaptcha: async () => true,
  clientIp: () => "127.0.0.1",
}));
vi.mock("@dayotter/db", async (original) => ({
  ...(await original<typeof import("@dayotter/db")>()),
  getDb: () => ({ query: { memberships: { findFirst: async () => null } } }),
}));
import { POST as book } from "@/app/api/book/route";
import { POST as preview } from "@/app/api/coupons/preview/route";
import { GET, PATCH, POST } from "@/app/api/coupons/route";
import { PATCH as timezone } from "@/app/api/coupons/timezone/route";
const org = "11111111-1111-4111-8111-111111111111";
const coupon = {
  organizationId: org,
  code: " Friend50 ",
  label: null,
  isActive: true,
  discountKind: "percentage",
  discountValue: 5000,
  currency: null,
  startDate: "2026-10-01",
  endDate: "2026-10-31",
  minimumBasePrice: null,
  globalLimit: 1,
  perCustomerLimit: 1,
  eventTypeIds: ["22222222-2222-4222-8222-222222222222"],
};
const req = (path: string, body: unknown, method = "POST") =>
  new Request(`https://example.test${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
describe("coupon API authorization", () => {
  it("rejects guest booking even when the body supplies a customer identity", async () => {
    mock.user = null;
    const response = await book(
      req("/api/book", {
        eventTypeId: coupon.eventTypeIds[0],
        start: "2026-10-15T15:00:00Z",
        attendee: { name: "Client", email: "victim@example.test", timezone: "UTC" },
        couponCode: "FRIEND50",
        couponCustomerUserId: "33333333-3333-4333-8333-333333333333",
      }),
    );
    expect(response.status).toBe(401);
  });
  it("rejects simultaneous coupon and package selection before financial work", async () => {
    mock.user = {
      id: "33333333-3333-4333-8333-333333333333",
      email: "client@example.test",
      name: null,
    };
    const response = await book(
      req("/api/book", {
        eventTypeId: coupon.eventTypeIds[0],
        start: "2026-10-15T15:00:00Z",
        attendee: { name: "Client", email: "client@example.test", timezone: "UTC" },
        couponCode: "FRIEND50",
        redeemCredit: true,
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/either/);
  });
  it("requires a session to manage, preview, or change timezone", async () => {
    mock.user = null;
    expect(
      (await GET(new Request(`https://example.test/api/coupons?organizationId=${org}`), undefined))
        .status,
    ).toBe(401);
    expect((await POST(req("/api/coupons", coupon), undefined)).status).toBe(401);
    expect(
      (await PATCH(req("/api/coupons", { ...coupon, id: org }, "PATCH"), undefined)).status,
    ).toBe(401);
    expect(
      (
        await timezone(
          req(
            "/api/coupons/timezone",
            { organizationId: org, businessTimezone: "America/Boise" },
            "PATCH",
          ),
          undefined,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await preview(
          req("/api/coupons/preview", {
            eventTypeId: coupon.eventTypeIds[0],
            start: "2026-10-15T15:00:00Z",
            couponCode: "FRIEND50",
          }),
        )
      ).status,
    ).toBe(401);
  });
  it("denies authenticated non-admin management without querying coupons", async () => {
    mock.user = {
      id: "33333333-3333-4333-8333-333333333333",
      email: "customer@example.test",
      name: null,
    };
    expect(
      (await GET(new Request(`https://example.test/api/coupons?organizationId=${org}`), undefined))
        .status,
    ).toBe(403);
    expect((await POST(req("/api/coupons", coupon), undefined)).status).toBe(403);
    expect(
      (
        await timezone(
          req(
            "/api/coupons/timezone",
            { organizationId: org, businessTimezone: "America/Boise" },
            "PATCH",
          ),
          undefined,
        )
      ).status,
    ).toBe(403);
  });
});
