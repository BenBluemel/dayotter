import { afterAll, beforeAll, expect, it } from "vitest";
import { fixtureAttempt } from "./attempt-fixtures";
import { originalBookingRefundRoute } from "./booking-routing";
import { type PaymentRoute, refundRoutingParameters } from "./routing";
const oldKey = process.env.ENCRYPTION_KEY;
beforeAll(() => {
  process.env.ENCRYPTION_KEY = "ab".repeat(32);
});
afterAll(() => {
  if (oldKey === undefined) Reflect.deleteProperty(process.env, "ENCRYPTION_KEY");
  else process.env.ENCRYPTION_KEY = oldKey;
});

it("retains original zero-fee Connect facts for new bookings and the legacy destination convention for old ones", () => {
  const attempt = {
    ...fixtureAttempt(),
    bookingId: "booking",
    paymentIntentId: "pi_saved",
    applicationFeeAmount: 0,
  };
  const booking = {
    id: "booking",
    paymentIntentId: "pi_saved",
    amountPaid: attempt.amount,
    paymentCurrency: attempt.currency,
    destinationAccountId: attempt.destinationAccountId,
  };
  const route = originalBookingRefundRoute(booking, attempt) as PaymentRoute;
  expect(route).toMatchObject({
    mode: "connect",
    applicationFeeAmount: 0,
    destinationAccountId: "acct_host",
  });
  expect(refundRoutingParameters(route)).toEqual({ reverse_transfer: true });
  expect(originalBookingRefundRoute(booking)).toBe(true);
  expect(() => originalBookingRefundRoute({ ...booking, amountPaid: 1 }, attempt)).toThrow(
    "original checkout attempt",
  );
});
