# Pricing architecture and accepted-quote contract

Status: Slice 6 extends the validated Slice 1–5 financial foundation and its
business-rule documentation checkpoint. New public/direct/API/staff service
creation uses authoritative pricing. Coupons have shared arithmetic/normalization
primitives only; runtime eligibility, reservations, redemption, and UI remain
unimplemented. Production payments are not enabled.

## Business-rule authority and document boundaries

Implementation must preserve [BUSINESS-RULES.md](BUSINESS-RULES.md). Update that
document when a business rule changes, then reconcile this technical contract
and [PAYMENTS-ARCHITECTURE.md](PAYMENTS-ARCHITECTURE.md). A historical audit or an
older implementation prompt does not override the current business rules.

This document owns pricing and accepted-term semantics. The payment document
owns routing, durable payment/refund obligations, settlement verification,
package-credit integrity, and crash recovery. [APPOINTMENT-PROMOTIONS.md](APPOINTMENT-PROMOTIONS.md)
provides promotion-specific schema, migration, and test navigation.

Labels **CURRENT**, **DECIDED / NOT YET IMPLEMENTED**, and **FUTURE / DEFERRED**
have the meanings defined in the business rules. Policy applies beyond current
coverage; the coverage gaps below must not be read as implemented functionality.

## Current authoritative pricing pipeline

1. Authorize booking intent and organization/service access; select settlement
   on the server. Prices, promotion choice, and internal financial identity are
   not public request inputs.
2. `apps/web/lib/booking/pricing.ts:quoteAppointmentPrice` reads the active service
   and eligible organization-scoped promotion links in one SQL statement.
   PostgreSQL therefore supplies one coherent committed pricing view, even under
   READ COMMITTED. Cash attempt preparation additionally uses repeatable read
   with bounded retries to keep service, duration, and merchant decisions coherent.
3. `packages/core/src/pricing.ts:calculateAppointmentPrice` computes a detached
   quote using pure domain logic. It does not book, charge, authorize a credit,
   or consult a clock outside its explicit appointment input.
4. For positive cash, `payments/attempts.ts:prepareAppointmentAttempt` saves the
   quote, canonical hash, durable encrypted booking intent, resolved duration,
   and original routing facts before Stripe Checkout creation.
5. Verified fulfillment uses that saved quote; it never runs promotion selection
   again. Booking creation locks/binds the attempt and persists the pricing
   snapshot before applying verified settlement, in one transaction.
6. Zero-cash bookings skip Stripe. Public preparation can preview a free quote,
   but booking creation requotes within its transaction before accepting and
   persisting the snapshot. Public/direct/API creation also claims the stable
   operation as `zero_cash` in that transaction; retries return its original
   booking. Package booking creates its credit snapshot and redemption in the
   same booking transaction. Neither is proof of a cash payment.

Current public `/api/book` can automatically prefer an available authorized
package credit before calculating a new cash quote; explicit redemption also
requires a verified owner. This existing settlement-selection behavior is not
an implemented coupon-versus-credit comparison or a redesigned public UI.

## Price and settlement vocabulary

| Fact | Contract |
| --- | --- |
| `basePrice` | Original service price loaded from configuration for this pricing decision. |
| `effectivePrice` | Service value after the single selected cash discount; never the deposit or amount paid. |
| `currency` | Normalized three-letter code; fixed discounts must match it. |
| `amountToCollect` | Server-quoted current cash collection after deposit capping, or zero for package settlement. Not payment evidence. |
| Accepted quote | Durably saved authoritative terms bound to a business operation; a transient preview alone is not accepted history. |
| Captured amount / payment facts | Authoritative verified Stripe settlement, recorded separately from service value. |
| Pricing snapshot | Detached immutable booking-linked copy of the accepted pricing explanation. No row means legacy/unpriced, not free. |

**CURRENT:** Amounts use integer currency minor units bounded by existing
PostgreSQL integer columns. Percentage discounts use 1–10000 basis points,
including a legitimate 100% discount. Round the saving half up to a minor unit:
`floor((basePrice * basisPoints + 5000) / 10000)`. Fixed savings are capped at
base price; wrong-currency rules produce no eligible saving. Zero-saving rules
are not recorded as an applied promotion.

After selecting the saving, `effectivePrice = basePrice - saving`. A positive
configured fixed deposit produces `min(depositAmount, effectivePrice)`; otherwise
collection is the effective price. No automatic remaining-balance collection
exists. Refund amount comes from captured payment facts, not recalculated price.

## Immutable financial history

**CURRENT:** `packages/db/src/schema/booking-pricing.ts:bookingPricingSnapshots`
and migration `0063_appointment_promotions.sql` store base/effective price,
currency, quoted collection, settlement, original priced appointment instant,
and copied promotion identity/label/window/discount rule. Attribution is not a
join to a mutable promotion; deleting or editing that promotion cannot rewrite
the saved explanation. UPDATE and direct DELETE are guarded. The original schema
allows parent booking deletion to cascade snapshots; durable financial bindings
add their own deletion restrictions. New claimed zero-cash bookings also reject
additional snapshots that would replace their accepted quote. Legacy uncollected
revision history remains intact. Do not claim all legacy history is undeletable.

`persistBookingPricingSnapshot` locks and validates booking scope/start and
refuses to attach a fresh quote to an already settled booking. Snapshot and
settlement ordering is mandatory. Explicit pre-settlement revision primitives
exist, but ordinary rescheduling must not use them to reprice. A separate
financial-adjustment workflow is deferred.

Future discount-source and coupon attribution must preserve this contract;
current snapshot/attempt types are promotion-specific and cannot represent a
coupon by pretending it is a promotion. Extend them deliberately when coupon
work is authorized. Do not backfill missing legacy quotes from today's prices.

## Discount sources and selection

**CURRENT:** `AppointmentPromotion`, `PromotionDiscount`, `AppliedPromotion`,
and `AppointmentPrice` represent automatic promotions only. Eligibility requires
an active rule, matching organization, explicitly selected service, and an
appointment start in its window. An empty service selection applies nowhere.
Greatest single saving wins; ties use ascending stable promotion ID. No stacking.

**CURRENT arithmetic boundary:** `DiscountRule`, `DiscountCandidate`, and
`selectBestDiscount` in `packages/core/src/pricing.ts` support already eligible
promotion/coupon candidates. Automatic pricing uses this helper now; larger
saving wins, promotion wins cross-source ties, and stable IDs break same-source
ties. `normalizeCouponCode` implements `trim().toUpperCase()` identity only.
These pure helpers neither authenticate customers nor reserve/redeem coupons.

**DECIDED / NOT YET IMPLEMENTED:** Runtime coupon eligibility must join the
existing promotion evaluation through that same pricing contract. Keep
eligibility separate from pure discount arithmetic and settlement. Each valid
candidate contributes its source identity/type, copied explanation/rule, and
computed saving. Choose the greatest single valid saving and persist the chosen
source; do not add promotion and coupon savings together. Accepted coupon
attribution and schema evolution remain future implementation design. Equal savings across
sources prefer the automatic promotion, preserving the coupon use.
Future candidates must be validated server-side in the same organization and
service scope; a submitted code is not authority for a price or ownership claim.

Coupon eligibility will support percent/fixed amounts, dates, service scope,
optional minimum purchase, and optional global/per-customer limits. There is
currently no coupon table, input, evaluator, accepted attribution, or use ledger.
Minimum-purchase eligibility tests base service price. Canonical codes use
`code.trim().toUpperCase()` so case and surrounding whitespace do not create
separate identities; enforce scoped canonical uniqueness when a coupon schema
is implemented. Coupon redemption requires an authenticated customer, never a
guest or supplied email alone. The unresolved eligibility questions are listed
in the business rules. Package credit remains a settlement choice, not a
candidate cash discount.

## Future coupon-use provenance

**DECIDED / NOT YET IMPLEMENTED:** The chosen limited coupon needs a durable
booking-linked use with stable operation identity and authoritative customer
scope where per-customer limits apply. A code that loses discount selection does
not consume a use. Global and customer limit checks/mutations must be atomic in
PostgreSQL across application instances; read-then-decrement in application code
or Redis is insufficient.

Cancellation must identify the original consumed use and restore both global
and per-customer allowances exactly once, transactionally with the local
cancellation decision where possible. Unique reversal identity and immutable
source/owner/booking/quantity facts must prevent double restore and lost restore.
Do not derive restoration from current coupon configuration. Unlimited coupons
retain accepted attribution/provenance without unnecessary scarce-use arithmetic.
Restoration never changes the coupon's active flag or validity dates.

Rescheduling preserves the same use. A genuine new booking performs fresh
selection and redemption. Reserve scarce global/customer capacity during
Checkout, release it after authoritative abandonment/expiration, and consume it
with successful booking. Database-backed reservation identity and safe delayed-
payment/release coordination need an explicit design before runtime implementation;
saved pricing alone cannot guarantee scarce availability.
Coupon restoration must not erase or replace a pending cash RefundOperation.

## $0 and package settlement

**CURRENT:** A 100% cash promotion may create a $0 quote. Public booking saves its
cash snapshot/discount attribution without a Stripe Session or PaymentAttempt;
it retains existing approval behavior and does not invent paid cash status.
Disabled sales mode rejects positive cash but does not require Stripe for $0.

For `package_credit`, current pricing keeps `effectivePrice = basePrice`, applies
no cash promotion, and sets `amountToCollect = 0`. Verified ownership,
redemption/booking atomicity, exact cancellation restoration, and purchase
fulfillment belong to the payment architecture. A missing PaymentIntent or zero
collection amount must never be used to infer that a credit was consumed.

**CURRENT:** `booking/zero-cash.ts` uses the same appointment operation key and
input fingerprint as cash/credit. `createBooking` locks that identity, creates
booking + immutable snapshot + `zero_cash` settlement claim atomically, and
returns a committed original before consulting mutable prices/availability.
Migration `0068_zero_cash_booking.sql` extends the shared claim, checks zero cash
against its immutable snapshot, and protects claimed booking identity/settlement.
No Stripe attempt is needed for a transaction that creates a free booking.
A cash, credit, or zero-cash operation cannot independently settle the same key.
Old callers retain exact-input deduplication; a genuinely new booking after
cancellation must supply a fresh `checkoutRequestId`.

Staff service creation also quotes and commits snapshot/attendees with booking.
It has no positive-cash collection workflow, so it rejects positive collection
and commercial recurring series. An explicit missing/foreign service cannot
silently fall back to a Personal meeting. Hidden Personal/internal team meetings
remain noncommercial and are guarded against acquiring a paid Personal service
configuration; they do not invent commercial pricing history.

**CURRENT LIMITATION:** Zero-cash creation, free recurring expansion, and staff
calendar/email/reminder delivery are not a universal durable outbox. An operation
retry returns DB booking truth without replaying external effects. Staff ad-hoc
creation also has no new request-id API in this slice. Provider-effect recovery
and approved commercial offline workflows remain separate work.

## Rescheduling and new financial lineage

**CURRENT + DECIDED CONTRACT:** `booking/reschedule-booking.ts:rescheduleBooking`
moves the same booking while retaining its actual duration and financial facts.
It does not quote again, change accepted attribution, create a PaymentAttempt,
refund/recharge, or restore/redeem a package credit. Preserve that behavior for
unpaid price-locked, deposit-paid, fully paid, $0, and future coupon bookings.
The snapshot's priced appointment instant remains the original decision instant;
it need not equal the booking's later scheduling start.

There is **no grace-count or free-reschedule counter requirement**. The old
one-free-move proposal and unpaid-reschedule repricing guidance are superseded.
Continue enforcing availability, authorization, cancelled-booking guards, and
package-finalization review restrictions. Repeated moves must not mutate financial
relationships. Current scheduling/provider effects are not a durable idempotent
move workflow; simultaneous competing moves and effect reconciliation remain
separate technical concerns, not a reason to reprice or add an allowance.

Cancellation plus a genuinely new booking uses a new operation identity and
current eligibility. Retrying an existing payment/redemption operation returns
its historical result; it must not masquerade as a new booking or transfer the
cancelled discount to an unrelated lineage.

## Timezones and validity windows

**CURRENT:** Promotion bounds are finite UTC instants with start inclusive and
end exclusive: `[startsAt, endsAt)`. Eligibility uses the original appointment
start; customer booking time is irrelevant. Snapshots retain the original bounds
and priced instant. Fixed discounts carry matching currency; links enforce
same-organization service/promotion scope.

**FUTURE / DEFERRED:** A date-entry UI may offer inclusive business calendar dates,
converted to the corresponding UTC instants using an explicitly chosen business
timezone. Compute local next-day boundaries with calendar-aware timezone rules,
including DST; do not add 24 hours blindly. Business-timezone ownership and date
entry are unresolved. Coupon eligibility must not silently inherit appointment-
time semantics before its validity-clock decision is made.

## Concurrency, retry, and recurring boundaries

**CURRENT:** Quotes read coherent configuration; cash intent preparation uses
stable identity, input fingerprint, immutable saved terms, and bounded database
retries. Stripe requests use stable identity outside retried database work.
Fulfillment verifies saved amount/currency/routing/identifiers and commits one
booking. Package redemption and restoration use PostgreSQL locks/constraints.
See the payment architecture for exact lifecycle/recovery behavior.

**DECIDED:** Future pricing entry points and coupon mutations must preserve these
guarantees. Concurrent administration edits must not produce mixed-revision
quotes; configuration changes cannot replace an already accepted quote.
Contradictory saved/payment facts fail closed for recovery/review. Never weaken
an invariant to handle a stale or retried request.

Package recurring creation is rejected in application and database guards.
`prepareAppointmentAttempt` and `createBooking` block commercial recurring series
when `basePrice > 0`, `recurringCount > 1`, and the service is not a host-owned
group slot (`maxAttendees > 1`); this includes a 100%-discounted commercial series.
The group-slot exception is not a funded recurring series, and legacy/internal
records are not retroactively repaired. Staff service series reject positive
base price too. `finalize-booking.ts:finalizeOccurrence` atomically saves a zero
quote with each new free-service occurrence and rejects positive base prices,
including a paid service edited after initial series creation. This is a free
scheduling path, not financial allocation for recurring paid services.

Unsupported paid/credit series must remain blocked until explicit occurrence
settlement exists. Future genuine occurrences need their own pricing decision;
moving an existing occurrence keeps its original terms. Series collection,
allocation, and partial cancellation are deferred, not implemented by this
contract or authorized by the presence of a recurring scheduling feature.

## Coverage and next implementation boundaries

| Entry point | CURRENT coverage / remaining boundary |
| --- | --- |
| `/api/book` + `prepareAppointmentAttempt` | Saved positive-cash quotes, promotion/deposit calculation, verified durable fulfillment; $0 snapshot with shared stable operation claim. |
| `createBooking` package path | Verified owner, coherent credit quote, immutable snapshot and atomic redemption; no cash promotion stacking. |
| Package purchase | Independent saved package price/count; appointment promotions are not applied to its sale. |
| `/api/v1/bookings` | Authorizes caller-owned service; delegates authoritative quote/snapshot to `createBooking`, allows zero effective cash, rejects positive collection; supports `checkoutRequestId`. |
| `host-booking.ts:createHostBooking` / internal meetings | Commercial service quote/snapshot is atomic; positive collection requires public checkout. Personal/internal meetings remain noncommercial. Explicit service scope is enforced. |
| Reschedule | Same financial lineage; no repricing/counter; external-effect/move reconciliation is incomplete. |
| Coupons | Pure shared candidate selection/canonical code helper exists; runtime eligibility/usage remains deferred; business rules decided subject to listed unresolved questions. |
| Recurring creation | Financial guards cover public/direct/staff commercial creation; free occurrences save quotes; funded recurring architecture remains deferred. |

Slice 6 deliberately retains version-1 promotion snapshots/attempts and the
Slice 1–5 cash/credit/refund guarantees. Future coupon runtime must extend
accepted attribution and scarce-capacity provenance explicitly; a generic pure
candidate is not a persisted coupon entitlement.
