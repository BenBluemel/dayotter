-- Correct 0070 diagnostic ordering without changing its schema, fences or
-- deferred final-set validation. Existing applied databases replace only this
-- trigger function; no booking writer or resource admission is activated.
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
 IF resource_peak(r.id,NEW.starts_at,NEW.ends_at)+NEW.quantity>r.capacity THEN PERFORM resource_error('resource_capacity_conflict','23P01'); END IF;
 -- Final-set completeness remains deferred on BOTH bookings and claims.
 RETURN NEW;
END $$;
