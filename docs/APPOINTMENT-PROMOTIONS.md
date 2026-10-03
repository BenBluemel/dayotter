# Automatic appointment promotions: implementation reference

Status: the promotion foundation originated on `feature/promotions` in migration
0063 and is integrated into the new public appointment cash/package pricing
paths through validated Slice 5 commit `7ff1a9a8eac39151ae76db0dfc3bc50535542348`
on `feature/payment-routing`. No promotion-management UI or coupon functionality
is implemented. Existing bookings are not backfilled. Production configuration
has not been changed or payments enabled by these slices.

## Contract and document boundaries

Implementation must preserve [BUSINESS-RULES.md](BUSINESS-RULES.md); policy changes
must update that document. [PRICING-ARCHITECTURE.md](PRICING-ARCHITECTURE.md) owns
eligibility, best-discount selection, accepted quotes, deposits, $0 handling, and
historical-price-preserving rescheduling. [PAYMENTS-ARCHITECTURE.md](PAYMENTS-ARCHITECTURE.md)
owns cash/package settlement, payment/refund durability, and recovery.

This document owns promotion-specific schema/migration and code navigation.
Earlier statements that public checkout is undiscounted, credits are authorized
by email, or unpaid reschedules should receive replacement quotes are obsolete.
There is no grace-count/free-reschedule counter requirement. Coupon support is
decided future work in the shared pricing contract; the promotion-only code does
not currently accept coupon codes.

## Current code map

Paths are relative to the repository root; function names are stable navigation
anchors. Behavior below describes the current code, not the original audit.

| Boundary | Current behavior |
| --- | --- |
| `packages/core/src/pricing.ts:calculateAppointmentPrice` | Pure automatic-promotion eligibility, greatest single saving, deterministic ties, rounding, deposit cap, separate cash/credit settlement. |
| `apps/web/lib/booking/pricing.ts:quoteAppointmentPrice` | One coherent SQL view of active organization-scoped service and selected promotions; server-owned quote. |
| `apps/web/lib/booking/pricing.ts:persistBookingPricingSnapshot` | Locks/validates scope and initial start; saves detached values before settlement. |
| `apps/web/app/api/book/route.ts:POST` | Resumes existing durable cash/credit operations; can prefer authorized credits; otherwise prepares cash quote, Checkout, or $0 booking. |
| `apps/web/lib/payments/attempts.ts:prepareAppointmentAttempt` | Saves positive-cash quote, resolved duration and original merchant routing before Stripe, under repeatable read. |
| `apps/web/lib/payments/payment-success.ts`, `payment-work.ts`, `payment-events.ts` | Verify canonical payment facts and fulfill from saved terms, not recalculated promotions. |
| `apps/web/lib/booking/create-booking.ts:createBooking` | Persists the saved cash snapshot before settlement; package branch quotes and persists credit snapshot with redemption atomically. |
| `apps/web/lib/packages/credits.ts` | Verified internal owner, durable grant/redemption/restoration provenance; never email-only entitlement spending. |
| `apps/web/lib/booking/reschedule-booking.ts:rescheduleBooking` | Moves the same booking without changing its financial snapshot or spending another credit. |
| `apps/web/lib/payments/refunds.ts:decideBookingCancellation` | Cancellation coordinates durable cash refund obligation or exact credit restoration; coupon restoration does not exist yet. |
| `apps/web/app/api/v1/bookings/route.ts:POST` | Rejects services with positive base price; free API creation is not yet universally quoted. |
| `apps/web/lib/booking/host-booking.ts:createHostBooking` | Direct staff/internal creation without universal pricing enforcement; commercial offline policy unresolved. |
| `apps/web/lib/booking/finalize-booking.ts:finalizeOccurrence` | Scheduling recurrence without independent pricing/allocation; unsupported financial series must remain blocked. |
| `apps/web/lib/payments/pending.ts`, `fulfill.ts` | Redis compatibility path for legacy appointment Sessions; new durable appointment attempts do not depend on it. |

## Implemented promotion schema

Migration: `packages/db/drizzle/0063_appointment_promotions.sql`, with its Drizzle
journal and snapshot. Schema references:
`packages/db/src/schema/promotions.ts` and `booking-pricing.ts`.

1. `appointment_promotions` stores organization, label, active flag, UTC bounds,
   percentage/fixed rule and value, and fixed-discount currency. Checks reject
   blank labels, invalid/infinite windows, invalid kinds/values, and malformed
   or inappropriate currencies.
2. `appointment_promotion_event_types` stores explicitly selected services.
   Composite foreign keys enforce the same organization on both parents;
   duplicate links are forbidden and an empty selection applies nowhere.
3. `booking_pricing_snapshots` stores append-only booking-linked accepted quote
   history: base/effective price, currency, quoted collection, original priced
   start, settlement, version, and copied promotion identity/label/window/rule.
   It has no promotion FK; promotion edits/deletion cannot rewrite attribution.

Supporting composite indexes/FKs bind every snapshot to the booking's actual
organization and service. Checks enforce integer bounds, exact discount arithmetic,
valid attribution, and cash/credit separation. No snapshot means legacy/unpriced,
not a free service. Current types/columns represent promotions, not future coupons.

Handwritten triggers reject snapshot UPDATE and direct DELETE. Parent booking
deletion can cascade history, subject to later durable financial restrictions.
Initial snapshot insertion locks the booking, requires its current start, and
rejects a previously settled booking. Persist the accepted quote before writing
payment facts in the same transaction. The priced start remains historical after
rescheduling; do not append a replacement quote merely because the booking moved.

No implicit settlement-mode switch exists after history is saved. Payment writes
cannot attach a PaymentIntent, positive cash amount, or Connect destination to a
credit-snapshot booking. Migration 0067 additionally requires proven redemption
before a credit booking can become paid and restoration when it is cancelled.

Drizzle does not model custom triggers. Preserve the handwritten migration guards
and their statement ordering; referenced composite unique indexes precede FKs.
Do not modify already-applied migrations to introduce future discount sources.

## Verification and remaining scope

`packages/core/src/pricing.test.ts` covers appointment-time windows, DST, scope,
percentage/fixed discounts, rounding, best-promotion ties, deposits, zero cash,
credit settlement and detached historical values.

`apps/web/lib/booking/pricing.database.test.ts` covers migration compatibility,
scope/constraints, immutable snapshots and coherent quotes under concurrent edits.
It requires an explicit disposable loopback PostgreSQL 17 URL in
`PROMOTIONS_TEST_DATABASE_URL`, with base database `dayotter_promotions_test`.
It creates/applies migrations/drops only its own unique child database; it does
not fall back to `DATABASE_URL`. Other durable payment/package integration suites
and their guards are documented in the payment architecture.

CURRENT gaps: staff/API pricing coverage, zero-cash durable operation identity,
independent recurring financial allocation and external-effect reconciliation.
DECIDED but unimplemented: coupons sharing best-discount selection and durable
booking-linked use/restoration. FUTURE: promotion-management UI and inclusive
calendar-date entry after business timezone semantics are chosen. See the pricing
contract and business rules for unresolved decisions and later scope.
