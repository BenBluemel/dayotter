import { and, desc, eq, getDb, inArray, schema, sql } from "@dayotter/db";

export const HISTORY_STATUSES = [
  "all",
  "confirmed",
  "completed",
  "cancelled",
  "no_show",
  "pending",
] as const;
export type HistoryStatus = (typeof HISTORY_STATUSES)[number];

export function normalizeHistoryStatus(value?: string): HistoryStatus {
  return HISTORY_STATUSES.find((status) => status === value) ?? "all";
}

export function historySearchPatterns(query: string) {
  const escaped = query.replace(/[!%_]/g, "!$&");
  return { prefix: `${escaped}%`, substring: `%${escaped}%` };
}

export async function loadBookingHistory(
  hostId: string,
  search = "",
  status: HistoryStatus = "all",
) {
  const query = search.trim();
  const statuses = status === "cancelled" ? ["cancelled", "rejected"] : [status];
  const statusCondition =
    status === "all"
      ? sql`true`
      : sql`b.status::text in (${sql.join(
          statuses.map((s) => sql`${s}`),
          sql`, `,
        )})`;
  const db = getDb();
  if (!query) {
    const rows = await db.query.bookings.findMany({
      where: and(
        eq(schema.bookings.hostId, hostId),
        status === "all"
          ? undefined
          : inArray(
              schema.bookings.status,
              statuses as (typeof schema.bookings.$inferSelect.status)[],
            ),
      ),
      orderBy: [desc(schema.bookings.startsAt), desc(schema.bookings.id)],
      limit: 101,
      with: { attendees: true, eventType: { columns: { color: true } } },
    });
    return { query, status, rows: rows.slice(0, 100), hasMore: rows.length > 100 };
  }

  const patterns = historySearchPatterns(query);
  const fuzzy = !query.includes("@") && (query.match(/\p{L}/gu)?.length ?? 0) >= 3;
  // Keep ranking and relation hydration on the same read-only snapshot.
  return db.transaction(
    async (tx) => {
      // The operator's threshold must be explicit and must not leak into the pool.
      await tx.execute(sql`select set_config('pg_trgm.word_similarity_threshold', '0.5', true)`);
      const result = await tx.execute<{ id: string }>(sql`
      with candidates as (
        select b.id, lower(b.title) as value, 0::real as fuzzy_score
        from bookings b
        where b.host_id = ${hostId} and ${statusCondition}
          and lower(b.title) like lower(${patterns.substring}) escape '!'
        union all
        select b.id, lower(a.name), 0::real
        from booking_attendees a join bookings b on b.id = a.booking_id
        where b.host_id = ${hostId} and ${statusCondition}
          and lower(a.name) like lower(${patterns.substring}) escape '!'
        union all
        select b.id, lower(a.email), 0::real
        from booking_attendees a join bookings b on b.id = a.booking_id
        where b.host_id = ${hostId} and ${statusCondition}
          and lower(a.email) like lower(${patterns.substring}) escape '!'
        union all
        select b.id, lower(a.name), word_similarity(lower(${query}), lower(a.name))
        from booking_attendees a join bookings b on b.id = a.booking_id
        where ${fuzzy} and b.host_id = ${hostId} and ${statusCondition}
          and lower(${query}) <% lower(a.name)
      ), scored as (
        select id,
          case when value = lower(${query}) then 4
            when value like lower(${patterns.prefix}) escape '!' then 3
            when value like lower(${patterns.substring}) escape '!' then 2
            else 1 end as tier,
          fuzzy_score
        from candidates
      ), best as (
        select distinct on (id) id, tier,
          case when tier = 1 then fuzzy_score else 0 end as score
        from scored
        order by id, tier desc, score desc
      )
      select b.id from best join bookings b on b.id = best.id
      where b.host_id = ${hostId}
      order by best.tier desc, best.score desc, b.starts_at desc, b.id desc
      limit 101
    `);
      const ids = result.rows.slice(0, 100).map((row) => row.id);
      const rows = ids.length
        ? await tx.query.bookings.findMany({
            where: and(eq(schema.bookings.hostId, hostId), inArray(schema.bookings.id, ids)),
            with: { attendees: true, eventType: { columns: { color: true } } },
          })
        : [];
      const byId = new Map(rows.map((row) => [row.id, row]));
      return {
        query,
        status,
        rows: ids.map((id) => byId.get(id)!),
        hasMore: result.rows.length > 100,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
