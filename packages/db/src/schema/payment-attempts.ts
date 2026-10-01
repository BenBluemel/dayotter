import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { bookings } from "./booking";
import { organizations } from "./orgs";
import { eventTypes } from "./scheduling";

/** Appointment-only immutable terms; mutable identifiers/status are guarded by migration triggers. */
export const paymentAttempts = pgTable(
  "payment_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestKey: text("request_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    purpose: text("purpose").$type<"appointment">().notNull().default("appointment"),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    eventTypeId: uuid("event_type_id").notNull(),
    /** AES-GCM encrypted booking input, including access code/intake answers. */
    bookingIntent: text("booking_intent").notNull(),
    quote: jsonb("quote").$type<unknown>().notNull(),
    quoteHash: text("quote_hash").notNull(),
    amount: integer("amount").notNull(),
    currency: text("currency").notNull(),
    settlement: text("settlement").$type<"cash">().notNull().default("cash"),
    expectedPaymentStatus: text("expected_payment_status")
      .$type<"paid">()
      .notNull()
      .default("paid"),
    paymentMode: text("payment_mode").$type<"direct" | "connect">().notNull(),
    environment: text("environment").$type<"test" | "live">().notNull(),
    chargeAccountId: text("charge_account_id").notNull(),
    credentialContext: text("credential_context").$type<"primary">().notNull(),
    destinationAccountId: text("destination_account_id"),
    applicationFeeAmount: integer("application_fee_amount").notNull().default(0),
    productName: text("product_name").notNull(),
    successUrl: text("success_url").notNull(),
    cancelUrl: text("cancel_url").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    creationDeadline: timestamp("creation_deadline", { withTimezone: true }).notNull(),
    state: text("state")
      .$type<"prepared" | "open" | "expired" | "fulfilled" | "requires_review">()
      .notNull()
      .default("prepared"),
    checkoutSessionId: text("checkout_session_id"),
    checkoutUrl: text("checkout_url"),
    paymentIntentId: text("payment_intent_id"),
    bookingId: uuid("booking_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("payment_attempt_request_key_idx").on(t.requestKey),
    uniqueIndex("payment_attempt_session_idx").on(
      t.environment,
      t.chargeAccountId,
      t.checkoutSessionId,
    ),
    uniqueIndex("payment_attempt_intent_idx").on(
      t.environment,
      t.chargeAccountId,
      t.paymentIntentId,
    ),
    uniqueIndex("payment_attempt_booking_idx").on(t.bookingId),
    index("payment_attempt_state_idx").on(t.state, t.createdAt),
    foreignKey({
      name: "payment_attempt_booking_scope_fk",
      columns: [t.bookingId, t.organizationId, t.eventTypeId],
      foreignColumns: [bookings.id, bookings.organizationId, bookings.eventTypeId],
    }).onDelete("restrict"),
    foreignKey({
      name: "payment_attempt_event_scope_fk",
      columns: [t.eventTypeId, t.organizationId],
      foreignColumns: [eventTypes.id, eventTypes.organizationId],
    }).onDelete("restrict"),
    check(
      "payment_attempt_quote_binding_check",
      sql`jsonb_typeof(${t.quote}) = 'object' AND (
    ${t.quote}->>'version' = '1' AND ${t.quote}->>'settlement' = ${t.settlement}
    AND ${t.quote}->>'organizationId' = ${t.organizationId}::text AND ${t.quote}->>'eventTypeId' = ${t.eventTypeId}::text
    AND ${t.quote}->>'currency' = ${t.currency} AND (${t.quote}->>'amountToCollect')::integer = ${t.amount}
    AND (${t.quote}->>'effectivePrice')::integer >= ${t.amount} AND (${t.quote}->>'basePrice')::integer >= (${t.quote}->>'effectivePrice')::integer
    AND isfinite((${t.quote}->>'appointmentStartsAt')::timestamptz)
  ) IS TRUE`,
    ),
    check(
      "payment_attempt_terms_check",
      sql`${t.purpose} = 'appointment' AND ${t.settlement} = 'cash' AND ${t.expectedPaymentStatus} = 'paid'
    AND ${t.amount} > 0 AND ${t.currency} ~ '^[a-z]{3}$' AND ${t.environment} IN ('test', 'live')
    AND ${t.credentialContext} = 'primary' AND ${t.chargeAccountId} ~ '^acct_[A-Za-z0-9]+$'
    AND ${t.requestFingerprint} ~ '^[a-f0-9]{64}$' AND ${t.quoteHash} ~ '^[a-f0-9]{64}$'
    AND ${t.applicationFeeAmount} BETWEEN 0 AND ${t.amount}
    AND ((${t.paymentMode} = 'direct' AND ${t.destinationAccountId} IS NULL AND ${t.applicationFeeAmount} = 0)
      OR (${t.paymentMode} = 'connect' AND ${t.destinationAccountId} IS NOT NULL AND ${t.destinationAccountId} ~ '^acct_[A-Za-z0-9]+$' AND ${t.destinationAccountId} <> ${t.chargeAccountId}))
    AND isfinite(${t.expiresAt}) AND isfinite(${t.creationDeadline}) AND ${t.creationDeadline} > ${t.createdAt} AND ${t.expiresAt} > ${t.creationDeadline}
    AND ${t.state} IN ('prepared', 'open', 'expired', 'fulfilled', 'requires_review')
    AND (${t.state} <> 'open' OR ${t.checkoutSessionId} IS NOT NULL)
    AND (${t.state} <> 'fulfilled' OR (${t.bookingId} IS NOT NULL AND ${t.paymentIntentId} IS NOT NULL AND ${t.checkoutSessionId} IS NOT NULL))`,
    ),
  ],
);
