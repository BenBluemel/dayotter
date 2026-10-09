import type { AppointmentPrice } from "@dayotter/core";
import { type Database, and, eq, getDb, inArray, schema } from "@dayotter/db";
import { BookingError } from "./booking-logic";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Writer = Pick<Database, "transaction">;

function couponTerms(price: AppointmentPrice) {
  if (price.settlement !== "cash" || !price.coupon || price.version !== 2)
    throw new BookingError("A coupon quote is required", 409);
  return price.coupon;
}

/** The coupon row serializes final-use checks across every web instance. */
export async function reserveCouponUse(
  tx: Transaction,
  price: AppointmentPrice,
  customerUserId: string,
  operationKey: string,
  requestFingerprint: string,
  source: { attemptId: string; expiresAt: Date } | { bookingId: string },
) {
  const terms = couponTerms(price);
  const [definition] = await tx
    .select()
    .from(schema.appointmentCoupons)
    .where(
      and(
        eq(schema.appointmentCoupons.id, terms.id),
        eq(schema.appointmentCoupons.organizationId, price.organizationId),
      ),
    )
    .for("update");
  if (!definition) throw new BookingError("Coupon code not recognized", 400);
  const sameTerms =
    definition.isActive &&
    definition.code === terms.code &&
    definition.label === terms.label &&
    definition.startsAt.toISOString() === terms.startsAt &&
    definition.endsAt.toISOString() === terms.endsAt &&
    definition.minimumBasePrice === terms.minimumBasePrice &&
    definition.discountKind === terms.discount.kind &&
    definition.discountValue ===
      (terms.discount.kind === "percentage" ? terms.discount.basisPoints : terms.discount.amount) &&
    definition.currency === (terms.discount.kind === "fixed" ? terms.discount.currency : null);
  if (!sameTerms) throw new BookingError("Coupon terms changed; review the price again", 409);
  const link = await tx.query.appointmentCouponEventTypes.findFirst({
    where: and(
      eq(schema.appointmentCouponEventTypes.couponId, definition.id),
      eq(schema.appointmentCouponEventTypes.organizationId, price.organizationId),
      eq(schema.appointmentCouponEventTypes.eventTypeId, price.eventTypeId),
    ),
  });
  if (!link) throw new BookingError("This coupon does not apply to this service", 400);
  const existing = await tx.query.appointmentCouponUses.findFirst({
    where: eq(schema.appointmentCouponUses.operationKey, operationKey),
  });
  if (existing) {
    if (
      existing.couponId !== terms.id ||
      existing.customerUserId !== customerUserId ||
      existing.requestFingerprint !== requestFingerprint ||
      existing.paymentAttemptId !== ("attemptId" in source ? source.attemptId : null) ||
      existing.bookingId !== ("bookingId" in source ? source.bookingId : null)
    )
      throw new BookingError("Booking request was reused with different coupon details", 409);
    return existing;
  }
  if (definition.globalLimit != null || definition.perCustomerLimit != null) {
    const active = await tx
      .select({ customerUserId: schema.appointmentCouponUses.customerUserId })
      .from(schema.appointmentCouponUses)
      .where(
        and(
          eq(schema.appointmentCouponUses.couponId, definition.id),
          inArray(schema.appointmentCouponUses.status, ["reserved", "redeemed"]),
        ),
      );
    if (definition.globalLimit != null && active.length >= definition.globalLimit)
      throw new BookingError("This coupon has no uses remaining", 409);
    if (
      definition.perCustomerLimit != null &&
      active.filter((use) => use.customerUserId === customerUserId).length >=
        definition.perCustomerLimit
    )
      throw new BookingError("You have used this coupon the maximum number of times", 409);
  }
  const [use] = await tx
    .insert(schema.appointmentCouponUses)
    .values({
      couponId: terms.id,
      organizationId: price.organizationId,
      eventTypeId: price.eventTypeId,
      customerUserId,
      operationKey,
      requestFingerprint,
      status: "attemptId" in source ? "reserved" : "redeemed",
      paymentAttemptId: "attemptId" in source ? source.attemptId : null,
      bookingId: "bookingId" in source ? source.bookingId : null,
      expiresAt: "attemptId" in source ? source.expiresAt : null,
    })
    .returning();
  return use!;
}

/** Called only after verified paid fulfillment has saved the coupon snapshot. */
export async function redeemReservedCouponUse(
  tx: Transaction,
  attemptId: string,
  bookingId: string,
  price: AppointmentPrice,
  customerUserId: string,
) {
  const terms = couponTerms(price);
  const [use] = await tx
    .select()
    .from(schema.appointmentCouponUses)
    .where(eq(schema.appointmentCouponUses.paymentAttemptId, attemptId))
    .for("update");
  if (
    !use ||
    use.status !== "reserved" ||
    use.bookingId ||
    use.couponId !== terms.id ||
    use.customerUserId !== customerUserId ||
    use.organizationId !== price.organizationId ||
    use.eventTypeId !== price.eventTypeId
  )
    throw new BookingError("Coupon reservation requires payment review", 409);
  await tx
    .update(schema.appointmentCouponUses)
    .set({ status: "redeemed", bookingId })
    .where(eq(schema.appointmentCouponUses.id, use.id));
}

/** Called inside the existing booking cancellation transaction. */
export async function restoreBookingCoupon(
  tx: Transaction,
  booking: typeof schema.bookings.$inferSelect,
) {
  const [use] = await tx
    .select()
    .from(schema.appointmentCouponUses)
    .where(eq(schema.appointmentCouponUses.bookingId, booking.id))
    .for("update");
  if (!use) {
    const snapshot = await tx.query.bookingPricingSnapshots.findFirst({
      where: eq(schema.bookingPricingSnapshots.bookingId, booking.id),
    });
    if (snapshot?.couponId) throw new BookingError("Coupon redemption requires review", 409);
    return null;
  }
  if (use.status === "restored") return use;
  if (use.status !== "redeemed") throw new BookingError("Coupon redemption requires review", 409);
  await tx.insert(schema.appointmentCouponRestorations).values({
    useId: use.id,
    bookingId: booking.id,
  });
  await tx
    .update(schema.appointmentCouponUses)
    .set({ status: "restored" })
    .where(eq(schema.appointmentCouponUses.id, use.id));
  return use;
}

/** Terminal payment state is proved by the saved attempt, never by a local timer alone. */
export async function releaseTerminalCouponReservation(attemptId: string, db: Writer = getDb()) {
  return db.transaction(async (tx) => {
    const [attempt] = await tx
      .select()
      .from(schema.paymentAttempts)
      .where(eq(schema.paymentAttempts.id, attemptId))
      .for("update");
    if (
      !attempt ||
      !["expired", "payment_failed"].includes(attempt.state) ||
      attempt.successFacts ||
      attempt.bookingId
    )
      return false;
    const [use] = await tx
      .select()
      .from(schema.appointmentCouponUses)
      .where(eq(schema.appointmentCouponUses.paymentAttemptId, attemptId))
      .for("update");
    if (!use || use.status !== "reserved") return false;
    await tx
      .update(schema.appointmentCouponUses)
      .set({ status: "released" })
      .where(eq(schema.appointmentCouponUses.id, use.id));
    return true;
  });
}

/** Preview is advisory; booking/checkout repeats the check under a coupon row lock. */
export async function couponCapacityMessage(
  price: AppointmentPrice,
  customerUserId: string,
  db: Pick<Database, "query" | "select"> = getDb(),
) {
  const coupon = price.coupon;
  if (!coupon) return null;
  const definition = await db.query.appointmentCoupons.findFirst({
    where: eq(schema.appointmentCoupons.id, coupon.id),
  });
  if (!definition) return "Coupon code not recognized";
  if (definition.globalLimit == null && definition.perCustomerLimit == null) return null;
  const active = await db
    .select({ customerUserId: schema.appointmentCouponUses.customerUserId })
    .from(schema.appointmentCouponUses)
    .where(
      and(
        eq(schema.appointmentCouponUses.couponId, coupon.id),
        inArray(schema.appointmentCouponUses.status, ["reserved", "redeemed"]),
      ),
    );
  if (definition.globalLimit != null && active.length >= definition.globalLimit)
    return "This coupon has no uses remaining";
  if (
    definition.perCustomerLimit != null &&
    active.filter((use) => use.customerUserId === customerUserId).length >=
      definition.perCustomerLimit
  )
    return "You have used this coupon the maximum number of times";
  return null;
}
