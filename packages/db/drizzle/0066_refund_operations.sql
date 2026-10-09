CREATE TABLE "refund_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"purpose" text DEFAULT 'cancellation' NOT NULL,
	"payment_intent_id" text NOT NULL,
	"charge_id" text NOT NULL,
	"amount" integer NOT NULL,
	"currency" text NOT NULL,
	"payment_mode" text NOT NULL,
	"environment" text NOT NULL,
	"charge_account_id" text NOT NULL,
	"credential_context" text NOT NULL,
	"destination_account_id" text,
	"application_fee_amount" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"state" text DEFAULT 'owed' NOT NULL,
	"stripe_refund_id" text,
	"stripe_status" text,
	"first_submitted_at" timestamp with time zone,
	"succeeded_at" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	"next_recovery_at" timestamp with time zone DEFAULT now() NOT NULL,
	"review_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_operation_terms_check" CHECK ("refund_operations"."purpose" = 'cancellation' AND "refund_operations"."amount" > 0 AND "refund_operations"."currency" ~ '^[a-z]{3}$'
    AND "refund_operations"."payment_intent_id" ~ '^pi_[A-Za-z0-9]+$' AND "refund_operations"."charge_id" ~ '^ch_[A-Za-z0-9]+$'
    AND "refund_operations"."environment" IN ('test', 'live') AND "refund_operations"."charge_account_id" ~ '^acct_[A-Za-z0-9]+$' AND "refund_operations"."credential_context" = 'primary'
    AND "refund_operations"."application_fee_amount" BETWEEN 0 AND "refund_operations"."amount"
    AND (("refund_operations"."payment_mode" = 'direct' AND "refund_operations"."destination_account_id" IS NULL AND "refund_operations"."application_fee_amount" = 0)
      OR ("refund_operations"."payment_mode" = 'connect' AND "refund_operations"."destination_account_id" ~ '^acct_[A-Za-z0-9]+$' AND "refund_operations"."destination_account_id" <> "refund_operations"."charge_account_id")) IS TRUE
    AND "refund_operations"."idempotency_key" = 'appointment-refund:' || "refund_operations"."id"::text || ':v1'),
	CONSTRAINT "refund_operation_progress_check" CHECK ("refund_operations"."state" IN ('owed', 'submitting', 'pending', 'retryable', 'succeeded', 'requires_review')
    AND "refund_operations"."failures" >= 0 AND isfinite("refund_operations"."next_recovery_at")
    AND ("refund_operations"."first_submitted_at" IS NULL OR isfinite("refund_operations"."first_submitted_at"))
    AND ("refund_operations"."stripe_refund_id" IS NULL OR "refund_operations"."stripe_refund_id" ~ '^re_[A-Za-z0-9]+$')
    AND ("refund_operations"."state" NOT IN ('pending', 'succeeded') OR "refund_operations"."stripe_refund_id" IS NOT NULL)
    AND ("refund_operations"."state" <> 'submitting' OR "refund_operations"."first_submitted_at" IS NOT NULL)
    AND ("refund_operations"."state" <> 'succeeded' OR ("refund_operations"."stripe_status" = 'succeeded' AND "refund_operations"."succeeded_at" IS NOT NULL)) IS TRUE
    AND ("refund_operations"."state" <> 'requires_review' OR "refund_operations"."review_code" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "refund_operations" ADD CONSTRAINT "refund_operations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_operations" ADD CONSTRAINT "refund_operations_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_operations" ADD CONSTRAINT "refund_operations_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "refund_operation_attempt_idx" ON "refund_operations" USING btree ("attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_operation_booking_idx" ON "refund_operations" USING btree ("booking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_operation_charge_idx" ON "refund_operations" USING btree ("environment","charge_account_id","charge_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_operation_key_idx" ON "refund_operations" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_operation_stripe_idx" ON "refund_operations" USING btree ("environment","charge_account_id","stripe_refund_id");--> statement-breakpoint
CREATE INDEX "refund_operation_recovery_idx" ON "refund_operations" USING btree ("state","next_recovery_at");
--> statement-breakpoint
-- Refund terms are a verified historical snapshot, not mutable deployment configuration.
CREATE FUNCTION guard_refund_operation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a payment_attempts%ROWTYPE; b bookings%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Refund obligations must be retained' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'owed' OR NEW.stripe_refund_id IS NOT NULL OR NEW.first_submitted_at IS NOT NULL
      OR NEW.succeeded_at IS NOT NULL OR NEW.stripe_status IS NOT NULL OR NEW.review_code IS NOT NULL THEN
      RAISE EXCEPTION 'Refund operations must begin as unbound obligations' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO a FROM payment_attempts WHERE id = NEW.attempt_id;
    SELECT * INTO b FROM bookings WHERE id = NEW.booking_id;
    IF a.id IS NULL OR b.id IS NULL OR a.success_facts IS NULL OR a.booking_id IS DISTINCT FROM b.id
      OR a.organization_id IS DISTINCT FROM NEW.organization_id OR b.organization_id IS DISTINCT FROM NEW.organization_id
      OR b.status <> 'cancelled' OR b.payment_status NOT IN ('paid', 'refunded')
      OR a.payment_intent_id IS DISTINCT FROM b.payment_intent_id OR a.amount IS DISTINCT FROM b.amount_paid
      OR a.currency IS DISTINCT FROM b.payment_currency OR a.destination_account_id IS DISTINCT FROM b.destination_account_id
      OR (NEW.payment_intent_id, NEW.amount, NEW.currency, NEW.payment_mode, NEW.environment,
          NEW.charge_account_id, NEW.credential_context, NEW.destination_account_id, NEW.application_fee_amount)
        IS DISTINCT FROM (a.payment_intent_id, a.amount, a.currency, a.payment_mode, a.environment,
          a.charge_account_id, a.credential_context, a.destination_account_id, a.application_fee_amount)
      OR NEW.charge_id IS DISTINCT FROM a.success_facts->>'chargeId' THEN
      RAISE EXCEPTION 'Refund must match its verified payment and cancelled booking' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['state', 'stripe_refund_id', 'stripe_status', 'first_submitted_at', 'succeeded_at',
      'failures', 'next_recovery_at', 'review_code']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['state', 'stripe_refund_id', 'stripe_status', 'first_submitted_at', 'succeeded_at',
      'failures', 'next_recovery_at', 'review_code']) THEN
    RAISE EXCEPTION 'Refund terms are immutable' USING ERRCODE = '23514';
  END IF;
  IF (OLD.stripe_refund_id IS NOT NULL AND NEW.stripe_refund_id IS DISTINCT FROM OLD.stripe_refund_id)
    OR (OLD.first_submitted_at IS NOT NULL AND NEW.first_submitted_at IS DISTINCT FROM OLD.first_submitted_at)
    OR (OLD.succeeded_at IS NOT NULL AND NEW.succeeded_at IS DISTINCT FROM OLD.succeeded_at) THEN
    RAISE EXCEPTION 'Refund identifiers and observation timestamps are write-once' USING ERRCODE = '23514';
  END IF;
  IF OLD.state IN ('succeeded', 'requires_review') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'Completed/review refund operations require explicit manual reconciliation' USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'owed' AND OLD.state <> 'owed' THEN
    RAISE EXCEPTION 'Refund submission cannot be erased' USING ERRCODE = '23514';
  END IF;
  IF OLD.state = 'succeeded' AND NEW.stripe_status IS DISTINCT FROM OLD.stripe_status THEN
    RAISE EXCEPTION 'Verified refund success cannot regress' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER refund_operation_guard BEFORE INSERT OR UPDATE OR DELETE ON refund_operations
FOR EACH ROW EXECUTE FUNCTION guard_refund_operation();
--> statement-breakpoint
-- Query at transaction end so cancellation+obligation and refund success+booking
-- status must commit together, independent of statement order. Existing rows are
-- not backfilled with guessed financial facts by this migration.
CREATE FUNCTION guard_cancelled_payment_obligation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b bookings%ROWTYPE; a payment_attempts%ROWTYPE; r refund_operations%ROWTYPE;
BEGIN
  SELECT * INTO b FROM bookings WHERE id = NEW.id;
  SELECT * INTO a FROM payment_attempts WHERE booking_id = NEW.id;
  IF a.success_facts IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO r FROM refund_operations WHERE attempt_id = a.id;
  IF b.status = 'cancelled' AND r.id IS NULL THEN
    RAISE EXCEPTION 'Durable paid cancellation requires a refund obligation' USING ERRCODE = '23514';
  END IF;
  IF b.payment_status = 'refunded' AND (r.id IS NULL OR r.state <> 'succeeded') THEN
    RAISE EXCEPTION 'Durable refund status requires verified refund success' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER cancelled_payment_obligation_guard AFTER UPDATE OF status, payment_status ON bookings
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.payment_status IS DISTINCT FROM NEW.payment_status)
EXECUTE FUNCTION guard_cancelled_payment_obligation();
--> statement-breakpoint
CREATE FUNCTION guard_refund_booking() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM refund_operations WHERE booking_id = OLD.id) THEN
    IF NEW.status <> 'cancelled'
      OR (NEW.organization_id, NEW.event_type_id, NEW.payment_intent_id, NEW.amount_paid, NEW.payment_currency, NEW.destination_account_id)
        IS DISTINCT FROM (OLD.organization_id, OLD.event_type_id, OLD.payment_intent_id, OLD.amount_paid, OLD.payment_currency, OLD.destination_account_id)
      OR (OLD.payment_status = 'refunded' AND NEW.payment_status <> 'refunded') THEN
      RAISE EXCEPTION 'Refunded/cancelled payment truth cannot be resurrected or rerouted' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER refund_booking_guard BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION guard_refund_booking();
--> statement-breakpoint
CREATE FUNCTION guard_refund_completion_booking() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r refund_operations%ROWTYPE; b bookings%ROWTYPE;
BEGIN
  SELECT * INTO r FROM refund_operations WHERE id = NEW.id;
  SELECT * INTO b FROM bookings WHERE id = r.booking_id;
  IF b.status <> 'cancelled' OR (r.state = 'succeeded' AND b.payment_status <> 'refunded') THEN
    RAISE EXCEPTION 'Refund and cancelled booking completion must commit together' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER refund_completion_booking_guard AFTER INSERT OR UPDATE ON refund_operations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_refund_completion_booking();
