import type { schema } from "@dayotter/db";
import { type PaymentAttempt, attemptRoute } from "./attempt-terms";
import { type PaymentRoute, PaymentRoutingError } from "./routing";

type BookingPayment = Pick<
  typeof schema.bookings.$inferSelect,
  "id" | "paymentIntentId" | "amountPaid" | "paymentCurrency" | "destinationAccountId"
>;

/** Existing best-effort refunds can use saved fee/account facts without a durable refund workflow. */
export function originalBookingRefundRoute(
  booking: BookingPayment,
  attempt?: PaymentAttempt,
): PaymentRoute | boolean {
  if (!attempt) return Boolean(booking.destinationAccountId);
  if (
    attempt.bookingId !== booking.id ||
    attempt.paymentIntentId !== booking.paymentIntentId ||
    attempt.amount !== booking.amountPaid ||
    attempt.currency !== booking.paymentCurrency ||
    attempt.destinationAccountId !== booking.destinationAccountId
  ) {
    throw new PaymentRoutingError("Booking payment does not match its original checkout attempt");
  }
  return attemptRoute(attempt);
}
