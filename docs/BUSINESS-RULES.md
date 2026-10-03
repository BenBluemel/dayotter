# Pricing, payment, and booking business rules

Status: business decisions recorded against validated Slice 5 commit
`7ff1a9a8eac39151ae76db0dfc3bc50535542348`, on `feature/payment-routing`.
Slice 6 enforces the shared pricing contract across new service-booking paths.
This work does not enable production payments or implement coupon redemption.

This is the product source of truth. Implementation must preserve these rules;
changes to product policy must update this document. Technical contracts belong
in [PRICING-ARCHITECTURE.md](PRICING-ARCHITECTURE.md) and
[PAYMENTS-ARCHITECTURE.md](PAYMENTS-ARCHITECTURE.md). Promotion-specific schema
references belong in [APPOINTMENT-PROMOTIONS.md](APPOINTMENT-PROMOTIONS.md).

## Reading implementation status

- **CURRENT / IMPLEMENTED:** behavior exists in the inspected code, within the
  stated paths. This does not mean production payments are enabled.
- **DECIDED / NOT YET IMPLEMENTED:** approved behavior that implementation must
  follow, but is not available yet or not consistent across every entry point.
- **FUTURE / DEFERRED:** additional work or ideas without an implemented contract.
- **UNRESOLVED:** a product or architecture question requiring a decision.

## Pricing

**CURRENT:** Services have a base price. The public appointment booking path
determines an effective price from eligible automatic promotions. Accepted
pricing is historical: later service-price, promotion, deposit, or payment
configuration changes do not rewrite a saved quote or an existing booking's
financial history. These guarantees cover the new public cash/package paths;
new direct/API and staff service bookings now save the shared pricing history.
Staff/API paths without a collection workflow reject positive cash. Hidden
Personal and internal team meetings remain explicitly noncommercial; legacy
bookings are not assigned invented historical quotes.

**DECIDED:** All commercial booking entry points must respect the same pricing
contract. A missing historical quote must not be interpreted as a free booking.
The customer does not choose the final price by sending an amount to the server.

## Automatic promotions

**CURRENT:** Promotions apply automatically without a customer code. They can
offer a configurable percentage or fixed discount, target selected services,
and have validity windows. No percentage, including 50%, is hardcoded.

When several promotions qualify, use the single promotion giving the customer
the greatest savings. Discounts do not stack. Current eligibility uses the
original appointment start, rather than when the customer submits the booking.
For example, an October 1–31 window covers appointments occurring in October,
regardless of when they are booked. Stored windows exclude the end instant; an
inclusive October 31 date is represented by the next local-day boundary.
A fixed discount must use the service's currency and cannot make its price
negative. The promotion's end boundary is excluded.

**FUTURE / DEFERRED:** A promotion-management interface and convenient calendar
date entry. These are not included in the implemented promotion foundation.

## Coupons

**DECIDED / NOT YET IMPLEMENTED:** A coupon is an explicit code supplied by a
customer or staff member. Planned capabilities include percentage/fixed
discounts, validity dates, service restrictions, an optional minimum purchase,
unlimited use, global use limits, and per-customer use limits.

Coupons and automatic promotions participate in the same pricing system. The
single valid discount giving the greatest savings wins; there is no default
stacking. A coupon that loses to a better promotion must not consume a coupon
use merely because its code was submitted. No coupon model, code-entry flow,
usage ledger, or coupon-restoration behavior is implemented yet.

Minimum-purchase eligibility uses the regular/base service price, not discounted
price or deposit. Codes are trimmed and case-insensitive: `FRIEND50`, `friend50`,
and `" Friend50 "` identify the same code. If a coupon and an automatic promotion
give exactly the same best price, prefer the automatic promotion and preserve
the coupon use. Coupons require an authenticated customer; guest redemption is
not supported.

## Coupon usage and cancellation

**DECIDED / NOT YET IMPLEMENTED:** Limited or one-time coupon redemption belongs
to the booking that used it. Moving that booking does not consume another use.
Cancellation restores the consumed use exactly once, including the customer's
per-customer allowance. Retries or repeated cancellation cannot restore twice.

Future limited-use coupons may have global and/or per-customer limits. Reserve
scarce capacity safely during Checkout and release it when Checkout is abandoned.
Successful booking consumes the reservation; cancellation restores it once;
rescheduling preserves it. Expiration/abandonment must be established safely so
a delayed successful payment is not discarded or assigned released capacity.

Unlimited coupons do not need scarce-use counting, but the booking still records
why its discount applied. Restoring a use does not reactivate an expired or
disabled coupon. Cancellation followed by a genuinely new booking performs a
fresh eligibility and redemption check; it does not inherit the cancelled
booking's discounted price.

Coupon-use restoration and returning cash are different operations. Future
implementation must preserve both obligations without claiming a cash refund
has completed merely because a coupon use was restored.

## Rescheduling

**CURRENT:** Moving the same booking preserves its agreed price and original
promotion attribution. Promotion eligibility is not evaluated again, even if
the replacement appointment is outside the original promotion window. Payments,
deposits, and package redemption stay attached to that same booking. Moving it
does not itself charge, refund, redeem, or restore value.

**DECIDED:** The same rule applies to future coupon-paid discounts and to
unpaid but price-locked, partially paid, fully paid, $0, and package-settled
bookings. Availability, authorization, and existing scheduling restrictions
still apply. Price preservation is not a guarantee that every requested time
is bookable.

**There is no grace-count or free-reschedule counter requirement.** This decision
supersedes the earlier one-free-move proposal and any instruction to reprice
unpaid appointments on reschedule. Do not introduce a counter, allowance
exhaustion rule, or automatic price adjustment to implement this policy.

## Packages

**CURRENT:** A package credit is an alternative settlement method, not another
discount to stack. A package-settled appointment consumes one authorized credit
and collects no cash; it does not also apply a cash promotion. Rescheduling
preserves the original redemption. Cancellation restores that exact credit once.

New entitlements belong to a verified internal customer account. Supplying an
email address, including someone else's email, does not prove ownership. Staff
can grant credits through an authorized path to a verified recipient.

Package purchases save their own price and credit quantity, and grant credits
only after verified payment success. Appointment promotions do not implicitly
discount package purchases. Duplicate payment delivery cannot grant twice.

**CURRENT COMPATIBILITY LIMIT:** Historical email-only balances remain visible,
but automatic spending/restoration is blocked when ownership or the original
redemption cannot be proven. Manual review is needed; old balances are not
silently reassigned or erased.

**FUTURE / DEFERRED:** Ownership-resolution tools, package purchase refunds with
credit revocation, partially consumed package refund policy, and dispute handling.

## Deposits and $0 bookings

**CURRENT:** Calculate the discounted effective service price first. A configured
positive fixed deposit is capped at that effective price; without a positive
deposit, collect the effective price. A deposit cannot exceed the effective
price. The amount collected and the full service value are different facts.
Automatic collection of a remaining balance is not implemented.

A legitimate 100% discount can produce a $0 booking. It requires no Stripe
payment, including a bookkeeping-only payment. Keep the pricing explanation and
history. A $0 cash booking is not a package redemption and does not invent a
successful cash payment.

## Cancellation versus a new booking

**CURRENT:** Reschedule means the same booking and financial lineage. Cancellation
reverses the proven settlement under the existing refund/restoration policy.
For new durable cash bookings, cancellation records an owed refund before Stripe
work; a pending refund is not reported as completed. For new package bookings,
cancellation and exact credit restoration commit together.

**DECIDED:** Cancellation followed by a genuinely new booking means current
pricing and fresh promotion/coupon eligibility. Reuse of a cancelled booking's
retry identity is not a new purchase or booking. A new operation needs its own
identity. Never implement an ordinary move as cancellation plus an unrelated
new booking that loses the original financial relationships.

## Recurring financial bookings

**CURRENT:** Package-paid recurring creation is blocked. The new public cash
path blocks commercial recurring series where one payment would otherwise fund
multiple occurrences; host-owned group-slot exceptions remain (they do not
expand into a series).
Staff commercial series are blocked too, including 100%-discounted services.
Free-service occurrence expansion saves separate zero-cash quotes and refuses
commercial prices; historical series are not retroactively allocated payments.

**DECIDED:** One payment or credit must not authorize multiple independently
chargeable occurrences. Unsupported financial series must fail closed until
explicit per-occurrence settlement/allocation exists. A future genuine occurrence
gets its own pricing decision; moving an existing occurrence retains its history.

**FUTURE / DEFERRED:** Recurring collection, credit allocations, and partial-series
cancellation/refund policy.

## Unresolved decisions

- Coupon validity clock: appointment start, booking acceptance time, or another
  explicitly defined time; promotion eligibility currently uses appointment start.
- Coupon eligibility for package purchases is not decided; appointment minimums
  use base service price. Coupon validity clock remains unresolved separately
  from the finalized appointment-time promotion rule.
- Exact scarce-use reservation/release mechanics, abandoned Checkout evidence,
  delayed-payment races, and operator recovery need design before coupon runtime
  implementation. Reservation at Checkout and consumption at successful booking
  are decided; their failure handling must preserve exactly-once use/restoration.
- Staff/offline commercial booking policy and consistent approval behavior for
  $0 promotional bookings. Current public $0 bookings retain existing approval
  behavior; cash-paid and package bookings bypass approval.
- Business timezone ownership and inclusive calendar-date input for promotion
  management; current stored windows are explicit instants.
- Remaining-balance collection and recurring/package refund policies described
  above. None is implicitly authorized by documenting the current rules.
