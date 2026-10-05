CREATE TABLE "payment_review_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"method" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"evidence" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "payment_review_action_shape_check" CHECK ("payment_review_actions"."method" IN ('retry','refund') AND "payment_review_actions"."state" IN ('active','failed','booked','refunded') AND "payment_review_actions"."request_fingerprint" ~ '^[a-f0-9]{64}$' AND length("payment_review_actions"."evidence") > 0 AND ("payment_review_actions"."state" IN ('active','failed') OR "payment_review_actions"."resolved_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "refund_operations" DROP CONSTRAINT "refund_operation_terms_check";--> statement-breakpoint
ALTER TABLE "refund_operations" ALTER COLUMN "booking_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "scheduling_attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "creation_operation_key" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "creation_fingerprint" text;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "scheduling_plan" jsonb;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "scheduling_duration_minutes" integer;--> statement-breakpoint
ALTER TABLE "payment_review_actions" ADD CONSTRAINT "payment_review_actions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_review_actions" ADD CONSTRAINT "payment_review_actions_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_review_actions" ADD CONSTRAINT "payment_review_actions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_review_action_attempt_idx" ON "payment_review_actions" USING btree ("attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_creation_operation_idx" ON "bookings" USING btree ("creation_operation_key");--> statement-breakpoint
ALTER TABLE "refund_operations" ADD CONSTRAINT "refund_operation_terms_check" CHECK ((("refund_operations"."purpose" = 'cancellation' AND "refund_operations"."booking_id" IS NOT NULL) OR ("refund_operations"."purpose" = 'unbooked_obligation' AND "refund_operations"."booking_id" IS NULL)) AND "refund_operations"."amount" > 0 AND "refund_operations"."currency" ~ '^[a-z]{3}$'
    AND "refund_operations"."payment_intent_id" ~ '^pi_[A-Za-z0-9]+$' AND "refund_operations"."charge_id" ~ '^ch_[A-Za-z0-9]+$'
    AND "refund_operations"."environment" IN ('test', 'live') AND "refund_operations"."charge_account_id" ~ '^acct_[A-Za-z0-9]+$' AND "refund_operations"."credential_context" = 'primary'
    AND "refund_operations"."application_fee_amount" BETWEEN 0 AND "refund_operations"."amount"
    AND (("refund_operations"."payment_mode" = 'direct' AND "refund_operations"."destination_account_id" IS NULL AND "refund_operations"."application_fee_amount" = 0)
      OR ("refund_operations"."payment_mode" = 'connect' AND "refund_operations"."destination_account_id" ~ '^acct_[A-Za-z0-9]+$' AND "refund_operations"."destination_account_id" <> "refund_operations"."charge_account_id")) IS TRUE
    AND "refund_operations"."idempotency_key" = 'appointment-refund:' || "refund_operations"."id"::text || ':v1');
--> statement-breakpoint
CREATE FUNCTION resource_incompatible_commitments(eid uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(
  SELECT 1 FROM bookings b WHERE b.event_type_id=eid AND b.status NOT IN ('cancelled','rejected')
   AND (b.scheduling_plan IS NULL OR (jsonb_array_length(b.scheduling_plan->'resources')=0 AND b.ends_at+(b.scheduling_plan->>'bufferAfterMinutes')::integer*interval '1 minute'>statement_timestamp()))
  UNION ALL
  SELECT 1 FROM payment_attempts a WHERE a.event_type_id=eid AND a.booking_id IS NULL
   AND (a.success_facts IS NOT NULL OR a.state NOT IN ('expired','payment_failed') OR a.checkout_session_id IS NULL)
   AND NOT EXISTS(SELECT 1 FROM refund_operations r WHERE r.attempt_id=a.id AND r.purpose='unbooked_obligation' AND r.state='succeeded')
   AND (a.scheduling_plan IS NULL OR jsonb_array_length(a.scheduling_plan->'resources')=0)
 );
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION resource_guard_service() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
BEGIN
 IF NOT NEW.requires_host THEN
  PERFORM resource_error('resource_plan_completeness_violation'); -- cutover unavailable in R1
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.resource_admission_epoch<>0 THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
  NEW.resource_configuration_revision:=1;
 ELSE
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id AND (EXISTS(SELECT 1 FROM bookings WHERE event_type_id=OLD.id AND scheduling_plan IS NOT NULL) OR EXISTS(SELECT 1 FROM payment_attempts WHERE event_type_id=OLD.id AND scheduling_plan IS NOT NULL)) THEN PERFORM resource_error('resource_scope_violation'); END IF;
  IF (to_jsonb(NEW)-ARRAY['updated_at','resource_configuration_revision']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['updated_at','resource_configuration_revision']) OR
      NEW.resource_configuration_revision IS DISTINCT FROM OLD.resource_configuration_revision THEN
   -- Explicit lock strength; callers editing requirements take this before resources.
   PERFORM 1 FROM event_types WHERE id=OLD.id FOR UPDATE;
   NEW.resource_configuration_revision:=OLD.resource_configuration_revision+1;
  END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM event_type_resource_requirements WHERE event_type_id=NEW.id) AND
   (NEW.scheduling_type<>'individual' OR NEW.max_attendees<>1 OR NEW.recurring_count<>1 OR NEW.owner_id IS NULL OR NEW.slug='__personal') THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
 IF TG_OP='UPDATE' AND NEW.resource_admission_epoch IS DISTINCT FROM OLD.resource_admission_epoch THEN
  PERFORM 1 FROM event_types WHERE id=OLD.id FOR UPDATE;
  IF OLD.resource_admission_epoch<>0 OR NEW.resource_admission_epoch<>1 OR NOT NEW.is_active
    OR NOT EXISTS(SELECT 1 FROM event_type_resource_requirements WHERE event_type_id=NEW.id) THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
  IF resource_incompatible_commitments(NEW.id) THEN PERFORM resource_error('resource_adoption_required'); END IF;
 END IF;
 IF NEW.resource_admission_epoch>0 AND (NEW.scheduling_type<>'individual' OR NEW.max_attendees<>1 OR NEW.recurring_count<>1 OR NEW.owner_id IS NULL OR NEW.slug='__personal') THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
 IF TG_OP='UPDATE' AND NOT OLD.is_active AND NEW.is_active AND NEW.resource_admission_epoch>0 AND resource_incompatible_commitments(NEW.id) THEN PERFORM resource_error('resource_adoption_required'); END IF;
 IF NEW.resource_configuration_revision>9007199254740991 THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION resource_guard_requirement() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE eid uuid; ids uuid[]; r resources%ROWTYPE; e event_types%ROWTYPE;
BEGIN
 eid:=CASE WHEN TG_OP='DELETE' THEN OLD.event_type_id ELSE NEW.event_type_id END;
 IF TG_OP='UPDATE' AND (NEW.organization_id,NEW.event_type_id) IS DISTINCT FROM (OLD.organization_id,OLD.event_type_id)
   THEN PERFORM resource_error('resource_scope_violation'); END IF;
 SELECT * INTO e FROM event_types WHERE id=eid FOR UPDATE;
 IF e.id IS NULL OR e.organization_id IS DISTINCT FROM (CASE WHEN TG_OP='DELETE' THEN OLD.organization_id ELSE NEW.organization_id END)
   THEN PERFORM resource_error('resource_scope_violation'); END IF;
 IF e.scheduling_type<>'individual' OR e.max_attendees<>1 OR e.recurring_count<>1 OR e.owner_id IS NULL OR e.slug='__personal'
   THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
 IF TG_OP<>'DELETE' AND e.resource_admission_epoch>0 AND NOT EXISTS(SELECT 1 FROM event_type_resource_requirements WHERE event_type_id=eid) AND resource_incompatible_commitments(eid) THEN PERFORM resource_error('resource_adoption_required'); END IF;
 SELECT array_agg(DISTINCT id) INTO ids FROM (
  SELECT resource_id AS id FROM event_type_resource_requirements WHERE event_type_id=eid
  UNION SELECT CASE WHEN TG_OP='DELETE' THEN OLD.resource_id ELSE NEW.resource_id END
 ) all_ids;
 PERFORM resource_fence(ids);
 IF TG_OP<>'DELETE' THEN
  SELECT * INTO r FROM resources WHERE id=NEW.resource_id;
  IF r.organization_id IS DISTINCT FROM NEW.organization_id THEN PERFORM resource_error('resource_scope_violation'); END IF;
  IF NOT r.enabled THEN PERFORM resource_error('resource_disabled'); END IF;
  IF NEW.quantity>r.capacity THEN PERFORM resource_error('resource_capacity_conflict','23P01'); END IF;
 END IF;
 -- Already-held service lock is reused, not acquired after resource locks.
 UPDATE event_types SET resource_configuration_revision=resource_configuration_revision+1 WHERE id=eid;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION resource_guard_booking() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE expected jsonb; e event_types%ROWTYPE; a payment_attempts%ROWTYPE; admission boolean;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.scheduling_plan IS NOT NULL THEN PERFORM resource_error('resource_claim_lifecycle_violation'); END IF;
  RETURN OLD;
 END IF;
 IF NEW.scheduling_plan IS NOT NULL AND (jsonb_typeof(NEW.scheduling_plan) IS DISTINCT FROM 'object' OR jsonb_typeof(NEW.scheduling_plan->'resources') IS DISTINCT FROM 'array') THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
 admission:=TG_OP='INSERT';
 IF TG_OP='UPDATE' THEN
  admission:=(NEW.starts_at,NEW.ends_at,NEW.status,NEW.event_type_id,NEW.host_id) IS DISTINCT FROM (OLD.starts_at,OLD.ends_at,OLD.status,OLD.event_type_id,OLD.host_id);
  IF (NEW.scheduling_attempt_id,NEW.creation_operation_key,NEW.creation_fingerprint) IS DISTINCT FROM (OLD.scheduling_attempt_id,OLD.creation_operation_key,OLD.creation_fingerprint) THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
 END IF;
 IF admission THEN
  SELECT * INTO e FROM event_types WHERE id=NEW.event_type_id FOR SHARE;
  IF e.resource_admission_epoch>0 AND NEW.status NOT IN ('cancelled','rejected') THEN
   IF NEW.scheduling_plan IS NULL THEN
    IF TG_OP='INSERT' THEN PERFORM resource_error('resource_plan_completeness_violation'); ELSE PERFORM resource_error('resource_adoption_required'); END IF;
   END IF;
   IF (TG_OP='INSERT' AND NOT e.is_active) OR NEW.recurrence_uid IS NOT NULL OR e.recurring_count<>1 OR e.max_attendees<>1 OR e.scheduling_type<>'individual' THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
   IF EXISTS(SELECT 1 FROM event_type_resource_requirements WHERE event_type_id=e.id) AND jsonb_array_length(NEW.scheduling_plan->'resources')=0 AND (TG_OP='INSERT' OR NEW.ends_at+(NEW.scheduling_plan->>'bufferAfterMinutes')::integer*interval '1 minute'>statement_timestamp()) THEN IF TG_OP='INSERT' THEN PERFORM resource_error('resource_plan_completeness_violation'); ELSE PERFORM resource_error('resource_adoption_required'); END IF; END IF;
  END IF;
 END IF;
 IF TG_OP='UPDATE' AND OLD.scheduling_plan IS DISTINCT FROM NEW.scheduling_plan THEN
  -- No raw NULL->managed adoption and no rewriting accepted custody, even with flags.
  PERFORM resource_error('resource_plan_completeness_violation');
 END IF;
 IF NEW.scheduling_plan IS NULL THEN
  IF NEW.scheduling_attempt_id IS NOT NULL OR NEW.allocation_revision IS NOT NULL THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.scheduling_attempt_id IS NULL THEN
   expected:=resource_accept_plan(NEW.event_type_id,(NEW.scheduling_plan->>'durationMinutes')::integer,NEW.host_id);
  ELSE
   SELECT * INTO a FROM payment_attempts WHERE id=NEW.scheduling_attempt_id; -- caller holds attempt lock
   IF a.id IS NULL OR a.success_facts IS NULL OR a.booking_id IS NOT NULL OR a.state NOT IN ('payment_succeeded','fulfilling') OR
     a.organization_id<>NEW.organization_id OR a.event_type_id<>NEW.event_type_id OR
     NEW.starts_at IS DISTINCT FROM (a.quote->>'appointmentStartsAt')::timestamptz OR
     NEW.ends_at IS DISTINCT FROM NEW.starts_at+a.scheduling_duration_minutes*interval '1 minute' OR
     NOT (a.scheduling_plan->'requiredHostIds' @> jsonb_build_array(NEW.host_id)) OR
     EXISTS(SELECT 1 FROM refund_operations WHERE attempt_id=a.id AND purpose='unbooked_obligation') THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
   expected:=a.scheduling_plan;
  END IF;
  IF NEW.scheduling_plan IS DISTINCT FROM expected OR NEW.allocation_revision IS DISTINCT FROM 1 OR NEW.recurrence_uid IS NOT NULL
    OR NEW.is_group OR NEW.status NOT IN ('pending','confirmed') THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
 ELSE
  IF (NEW.id,NEW.organization_id,NEW.event_type_id,NEW.host_id,NEW.is_group,NEW.created_at,NEW.recurrence_uid) IS DISTINCT FROM
     (OLD.id,OLD.organization_id,OLD.event_type_id,OLD.host_id,OLD.is_group,OLD.created_at,OLD.recurrence_uid)
     THEN PERFORM resource_error('resource_scope_violation'); END IF;
  IF OLD.status IN ('cancelled','rejected') AND NEW.status IS DISTINCT FROM OLD.status THEN PERFORM resource_error('resource_claim_lifecycle_violation'); END IF;
  IF (NEW.starts_at,NEW.ends_at) IS DISTINCT FROM (OLD.starts_at,OLD.ends_at) THEN
   IF OLD.status NOT IN ('pending','confirmed') OR NEW.status NOT IN ('pending','confirmed') OR
     NEW.allocation_revision IS DISTINCT FROM OLD.allocation_revision+1 THEN PERFORM resource_error('resource_claim_lifecycle_violation'); END IF;
  ELSIF NEW.allocation_revision IS DISTINCT FROM OLD.allocation_revision THEN PERFORM resource_error('resource_claim_lifecycle_violation'); END IF;
 END IF;
 IF NEW.organization_id::text IS DISTINCT FROM NEW.scheduling_plan->>'organizationId' OR
    NEW.event_type_id::text IS DISTINCT FROM NEW.scheduling_plan->>'eventTypeId' THEN PERFORM resource_error('resource_scope_violation'); END IF;
 IF NOT (isfinite(NEW.starts_at) AND isfinite(NEW.ends_at) AND NEW.ends_at-NEW.starts_at=(NEW.scheduling_plan->>'durationMinutes')::integer*interval '1 minute'
    AND NEW.allocation_revision BETWEEN 1 AND 9007199254740991) IS TRUE THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
 RETURN NEW;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN
 PERFORM resource_error('resource_plan_completeness_violation');
END $$;
--> statement-breakpoint
CREATE FUNCTION resource_guard_attempt() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE e event_types%ROWTYPE; expected jsonb;
BEGIN
 SELECT * INTO e FROM event_types WHERE id=NEW.event_type_id FOR SHARE;
 IF e.organization_id IS DISTINCT FROM NEW.organization_id THEN PERFORM resource_error('resource_scope_violation'); END IF;
 IF TG_OP='INSERT' THEN
  IF e.resource_admission_epoch>0 AND NEW.scheduling_plan IS NULL THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
  IF NEW.scheduling_plan IS NOT NULL THEN
   IF NEW.scheduling_duration_minutes IS NULL OR NEW.scheduling_duration_minutes<=0 THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
   expected:=resource_accept_plan(e.id,NEW.scheduling_duration_minutes,e.owner_id);
   IF NEW.scheduling_plan IS DISTINCT FROM expected THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
   IF EXISTS(SELECT 1 FROM event_type_resource_requirements q JOIN resources r ON r.id=q.resource_id WHERE q.event_type_id=e.id AND NOT r.enabled) THEN PERFORM resource_error('resource_disabled'); END IF;
  ELSIF NEW.scheduling_duration_minutes IS NOT NULL THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
 END IF;
 IF NEW.booking_id IS NOT NULL AND EXISTS(SELECT 1 FROM refund_operations WHERE attempt_id=NEW.id AND purpose='unbooked_obligation') THEN PERFORM resource_error('resource_claim_lifecycle_violation'); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER resource_attempt_admission BEFORE INSERT OR UPDATE ON payment_attempts FOR EACH ROW EXECUTE FUNCTION resource_guard_attempt();
--> statement-breakpoint
CREATE FUNCTION resource_check_attempt_binding() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE b bookings%ROWTYPE; a payment_attempts%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='bookings' THEN SELECT * INTO b FROM bookings WHERE id=NEW.id; SELECT * INTO a FROM payment_attempts WHERE id=b.scheduling_attempt_id;
 ELSE SELECT * INTO a FROM payment_attempts WHERE id=NEW.id; SELECT * INTO b FROM bookings WHERE id=a.booking_id; END IF;
 IF a.scheduling_plan IS NOT NULL AND a.booking_id IS NOT NULL AND (b.id IS NULL OR b.scheduling_attempt_id IS DISTINCT FROM a.id) THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
 IF b.scheduling_attempt_id IS NOT NULL AND (a.booking_id IS DISTINCT FROM b.id OR a.scheduling_plan IS DISTINCT FROM b.scheduling_plan OR a.success_facts IS NULL) THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER resource_booking_attempt_binding AFTER INSERT OR UPDATE ON bookings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION resource_check_attempt_binding();
CREATE CONSTRAINT TRIGGER resource_attempt_booking_binding AFTER INSERT OR UPDATE ON payment_attempts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION resource_check_attempt_binding();
--> statement-breakpoint
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
    OR (OLD.state = 'requires_review' AND (OLD.review_code = 'creation_ambiguous' OR EXISTS(SELECT 1 FROM payment_review_actions WHERE attempt_id=OLD.id AND method='retry' AND state='active')) AND NEW.state = 'payment_succeeded')
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
CREATE OR REPLACE FUNCTION guard_refund_operation() RETURNS trigger LANGUAGE plpgsql AS $$
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
    SELECT * INTO a FROM payment_attempts WHERE id = NEW.attempt_id FOR UPDATE;
    SELECT * INTO b FROM bookings WHERE id = NEW.booking_id;
    IF a.id IS NULL OR a.success_facts IS NULL OR a.organization_id IS DISTINCT FROM NEW.organization_id
      OR (NEW.purpose='cancellation' AND (b.id IS NULL OR a.booking_id IS DISTINCT FROM b.id OR b.organization_id IS DISTINCT FROM NEW.organization_id OR b.status<>'cancelled' OR b.payment_status NOT IN ('paid','refunded') OR a.payment_intent_id IS DISTINCT FROM b.payment_intent_id OR a.amount IS DISTINCT FROM b.amount_paid OR a.currency IS DISTINCT FROM b.payment_currency OR a.destination_account_id IS DISTINCT FROM b.destination_account_id))
      OR (NEW.purpose='unbooked_obligation' AND (NEW.booking_id IS NOT NULL OR a.booking_id IS NOT NULL OR a.state<>'requires_review' OR NOT EXISTS(SELECT 1 FROM payment_review_actions WHERE attempt_id=a.id AND method='refund' AND state='active')))
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
CREATE OR REPLACE FUNCTION guard_refund_completion_booking() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r refund_operations%ROWTYPE; b bookings%ROWTYPE;
BEGIN
  SELECT * INTO r FROM refund_operations WHERE id = NEW.id;
  SELECT * INTO b FROM bookings WHERE id = r.booking_id;
  IF r.purpose='unbooked_obligation' THEN
    IF EXISTS(SELECT 1 FROM payment_attempts WHERE id=r.attempt_id AND booking_id IS NOT NULL) THEN RAISE EXCEPTION 'Unbooked refund cannot acquire a booking' USING ERRCODE='23514'; END IF;
    IF r.state='succeeded' AND (EXISTS(SELECT 1 FROM appointment_coupon_uses WHERE payment_attempt_id=r.attempt_id AND status='reserved') OR NOT EXISTS(SELECT 1 FROM payment_review_actions WHERE attempt_id=r.attempt_id AND method='refund' AND state='refunded')) THEN RAISE EXCEPTION 'Unbooked refund requires durable resolution evidence' USING ERRCODE='23514'; END IF;
    RETURN NULL;
  END IF;
  IF b.status <> 'cancelled' OR (r.state = 'succeeded' AND b.payment_status <> 'refunded') THEN
    RAISE EXCEPTION 'Refund and cancelled booking completion must commit together' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_coupon_use() RETURNS trigger LANGUAGE plpgsql AS $$
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
 IF NEW.status='released' AND NOT EXISTS (SELECT 1 FROM payment_attempts a WHERE a.id=NEW.payment_attempt_id AND a.booking_id IS NULL AND ((a.state IN ('expired','payment_failed') AND a.success_facts IS NULL) OR EXISTS(SELECT 1 FROM refund_operations r WHERE r.attempt_id=a.id AND r.purpose='unbooked_obligation' AND r.state='succeeded')))
   THEN RAISE EXCEPTION 'Coupon reservation is not terminal'; END IF;
 IF NEW.status='restored' AND NOT EXISTS (SELECT 1 FROM appointment_coupon_restorations r WHERE r.use_id=NEW.id AND r.booking_id=NEW.booking_id)
   THEN RAISE EXCEPTION 'Coupon restoration is missing'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION guard_payment_review_action() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE a payment_attempts%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Payment review evidence must be retained' USING ERRCODE='23514'; END IF;
 SELECT * INTO a FROM payment_attempts WHERE id=NEW.attempt_id FOR UPDATE;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'active' OR NEW.resolved_at IS NOT NULL OR a.success_facts IS NULL OR a.booking_id IS NOT NULL OR a.state<>'requires_review' OR a.review_code IS DISTINCT FROM 'booking_obligation_requires_review' OR a.organization_id<>NEW.organization_id OR
    NOT EXISTS(SELECT 1 FROM memberships WHERE organization_id=NEW.organization_id AND user_id=NEW.actor_user_id AND role IN ('owner','admin')) OR
    EXISTS(SELECT 1 FROM refund_operations WHERE attempt_id=a.id) OR EXISTS(SELECT 1 FROM payment_review_actions WHERE attempt_id=a.id AND state='active')
    THEN RAISE EXCEPTION 'Payment review action requires an authorized unresolved obligation' USING ERRCODE='23514'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['state','resolved_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','resolved_at']) OR OLD.state<>'active' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Payment review history is immutable' USING ERRCODE='23514'; END IF;
  IF NEW.state='booked' AND (NEW.method<>'retry' OR a.booking_id IS NULL) OR NEW.state='refunded' AND (NEW.method<>'refund' OR NOT EXISTS(SELECT 1 FROM refund_operations WHERE attempt_id=a.id AND purpose='unbooked_obligation' AND state='succeeded')) THEN RAISE EXCEPTION 'Payment review resolution requires verified evidence' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER payment_review_action_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_review_actions FOR EACH ROW EXECUTE FUNCTION guard_payment_review_action();

--> statement-breakpoint
CREATE UNIQUE INDEX payment_review_action_active_idx ON payment_review_actions(attempt_id) WHERE state='active';
--> statement-breakpoint
ALTER TABLE bookings ADD CONSTRAINT bookings_scheduling_attempt_id_payment_attempts_id_fk FOREIGN KEY(scheduling_attempt_id) REFERENCES payment_attempts(id) ON DELETE RESTRICT;

--> statement-breakpoint
CREATE TRIGGER payment_review_action_no_truncate BEFORE TRUNCATE ON payment_review_actions FOR EACH STATEMENT EXECUTE FUNCTION resource_guard_truncate_history();

--> statement-breakpoint
CREATE OR REPLACE FUNCTION resource_guard_schedule_history() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM bookings WHERE scheduling_plan->>'scheduleId'=OLD.id::text) OR EXISTS(SELECT 1 FROM payment_attempts WHERE scheduling_plan->>'scheduleId'=OLD.id::text) THEN PERFORM resource_error('resource_claim_lifecycle_violation'); END IF;
 RETURN OLD;
END $$;

--> statement-breakpoint
ALTER TABLE bookings ADD CONSTRAINT booking_creation_identity_check CHECK ((creation_operation_key IS NULL AND creation_fingerprint IS NULL) OR (scheduling_plan IS NOT NULL AND creation_operation_key IS NOT NULL AND creation_fingerprint ~ '^[a-f0-9]{64}$' AND creation_operation_key LIKE 'host-booking:' || host_id::text || ':%') IS TRUE);
