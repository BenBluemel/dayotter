import { describe, expect, it, vi } from "vitest";
import {
  type AppointmentPricingInput,
  type AppointmentPromotion,
  calculateAppointmentPrice,
} from "./pricing";

const light = { id: "light", organizationId: "light-and-balance", price: 5000, currency: "usd" };
const appointmentStartsAt = new Date("2026-10-15T15:00:00Z");
const promotion = (overrides: Partial<AppointmentPromotion> = {}): AppointmentPromotion => ({
  id: "promo-a",
  organizationId: light.organizationId,
  label: "October light therapy",
  isActive: true,
  startsAt: new Date("2026-10-01T00:00:00Z"),
  endsAt: new Date("2026-11-01T00:00:00Z"),
  eventTypeIds: [light.id],
  discount: { kind: "percentage", basisPoints: 2000 },
  ...overrides,
});
const price = (overrides: Partial<AppointmentPricingInput> = {}) =>
  calculateAppointmentPrice({
    eventType: light,
    appointmentStartsAt,
    settlement: "cash",
    promotions: [promotion()],
    ...overrides,
  });

describe("automatic appointment pricing", () => {
  it.each([
    [null, 4000],
    [0, 4000],
    [1000, 1000],
    [4500, 4000],
    [6000, 4000],
  ])(
    "derives a capped deposit (%s) after discounting the full service",
    (depositAmount, expected) => {
      expect(price({ eventType: { ...light, depositAmount } })).toMatchObject({
        effectivePrice: 4000,
        amountToCollect: expected,
      });
    },
  );

  it("collects nothing for credits or a 100% cash promotion, even with a deposit", () => {
    expect(
      price({ eventType: { ...light, depositAmount: 2000 }, settlement: "package_credit" })
        .amountToCollect,
    ).toBe(0);
    expect(
      price({
        eventType: { ...light, depositAmount: 2000 },
        promotions: [promotion({ discount: { kind: "percentage", basisPoints: 10000 } })],
      }),
    ).toMatchObject({ settlement: "cash", amountToCollect: 0 });
  });

  it("rejects noninteger or negative deposit amounts", () => {
    for (const depositAmount of [-1, 1.5, Number.NaN]) {
      expect(() => price({ eventType: { ...light, depositAmount } })).toThrow(RangeError);
    }
  });

  it("preserves base price and promotion identity with a percentage discount", () => {
    expect(price()).toMatchObject({
      version: 1,
      organizationId: light.organizationId,
      eventTypeId: light.id,
      appointmentStartsAt: appointmentStartsAt.toISOString(),
      settlement: "cash",
      basePrice: 5000,
      effectivePrice: 4000,
      currency: "usd",
      promotion: { id: "promo-a", label: "October light therapy" },
    });
  });

  it.each([
    ["2026-09-30T23:59:59.999Z", 5000],
    ["2026-10-01T00:00:00Z", 4000],
    ["2026-10-31T23:59:59.999Z", 4000],
    ["2026-11-01T00:00:00Z", 5000],
  ])("uses appointment start with inclusive start and exclusive end: %s", (start, expected) => {
    expect(price({ appointmentStartsAt: new Date(start) }).effectivePrice).toBe(expected);
  });

  it("uses the appointment time even when booking creation is before or after the promotion", () => {
    vi.useFakeTimers();
    try {
      for (const createdAt of ["2026-09-01", "2026-10-15", "2026-12-01"]) {
        vi.setSystemTime(new Date(`${createdAt}T00:00:00Z`));
        expect(price().effectivePrice).toBe(4000);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("compares UTC instants across offsets, including the Boise DST fallback", () => {
    const promos = [
      promotion({
        startsAt: new Date("2026-11-01T01:00:00-06:00"),
        endsAt: new Date("2026-11-01T01:00:00-07:00"),
      }),
    ];
    expect(
      price({ promotions: promos, appointmentStartsAt: new Date("2026-11-01T07:30:00Z") })
        .effectivePrice,
    ).toBe(4000);
    expect(
      price({ promotions: promos, appointmentStartsAt: new Date("2026-11-01T08:30:00Z") })
        .effectivePrice,
    ).toBe(5000);
  });

  it.each([
    { isActive: false },
    { organizationId: "another-org" },
    { eventTypeIds: ["pemf"] },
    { eventTypeIds: [] },
  ])("ignores disabled, foreign, and unselected promotions: %j", (overrides) => {
    expect(price({ promotions: [promotion(overrides)] })).toMatchObject({
      effectivePrice: 5000,
      promotion: null,
    });
  });

  it("supports several explicitly selected services", () => {
    expect(
      price({
        eventType: { ...light, id: "pemf" },
        promotions: [promotion({ eventTypeIds: ["light", "pemf"] })],
      }).effectivePrice,
    ).toBe(4000);
  });

  it("applies a fixed amount in minor units only for the matching currency", () => {
    const promos = [promotion({ discount: { kind: "fixed", amount: 1500, currency: "USD" } })];
    expect(price({ promotions: promos }).effectivePrice).toBe(3500);
    expect(
      price({ promotions: promos, eventType: { ...light, currency: "eur" } }).promotion,
    ).toBeNull();
  });

  it("works in zero-decimal currency minor units without a cents conversion", () => {
    expect(
      price({
        eventType: { ...light, currency: "jpy" },
        promotions: [promotion({ discount: { kind: "fixed", amount: 500, currency: "jpy" } })],
      }).effectivePrice,
    ).toBe(4500);
  });

  it.each([null, 0])("treats a free base price (%s) as zero with no applied promotion", (base) => {
    expect(price({ eventType: { ...light, price: base, currency: null } })).toMatchObject({
      basePrice: 0,
      effectivePrice: 0,
      currency: "usd",
      promotion: null,
    });
  });

  it("rounds the discount half up at minor-unit precision", () => {
    expect(
      price({
        eventType: { ...light, price: 101 },
        promotions: [promotion({ discount: { kind: "percentage", basisPoints: 5000 } })],
      }).effectivePrice,
    ).toBe(50);
    expect(
      price({
        eventType: { ...light, price: 9999 },
        promotions: [promotion({ discount: { kind: "percentage", basisPoints: 1250 } })],
      }).effectivePrice,
    ).toBe(8749);
  });

  it("does not record a promotion whose savings round to zero", () => {
    expect(price({ eventType: { ...light, price: 1 } }).promotion).toBeNull();
  });

  it.each([
    { kind: "percentage" as const, basisPoints: 10_000 },
    { kind: "fixed" as const, amount: 6000, currency: "usd" },
  ])("allows a zero cash price without redeeming a credit: %j", (discount) => {
    expect(price({ promotions: [promotion({ discount })] })).toMatchObject({
      settlement: "cash",
      effectivePrice: 0,
      promotion: { id: "promo-a" },
    });
  });

  it("selects the greatest saving without stacking, independently of query order", () => {
    const candidates = [
      promotion(),
      promotion({ id: "promo-b", discount: { kind: "fixed", amount: 1500, currency: "usd" } }),
    ];
    expect(price({ promotions: candidates })).toEqual(
      price({ promotions: [...candidates].reverse() }),
    );
    expect(price({ promotions: candidates })).toMatchObject({
      effectivePrice: 3500,
      promotion: { id: "promo-b" },
    });
  });

  it("breaks equal-saving ties by ascending stable id", () => {
    const candidates = [
      promotion({ id: "promo-z" }),
      promotion({ discount: { kind: "fixed", amount: 1000, currency: "usd" } }),
    ];
    expect(price({ promotions: candidates })).toEqual(
      price({ promotions: [...candidates].reverse() }),
    );
    expect(price({ promotions: candidates }).promotion?.id).toBe("promo-a");
  });

  it("returns a separate credit settlement without applying a cash promotion", () => {
    expect(price({ settlement: "package_credit" })).toMatchObject({
      settlement: "package_credit",
      basePrice: 5000,
      effectivePrice: 5000,
      promotion: null,
    });
  });

  it("copies historical price and rule data so later source edits cannot change it", () => {
    const eventType = { ...light };
    const discount = { kind: "percentage" as const, basisPoints: 2000 };
    const original = { ...promotion(), discount };
    const quote = price({ eventType, promotions: [original] });
    const stored = JSON.parse(JSON.stringify(quote));
    original.label = "Edited label";
    original.endsAt.setUTCFullYear(2030);
    discount.basisPoints = 5000;
    eventType.price = 9000;
    expect(quote).toEqual(stored);
    expect(quote.promotion?.label).toBe("October light therapy");
  });

  it("returns list price when no promotion applies", () => {
    expect(price({ promotions: [] })).toMatchObject({ effectivePrice: 5000, promotion: null });
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    "rejects invalid base amounts: %s",
    (amount) => {
      expect(() => price({ eventType: { ...light, price: amount } })).toThrow(RangeError);
    },
  );

  it.each([0, -1, 1.5, 10_001, Number.NaN])(
    "rejects invalid percentage rules: %s",
    (basisPoints) => {
      expect(() =>
        price({ promotions: [promotion({ discount: { kind: "percentage", basisPoints } })] }),
      ).toThrow(RangeError);
    },
  );

  it.each([0, -1, 1.5, 2_147_483_648])("rejects invalid fixed rules: %s", (amount) => {
    expect(() =>
      price({ promotions: [promotion({ discount: { kind: "fixed", amount, currency: "usd" } })] }),
    ).toThrow(RangeError);
  });

  it("rejects invalid dates, inverted windows, missing labels, and duplicate identities", () => {
    expect(() => price({ appointmentStartsAt: new Date("invalid") })).toThrow(RangeError);
    expect(() => price({ promotions: [promotion({ endsAt: new Date("invalid") })] })).toThrow(
      RangeError,
    );
    expect(() =>
      price({ promotions: [promotion({ endsAt: new Date("2026-10-01T00:00:00Z") })] }),
    ).toThrow(RangeError);
    expect(() => price({ promotions: [promotion({ label: " " })] })).toThrow(RangeError);
    expect(() => price({ promotions: [promotion(), promotion()] })).toThrow(RangeError);
  });

  it("rejects malformed currency codes and unknown settlement values", () => {
    expect(() => price({ eventType: { ...light, currency: "dollars" } })).toThrow(RangeError);
    expect(() =>
      price({ settlement: "cash_and_credit" as AppointmentPricingInput["settlement"] }),
    ).toThrow(RangeError);
  });
});
