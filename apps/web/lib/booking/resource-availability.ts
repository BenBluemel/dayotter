import type { Slot } from "@dayotter/core";
import { type Database, eq, getDb, schema, sql } from "@dayotter/db";
import { ResourceInvariantError, mapInsertError } from "./booking-logic";

type EventType = typeof schema.eventTypes.$inferSelect;
type Interval = { start: number; end: number };
type WindowRow = {
  resourceId: string;
  startsAt: string;
  endsAt: string;
  demand: string;
  kind: "occupancy" | "open";
};

/** Sorted, disjoint intervals: find the last start preceding the bound. */
function before(intervals: Interval[], bound: number, inclusive: boolean): Interval | undefined {
  let lo = 0;
  let hi = intervals.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const at = intervals[mid]!.start;
    if (at < bound || (inclusive && at === bound)) lo = mid + 1;
    else hi = mid;
  }
  return intervals[lo - 1];
}

/** Outward rounding can make adjacent microsecond segments overlap on the
 * millisecond grid. Merge them before binary search, including equal starts.
 */
function mergeIntervals(intervals: Interval[]): Interval[] {
  const merged: Interval[] = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ start: interval.start, end: interval.end });
  }
  return merged;
}

/** Advisory reads never fence/lock resources or create holds. Both queries share
 * a read-only snapshot; acceptance still serializes the final allocation.
 * The sweep is resource_peak's grouped endpoint arithmetic, once per window,
 * rather than one aggregate/query per candidate. Claims already include buffers.
 */
export async function filterResourceAvailability(
  eventType: EventType,
  slots: Slot[],
  db: Database = getDb(),
): Promise<Slot[]> {
  if (!slots.length) return slots;
  try {
    return await db.transaction(
      async (tx) => {
        const e = schema.eventTypes;
        const q = schema.eventTypeResourceRequirements;
        const r = schema.resources;
        const context = await tx
          .select({
            service: e,
            requirement: q,
            resource: {
              id: r.id,
              organizationId: r.organizationId,
              capacity: r.capacity,
              enabled: r.enabled,
            },
            validTerms: sql<boolean>`CASE WHEN ${q.resourceId} IS NULL THEN true ELSE
            EXISTS (SELECT 1 FROM schedules s WHERE s.user_id = ${e.ownerId}
              AND s.id = coalesce(${e.scheduleId}, (SELECT id FROM schedules WHERE user_id = ${e.ownerId} AND is_default ORDER BY id LIMIT 1))
              AND (${e.scheduleId} IS NOT NULL OR (SELECT count(*) FROM schedules WHERE user_id = ${e.ownerId} AND is_default) = 1)
              AND EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = s.timezone))
            AND EXISTS (SELECT 1 FROM users u JOIN pg_timezone_names z ON z.name = u.timezone WHERE u.id = ${e.ownerId})
            AND EXISTS (SELECT 1 FROM organizations o JOIN pg_timezone_names z ON z.name = o.business_timezone WHERE o.id = ${e.organizationId}) END`,
          })
          .from(e)
          .leftJoin(q, eq(q.eventTypeId, e.id))
          .leftJoin(r, eq(r.id, q.resourceId))
          .where(eq(e.id, eventType.id));
        if (!context.length) return [];
        const current = context[0]!.service;
        const required = context.filter((row) => row.requirement !== null);
        if (
          current.resourceConfigurationRevision !== eventType.resourceConfigurationRevision ||
          current.resourceAdmissionEpoch !== eventType.resourceAdmissionEpoch
        )
          return []; // The host candidates were computed from a stale definition.
        // Check the revision even when requirements were removed: candidates
        // may have skipped person conflicts under the previous attendance policy.
        if (!required.length) return current.requiresHost ? slots : [];
        if (
          !current.isActive ||
          current.resourceAdmissionEpoch <= 0 ||
          !current.ownerId ||
          current.schedulingType !== "individual" ||
          current.maxAttendees !== 1 ||
          current.recurringCount !== 1 ||
          current.slug === "__personal"
        )
          return [];
        const buffers = [current.bufferBeforeMinutes, current.bufferAfterMinutes];
        if (
          !context[0]!.validTerms ||
          [...buffers, current.minimumGapMinutes].some((v) => !Number.isSafeInteger(v) || v < 0)
        )
          throw new ResourceInvariantError("resource_plan_completeness_violation", undefined);
        for (const row of required) {
          const requirement = row.requirement!;
          if (
            !row.resource ||
            requirement.organizationId !== current.organizationId ||
            row.resource.organizationId !== current.organizationId
          )
            throw new ResourceInvariantError("resource_scope_violation", undefined);
          if (
            !Number.isSafeInteger(requirement.quantity) ||
            requirement.quantity <= 0 ||
            !Number.isSafeInteger(row.resource.capacity) ||
            row.resource.capacity <= 0
          )
            throw new ResourceInvariantError("resource_plan_completeness_violation", undefined);
        }
        if (
          required.some(
            (row) => !row.resource!.enabled || row.requirement!.quantity > row.resource!.capacity,
          )
        )
          return [];
        const start =
          slots.reduce((at, s) => Math.min(at, s.start.getTime()), Number.POSITIVE_INFINITY) -
          current.bufferBeforeMinutes * 60_000;
        const end =
          slots.reduce((at, s) => Math.max(at, s.end.getTime()), Number.NEGATIVE_INFINITY) +
          current.bufferAfterMinutes * 60_000;
        // Public windows are at most 62 days. Bound expansion as well, including
        // malformed/extreme buffers, before generating opening-hour calendar days.
        if (
          !Number.isFinite(start) ||
          !Number.isFinite(end) ||
          end <= start ||
          end - start > 64 * 86_400_000
        )
          return [];
        const ids = sql`ARRAY[${sql.join(
          required.map((row) => sql`${row.resource!.id}::uuid`),
          sql`, `,
        )}]`;
        const result = await tx.execute<WindowRow>(sql`
        WITH claims AS MATERIALIZED (
          SELECT resource_id, greatest(starts_at, ${new Date(start)}::timestamptz) AS lo,
            least(ends_at, ${new Date(end)}::timestamptz) AS hi, quantity::numeric AS quantity
          FROM booking_resource_claims
          WHERE organization_id = ${current.organizationId}::uuid
            AND resource_id = ANY(${ids}::uuid[]) AND released_at IS NULL
            AND tstzrange(starts_at, ends_at, '[)') && tstzrange(${new Date(start)}::timestamptz, ${new Date(end)}::timestamptz, '[)')
        ), endpoints AS (
          SELECT resource_id, lo AS at, quantity AS delta FROM claims
          UNION ALL SELECT resource_id, hi, -quantity FROM claims
        ), grouped AS (
          SELECT resource_id, at, sum(delta) AS delta FROM endpoints GROUP BY resource_id, at
        ), segments AS (
          SELECT resource_id, at, lead(at) OVER (PARTITION BY resource_id ORDER BY at) AS until,
            sum(delta) OVER (PARTITION BY resource_id ORDER BY at) AS demand FROM grouped
        )
        SELECT resource_id AS "resourceId", floor(extract(epoch FROM at)*1000) AS "startsAt", ceil(extract(epoch FROM until)*1000) AS "endsAt", demand::text, 'occupancy' AS kind
          FROM segments WHERE until > at
        UNION ALL
        SELECT r.id, extract(epoch FROM lower(w))*1000, extract(epoch FROM upper(w))*1000, '0', 'open'
          FROM resources r CROSS JOIN LATERAL unnest((SELECT range_agg(open_interval)
            FROM resource_open_windows(r.opening_hours, ${new Date(start)}::timestamptz, ${new Date(end)}::timestamptz) open_interval)) w
          WHERE r.organization_id = ${current.organizationId}::uuid AND r.id = ANY(${ids}::uuid[])
      `);
        const byResource = new Map<string, WindowRow[]>();
        for (const row of result.rows) {
          const rows = byResource.get(row.resourceId) ?? [];
          rows.push(row);
          byResource.set(row.resourceId, rows);
        }
        const profiles = required.map((row) => {
          const rows = byResource.get(row.resource!.id) ?? [];
          const intervals = (kind: WindowRow["kind"]) =>
            rows
              .filter((v) => v.kind === kind)
              .map((v) => {
                const demand = Number(v.demand);
                const interval = { start: Number(v.startsAt), end: Number(v.endsAt) };
                if (
                  !Number.isSafeInteger(demand) ||
                  demand < 0 ||
                  !Number.isSafeInteger(interval.start) ||
                  !Number.isSafeInteger(interval.end) ||
                  interval.end <= interval.start
                )
                  throw new ResourceInvariantError(
                    "resource_plan_completeness_violation",
                    undefined,
                  );
                return { ...interval, demand };
              })
              .sort((a, b) => a.start - b.start);
          return {
            open: intervals("open"),
            blocked: mergeIntervals(
              intervals("occupancy").filter(
                (v) => v.demand + row.requirement!.quantity > row.resource!.capacity,
              ),
            ),
          };
        });
        return slots.filter((slot) => {
          const a = slot.start.getTime() - current.bufferBeforeMinutes * 60_000;
          const b = slot.end.getTime() + current.bufferAfterMinutes * 60_000;
          return profiles.every((profile) => {
            const open = before(profile.open, a, true);
            const occupied = before(profile.blocked, b, false);
            return open !== undefined && open.end >= b && !(occupied && occupied.end > a);
          });
        });
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  } catch (error) {
    mapInsertError(error);
  }
}

/** A move has one candidate and a proven immutable plan. Reuse PostgreSQL's
 * interval/peak/hours semantics, excluding only this booking's old commitment.
 * This is advisory; the transactional replacement still fences and rechecks.
 */
export async function acceptedBookingResourceAvailable(
  booking: typeof schema.bookings.$inferSelect,
  startsAt: Date,
  endsAt: Date,
  db: Database = getDb(),
): Promise<boolean> {
  const plan = booking.schedulingPlan;
  if (!plan) return true;
  try {
    const result = await db.execute<{ available: boolean }>(sql`
      WITH candidate AS (
        SELECT resource_occupied_interval(${startsAt}::timestamptz, ${endsAt}::timestamptz,
          ${JSON.stringify(plan)}::jsonb) AS occupied
      ) SELECT NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(${JSON.stringify(plan.resources)}::jsonb) x
        LEFT JOIN resources r ON r.id=(x->>'id')::uuid AND r.organization_id=${booking.organizationId}::uuid
        CROSS JOIN candidate c
        WHERE r.id IS NULL OR NOT r.enabled OR (x->>'quantity')::integer<=0
          OR (x->>'quantity')::integer>r.capacity
          OR NOT resource_open_during(r.opening_hours,lower(c.occupied),upper(c.occupied))
          OR resource_peak(r.id,lower(c.occupied),upper(c.occupied),${booking.id}::uuid)
             +(x->>'quantity')::integer>r.capacity
      ) AS available`);
    return result.rows[0]?.available === true;
  } catch (error) {
    mapInsertError(error);
  }
}
