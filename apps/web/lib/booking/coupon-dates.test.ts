import { describe, expect, it } from "vitest";
import { couponCalendarWindow } from "./coupon-dates";
describe("organization coupon calendar days", () => {
  it("stores inclusive October in Boise as half-open UTC instants", () => {
    const window = couponCalendarWindow("2026-10-01", "2026-10-31", "America/Boise");
    expect(window.startsAt.toISOString()).toBe("2026-10-01T06:00:00.000Z");
    expect(window.endsAt.toISOString()).toBe("2026-11-01T06:00:00.000Z");
  });
  it("uses the next local midnight across daylight saving changes", () => {
    const window = couponCalendarWindow("2026-11-01", "2026-11-01", "America/Boise");
    expect(window.startsAt.toISOString()).toBe("2026-11-01T06:00:00.000Z");
    expect(window.endsAt.toISOString()).toBe("2026-11-02T07:00:00.000Z");
  });
  it("rejects bad dates, inverted windows, and unknown timezones", () => {
    expect(() => couponCalendarWindow("2026-02-30", "2026-03-01", "America/Boise")).toThrow();
    expect(() => couponCalendarWindow("2026-10-31", "2026-10-01", "America/Boise")).toThrow();
    expect(() => couponCalendarWindow("2026-10-01", "2026-10-31", "Not/AZone")).toThrow();
  });
});
