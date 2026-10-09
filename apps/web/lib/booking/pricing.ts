import {
  type AppointmentPrice,
  calculateAppointmentPrice,
  normalizeCouponCode,
} from "@dayotter/core";
import { type Database, and, eq, getDb, gt, lte, schema, sql } from "@dayotter/db";
import { BookingError } from "./booking-logic";

type PricingReader = Pick<Database, "select" | "query">;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface AppointmentQuoteRequest {
  organizationId: string;
  eventTypeId: string;
  appointmentStartsAt: Date;
  /** Server-selected; this function neither authorizes nor redeems a credit. */
  settlement: "cash" | "package_credit";
  /** Internal authenticated customer identity, never supplied as an HTTP body field. */
  couponCustomerUserId?: string;
  couponCode?: string;
}

/**
 * Shared server quote boundary for public/API/staff callers. Only booking intent
 * enters; all service amounts and promotion rules are read here. Callers must
 * authorize organization access before invoking this internal service.
 * Appointment cash checkout saves this quote before requesting Stripe.
 */
export async function quoteAppointmentPrice(
  input: AppointmentQuoteRequest,
  db: PricingReader = getDb(),
): Promise<AppointmentPrice> {
  if (!Number.isFinite(input.appointmentStartsAt.getTime())) {
    throw new BookingError("Invalid appointment time", 400);
  }
  if (input.couponCode && (!input.couponCustomerUserId || input.settlement !== "cash"))
    throw new BookingError("Sign in to use a coupon", 401);
  const normalizedCode = input.couponCode ? normalizeCouponCode(input.couponCode) : null;
  // All candidates and applicability share one statement snapshot, including a
  // losing coupon (which never reaches reservation's locked terms check). Capacity
  // is still checked separately under the coupon row lock at READ COMMITTED.
  const candidates = db
    .select({
      eventType: schema.eventTypes,
      promotion: schema.appointmentPromotions,
      coupon: normalizedCode ? schema.appointmentCoupons : sql<null>`null`,
      couponEventTypeId: normalizedCode
        ? schema.appointmentCouponEventTypes.eventTypeId
        : sql<null>`null`,
    })
    // Retain a result even without an active service so unknown coupon and missing
    // service errors keep their existing precedence, without a separate read.
    .from(sql`(select 1) as pricing_request`)
    .leftJoin(
      schema.eventTypes,
      and(
        eq(schema.eventTypes.id, input.eventTypeId),
        eq(schema.eventTypes.organizationId, input.organizationId),
        eq(schema.eventTypes.isActive, true),
      ),
    )
    .leftJoin(
      schema.appointmentPromotionEventTypes,
      and(
        eq(schema.appointmentPromotionEventTypes.eventTypeId, schema.eventTypes.id),
        eq(schema.appointmentPromotionEventTypes.organizationId, schema.eventTypes.organizationId),
        input.settlement === "package_credit" ? sql`false` : undefined,
      ),
    )
    .leftJoin(
      schema.appointmentPromotions,
      and(
        eq(schema.appointmentPromotions.id, schema.appointmentPromotionEventTypes.promotionId),
        eq(
          schema.appointmentPromotions.organizationId,
          schema.appointmentPromotionEventTypes.organizationId,
        ),
        eq(schema.appointmentPromotions.isActive, true),
        lte(schema.appointmentPromotions.startsAt, input.appointmentStartsAt),
        gt(schema.appointmentPromotions.endsAt, input.appointmentStartsAt),
      ),
    );
  // Keep no-code quotes independent of coupon tables; only submitted codes add joins.
  const rows = normalizedCode
    ? await candidates
        .leftJoin(
          schema.appointmentCoupons,
          and(
            eq(schema.appointmentCoupons.organizationId, input.organizationId),
            eq(schema.appointmentCoupons.code, normalizedCode),
          ),
        )
        .leftJoin(
          schema.appointmentCouponEventTypes,
          and(
            eq(schema.appointmentCouponEventTypes.couponId, schema.appointmentCoupons.id),
            eq(schema.appointmentCouponEventTypes.eventTypeId, schema.eventTypes.id),
            eq(schema.appointmentCouponEventTypes.organizationId, input.organizationId),
          ),
        )
    : await candidates;
  const coupon = rows[0]?.coupon;
  if (normalizedCode && !coupon) throw new BookingError("Coupon code not recognized", 400);
  const eventType = rows[0]?.eventType;
  if (!eventType) throw new BookingError("Event type not found", 404);
  const rules = rows.flatMap(({ promotion }) => (promotion ? [promotion] : []));

  let eligibleCoupon = null;
  if (coupon) {
    if (!coupon.isActive) throw new BookingError("This coupon is inactive", 400);
    if (input.appointmentStartsAt < coupon.startsAt || input.appointmentStartsAt >= coupon.endsAt)
      throw new BookingError("This appointment is outside the coupon dates", 400);
    if (!rows[0]?.couponEventTypeId)
      throw new BookingError("This coupon does not apply to this service", 400);
    if ((eventType.price ?? 0) < (coupon.minimumBasePrice ?? 0))
      throw new BookingError("The regular service price is below this coupon's minimum", 400);
    if (coupon.discountKind === "fixed" && coupon.currency !== (eventType.currency ?? "usd"))
      throw new BookingError("This coupon uses a different currency", 400);
    eligibleCoupon = {
      id: coupon.id,
      organizationId: coupon.organizationId,
      code: coupon.code,
      label: coupon.label,
      isActive: coupon.isActive,
      startsAt: coupon.startsAt,
      endsAt: coupon.endsAt,
      eventTypeIds: [eventType.id],
      minimumBasePrice: coupon.minimumBasePrice,
      discount:
        coupon.discountKind === "percentage"
          ? { kind: "percentage" as const, basisPoints: coupon.discountValue }
          : { kind: "fixed" as const, amount: coupon.discountValue, currency: coupon.currency! },
    };
  }

  const quote = calculateAppointmentPrice({
    eventType,
    appointmentStartsAt: input.appointmentStartsAt,
    settlement: input.settlement,
    promotions: rules.map((p) => ({
      ...p,
      eventTypeIds: [eventType.id],
      discount:
        p.discountKind === "percentage"
          ? { kind: "percentage", basisPoints: p.discountValue }
          : { kind: "fixed", amount: p.discountValue, currency: p.currency! },
    })),
    coupon: eligibleCoupon,
  });
  if (coupon && !quote.coupon && !quote.promotion)
    throw new BookingError("This coupon does not reduce the service price", 400);
  return quote;
}

/**
 * Persist a SERVER-OWNED initial quote inside the booking transaction. Never
 * expose `price` as an HTTP input. Checkout integration must recover the exact
 * stored quote used for that checkout, not recalculate from mutable promotions.
 * Ordinary rescheduling preserves this historical quote; financial adjustments require a separate explicit design.
 */
export async function persistBookingPricingSnapshot(
  bookingId: string,
  price: AppointmentPrice,
  tx: Transaction,
) {
  const [booking] = await tx
    .select()
    .from(schema.bookings)
    .where(
      and(
        eq(schema.bookings.id, bookingId),
        eq(schema.bookings.organizationId, price.organizationId),
        eq(schema.bookings.eventTypeId, price.eventTypeId),
      ),
    )
    .for("update");
  if (!booking) throw new BookingError("Booking not found", 404);
  if (booking.startsAt.toISOString() !== price.appointmentStartsAt) {
    throw new BookingError("The quote does not match the appointment time", 409);
  }
  // Initial checkout/credit integration must save the original quote BEFORE
  // recording settlement, in the same transaction. Never invent a quote for a
  // previously settled legacy booking or silently reprice one after collection.
  if (
    booking.paymentIntentId ||
    booking.destinationAccountId ||
    (booking.amountPaid ?? 0) > 0 ||
    booking.paymentStatus === "paid" ||
    booking.paymentStatus === "refunded"
  ) {
    throw new BookingError("A settled booking requires an explicit pricing adjustment", 409);
  }
  const p = price.promotion;
  const c = price.coupon;
  const [snapshot] = await tx
    .insert(schema.bookingPricingSnapshots)
    .values({
      bookingId,
      organizationId: price.organizationId,
      eventTypeId: price.eventTypeId,
      version: price.version,
      appointmentStartsAt: new Date(price.appointmentStartsAt),
      settlement: price.settlement,
      basePrice: price.basePrice,
      effectivePrice: price.effectivePrice,
      currency: price.currency,
      amountToCollect: price.amountToCollect,
      promotionId: p?.id ?? null,
      promotionLabel: p?.label ?? null,
      promotionStartsAt: p ? new Date(p.startsAt) : null,
      promotionEndsAt: p ? new Date(p.endsAt) : null,
      promotionDiscountKind: p?.discount.kind ?? null,
      promotionDiscountValue: p
        ? p.discount.kind === "percentage"
          ? p.discount.basisPoints
          : p.discount.amount
        : null,
      promotionCurrency: p?.discount.kind === "fixed" ? p.discount.currency : null,
      discountSource: c ? "coupon" : p ? "promotion" : null,
      couponId: c?.id ?? null,
      couponCode: c?.code ?? null,
      couponLabel: c?.label ?? null,
      couponStartsAt: c ? new Date(c.startsAt) : null,
      couponEndsAt: c ? new Date(c.endsAt) : null,
      couponDiscountKind: c?.discount.kind ?? null,
      couponDiscountValue: c
        ? c.discount.kind === "percentage"
          ? c.discount.basisPoints
          : c.discount.amount
        : null,
      couponCurrency: c?.discount.kind === "fixed" ? c.discount.currency : null,
      couponMinimumBasePrice: c?.minimumBasePrice ?? null,
    })
    .returning();
  return snapshot!;
}
