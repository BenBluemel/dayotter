import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { ResourceInvariantError } from "../booking/booking-logic";
import { fixtureAttempt, fixturePaidSession } from "./attempt-fixtures";
import { type PaymentAttempt, decodeAttempt } from "./attempt-terms";

const mocks = vi.hoisted(() => ({
  attempt: null as PaymentAttempt | null,
  retrieve: vi.fn(),
  reconcile: vi.fn(),
  review: vi.fn(),
  claim: vi.fn(),
  booking: vi.fn(),
}));
vi.mock("./stripe", () => ({ retrieveSession: mocks.retrieve, refundPayment: vi.fn() }));
vi.mock("./pending", () => ({ claimPendingBooking: mocks.claim }));
vi.mock("./payment-events", () => ({ reconcileSession: mocks.reconcile }));
vi.mock("./payment-work", () => ({ requirePaymentReview: mocks.review }));
vi.mock("../booking/create-booking", async () => ({
  BookingError: (await import("../booking/booking-logic")).BookingError,
  createBooking: vi.fn(),
}));
vi.mock("@dayotter/db", async (original) => ({
  ...(await original<typeof import("@dayotter/db")>()),
  getDb: () => ({
    query: {
      paymentAttempts: { findFirst: async () => mocks.attempt },
      bookings: { findFirst: mocks.booking },
    },
  }),
}));
import { fulfillCheckout } from "./fulfill";
import { PaymentContradictionError } from "./routing";
const oldKey = process.env.ENCRYPTION_KEY;
beforeAll(() => {
  process.env.ENCRYPTION_KEY = "ab".repeat(32);
});
afterAll(() => {
  if (oldKey === undefined) Reflect.deleteProperty(process.env, "ENCRYPTION_KEY");
  else process.env.ENCRYPTION_KEY = oldKey;
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.attempt = {
    ...fixtureAttempt(),
    checkoutSessionId: "cs_saved",
    state: "open",
    paymentIntentId: "pi_saved",
  };
  mocks.retrieve.mockResolvedValue(fixturePaidSession(mocks.attempt));
});
it("uses durable reconciliation after Redis loss, with the saved account route", async () => {
  mocks.reconcile.mockImplementation(async () => {
    mocks.attempt!.bookingId = "saved";
    return "fulfilled";
  });
  mocks.booking.mockResolvedValue({ uid: "booking", paymentIntentId: "pi_saved" });
  await expect(fulfillCheckout("cs_saved")).resolves.toEqual({
    uid: "booking",
    pending: false,
    state: "fulfilled",
  });
  expect(mocks.retrieve).toHaveBeenCalledWith("cs_saved", decodeAttempt(mocks.attempt!).route);
  expect(mocks.claim).not.toHaveBeenCalled();
});
it("reports contradictions as review without a refund promise or legacy claim", async () => {
  mocks.reconcile.mockRejectedValue(new PaymentContradictionError("Wrong amount"));
  await expect(fulfillCheckout("cs_saved")).resolves.toMatchObject({
    uid: null,
    pending: true,
    state: "requires_review",
  });
  expect(mocks.review).toHaveBeenCalled();
  expect(mocks.claim).not.toHaveBeenCalled();
});
it("browser visits do not establish success and transient reads remain retryable", async () => {
  mocks.reconcile.mockResolvedValue("waiting_payment");
  await expect(fulfillCheckout("cs_saved")).resolves.toMatchObject({
    uid: null,
    pending: true,
    state: "waiting_payment",
  });
  mocks.retrieve.mockRejectedValue(new Error("Stripe unavailable"));
  await expect(fulfillCheckout("cs_saved")).rejects.toThrow("Stripe unavailable");
});

it("browser resource invariants enter technical review without Redis or refunds", async () => {
  mocks.reconcile.mockRejectedValue(
    new ResourceInvariantError(
      "resource_plan_completeness_violation",
      new Error("Corrupted scheduling custody"),
    ),
  );
  await expect(fulfillCheckout("cs_saved")).resolves.toMatchObject({
    uid: null,
    pending: true,
    state: "requires_review",
  });
  expect(mocks.review).toHaveBeenCalledWith(
    mocks.attempt!.id,
    "resource_invariant_requires_review",
  );
  expect(mocks.claim).not.toHaveBeenCalled();
});
