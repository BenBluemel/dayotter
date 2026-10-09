CREATE TABLE "booking_settlement_claims" (
	"operation_key" text PRIMARY KEY NOT NULL,
	"settlement" text NOT NULL,
	"source_id" uuid NOT NULL,
	"request_fingerprint" text NOT NULL,
	CONSTRAINT "booking_settlement_claim_shape" CHECK ("booking_settlement_claims"."settlement" IN ('cash','package_credit') AND "booking_settlement_claims"."request_fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "package_credit_mutations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credit_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_type_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"quantity" integer NOT NULL,
	"operation_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"booking_id" uuid,
	"purchase_id" uuid,
	"actor_user_id" uuid,
	"finalization_state" text,
	"finalization_started_at" timestamp with time zone,
	"finalization_review_code" text,
	"reverses_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "package_mutation_shape_check" CHECK ("package_credit_mutations"."quantity" > 0 AND (("package_credit_mutations"."kind" = 'grant' AND "package_credit_mutations"."booking_id" IS NULL AND "package_credit_mutations"."reverses_id" IS NULL AND (("package_credit_mutations"."purchase_id" IS NULL) <> ("package_credit_mutations"."actor_user_id" IS NULL))) OR ("package_credit_mutations"."kind" = 'redemption' AND "package_credit_mutations"."quantity" = 1 AND "package_credit_mutations"."booking_id" IS NOT NULL AND "package_credit_mutations"."reverses_id" IS NULL AND "package_credit_mutations"."purchase_id" IS NULL AND "package_credit_mutations"."actor_user_id" IS NULL) OR ("package_credit_mutations"."kind" = 'restoration' AND "package_credit_mutations"."booking_id" IS NOT NULL AND "package_credit_mutations"."reverses_id" IS NOT NULL AND "package_credit_mutations"."purchase_id" IS NULL AND "package_credit_mutations"."actor_user_id" IS NULL)))
);
--> statement-breakpoint
CREATE TABLE "package_purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"event_type_id" uuid NOT NULL,
	"terms" jsonb NOT NULL,
	"terms_hash" text NOT NULL,
	"environment" text NOT NULL,
	"charge_account_id" text NOT NULL,
	"state" text DEFAULT 'prepared' NOT NULL,
	"checkout_session_id" text,
	"checkout_url" text,
	"payment_intent_id" text,
	"success_facts" jsonb,
	"credit_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"creation_deadline" timestamp with time zone NOT NULL,
	"next_recovery_at" timestamp with time zone DEFAULT now() NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"review_code" text,
	CONSTRAINT "package_purchase_state_check" CHECK ("package_purchases"."state" IN ('prepared','open','expired','payment_succeeded','granted','requires_review') AND "package_purchases"."failures" >= 0 AND ("package_purchases"."state" <> 'requires_review' OR "package_purchases"."review_code" IS NOT NULL) AND ("package_purchases"."state" NOT IN ('payment_succeeded','granted') OR "package_purchases"."success_facts" IS NOT NULL) AND ("package_purchases"."state" <> 'granted' OR "package_purchases"."credit_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "package_credits" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "package_credits" ADD COLUMN "integrity_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "package_credits" ADD COLUMN "opening_total_credits" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "package_credits" ADD COLUMN "opening_used_credits" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "package_credit_mutations" ADD CONSTRAINT "package_credit_mutations_credit_id_package_credits_id_fk" FOREIGN KEY ("credit_id") REFERENCES "public"."package_credits"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_credit_mutations" ADD CONSTRAINT "package_credit_mutations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_credit_mutations" ADD CONSTRAINT "package_credit_mutations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_credit_mutations" ADD CONSTRAINT "package_credit_mutations_event_type_id_event_types_id_fk" FOREIGN KEY ("event_type_id") REFERENCES "public"."event_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_credit_mutations" ADD CONSTRAINT "package_credit_mutations_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_credit_mutations" ADD CONSTRAINT "package_credit_mutations_purchase_id_package_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."package_purchases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_credit_mutations" ADD CONSTRAINT "package_credit_mutations_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_credit_mutations" ADD CONSTRAINT "package_credit_mutations_reverses_id_package_credit_mutations_id_fk" FOREIGN KEY ("reverses_id") REFERENCES "public"."package_credit_mutations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_purchases" ADD CONSTRAINT "package_purchases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_purchases" ADD CONSTRAINT "package_purchases_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_purchases" ADD CONSTRAINT "package_purchases_package_id_session_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."session_packages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_purchases" ADD CONSTRAINT "package_purchases_event_type_id_event_types_id_fk" FOREIGN KEY ("event_type_id") REFERENCES "public"."event_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_purchases" ADD CONSTRAINT "package_purchases_credit_id_package_credits_id_fk" FOREIGN KEY ("credit_id") REFERENCES "public"."package_credits"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_settlement_claim_source_idx" ON "booking_settlement_claims" USING btree ("settlement","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "package_mutation_operation_idx" ON "package_credit_mutations" USING btree ("operation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "package_mutation_restores_idx" ON "package_credit_mutations" USING btree ("reverses_id");--> statement-breakpoint
CREATE UNIQUE INDEX "package_mutation_purchase_idx" ON "package_credit_mutations" USING btree ("purchase_id");--> statement-breakpoint
CREATE UNIQUE INDEX "package_mutation_booking_kind_idx" ON "package_credit_mutations" USING btree ("booking_id","kind");--> statement-breakpoint
CREATE INDEX "package_mutation_credit_idx" ON "package_credit_mutations" USING btree ("credit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "package_purchase_request_idx" ON "package_purchases" USING btree ("request_key");--> statement-breakpoint
CREATE UNIQUE INDEX "package_purchase_session_idx" ON "package_purchases" USING btree ("environment","charge_account_id","checkout_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "package_purchase_pi_idx" ON "package_purchases" USING btree ("environment","charge_account_id","payment_intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "package_purchase_credit_idx" ON "package_purchases" USING btree ("credit_id");--> statement-breakpoint
CREATE INDEX "package_purchase_recovery_idx" ON "package_purchases" USING btree ("state","next_recovery_at");--> statement-breakpoint
ALTER TABLE "package_credits" ADD CONSTRAINT "package_credits_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "package_credits_owner_idx" ON "package_credits" USING btree ("owner_user_id","event_type_id");--> statement-breakpoint
ALTER TABLE "package_credits" ADD CONSTRAINT "package_credit_integrity_check" CHECK ("package_credits"."integrity_version" = 0 OR ("package_credits"."integrity_version" = 1 AND "package_credits"."owner_user_id" IS NOT NULL AND "package_credits"."total_credits" >= 0 AND "package_credits"."used_credits" BETWEEN 0 AND "package_credits"."total_credits" AND "package_credits"."opening_total_credits" = 0 AND "package_credits"."opening_used_credits" = 0));
--> statement-breakpoint
-- Existing cash request/source relationships are proven facts, not reconstructed credit history.
INSERT INTO booking_settlement_claims(operation_key,settlement,source_id,request_fingerprint)
  SELECT request_key,'cash',id,request_fingerprint FROM payment_attempts;
--> statement-breakpoint
CREATE FUNCTION claim_booking_settlement(k text, method text, source uuid, fingerprint text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE existing booking_settlement_claims%ROWTYPE;
BEGIN
  INSERT INTO booking_settlement_claims VALUES(k,method,source,fingerprint) ON CONFLICT(operation_key) DO NOTHING;
  SELECT * INTO existing FROM booking_settlement_claims WHERE operation_key = k;
  IF existing.settlement IS DISTINCT FROM method OR existing.source_id IS DISTINCT FROM source OR existing.request_fingerprint IS DISTINCT FROM fingerprint THEN
    RAISE EXCEPTION 'Booking operation already has a different settlement' USING ERRCODE='23514', CONSTRAINT='booking_settlement_claim_conflict';
  END IF;
END; $$;
--> statement-breakpoint
CREATE FUNCTION guard_booking_settlement_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Booking settlement identity is immutable' USING ERRCODE='23514';
END; $$;
--> statement-breakpoint
CREATE TRIGGER booking_settlement_claim_guard BEFORE UPDATE OR DELETE ON booking_settlement_claims FOR EACH ROW EXECUTE FUNCTION guard_booking_settlement_claim();
--> statement-breakpoint
CREATE FUNCTION claim_cash_booking_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM claim_booking_settlement(NEW.request_key,'cash',NEW.id,NEW.request_fingerprint);
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER cash_booking_settlement_claim BEFORE INSERT ON payment_attempts FOR EACH ROW EXECUTE FUNCTION claim_cash_booking_settlement();
--> statement-breakpoint
CREATE FUNCTION check_booking_settlement_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.settlement='cash' AND NOT EXISTS(SELECT 1 FROM payment_attempts WHERE id=NEW.source_id AND request_key=NEW.operation_key AND request_fingerprint=NEW.request_fingerprint))
    OR (NEW.settlement='package_credit' AND NOT EXISTS(SELECT 1 FROM package_credit_mutations WHERE booking_id=NEW.source_id AND kind='redemption' AND operation_key=NEW.operation_key AND request_fingerprint=NEW.request_fingerprint)) THEN
    RAISE EXCEPTION 'Settlement claim must commit with its durable source' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END; $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER booking_settlement_claim_binding AFTER INSERT ON booking_settlement_claims DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_booking_settlement_claim();
--> statement-breakpoint
-- Record only observed migration balances. No owner, grant, or redemption is inferred.
UPDATE package_credits SET opening_total_credits = total_credits, opening_used_credits = used_credits;
--> statement-breakpoint
CREATE FUNCTION guard_package_credit_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Package value cannot be deleted' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.integrity_version IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'New package value requires durable ownership and provenance' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (to_jsonb(NEW) - 'total_credits' - 'used_credits' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'total_credits' - 'used_credits' - 'updated_at')
      OR (OLD.integrity_version = 0 AND (NEW.total_credits <> OLD.total_credits OR NEW.used_credits <> OLD.used_credits)) THEN
      RAISE EXCEPTION 'Package ownership and opening history are immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER package_credit_identity_guard BEFORE INSERT OR UPDATE OR DELETE ON package_credits FOR EACH ROW EXECUTE FUNCTION guard_package_credit_identity();
--> statement-breakpoint
CREATE FUNCTION guard_package_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c package_credits%ROWTYPE; b bookings%ROWTYPE; original package_credit_mutations%ROWTYPE; purchase package_purchases%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Package mutations are append-only' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.kind <> 'redemption' OR (to_jsonb(NEW) - ARRAY['finalization_state','finalization_started_at','finalization_review_code']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['finalization_state','finalization_started_at','finalization_review_code'])
      OR (OLD.finalization_state IN ('complete','requires_review') AND NEW.finalization_state IS DISTINCT FROM OLD.finalization_state)
      OR (OLD.finalization_started_at IS NOT NULL AND NEW.finalization_started_at IS DISTINCT FROM OLD.finalization_started_at)
      OR NEW.finalization_state IS NULL OR NEW.finalization_state NOT IN ('pending','running','complete','requires_review')
      OR (OLD.finalization_state = 'pending' AND NEW.finalization_state NOT IN ('pending','running','requires_review'))
      OR (NEW.finalization_state IN ('running','complete') AND NEW.finalization_started_at IS NULL)
      OR (NEW.finalization_state = 'pending' AND NEW.finalization_started_at IS NOT NULL)
      OR (NEW.finalization_state = 'requires_review' AND NEW.finalization_review_code IS NULL) THEN
      RAISE EXCEPTION 'Package mutation financial terms are append-only' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.operation_key = '' OR NEW.request_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid package operation identity' USING ERRCODE = '23514';
  END IF;
  -- Shared ordering with cancellation: booking before entitlement. Purchases lock purchase before entitlement.
  IF NEW.booking_id IS NOT NULL THEN SELECT * INTO b FROM bookings WHERE id = NEW.booking_id FOR UPDATE; END IF;
  SELECT * INTO c FROM package_credits WHERE id = NEW.credit_id FOR UPDATE;
  IF c.integrity_version IS DISTINCT FROM 1 OR c.owner_user_id IS DISTINCT FROM NEW.owner_user_id OR c.organization_id <> NEW.organization_id OR c.event_type_id <> NEW.event_type_id THEN
    RAISE EXCEPTION 'Package mutation ownership mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'grant' THEN
    IF NEW.purchase_id IS NOT NULL THEN
      SELECT * INTO purchase FROM package_purchases WHERE id = NEW.purchase_id;
      IF purchase.state IS DISTINCT FROM 'payment_succeeded' OR purchase.success_facts IS NULL OR purchase.owner_user_id <> NEW.owner_user_id
        OR purchase.organization_id <> NEW.organization_id OR (purchase.terms->>'eventTypeId')::uuid <> NEW.event_type_id
        OR (purchase.terms->>'totalCredits')::integer <> NEW.quantity OR c.package_id IS DISTINCT FROM (purchase.terms->>'packageId')::uuid
        OR c.stripe_payment_intent_id IS DISTINCT FROM purchase.payment_intent_id THEN
        RAISE EXCEPTION 'Package grant requires verified purchase' USING ERRCODE = '23514';
      END IF;
    ELSE
      IF NOT EXISTS (SELECT 1 FROM event_types WHERE id = NEW.event_type_id AND organization_id = NEW.organization_id AND owner_id = NEW.actor_user_id)
        OR c.stripe_payment_intent_id IS NOT NULL
        OR NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.owner_user_id AND email_verified)
        OR NOT EXISTS (SELECT 1 FROM session_packages WHERE id = c.package_id AND event_type_id = NEW.event_type_id AND organization_id = NEW.organization_id AND session_count = NEW.quantity) THEN
        RAISE EXCEPTION 'Manual package grant is not authorized' USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSE
    IF b.id IS NULL OR b.organization_id <> NEW.organization_id OR b.event_type_id <> NEW.event_type_id OR b.payment_intent_id IS NOT NULL OR b.destination_account_id IS NOT NULL OR coalesce(b.amount_paid,0) <> 0
      OR NOT EXISTS (SELECT 1 FROM booking_pricing_snapshots WHERE booking_id = b.id AND settlement = 'package_credit') THEN
      RAISE EXCEPTION 'Package booking settlement mismatch' USING ERRCODE = '23514';
    END IF;
    IF NEW.kind = 'redemption' THEN
      PERFORM claim_booking_settlement(NEW.operation_key,'package_credit',NEW.booking_id,NEW.request_fingerprint);
      IF b.status <> 'confirmed' OR b.recurrence_uid IS NOT NULL OR c.used_credits >= c.total_credits
        OR NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.owner_user_id AND email_verified)
        OR EXISTS (SELECT 1 FROM event_types WHERE id = b.event_type_id AND coalesce(recurring_count,1) > 1) THEN
        RAISE EXCEPTION 'Package credit is not redeemable' USING ERRCODE = '23514';
      END IF;
    ELSE
      SELECT * INTO original FROM package_credit_mutations WHERE id = NEW.reverses_id;
      IF original.kind IS DISTINCT FROM 'redemption' OR b.status <> 'cancelled' OR NEW.credit_id <> original.credit_id OR NEW.owner_user_id <> original.owner_user_id
        OR NEW.booking_id <> original.booking_id OR NEW.quantity <> original.quantity OR NEW.request_fingerprint IS DISTINCT FROM original.request_fingerprint OR NEW.operation_key <> 'package-restore:' || original.id::text THEN
        RAISE EXCEPTION 'Restoration requires its original redemption' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  IF NOT ((NEW.kind = 'redemption' AND NEW.finalization_state = 'pending' AND NEW.finalization_started_at IS NULL AND NEW.finalization_review_code IS NULL)
    OR (NEW.kind <> 'redemption' AND NEW.finalization_state IS NULL AND NEW.finalization_started_at IS NULL AND NEW.finalization_review_code IS NULL)) IS TRUE THEN
    RAISE EXCEPTION 'Invalid package finalization state' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER package_mutation_guard BEFORE INSERT OR UPDATE OR DELETE ON package_credit_mutations FOR EACH ROW EXECUTE FUNCTION guard_package_mutation();
--> statement-breakpoint
CREATE FUNCTION apply_package_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE package_credits SET total_credits = total_credits + CASE WHEN NEW.kind = 'grant' THEN NEW.quantity ELSE 0 END,
    used_credits = used_credits + CASE WHEN NEW.kind = 'redemption' THEN NEW.quantity WHEN NEW.kind = 'restoration' THEN -NEW.quantity ELSE 0 END, updated_at = now() WHERE id = NEW.credit_id;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER package_mutation_apply AFTER INSERT ON package_credit_mutations FOR EACH ROW EXECUTE FUNCTION apply_package_mutation();
--> statement-breakpoint
CREATE FUNCTION check_package_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c package_credits%ROWTYPE; granted bigint; used bigint;
BEGIN
  SELECT * INTO c FROM package_credits WHERE id = NEW.id;
  IF c.integrity_version = 1 THEN
    SELECT coalesce(sum(quantity) FILTER (WHERE kind = 'grant'),0), coalesce(sum(CASE WHEN kind = 'redemption' THEN quantity WHEN kind = 'restoration' THEN -quantity ELSE 0 END),0)
      INTO granted,used FROM package_credit_mutations WHERE credit_id = c.id;
    IF c.total_credits <> granted OR c.used_credits <> used THEN RAISE EXCEPTION 'Package counters must equal durable mutations' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NULL;
END; $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER package_balance_guard AFTER INSERT OR UPDATE ON package_credits DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_package_balance();
--> statement-breakpoint
CREATE FUNCTION check_package_booking() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bid uuid; b bookings%ROWTYPE; redemption package_credit_mutations%ROWTYPE; restored boolean;
BEGIN
  IF TG_TABLE_NAME = 'bookings' THEN bid := NEW.id; ELSE bid := NEW.booking_id; END IF;
  IF bid IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO b FROM bookings WHERE id = bid;
  SELECT * INTO redemption FROM package_credit_mutations WHERE booking_id = bid AND kind = 'redemption';
  IF redemption.id IS NOT NULL THEN
    SELECT EXISTS(SELECT 1 FROM package_credit_mutations WHERE reverses_id = redemption.id) INTO restored;
    IF b.organization_id <> redemption.organization_id OR b.event_type_id <> redemption.event_type_id OR b.payment_intent_id IS NOT NULL OR b.destination_account_id IS NOT NULL OR coalesce(b.amount_paid,0) <> 0
      OR (b.status = 'cancelled') <> restored OR b.payment_status <> (CASE WHEN restored THEN 'refunded'::payment_status ELSE 'paid'::payment_status END) THEN
      RAISE EXCEPTION 'Booking and package redemption must commit together' USING ERRCODE = '23514';
    END IF;
  ELSIF b.payment_status IN ('paid','refunded') AND EXISTS (SELECT 1 FROM booking_pricing_snapshots WHERE booking_id = bid AND settlement = 'package_credit') THEN
    RAISE EXCEPTION 'Package settlement requires durable redemption' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END; $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER package_booking_guard AFTER INSERT OR UPDATE ON bookings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_package_booking();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER package_mutation_booking_guard AFTER INSERT ON package_credit_mutations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_package_booking();
--> statement-breakpoint
CREATE FUNCTION guard_package_purchase() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Package purchase obligation cannot be deleted' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'UPDATE' AND ((to_jsonb(NEW) - ARRAY['state','checkout_session_id','checkout_url','payment_intent_id','success_facts','credit_id','next_recovery_at','failures','review_code']) IS DISTINCT FROM
      (to_jsonb(OLD) - ARRAY['state','checkout_session_id','checkout_url','payment_intent_id','success_facts','credit_id','next_recovery_at','failures','review_code'])
    OR (OLD.checkout_session_id IS NOT NULL AND OLD.checkout_session_id IS DISTINCT FROM NEW.checkout_session_id)
    OR (OLD.payment_intent_id IS NOT NULL AND OLD.payment_intent_id IS DISTINCT FROM NEW.payment_intent_id)
    OR (OLD.success_facts IS NOT NULL AND OLD.success_facts IS DISTINCT FROM NEW.success_facts)
    OR (OLD.credit_id IS NOT NULL AND OLD.credit_id IS DISTINCT FROM NEW.credit_id)
    OR (OLD.state = 'granted' AND NEW.state <> 'granted')
    OR (OLD.success_facts IS NOT NULL AND NEW.state NOT IN ('payment_succeeded','granted','requires_review'))) THEN
    RAISE EXCEPTION 'Package purchase terms and identities are immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT ((NEW.terms->>'eventTypeId')::uuid = NEW.event_type_id AND (NEW.terms->>'packageId')::uuid = NEW.package_id
    AND (NEW.terms->>'version')::integer = 1 AND (NEW.terms->>'organizationId')::uuid = NEW.organization_id AND (NEW.terms->>'ownerUserId')::uuid = NEW.owner_user_id
    AND (NEW.terms->>'amount')::integer > 0 AND (NEW.terms->>'totalCredits')::integer BETWEEN 1 AND 100
    AND NEW.terms->>'currency' ~ '^[a-z]{3}$' AND NEW.environment IN ('test','live') AND NEW.charge_account_id ~ '^acct_[A-Za-z0-9]+$'
    AND NEW.terms->'route'->>'credentialContext' = 'primary' AND NEW.terms->'route'->>'environment' = NEW.environment
    AND NEW.terms->'route'->>'chargeAccountId' = NEW.charge_account_id AND NEW.terms->'route'->>'organizationId' = NEW.organization_id::text
    AND ((NEW.terms->'route'->>'mode' = 'direct' AND NEW.terms->'route'->>'destinationAccountId' IS NULL AND coalesce((NEW.terms->'route'->>'applicationFeeAmount')::integer,0) = 0)
      OR (NEW.terms->'route'->>'mode' = 'connect' AND NEW.terms->'route'->>'destinationAccountId' ~ '^acct_[A-Za-z0-9]+$'
        AND NEW.terms->'route'->>'destinationAccountId' <> NEW.charge_account_id AND (NEW.terms->'route'->>'applicationFeeAmount')::integer BETWEEN 0 AND (NEW.terms->>'amount')::integer))
    AND NEW.terms_hash ~ '^[0-9a-f]{64}$' AND NEW.request_fingerprint ~ '^[0-9a-f]{64}$' AND isfinite(NEW.expires_at) AND isfinite(NEW.creation_deadline) AND isfinite(NEW.next_recovery_at)
    AND NEW.creation_deadline > NEW.created_at AND NEW.expires_at > NEW.creation_deadline) IS TRUE THEN
    RAISE EXCEPTION 'Invalid saved package terms' USING ERRCODE = '23514';
  END IF;
  IF (NEW.success_facts IS NOT NULL AND NEW.state NOT IN ('payment_succeeded','granted','requires_review')) OR (NEW.credit_id IS NOT NULL AND NEW.state <> 'granted') THEN
    RAISE EXCEPTION 'Package paid obligation and grant lifecycle must remain discoverable' USING ERRCODE = '23514';
  END IF;
  IF NEW.success_facts IS NOT NULL AND (NEW.success_facts->>'version' IS DISTINCT FROM '1' OR NEW.success_facts->>'credentialContext' IS DISTINCT FROM 'primary' OR NOT coalesce(NEW.success_facts->>'chargeId' ~ '^ch_[A-Za-z0-9]+$',false) OR NOT coalesce(NEW.checkout_session_id ~ '^cs_[A-Za-z0-9_]+$',false) OR NOT coalesce(NEW.payment_intent_id ~ '^pi_[A-Za-z0-9]+$',false) OR NEW.success_facts->>'sessionId' IS DISTINCT FROM NEW.checkout_session_id OR NEW.success_facts->>'paymentIntentId' IS DISTINCT FROM NEW.payment_intent_id
    OR NEW.success_facts->>'amount' IS DISTINCT FROM NEW.terms->>'amount' OR NEW.success_facts->>'currency' IS DISTINCT FROM NEW.terms->>'currency'
    OR NEW.success_facts->>'environment' IS DISTINCT FROM NEW.environment OR NEW.success_facts->>'chargeAccountId' IS DISTINCT FROM NEW.charge_account_id
    OR NEW.success_facts->>'paymentMode' IS DISTINCT FROM NEW.terms->'route'->>'mode'
    OR NEW.success_facts->>'destinationAccountId' IS DISTINCT FROM NEW.terms->'route'->>'destinationAccountId'
    OR (NEW.success_facts->>'applicationFeeAmount')::integer IS DISTINCT FROM coalesce((NEW.terms->'route'->>'applicationFeeAmount')::integer,0)) THEN
    RAISE EXCEPTION 'Package payment facts contradict saved terms' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER package_purchase_guard BEFORE INSERT OR UPDATE OR DELETE ON package_purchases FOR EACH ROW EXECUTE FUNCTION guard_package_purchase();
--> statement-breakpoint
CREATE FUNCTION check_package_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM package_purchases p WHERE p.id = NEW.id AND p.state = 'granted' AND NOT EXISTS (
    SELECT 1 FROM package_credit_mutations m WHERE m.purchase_id = p.id AND m.credit_id = p.credit_id AND m.kind = 'grant')) THEN
    RAISE EXCEPTION 'Package grant and purchase must commit together' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END; $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER package_purchase_grant_guard AFTER INSERT OR UPDATE ON package_purchases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_package_grant();
--> statement-breakpoint
CREATE FUNCTION check_package_mutation_grant_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.purchase_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM package_purchases WHERE id = NEW.purchase_id AND state = 'granted' AND credit_id = NEW.credit_id) THEN
    RAISE EXCEPTION 'Purchased credits and grant binding must commit together' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END; $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER package_mutation_grant_binding_guard AFTER INSERT ON package_credit_mutations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_package_mutation_grant_binding();
