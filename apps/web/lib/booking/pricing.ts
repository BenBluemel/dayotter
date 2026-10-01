import { type AppointmentPrice, calculateAppointmentPrice } from "@dayotter/core";
import { type Database, and, eq, getDb, gt, lte, schema, sql } from "@dayotter/db";
import { BookingError } from "./booking-logic";

type PricingReader = Pick<Database, "select">;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface AppointmentQuoteRequest {
  organizationId: string;
  eventTypeId: string;
  appointmentStartsAt: Date;
  /** Server-selected; this function neither authorizes nor redeems a credit. */
  settlement: "cash" | "package_credit";
}

/**
 * Shared server quote boundary for public/API/staff callers. Only booking intent
 * enters; all service amounts and promotion rules are read here. Callers must
 * authorize organization access before invoking this internal service.
 * Not yet wired into checkout or existing booking routes.
 */
export async function quoteAppointmentPrice(
  input: AppointmentQuoteRequest,
  db: PricingReader = getDb(),
): Promise<AppointmentPrice> {
  if (!Number.isFinite(input.appointmentStartsAt.getTime())) {
    throw new BookingError("Invalid appointment time", 400);
  }
  // One statement sees one PostgreSQL snapshot, even at READ COMMITTED. Separate
  // reads could combine an old service price with newly committed promotion rules.
  const rows = await db
    .select({ eventType: schema.eventTypes, promotion: schema.appointmentPromotions })
    .from(schema.eventTypes)
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
    )
    .where(
      and(
        eq(schema.eventTypes.id, input.eventTypeId),
        eq(schema.eventTypes.organizationId, input.organizationId),
        eq(schema.eventTypes.isActive, true),
      ),
    );
  const eventType = rows[0]?.eventType;
  if (!eventType) throw new BookingError("Event type not found", 404);
  const rules = rows.flatMap(({ promotion }) => (promotion ? [promotion] : []));

  return calculateAppointmentPrice({
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
  });
}

/**
 * Persist a SERVER-OWNED quote inside the booking/reschedule transaction. Never
 * expose `price` as an HTTP input. Checkout integration must recover the exact
 * stored quote used for that checkout, not recalculate from mutable promotions.
 * Each occurrence/reprice appends its own row; payment facts are never changed.
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
    })
    .returning();
  return snapshot!;
}
