import { type Database, eq, schema, sql } from "@dayotter/db";
import type { AcceptedSchedulingPlan } from "@dayotter/db/schema";
import { BookingError, mapInsertError } from "./booking-logic";
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** Higher-order service admission. Never called from inside the resource allocator. */
export async function captureSchedulingPlan(
  tx: Transaction,
  service: typeof schema.eventTypes.$inferSelect,
  duration: number,
  hostId: string,
  frozen?: AcceptedSchedulingPlan | null,
) {
  if (!service.resourceAdmissionEpoch) return frozen ?? null;
  if (
    !service.requiresHost ||
    service.schedulingType !== "individual" ||
    service.maxAttendees !== 1 ||
    service.recurringCount !== 1
  )
    throw new BookingError("This scheduling mode is not supported for this service", 409);
  if (!service.isActive) throw new BookingError("Service is unavailable", 409);
  if (!Number.isInteger(duration) || duration <= 0)
    throw new BookingError("Enter a positive whole-minute appointment duration", 400);
  if (frozen) return frozen; // SQL verifies custody against the locked attempt, not today's requirements.
  try {
    const result = await tx.execute<{ plan: AcceptedSchedulingPlan }>(
      sql`select resource_accept_plan(${service.id}::uuid,${duration}::integer,${hostId}::uuid) as plan`,
    );
    const plan = result.rows[0]!.plan;
    // Early definition eligibility only; allocation's post-fence SQL remains authority.
    await tx.execute(
      sql`select resource_error('resource_disabled') where exists (select 1 from resources r join jsonb_array_elements(${JSON.stringify(plan.resources)}::jsonb) x on r.id=(x->>'id')::uuid where not r.enabled)`,
    );
    return plan;
  } catch (error) {
    mapInsertError(error);
  }
}
export async function lockServiceAdmission(tx: Transaction, id: string) {
  const [service] = await tx
    .select()
    .from(schema.eventTypes)
    .where(eq(schema.eventTypes.id, id))
    .for("share");
  if (!service) throw new BookingError("Event type not found", 404);
  return service;
}
export async function lockPersonAdmission(tx: Transaction, ids: string[]) {
  for (const id of [...new Set(ids)].sort())
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`booking-person:${id}`}))`);
}
export function rejectManagedRecurrence(
  service: typeof schema.eventTypes.$inferSelect,
  recurring: boolean,
) {
  if (service.resourceAdmissionEpoch > 0 && recurring)
    throw new BookingError("Recurring resource appointments are not supported", 409);
}
