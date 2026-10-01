CREATE TABLE "appointment_promotion_event_types" (
	"promotion_id" uuid NOT NULL,
	"event_type_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	CONSTRAINT "appointment_promotion_event_types_promotion_id_event_type_id_pk" PRIMARY KEY("promotion_id","event_type_id")
);
--> statement-breakpoint
CREATE TABLE "appointment_promotions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"label" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"discount_kind" text NOT NULL,
	"discount_value" integer NOT NULL,
	"currency" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_promotions_label_check" CHECK (length(btrim("appointment_promotions"."label")) > 0),
	CONSTRAINT "appointment_promotions_window_check" CHECK (isfinite("appointment_promotions"."starts_at") AND isfinite("appointment_promotions"."ends_at") AND "appointment_promotions"."ends_at" > "appointment_promotions"."starts_at"),
	CONSTRAINT "appointment_promotions_discount_check" CHECK (
    ("appointment_promotions"."discount_kind" = 'percentage' AND "appointment_promotions"."discount_value" BETWEEN 1 AND 10000 AND "appointment_promotions"."currency" IS NULL)
    OR ("appointment_promotions"."discount_kind" = 'fixed' AND "appointment_promotions"."discount_value" > 0 AND "appointment_promotions"."currency" IS NOT NULL AND "appointment_promotions"."currency" ~ '^[a-z]{3}$')
  )
);
--> statement-breakpoint
CREATE TABLE "booking_pricing_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_type_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"appointment_starts_at" timestamp with time zone NOT NULL,
	"settlement" text NOT NULL,
	"base_price" integer NOT NULL,
	"effective_price" integer NOT NULL,
	"currency" text NOT NULL,
	"amount_to_collect" integer NOT NULL,
	"promotion_id" uuid,
	"promotion_label" text,
	"promotion_starts_at" timestamp with time zone,
	"promotion_ends_at" timestamp with time zone,
	"promotion_discount_kind" text,
	"promotion_discount_value" integer,
	"promotion_currency" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_pricing_values_check" CHECK (
    "booking_pricing_snapshots"."version" = 1 AND isfinite("booking_pricing_snapshots"."appointment_starts_at")
    AND "booking_pricing_snapshots"."base_price" >= 0 AND "booking_pricing_snapshots"."effective_price" BETWEEN 0 AND "booking_pricing_snapshots"."base_price"
    AND "booking_pricing_snapshots"."amount_to_collect" BETWEEN 0 AND "booking_pricing_snapshots"."effective_price"
    AND "booking_pricing_snapshots"."currency" ~ '^[a-z]{3}$'
    AND "booking_pricing_snapshots"."settlement" IN ('cash', 'package_credit')
    AND ("booking_pricing_snapshots"."settlement" <> 'package_credit' OR ("booking_pricing_snapshots"."promotion_id" IS NULL AND "booking_pricing_snapshots"."effective_price" = "booking_pricing_snapshots"."base_price" AND "booking_pricing_snapshots"."amount_to_collect" = 0))
  ),
	CONSTRAINT "booking_pricing_promotion_check" CHECK ((
    ("booking_pricing_snapshots"."promotion_id" IS NULL AND "booking_pricing_snapshots"."promotion_label" IS NULL AND "booking_pricing_snapshots"."promotion_starts_at" IS NULL
      AND "booking_pricing_snapshots"."promotion_ends_at" IS NULL AND "booking_pricing_snapshots"."promotion_discount_kind" IS NULL
      AND "booking_pricing_snapshots"."promotion_discount_value" IS NULL AND "booking_pricing_snapshots"."promotion_currency" IS NULL
      AND "booking_pricing_snapshots"."effective_price" = "booking_pricing_snapshots"."base_price")
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
  ))
);
--> statement-breakpoint
CREATE INDEX "appointment_promotion_event_types_event_idx" ON "appointment_promotion_event_types" USING btree ("event_type_id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_promotions_id_org_idx" ON "appointment_promotions" USING btree ("id","organization_id");--> statement-breakpoint
CREATE INDEX "appointment_promotions_org_idx" ON "appointment_promotions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "booking_pricing_booking_idx" ON "booking_pricing_snapshots" USING btree ("booking_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "event_types_id_org_idx" ON "event_types" USING btree ("id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_id_org_event_idx" ON "bookings" USING btree ("id","organization_id","event_type_id");--> statement-breakpoint
-- Referenced unique indexes must exist before adding the composite foreign keys.
ALTER TABLE "appointment_promotion_event_types" ADD CONSTRAINT "promotion_services_promotion_org_fk" FOREIGN KEY ("promotion_id","organization_id") REFERENCES "public"."appointment_promotions"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_promotion_event_types" ADD CONSTRAINT "promotion_services_event_org_fk" FOREIGN KEY ("event_type_id","organization_id") REFERENCES "public"."event_types"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_promotions" ADD CONSTRAINT "appointment_promotions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_pricing_snapshots" ADD CONSTRAINT "booking_pricing_booking_scope_fk" FOREIGN KEY ("booking_id","organization_id","event_type_id") REFERENCES "public"."bookings"("id","organization_id","event_type_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Drizzle does not model triggers. Keep these guards with the schema migration.
CREATE FUNCTION guard_booking_pricing_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent public.bookings%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Booking pricing snapshots are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.bookings WHERE id = OLD.booking_id) THEN
      RAISE EXCEPTION 'Pricing history can only be deleted with its booking' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  SELECT * INTO parent FROM public.bookings WHERE id = NEW.booking_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found' USING ERRCODE = '23503';
  END IF;
  IF parent.payment_intent_id IS NOT NULL OR parent.destination_account_id IS NOT NULL OR coalesce(parent.amount_paid, 0) > 0 OR parent.payment_status IN ('paid', 'refunded') THEN
    RAISE EXCEPTION 'Settled bookings require an explicit pricing adjustment' USING ERRCODE = '23514';
  END IF;
  IF NEW.appointment_starts_at <> parent.starts_at THEN
    RAISE EXCEPTION 'Quote does not match the booking start' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.booking_pricing_snapshots WHERE booking_id = NEW.booking_id AND settlement <> NEW.settlement) THEN
    RAISE EXCEPTION 'Cash and credit settlement cannot be mixed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER booking_pricing_snapshot_guard BEFORE INSERT OR UPDATE OR DELETE ON "booking_pricing_snapshots"
FOR EACH ROW EXECUTE FUNCTION guard_booking_pricing_snapshot();--> statement-breakpoint

CREATE FUNCTION guard_booking_credit_payment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.payment_intent_id IS NOT NULL OR coalesce(NEW.amount_paid, 0) > 0 OR NEW.destination_account_id IS NOT NULL)
    AND EXISTS (SELECT 1 FROM public.booking_pricing_snapshots WHERE booking_id = NEW.id AND settlement = 'package_credit') THEN
    RAISE EXCEPTION 'A package-credit booking cannot collect cash' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER booking_credit_payment_guard BEFORE UPDATE ON "bookings"
FOR EACH ROW EXECUTE FUNCTION guard_booking_credit_payment();
