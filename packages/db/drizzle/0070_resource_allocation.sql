CREATE TABLE "booking_resource_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_type_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"configuration_revision" bigint NOT NULL,
	"allocation_revision" bigint NOT NULL,
	"quantity" integer NOT NULL,
	"resource_name" text NOT NULL,
	"capacity_at_allocation" integer NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"allocated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"source" text NOT NULL,
	"predecessor_id" uuid,
	"released_at" timestamp with time zone,
	"release_reason" text,
	CONSTRAINT "resource_claim_shape_check" CHECK ("booking_resource_claims"."quantity" > 0 AND "booking_resource_claims"."capacity_at_allocation" >= "booking_resource_claims"."quantity" AND "booking_resource_claims"."configuration_revision" > 0 AND "booking_resource_claims"."allocation_revision" > 0 AND isfinite("booking_resource_claims"."starts_at") AND isfinite("booking_resource_claims"."ends_at") AND "booking_resource_claims"."ends_at" > "booking_resource_claims"."starts_at" AND isfinite("booking_resource_claims"."allocated_at") AND length("booking_resource_claims"."source") > 0 AND (("booking_resource_claims"."released_at" IS NULL AND "booking_resource_claims"."release_reason" IS NULL) OR ("booking_resource_claims"."released_at" IS NOT NULL AND isfinite("booking_resource_claims"."released_at") AND "booking_resource_claims"."release_reason" IN ('cancelled','rejected','rescheduled'))))
);
--> statement-breakpoint
CREATE TABLE "event_type_resource_requirements" (
	"organization_id" uuid NOT NULL,
	"event_type_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resource_requirement_quantity_check" CHECK ("event_type_resource_requirements"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"capacity" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"allocation_version" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resources_shape_check" CHECK (length(btrim("resources"."name")) > 0 AND "resources"."capacity" > 0 AND "resources"."allocation_version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "event_types" ADD COLUMN "resource_configuration_revision" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "event_types" ADD COLUMN "resource_admission_epoch" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "event_types" ADD COLUMN "requires_host" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "scheduling_plan" jsonb;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "allocation_revision" bigint;--> statement-breakpoint
CREATE UNIQUE INDEX "resources_id_org_idx" ON "resources" USING btree ("id","organization_id");--> statement-breakpoint
ALTER TABLE "booking_resource_claims" ADD CONSTRAINT "booking_resource_claims_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_resource_claims" ADD CONSTRAINT "resource_claim_booking_scope_fk" FOREIGN KEY ("booking_id","organization_id","event_type_id") REFERENCES "public"."bookings"("id","organization_id","event_type_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_resource_claims" ADD CONSTRAINT "resource_claim_resource_scope_fk" FOREIGN KEY ("resource_id","organization_id") REFERENCES "public"."resources"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_resource_claims" ADD CONSTRAINT "resource_claim_predecessor_fk" FOREIGN KEY ("predecessor_id") REFERENCES "public"."booking_resource_claims"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_type_resource_requirements" ADD CONSTRAINT "resource_requirement_service_scope_fk" FOREIGN KEY ("event_type_id","organization_id") REFERENCES "public"."event_types"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_type_resource_requirements" ADD CONSTRAINT "resource_requirement_resource_scope_fk" FOREIGN KEY ("resource_id","organization_id") REFERENCES "public"."resources"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "resource_claim_revision_idx" ON "booking_resource_claims" USING btree ("booking_id","resource_id","allocation_revision");--> statement-breakpoint
CREATE UNIQUE INDEX "resource_claim_active_idx" ON "booking_resource_claims" USING btree ("booking_id","resource_id") WHERE "booking_resource_claims"."released_at" IS NULL;--> statement-breakpoint
CREATE INDEX "resource_claim_range_idx" ON "booking_resource_claims" USING gist ("resource_id",tstzrange("starts_at", "ends_at", '[)')) WHERE "booking_resource_claims"."released_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "resource_requirement_event_resource_idx" ON "event_type_resource_requirements" USING btree ("event_type_id","resource_id");--> statement-breakpoint

-- R1 is inert for existing writers. Epoch activation and adoption deliberately
-- have no enabled path until the coordinated writer/lifecycle cutover.
CREATE FUNCTION resource_error(identity text, state text DEFAULT '23514') RETURNS void
LANGUAGE plpgsql VOLATILE AS $$ BEGIN
 RAISE EXCEPTION 'Resource scheduling rejected the operation' USING ERRCODE=state, CONSTRAINT=identity;
END $$;
--> statement-breakpoint
CREATE FUNCTION resource_occupied_interval(a timestamptz, b timestamptz, plan jsonb)
RETURNS tstzrange LANGUAGE plpgsql IMMUTABLE AS $$ BEGIN
 IF NOT (isfinite(a) AND isfinite(b) AND b>a AND
   (plan->>'bufferBeforeMinutes')::integer >= 0 AND (plan->>'bufferAfterMinutes')::integer >= 0) IS TRUE THEN
   PERFORM resource_error('resource_plan_completeness_violation');
 END IF;
 RETURN tstzrange(a - (plan->>'bufferBeforeMinutes')::integer * interval '1 minute',
                 b + (plan->>'bufferAfterMinutes')::integer * interval '1 minute', '[)');
END $$;
--> statement-breakpoint
-- VOLATILE is intentional: each post-fence query obtains a fresh RC snapshot.
CREATE FUNCTION resource_peak(rid uuid, a timestamptz, b timestamptz, excluding_booking uuid DEFAULT NULL)
RETURNS numeric LANGUAGE sql VOLATILE AS $$
 WITH endpoints AS (
  SELECT greatest(starts_at,a) AS at, quantity::numeric AS delta FROM booking_resource_claims
   WHERE resource_id=rid AND released_at IS NULL AND starts_at<b AND ends_at>a
    AND (excluding_booking IS NULL OR booking_id<>excluding_booking)
  UNION ALL
  SELECT least(ends_at,b), -quantity::numeric FROM booking_resource_claims
   WHERE resource_id=rid AND released_at IS NULL AND starts_at<b AND ends_at>a
    AND (excluding_booking IS NULL OR booking_id<>excluding_booking)
 ), grouped AS (SELECT at,sum(delta) AS delta FROM endpoints GROUP BY at),
 loads AS (SELECT sum(delta) OVER (ORDER BY at) AS demand FROM grouped)
 SELECT coalesce(max(demand),0) FROM loads;
$$;
--> statement-breakpoint
CREATE FUNCTION resource_fence(ids uuid[]) RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE rid uuid;
BEGIN
 FOR rid IN SELECT DISTINCT unnest(ids) ORDER BY 1 LOOP
  PERFORM 1 FROM resources WHERE id=rid FOR NO KEY UPDATE;
  IF NOT FOUND THEN PERFORM resource_error('resource_scope_violation'); END IF;
  UPDATE resources SET allocation_version=allocation_version+1 WHERE id=rid;
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION resource_guard_resource() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE instant timestamptz;
BEGIN
 IF TG_OP='DELETE' THEN PERFORM resource_error('resource_claim_lifecycle_violation'); END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.allocation_version<>0 THEN PERFORM resource_error('resource_claim_lifecycle_violation'); END IF;
 ELSE
  IF (NEW.id,NEW.organization_id,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.created_at)
    THEN PERFORM resource_error('resource_scope_violation'); END IF;
  -- UPDATE already owns the resource row fence. Never take service/booking locks.
  NEW.allocation_version:=OLD.allocation_version+1;
  NEW.updated_at:=clock_timestamp();
  IF NEW.enabled AND EXISTS(SELECT 1 FROM event_type_resource_requirements WHERE resource_id=NEW.id AND quantity>NEW.capacity) THEN PERFORM resource_error('resource_capacity_conflict','23P01'); END IF;
  IF NEW.capacity<OLD.capacity THEN
   instant:=clock_timestamp();
   IF resource_peak(NEW.id,instant,'infinity')>NEW.capacity
     THEN PERFORM resource_error('resource_capacity_conflict','23P01'); END IF;
  END IF;
 END IF;
 IF NEW.allocation_version>9007199254740991 THEN PERFORM resource_error('resource_claim_lifecycle_violation'); END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER resource_identity_guard BEFORE INSERT OR UPDATE OR DELETE ON resources
 FOR EACH ROW EXECUTE FUNCTION resource_guard_resource();
--> statement-breakpoint
CREATE FUNCTION resource_guard_service() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
BEGIN
 IF NEW.resource_admission_epoch<>0 OR NOT NEW.requires_host THEN
  PERFORM resource_error('resource_plan_completeness_violation'); -- cutover unavailable in R1
 END IF;
 IF TG_OP='INSERT' THEN
  NEW.resource_configuration_revision:=1;
 ELSE
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id AND EXISTS(SELECT 1 FROM bookings WHERE event_type_id=OLD.id AND scheduling_plan IS NOT NULL) THEN PERFORM resource_error('resource_scope_violation'); END IF;
  IF (to_jsonb(NEW)-ARRAY['updated_at','resource_configuration_revision']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['updated_at','resource_configuration_revision']) OR
      NEW.resource_configuration_revision IS DISTINCT FROM OLD.resource_configuration_revision THEN
   -- Explicit lock strength; callers editing requirements take this before resources.
   PERFORM 1 FROM event_types WHERE id=OLD.id FOR UPDATE;
   NEW.resource_configuration_revision:=OLD.resource_configuration_revision+1;
  END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM event_type_resource_requirements WHERE event_type_id=NEW.id) AND
   (NEW.scheduling_type<>'individual' OR NEW.max_attendees<>1 OR NEW.recurring_count<>1 OR NEW.owner_id IS NULL) THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
 IF NEW.resource_configuration_revision>9007199254740991 THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER resource_service_revision_guard BEFORE INSERT OR UPDATE ON event_types
 FOR EACH ROW EXECUTE FUNCTION resource_guard_service();
--> statement-breakpoint
CREATE FUNCTION resource_guard_requirement() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE eid uuid; ids uuid[]; r resources%ROWTYPE; e event_types%ROWTYPE;
BEGIN
 eid:=CASE WHEN TG_OP='DELETE' THEN OLD.event_type_id ELSE NEW.event_type_id END;
 IF TG_OP='UPDATE' AND (NEW.organization_id,NEW.event_type_id) IS DISTINCT FROM (OLD.organization_id,OLD.event_type_id)
   THEN PERFORM resource_error('resource_scope_violation'); END IF;
 SELECT * INTO e FROM event_types WHERE id=eid FOR UPDATE;
 IF e.id IS NULL OR e.organization_id IS DISTINCT FROM (CASE WHEN TG_OP='DELETE' THEN OLD.organization_id ELSE NEW.organization_id END)
   THEN PERFORM resource_error('resource_scope_violation'); END IF;
 IF e.scheduling_type<>'individual' OR e.max_attendees<>1 OR e.recurring_count<>1 OR e.owner_id IS NULL
   THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
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
CREATE TRIGGER resource_requirement_guard BEFORE INSERT OR UPDATE OR DELETE ON event_type_resource_requirements
 FOR EACH ROW EXECUTE FUNCTION resource_guard_requirement();
--> statement-breakpoint
CREATE FUNCTION resource_accept_plan(eid uuid, duration integer, fixed_host uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE AS $$
DECLARE e event_types%ROWTYPE; s schedules%ROWTYPE; host_zone text; business_zone text; required jsonb;
BEGIN
 SELECT * INTO e FROM event_types WHERE id=eid FOR SHARE;
 IF e.id IS NULL THEN PERFORM resource_error('resource_scope_violation'); END IF;
 IF e.scheduling_type<>'individual' OR e.owner_id IS DISTINCT FROM fixed_host OR e.max_attendees<>1 OR e.recurring_count<>1
    OR NOT e.requires_host OR NOT e.is_active OR duration<=0 OR e.buffer_before_minutes<0 OR e.buffer_after_minutes<0 OR e.minimum_gap_minutes<0
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
 RETURN jsonb_build_object('version',1,'authority','current_configuration','organizationId',e.organization_id,'eventTypeId',e.id,
  'configurationRevision',e.resource_configuration_revision::text,'admissionEpoch',e.resource_admission_epoch::text,'resources',required,
  'requiresHost',true,'requiredHostIds',jsonb_build_array(fixed_host),'scheduleId',s.id,'scheduleOwnerId',s.user_id,
  'scheduleTimezone',s.timezone,'businessTimezone',business_zone,'capTimezone',host_zone,'durationMinutes',duration,
  'bufferBeforeMinutes',e.buffer_before_minutes,'bufferAfterMinutes',e.buffer_after_minutes,'minimumGapMinutes',e.minimum_gap_minutes);
END $$;
--> statement-breakpoint
CREATE FUNCTION resource_guard_booking() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE expected jsonb;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.scheduling_plan IS NOT NULL THEN PERFORM resource_error('resource_claim_lifecycle_violation'); END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND OLD.scheduling_plan IS DISTINCT FROM NEW.scheduling_plan THEN
  -- No raw NULL->managed adoption and no rewriting accepted custody, even with flags.
  PERFORM resource_error('resource_plan_completeness_violation');
 END IF;
 IF NEW.scheduling_plan IS NULL THEN
  IF NEW.allocation_revision IS NOT NULL THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='INSERT' THEN
  expected:=resource_accept_plan(NEW.event_type_id,(NEW.scheduling_plan->>'durationMinutes')::integer,NEW.host_id);
  IF NEW.scheduling_plan IS DISTINCT FROM expected OR NEW.allocation_revision IS DISTINCT FROM 1 OR NEW.recurrence_uid IS NOT NULL
    OR NEW.status NOT IN ('pending','confirmed') THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
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
CREATE TRIGGER resource_booking_identity_guard BEFORE INSERT OR UPDATE OR DELETE ON bookings
 FOR EACH ROW EXECUTE FUNCTION resource_guard_booking();
--> statement-breakpoint
CREATE FUNCTION resource_guard_claim() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE b bookings%ROWTYPE; r resources%ROWTYPE; p booking_resource_claims%ROWTYPE; occupied tstzrange; item jsonb; ids uuid[];
BEGIN
 IF TG_OP='DELETE' THEN PERFORM resource_error('resource_claim_lifecycle_violation'); END IF;
 SELECT * INTO b FROM bookings WHERE id=NEW.booking_id; -- NO higher-order lock here
 IF b.scheduling_plan IS NULL THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
 SELECT array_agg((x->>'id')::uuid ORDER BY (x->>'id')::uuid) INTO ids FROM jsonb_array_elements(b.scheduling_plan->'resources') x;
 -- Entire accepted set plus the submitted ID: even malformed direct SQL is fenced.
 PERFORM resource_fence(array_append(ids,NEW.resource_id));
 SELECT * INTO r FROM resources WHERE id=NEW.resource_id;
 IF (NEW.organization_id,NEW.event_type_id) IS DISTINCT FROM (b.organization_id,b.event_type_id) OR
    r.organization_id IS DISTINCT FROM NEW.organization_id THEN PERFORM resource_error('resource_scope_violation'); END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['released_at','release_reason']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['released_at','release_reason']) OR
     (OLD.released_at IS NOT NULL AND (NEW.released_at,NEW.release_reason) IS DISTINCT FROM (OLD.released_at,OLD.release_reason)) OR
     NEW.released_at IS NULL OR NEW.release_reason IS NULL THEN PERFORM resource_error('resource_claim_lifecycle_violation'); END IF;
  IF OLD.released_at IS NULL AND NOT (
    (NEW.release_reason IN ('cancelled','rejected') AND b.status::text=NEW.release_reason) OR
    (NEW.release_reason='rescheduled' AND b.status IN ('pending','confirmed') AND b.allocation_revision=OLD.allocation_revision+1)
   ) THEN PERFORM resource_error('resource_claim_lifecycle_violation'); END IF;
  IF OLD.released_at IS NULL THEN NEW.released_at:=clock_timestamp(); END IF;
  RETURN NEW;
 END IF;
 NEW.allocated_at:=clock_timestamp();
 IF NEW.released_at IS NOT NULL OR NEW.release_reason IS NOT NULL OR b.status NOT IN ('pending','confirmed') THEN PERFORM resource_error('resource_claim_lifecycle_violation'); END IF;
 IF NOT r.enabled THEN PERFORM resource_error('resource_disabled'); END IF;
 -- Copied facts come from immutable plan / freshly locked resource, never caller assertions.
 SELECT x INTO item FROM jsonb_array_elements(b.scheduling_plan->'resources') x WHERE x->>'id'=r.id::text;
 IF NEW.resource_name IS DISTINCT FROM coalesce(item->>'name',r.name) OR NEW.capacity_at_allocation IS DISTINCT FROM r.capacity THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
 occupied:=resource_occupied_interval(b.starts_at,b.ends_at,b.scheduling_plan);
 IF resource_peak(r.id,NEW.starts_at,NEW.ends_at)+NEW.quantity>r.capacity THEN PERFORM resource_error('resource_capacity_conflict','23P01'); END IF;
 IF b.allocation_revision>1 THEN
  SELECT * INTO p FROM booking_resource_claims WHERE id=NEW.predecessor_id;
  IF (p.booking_id,p.resource_id,p.allocation_revision,p.release_reason) IS DISTINCT FROM
     (b.id,r.id,b.allocation_revision-1,'rescheduled'::text) OR p.released_at IS NULL THEN PERFORM resource_error('resource_claim_lifecycle_violation'); END IF;
 ELSIF NEW.predecessor_id IS NOT NULL THEN PERFORM resource_error('resource_claim_lifecycle_violation'); END IF;
 -- Quantity/interval/revision completeness is intentionally checked on final state.
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER resource_claim_identity_guard BEFORE INSERT OR UPDATE OR DELETE ON booking_resource_claims
 FOR EACH ROW EXECUTE FUNCTION resource_guard_claim();
--> statement-breakpoint
CREATE FUNCTION resource_check_complete() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE bid uuid; b bookings%ROWTYPE; occupied tstzrange; bad boolean;
BEGIN
 IF TG_TABLE_NAME='bookings' THEN bid:=NEW.id; ELSE bid:=CASE WHEN TG_OP='DELETE' THEN OLD.booking_id ELSE NEW.booking_id END; END IF;
 SELECT * INTO b FROM bookings WHERE id=bid;
 IF b.scheduling_plan IS NULL THEN
  IF EXISTS(SELECT 1 FROM booking_resource_claims WHERE booking_id=bid) THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
  RETURN NULL;
 END IF;
 occupied:=resource_occupied_interval(b.starts_at,b.ends_at,b.scheduling_plan);
 IF b.status IN ('cancelled','rejected') THEN
  IF EXISTS(SELECT 1 FROM booking_resource_claims WHERE booking_id=bid AND released_at IS NULL) THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
 ELSE
  SELECT EXISTS (
   SELECT 1 FROM jsonb_array_elements(b.scheduling_plan->'resources') x
   FULL JOIN (SELECT * FROM booking_resource_claims WHERE booking_id=bid AND released_at IS NULL) c ON c.resource_id::text=x->>'id'
   WHERE x IS NULL OR c.id IS NULL OR c.quantity IS DISTINCT FROM (x->>'quantity')::integer OR
    c.organization_id<>b.organization_id OR c.event_type_id<>b.event_type_id OR
    c.configuration_revision IS DISTINCT FROM (b.scheduling_plan->>'configurationRevision')::bigint OR c.allocation_revision IS DISTINCT FROM b.allocation_revision OR
    c.starts_at IS DISTINCT FROM lower(occupied) OR c.ends_at IS DISTINCT FROM upper(occupied)
  ) INTO bad;
  IF bad THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
 END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER resource_booking_complete AFTER INSERT OR UPDATE ON bookings
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION resource_check_complete();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER resource_claim_complete AFTER INSERT OR UPDATE OR DELETE ON booking_resource_claims
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION resource_check_complete();
--> statement-breakpoint
-- These helpers deliberately acquire NO service/booking/payment/financial locks.
-- Callers must have done higher-order admission and tentative host-index writes.
CREATE FUNCTION resource_allocate_booking(bid uuid, allocation_source text, actor uuid DEFAULT NULL) RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE b bookings%ROWTYPE; ids uuid[]; x jsonb; r resources%ROWTYPE; occupied tstzrange; previous uuid;
BEGIN
 SELECT * INTO b FROM bookings WHERE id=bid;
 IF b.scheduling_plan IS NULL OR b.status NOT IN ('pending','confirmed') THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
 IF EXISTS(SELECT 1 FROM booking_resource_claims WHERE booking_id=bid AND released_at IS NULL AND allocation_revision=b.allocation_revision)
    THEN RETURN; END IF;
 SELECT array_agg((v->>'id')::uuid) INTO ids FROM jsonb_array_elements(b.scheduling_plan->'resources') v;
 PERFORM resource_fence(ids);
 occupied:=resource_occupied_interval(b.starts_at,b.ends_at,b.scheduling_plan);
 -- Validate the COMPLETE destination before releasing any previous revision.
 FOR x IN SELECT * FROM jsonb_array_elements(b.scheduling_plan->'resources') ORDER BY value->>'id' LOOP
  SELECT * INTO r FROM resources WHERE id=(x->>'id')::uuid;
  IF NOT r.enabled THEN PERFORM resource_error('resource_disabled'); END IF;
  IF resource_peak(r.id,lower(occupied),upper(occupied),b.id)+(x->>'quantity')::integer>r.capacity THEN PERFORM resource_error('resource_capacity_conflict','23P01'); END IF;
 END LOOP;

 UPDATE booking_resource_claims SET released_at=clock_timestamp(),release_reason='rescheduled' WHERE booking_id=bid AND released_at IS NULL;
 FOR x IN SELECT * FROM jsonb_array_elements(b.scheduling_plan->'resources') ORDER BY value->>'id' LOOP
  SELECT * INTO r FROM resources WHERE id=(x->>'id')::uuid;
  SELECT id INTO previous FROM booking_resource_claims WHERE booking_id=bid AND resource_id=r.id AND allocation_revision=b.allocation_revision-1;
  INSERT INTO booking_resource_claims(organization_id,event_type_id,booking_id,resource_id,configuration_revision,allocation_revision,quantity,resource_name,capacity_at_allocation,starts_at,ends_at,source,actor_user_id,predecessor_id)
  VALUES(b.organization_id,b.event_type_id,b.id,r.id,(b.scheduling_plan->>'configurationRevision')::bigint,b.allocation_revision,(x->>'quantity')::integer,x->>'name',r.capacity,lower(occupied),upper(occupied),allocation_source,actor,previous);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION resource_release_booking(bid uuid) RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE b bookings%ROWTYPE; ids uuid[];
BEGIN
 SELECT * INTO b FROM bookings WHERE id=bid;
 IF b.scheduling_plan IS NULL OR b.status NOT IN ('cancelled','rejected') THEN PERFORM resource_error('resource_claim_lifecycle_violation'); END IF;
 SELECT array_agg((v->>'id')::uuid) INTO ids FROM jsonb_array_elements(b.scheduling_plan->'resources') v;
 PERFORM resource_fence(ids);
 UPDATE booking_resource_claims SET released_at=clock_timestamp(),release_reason=b.status::text WHERE booking_id=bid AND released_at IS NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION resource_guard_schedule_history() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM bookings WHERE scheduling_plan->>'scheduleId'=OLD.id::text) THEN PERFORM resource_error('resource_claim_lifecycle_violation'); END IF;
 RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER resource_schedule_history_guard BEFORE DELETE ON schedules FOR EACH ROW EXECUTE FUNCTION resource_guard_schedule_history();
--> statement-breakpoint
-- Atomic configuration replacement: service lock FIRST, complete old/new union
-- fenced BEFORE row changes. Per-row guards also protect direct SQL mutations.
CREATE FUNCTION resource_set_requirements(eid uuid, desired jsonb) RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE e event_types%ROWTYPE; ids uuid[]; x jsonb;
BEGIN
 SELECT * INTO e FROM event_types WHERE id=eid FOR UPDATE;
 IF e.id IS NULL THEN PERFORM resource_error('resource_scope_violation'); END IF;
 IF jsonb_typeof(desired) IS DISTINCT FROM 'array' OR EXISTS (
  SELECT 1 FROM jsonb_array_elements(desired) v GROUP BY v->>'id' HAVING count(*)>1)
  THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
 SELECT array_agg(DISTINCT id) INTO ids FROM (
  SELECT resource_id AS id FROM event_type_resource_requirements WHERE event_type_id=eid
  UNION SELECT (v->>'id')::uuid FROM jsonb_array_elements(desired) v
 ) all_ids;
 PERFORM resource_fence(ids);
 DELETE FROM event_type_resource_requirements WHERE event_type_id=eid;
 FOR x IN SELECT * FROM jsonb_array_elements(desired) ORDER BY value->>'id' LOOP
  INSERT INTO event_type_resource_requirements(organization_id,event_type_id,resource_id,quantity)
   VALUES(e.organization_id,e.id,(x->>'id')::uuid,(x->>'quantity')::integer);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION resource_guard_truncate_history() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$ BEGIN
 PERFORM resource_error('resource_claim_lifecycle_violation'); RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER resource_no_truncate BEFORE TRUNCATE ON resources
 FOR EACH STATEMENT EXECUTE FUNCTION resource_guard_truncate_history();
--> statement-breakpoint
CREATE TRIGGER resource_claim_no_truncate BEFORE TRUNCATE ON booking_resource_claims
 FOR EACH STATEMENT EXECUTE FUNCTION resource_guard_truncate_history();
