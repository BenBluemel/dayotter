import { type Database, eq, getDb, schema } from "@dayotter/db";
import { appointmentRequestIdentity } from "../payments/attempt-terms";
import { BookingError } from "./booking-logic";
import type { CreateBookingInput } from "./create-booking";

type Reader = Pick<Database, "query">;

export function zeroCashBookingIdentity(input: CreateBookingInput) {
  const {
    pricingQuote,
    quotedDurationMinutes,
    bookingRequestId,
    bookingReturnPath,
    paymentAttemptId,
    payment,
    redeemCredit,
    creditOwnerUserId,
    creditRequestId,
    creditReturnPath,
    ...intent
  } = input;
  return appointmentRequestIdentity(intent, bookingReturnPath ?? "/", bookingRequestId);
}

/** Return the committed original result before reading mutable service/promotion settings. */
export async function findZeroCashBooking(input: CreateBookingInput, db: Reader = getDb()) {
  const identity = zeroCashBookingIdentity(input);
  const claim = await db.query.bookingSettlementClaims.findFirst({
    where: eq(schema.bookingSettlementClaims.operationKey, identity.key),
  });
  if (!claim || claim.settlement !== "zero_cash") return null;
  if (claim.requestFingerprint !== identity.fingerprint)
    throw new BookingError("Booking request was reused with different details", 409);
  const booking = await db.query.bookings.findFirst({
    where: eq(schema.bookings.id, claim.sourceId),
  });
  if (!booking) throw new BookingError("Booking requires reconciliation", 409);
  return booking;
}
