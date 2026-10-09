import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { bookings } from "./booking";
import { organizations } from "./orgs";
import { paymentAttempts } from "./payment-attempts";

/** One full cancellation refund per captured appointment payment. No partial-refund API. */
export const refundOperations = pgTable(
  "refund_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    bookingId: uuid("booking_id").references(() => bookings.id, { onDelete: "restrict" }),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => paymentAttempts.id, { onDelete: "restrict" }),
    purpose: text("purpose")
      .$type<"cancellation" | "unbooked_obligation">()
      .notNull()
      .default("cancellation"),
    paymentIntentId: text("payment_intent_id").notNull(),
    chargeId: text("charge_id").notNull(),
    amount: integer("amount").notNull(),
    currency: text("currency").notNull(),
    paymentMode: text("payment_mode").$type<"direct" | "connect">().notNull(),
    environment: text("environment").$type<"test" | "live">().notNull(),
    chargeAccountId: text("charge_account_id").notNull(),
    credentialContext: text("credential_context").$type<"primary">().notNull(),
    destinationAccountId: text("destination_account_id"),
    applicationFeeAmount: integer("application_fee_amount").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    state: text("state")
      .$type<"owed" | "submitting" | "pending" | "retryable" | "succeeded" | "requires_review">()
      .notNull()
      .default("owed"),
    stripeRefundId: text("stripe_refund_id"),
    stripeStatus: text("stripe_status"),
    firstSubmittedAt: timestamp("first_submitted_at", { withTimezone: true }),
    succeededAt: timestamp("succeeded_at", { withTimezone: true }),
    failures: integer("failures").notNull().default(0),
    nextRecoveryAt: timestamp("next_recovery_at", { withTimezone: true }).notNull().defaultNow(),
    reviewCode: text("review_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("refund_operation_attempt_idx").on(t.attemptId),
    uniqueIndex("refund_operation_booking_idx").on(t.bookingId),
    uniqueIndex("refund_operation_charge_idx").on(t.environment, t.chargeAccountId, t.chargeId),
    uniqueIndex("refund_operation_key_idx").on(t.idempotencyKey),
    uniqueIndex("refund_operation_stripe_idx").on(
      t.environment,
      t.chargeAccountId,
      t.stripeRefundId,
    ),
    index("refund_operation_recovery_idx").on(t.state, t.nextRecoveryAt),
    check(
      "refund_operation_terms_check",
      sql`((${t.purpose} = 'cancellation' AND ${t.bookingId} IS NOT NULL) OR (${t.purpose} = 'unbooked_obligation' AND ${t.bookingId} IS NULL)) AND ${t.amount} > 0 AND ${t.currency} ~ '^[a-z]{3}$'
    AND ${t.paymentIntentId} ~ '^pi_[A-Za-z0-9]+$' AND ${t.chargeId} ~ '^ch_[A-Za-z0-9]+$'
    AND ${t.environment} IN ('test', 'live') AND ${t.chargeAccountId} ~ '^acct_[A-Za-z0-9]+$' AND ${t.credentialContext} = 'primary'
    AND ${t.applicationFeeAmount} BETWEEN 0 AND ${t.amount}
    AND ((${t.paymentMode} = 'direct' AND ${t.destinationAccountId} IS NULL AND ${t.applicationFeeAmount} = 0)
      OR (${t.paymentMode} = 'connect' AND ${t.destinationAccountId} ~ '^acct_[A-Za-z0-9]+$' AND ${t.destinationAccountId} <> ${t.chargeAccountId})) IS TRUE
    AND ${t.idempotencyKey} = 'appointment-refund:' || ${t.id}::text || ':v1'`,
    ),
    check(
      "refund_operation_progress_check",
      sql`${t.state} IN ('owed', 'submitting', 'pending', 'retryable', 'succeeded', 'requires_review')
    AND ${t.failures} >= 0 AND isfinite(${t.nextRecoveryAt})
    AND (${t.firstSubmittedAt} IS NULL OR isfinite(${t.firstSubmittedAt}))
    AND (${t.stripeRefundId} IS NULL OR ${t.stripeRefundId} ~ '^re_[A-Za-z0-9]+$')
    AND (${t.state} NOT IN ('pending', 'succeeded') OR ${t.stripeRefundId} IS NOT NULL)
    AND (${t.state} <> 'submitting' OR ${t.firstSubmittedAt} IS NOT NULL)
    AND (${t.state} <> 'succeeded' OR (${t.stripeStatus} = 'succeeded' AND ${t.succeededAt} IS NOT NULL)) IS TRUE
    AND (${t.state} <> 'requires_review' OR ${t.reviewCode} IS NOT NULL)`,
    ),
  ],
);
