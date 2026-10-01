import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { fixtureAttempt, fixtureSession } from "./attempt-fixtures";
import { type PaymentAttempt, decodeAttempt } from "./attempt-terms";

const mocks = vi.hoisted(() => ({
  attempt: null as PaymentAttempt | null,
  retrieve: vi.fn(),
  create: vi.fn(),
  refund: vi.fn(),
  claim: vi.fn(),
  bind: vi.fn(),
  booking: vi.fn(),
}));
vi.mock("./stripe", () => ({ retrieveSession: mocks.retrieve, refundPayment: mocks.refund }));
vi.mock("./pending", () => ({ claimPendingBooking: mocks.claim }));
vi.mock("./attempts", () => ({ bindAttemptSession: mocks.bind }));
vi.mock("../booking/create-booking", async () => ({
  BookingError: (await import("../booking/booking-logic")).BookingError,
  createBooking: mocks.create,
}));
vi.mock("@dayotter/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dayotter/db")>()),
  getDb: () => ({
    query: {
      paymentAttempts: { findFirst: async () => mocks.attempt },
      bookings: { findFirst: mocks.booking },
    },
  }),
}));
import { fulfillCheckout } from "./fulfill";
const oldKey = process.env.ENCRYPTION_KEY;
beforeAll(() => {
  process.env.ENCRYPTION_KEY = "ab".repeat(32);
});
afterAll(() => {
  if (oldKey === undefined) Reflect.deleteProperty(process.env, "ENCRYPTION_KEY");
  else process.env.ENCRYPTION_KEY = oldKey;
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.attempt = {
    ...fixtureAttempt(),
    checkoutSessionId: "cs_saved",
    state: "open",
    paymentIntentId: "pi_saved",
  };
  mocks.retrieve.mockResolvedValue({
    ...fixtureSession(mocks.attempt),
    payment_status: "paid",
    payment_intent: "pi_saved",
    status: "complete",
  });
  mocks.bind.mockImplementation(async (attempt: PaymentAttempt) => attempt);
  mocks.create.mockResolvedValue({ uid: "booking", redirectUrl: null });
});

it("fulfills with the saved quote/routing/intent after Redis loss, without a new pricing decision", async () => {
  await expect(fulfillCheckout("cs_saved")).resolves.toEqual({ uid: "booking", pending: false });
  const terms = decodeAttempt(mocks.attempt!);
  expect(mocks.create).toHaveBeenCalledWith({
    ...terms.input,
    paymentAttemptId: mocks.attempt!.id,
    pricingQuote: terms.quote,
    quotedDurationMinutes: 30,
    payment: {
      paymentIntentId: "pi_saved",
      amountPaid: 3500,
      currency: "usd",
      destinationAccountId: "acct_host",
    },
  });
  expect(mocks.retrieve).toHaveBeenCalledWith("cs_saved", terms.route);
  expect(mocks.claim).not.toHaveBeenCalled();
});

it("rejects mismatched paid totals before creating a booking", async () => {
  mocks.retrieve.mockResolvedValue({
    ...fixtureSession(mocks.attempt!),
    payment_status: "paid",
    payment_intent: "pi_saved",
    amount_total: 1,
  });
  await expect(fulfillCheckout("cs_saved")).rejects.toThrow("saved checkout terms");
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.refund).not.toHaveBeenCalled();
});

it("does not refund a committed booking when post-commit finalization fails", async () => {
  mocks.create.mockImplementation(async () => {
    mocks.attempt!.bookingId = "saved-booking";
    mocks.attempt!.state = "fulfilled";
    throw new Error("queue unavailable");
  });
  mocks.booking.mockResolvedValue({ uid: "saved", paymentIntentId: "pi_saved" });
  await expect(fulfillCheckout("cs_saved")).resolves.toEqual({ uid: "saved", pending: false });
  expect(mocks.refund).not.toHaveBeenCalled();
});
