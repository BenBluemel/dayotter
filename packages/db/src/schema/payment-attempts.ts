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
import type { AcceptedSchedulingPlan } from "./resources";
import { eventTypes } from "./scheduling";

export interface PaymentSuccessFacts {
  version: 1;
  sessionId: string;
  paymentIntentId: string;
  chargeId: string;
  amount: number;
  currency: string;
  environment: "test" | "live";
  chargeAccountId: string;
  credentialContext: "primary";
  paymentMode: "direct" | "connect";
  destinationAccountId: string | null;
  applicationFeeAmount: number;
}

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
    schedulingPlan: jsonb("scheduling_plan").$type<AcceptedSchedulingPlan>(),
    schedulingDurationMinutes: integer("scheduling_duration_minutes"),
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
      .$type<
        | "prepared"
        | "open"
        | "expired"
        | "payment_failed"
        | "payment_succeeded"
        | "fulfilling"
        | "fulfilled"
        | "requires_review"
      >()
      .notNull()
      .default("prepared"),
    checkoutSessionId: text("checkout_session_id"),
    checkoutUrl: text("checkout_url"),
    paymentIntentId: text("payment_intent_id"),
    bookingId: uuid("booking_id"),
    paymentSucceededAt: timestamp("payment_succeeded_at", { withTimezone: true }),
    successFacts: jsonb("success_facts").$type<PaymentSuccessFacts>(),
    nextRecoveryAt: timestamp("next_recovery_at", { withTimezone: true }).notNull().defaultNow(),
    recoveryFailures: integer("recovery_failures").notNull().default(0),
    reviewCode: text("review_code"),
    /** Frozen, encrypted confirmed-booking context, committed with the booking. */
    finalizationContext: text("finalization_context"),
    finalizationState: text("finalization_state").$type<
      "pending" | "running" | "attempted" | "requires_review"
    >(),
    finalizationStartedAt: timestamp("finalization_started_at", { withTimezone: true }),
    finalizationReviewCode: text("finalization_review_code"),
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
    ${t.quote}->>'version' IN ('1','2') AND ${t.quote}->>'settlement' = ${t.settlement}
    AND (${t.quote}->>'version' <> '2' OR (jsonb_typeof(${t.quote}->'coupon') = 'object' AND ${t.quote}->>'promotion' IS NULL))
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
    AND ${t.state} IN ('prepared', 'open', 'expired', 'payment_failed', 'payment_succeeded', 'fulfilling', 'fulfilled', 'requires_review')
    AND (${t.state} <> 'open' OR ${t.checkoutSessionId} IS NOT NULL)
    AND (${t.state} <> 'fulfilled' OR (${t.bookingId} IS NOT NULL AND ${t.paymentIntentId} IS NOT NULL AND ${t.checkoutSessionId} IS NOT NULL))`,
    ),
    check(
      "payment_attempt_progress_check",
      sql`${t.recoveryFailures} >= 0 AND isfinite(${t.nextRecoveryAt})
      AND ((${t.finalizationState} IS NULL AND ${t.finalizationContext} IS NULL AND ${t.finalizationStartedAt} IS NULL)
        OR (${t.bookingId} IS NOT NULL AND ${t.finalizationContext} IS NOT NULL AND ${t.finalizationState} IN ('pending', 'running', 'attempted', 'requires_review')
          AND (${t.finalizationState} NOT IN ('running', 'attempted') OR ${t.finalizationStartedAt} IS NOT NULL))) IS TRUE`,
    ),
    check(
      "payment_attempt_success_check",
      sql`
      (${t.successFacts} IS NULL AND ${t.paymentSucceededAt} IS NULL
        AND ${t.state} NOT IN ('payment_succeeded', 'fulfilling')) OR (
      ${t.successFacts} IS NOT NULL AND ${t.paymentSucceededAt} IS NOT NULL AND (
        ${t.successFacts}->>'version' = '1'
        AND ${t.successFacts}->>'sessionId' = ${t.checkoutSessionId}
        AND ${t.successFacts}->>'paymentIntentId' = ${t.paymentIntentId}
        AND ${t.successFacts}->>'chargeId' ~ '^ch_[A-Za-z0-9]+$'
        AND (${t.successFacts}->>'amount')::integer = ${t.amount}
        AND ${t.successFacts}->>'currency' = ${t.currency}
        AND ${t.successFacts}->>'environment' = ${t.environment}
        AND ${t.successFacts}->>'chargeAccountId' = ${t.chargeAccountId}
        AND ${t.successFacts}->>'credentialContext' = ${t.credentialContext}
        AND ${t.successFacts}->>'paymentMode' = ${t.paymentMode}
        AND (${t.successFacts}->>'destinationAccountId') IS NOT DISTINCT FROM ${t.destinationAccountId}
        AND (${t.successFacts}->>'applicationFeeAmount')::integer = ${t.applicationFeeAmount}
      ) IS TRUE)`,
    ),
  ],
);

/** Signed appointment events only; acceptance is independent of Stripe API availability. */
export const paymentEvents = pgTable(
  "payment_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => paymentAttempts.id, { onDelete: "restrict" }),
    stripeEventId: text("stripe_event_id").notNull(),
    environment: text("environment").$type<"test" | "live">().notNull(),
    chargeAccountId: text("charge_account_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: text("payload").notNull(),
    payloadHash: text("payload_hash").notNull(),
    state: text("state")
      .$type<"pending" | "completed" | "requires_review">()
      .notNull()
      .default("pending"),
    failures: integer("failures").notNull().default(0),
    nextRecoveryAt: timestamp("next_recovery_at", { withTimezone: true }).notNull().defaultNow(),
    reviewCode: text("review_code"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("payment_event_identity_idx").on(t.environment, t.chargeAccountId, t.stripeEventId),
    index("payment_event_pending_idx").on(t.state, t.nextRecoveryAt),
    check(
      "payment_event_terms_check",
      sql`${t.environment} IN ('test', 'live') AND ${t.chargeAccountId} ~ '^acct_[A-Za-z0-9]+$'
    AND ${t.stripeEventId} ~ '^evt_[A-Za-z0-9]+$' AND ${t.payloadHash} ~ '^[a-f0-9]{64}$'
    AND ${t.state} IN ('pending', 'completed', 'requires_review') AND ${t.failures} >= 0 AND isfinite(${t.nextRecoveryAt})`,
    ),
  ],
);
