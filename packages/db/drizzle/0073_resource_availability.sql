ALTER TABLE "resources" ADD COLUMN "opening_hours" jsonb;
--> statement-breakpoint
-- Optional, resource-owned schedules. Reuse the weekly-rule/date-override
-- representation, without requiring or inventing a staff owner. PostgreSQL
-- resolves these wall-clock boundaries for both prediction and allocation.
CREATE FUNCTION resource_validate_opening_hours(hours jsonb) RETURNS void
LANGUAGE plpgsql STABLE AS $$
DECLARE w jsonb; date_value date;
BEGIN
 IF hours IS NULL THEN RETURN; END IF;
 IF jsonb_typeof(hours) IS DISTINCT FROM 'object' THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
 IF
    jsonb_typeof(hours->'timezone') IS DISTINCT FROM 'string' OR
    jsonb_typeof(hours->'rules') IS DISTINCT FROM 'array' OR
    jsonb_typeof(hours->'overrides') IS DISTINCT FROM 'array' OR
    NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=hours->>'timezone') OR
    EXISTS(SELECT 1 FROM jsonb_object_keys(hours) k WHERE k NOT IN ('timezone','rules','overrides'))
   THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
 FOR w IN SELECT value FROM jsonb_array_elements(hours->'rules') LOOP
  IF jsonb_typeof(w) IS DISTINCT FROM 'object' THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
  IF jsonb_typeof(w->'dayOfWeek') IS DISTINCT FROM 'number' OR
     (w->>'dayOfWeek') !~ '^[0-6]$' OR jsonb_typeof(w->'startTime') IS DISTINCT FROM 'string' OR jsonb_typeof(w->'endTime') IS DISTINCT FROM 'string' OR
     (w->>'startTime') !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:00)?$' OR
     (w->>'endTime') !~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)(:00)?$' OR
     EXISTS(SELECT 1 FROM jsonb_object_keys(w) k WHERE k NOT IN ('dayOfWeek','startTime','endTime'))
    THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
  IF (w->>'startTime')::time >= (w->>'endTime')::time THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
 END LOOP;
 FOR w IN SELECT value FROM jsonb_array_elements(hours->'overrides') LOOP
  IF jsonb_typeof(w) IS DISTINCT FROM 'object' THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
  IF jsonb_typeof(w->'date') IS DISTINCT FROM 'string' OR
     (w->>'date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR NOT (w ? 'startTime' AND w ? 'endTime') OR
     EXISTS(SELECT 1 FROM jsonb_object_keys(w) k WHERE k NOT IN ('date','startTime','endTime'))
    THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
  BEGIN date_value:=(w->>'date')::date;
  EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
   PERFORM resource_error('resource_plan_completeness_violation'); END;
  IF to_char(date_value,'YYYY-MM-DD')<>w->>'date' THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
  IF w->>'startTime' IS NULL AND w->>'endTime' IS NULL THEN CONTINUE; END IF;
  IF jsonb_typeof(w->'startTime') IS DISTINCT FROM 'string' OR jsonb_typeof(w->'endTime') IS DISTINCT FROM 'string' OR
     (w->>'startTime') !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:00)?$' OR
     (w->>'endTime') !~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)(:00)?$'
    THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
  IF (w->>'startTime')::time >= (w->>'endTime')::time THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(hours->'overrides') AS o(value) GROUP BY o.value->>'date' HAVING count(*)>1)
  THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION resource_guard_opening_hours() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN PERFORM resource_validate_opening_hours(NEW.opening_hours);
 ELSIF NEW.opening_hours IS DISTINCT FROM OLD.opening_hours THEN PERFORM resource_validate_opening_hours(NEW.opening_hours); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER resource_opening_hours_guard BEFORE INSERT OR UPDATE ON resources
 FOR EACH ROW EXECUTE FUNCTION resource_guard_opening_hours();
--> statement-breakpoint
CREATE FUNCTION resource_open_windows(hours jsonb, a timestamptz, b timestamptz)
RETURNS SETOF tstzrange LANGUAGE plpgsql STABLE AS $$
BEGIN
 IF (isfinite(a) AND isfinite(b) AND b>a) IS NOT TRUE THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
 PERFORM resource_validate_opening_hours(hours);
 IF hours IS NULL THEN RETURN NEXT tstzrange(a,b,'[)'); RETURN; END IF;
 RETURN QUERY
 WITH days AS (
  SELECT d::date AS day FROM generate_series(
   (a AT TIME ZONE (hours->>'timezone'))::date::timestamp,
   (b AT TIME ZONE (hours->>'timezone'))::date::timestamp,interval '1 day') d
 ), chosen AS (
  SELECT day,w FROM days CROSS JOIN LATERAL jsonb_array_elements(hours->'overrides') w
   WHERE w->>'date'=day::text AND w->>'startTime' IS NOT NULL
  UNION ALL
  SELECT day,w FROM days CROSS JOIN LATERAL jsonb_array_elements(hours->'rules') w
   WHERE (w->>'dayOfWeek')::integer=extract(dow FROM day)
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(hours->'overrides') o WHERE o->>'date'=day::text)
 ), bounds AS (
  SELECT (day+(w->>'startTime')::time) AT TIME ZONE (hours->>'timezone') AS lo,
         (day+(w->>'endTime')::time) AT TIME ZONE (hours->>'timezone') AS hi FROM chosen
 ) SELECT tstzrange(lo,hi,'[)') FROM bounds WHERE hi>lo AND lo<b AND hi>a;
END $$;
--> statement-breakpoint
CREATE FUNCTION resource_open_during(hours jsonb,a timestamptz,b timestamptz)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce(range_agg(w) @> tstzrange(a,b,'[)'),false)
 FROM resource_open_windows(hours,a,b) w;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION resource_guard_claim() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
 -- Only INSERTs must match the current allocation. Release UPDATEs above
 -- retain the old revision/interval while a replacement is in progress.
 SELECT x INTO item FROM jsonb_array_elements(b.scheduling_plan->'resources') x WHERE x->>'id'=r.id::text;
 occupied:=resource_occupied_interval(b.starts_at,b.ends_at,b.scheduling_plan);
 IF item IS NULL OR
    NEW.quantity IS DISTINCT FROM (item->>'quantity')::integer OR
    NEW.configuration_revision IS DISTINCT FROM (b.scheduling_plan->>'configurationRevision')::bigint OR
    NEW.allocation_revision IS DISTINCT FROM b.allocation_revision OR
    NEW.starts_at IS DISTINCT FROM lower(occupied) OR NEW.ends_at IS DISTINCT FROM upper(occupied) OR
    NEW.resource_name IS DISTINCT FROM item->>'name' OR NEW.capacity_at_allocation IS DISTINCT FROM r.capacity
   THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
 IF b.allocation_revision>1 THEN
  SELECT * INTO p FROM booking_resource_claims WHERE id=NEW.predecessor_id;
  IF (p.booking_id,p.resource_id,p.allocation_revision,p.release_reason) IS DISTINCT FROM
     (b.id,r.id,b.allocation_revision-1,'rescheduled'::text) OR p.released_at IS NULL THEN PERFORM resource_error('resource_claim_lifecycle_violation'); END IF;
 ELSIF NEW.predecessor_id IS NOT NULL THEN PERFORM resource_error('resource_claim_lifecycle_violation'); END IF;
 -- An already present current/revision claim is not a new capacity candidate.
 -- Old released predecessor revisions remain legal during replacement.
 IF EXISTS(SELECT 1 FROM booking_resource_claims WHERE booking_id=b.id AND resource_id=r.id
     AND (allocation_revision=NEW.allocation_revision OR released_at IS NULL))
   THEN PERFORM resource_error('resource_plan_completeness_violation'); END IF;
 IF NEW.source IS NULL OR length(NEW.source)=0 THEN PERFORM resource_error('resource_claim_lifecycle_violation'); END IF;
 -- Expected scheduling diagnostics apply only to a structurally valid claim.
 IF NOT r.enabled THEN PERFORM resource_error('resource_disabled'); END IF;
 IF NOT resource_open_during(r.opening_hours,NEW.starts_at,NEW.ends_at) THEN PERFORM resource_error('resource_closed'); END IF;
 IF resource_peak(r.id,NEW.starts_at,NEW.ends_at)+NEW.quantity>r.capacity THEN PERFORM resource_error('resource_capacity_conflict','23P01'); END IF;
 -- Final-set completeness remains deferred on BOTH bookings and claims.
 RETURN NEW;
END $$;
