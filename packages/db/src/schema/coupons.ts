import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared";
import { bookings } from "./booking";
import { organizations, users } from "./orgs";
import { paymentAttempts } from "./payment-attempts";
import { eventTypes } from "./scheduling";

/** Organization-owned definitions. The stored code is already canonical. */
export const appointmentCoupons = pgTable(
  "appointment_coupons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    code: text("code").notNull(),
    label: text("label"),
    isActive: boolean("is_active").notNull().default(true),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    /** Zone used to turn inclusive calendar dates into the saved UTC window. */
    validityTimezone: text("validity_timezone").notNull(),
    discountKind: text("discount_kind").$type<"percentage" | "fixed">().notNull(),
    /** Basis points or currency minor units. */
    discountValue: integer("discount_value").notNull(),
    currency: text("currency"),
    minimumBasePrice: integer("minimum_base_price"),
    globalLimit: integer("global_limit"),
    perCustomerLimit: integer("per_customer_limit"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("appointment_coupons_org_code_idx").on(t.organizationId, t.code),
    uniqueIndex("appointment_coupons_id_org_idx").on(t.id, t.organizationId),
    check(
      "appointment_coupons_code_check",
      sql`${t.code} = upper(btrim(${t.code})) AND ${t.code} ~ '^[A-Z0-9][A-Z0-9_-]{0,63}$'`,
    ),
    check(
      "appointment_coupons_terms_check",
      sql`isfinite(${t.startsAt}) AND isfinite(${t.endsAt}) AND ${t.endsAt} > ${t.startsAt}
        AND (${t.label} IS NULL OR length(btrim(${t.label})) > 0)
        AND (${t.minimumBasePrice} IS NULL OR ${t.minimumBasePrice} >= 0)
        AND (${t.globalLimit} IS NULL OR ${t.globalLimit} > 0)
        AND (${t.perCustomerLimit} IS NULL OR ${t.perCustomerLimit} > 0)
        AND ((${t.discountKind} = 'percentage' AND ${t.discountValue} BETWEEN 1 AND 10000 AND ${t.currency} IS NULL)
          OR (${t.discountKind} = 'fixed' AND ${t.discountValue} > 0 AND ${t.currency} IS NOT NULL AND ${t.currency} ~ '^[a-z]{3}$'))`,
    ),
  ],
);

export const appointmentCouponEventTypes = pgTable(
  "appointment_coupon_event_types",
  {
    couponId: uuid("coupon_id").notNull(),
    eventTypeId: uuid("event_type_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.couponId, t.eventTypeId] }),
    index("appointment_coupon_event_types_event_idx").on(t.eventTypeId, t.organizationId),
    foreignKey({
      name: "coupon_services_coupon_org_fk",
      columns: [t.couponId, t.organizationId],
      foreignColumns: [appointmentCoupons.id, appointmentCoupons.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "coupon_services_event_org_fk",
      columns: [t.eventTypeId, t.organizationId],
      foreignColumns: [eventTypes.id, eventTypes.organizationId],
    }).onDelete("restrict"),
  ],
);

/** One operation consumes at most one coupon use; status is its durable lifecycle. */
export const appointmentCouponUses = pgTable(
  "appointment_coupon_uses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    couponId: uuid("coupon_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    eventTypeId: uuid("event_type_id").notNull(),
    customerUserId: uuid("customer_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    operationKey: text("operation_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    status: text("status").$type<"reserved" | "redeemed" | "released" | "restored">().notNull(),
    paymentAttemptId: uuid("payment_attempt_id").references(() => paymentAttempts.id, {
      onDelete: "restrict",
    }),
    bookingId: uuid("booking_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("appointment_coupon_uses_operation_idx").on(t.operationKey),
    uniqueIndex("appointment_coupon_uses_attempt_idx").on(t.paymentAttemptId),
    uniqueIndex("appointment_coupon_uses_booking_idx").on(t.bookingId),
    index("appointment_coupon_uses_capacity_idx").on(t.couponId, t.status, t.customerUserId),
    foreignKey({
      name: "coupon_uses_coupon_org_fk",
      columns: [t.couponId, t.organizationId],
      foreignColumns: [appointmentCoupons.id, appointmentCoupons.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "coupon_uses_booking_scope_fk",
      columns: [t.bookingId, t.organizationId, t.eventTypeId],
      foreignColumns: [bookings.id, bookings.organizationId, bookings.eventTypeId],
    }).onDelete("restrict"),
    check(
      "appointment_coupon_uses_shape_check",
      sql`${t.requestFingerprint} ~ '^[0-9a-f]{64}$' AND length(${t.operationKey}) > 0
        AND ((${t.status} = 'reserved' AND ${t.paymentAttemptId} IS NOT NULL AND ${t.bookingId} IS NULL AND ${t.expiresAt} IS NOT NULL AND isfinite(${t.expiresAt}))
          OR (${t.status} = 'released' AND ${t.paymentAttemptId} IS NOT NULL AND ${t.bookingId} IS NULL AND ${t.expiresAt} IS NOT NULL)
          OR (${t.status} IN ('redeemed','restored') AND ${t.bookingId} IS NOT NULL))`,
    ),
  ],
);

/** Exactly one cancellation reversal may reference a booking's original use. */
export const appointmentCouponRestorations = pgTable(
  "appointment_coupon_restorations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    useId: uuid("use_id")
      .notNull()
      .references(() => appointmentCouponUses.id, { onDelete: "restrict" }),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("appointment_coupon_restorations_use_idx").on(t.useId)],
);

export const appointmentCouponsRelations = relations(appointmentCoupons, ({ many }) => ({
  eventTypes: many(appointmentCouponEventTypes),
  uses: many(appointmentCouponUses),
}));
