-- Inspection is advisory; the locked current state and database census decide.
SELECT resource_error('resource_plan_completeness_violation')
 WHERE NOT (:'readiness'::jsonb->>'ready')::boolean;
SELECT resource_error('resource_plan_completeness_violation')
 WHERE :'readiness'::jsonb->'configuration_snapshot' IS DISTINCT FROM :'reviewed_snapshot'::jsonb;
-- Existing SQL guards enforce the coherent historical booking/payment census.
-- Energy has no equipment and stays at epoch zero, with all its settings intact.
UPDATE event_types SET is_active=true,resource_admission_epoch=1
 WHERE organization_id=:'organization_id'::uuid
 AND id IN (:'light_service_id'::uuid,:'pemf_service_id'::uuid);
-- Resource-only plans retain the responsible owner and have no required person IDs.
-- Any failed proof rolls back both services; accepted bookings/plans/claims are untouched.
SELECT jsonb_build_object('activated',jsonb_agg(jsonb_build_object(
 'id',id,'requires_host',requires_host,'resource_admission_epoch',resource_admission_epoch,
 'resource_configuration_revision',resource_configuration_revision,
 'accepted_test_plan',resource_accept_plan(id,duration_minutes,owner_id)) ORDER BY id))
 FROM event_types WHERE organization_id=:'organization_id'::uuid
 AND id IN (:'light_service_id'::uuid,:'pemf_service_id'::uuid);
COMMIT;
