import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { formatMoney } from "@/lib/booking/money";
import { type Locale, t } from "@/lib/i18n/booking";

export function CouponCodeControls({
  signedIn,
  value,
  appliedCoupon,
  onChange,
  onApply,
  onRemove,
}: {
  signedIn: boolean;
  value: string;
  appliedCoupon: string | null;
  onChange: (value: string) => void;
  onApply: () => void;
  onRemove: () => void;
}) {
  if (!signedIn) return null;
  return (
    <div>
      <Label htmlFor="b-coupon">Coupon code</Label>
      <div className="flex gap-2">
        <Input
          id="b-coupon"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Enter code"
        />
        <Button type="button" variant="outline" disabled={!value.trim()} onClick={onApply}>
          Apply
        </Button>
        {appliedCoupon ? (
          <Button type="button" variant="outline" onClick={onRemove}>
            Remove
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function BookingSubmitLabel({
  quote,
  locale,
}: {
  quote: { amountToCollect: number; currency: string } | null;
  locale: Locale;
}) {
  return quote && quote.amountToCollect > 0
    ? t(locale, "payAndBook", { price: formatMoney(quote.amountToCollect, quote.currency) })
    : t(locale, "confirmBooking");
}
