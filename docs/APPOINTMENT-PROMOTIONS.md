# Automatic appointment promotions foundation

Status: database/domain foundation implemented on `feature/promotions`.
Promotional pricing is NOT enabled in public, API, staff, recurring creation,
rescheduling, or Stripe checkout. Existing bookings are not backfilled.
No promotion-management UI is included. Inspection baseline: `698897a`.

## Product rules

- Eligibility uses each appointment's scheduled **start**, in the promotion's
  start-inclusive/end-exclusive interval. Creation time is irrelevant.
- Apply one promotion: greatest savings wins; ties use ascending stable promotion
  ID. Never stack or accept coupon codes.
- Percentages are integer basis points (2000 = 20%); round the discount half up
  to a minor unit. Fixed discounts use integer minor units and matching currency.
- Discount the full service price first. Then quote the configured fixed deposit,
  capped at effective price; no positive deposit means collect the full effective
  price. `amountToCollect` is a quote, not proof of payment.
- Package credits are a separate settlement. No promotion applies and collection
  is zero. Base/effective price retain the service value. Credit verification and
  consumption must occur with booking creation in one transaction.
- A 100% promotion produces a zero cash quote, not a credit redemption. Future
  routing must create it without Stripe and without inferring a credit from
  zero price or a missing PaymentIntent.
- Reprice each recurring occurrence using its own start; persist each snapshot
  independently. Do not copy the first occurrence's promotion to later dates.
- Rescheduling re-evaluates the new start. Before settlement, create a new quote.
  After collection, preserve payment facts and require an explicit adjustment
  path; never silently charge/refund.
- A checkout represents the exact server quote that created it. Promotion edits
  must not change its amount, currency, or historical attribution.
- A future UI may expose inclusive calendar-date ranges. Convert those to UTC
  instants using the business/organization timezone, including DST. No such UI
  or business-timezone configuration is introduced here.

## Current architecture

| Boundary | Inspected behavior |
| --- | --- |
| `packages/db/src/schema/scheduling.ts`, `eventTypes` | Nullable price/currency and optional fixed deposit. Null/zero price means free. |
| `packages/db/src/schema/booking.ts`, `bookings` | PaymentIntent, amount paid, payment currency/status, and Connect destination are actual payment facts. A deposit cannot reconstruct historical full service price. |
| `apps/web/lib/booking/money.ts`, `chargeFor` | Existing deposit helper, used by today's public checkout. Still unchanged. |
| `apps/web/app/api/book/route.ts`, `POST` | With payments enabled and a positive price, automatically redeems an available package credit before Stripe. Otherwise falls through to creation. Does not yet use the new pricing service. |
| `apps/web/lib/booking/create-booking.ts`, `createBooking` | Validates availability, inserts booking/attendees, and consumes a credit transactionally. Now rejects simultaneous payment + redemption before database access. Still does not enforce promotional pricing or persist snapshots. |
| `apps/web/app/api/v1/bookings/route.ts`, `POST` | Rejects paid services. `host-booking.ts:createHostBooking` and internal team booking insert directly without pricing. |
| `apps/web/lib/payments/pending.ts`, `stashPendingBooking` | Redis holds booking intent for one hour. It does NOT yet store a bound price quote. |
| `apps/web/lib/payments/fulfill.ts`, `fulfillCheckout` | Success redirect/webhook share Redis GETDEL and PaymentIntent lookup, then create a booking with Stripe's amount. BookingError refund now passes the Connect destination reversal flag, matching cancellation. Payout and fee calculations are unchanged. |
| `apps/web/lib/booking/reschedule-booking.ts`, `rescheduleBooking` | Existing live flow updates start/end/reason without repricing. The new pricing service can calculate the replacement quote; live integration remains next work. |
| `apps/web/lib/booking/finalize-booking.ts`, `finalizeOccurrence` | Later recurring occurrences insert directly without independent pricing/payment. Each must call the shared quote service when integration is implemented. |
| `apps/web/lib/packages/credits.ts`, `consumeCredit` | Now locks the selected grant and repeats its capacity predicate on UPDATE. Grants remain matched by service + lowercase email. |
| `apps/web/lib/booking/cancel-booking.ts`, `cancelBooking` | Legacy code infers credit redemption from paid-without-PaymentIntent and restores via the first attendee. New zero-price cash handling must not use that inference. |

## Implemented schema

Generated migration: `packages/db/drizzle/0063_appointment_promotions.sql`,
with Drizzle journal and schema snapshot. It adds:

1. `appointment_promotions`: organization, label, active flag, UTC bounds,
   percentage/fixed rule and value, and fixed-discount currency. Database checks
   reject blank labels, invalid/infinite windows, invalid kinds/values, and
   malformed or inappropriate currencies.
2. `appointment_promotion_event_types`: explicit selected-service links.
   Composite foreign keys enforce the same organization on both parents.
   Duplicate links are forbidden; an empty selection applies nowhere.
3. `booking_pricing_snapshots`: append-only booking-linked quote history with
   base/effective price, currency, quoted amount to collect, priced start,
   settlement, version, and copied promotion identity/label/window/rule. No
   promotion FK: later edits or deletion cannot rewrite historical attribution.

The earlier nullable-JSON-column proposal has been replaced with typed history
rows. This allows an unpaid reschedule to append a replacement quote while
retaining the earlier snapshot, and gives an eventual checkout/adjustment an
explicit snapshot identity. No row means legacy/unpriced; it never means free.

The migration adds supporting composite unique indexes to event types and
bookings. Snapshot checks enforce integer bounds, exact discount arithmetic,
valid attribution, and credit/cash separation. Every snapshot belongs to the
booking's actual organization and event type.

Custom SQL triggers reject snapshot UPDATE and direct DELETE. Parent booking
deletion can cascade its history. Snapshot insertion locks the booking, requires
its current start, and rejects a previously settled booking (including legacy
paid records). Save initial pricing before writing payment facts, in the same
transaction. No implicit settlement-mode switch is supported once history exists;
an explicit future workflow must handle such a transition. Payment writes cannot
attach a PaymentIntent, positive cash amount, or Connect destination to a booking
with credit snapshots. Credit `paymentStatus=paid` remains supported.

These triggers are handwritten migration additions because Drizzle does not
model triggers. The generated composite-FK statements were moved after their
referenced unique indexes so the migration executes correctly on PostgreSQL.
Preserve both details in subsequent migrations.

## Shared service and domain boundaries

`packages/core/src/pricing.ts:calculateAppointmentPrice` remains pure and
clock-independent. It now also quotes collection after the deposit cap.
Existing `chargeFor` and Stripe routes do not call it yet.

`apps/web/lib/booking/pricing.ts:quoteAppointmentPrice` is the authoritative
server reader: load the active service in organization scope, load its selected
active rules covering the appointment start, and invoke the pure calculator.
It accepts intent/scope/settlement, never a client price or chosen promotion.
Callers authorize organization access and choose settlement on the server.
Pass a transaction when reading as part of a booking operation.

`persistBookingPricingSnapshot` accepts that server-owned result inside the
caller's transaction. It verifies booking scope/start, locks the booking, and
appends the detached values. It never consumes a credit or changes payment facts.
Never expose its price argument as an HTTP request body. It refuses persistence
after settlement; an explicit adjustment API/ledger remains future work.

For each new direct booking or recurrence, quote its own start and save its own
snapshot with the booking. For unpaid rescheduling, update start/end and append
the replacement snapshot in the same transaction. After collection, quote the
new start for preview but route the change through an explicit adjustment flow.

## Checkout integration remains disabled

The next payment change must stash a server-owned quote (including amount to
collect, currency, settlement, priced start, and promotion copy) with the pending
intent BEFORE creating checkout. Bind the Stripe session to that stored quote
and verify amount/currency/intent at fulfillment. Use the saved quote even if
promotions or service prices change meanwhile. Save it with the new booking
before recording the verified payment in the same transaction.

Do not enable only the quote calculator in checkout: fulfillment, zero cash,
credit redemption, recurring creation, and rescheduling must honor the same
contract. There is no new client-supplied pricing API in this foundation.
Existing checkout routes still represent the old undiscounted/deposit flow.

## Small corrections and remaining risks

- Credit consumption formerly checked remaining credits only in the selecting
  subquery. Competing statements could select the same final credit. Selection
  now uses FOR UPDATE with stable ordering, plus an outer capacity predicate.
  The real PostgreSQL test holds one transaction until a second lock waiter is
  observed, then verifies exactly one redemption and rollback behavior.
- Checkout-failure refunds now use `Boolean(destinationAccountId)` for the
  existing refund helper, just like cancellation. Tests cover destination and
  platform charges and a competing fulfillment that already succeeded.
- Credit grant provenance/restoration still needs a separate improvement:
  cancellation does not know the exact redeemed grant or primary attendee.
  `restoreCredit` has similar concurrency considerations; this change does not
  redesign restoration, grant idempotency, or refunds after a failed retry.
- Checkout quote expiry/recovery, explicit paid adjustments, and series payment
  collection still need implementation. The pricing rule for each occurrence is
  settled; how to collect for a whole series is not implemented.
- This is additive, but migration 0063 must precede code that queries its tables.
  The indexes/checks/triggers need a normal migration rollout review for a large
  database. No production database has been contacted or migrated.

## Verification

Domain tests cover appointment-time eligibility, DST, scope, percentage/fixed
discounts, rounding, best-rule ties, deposits, zero cash, credits, and detached
snapshots. Existing booking/helper tests plus new settlement/refund tests run in
the normal web test suite.

`apps/web/lib/booking/pricing.database.test.ts` is opt-in. Set
`PROMOTIONS_TEST_DATABASE_URL` to a **disposable loopback PostgreSQL** database
named `dayotter_promotions_test`; it never reads DATABASE_URL. It creates a unique
child database, applies the real historical migrations, inserts a legacy paid
booking, applies 0063 transactionally, runs constraints/persistence/concurrency
tests, and drops only that child database. Use PostgreSQL 17 with btree_gist
available. For example, against an already-started disposable container:

```sh
PROMOTIONS_TEST_DATABASE_URL=postgresql://dayotter_test@127.0.0.1:TEST_PORT/dayotter_promotions_test pnpm --filter @dayotter/web test lib/booking/pricing.database.test.ts
pnpm --filter @dayotter/core test
pnpm --filter @dayotter/web test
pnpm --filter @dayotter/db typecheck
pnpm --filter @dayotter/core typecheck
pnpm --filter @dayotter/web typecheck
```

Recommended next change: integrate server-owned quotes into new booking and
checkout intent/fulfillment, including zero cash and credit paths, then add the
explicit paid-reschedule adjustment workflow and independent recurring pricing.
Keep promotion-management UI as a separate change.
