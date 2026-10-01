import { sql } from "drizzle-orm";
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
import { organizations } from "./orgs";
import { eventTypes } from "./scheduling";

export const appointmentPromotions = pgTable(
  "appointment_promotions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    discountKind: text("discount_kind").$type<"percentage" | "fixed">().notNull(),
    /** Basis points for percentage rules; minor units for fixed rules. */
    discountValue: integer("discount_value").notNull(),
    currency: text("currency"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("appointment_promotions_id_org_idx").on(t.id, t.organizationId),
    index("appointment_promotions_org_idx").on(t.organizationId),
    check("appointment_promotions_label_check", sql`length(btrim(${t.label})) > 0`),
    check(
      "appointment_promotions_window_check",
      sql`isfinite(${t.startsAt}) AND isfinite(${t.endsAt}) AND ${t.endsAt} > ${t.startsAt}`,
    ),
    check(
      "appointment_promotions_discount_check",
      sql`
    (${t.discountKind} = 'percentage' AND ${t.discountValue} BETWEEN 1 AND 10000 AND ${t.currency} IS NULL)
    OR (${t.discountKind} = 'fixed' AND ${t.discountValue} > 0 AND ${t.currency} IS NOT NULL AND ${t.currency} ~ '^[a-z]{3}$')
  `,
    ),
  ],
);

/** Both composite FKs enforce that a promotion and selected service share an organization. */
export const appointmentPromotionEventTypes = pgTable(
  "appointment_promotion_event_types",
  {
    promotionId: uuid("promotion_id").notNull(),
    eventTypeId: uuid("event_type_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.promotionId, t.eventTypeId] }),
    index("appointment_promotion_event_types_event_idx").on(t.eventTypeId, t.organizationId),
    foreignKey({
      name: "promotion_services_promotion_org_fk",
      columns: [t.promotionId, t.organizationId],
      foreignColumns: [appointmentPromotions.id, appointmentPromotions.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "promotion_services_event_org_fk",
      columns: [t.eventTypeId, t.organizationId],
      foreignColumns: [eventTypes.id, eventTypes.organizationId],
    }).onDelete("cascade"),
  ],
);
