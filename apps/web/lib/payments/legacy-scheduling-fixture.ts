import { schema } from "@dayotter/db";

/** Migration upgrade fixtures execute BEFORE 0070 exists. Temporarily project the
 * actual pre-0070 table column metadata so today's INSERT/SELECT builders target
 * that historical schema. Restore in finally, before applying 0070 or live tests.
 * Vitest isolates each file; only its serial migration setup uses this helper.
 */
export async function withPreResourceSchedulingSchema<T>(seed: () => Promise<T>): Promise<T> {
  const key = Symbol.for("drizzle:Columns");
  const removed: { columns: Record<string, unknown>; name: string; value: unknown }[] = [];
  for (const [table, names] of [
    [
      schema.eventTypes,
      ["resourceConfigurationRevision", "resourceAdmissionEpoch", "requiresHost"],
    ],
    [schema.bookings, ["schedulingPlan", "allocationRevision"]],
  ] as const) {
    const columns = (table as unknown as Record<symbol, Record<string, unknown>>)[key]!;
    for (const name of names) {
      removed.push({ columns, name, value: columns[name] });
      delete columns[name];
    }
  }
  try {
    return await seed();
  } finally {
    for (const { columns, name, value } of removed) columns[name] = value;
  }
}
