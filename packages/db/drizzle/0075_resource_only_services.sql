DROP INDEX "bookings_host_slot_active_idx";--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "requires_host" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_host_slot_active_idx" ON "bookings" USING btree ("host_id","starts_at") WHERE "bookings"."status" IN ('confirmed', 'pending') AND "bookings"."is_group" = false AND "bookings"."allow_overlap" = false AND "bookings"."requires_host" = true;
--> statement-breakpoint

-- The provider identity stays intact. Only accepted capacity participation changes.
ALTER TABLE bookings DROP CONSTRAINT bookings_no_overlap;
ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap EXCLUDE USING gist
 (host_id WITH =, tstzrange(starts_at,ends_at) WITH &&)
 WHERE (status IN ('confirmed','pending') AND NOT is_group AND NOT allow_overlap AND requires_host);
--> statement-breakpoint
CREATE FUNCTION resource_guard_booking_attendance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.requires_host IS DISTINCT FROM OLD.requires_host THEN
  PERFORM resource_error('resource_plan_completeness_violation');
 END IF;
 IF NEW.scheduling_plan IS NULL THEN
  IF NOT NEW.requires_host THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
 ELSE
  IF jsonb_typeof(NEW.scheduling_plan) IS DISTINCT FROM 'object' OR
     jsonb_typeof(NEW.scheduling_plan->'resources') IS DISTINCT FROM 'array' THEN
   PERFORM resource_error('resource_plan_completeness_violation');
  END IF;
  IF jsonb_typeof(NEW.scheduling_plan->'requiresHost') IS DISTINCT FROM 'boolean'
    OR NEW.host_id::text IS DISTINCT FROM NEW.scheduling_plan->>'scheduleOwnerId'
    OR NEW.scheduling_plan->'requiredHostIds' IS DISTINCT FROM
      (CASE WHEN (NEW.scheduling_plan->>'requiresHost')::boolean THEN jsonb_build_array(NEW.host_id) ELSE '[]'::jsonb END)
    OR (NOT (NEW.scheduling_plan->>'requiresHost')::boolean AND jsonb_array_length(NEW.scheduling_plan->'resources')=0)
    THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
  -- Derive on INSERT; never trust a caller-supplied capacity exemption.
  IF TG_OP='INSERT' THEN NEW.requires_host:=(NEW.scheduling_plan->>'requiresHost')::boolean;
  ELSIF NEW.requires_host IS DISTINCT FROM (NEW.scheduling_plan->>'requiresHost')::boolean THEN
   PERFORM resource_error('resource_plan_completeness_violation');
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER a_resource_booking_attendance BEFORE INSERT OR UPDATE ON bookings
 FOR EACH ROW EXECUTE FUNCTION resource_guard_booking_attendance();
--> statement-breakpoint
-- Atomic requirement replacement may temporarily remove every row. Inspect the
-- committed definition, rather than rejecting a safe replacement halfway through.
CREATE FUNCTION resource_check_service_attendance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE eid uuid; e event_types%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='event_types' THEN eid:=NEW.id;
 ELSE eid:=CASE WHEN TG_OP='DELETE' THEN OLD.event_type_id ELSE NEW.event_type_id END; END IF;
 SELECT * INTO e FROM event_types WHERE id=eid;
 IF e.id IS NOT NULL AND NOT e.requires_host AND NOT EXISTS
   (SELECT 1 FROM event_type_resource_requirements WHERE event_type_id=eid)
   THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER resource_service_attendance_complete AFTER INSERT OR UPDATE ON event_types
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION resource_check_service_attendance();
CREATE CONSTRAINT TRIGGER resource_requirement_attendance_complete AFTER INSERT OR UPDATE OR DELETE ON event_type_resource_requirements
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION resource_check_service_attendance();

--> statement-breakpoint
CREATE OR REPLACE FUNCTION resource_guard_service() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
BEGIN
 IF NOT NEW.requires_host AND (NEW.scheduling_type<>'individual' OR NEW.max_attendees<>1 OR NEW.recurring_count<>1 OR NEW.owner_id IS NULL OR NEW.slug='__personal') THEN
  PERFORM resource_error('resource_plan_completeness_violation');
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
CREATE OR REPLACE FUNCTION resource_accept_plan(eid uuid, duration integer, fixed_host uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE AS $$
DECLARE e event_types%ROWTYPE; s schedules%ROWTYPE; host_zone text; business_zone text; required jsonb;
BEGIN
 SELECT * INTO e FROM event_types WHERE id=eid FOR SHARE;
 IF e.id IS NULL THEN PERFORM resource_error('resource_scope_violation'); END IF;
 IF e.scheduling_type<>'individual' OR e.owner_id IS DISTINCT FROM fixed_host OR e.max_attendees<>1 OR e.recurring_count<>1
    OR NOT e.is_active OR duration<=0 OR e.buffer_before_minutes<0 OR e.buffer_after_minutes<0 OR e.minimum_gap_minutes<0
    THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
 IF e.schedule_id IS NOT NULL THEN SELECT * INTO s FROM schedules WHERE id=e.schedule_id FOR SHARE;
 ELSE SELECT * INTO s FROM schedules WHERE user_id=e.owner_id AND is_default ORDER BY id LIMIT 1 FOR SHARE; END IF;
 IF s.id IS NULL OR s.user_id<>e.owner_id OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=s.timezone)
    THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
 SELECT timezone INTO host_zone FROM users WHERE id=fixed_host;
 SELECT business_timezone INTO business_zone FROM organizations WHERE id=e.organization_id;
 IF NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=host_zone) OR
    NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=business_zone) THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',r.id,'quantity',q.quantity,'name',r.name) ORDER BY r.id),'[]')
  INTO required FROM event_type_resource_requirements q JOIN resources r ON r.id=q.resource_id AND r.organization_id=q.organization_id WHERE q.event_type_id=e.id;
 IF NOT e.requires_host AND (e.resource_admission_epoch<=0 OR jsonb_array_length(required)=0) THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
 RETURN jsonb_build_object('version',1,'authority','current_configuration','organizationId',e.organization_id,'eventTypeId',e.id,
  'configurationRevision',e.resource_configuration_revision::text,'admissionEpoch',e.resource_admission_epoch::text,'resources',required,
  'requiresHost',e.requires_host,'requiredHostIds',CASE WHEN e.requires_host THEN jsonb_build_array(fixed_host) ELSE '[]'::jsonb END,'scheduleId',s.id,'scheduleOwnerId',s.user_id,
  'scheduleTimezone',s.timezone,'businessTimezone',business_zone,'capTimezone',CASE WHEN e.requires_host THEN host_zone ELSE business_zone END,'durationMinutes',duration,
  'bufferBeforeMinutes',e.buffer_before_minutes,'bufferAfterMinutes',e.buffer_after_minutes,'minimumGapMinutes',e.minimum_gap_minutes);
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
  IF TG_OP='INSERT' AND NOT e.requires_host AND e.resource_admission_epoch<=0 THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
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
     NEW.host_id::text IS DISTINCT FROM a.scheduling_plan->>'scheduleOwnerId' OR
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
CREATE OR REPLACE FUNCTION resource_guard_attempt() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE e event_types%ROWTYPE; expected jsonb;
BEGIN
 SELECT * INTO e FROM event_types WHERE id=NEW.event_type_id FOR SHARE;
 IF e.organization_id IS DISTINCT FROM NEW.organization_id THEN PERFORM resource_error('resource_scope_violation'); END IF;
 IF TG_OP='INSERT' THEN
  IF NOT e.requires_host AND e.resource_admission_epoch<=0 THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
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
