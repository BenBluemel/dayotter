import { relations, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { bookings } from "./booking";

/**
 * Append-only copies of server quotes, never a join to today's mutable prices.
 * Legacy bookings have no rows. Updates/direct deletes are rejected by the
 * migration's trigger; deleting the parent booking may cascade its history.
 */
export const bookingPricingSnapshots = pgTable(
  "booking_pricing_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    eventTypeId: uuid("event_type_id").notNull(),
    version: integer("version").notNull().default(1),
    appointmentStartsAt: timestamp("appointment_starts_at", { withTimezone: true }).notNull(),
    settlement: text("settlement").$type<"cash" | "package_credit">().notNull(),
    basePrice: integer("base_price").notNull(),
    effectivePrice: integer("effective_price").notNull(),
    currency: text("currency").notNull(),
    /** Quoted collection amount after deposit capping; NOT evidence of a payment. */
    amountToCollect: integer("amount_to_collect").notNull(),
    // Deliberately no FK to promotions: edits/deletion must not change historical attribution.
    discountSource: text("discount_source").$type<"promotion" | "coupon">(),
    promotionId: uuid("promotion_id"),
    promotionLabel: text("promotion_label"),
    promotionStartsAt: timestamp("promotion_starts_at", { withTimezone: true }),
    promotionEndsAt: timestamp("promotion_ends_at", { withTimezone: true }),
    promotionDiscountKind: text("promotion_discount_kind").$type<"percentage" | "fixed">(),
    promotionDiscountValue: integer("promotion_discount_value"),
    promotionCurrency: text("promotion_currency"),
    couponId: uuid("coupon_id"),
    couponCode: text("coupon_code"),
    couponLabel: text("coupon_label"),
    couponStartsAt: timestamp("coupon_starts_at", { withTimezone: true }),
    couponEndsAt: timestamp("coupon_ends_at", { withTimezone: true }),
    couponDiscountKind: text("coupon_discount_kind").$type<"percentage" | "fixed">(),
    couponDiscountValue: integer("coupon_discount_value"),
    couponCurrency: text("coupon_currency"),
    couponMinimumBasePrice: integer("coupon_minimum_base_price"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "booking_pricing_booking_scope_fk",
      columns: [t.bookingId, t.organizationId, t.eventTypeId],
      foreignColumns: [bookings.id, bookings.organizationId, bookings.eventTypeId],
    }).onDelete("cascade"),
    index("booking_pricing_booking_idx").on(t.bookingId, t.createdAt),
    check(
      "booking_pricing_values_check",
      sql`
    ${t.version} IN (1,2) AND isfinite(${t.appointmentStartsAt})
    AND ${t.basePrice} >= 0 AND ${t.effectivePrice} BETWEEN 0 AND ${t.basePrice}
    AND ${t.amountToCollect} BETWEEN 0 AND ${t.effectivePrice}
    AND ${t.currency} ~ '^[a-z]{3}$'
    AND ${t.settlement} IN ('cash', 'package_credit')
    AND (${t.settlement} <> 'package_credit' OR (${t.promotionId} IS NULL AND ${t.couponId} IS NULL AND ${t.effectivePrice} = ${t.basePrice} AND ${t.amountToCollect} = 0))
  `,
    ),
    check(
      "booking_pricing_promotion_check",
      sql`(
    (${t.promotionId} IS NULL AND ${t.promotionLabel} IS NULL AND ${t.promotionStartsAt} IS NULL
      AND ${t.promotionEndsAt} IS NULL AND ${t.promotionDiscountKind} IS NULL
      AND ${t.promotionDiscountValue} IS NULL AND ${t.promotionCurrency} IS NULL
      AND (${t.couponId} IS NOT NULL OR ${t.effectivePrice} = ${t.basePrice}))
    OR (${t.promotionId} IS NOT NULL AND ${t.promotionLabel} IS NOT NULL AND length(btrim(${t.promotionLabel})) > 0
      AND ${t.promotionStartsAt} IS NOT NULL AND ${t.promotionEndsAt} IS NOT NULL
      AND isfinite(${t.promotionStartsAt}) AND isfinite(${t.promotionEndsAt})
      AND ${t.promotionEndsAt} > ${t.promotionStartsAt}
      AND ${t.appointmentStartsAt} >= ${t.promotionStartsAt} AND ${t.appointmentStartsAt} < ${t.promotionEndsAt}
      AND ${t.promotionDiscountKind} IS NOT NULL AND ${t.promotionDiscountValue} IS NOT NULL
      AND ${t.effectivePrice} < ${t.basePrice}
      AND (
        (${t.promotionDiscountKind} = 'percentage' AND ${t.promotionDiscountValue} BETWEEN 1 AND 10000 AND ${t.promotionCurrency} IS NULL
          AND ${t.effectivePrice} = ${t.basePrice} - floor((${t.basePrice}::numeric * ${t.promotionDiscountValue} + 5000) / 10000))
        OR (${t.promotionDiscountKind} = 'fixed' AND ${t.promotionDiscountValue} > 0 AND ${t.promotionCurrency} IS NOT NULL AND ${t.promotionCurrency} = ${t.currency}
          AND ${t.effectivePrice} = greatest(0, ${t.basePrice} - ${t.promotionDiscountValue}))
      ))
  )`,
    ),
    check(
      "booking_pricing_coupon_check",
      sql`(
        (${t.couponId} IS NULL AND ${t.couponCode} IS NULL AND ${t.couponLabel} IS NULL
          AND ${t.couponStartsAt} IS NULL AND ${t.couponEndsAt} IS NULL
          AND ${t.couponDiscountKind} IS NULL AND ${t.couponDiscountValue} IS NULL
          AND ${t.couponCurrency} IS NULL AND ${t.couponMinimumBasePrice} IS NULL
          AND (${t.promotionId} IS NOT NULL OR ${t.discountSource} IS NULL))
        OR (${t.couponId} IS NOT NULL AND ${t.version} = 2 AND ${t.settlement} = 'cash'
          AND ${t.discountSource} IS NOT NULL AND ${t.discountSource} = 'coupon' AND ${t.promotionId} IS NULL
          AND ${t.couponCode} IS NOT NULL AND ${t.couponCode} ~ '^[A-Z0-9][A-Z0-9_-]{0,63}$'
          AND (${t.couponLabel} IS NULL OR length(btrim(${t.couponLabel})) > 0)
          AND ${t.couponStartsAt} IS NOT NULL AND ${t.couponEndsAt} IS NOT NULL
          AND isfinite(${t.couponStartsAt}) AND isfinite(${t.couponEndsAt})
          AND ${t.couponEndsAt} > ${t.couponStartsAt}
          AND ${t.appointmentStartsAt} >= ${t.couponStartsAt}
          AND ${t.appointmentStartsAt} < ${t.couponEndsAt}
          AND (${t.couponMinimumBasePrice} IS NULL OR (${t.couponMinimumBasePrice} >= 0 AND ${t.basePrice} >= ${t.couponMinimumBasePrice}))
          AND ${t.couponDiscountKind} IS NOT NULL AND ${t.couponDiscountValue} IS NOT NULL
          AND ${t.effectivePrice} < ${t.basePrice}
          AND (( ${t.couponDiscountKind} = 'percentage' AND ${t.couponDiscountValue} BETWEEN 1 AND 10000
              AND ${t.couponCurrency} IS NULL
              AND ${t.effectivePrice} = ${t.basePrice} - floor((${t.basePrice}::numeric * ${t.couponDiscountValue} + 5000) / 10000))
            OR (${t.couponDiscountKind} = 'fixed' AND ${t.couponDiscountValue} > 0
              AND ${t.couponCurrency} IS NOT NULL AND ${t.couponCurrency} = ${t.currency}
              AND ${t.effectivePrice} = greatest(0, ${t.basePrice} - ${t.couponDiscountValue}))))
      ) AND (${t.promotionId} IS NULL OR ${t.discountSource} IS NULL OR ${t.discountSource} = 'promotion')
        AND (${t.discountSource} IS NULL OR ${t.discountSource} IN ('promotion','coupon'))`,
    ),
  ],
);

export const bookingPricingSnapshotsRelations = relations(bookingPricingSnapshots, ({ one }) => ({
  booking: one(bookings, {
    fields: [bookingPricingSnapshots.bookingId],
    references: [bookings.id],
  }),
}));
