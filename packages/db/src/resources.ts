import { sql } from "drizzle-orm";
import type { Database } from "./client";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type ResourceErrorIdentity =
  | "resource_capacity_conflict"
  | "resource_disabled"
  | "resource_adoption_required"
  | "resource_plan_completeness_violation"
  | "resource_scope_violation"
  | "resource_claim_lifecycle_violation";

const states: Record<ResourceErrorIdentity, string> = {
  resource_capacity_conflict: "23P01",
  resource_disabled: "23514",
  resource_adoption_required: "23514",
  resource_plan_completeness_violation: "23514",
  resource_scope_violation: "23514",
  resource_claim_lifecycle_violation: "23514",
};
const scopeConstraints = new Set([
  "resource_requirement_service_scope_fk",
  "resource_requirement_resource_scope_fk",
  "resource_claim_booking_scope_fk",
  "resource_claim_resource_scope_fk",
]);
/** Match stable driver diagnostics, including Drizzle wrappers; never English text. */
export function classifyResourceError(
  error: unknown,
):
  | { category: "conflict" | "invariant"; identity: ResourceErrorIdentity }
  | { category: "transient"; code: "40001" | "40P01" }
  | null {
  const seen = new Set<object>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const diagnostic = current as { code?: string; constraint?: string; cause?: unknown };
    if (diagnostic.code === "40001" || diagnostic.code === "40P01")
      return { category: "transient", code: diagnostic.code };
    if (diagnostic.code === "23503" && scopeConstraints.has(diagnostic.constraint ?? ""))
      return { category: "invariant", identity: "resource_scope_violation" };
    const identity = diagnostic.constraint as ResourceErrorIdentity;
    if (Object.hasOwn(states, identity) && states[identity] === diagnostic.code)
      return {
        category: [
          "resource_capacity_conflict",
          "resource_disabled",
          "resource_adoption_required",
        ].includes(identity)
          ? "conflict"
          : "invariant",
        identity,
      };
    current = diagnostic.cause;
  }
  return null;
}

/** Allocate OR replace after caller's service/booking/host/financial work.
 * SQL owns the full sorted resource fence. No higher-order locks or provider IO.
 * Keep this inside the caller's transaction; deferred completeness runs at COMMIT.
 */
export async function allocateBookingResources(
  tx: Transaction,
  bookingId: string,
  source: string,
  actorUserId: string | null = null,
) {
  await tx.execute(
    sql`select resource_allocate_booking(${bookingId}::uuid, ${source}, ${actorUserId}::uuid)`,
  );
}

/** Caller must first set cancelled/rejected under its existing lifecycle locks. */
export async function releaseBookingResources(tx: Transaction, bookingId: string) {
  await tx.execute(sql`select resource_release_booking(${bookingId}::uuid)`);
}

/** Retry the WHOLE transaction only. The callback must contain no provider effects. */
export async function withResourceTransaction<T>(
  db: Database,
  operation: (tx: Transaction) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(operation);
    } catch (error) {
      if (attempt >= 2 || classifyResourceError(error)?.category !== "transient") throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, 10 + Math.floor(Math.random() * 20) * (attempt + 1)),
      );
    }
  }
}
