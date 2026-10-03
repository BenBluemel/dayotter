import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
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
import { organizations, users } from "./orgs";
import { packageCredits, sessionPackages } from "./packages";
import type { PaymentSuccessFacts } from "./payment-attempts";
import { eventTypes } from "./scheduling";

export interface PackagePurchaseTerms {
  version: 1;
  organizationId: string;
  eventTypeId: string;
  packageId: string;
  ownerUserId: string;
  clientEmail: string;
  totalCredits: number;
  amount: number;
  currency: string;
  productName: string;
  successUrl: string;
  cancelUrl: string;
  route: {
    mode: "direct" | "connect";
    organizationId: string;
    environment: "test" | "live";
    chargeAccountId: string;
    credentialContext: "primary";
    destinationAccountId?: string;
    applicationFeeAmount?: number;
  };
}
export const packagePurchases = pgTable(
  "package_purchases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestKey: text("request_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    packageId: uuid("package_id")
      .notNull()
      .references(() => sessionPackages.id, { onDelete: "restrict" }),
    eventTypeId: uuid("event_type_id")
      .notNull()
      .references(() => eventTypes.id, { onDelete: "restrict" }),
    terms: jsonb("terms").$type<PackagePurchaseTerms>().notNull(),
    termsHash: text("terms_hash").notNull(),
    environment: text("environment").$type<"test" | "live">().notNull(),
    chargeAccountId: text("charge_account_id").notNull(),
    state: text("state")
      .$type<
        "prepared" | "open" | "expired" | "payment_succeeded" | "granted" | "requires_review"
      >()
      .notNull()
      .default("prepared"),
    checkoutSessionId: text("checkout_session_id"),
    checkoutUrl: text("checkout_url"),
    paymentIntentId: text("payment_intent_id"),
    successFacts: jsonb("success_facts").$type<PaymentSuccessFacts>(),
    creditId: uuid("credit_id").references(() => packageCredits.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    creationDeadline: timestamp("creation_deadline", { withTimezone: true }).notNull(),
    nextRecoveryAt: timestamp("next_recovery_at", { withTimezone: true }).notNull().defaultNow(),
    failures: integer("failures").notNull().default(0),
    reviewCode: text("review_code"),
  },
  (t) => [
    uniqueIndex("package_purchase_request_idx").on(t.requestKey),
    uniqueIndex("package_purchase_session_idx").on(
      t.environment,
      t.chargeAccountId,
      t.checkoutSessionId,
    ),
    uniqueIndex("package_purchase_pi_idx").on(t.environment, t.chargeAccountId, t.paymentIntentId),
    uniqueIndex("package_purchase_credit_idx").on(t.creditId),
    index("package_purchase_recovery_idx").on(t.state, t.nextRecoveryAt),
    check(
      "package_purchase_state_check",
      sql`${t.state} IN ('prepared','open','expired','payment_succeeded','granted','requires_review') AND ${t.failures} >= 0 AND (${t.state} <> 'requires_review' OR ${t.reviewCode} IS NOT NULL) AND (${t.state} NOT IN ('payment_succeeded','granted') OR ${t.successFacts} IS NOT NULL) AND (${t.state} <> 'granted' OR ${t.creditId} IS NOT NULL)`,
    ),
  ],
);
/** Append-only session quantities. Legacy opening balances are snapshots, not inferred grants. */
export const packageCreditMutations = pgTable(
  "package_credit_mutations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    creditId: uuid("credit_id")
      .notNull()
      .references(() => packageCredits.id, { onDelete: "restrict" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    eventTypeId: uuid("event_type_id")
      .notNull()
      .references(() => eventTypes.id, { onDelete: "restrict" }),
    kind: text("kind").$type<"grant" | "redemption" | "restoration">().notNull(),
    quantity: integer("quantity").notNull(),
    operationKey: text("operation_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    bookingId: uuid("booking_id").references(() => bookings.id, { onDelete: "restrict" }),
    purchaseId: uuid("purchase_id").references(() => packagePurchases.id, { onDelete: "restrict" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "restrict" }),
    finalizationState: text("finalization_state").$type<
      "pending" | "running" | "complete" | "requires_review"
    >(),
    finalizationStartedAt: timestamp("finalization_started_at", { withTimezone: true }),
    finalizationReviewCode: text("finalization_review_code"),
    reversesId: uuid("reverses_id").references((): AnyPgColumn => packageCreditMutations.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("package_mutation_operation_idx").on(t.operationKey),
    uniqueIndex("package_mutation_restores_idx").on(t.reversesId),
    uniqueIndex("package_mutation_purchase_idx").on(t.purchaseId),
    uniqueIndex("package_mutation_booking_kind_idx").on(t.bookingId, t.kind),
    index("package_mutation_credit_idx").on(t.creditId),
    check(
      "package_mutation_shape_check",
      sql`${t.quantity} > 0 AND ((${t.kind} = 'grant' AND ${t.bookingId} IS NULL AND ${t.reversesId} IS NULL AND ((${t.purchaseId} IS NULL) <> (${t.actorUserId} IS NULL))) OR (${t.kind} = 'redemption' AND ${t.quantity} = 1 AND ${t.bookingId} IS NOT NULL AND ${t.reversesId} IS NULL AND ${t.purchaseId} IS NULL AND ${t.actorUserId} IS NULL) OR (${t.kind} = 'restoration' AND ${t.bookingId} IS NOT NULL AND ${t.reversesId} IS NOT NULL AND ${t.purchaseId} IS NULL AND ${t.actorUserId} IS NULL))`,
    ),
  ],
);

/** One appointment operation may choose cash or credit, never both under concurrent retries. */
export const bookingSettlementClaims = pgTable(
  "booking_settlement_claims",
  {
    operationKey: text("operation_key").primaryKey(),
    settlement: text("settlement").$type<"cash" | "package_credit">().notNull(),
    sourceId: uuid("source_id").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
  },
  (t) => [
    check(
      "booking_settlement_claim_shape",
      sql`${t.settlement} IN ('cash','package_credit') AND ${t.requestFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    uniqueIndex("booking_settlement_claim_source_idx").on(t.settlement, t.sourceId),
  ],
);
