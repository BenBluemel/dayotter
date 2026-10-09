# Pricing architecture and accepted-quote contract

Status: Slice 7 adds authenticated appointment coupons to the Slice 6
accepted-quote foundation. Production payments remain unchanged.

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

Public `/api/book` can use an authorized package credit as an alternative
settlement. Explicit coupon and credit selection are mutually exclusive; a
submitted coupon proceeds through cash pricing, including a $0 effective price.
No package credit is consumed because a coupon lowers the price.

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

Migration `0069_appointment_coupons.sql` adds version-2 coupon attribution to
the same booking snapshot and payment-attempt quote. It copies the coupon ID,
code, label, window, discount kind/value/currency, and minimum beside base,
effective, quoted collection, currency, and priced appointment instant. Later
definition edits cannot reinterpret this history. Do not backfill legacy quotes.

## Discount sources and selection

**CURRENT:** `quoteAppointmentPrice` reads server-owned service price and eligible
organization promotions; an authenticated coupon code is normalized and looked
up in that same organization. It checks active state, selected service, original
appointment start in `[startsAt, endsAt)`, base-price minimum, and fixed-currency
match. The pure `calculateAppointmentPrice` function submits promotion and coupon
candidates to `selectBestDiscount`. Greatest single saving wins; promotion wins
an exact cross-source tie; same-source ties use stable ID order. Nothing stacks.
A losing coupon has no use or attribution. Zero-saving coupons cannot be applied.

The client receives only an advisory preview of base/effective/due-now amounts;
checkout and $0 booking revalidate on the server. Positive-cash checkout saves
its exact quote before Stripe. Fulfillment copies that quote, not a fresh lookup.
The booking snapshot and attempt JSON carry `version=2` for a winning coupon;
version-1 promotion and undiscounted quotes remain compatible. The database
checks coupon arithmetic, scope, and source exclusivity. Code normalization is
`trim().toUpperCase()` with a unique `(organization_id, code)` index plus a
canonical-code CHECK. Coupon authorization uses the authenticated user ID, never
attendee email.

## Coupon reservation, redemption, and restoration

**CURRENT:** `appointment_coupons` stores definitions and UTC date bounds plus
the business timezone used to convert inclusive local dates. The organization
setting defaults to `America/Boise`. `appointment_coupon_event_types` scopes
services. `appointment_coupon_uses` records stable request identity, user,
coupon, organization, service, payment attempt or booking, and one state:
`reserved`, `redeemed`, `released`, or `restored`. Unlimited coupons retain uses
but skip allowance counting. PostgreSQL locks the definition row and counts
active reserved/redeemed uses for global and per-customer limits before insert.
There is no authoritative mutable uses counter. Unique operation, attempt, and
booking keys, foreign keys, CHECKs, and triggers constrain direct mutations.
Deferred database checks require every accepted coupon checkout quote to own a
reservation, every coupon-priced booking to own its matching use, and cancelled
coupon bookings to own exactly one completed restoration. They reject a partial
financial commit even if an application path omits a write.

A positive-cash attempt reserves capacity in the same transaction as its saved
quote. Response loss retries the same attempt. On verified fulfillment, booking,
immutable snapshot, and reserved-to-redeemed transition commit together. $0
cash bookings create the snapshot and redeemed use in their booking transaction,
without Stripe. Expired or async-failed terminal attempts release once; payment
recovery sweeps terminal reservations if the process stopped between commits.
An ambiguous checkout remains held for existing payment reconciliation because
a late paid obligation must not be assigned released capacity.

The existing cancellation decision transaction inserts one
`appointment_coupon_restorations` row referencing the original use and moves it
to `restored`; duplicate/retried cancellation converges. This frees both scopes
without changing the definition's active flag or dates. The cash refund
obligation remains separate. Rescheduling touches neither snapshot nor use,
regardless of a moved date or edited/expired definition. A new booking starts a
new eligibility decision. Unsupported recurring commercial coupon series fail
closed until recurring finance is defined.

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
unpaid price-locked, deposit-paid, fully paid, $0, and coupon bookings.
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

Coupon management accepts inclusive local calendar dates. The organization
business timezone defaults to `America/Boise` and can be changed by an owner/admin.
The server converts the first date's local midnight and the midnight after the
last date into UTC instants using calendar-aware timezone rules, including DST.
The saved UTC bounds and timezone remain fixed if the organization setting later
changes. Coupon eligibility uses appointment start, with the same `[startsAt,
endsAt)` semantics as promotions.

## Concurrency, retry, and recurring boundaries

**CURRENT:** Quotes read coherent configuration; cash intent preparation uses
stable identity, input fingerprint, immutable saved terms, and bounded database
retries. Stripe requests use stable identity outside retried database work.
Fulfillment verifies saved amount/currency/routing/identifiers and commits one
booking. Package redemption and restoration use PostgreSQL locks/constraints.
See the payment architecture for exact lifecycle/recovery behavior.

**DECIDED:** Future pricing entry points and coupon mutations must preserve these
guarantees. Coupon mutations serialize with reservations and cannot replace an
already accepted quote. Concurrent administration edits must not produce
mixed-revision quotes.
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
| Coupons | Authenticated public booking preview and entry, owner/admin management, shared pricing, durable use/reservation/restoration and saved attribution are implemented; staff entry and package-purchase discounts are deferred. |
| Recurring creation | Financial guards cover public/direct/staff commercial creation; free occurrences save quotes; funded recurring architecture remains deferred. |

Slice 6 deliberately retains version-1 promotion snapshots/attempts and the
Slice 1–6 cash/credit/refund guarantees remain intact. Coupon uses are separate
from package credits and cash settlement. Ambiguous payment reconciliation holds
scarce reservations until the existing payment workflow proves a terminal state.
