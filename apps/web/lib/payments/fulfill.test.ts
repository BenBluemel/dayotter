import { beforeEach, describe, expect, it, vi } from "vitest";
import { BookingError } from "../booking/booking-logic";

const mocks = vi.hoisted(() => ({
  retrieve: vi.fn(),
  claim: vi.fn(),
  create: vi.fn(),
  refund: vi.fn(),
  lookup: vi.fn(),
  attempt: vi.fn(),
  service: vi.fn(),
}));
vi.mock("./stripe", () => ({ retrieveSession: mocks.retrieve, refundPayment: mocks.refund }));
vi.mock("./pending", () => ({ claimPendingBooking: mocks.claim }));
vi.mock("../booking/create-booking", async () => ({
  BookingError: (await import("../booking/booking-logic")).BookingError,
  createBooking: mocks.create,
}));
vi.mock("@dayotter/db", () => ({
  eq: vi.fn(),
  schema: {
    bookings: { paymentIntentId: "payment_intent_id" },
    eventTypes: { id: "id" },
    paymentAttempts: { checkoutSessionId: "checkout_session_id", id: "id" },
  },
  getDb: () => ({
    query: {
      bookings: { findFirst: mocks.lookup },
      paymentAttempts: { findFirst: mocks.attempt },
      eventTypes: { findFirst: mocks.service },
    },
  }),
}));
import { fulfillCheckout } from "./fulfill";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.lookup.mockResolvedValue(undefined);
  mocks.attempt.mockResolvedValue(undefined);
  mocks.claim.mockResolvedValue({ eventTypeId: "event", start: "2026-10-15T10:00:00Z" });
  mocks.refund.mockResolvedValue(true);
});

describe("checkout failure refunds", () => {
  it.each([
    ["acct_host", true],
    [undefined, false],
  ])("reverses a transfer only for destination %s", async (dest, reverse) => {
    mocks.retrieve.mockResolvedValue({
      payment_status: "paid",
      payment_intent: "pi_test",
      amount_total: 4000,
      currency: "usd",
      metadata: { token: "token", dest },
    });
    const error = new BookingError("Slot taken", 409);
    mocks.create.mockRejectedValue(error);
    await expect(fulfillCheckout("cs_test")).rejects.toBe(error);
    expect(mocks.refund).toHaveBeenCalledTimes(1);
    expect(mocks.refund).toHaveBeenCalledWith("pi_test", reverse);
  });

  it("does not refund a booking another fulfillment handler already completed", async () => {
    mocks.retrieve.mockResolvedValue({
      payment_status: "paid",
      payment_intent: "pi_test",
      metadata: { token: "token", dest: "acct_host" },
    });
    mocks.lookup.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ uid: "booked" });
    mocks.create.mockRejectedValue(new BookingError("Slot taken", 409));
    await expect(fulfillCheckout("cs_test")).resolves.toEqual({ uid: "booked", pending: false });
    expect(mocks.refund).not.toHaveBeenCalled();
  });
});

it("legacy resource checkout fails closed without allocating or guessing a refund", async () => {
  mocks.retrieve.mockResolvedValue({
    payment_status: "paid",
    payment_intent: "pi_test",
    metadata: { token: "token" },
  });
  mocks.service.mockResolvedValue({ id: "event", resourceAdmissionEpoch: 1 });
  await expect(fulfillCheckout("cs_test")).resolves.toMatchObject({
    uid: null,
    pending: true,
    state: "requires_review",
  });
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.refund).not.toHaveBeenCalled();
});
it("legacy checkout cannot guess a refund when resource admission changes during fulfillment", async () => {
  mocks.retrieve.mockResolvedValue({
    payment_status: "paid",
    payment_intent: "pi_test",
    metadata: { token: "token" },
  });
  mocks.service
    .mockResolvedValueOnce({ id: "event", resourceAdmissionEpoch: 0 })
    .mockResolvedValueOnce({ id: "event", resourceAdmissionEpoch: 1 });
  mocks.create.mockRejectedValue(new BookingError("This service requires durable checkout", 409));
  await expect(fulfillCheckout("cs_test")).resolves.toMatchObject({
    uid: null,
    pending: true,
    state: "requires_review",
  });
  expect(mocks.refund).not.toHaveBeenCalled();
});
