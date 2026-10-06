-- Shared, side-effect-free state query. No Redis or provider state is inferred.
-- Names are presentation only; exact UUIDs, expected policies and mappings bind review.
WITH targets(role,id,requires_host,resource_id) AS (
 VALUES ('energy',:'energy_service_id'::uuid,true,NULL::uuid),
 ('light',:'light_service_id'::uuid,:'light_requires_host'::boolean,:'light_resource_id'::uuid),
 ('pemf',:'pemf_service_id'::uuid,:'pemf_requires_host'::boolean,:'pemf_resource_id'::uuid)
), definitions AS (
 SELECT t.role,t.resource_id,e.id,e.owner_id,
 jsonb_build_object('role',t.role,'service',to_jsonb(e)-'access_code_hash',
  'owner_timezone',u.timezone,'schedule',to_jsonb(s),
  'rules',coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM availability_rules a WHERE a.schedule_id=s.id),'[]'::jsonb),
  'overrides',coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM date_overrides a WHERE a.schedule_id=s.id),'[]'::jsonb),
  'requirements',coalesce((SELECT jsonb_agg(to_jsonb(q) ORDER BY q.resource_id) FROM event_type_resource_requirements q WHERE q.event_type_id=e.id),'[]'::jsonb)) AS configuration,
 array_remove(ARRAY[
  CASE WHEN e.id IS NULL THEN 'service_not_in_organization' END,
  CASE WHEN e.requires_host IS DISTINCT FROM t.requires_host THEN 'unexpected_attendance_policy' END,
  CASE WHEN e.resource_admission_epoch IS DISTINCT FROM CASE WHEN t.role='energy' THEN 0 ELSE :'expected_resource_epoch'::bigint END THEN 'unexpected_admission_epoch' END,
  CASE WHEN t.role<>'energy' AND :'expected_resource_epoch'::bigint=1 AND NOT e.is_active THEN 'activated_service_disabled' END,
  CASE WHEN e.owner_id IS NULL OR NOT EXISTS(SELECT 1 FROM memberships WHERE organization_id=e.organization_id AND user_id=e.owner_id) THEN 'responsible_owner_not_member' END,
  CASE WHEN e.scheduling_type<>'individual' OR e.max_attendees<>1 OR e.recurring_count<>1 OR e.slug='__personal' THEN 'unsupported_service_mode' END,
  CASE WHEN e.duration_minutes<=0 OR coalesce(e.slot_interval_minutes,e.duration_minutes)<=0 OR e.buffer_before_minutes<0 OR e.buffer_after_minutes<0 OR e.minimum_gap_minutes<0 THEN 'invalid_duration_cadence_or_buffers' END,
  CASE WHEN s.id IS NULL OR s.user_id IS DISTINCT FROM e.owner_id OR (e.schedule_id IS NULL AND (SELECT count(*) FROM schedules WHERE user_id=e.owner_id AND is_default)<>1) THEN 'invalid_owned_schedule' END,
  CASE WHEN NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=s.timezone) OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=u.timezone) THEN 'invalid_timezone' END,
  CASE WHEN t.role='energy' AND EXISTS(SELECT 1 FROM event_type_resource_requirements WHERE event_type_id=e.id) THEN 'energy_must_remain_person_only' END,
  CASE WHEN t.role<>'energy' AND ((SELECT count(*) FROM event_type_resource_requirements WHERE event_type_id=e.id)<>1 OR NOT EXISTS(SELECT 1 FROM event_type_resource_requirements WHERE event_type_id=e.id AND organization_id=e.organization_id AND resource_id=t.resource_id AND quantity=1)) THEN 'unexpected_equipment_requirement' END
 ],NULL) AS issues,
 CASE WHEN t.role<>'energy' THEN resource_incompatible_commitments(e.id) ELSE false END AS activation_blocked
 FROM targets t LEFT JOIN event_types e ON e.id=t.id AND e.organization_id=:'organization_id'::uuid
 LEFT JOIN users u ON u.id=e.owner_id
 LEFT JOIN LATERAL (SELECT * FROM schedules WHERE id=e.schedule_id OR (e.schedule_id IS NULL AND user_id=e.owner_id AND is_default) ORDER BY id LIMIT 1) s ON true
), equipment AS (
 SELECT r.*,resource_validate_opening_hours(r.opening_hours) AS validated_hours,q.event_type_id,q.quantity,q.organization_id AS requirement_organization
 FROM event_type_resource_requirements q JOIN resources r ON r.id=q.resource_id
 WHERE q.event_type_id IN (SELECT id FROM definitions)
), bookings_review AS (
 SELECT b.id,b.event_type_id,b.status,b.starts_at,b.ends_at,b.requires_host,b.host_id,b.scheduling_plan,
 CASE WHEN b.scheduling_plan IS NULL THEN NOT b.requires_host ELSE
  jsonb_typeof(b.scheduling_plan) IS DISTINCT FROM 'object' OR
  b.scheduling_plan->>'organizationId' IS DISTINCT FROM b.organization_id::text OR
  b.scheduling_plan->>'eventTypeId' IS DISTINCT FROM b.event_type_id::text OR
  jsonb_typeof(b.scheduling_plan->'resources') IS DISTINCT FROM 'array' OR
  b.scheduling_plan->'requiresHost' IS DISTINCT FROM to_jsonb(b.requires_host) OR
  b.scheduling_plan->>'scheduleOwnerId' IS DISTINCT FROM b.host_id::text OR
  b.scheduling_plan->'requiredHostIds' IS DISTINCT FROM CASE WHEN b.requires_host THEN jsonb_build_array(b.host_id) ELSE '[]'::jsonb END OR
  (NOT b.requires_host AND CASE WHEN jsonb_typeof(b.scheduling_plan->'resources')='array' THEN jsonb_array_length(b.scheduling_plan->'resources')=0 ELSE true END)
 END AS accepted_policy_invalid
 FROM bookings b WHERE b.organization_id=:'organization_id'::uuid AND b.event_type_id IN (SELECT id FROM definitions)
), state AS (
 SELECT jsonb_build_object(
 'format_version',1,'organization_id',:'organization_id'::uuid,
 'organization', (SELECT jsonb_build_object('id',id,'slug',slug,'business_timezone',business_timezone) FROM organizations WHERE id=:'organization_id'::uuid),
 'services',(SELECT jsonb_agg(configuration ORDER BY role) FROM definitions),
 'resources',coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY id,event_type_id) FROM equipment r),'[]'::jsonb)
 ) AS configuration_snapshot,
 array_remove(ARRAY[
  CASE WHEN (SELECT count(DISTINCT id) FROM targets)<>3 OR :'light_resource_id'::uuid=:'pemf_resource_id'::uuid THEN 'distinct_service_and_equipment_ids_required' END,
  CASE WHEN (SELECT count(DISTINCT owner_id) FROM definitions)<>1 THEN 'services_must_share_responsible_owner' END,
  CASE WHEN NOT EXISTS(SELECT 1 FROM organizations o JOIN pg_timezone_names z ON z.name=o.business_timezone WHERE o.id=:'organization_id'::uuid) THEN 'invalid_organization_timezone' END,
  CASE WHEN EXISTS(SELECT 1 FROM equipment WHERE organization_id<>:'organization_id'::uuid OR requirement_organization<>organization_id OR NOT enabled OR capacity<quantity OR capacity<=0) THEN 'resource_scope_enabled_or_capacity_invalid' END,
  CASE WHEN EXISTS(SELECT 1 FROM bookings_review WHERE accepted_policy_invalid) THEN 'invalid_frozen_booking_attendance' END,
  CASE WHEN NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='a_resource_booking_attendance' AND tgrelid='bookings'::regclass AND tgenabled IN ('O','A')) THEN 'slice6_attendance_guard_required' END
 ],NULL) AS issues
)
SELECT jsonb_build_object(
 'ready',cardinality(state.issues)=0 AND NOT EXISTS(SELECT 1 FROM definitions WHERE cardinality(issues)>0 OR activation_blocked),
 'configuration_snapshot',configuration_snapshot,'issues',to_jsonb(state.issues),
 'services',(SELECT jsonb_agg(jsonb_build_object('role',role,'id',id,'issues',to_jsonb(issues),'activation_blocked',activation_blocked) ORDER BY role) FROM definitions),
 'accepted_bookings',coalesce((SELECT jsonb_agg(to_jsonb(b) ORDER BY event_type_id,starts_at,id) FROM bookings_review b),'[]'::jsonb),
 'unbound_selected_attempts',coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'event_type_id',a.event_type_id,'state',a.state,'review_code',a.review_code,'checkout_session_id',a.checkout_session_id,'payment_intent_id',a.payment_intent_id,'observed_paid',a.success_facts IS NOT NULL,'expires_at',a.expires_at,'scheduling_plan',a.scheduling_plan) ORDER BY a.created_at,a.id) FROM payment_attempts a WHERE a.organization_id=:'organization_id'::uuid AND a.event_type_id IN (SELECT id FROM definitions WHERE role<>'energy') AND a.booking_id IS NULL),'[]'::jsonb),
 'organization_payment_review',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'event_type_id',event_type_id,'state',state,'review_code',review_code,'booking_id',booking_id,'observed_paid',success_facts IS NOT NULL,'finalization_state',finalization_state,'finalization_review_code',finalization_review_code,'next_recovery_at',next_recovery_at) ORDER BY created_at,id) FROM payment_attempts WHERE organization_id=:'organization_id'::uuid AND (state='requires_review' OR review_code IS NOT NULL OR finalization_state='requires_review' OR (success_facts IS NOT NULL AND booking_id IS NULL))),'[]'::jsonb),
 'organization_refund_review',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'purpose',purpose,'attempt_id',attempt_id,'booking_id',booking_id,'state',state,'review_code',review_code,'stripe_refund_id',stripe_refund_id,'next_recovery_at',next_recovery_at) ORDER BY created_at,id) FROM refund_operations WHERE organization_id=:'organization_id'::uuid AND state<>'succeeded'),'[]'::jsonb),
 'organization_legacy_bookings',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'event_type_id',event_type_id,'status',status,'starts_at',starts_at,'ends_at',ends_at) ORDER BY event_type_id,starts_at,id) FROM bookings WHERE organization_id=:'organization_id'::uuid AND scheduling_plan IS NULL AND status NOT IN ('cancelled','rejected')),'[]'::jsonb),
 'external_boundary','Not certified by SQL: quiesced writers, legacy Redis/provider obligations, cash routing, review and recovery ownership must be reviewed separately.'
) AS readiness FROM state
\gset
