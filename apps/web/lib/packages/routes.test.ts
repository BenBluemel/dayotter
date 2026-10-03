import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  session: vi.fn(),
  owner: vi.fn(),
  balance: vi.fn(),
  previous: vi.fn(),
  booking: vi.fn(),
  prepareCash: vi.fn(),
  prepare: vi.fn(),
  checkout: vi.fn(),
  grant: vi.fn(),
  event: vi.fn(),
}));
vi.mock("../auth/session", () => ({ getSession: mock.session }));
vi.mock("../server/rate-limit", () => ({
  enforceRateLimit: async () => null,
  verifyCaptcha: async () => true,
  clientIp: () => "127.0.0.1",
}));
vi.mock("./credits", () => ({
  requirePackageOwner: mock.owner,
  creditBalance: mock.balance,
  findCreditBooking: mock.previous,
  grantPackageToCustomer: mock.grant,
}));
vi.mock("./purchases", () => ({
  preparePackagePurchase: mock.prepare,
  packageCheckout: mock.checkout,
}));
vi.mock("../payments/stripe", () => ({ paymentsEnabled: true }));
vi.mock("../payments/attempts", () => ({
  findAppointmentAttempt: async () => null,
  prepareAppointmentAttempt: mock.prepareCash,
  appointmentCheckout: vi.fn(),
}));
vi.mock("../booking/create-booking", async () => ({
  BookingError: (await import("../booking/booking-logic")).BookingError,
  createBooking: mock.booking,
}));
vi.mock("@dayotter/db", async (original) => ({
  ...(await original<typeof import("@dayotter/db")>()),
  getDb: () => ({ query: { eventTypes: { findFirst: mock.event } } }),
}));
import { POST as book } from "../../app/api/book/route";
import { POST as buy } from "../../app/api/packages/[id]/buy/route";
import { POST as grant } from "../../app/api/packages/grant/route";
import { BookingError } from "../booking/booking-logic";
const request = (body: unknown) =>
  new Request("https://example.test/api/test", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
let owner: string;
let pkg: string;
let operation: string;
beforeEach(() => {
  vi.resetAllMocks();
  owner = randomUUID();
  pkg = randomUUID();
  operation = randomUUID();
  mock.session.mockResolvedValue({ user: { id: owner, email: "owner@example.test" } });
  mock.owner.mockImplementation(async (id, email) => {
    if (id !== owner || (email && email !== "owner@example.test"))
      throw new BookingError("Sign in with your verified account to use prepaid sessions", 403);
    return { id: owner };
  });
  mock.previous.mockResolvedValue(null);
  mock.balance.mockResolvedValue(1);
  mock.event.mockResolvedValue({ price: 5000, isActive: true });
  mock.booking.mockResolvedValue({ uid: "original", redirectUrl: null });
  mock.prepare.mockResolvedValue({ id: "purchase" });
  mock.checkout.mockResolvedValue({ state: "open", checkoutUrl: "https://checkout.example.test" });
});
const input = () => ({
  eventTypeId: pkg,
  start: "2035-01-01T12:00:00.000Z",
  attendee: { name: "Owner", email: "owner@example.test", timezone: "UTC" },
  redeemCredit: true,
  checkoutRequestId: operation,
});
it("booking redemption takes owner identity only from the authenticated session", async () => {
  expect(
    (
      await book(
        request({ ...input(), creditOwnerUserId: randomUUID(), creditRequestId: "forged" }),
      )
    ).status,
  ).toBe(200);
  expect(mock.balance).toHaveBeenCalledWith(pkg, owner);
  expect(mock.booking).toHaveBeenCalledWith(
    expect.objectContaining({ creditOwnerUserId: owner, creditRequestId: operation }),
  );
  expect(mock.prepareCash).not.toHaveBeenCalled();
});
it("another customer's email is rejected without leaking package details or creating cash checkout", async () => {
  const data = input();
  data.attendee.email = "victim@example.test";
  const response = await book(request(data));
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    error: "Sign in with your verified account to use prepaid sessions",
  });
  expect(mock.balance).not.toHaveBeenCalled();
  expect(mock.booking).not.toHaveBeenCalled();
  expect(mock.prepareCash).not.toHaveBeenCalled();
});
it("anonymous email-only redemption cannot bypass ownership", async () => {
  mock.session.mockResolvedValue(null);
  expect((await book(request({ ...input(), creditOwnerUserId: owner }))).status).toBe(403);
  expect(mock.balance).not.toHaveBeenCalled();
  expect(mock.booking).not.toHaveBeenCalled();
});
it("a response-loss retry returns the original credit booking before checking today's balance", async () => {
  mock.previous.mockResolvedValue({ uid: "original" });
  expect(await (await book(request(input()))).json()).toMatchObject({ uid: "original" });
  expect(mock.balance).not.toHaveBeenCalled();
  expect(mock.booking).not.toHaveBeenCalled();
});
it("package purchases bind authenticated identity and stable operation, ignoring forged owner", async () => {
  expect(
    (
      await buy(request({ requestId: operation, ownerUserId: randomUUID() }), {
        params: Promise.resolve({ id: pkg }),
      })
    ).status,
  ).toBe(200);
  expect(mock.prepare).toHaveBeenCalledWith(pkg, owner, operation);
});
it("purchase identity mismatch fails generically without revealing package details", async () => {
  expect(
    (
      await buy(request({ requestId: operation, clientEmail: "victim@example.test" }), {
        params: Promise.resolve({ id: pkg }),
      })
    ).status,
  ).toBe(403);
  expect(mock.prepare).not.toHaveBeenCalled();
});
it("package purchases require authentication and stable operation identity", async () => {
  expect((await buy(request({}), { params: Promise.resolve({ id: pkg }) })).status).toBe(400);
  mock.session.mockResolvedValue(null);
  expect(
    (await buy(request({ requestId: operation }), { params: Promise.resolve({ id: pkg }) })).status,
  ).toBe(401);
  expect(mock.prepare).not.toHaveBeenCalled();
});
it("staff grants use the authenticated actor and require a stable grant identity", async () => {
  expect(
    (
      await grant(
        request({
          packageId: pkg,
          clientEmail: "owner@example.test",
          operationId: operation,
          actorUserId: randomUUID(),
        }),
        undefined,
      )
    ).status,
  ).toBe(200);
  expect(mock.grant).toHaveBeenCalledWith(owner, pkg, "owner@example.test", operation);
  expect(
    (await grant(request({ packageId: pkg, clientEmail: "owner@example.test" }), undefined)).status,
  ).toBe(400);
});
