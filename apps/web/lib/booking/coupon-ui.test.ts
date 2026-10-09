import { BookingSubmitLabel, CouponCodeControls } from "@/components/booking-coupon-ui";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const controls = (signedIn: boolean, value = "", appliedCoupon: string | null = null) =>
  renderToStaticMarkup(
    createElement(CouponCodeControls, {
      signedIn,
      value,
      appliedCoupon,
      onChange: () => {},
      onApply: () => {},
      onRemove: () => {},
    }),
  );
const label = (amountToCollect: number, currency = "usd") =>
  renderToStaticMarkup(
    createElement(BookingSubmitLabel, { quote: { amountToCollect, currency }, locale: "en" }),
  );

describe("customer coupon controls and quoted commitment", () => {
  it("hides coupon entry for guests", () => {
    expect(controls(false, "FRIEND50", "FRIEND50")).toBe("");
  });
  it("shows apply for signed-in customers and disables empty codes", () => {
    expect(controls(true)).toContain("Coupon code");
    expect(controls(true)).toMatch(/disabled=""[^>]*>Apply/);
    expect(controls(true, "FRIEND50")).not.toContain('disabled=""');
  });
  it("shows remove only while a coupon has been applied", () => {
    expect(controls(true, "FRIEND50")).not.toContain("Remove");
    expect(controls(true, "NEWCODE", "FRIEND50")).toContain("Remove");
  });
  it("uses the quoted discounted cash or deposit amount on the confirmation action", () => {
    expect(label(2500)).toContain("$25.00");
    expect(label(1500)).toContain("$15.00");
  });
  it("confirms zero-cash bookings without a payment amount", () => {
    expect(label(0)).toBe("Confirm booking");
  });
  it("formats zero-decimal quoted currency correctly", () => {
    expect(label(2500, "jpy")).toContain("2500 JPY");
  });
});
