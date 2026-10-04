import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared";
import { bookings } from "./booking";
import { organizations, users } from "./orgs";
import { eventTypes } from "./scheduling";

export interface AcceptedSchedulingPlan {
  version: 1;
  authority: "current_configuration";
  organizationId: string;
  eventTypeId: string;
  configurationRevision: string;
  admissionEpoch: string;
  resources: { id: string; quantity: number; name: string }[];
  requiresHost: boolean;
  requiredHostIds: string[];
  scheduleId: string;
  scheduleOwnerId: string;
  scheduleTimezone: string;
  businessTimezone: string;
  capTimezone: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minimumGapMinutes: number;
}

export const resources = pgTable(
  "resources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    capacity: integer("capacity").notNull().default(1),
    enabled: boolean("enabled").notNull().default(true),
    allocationVersion: bigint("allocation_version", { mode: "number" }).notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("resources_id_org_idx").on(t.id, t.organizationId),
    check(
      "resources_shape_check",
      sql`length(btrim(${t.name})) > 0 AND ${t.capacity} > 0 AND ${t.allocationVersion} >= 0`,
    ),
  ],
);

export const eventTypeResourceRequirements = pgTable(
  "event_type_resource_requirements",
  {
    organizationId: uuid("organization_id").notNull(),
    eventTypeId: uuid("event_type_id").notNull(),
    resourceId: uuid("resource_id").notNull(),
    quantity: integer("quantity").notNull().default(1),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("resource_requirement_event_resource_idx").on(t.eventTypeId, t.resourceId),
    foreignKey({
      name: "resource_requirement_service_scope_fk",
      columns: [t.eventTypeId, t.organizationId],
      foreignColumns: [eventTypes.id, eventTypes.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "resource_requirement_resource_scope_fk",
      columns: [t.resourceId, t.organizationId],
      foreignColumns: [resources.id, resources.organizationId],
    }).onDelete("restrict"),
    check("resource_requirement_quantity_check", sql`${t.quantity} > 0`),
  ],
);

export const bookingResourceClaims = pgTable(
  "booking_resource_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    eventTypeId: uuid("event_type_id").notNull(),
    bookingId: uuid("booking_id").notNull(),
    resourceId: uuid("resource_id").notNull(),
    configurationRevision: bigint("configuration_revision", { mode: "number" }).notNull(),
    allocationRevision: bigint("allocation_revision", { mode: "number" }).notNull(),
    quantity: integer("quantity").notNull(),
    resourceName: text("resource_name").notNull(),
    capacityAtAllocation: integer("capacity_at_allocation").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    allocatedAt: timestamp("allocated_at", { withTimezone: true }).notNull().defaultNow(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "restrict" }),
    source: text("source").notNull(),
    predecessorId: uuid("predecessor_id"),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releaseReason: text("release_reason").$type<"cancelled" | "rejected" | "rescheduled">(),
  },
  (t) => [
    uniqueIndex("resource_claim_revision_idx").on(t.bookingId, t.resourceId, t.allocationRevision),
    uniqueIndex("resource_claim_active_idx")
      .on(t.bookingId, t.resourceId)
      .where(sql`${t.releasedAt} IS NULL`),
    index("resource_claim_range_idx")
      .using("gist", t.resourceId, sql`tstzrange(${t.startsAt}, ${t.endsAt}, '[)')`)
      .where(sql`${t.releasedAt} IS NULL`),
    foreignKey({
      name: "resource_claim_booking_scope_fk",
      columns: [t.bookingId, t.organizationId, t.eventTypeId],
      foreignColumns: [bookings.id, bookings.organizationId, bookings.eventTypeId],
    }).onDelete("restrict"),
    foreignKey({
      name: "resource_claim_resource_scope_fk",
      columns: [t.resourceId, t.organizationId],
      foreignColumns: [resources.id, resources.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "resource_claim_predecessor_fk",
      columns: [t.predecessorId],
      foreignColumns: [t.id],
    }).onDelete("restrict"),
    check(
      "resource_claim_shape_check",
      sql`${t.quantity} > 0 AND ${t.capacityAtAllocation} >= ${t.quantity} AND ${t.configurationRevision} > 0 AND ${t.allocationRevision} > 0 AND isfinite(${t.startsAt}) AND isfinite(${t.endsAt}) AND ${t.endsAt} > ${t.startsAt} AND isfinite(${t.allocatedAt}) AND length(${t.source}) > 0 AND ((${t.releasedAt} IS NULL AND ${t.releaseReason} IS NULL) OR (${t.releasedAt} IS NOT NULL AND isfinite(${t.releasedAt}) AND ${t.releaseReason} IN ('cancelled','rejected','rescheduled')))`,
    ),
  ],
);
