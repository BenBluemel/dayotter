CREATE TABLE "payment_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"purpose" text DEFAULT 'appointment' NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_type_id" uuid NOT NULL,
	"booking_intent" text NOT NULL,
	"quote" jsonb NOT NULL,
	"quote_hash" text NOT NULL,
	"amount" integer NOT NULL,
	"currency" text NOT NULL,
	"settlement" text DEFAULT 'cash' NOT NULL,
	"expected_payment_status" text DEFAULT 'paid' NOT NULL,
	"payment_mode" text NOT NULL,
	"environment" text NOT NULL,
	"charge_account_id" text NOT NULL,
	"credential_context" text NOT NULL,
	"destination_account_id" text,
	"application_fee_amount" integer DEFAULT 0 NOT NULL,
	"product_name" text NOT NULL,
	"success_url" text NOT NULL,
	"cancel_url" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"creation_deadline" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'prepared' NOT NULL,
	"checkout_session_id" text,
	"checkout_url" text,
	"payment_intent_id" text,
	"booking_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_attempt_quote_binding_check" CHECK (jsonb_typeof("payment_attempts"."quote") = 'object' AND (
    "payment_attempts"."quote"->>'version' = '1' AND "payment_attempts"."quote"->>'settlement' = "payment_attempts"."settlement"
    AND "payment_attempts"."quote"->>'organizationId' = "payment_attempts"."organization_id"::text AND "payment_attempts"."quote"->>'eventTypeId' = "payment_attempts"."event_type_id"::text
    AND "payment_attempts"."quote"->>'currency' = "payment_attempts"."currency" AND ("payment_attempts"."quote"->>'amountToCollect')::integer = "payment_attempts"."amount"
    AND ("payment_attempts"."quote"->>'effectivePrice')::integer >= "payment_attempts"."amount" AND ("payment_attempts"."quote"->>'basePrice')::integer >= ("payment_attempts"."quote"->>'effectivePrice')::integer
    AND isfinite(("payment_attempts"."quote"->>'appointmentStartsAt')::timestamptz)
  ) IS TRUE),
	CONSTRAINT "payment_attempt_terms_check" CHECK ("payment_attempts"."purpose" = 'appointment' AND "payment_attempts"."settlement" = 'cash' AND "payment_attempts"."expected_payment_status" = 'paid'
    AND "payment_attempts"."amount" > 0 AND "payment_attempts"."currency" ~ '^[a-z]{3}$' AND "payment_attempts"."environment" IN ('test', 'live')
    AND "payment_attempts"."credential_context" = 'primary' AND "payment_attempts"."charge_account_id" ~ '^acct_[A-Za-z0-9]+$'
    AND "payment_attempts"."request_fingerprint" ~ '^[a-f0-9]{64}$' AND "payment_attempts"."quote_hash" ~ '^[a-f0-9]{64}$'
    AND "payment_attempts"."application_fee_amount" BETWEEN 0 AND "payment_attempts"."amount"
    AND (("payment_attempts"."payment_mode" = 'direct' AND "payment_attempts"."destination_account_id" IS NULL AND "payment_attempts"."application_fee_amount" = 0)
      OR ("payment_attempts"."payment_mode" = 'connect' AND "payment_attempts"."destination_account_id" IS NOT NULL AND "payment_attempts"."destination_account_id" ~ '^acct_[A-Za-z0-9]+$' AND "payment_attempts"."destination_account_id" <> "payment_attempts"."charge_account_id"))
    AND isfinite("payment_attempts"."expires_at") AND isfinite("payment_attempts"."creation_deadline") AND "payment_attempts"."creation_deadline" > "payment_attempts"."created_at" AND "payment_attempts"."expires_at" > "payment_attempts"."creation_deadline"
    AND "payment_attempts"."state" IN ('prepared', 'open', 'expired', 'fulfilled', 'requires_review')
    AND ("payment_attempts"."state" <> 'open' OR "payment_attempts"."checkout_session_id" IS NOT NULL)
    AND ("payment_attempts"."state" <> 'fulfilled' OR ("payment_attempts"."booking_id" IS NOT NULL AND "payment_attempts"."payment_intent_id" IS NOT NULL AND "payment_attempts"."checkout_session_id" IS NOT NULL)))
);
--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempt_booking_scope_fk" FOREIGN KEY ("booking_id","organization_id","event_type_id") REFERENCES "public"."bookings"("id","organization_id","event_type_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempt_event_scope_fk" FOREIGN KEY ("event_type_id","organization_id") REFERENCES "public"."event_types"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempt_request_key_idx" ON "payment_attempts" USING btree ("request_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempt_session_idx" ON "payment_attempts" USING btree ("environment","charge_account_id","checkout_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempt_intent_idx" ON "payment_attempts" USING btree ("environment","charge_account_id","payment_intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempt_booking_idx" ON "payment_attempts" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "payment_attempt_state_idx" ON "payment_attempts" USING btree ("state","created_at");
--> statement-breakpoint
CREATE FUNCTION guard_payment_attempt_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Payment attempts must be retained for reconciliation' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['state', 'checkout_session_id', 'checkout_url', 'payment_intent_id', 'booking_id'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state', 'checkout_session_id', 'checkout_url', 'payment_intent_id', 'booking_id']) THEN
    RAISE EXCEPTION 'Payment attempt terms are immutable' USING ERRCODE = '23514';
  END IF;
  IF (OLD.checkout_session_id IS NOT NULL AND NEW.checkout_session_id IS DISTINCT FROM OLD.checkout_session_id)
    OR (OLD.checkout_url IS NOT NULL AND NEW.checkout_url IS DISTINCT FROM OLD.checkout_url)
    OR (OLD.payment_intent_id IS NOT NULL AND NEW.payment_intent_id IS DISTINCT FROM OLD.payment_intent_id)
    OR (OLD.booking_id IS NOT NULL AND NEW.booking_id IS DISTINCT FROM OLD.booking_id) THEN
    RAISE EXCEPTION 'Payment attempt identifiers are write-once' USING ERRCODE = '23514';
  END IF;
  IF NEW.state <> OLD.state AND NOT (
    (OLD.state = 'prepared' AND NEW.state IN ('open', 'expired', 'fulfilled', 'requires_review'))
    OR (OLD.state = 'open' AND NEW.state IN ('expired', 'fulfilled', 'requires_review'))
    OR (OLD.state = 'requires_review' AND NEW.state = 'fulfilled')
  ) THEN
    RAISE EXCEPTION 'Invalid payment attempt state transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_attempt_terms_guard BEFORE UPDATE OR DELETE ON payment_attempts
FOR EACH ROW EXECUTE FUNCTION guard_payment_attempt_terms();
