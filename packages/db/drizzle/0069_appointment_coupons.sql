CREATE TABLE "appointment_coupon_event_types" (
	"coupon_id" uuid NOT NULL,
	"event_type_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	CONSTRAINT "appointment_coupon_event_types_coupon_id_event_type_id_pk" PRIMARY KEY("coupon_id","event_type_id")
);
--> statement-breakpoint
CREATE TABLE "appointment_coupon_restorations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"use_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appointment_coupon_uses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"coupon_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_type_id" uuid NOT NULL,
	"customer_user_id" uuid NOT NULL,
	"operation_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"status" text NOT NULL,
	"payment_attempt_id" uuid,
	"booking_id" uuid,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_coupon_uses_shape_check" CHECK ("appointment_coupon_uses"."request_fingerprint" ~ '^[0-9a-f]{64}$' AND length("appointment_coupon_uses"."operation_key") > 0
        AND (("appointment_coupon_uses"."status" = 'reserved' AND "appointment_coupon_uses"."payment_attempt_id" IS NOT NULL AND "appointment_coupon_uses"."booking_id" IS NULL AND "appointment_coupon_uses"."expires_at" IS NOT NULL AND isfinite("appointment_coupon_uses"."expires_at"))
          OR ("appointment_coupon_uses"."status" = 'released' AND "appointment_coupon_uses"."payment_attempt_id" IS NOT NULL AND "appointment_coupon_uses"."booking_id" IS NULL AND "appointment_coupon_uses"."expires_at" IS NOT NULL)
          OR ("appointment_coupon_uses"."status" IN ('redeemed','restored') AND "appointment_coupon_uses"."booking_id" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "appointment_coupons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"label" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"validity_timezone" text NOT NULL,
	"discount_kind" text NOT NULL,
	"discount_value" integer NOT NULL,
	"currency" text,
	"minimum_base_price" integer,
	"global_limit" integer,
	"per_customer_limit" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_coupons_code_check" CHECK ("appointment_coupons"."code" = upper(btrim("appointment_coupons"."code")) AND "appointment_coupons"."code" ~ '^[A-Z0-9][A-Z0-9_-]{0,63}$'),
	CONSTRAINT "appointment_coupons_terms_check" CHECK (isfinite("appointment_coupons"."starts_at") AND isfinite("appointment_coupons"."ends_at") AND "appointment_coupons"."ends_at" > "appointment_coupons"."starts_at"
        AND ("appointment_coupons"."label" IS NULL OR length(btrim("appointment_coupons"."label")) > 0)
        AND ("appointment_coupons"."minimum_base_price" IS NULL OR "appointment_coupons"."minimum_base_price" >= 0)
        AND ("appointment_coupons"."global_limit" IS NULL OR "appointment_coupons"."global_limit" > 0)
        AND ("appointment_coupons"."per_customer_limit" IS NULL OR "appointment_coupons"."per_customer_limit" > 0)
        AND (("appointment_coupons"."discount_kind" = 'percentage' AND "appointment_coupons"."discount_value" BETWEEN 1 AND 10000 AND "appointment_coupons"."currency" IS NULL)
          OR ("appointment_coupons"."discount_kind" = 'fixed' AND "appointment_coupons"."discount_value" > 0 AND "appointment_coupons"."currency" IS NOT NULL AND "appointment_coupons"."currency" ~ '^[a-z]{3}$')))
);
--> statement-breakpoint
ALTER TABLE "booking_pricing_snapshots" DROP CONSTRAINT "booking_pricing_values_check";--> statement-breakpoint
ALTER TABLE "booking_pricing_snapshots" DROP CONSTRAINT "booking_pricing_promotion_check";--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "business_timezone" text DEFAULT 'America/Boise' NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_pricing_snapshots" ADD COLUMN "discount_source" text;--> statement-breakpoint
ALTER TABLE "booking_pricing_snapshots" ADD COLUMN "coupon_id" uuid;--> statement-breakpoint
ALTER TABLE "booking_pricing_snapshots" ADD COLUMN "coupon_code" text;--> statement-breakpoint
ALTER TABLE "booking_pricing_snapshots" ADD COLUMN "coupon_label" text;--> statement-breakpoint
ALTER TABLE "booking_pricing_snapshots" ADD COLUMN "coupon_starts_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "booking_pricing_snapshots" ADD COLUMN "coupon_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "booking_pricing_snapshots" ADD COLUMN "coupon_discount_kind" text;--> statement-breakpoint
ALTER TABLE "booking_pricing_snapshots" ADD COLUMN "coupon_discount_value" integer;--> statement-breakpoint
ALTER TABLE "booking_pricing_snapshots" ADD COLUMN "coupon_currency" text;--> statement-breakpoint
ALTER TABLE "booking_pricing_snapshots" ADD COLUMN "coupon_minimum_base_price" integer;--> statement-breakpoint
ALTER TABLE "appointment_coupon_event_types" ADD CONSTRAINT "coupon_services_event_org_fk" FOREIGN KEY ("event_type_id","organization_id") REFERENCES "public"."event_types"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_coupon_restorations" ADD CONSTRAINT "appointment_coupon_restorations_use_id_appointment_coupon_uses_id_fk" FOREIGN KEY ("use_id") REFERENCES "public"."appointment_coupon_uses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_coupon_restorations" ADD CONSTRAINT "appointment_coupon_restorations_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_coupon_uses" ADD CONSTRAINT "appointment_coupon_uses_customer_user_id_users_id_fk" FOREIGN KEY ("customer_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_coupon_uses" ADD CONSTRAINT "appointment_coupon_uses_payment_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("payment_attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_coupon_uses" ADD CONSTRAINT "coupon_uses_booking_scope_fk" FOREIGN KEY ("booking_id","organization_id","event_type_id") REFERENCES "public"."bookings"("id","organization_id","event_type_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_coupons" ADD CONSTRAINT "appointment_coupons_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointment_coupon_event_types_event_idx" ON "appointment_coupon_event_types" USING btree ("event_type_id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_coupon_restorations_use_idx" ON "appointment_coupon_restorations" USING btree ("use_id");--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_coupon_uses_operation_idx" ON "appointment_coupon_uses" USING btree ("operation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_coupon_uses_attempt_idx" ON "appointment_coupon_uses" USING btree ("payment_attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_coupon_uses_booking_idx" ON "appointment_coupon_uses" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "appointment_coupon_uses_capacity_idx" ON "appointment_coupon_uses" USING btree ("coupon_id","status","customer_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_coupons_org_code_idx" ON "appointment_coupons" USING btree ("organization_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_coupons_id_org_idx" ON "appointment_coupons" USING btree ("id","organization_id");--> statement-breakpoint
ALTER TABLE "appointment_coupon_event_types" ADD CONSTRAINT "coupon_services_coupon_org_fk" FOREIGN KEY ("coupon_id","organization_id") REFERENCES "public"."appointment_coupons"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_coupon_uses" ADD CONSTRAINT "coupon_uses_coupon_org_fk" FOREIGN KEY ("coupon_id","organization_id") REFERENCES "public"."appointment_coupons"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_pricing_snapshots" ADD CONSTRAINT "booking_pricing_coupon_check" CHECK ((
        ("booking_pricing_snapshots"."coupon_id" IS NULL AND "booking_pricing_snapshots"."coupon_code" IS NULL AND "booking_pricing_snapshots"."coupon_label" IS NULL
          AND "booking_pricing_snapshots"."coupon_starts_at" IS NULL AND "booking_pricing_snapshots"."coupon_ends_at" IS NULL
          AND "booking_pricing_snapshots"."coupon_discount_kind" IS NULL AND "booking_pricing_snapshots"."coupon_discount_value" IS NULL
          AND "booking_pricing_snapshots"."coupon_currency" IS NULL AND "booking_pricing_snapshots"."coupon_minimum_base_price" IS NULL
          AND ("booking_pricing_snapshots"."promotion_id" IS NOT NULL OR "booking_pricing_snapshots"."discount_source" IS NULL))
        OR ("booking_pricing_snapshots"."coupon_id" IS NOT NULL AND "booking_pricing_snapshots"."version" = 2 AND "booking_pricing_snapshots"."settlement" = 'cash'
          AND "booking_pricing_snapshots"."discount_source" IS NOT NULL AND "booking_pricing_snapshots"."discount_source" = 'coupon' AND "booking_pricing_snapshots"."promotion_id" IS NULL
          AND "booking_pricing_snapshots"."coupon_code" IS NOT NULL AND "booking_pricing_snapshots"."coupon_code" ~ '^[A-Z0-9][A-Z0-9_-]{0,63}$'
          AND ("booking_pricing_snapshots"."coupon_label" IS NULL OR length(btrim("booking_pricing_snapshots"."coupon_label")) > 0)
          AND "booking_pricing_snapshots"."coupon_starts_at" IS NOT NULL AND "booking_pricing_snapshots"."coupon_ends_at" IS NOT NULL
          AND isfinite("booking_pricing_snapshots"."coupon_starts_at") AND isfinite("booking_pricing_snapshots"."coupon_ends_at")
          AND "booking_pricing_snapshots"."coupon_ends_at" > "booking_pricing_snapshots"."coupon_starts_at"
          AND "booking_pricing_snapshots"."appointment_starts_at" >= "booking_pricing_snapshots"."coupon_starts_at"
          AND "booking_pricing_snapshots"."appointment_starts_at" < "booking_pricing_snapshots"."coupon_ends_at"
          AND ("booking_pricing_snapshots"."coupon_minimum_base_price" IS NULL OR ("booking_pricing_snapshots"."coupon_minimum_base_price" >= 0 AND "booking_pricing_snapshots"."base_price" >= "booking_pricing_snapshots"."coupon_minimum_base_price"))
          AND "booking_pricing_snapshots"."coupon_discount_kind" IS NOT NULL AND "booking_pricing_snapshots"."coupon_discount_value" IS NOT NULL
          AND "booking_pricing_snapshots"."effective_price" < "booking_pricing_snapshots"."base_price"
          AND (( "booking_pricing_snapshots"."coupon_discount_kind" = 'percentage' AND "booking_pricing_snapshots"."coupon_discount_value" BETWEEN 1 AND 10000
              AND "booking_pricing_snapshots"."coupon_currency" IS NULL
              AND "booking_pricing_snapshots"."effective_price" = "booking_pricing_snapshots"."base_price" - floor(("booking_pricing_snapshots"."base_price"::numeric * "booking_pricing_snapshots"."coupon_discount_value" + 5000) / 10000))
            OR ("booking_pricing_snapshots"."coupon_discount_kind" = 'fixed' AND "booking_pricing_snapshots"."coupon_discount_value" > 0
              AND "booking_pricing_snapshots"."coupon_currency" IS NOT NULL AND "booking_pricing_snapshots"."coupon_currency" = "booking_pricing_snapshots"."currency"
              AND "booking_pricing_snapshots"."effective_price" = greatest(0, "booking_pricing_snapshots"."base_price" - "booking_pricing_snapshots"."coupon_discount_value"))))
      ) AND ("booking_pricing_snapshots"."promotion_id" IS NULL OR "booking_pricing_snapshots"."discount_source" IS NULL OR "booking_pricing_snapshots"."discount_source" = 'promotion')
        AND ("booking_pricing_snapshots"."discount_source" IS NULL OR "booking_pricing_snapshots"."discount_source" IN ('promotion','coupon')));--> statement-breakpoint
ALTER TABLE "booking_pricing_snapshots" ADD CONSTRAINT "booking_pricing_values_check" CHECK (
    "booking_pricing_snapshots"."version" IN (1,2) AND isfinite("booking_pricing_snapshots"."appointment_starts_at")
    AND "booking_pricing_snapshots"."base_price" >= 0 AND "booking_pricing_snapshots"."effective_price" BETWEEN 0 AND "booking_pricing_snapshots"."base_price"
    AND "booking_pricing_snapshots"."amount_to_collect" BETWEEN 0 AND "booking_pricing_snapshots"."effective_price"
    AND "booking_pricing_snapshots"."currency" ~ '^[a-z]{3}$'
    AND "booking_pricing_snapshots"."settlement" IN ('cash', 'package_credit')
    AND ("booking_pricing_snapshots"."settlement" <> 'package_credit' OR ("booking_pricing_snapshots"."promotion_id" IS NULL AND "booking_pricing_snapshots"."coupon_id" IS NULL AND "booking_pricing_snapshots"."effective_price" = "booking_pricing_snapshots"."base_price" AND "booking_pricing_snapshots"."amount_to_collect" = 0))
  );--> statement-breakpoint
ALTER TABLE "booking_pricing_snapshots" ADD CONSTRAINT "booking_pricing_promotion_check" CHECK ((
    ("booking_pricing_snapshots"."promotion_id" IS NULL AND "booking_pricing_snapshots"."promotion_label" IS NULL AND "booking_pricing_snapshots"."promotion_starts_at" IS NULL
      AND "booking_pricing_snapshots"."promotion_ends_at" IS NULL AND "booking_pricing_snapshots"."promotion_discount_kind" IS NULL
      AND "booking_pricing_snapshots"."promotion_discount_value" IS NULL AND "booking_pricing_snapshots"."promotion_currency" IS NULL
      AND ("booking_pricing_snapshots"."coupon_id" IS NOT NULL OR "booking_pricing_snapshots"."effective_price" = "booking_pricing_snapshots"."base_price"))
    OR ("booking_pricing_snapshots"."promotion_id" IS NOT NULL AND "booking_pricing_snapshots"."promotion_label" IS NOT NULL AND length(btrim("booking_pricing_snapshots"."promotion_label")) > 0
      AND "booking_pricing_snapshots"."promotion_starts_at" IS NOT NULL AND "booking_pricing_snapshots"."promotion_ends_at" IS NOT NULL
      AND isfinite("booking_pricing_snapshots"."promotion_starts_at") AND isfinite("booking_pricing_snapshots"."promotion_ends_at")
      AND "booking_pricing_snapshots"."promotion_ends_at" > "booking_pricing_snapshots"."promotion_starts_at"
      AND "booking_pricing_snapshots"."appointment_starts_at" >= "booking_pricing_snapshots"."promotion_starts_at" AND "booking_pricing_snapshots"."appointment_starts_at" < "booking_pricing_snapshots"."promotion_ends_at"
      AND "booking_pricing_snapshots"."promotion_discount_kind" IS NOT NULL AND "booking_pricing_snapshots"."promotion_discount_value" IS NOT NULL
      AND "booking_pricing_snapshots"."effective_price" < "booking_pricing_snapshots"."base_price"
      AND (
        ("booking_pricing_snapshots"."promotion_discount_kind" = 'percentage' AND "booking_pricing_snapshots"."promotion_discount_value" BETWEEN 1 AND 10000 AND "booking_pricing_snapshots"."promotion_currency" IS NULL
          AND "booking_pricing_snapshots"."effective_price" = "booking_pricing_snapshots"."base_price" - floor(("booking_pricing_snapshots"."base_price"::numeric * "booking_pricing_snapshots"."promotion_discount_value" + 5000) / 10000))
        OR ("booking_pricing_snapshots"."promotion_discount_kind" = 'fixed' AND "booking_pricing_snapshots"."promotion_discount_value" > 0 AND "booking_pricing_snapshots"."promotion_currency" IS NOT NULL AND "booking_pricing_snapshots"."promotion_currency" = "booking_pricing_snapshots"."currency"
          AND "booking_pricing_snapshots"."effective_price" = greatest(0, "booking_pricing_snapshots"."base_price" - "booking_pricing_snapshots"."promotion_discount_value"))
      ))
  ));--> statement-breakpoint
ALTER TABLE payment_attempts DROP CONSTRAINT payment_attempt_quote_binding_check;
--> statement-breakpoint
ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempt_quote_binding_check CHECK (jsonb_typeof(quote) = 'object' AND (
 quote->>'version' IN ('1','2') AND quote->>'settlement' = settlement
 AND (quote->>'version' <> '2' OR (jsonb_typeof(quote->'coupon') = 'object' AND quote->>'promotion' IS NULL))
 AND quote->>'organizationId' = organization_id::text AND quote->>'eventTypeId' = event_type_id::text
 AND quote->>'currency' = currency AND (quote->>'amountToCollect')::integer = amount
 AND (quote->>'effectivePrice')::integer >= amount AND (quote->>'basePrice')::integer >= (quote->>'effectivePrice')::integer
 AND isfinite((quote->>'appointmentStartsAt')::timestamptz)) IS TRUE);
--> statement-breakpoint
CREATE FUNCTION guard_coupon_use() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Coupon use history is immutable'; END IF;
 IF TG_OP = 'UPDATE' THEN
   IF (NEW.id,NEW.coupon_id,NEW.organization_id,NEW.event_type_id,NEW.customer_user_id,NEW.operation_key,NEW.request_fingerprint,NEW.payment_attempt_id,NEW.expires_at,NEW.created_at) IS DISTINCT FROM
      (OLD.id,OLD.coupon_id,OLD.organization_id,OLD.event_type_id,OLD.customer_user_id,OLD.operation_key,OLD.request_fingerprint,OLD.payment_attempt_id,OLD.expires_at,OLD.created_at)
      THEN RAISE EXCEPTION 'Coupon use identity is immutable'; END IF;
   IF NOT ((OLD.status='reserved' AND NEW.status IN ('redeemed','released') AND ((NEW.status='released' AND NEW.booking_id IS NULL) OR (NEW.status='redeemed' AND NEW.booking_id IS NOT NULL)))
      OR (OLD.status='redeemed' AND NEW.status='restored' AND NEW.booking_id=OLD.booking_id))
      THEN RAISE EXCEPTION 'Invalid coupon use transition'; END IF;
 END IF;
 IF NEW.payment_attempt_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM payment_attempts a WHERE a.id=NEW.payment_attempt_id AND a.organization_id=NEW.organization_id AND a.event_type_id=NEW.event_type_id AND a.request_key=NEW.operation_key AND a.request_fingerprint=NEW.request_fingerprint AND a.quote->'coupon'->>'id'=NEW.coupon_id::text)
   THEN RAISE EXCEPTION 'Coupon reservation does not match checkout'; END IF;
 IF NEW.booking_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM booking_pricing_snapshots s WHERE s.booking_id=NEW.booking_id AND s.organization_id=NEW.organization_id AND s.event_type_id=NEW.event_type_id AND s.coupon_id=NEW.coupon_id AND s.discount_source='coupon')
   THEN RAISE EXCEPTION 'Coupon use does not match accepted quote'; END IF;
 IF NEW.status='released' AND NOT EXISTS (SELECT 1 FROM payment_attempts a WHERE a.id=NEW.payment_attempt_id AND a.state IN ('expired','payment_failed') AND a.success_facts IS NULL AND a.booking_id IS NULL)
   THEN RAISE EXCEPTION 'Coupon reservation is not terminal'; END IF;
 IF NEW.status='restored' AND NOT EXISTS (SELECT 1 FROM appointment_coupon_restorations r WHERE r.use_id=NEW.id AND r.booking_id=NEW.booking_id)
   THEN RAISE EXCEPTION 'Coupon restoration is missing'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER coupon_use_guard BEFORE INSERT OR UPDATE OR DELETE ON appointment_coupon_uses FOR EACH ROW EXECUTE FUNCTION guard_coupon_use();
--> statement-breakpoint
CREATE FUNCTION guard_coupon_restoration() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Coupon restoration history is immutable'; END IF;
 IF NOT EXISTS (SELECT 1 FROM appointment_coupon_uses u JOIN bookings b ON b.id=u.booking_id WHERE u.id=NEW.use_id AND u.booking_id=NEW.booking_id AND u.status='redeemed' AND b.status='cancelled')
   THEN RAISE EXCEPTION 'Coupon restoration must reference cancelled redemption'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER coupon_restoration_guard BEFORE INSERT OR UPDATE OR DELETE ON appointment_coupon_restorations FOR EACH ROW EXECUTE FUNCTION guard_coupon_restoration();
--> statement-breakpoint
-- Check both sides at commit, after booking/quote/use/restoration writes converge.
CREATE FUNCTION check_coupon_booking() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bid uuid; b bookings%ROWTYPE; u appointment_coupon_uses%ROWTYPE; has_coupon boolean; restored boolean;
BEGIN
 IF TG_TABLE_NAME='bookings' THEN bid:=NEW.id; ELSE bid:=NEW.booking_id; END IF;
 IF bid IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO b FROM bookings WHERE id=bid;
 SELECT * INTO u FROM appointment_coupon_uses WHERE booking_id=bid;
 SELECT EXISTS(SELECT 1 FROM booking_pricing_snapshots WHERE booking_id=bid AND coupon_id IS NOT NULL) INTO has_coupon;
 IF has_coupon OR u.id IS NOT NULL THEN
   SELECT EXISTS(SELECT 1 FROM appointment_coupon_restorations WHERE use_id=u.id AND booking_id=bid) INTO restored;
   IF b.id IS NULL OR u.id IS NULL OR NOT has_coupon
      OR u.organization_id<>b.organization_id OR u.event_type_id<>b.event_type_id
      OR EXISTS(SELECT 1 FROM booking_pricing_snapshots WHERE booking_id=bid AND coupon_id IS NOT NULL AND coupon_id<>u.coupon_id)
      OR u.status NOT IN ('redeemed','restored')
      OR (b.status='cancelled')<>(u.status='restored') OR (u.status='restored')<>restored THEN
     RAISE EXCEPTION 'Coupon booking, redemption and cancellation restoration must commit together' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER coupon_booking_binding AFTER INSERT OR UPDATE ON bookings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_coupon_booking();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER coupon_quote_booking_binding AFTER INSERT ON booking_pricing_snapshots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_coupon_booking();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER coupon_use_booking_binding AFTER INSERT OR UPDATE ON appointment_coupon_uses DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_coupon_booking();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER coupon_restoration_booking_binding AFTER INSERT ON appointment_coupon_restorations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_coupon_booking();
--> statement-breakpoint
CREATE FUNCTION check_coupon_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE aid uuid; a payment_attempts%ROWTYPE; u appointment_coupon_uses%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='payment_attempts' THEN aid:=NEW.id; ELSE aid:=NEW.payment_attempt_id; END IF;
 IF aid IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO a FROM payment_attempts WHERE id=aid;
 SELECT * INTO u FROM appointment_coupon_uses WHERE payment_attempt_id=aid;
 IF a.quote->>'version'='2' OR u.id IS NOT NULL THEN
   IF a.id IS NULL OR u.id IS NULL OR a.quote->>'version'<>'2'
      OR a.quote->'coupon'->>'id' IS DISTINCT FROM u.coupon_id::text
      OR a.organization_id<>u.organization_id OR a.event_type_id<>u.event_type_id
      OR a.request_key<>u.operation_key OR a.request_fingerprint<>u.request_fingerprint
      OR (a.booking_id IS NOT NULL AND a.booking_id IS DISTINCT FROM u.booking_id) THEN
     RAISE EXCEPTION 'Coupon checkout quote and reservation must commit together' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER coupon_attempt_binding AFTER INSERT OR UPDATE ON payment_attempts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_coupon_attempt();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER coupon_use_attempt_binding AFTER INSERT OR UPDATE ON appointment_coupon_uses DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_coupon_attempt();
