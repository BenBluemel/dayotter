import { type Database, classifyResourceError, withResourceTransaction } from "@dayotter/db";
import { describe, expect, it, vi } from "vitest";

describe("resource database diagnostics and transaction retries", () => {
  it("unwraps named expected conflicts without confusing host exclusion", () => {
    expect(
      classifyResourceError({
        cause: { cause: { code: "23P01", constraint: "resource_capacity_conflict" } },
      }),
    ).toEqual({ category: "conflict", identity: "resource_capacity_conflict" });
    expect(classifyResourceError({ code: "23P01", constraint: "bookings_no_overlap" })).toBeNull();
    expect(classifyResourceError({ code: "23514", constraint: "resource_disabled" })).toEqual({
      category: "conflict",
      identity: "resource_disabled",
    });
  });
  it("keeps corruption and composite scope failures distinct from contention", () => {
    for (const constraint of [
      "resource_plan_completeness_violation",
      "resource_claim_lifecycle_violation",
      "resource_scope_violation",
    ])
      expect(classifyResourceError({ code: "23514", constraint })?.category).toBe("invariant");
    for (const constraint of [
      "resource_requirement_service_scope_fk",
      "resource_requirement_resource_scope_fk",
      "resource_claim_booking_scope_fk",
      "resource_claim_resource_scope_fk",
    ])
      expect(classifyResourceError({ cause: { code: "23503", constraint } })).toEqual({
        category: "invariant",
        identity: "resource_scope_violation",
      });
  });
  it("does not trust English text, mismatched SQLSTATE or cause cycles", () => {
    expect(
      classifyResourceError({ message: "resource_capacity_conflict", code: "23514" }),
    ).toBeNull();
    expect(
      classifyResourceError({ constraint: "resource_capacity_conflict", code: "23514" }),
    ).toBeNull();
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(classifyResourceError(cyclic)).toBeNull();
  });
  it("retries the entire transaction for deadlock/serialization at most three times", async () => {
    const operation = vi.fn().mockResolvedValue("booked");
    const transaction = vi
      .fn()
      .mockRejectedValueOnce({ cause: { code: "40P01" } })
      .mockRejectedValueOnce({ code: "40001" })
      .mockImplementation(operation);
    expect(await withResourceTransaction({ transaction } as unknown as Database, operation)).toBe(
      "booked",
    );
    expect(transaction).toHaveBeenCalledTimes(3);
    const failed = vi.fn().mockRejectedValue({ code: "40001" });
    await expect(
      withResourceTransaction({ transaction: failed } as unknown as Database, operation),
    ).rejects.toEqual({ code: "40001" });
    expect(failed).toHaveBeenCalledTimes(3);
  });
  it("never retries capacity contention or invariant failure", async () => {
    for (const constraint of ["resource_disabled", "resource_plan_completeness_violation"]) {
      const transaction = vi.fn().mockRejectedValue({ code: "23514", constraint });
      await expect(
        withResourceTransaction({ transaction } as unknown as Database, async () => null),
      ).rejects.toEqual({ code: "23514", constraint });
      expect(transaction).toHaveBeenCalledTimes(1);
    }
  });
});
