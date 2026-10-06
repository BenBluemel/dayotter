-- ONE-WAY DATA MUTATION. Only the separately authorized operator runs this.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
-- Service gates first, ordered including Energy, then the complete resource union.
SELECT id FROM event_types WHERE organization_id=:'organization_id'::uuid
 AND id IN (:'energy_service_id'::uuid,:'light_service_id'::uuid,:'pemf_service_id'::uuid)
 ORDER BY id FOR UPDATE;
SELECT r.id FROM resources r WHERE r.id IN (
 SELECT resource_id FROM event_type_resource_requirements
 WHERE organization_id=:'organization_id'::uuid AND event_type_id IN (:'energy_service_id'::uuid,:'light_service_id'::uuid,:'pemf_service_id'::uuid)
) ORDER BY r.id FOR SHARE;
-- Hold selected schedule definitions stable through the final plan proof.
SELECT s.id FROM schedules s WHERE s.id IN (
 SELECT coalesce(e.schedule_id,(SELECT id FROM schedules WHERE user_id=e.owner_id AND is_default ORDER BY id LIMIT 1))
 FROM event_types e WHERE e.organization_id=:'organization_id'::uuid
 AND e.id IN (:'energy_service_id'::uuid,:'light_service_id'::uuid,:'pemf_service_id'::uuid)
) ORDER BY s.id FOR SHARE;
