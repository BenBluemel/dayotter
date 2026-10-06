SELECT :'readiness'::jsonb;
SELECT resource_error('resource_plan_completeness_violation')
 WHERE NOT (:'readiness'::jsonb->>'ready')::boolean;
ROLLBACK;
