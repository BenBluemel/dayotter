/** Automatic appointment pricing. Pure domain logic; no payment or credit I/O. */

export type DiscountRule =
  | { readonly kind: "percentage"; readonly basisPoints: number }
  | { readonly kind: "fixed"; readonly amount: number; readonly currency: string };

/** Existing persisted promotion terms retain their version-1 shape. */
export type PromotionDiscount = DiscountRule;

export interface DiscountCandidate {
  readonly id: string;
  readonly source: "promotion" | "coupon";
  readonly discount: DiscountRule;
}

/** Canonical identity only: does not validate, authenticate, or redeem a coupon. */
export function normalizeCouponCode(code: string): string {
  return code.trim().toUpperCase();
}

/** Candidates must already be authorized/eligible. Only the winner may consume capacity. */
export function selectBestDiscount<T extends DiscountCandidate>(
  basePrice: number,
  currency: string,
  candidates: readonly T[],
): { candidate: T | null; saving: number } {
  validateAmount(basePrice);
  const code = currencyCode(currency);
  let candidate: T | null = null;
  let saving = 0;
  const ids = new Set<string>();
  for (const item of candidates) {
    const key = `${item.source}:${item.id}`;
    if (!item.id || !["promotion", "coupon"].includes(item.source) || ids.has(key))
      throw new RangeError("Invalid or duplicate discount source");
    ids.add(key);
    const amount = discountAmount(basePrice, code, item.discount);
    if (
      amount > saving ||
      (amount > 0 &&
        amount === saving &&
        candidate &&
        ((item.source === "promotion" && candidate.source === "coupon") ||
          (item.source === candidate.source && item.id < candidate.id)))
    ) {
      candidate = item;
      saving = amount;
    }
  }
  return { candidate, saving };
}

export interface AppointmentPromotion {
  readonly id: string;
  readonly organizationId: string;
  readonly label: string;
  readonly isActive: boolean;
  /** Appointment start must be in [startsAt, endsAt), regardless of booking creation time. */
  readonly startsAt: Date;
  readonly endsAt: Date;
  /** Explicit selection only: an empty list applies to no services. */
  readonly eventTypeIds: readonly string[];
  readonly discount: PromotionDiscount;
}

export interface AppliedPromotion {
  readonly id: string;
  readonly label: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly discount: PromotionDiscount;
}

export interface AppointmentCoupon {
  readonly id: string;
  readonly organizationId: string;
  readonly code: string;
  readonly label: string | null;
  readonly isActive: boolean;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly eventTypeIds: readonly string[];
  readonly minimumBasePrice: number | null;
  readonly discount: DiscountRule;
}

export interface AppliedCoupon {
  readonly id: string;
  readonly code: string;
  readonly label: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly minimumBasePrice: number | null;
  readonly discount: DiscountRule;
}

interface PriceSnapshot {
  readonly version: 1 | 2;
  readonly organizationId: string;
  readonly eventTypeId: string;
  /** The appointment instant priced, retained even if a booking is later moved. */
  readonly appointmentStartsAt: string;
  /** Amounts are integer currency minor units, never display amounts. */
  readonly basePrice: number;
  /** Service value after promotions, NOT a deposit, amount paid, or instruction to charge. */
  readonly effectivePrice: number;
  readonly currency: string;
  /** Amount quoted for collection after capping a fixed deposit; zero for credits. */
  readonly amountToCollect: number;
}

export type AppointmentPrice = PriceSnapshot &
  (
    | {
        readonly settlement: "cash";
        readonly promotion: AppliedPromotion | null;
        readonly coupon?: AppliedCoupon | null;
      }
    | { readonly settlement: "package_credit"; readonly promotion: null; readonly coupon?: null }
  );

export interface AppointmentPricingInput {
  /** These values must be loaded by the server, never accepted as a client's quote. */
  readonly eventType: {
    readonly id: string;
    readonly organizationId: string;
    readonly price: number | null;
    readonly currency: string | null;
    readonly depositAmount?: number | null;
  };
  readonly appointmentStartsAt: Date;
  /** Chosen by the server. Credit balance validation/consumption belongs in the booking transaction. */
  readonly settlement: "cash" | "package_credit";
  readonly promotions: readonly AppointmentPromotion[];
  /** Server-verified candidate. Eligibility is repeated here to keep pure pricing safe. */
  readonly coupon?: AppointmentCoupon | null;
}

// Fits existing PostgreSQL integer money columns; also keeps basis-point arithmetic exact.
const MAX_AMOUNT = 2_147_483_647;

function validateAmount(amount: number): void {
  if (!Number.isInteger(amount) || amount < 0 || amount > MAX_AMOUNT) {
    throw new RangeError("Price and discount amounts must be nonnegative PostgreSQL integers");
  }
}

function currencyCode(currency: string): string {
  if (!/^[a-z]{3}$/i.test(currency)) throw new RangeError("Currency must be a three-letter code");
  return currency.toLowerCase();
}

function instant(date: Date): number {
  const ms = date.getTime();
  if (!Number.isFinite(ms))
    throw new RangeError("Pricing requires valid appointment/promotion times");
  return ms;
}

function discountAmount(basePrice: number, currency: string, discount: PromotionDiscount): number {
  switch (discount.kind) {
    case "percentage": {
      const bps = discount.basisPoints;
      if (!Number.isInteger(bps) || bps <= 0 || bps > 10_000) {
        throw new RangeError("Percentage discount must be 1–10000 basis points");
      }
      // Round the discount half up to a minor unit (1 basis point = 0.01%).
      return Math.floor((basePrice * bps + 5_000) / 10_000);
    }
    case "fixed": {
      validateAmount(discount.amount);
      if (discount.amount === 0) throw new RangeError("Fixed discount must be positive");
      return currencyCode(discount.currency) === currency
        ? Math.min(basePrice, discount.amount)
        : 0;
    }
    default:
      throw new RangeError("Unknown promotion discount kind");
  }
}

/**
 * Select the largest SINGLE eligible discount. Equal savings use the ascending
 * promotion id (code-point order), so query order cannot change the result.
 * Zero-saving rules are not recorded as applied promotions.
 *
 * Package credits bypass promotions: effectivePrice retains the base service
 * value, settlement is package_credit, and NO cash should be collected. A 100%
 * cash discount stays settlement=cash; it must never imply credit redemption.
 *
 * The result is a detached, JSON-safe snapshot for future persistence. This
 * function does not authorize a booking, reserve a price, or charge a payment.
 */
export function calculateAppointmentPrice(input: AppointmentPricingInput): AppointmentPrice {
  const { eventType } = input;
  if (!eventType.id || !eventType.organizationId)
    throw new RangeError("Event type scope is required");
  const appointment = instant(input.appointmentStartsAt);
  const basePrice = eventType.price ?? 0;
  validateAmount(basePrice);
  const currency = currencyCode(eventType.currency ?? "usd");
  const deposit = eventType.depositAmount ?? 0;
  validateAmount(deposit);
  const snapshot: PriceSnapshot = {
    version: 1,
    organizationId: eventType.organizationId,
    eventTypeId: eventType.id,
    appointmentStartsAt: input.appointmentStartsAt.toISOString(),
    basePrice,
    effectivePrice: basePrice,
    currency,
    amountToCollect: 0,
  };

  if (input.settlement === "package_credit") {
    return { ...snapshot, settlement: "package_credit", promotion: null };
  }
  if (input.settlement !== "cash") throw new RangeError("Unknown appointment settlement");

  const candidates: (
    | (AppointmentPromotion & { readonly source: "promotion" })
    | (AppointmentCoupon & { readonly source: "coupon" })
  )[] = [];
  const ids = new Set<string>();
  for (const promotion of input.promotions) {
    if (
      !promotion.isActive ||
      promotion.organizationId !== eventType.organizationId ||
      !promotion.eventTypeIds.includes(eventType.id)
    ) {
      continue;
    }
    if (!promotion.id || !promotion.label.trim())
      throw new RangeError("Promotion id and label are required");
    if (ids.has(promotion.id)) throw new RangeError("Duplicate promotion id in pricing input");
    ids.add(promotion.id);
    const from = instant(promotion.startsAt);
    const to = instant(promotion.endsAt);
    if (to <= from) throw new RangeError("Promotion end must follow its start");
    const amount = discountAmount(basePrice, currency, promotion.discount);
    if (appointment < from || appointment >= to || amount === 0) continue;
    candidates.push({ ...promotion, source: "promotion" });
  }

  const coupon = input.coupon;
  if (coupon) {
    validateAmount(coupon.minimumBasePrice ?? 0);
    if (
      coupon.isActive &&
      coupon.organizationId === eventType.organizationId &&
      coupon.eventTypeIds.includes(eventType.id) &&
      basePrice >= (coupon.minimumBasePrice ?? 0) &&
      appointment >= instant(coupon.startsAt) &&
      appointment < instant(coupon.endsAt) &&
      discountAmount(basePrice, currency, coupon.discount) > 0
    ) {
      candidates.push({ ...coupon, source: "coupon" });
    }
  }

  const { candidate: selected, saving } = selectBestDiscount(basePrice, currency, candidates);
  const selectedPromotion = selected?.source === "promotion" ? selected : null;
  const selectedCoupon = selected?.source === "coupon" ? selected : null;
  return {
    ...snapshot,
    version: selectedCoupon ? 2 : 1,
    settlement: "cash",
    effectivePrice: basePrice - saving,
    amountToCollect: deposit > 0 ? Math.min(deposit, basePrice - saving) : basePrice - saving,
    promotion: selectedPromotion
      ? {
          id: selectedPromotion.id,
          label: selectedPromotion.label,
          startsAt: selectedPromotion.startsAt.toISOString(),
          endsAt: selectedPromotion.endsAt.toISOString(),
          discount:
            selectedPromotion.discount.kind === "fixed"
              ? {
                  ...selectedPromotion.discount,
                  currency: currencyCode(selectedPromotion.discount.currency),
                }
              : { ...selectedPromotion.discount },
        }
      : null,
    ...(selectedCoupon
      ? {
          coupon: {
            id: selectedCoupon.id,
            code: selectedCoupon.code,
            label: selectedCoupon.label,
            startsAt: selectedCoupon.startsAt.toISOString(),
            endsAt: selectedCoupon.endsAt.toISOString(),
            minimumBasePrice: selectedCoupon.minimumBasePrice,
            discount:
              selectedCoupon.discount.kind === "fixed"
                ? {
                    ...selectedCoupon.discount,
                    currency: currencyCode(selectedCoupon.discount.currency),
                  }
                : { ...selectedCoupon.discount },
          },
        }
      : {}),
  };
}
