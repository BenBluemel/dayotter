import { randomUUID } from "node:crypto";
import { eq, getDb, schema } from "@dayotter/db";
import { connection } from "@dayotter/jobs";
import { BookingError } from "../booking/booking-logic";
import type { CreateBookingInput } from "../booking/create-booking";

const PREFIX = "dayotter:pendingbooking:";
const TTL_SECONDS = 3600; // a checkout session lives ~1h

/** Stash the intended booking while the booker completes Stripe Checkout. */
export async function stashPendingBooking(input: CreateBookingInput): Promise<string> {
  await getDb().transaction(async (tx) => {
    const [service] = await tx
      .select()
      .from(schema.eventTypes)
      .where(eq(schema.eventTypes.id, input.eventTypeId))
      .for("share");
    if (service?.resourceAdmissionEpoch)
      throw new BookingError("This service requires durable checkout", 409);
  });
  const token = randomUUID();
  await connection.set(`${PREFIX}${token}`, JSON.stringify(input), "EX", TTL_SECONDS);
  return token;
}

/** Atomically claim (GET + DEL) the stashed booking - one-time use so the success
 *  handler and the webhook can't both create it. */
export async function claimPendingBooking(token: string): Promise<CreateBookingInput | null> {
  const raw = await connection.getdel(`${PREFIX}${token}`);
  return raw ? (JSON.parse(raw) as CreateBookingInput) : null;
}
