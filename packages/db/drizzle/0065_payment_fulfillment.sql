CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"stripe_event_id" text NOT NULL,
	"environment" text NOT NULL,
	"charge_account_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" text NOT NULL,
	"payload_hash" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"next_recovery_at" timestamp with time zone DEFAULT now() NOT NULL,
	"review_code" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_event_terms_check" CHECK ("payment_events"."environment" IN ('test', 'live') AND "payment_events"."charge_account_id" ~ '^acct_[A-Za-z0-9]+$'
    AND "payment_events"."stripe_event_id" ~ '^evt_[A-Za-z0-9]+$' AND "payment_events"."payload_hash" ~ '^[a-f0-9]{64}$'
    AND "payment_events"."state" IN ('pending', 'completed', 'requires_review') AND "payment_events"."failures" >= 0 AND isfinite("payment_events"."next_recovery_at"))
);
--> statement-breakpoint
ALTER TABLE "payment_attempts" DROP CONSTRAINT "payment_attempt_terms_check";--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "payment_succeeded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "success_facts" jsonb;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "next_recovery_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "recovery_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "review_code" text;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "finalization_context" text;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "finalization_state" text;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "finalization_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "finalization_review_code" text;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_event_identity_idx" ON "payment_events" USING btree ("environment","charge_account_id","stripe_event_id");--> statement-breakpoint
CREATE INDEX "payment_event_pending_idx" ON "payment_events" USING btree ("state","next_recovery_at");--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempt_progress_check" CHECK ("payment_attempts"."recovery_failures" >= 0 AND isfinite("payment_attempts"."next_recovery_at")
      AND (("payment_attempts"."finalization_state" IS NULL AND "payment_attempts"."finalization_context" IS NULL AND "payment_attempts"."finalization_started_at" IS NULL)
        OR ("payment_attempts"."booking_id" IS NOT NULL AND "payment_attempts"."finalization_context" IS NOT NULL AND "payment_attempts"."finalization_state" IN ('pending', 'running', 'attempted', 'requires_review')
          AND ("payment_attempts"."finalization_state" NOT IN ('running', 'attempted') OR "payment_attempts"."finalization_started_at" IS NOT NULL))) IS TRUE);--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempt_success_check" CHECK (
      ("payment_attempts"."success_facts" IS NULL AND "payment_attempts"."payment_succeeded_at" IS NULL
        AND "payment_attempts"."state" NOT IN ('payment_succeeded', 'fulfilling')) OR (
      "payment_attempts"."success_facts" IS NOT NULL AND "payment_attempts"."payment_succeeded_at" IS NOT NULL AND (
        "payment_attempts"."success_facts"->>'version' = '1'
        AND "payment_attempts"."success_facts"->>'sessionId' = "payment_attempts"."checkout_session_id"
        AND "payment_attempts"."success_facts"->>'paymentIntentId' = "payment_attempts"."payment_intent_id"
        AND "payment_attempts"."success_facts"->>'chargeId' ~ '^ch_[A-Za-z0-9]+$'
        AND ("payment_attempts"."success_facts"->>'amount')::integer = "payment_attempts"."amount"
        AND "payment_attempts"."success_facts"->>'currency' = "payment_attempts"."currency"
        AND "payment_attempts"."success_facts"->>'environment' = "payment_attempts"."environment"
        AND "payment_attempts"."success_facts"->>'chargeAccountId' = "payment_attempts"."charge_account_id"
        AND "payment_attempts"."success_facts"->>'credentialContext' = "payment_attempts"."credential_context"
        AND "payment_attempts"."success_facts"->>'paymentMode' = "payment_attempts"."payment_mode"
        AND ("payment_attempts"."success_facts"->>'destinationAccountId') IS NOT DISTINCT FROM "payment_attempts"."destination_account_id"
        AND ("payment_attempts"."success_facts"->>'applicationFeeAmount')::integer = "payment_attempts"."application_fee_amount"
      ) IS TRUE));--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempt_terms_check" CHECK ("payment_attempts"."purpose" = 'appointment' AND "payment_attempts"."settlement" = 'cash' AND "payment_attempts"."expected_payment_status" = 'paid'
    AND "payment_attempts"."amount" > 0 AND "payment_attempts"."currency" ~ '^[a-z]{3}$' AND "payment_attempts"."environment" IN ('test', 'live')
    AND "payment_attempts"."credential_context" = 'primary' AND "payment_attempts"."charge_account_id" ~ '^acct_[A-Za-z0-9]+$'
    AND "payment_attempts"."request_fingerprint" ~ '^[a-f0-9]{64}$' AND "payment_attempts"."quote_hash" ~ '^[a-f0-9]{64}$'
    AND "payment_attempts"."application_fee_amount" BETWEEN 0 AND "payment_attempts"."amount"
    AND (("payment_attempts"."payment_mode" = 'direct' AND "payment_attempts"."destination_account_id" IS NULL AND "payment_attempts"."application_fee_amount" = 0)
      OR ("payment_attempts"."payment_mode" = 'connect' AND "payment_attempts"."destination_account_id" IS NOT NULL AND "payment_attempts"."destination_account_id" ~ '^acct_[A-Za-z0-9]+$' AND "payment_attempts"."destination_account_id" <> "payment_attempts"."charge_account_id"))
    AND isfinite("payment_attempts"."expires_at") AND isfinite("payment_attempts"."creation_deadline") AND "payment_attempts"."creation_deadline" > "payment_attempts"."created_at" AND "payment_attempts"."expires_at" > "payment_attempts"."creation_deadline"
    AND "payment_attempts"."state" IN ('prepared', 'open', 'expired', 'payment_failed', 'payment_succeeded', 'fulfilling', 'fulfilled', 'requires_review')
    AND ("payment_attempts"."state" <> 'open' OR "payment_attempts"."checkout_session_id" IS NOT NULL)
    AND ("payment_attempts"."state" <> 'fulfilled' OR ("payment_attempts"."booking_id" IS NOT NULL AND "payment_attempts"."payment_intent_id" IS NOT NULL AND "payment_attempts"."checkout_session_id" IS NOT NULL)));
--> statement-breakpoint
-- Financial terms remain immutable. Only durable observations/progress are mutable.
CREATE OR REPLACE FUNCTION guard_payment_attempt_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'prepared' OR NEW.checkout_session_id IS NOT NULL OR NEW.checkout_url IS NOT NULL
      OR NEW.payment_intent_id IS NOT NULL OR NEW.booking_id IS NOT NULL OR NEW.success_facts IS NOT NULL
      OR NEW.payment_succeeded_at IS NOT NULL OR NEW.finalization_context IS NOT NULL OR NEW.finalization_state IS NOT NULL THEN
      RAISE EXCEPTION 'New payment attempts must begin as unbound prepared intents' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Payment attempts must be retained for reconciliation' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['state', 'checkout_session_id', 'checkout_url', 'payment_intent_id', 'booking_id',
      'success_facts', 'payment_succeeded_at', 'next_recovery_at', 'recovery_failures', 'review_code',
      'finalization_context', 'finalization_state', 'finalization_started_at', 'finalization_review_code'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state', 'checkout_session_id', 'checkout_url', 'payment_intent_id', 'booking_id',
      'success_facts', 'payment_succeeded_at', 'next_recovery_at', 'recovery_failures', 'review_code',
      'finalization_context', 'finalization_state', 'finalization_started_at', 'finalization_review_code']) THEN
    RAISE EXCEPTION 'Payment attempt terms are immutable' USING ERRCODE = '23514';
  END IF;
  IF (OLD.checkout_session_id IS NOT NULL AND NEW.checkout_session_id IS DISTINCT FROM OLD.checkout_session_id)
    OR (OLD.checkout_url IS NOT NULL AND NEW.checkout_url IS DISTINCT FROM OLD.checkout_url)
    OR (OLD.payment_intent_id IS NOT NULL AND NEW.payment_intent_id IS DISTINCT FROM OLD.payment_intent_id)
    OR (OLD.booking_id IS NOT NULL AND NEW.booking_id IS DISTINCT FROM OLD.booking_id)
    OR (OLD.success_facts IS NOT NULL AND NEW.success_facts IS DISTINCT FROM OLD.success_facts)
    OR (OLD.payment_succeeded_at IS NOT NULL AND NEW.payment_succeeded_at IS DISTINCT FROM OLD.payment_succeeded_at)
    OR (OLD.finalization_context IS NOT NULL AND NEW.finalization_context IS DISTINCT FROM OLD.finalization_context)
    OR (OLD.finalization_started_at IS NOT NULL AND NEW.finalization_started_at IS DISTINCT FROM OLD.finalization_started_at) THEN
    RAISE EXCEPTION 'Payment attempt observations and identifiers are write-once' USING ERRCODE = '23514';
  END IF;
  IF NEW.state <> OLD.state AND NOT (
    (OLD.state IN ('prepared', 'open') AND NEW.state IN ('open', 'expired', 'payment_failed', 'payment_succeeded', 'requires_review'))
    OR (OLD.state IN ('expired', 'payment_failed') AND NEW.state IN ('payment_succeeded', 'requires_review'))
    OR (OLD.state = 'payment_succeeded' AND NEW.state IN ('fulfilling', 'fulfilled', 'requires_review'))
    OR (OLD.state = 'fulfilling' AND NEW.state IN ('payment_succeeded', 'fulfilled', 'requires_review'))
    OR (OLD.state = 'requires_review' AND OLD.review_code = 'creation_ambiguous' AND NEW.state = 'payment_succeeded')
  ) THEN
    RAISE EXCEPTION 'Invalid payment attempt state transition' USING ERRCODE = '23514';
  END IF;
  IF NEW.success_facts IS NOT NULL AND NEW.state NOT IN ('payment_succeeded', 'fulfilling', 'fulfilled', 'requires_review') THEN
    RAISE EXCEPTION 'Observed success must retain a booking obligation or review state' USING ERRCODE = '23514';
  END IF;
  IF NEW.booking_id IS NOT NULL AND OLD.booking_id IS NULL AND
    (NEW.state <> 'fulfilled' OR NEW.success_facts IS NULL OR NEW.finalization_context IS NULL OR NEW.finalization_state <> 'pending') THEN
    RAISE EXCEPTION 'New booking binding requires observed success and durable finalization context' USING ERRCODE = '23514';
  END IF;
  IF NEW.finalization_state IS DISTINCT FROM OLD.finalization_state AND NOT (
    (OLD.finalization_state IS NULL AND NEW.finalization_state = 'pending' AND OLD.booking_id IS NULL)
    OR (OLD.finalization_state = 'pending' AND NEW.finalization_state IN ('running', 'requires_review'))
    OR (OLD.finalization_state = 'running' AND NEW.finalization_state IN ('attempted', 'requires_review'))
  ) THEN
    RAISE EXCEPTION 'Invalid paid booking finalization transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION guard_payment_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'pending' THEN
      RAISE EXCEPTION 'New payment events must begin pending' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Payment events must be retained for reconciliation' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['state', 'failures', 'next_recovery_at', 'review_code']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['state', 'failures', 'next_recovery_at', 'review_code']) THEN
    RAISE EXCEPTION 'Payment event facts are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> 'pending' AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'Payment event completion is terminal' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_event_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_events
FOR EACH ROW EXECUTE FUNCTION guard_payment_event();

--> statement-breakpoint
DROP TRIGGER payment_attempt_terms_guard ON payment_attempts;
--> statement-breakpoint
CREATE TRIGGER payment_attempt_terms_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_attempts
FOR EACH ROW EXECUTE FUNCTION guard_payment_attempt_terms();
