import {
  BookingError,
  ResourceInvariantError,
  assertExclusiveSettlement,
  mapInsertError,
  validateResponses,
} from "@/lib/booking/booking-logic";
import { describe, expect, it } from "vitest";

describe("assertExclusiveSettlement", () => {
  it("rejects mixed payment and credit before either can be consumed", () => {
    expect(() =>
      assertExclusiveSettlement({ payment: { amountPaid: 100 }, redeemCredit: true }),
    ).toThrow(BookingError);
  });
  it("allows credit, payment, and free cash inputs independently", () => {
    for (const input of [{}, { payment: { amountPaid: 0 } }, { redeemCredit: true }]) {
      expect(() => assertExclusiveSettlement(input)).not.toThrow();
    }
  });
});

const q = (id: string, type: string, required: boolean) => ({
  id,
  label: `Q ${id}`,
  type,
  required,
});

describe("validateResponses", () => {
  it("passes when there are no questions", () => {
    expect(() => validateResponses([], {})).not.toThrow();
    expect(() => validateResponses(null, null)).not.toThrow();
  });

  it("ignores optional questions even when unanswered", () => {
    expect(() => validateResponses([q("1", "text", false)], {})).not.toThrow();
  });

  it("throws a 400 naming the first unanswered required question", () => {
    try {
      validateResponses([q("1", "text", true)], {});
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(BookingError);
      expect((e as BookingError).status).toBe(400);
      expect((e as BookingError).message).toBe("Please answer: Q 1");
    }
  });

  it("treats whitespace-only text answers as unanswered", () => {
    expect(() => validateResponses([q("1", "text", true)], { "1": "   " })).toThrow(BookingError);
  });

  it("requires a required checkbox to be exactly true", () => {
    expect(() => validateResponses([q("1", "checkbox", true)], { "1": false })).toThrow(
      BookingError,
    );
    expect(() => validateResponses([q("1", "checkbox", true)], { "1": "true" })).toThrow(
      BookingError,
    );
    expect(() => validateResponses([q("1", "checkbox", true)], { "1": true })).not.toThrow();
  });

  it("accepts a non-empty text answer", () => {
    expect(() => validateResponses([q("1", "text", true)], { "1": "hello" })).not.toThrow();
  });
});

describe("mapInsertError", () => {
  it("maps a Postgres unique violation (23505) to a 409 BookingError", () => {
    try {
      mapInsertError({ code: "23505" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(BookingError);
      expect((e as BookingError).status).toBe(409);
    }
  });

  it("passes a BookingError through unchanged", () => {
    const original = new BookingError("nope", 400);
    expect(() => mapInsertError(original)).toThrow(original);
  });

  it("rethrows unknown errors as-is", () => {
    const other = new Error("boom");
    expect(() => mapInsertError(other)).toThrow(other);
  });
});

describe("Resource diagnostic application boundary", () => {
  it.each([
    "resource_plan_completeness_violation",
    "resource_scope_violation",
    "resource_claim_lifecycle_violation",
  ])("wrapped %s remains invariant rather than slot contention", (constraint) => {
    expect(() =>
      mapInsertError(new Error("driver wrapper", { cause: { code: "23514", constraint } })),
    ).toThrow(ResourceInvariantError);
  });
  it("wrapped valid capacity conflict is a scheduling conflict", () => {
    try {
      mapInsertError(
        new Error("driver wrapper", {
          cause: { code: "23P01", constraint: "resource_capacity_conflict" },
        }),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(BookingError);
      expect((error as BookingError).status).toBe(409);
    }
  });
  it("retryable transaction failure remains available to whole-transaction retry", () => {
    const original = new Error("driver wrapper", { cause: { code: "40P01" } });
    expect(() => mapInsertError(original)).toThrow(original);
  });
});
