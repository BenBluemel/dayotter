import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ event: vi.fn(), create: vi.fn(), user: "" }));
vi.mock("@/lib/server/api-key", () => ({
  withApiKey:
    (handler: (caller: { userId: string }, request: Request) => Promise<Response>) =>
    (request: Request) =>
      handler({ userId: mock.user }, request),
}));
vi.mock("@/lib/server/env", () => ({ env: { APP_URL: "https://example.test" } }));
vi.mock("@/lib/booking/create-booking", async () => ({
  BookingError: (await import("@/lib/booking/booking-logic")).BookingError,
  createBooking: mock.create,
}));
vi.mock("@dayotter/db", async (original) => ({
  ...(await original<typeof import("@dayotter/db")>()),
  getDb: () => ({ query: { eventTypes: { findFirst: mock.event } } }),
}));
import { BookingError } from "@/lib/booking/booking-logic";
import { POST } from "../../app/api/v1/bookings/route";
const operation = randomUUID();
const body = () => ({
  eventTypeId: randomUUID(),
  start: "2035-10-15T12:00:00Z",
  attendee: { name: "Client", email: "client@example.test", timezone: "UTC" },
  checkoutRequestId: operation,
});
const request = (input: unknown) =>
  new Request("https://example.test/api/v1/bookings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
beforeEach(() => {
  vi.resetAllMocks();
  mock.user = randomUUID();
  mock.event.mockResolvedValue({ id: randomUUID(), price: 5000 });
  mock.create.mockResolvedValue({ uid: "original" });
});
it("the versioned API delegates pricing rather than rejecting the undiscounted base price", async () => {
  const input = body();
  expect((await POST(request(input), undefined)).status).toBe(201);
  expect(mock.create).toHaveBeenCalledWith(
    expect.objectContaining({ bookingRequestId: operation, start: input.start }),
  );
});
it("positive cash rejected by the shared booking writer is reported truthfully", async () => {
  mock.create.mockRejectedValue(
    new BookingError("A payment is required; book through the public checkout", 402),
  );
  const response = await POST(request(body()), undefined);
  expect(response.status).toBe(402);
  expect(await response.json()).toEqual({
    error: "A payment is required; book through the public checkout",
  });
});
it("no caller-supplied quote, payment, coupon, or credit identity enters the internal financial boundary", async () => {
  await POST(
    request({
      ...body(),
      pricingQuote: { effectivePrice: 0 },
      payment: { amountPaid: 100 },
      redeemCredit: true,
      creditOwnerUserId: randomUUID(),
      couponCode: "FRIEND50",
    }),
    undefined,
  );
  const input = mock.create.mock.calls[0]![0];
  for (const field of [
    "pricingQuote",
    "payment",
    "redeemCredit",
    "creditOwnerUserId",
    "couponCode",
  ])
    expect(input).not.toHaveProperty(field);
});
it("a service outside the API caller scope is rejected before pricing or booking", async () => {
  mock.event.mockResolvedValue(null);
  expect((await POST(request(body()), undefined)).status).toBe(404);
  expect(mock.create).not.toHaveBeenCalled();
});
