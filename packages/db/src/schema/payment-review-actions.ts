import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations, users } from "./orgs";
import { paymentAttempts } from "./payment-attempts";
/** Authorized customer-consented resolution of one original paid obligation. */
export const paymentReviewActions = pgTable(
  "payment_review_actions",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => paymentAttempts.id, { onDelete: "restrict" }),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    method: text("method").$type<"retry" | "refund">().notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    /** Encrypted reason and customer contact/consent evidence. */
    evidence: text("evidence").notNull(),
    state: text("state")
      .$type<"active" | "failed" | "booked" | "refunded">()
      .notNull()
      .default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("payment_review_action_active_idx")
      .on(t.attemptId)
      .where(sql`${t.state} = 'active'`),
    index("payment_review_action_attempt_idx").on(t.attemptId),
    check(
      "payment_review_action_shape_check",
      sql`${t.method} IN ('retry','refund') AND ${t.state} IN ('active','failed','booked','refunded') AND ${t.requestFingerprint} ~ '^[a-f0-9]{64}$' AND length(${t.evidence}) > 0 AND (${t.state} IN ('active','failed') OR ${t.resolvedAt} IS NOT NULL)`,
    ),
  ],
);
