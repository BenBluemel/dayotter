# Payment architecture: direct Stripe and retained Connect support

Status: **Slices 1–5 were implemented and validated on `feature/payment-routing`, through `7ff1a9a8eac39151ae76db0dfc3bc50535542348`. Slice 3: `4ec3d98`; Slice 4: `c407ac8`, validation fixes: `0a90317`; Slice 5: `7ff1a9a`. Slices 6–7 are implemented and validated on `feature/promotions` as part of the current PR. Production payments remain unchanged.**

Review date: 2026-10-01. Inspection baseline: commit `698897a` on
`feature/promotions`, including the uncommitted appointment-promotion foundation.
This document preserves the code review and Astra High audit. The source map and
risks below describe that inspection baseline; the Slice 1 section records the
subsequent routing changes. The Slice 2 section records durable appointment intent/pricing persistence. The Slice 3 section records durable success observations, transactional booking fulfillment, event recovery and bounded finalization tracking. The Slice 4 section records the cancellation/refund lifecycle, subsequently validated at `0a90317`. The Slice 5 section records package ownership, mutation provenance, and purchase recovery. Per-effect delivery guarantees remain proposed.

The investigation inspected source and public Stripe documentation. It did not
run tests, inspect live Stripe accounts or production data, change Stripe
configuration, or implement payment changes. Source references below are relative
to the repository root; line numbers describe the inspected working tree and may
move. Function names identify the relevant boundaries when lines change.

## Business-rule authority and document boundaries

Implementation must preserve [BUSINESS-RULES.md](BUSINESS-RULES.md). Changes to
business policy must update that document and reconcile the technical contracts.
[PRICING-ARCHITECTURE.md](PRICING-ARCHITECTURE.md) owns authoritative pricing,
discount sources, accepted quotes, deposits, and rescheduling semantics.
[APPOINTMENT-PROMOTIONS.md](APPOINTMENT-PROMOTIONS.md) is the promotion-specific
schema/migration reference. This document owns financial routing, durable
payment/refund obligations, cash/package settlement, and recovery.

**CURRENT** means implemented within the named paths. **DECIDED / NOT YET
IMPLEMENTED** means approved policy awaiting implementation. **FUTURE / DEFERRED**
means additional work; unresolved choices are explicitly identified in the
business rules. The original source map/risk audit below remains historical;
read the Slice 1–7 implementation sections for current guarantees and limits.
Do not treat an original audit finding or an earlier slice exclusion as an
unfixed current problem when a later slice explicitly supersedes it.

New public cash checkout saves the authoritative quote and persists it to the
resulting booking; package redemption saves its own settlement snapshot.
Deployment configuration has not been changed or production payments enabled.

## Business objective and design decisions

Light & Balance is one business using its own Stripe account. Customer payments
should be ordinary payments into that account. Stripe should manage payout
scheduling and bank payouts. The scheduler should have no withdrawal concept in
direct mode, no minimum withdrawal, and no Connect onboarding requirement.

The intended design is:

1. Select direct Stripe or Connect explicitly at deployment configuration.
2. Share booking, authoritative pricing, Checkout, fulfillment, and compensation
   logic. Isolate the small differences in payment routing and Connect account
   management.
3. Persist the original account, topology, and quote for each payment. A later
   configuration change must not change how an old payment is retrieved/refunded.
4. Make payment and refund work durable before external requests and recoverable
   after crashes. Redis may accelerate work but must not hold the only copy.
5. Integrate the existing appointment-pricing snapshots rather than adding a
   separate Stripe-specific pricing calculation.
6. Retain useful Connect behavior where reasonably clean, while rejecting its
   silent fallback to collecting money on the platform when a recipient is not
   ready.

These are intended architecture decisions. Slice 1 implements only explicit
routing/configuration and capability gates. Slice 2 adds durable appointment
checkout terms and the minimum booking handoff; Slice 3 adds appointment recovery,
Slice 4 adds durable full appointment cancellation refunds, and Slice 5 adds
package ownership, credit provenance, and durable verified package grants.
Light & Balance correctness and simplicity take priority over upstream compatibility.
The recommendation does not require a general accounting system or two copies of
the payment workflow.

Terminology: this document's **direct mode** means ordinary payments created with
Light & Balance's account credentials. Stripe Connect also has a product term
"direct charges" for charges on connected accounts; that is a different topology
and is not the target here.

## Slice 1 implementation: explicit routing and configuration

Slice 1 validation reported 41 focused payment tests and 241 web tests passing
(with 14 PostgreSQL tests skipped), web/mobile typechecks, scoped Biome, and diff
checks passing. The validator's explicit `StripeContext` annotation and stale-dest
metadata filtering fixes were incorporated into this tree without its formatting
churn. Slice 2 passed 55 focused payment tests, 19 PostgreSQL integration tests, 274 full web tests, web/DB typechecks, scoped Biome and diff checks. No deployment
configuration, credentials, Stripe accounts, or payout schedules were changed.
This slice does **not** establish readiness for live payments.

### Deployment configuration

`apps/web/lib/server/env.ts` declares these fields. The pure
`paymentRoutingConfig` in `apps/web/lib/payments/routing.ts` validates enabled
configuration at use, so builds can run without payment credentials.

| Field | Implemented semantics |
| --- | --- |
| `STRIPE_PAYMENT_MODE` | `disabled` (default), `direct`, or `connect`. A secret key alone never enables booking/package cash checkout. |
| `STRIPE_PAYMENT_ENVIRONMENT` | Required `test` or `live` for enabled modes. Live operations require a production Node runtime; production may still use test credentials. |
| `STRIPE_ACCOUNT_ID` | Required charge-owning `acct_…` identity. The gateway retrieves the credential-owning account and checks this ID before new checkout. |
| `STRIPE_DIRECT_ORGANIZATION_ID` | Required organization UUID in direct mode. Only server-loaded services/packages belonging to this organization may sell through the configured merchant. |
| `STRIPE_SECRET_KEY` | Account-scoped secret or restricted key with the expected test/live prefix. Organization-scoped keys are unsupported. Account-read access is required for identity checks. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret required for enabled checkout. Prefix validation cannot prove endpoint/account ownership; deployment must supply the correct endpoint secret. |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | If supplied, its test/live prefix must match. |
| `STRIPE_PLATFORM_FEE_PERCENT` | Connect only; finite 0–100, defaults to zero. Direct ignores even stale or invalid fee configuration. |

The smallest merchant binding uses existing service/package organization IDs and
one deployment organization UUID, without schema changes or per-organization key
storage. It assumes the configured organization represents the sole direct
merchant and the configured account is that business's account. Package checkout
also checks that package and service organization IDs agree. It is not a general
multi-merchant direct-payment facility.

### Routing boundary and callers

- `routing.ts`: `PaymentRoute` carries mode, organization, charge account,
  environment, and nonsecret `credentialContext: "primary"`; Connect additionally
  carries destination and the computed application fee. This is suitable for
  later persistence, but Slice 2 now persists this context in appointment PaymentAttempt records.
- `connect.ts`, `checkoutRouteForOrganization`: direct avoids host/Connect lookups;
  Connect requires an owner, a valid stored account, and fresh Stripe charge and
  transfer capability state. Unsupported team ownership fails closed.
- `stripe.ts`, `createCheckoutSession`: revalidates configuration and charge-account
  identity, rechecks Connect readiness, and constructs parameters explicitly.
  Direct never sets transfers, application fees, or connected-account headers,
  even with stale Connect fields. Connect retains destination charges and fee
  rounding, and never falls back to an ordinary platform payment.
- Session and PaymentIntent metadata include routing identity. Reserved routing
  fields are overwritten and stale `dest` is removed for direct payments. Metadata
  is not a durable attempt or an authorization substitute.
- `app/api/book/route.ts`, `POST`: positive cash checkout always resolves a route;
  disabled mode cannot fall through to an unpaid booking. Free bookings and the
  existing package-credit path remain available. Slice 2 now uses `quoteAppointmentPrice` and its deposit-after-discount amount
  for new appointment cash checkout.
- `app/api/packages/[id]/buy/route.ts`, `POST`: uses the server-loaded service and
  package organization for merchant selection; purchase/grant hardening remains
  deferred.

### Historical operations and Connect capability gates

`stripeConfigured` means credentials exist; `paymentsEnabled` means new cash sales
are selected; `connectEnabled` gates Connect capabilities. Historical return and
webhook processing, cancellation refunds, and Pro billing use credential presence
rather than the current booking-payment mode.

`stripe.ts`, `retrieveSession` and `refundPayment` accept original typed route
context without consulting the current sales mode. Direct refunds omit reversal
parameters. Connect refunds reverse the original transfer and refund an application
fee only when the supplied original route records a positive fee. Legacy boolean
refund callers still use their saved destination presence, independent of current
mode; they have not been converted into durable refund operations. Slice 2 cancellation
looks up an original attempt for new bookings, preserving its actual fee amount;
only legacy bookings retain the boolean ambiguity. A signed
webhook's `livemode` must match the configured key environment, even when sales are
disabled. Signature verification and existing fulfillment otherwise remain intact.

**Historical limitation:** legacy records lack full charge-account/credential
facts. There is still only one primary credential context, and legacy Session
retrieval uses that key. Mode changes with the same charge-owning account preserve
routing behavior; changing accounts/credentials requires retaining access to the
old account in a later legacy-context resolver or settling its obligations first.
A supplied typed route with a different account fails identity checks instead of
being silently reinterpreted. This slice does not provide mixed-account processing.

All Connect SDK account-management, balance, and payout helpers require explicit
Connect configuration. Web/mobile navigation hides Payouts outside Connect; the
web page and backend status/withdraw/onboarding/dashboard routes also gate those
capabilities. `/api/me` exposes `connectEnabled`. The payout-status endpoint keeps
its legacy `paymentsEnabled` response field as a Connect capability indicator.
Connect target helpers also reject malformed/missing targets and the charge-owning
platform account before issuing account-context requests.
Existing Connect manual payouts and minimum withdrawal remain unchanged in Connect;
direct payout scheduling and bank payouts belong to Stripe.

Focused tests added: `lib/payments/routing.test.ts`, `connect.test.ts`, and
`stripe.test.ts` (under `apps/web`). They cover configuration, organization binding,
stale Connect state, missing/invalid/unready destinations, SDK parameters/account
identity, historical refunds/retrieval across mode changes, and webhook environment
checks. Slice 1 validation passed as reported above. Slice 2's tests and
changes remain pending validation; webhook recovery, durable refund lifecycle, and
production activation remain outside both slices.

### Focused adversarial review of Slice 1

The repository-wide Checkout search found two new-purchase gateways: ordinary
appointment/package `createCheckoutSession`, and cloud Pro
`createSubscriptionCheckout` (including its missing-customer retry). There are no
other Stripe client constructors or Checkout creation calls in application code.
`STRIPE_PAYMENT_MODE` governs appointment/package sales, not cloud Pro billing;
Pro remains separately gated by cloud edition, credentials, recurring Price, and
organization admin authorization. It never acquires Connect routing. Light &
Balance's self-hosted edition has no public Pro checkout route enabled.

Review fixes in `stripe.ts`, with regressions in `stripe.test.ts`:

- Centralized primary-key environment/runtime checks cover legacy Session
  retrieval, Pro checkout/retry/portal, refunds, subscription reads, and webhook
  verification, without consulting current sales mode. Live keys fail closed
  outside a production Node runtime.
- Account-identity lookup failures expose a generic routing error, without raw
  SDK error text/cause that might include credential details in caller logs.
- Connect account-target helpers reject the primary platform account and missing
  or malformed IDs, preventing a bad stored target or omitted header from exposing
  platform balances/payouts. Creating a new connected account has no target.

The account identity lookup is lazy; it makes no startup/build network request.
It introduces a fail-closed runtime dependency on Stripe's account endpoint and
account-read permission (including restricted keys). An unavailable/forbidden
lookup prevents checkout; it does not select a different account. Connect checkout
currently checks owner readiness and then rechecks at the gateway, causing two
platform-account and two destination-account reads. Permissions and latency should
be verified in an isolated test environment before deployment, not against live
accounts. No network-based credential checks were performed in this review.

Findings from the Slice 1 inspection, with the Slice 2 disposition noted:

- For legacy Sessions, `fulfill.ts`, `fulfillCheckout` still consumes Redis input before durable booking
  commit, uses Session destination metadata, and does not validate persisted
  expected amount/account/routing. Added routing metadata is not yet persisted in
  booking/payment records. Slice 2 replaces this path for new appointment Sessions
  with persisted terms and route facts; durable event/finalization recovery remains Slice 3.
- For legacy payments, `cancel-booking.ts`, `cancelBooking`, and failed-booking compensation still use
  destination-presence booleans; they cannot recover original fee or credential
  identity. Typed zero-fee Connect routes omit fee refunds, while legacy boolean
  calls retain their previous flags. Refund failure/crash recovery remains R2 and
  Slice 4, including verification of zero-fee legacy behavior. New appointment
  attempts supply the original typed route and fee to the existing refund calls.
- `packages/fulfill.ts`, `fulfillPackagePurchase` still grants from metadata without
  paid-status enforcement or original purchase account facts. R3/R4 and Slice 5
  remain required before package readiness.
- Before Slice 2, `app/api/book/route.ts`, `POST`, loaded mutable price/active/organization state
  separately from `createBooking`'s later validation. Concurrent service edits
  can change the terms or turn a previously free/inactive branch into a payable
  booking before creation. Route validation prevents wrong-merchant Checkout;
  it does not provide atomic pricing/booking terms. Slice 2 must bind the quote,
  purpose, and settlement decision rather than treating this initial read as an
  immutable snapshot. Slice 2 now binds the quote and cash intent before Stripe;
  the separate package-credit branch remains outside durable cash-operation identity.
- Public booking pages still derive displayed cash amounts from `paymentsEnabled`:
  disabled mode hides the amount while the API now rejects positive cash sales.
  Wrong-organization direct bookings may also display a checkout price before the
  API rejects their merchant. Server-authoritative pricing/capability presentation
  belongs to the later entry-point integration; the API remains the routing gate.
- Pro and legacy payments still share the primary credential. Changing that key
  can break historical processing or move Pro billing into a different account;
  its existing missing-customer retry does not preserve old account ownership.
  Account/credential cutover must retain historical context as described below.

## Slice 2 implementation: durable appointment checkout terms

### Records and coherent pricing

`packages/db/src/schema/payment-attempts.ts`, migration
`0064_payment_attempts.sql`, and generated Drizzle snapshot/journal add
`payment_attempts`. This is appointment cash checkout only; packages retain their
existing purchase path. A record is committed **before** requesting Stripe.

Each attempt stores:

- A stable request key, request-input fingerprint, purpose `appointment`, and
  organization/service identity.
- AES-GCM encrypted booking intent (including access code and intake answers),
  original return path, and resolved duration. The existing `ENCRYPTION_KEY` is
  required before creating an attempt; credentials are never stored in it.
- The complete authoritative `AppointmentPrice` JSON: base/effective price,
  promotion attribution and original rule values/window, appointment start,
  settlement, currency, and amount to collect after deposit capping. A canonical
  SHA-256 quote hash binds this copy to Session/PaymentIntent metadata.
- Explicit cash/paid expectations; original direct/Connect mode, charge account,
  test/live environment, primary credential context, destination, and original
  application-fee amount. Direct stores no destination and a zero fee.
- Immutable product/redirect parameters, creation time, creation-retry deadline,
  fixed expiration, eventual Session/PaymentIntent identifiers, and booking link.

`apps/web/lib/payments/attempts.ts`, `prepareAppointmentAttempt`, serializes one
request identity using a PostgreSQL advisory transaction lock. A REPEATABLE READ
transaction loads the service, calls the unchanged `quoteAppointmentPrice`, reads
Connect ownership through the same transaction, and inserts the attempt. Service,
price, owner, and promotion reads therefore share one committed database revision.
Fresh Stripe destination capabilities are checked for Connect. Serialization/key
conflicts retry only the database preparation, at most three tries; no external
Checkout request has happened at that point.

The record's financial/request/redirect/expiry fields are immutable. Migration
triggers reject edits and direct deletion, make Stripe identifiers/booking link
write-once, and constrain lifecycle transitions. Checks bind quote JSON to scalar
organization/service/amount/currency, and reject impossible topology/fee facts.
Unique indexes cover request identity, account/environment-scoped Session and
PaymentIntent IDs, and the associated booking. Parent organization/service/booking
deletion is restricted where it would erase financial context. No legacy records
are backfilled or guessed.

### Stable operation identity and expiration

`app/api/book/route.ts`, `POST`, accepts a UUID `checkoutRequestId`, bound to a
canonical fingerprint of the validated booking input and normalized return path.
Reusing a key with changed input returns 409. Without a UUID, exact canonical input
gets a deterministic fallback key; these older callers must supply a new operation
UUID after expiry to request a new checkout. This is cash-operation deduplication,
not a slot hold, attendee authorization, or booking uniqueness policy.

`components/slot-picker.tsx` reuses the operation UUID for unchanged intent and
network retries. Session storage retains only the UUID and input hash across a
page return/reload, not personal data. A verified 410 expiration clears it so the
next submit explicitly starts a new operation. Changed input starts a distinct
operation; old open Sessions are not superseded automatically by this slice.

`appointmentCheckout` always uses saved terms and a stable Stripe key
`appointment-checkout:<attempt-id>:v1`, with identical product, amount, currency,
route, metadata, URLs, and expiration on a retry. Creation responses are bound in
a separate database transaction. If Stripe accepted the request before response
persistence failed, replay uses the same key; a verified Session can also bind via
its `attemptId` metadata if its ID was not locally saved.

Sessions have a fixed **two-hour** `expires_at`. Unknown creation may be replayed
only during the first **15 minutes** after attempt creation, well within Stripe's
finite idempotency retention and valid expiration range. The key, quote, and expiry
are never rolled forward. After that window, an unbound attempt becomes
`requires_review`; it must be reconciled, not recreated automatically. A known
Session is retrieved using its original account context even if sales mode changes.
A new/replayed creation still must pass Slice 1's current configuration checks;
mode/account/environment/fee changes fail closed rather than rerouting the attempt.

These bounds follow Stripe's [Checkout creation reference](https://docs.stripe.com/api/checkout/sessions/create)
and [idempotent request reference](https://docs.stripe.com/api/idempotent_requests).
No real Stripe account, credentials, or API calls were used during implementation.

### Lifecycle and saved-quote handoff

| State | Meaning / transition |
| --- | --- |
| `prepared` | Immutable terms committed; Session may not yet be locally known. Same operation may retry creation within the deadline. |
| `open` | A verified Session is bound; fulfillment may still be pending. This does not assert that Stripe's current Session status is open or paid. |
| `expired` | Stripe returned an expired Session; this operation is terminal and never creates a replacement. Local time alone does not prove unpaid expiration. |
| `fulfilled` | Booking, original pricing snapshot, captured settlement, and attempt link committed together. This does not prove finalization work completed. |
| `requires_review` | Creation is old/ambiguous or paid booking creation failed. This is not evidence of a successful refund. Automatic checkout/booking retries stop. |

`fulfill.ts`, `fulfillCheckout`, loads a known attempt by Session ID or resolves its
metadata identity, then verifies the saved credential account. It validates purpose,
mode, quote hash, organization, account/environment/context, destination, collection
amount/currency, expiration, Session identity, and paid status/PaymentIntent before
booking creation. It never calls the pricing loader or selects promotions again.
`attempt-terms.ts` checks immutable snapshot integrity/arithmetic without looking
up current rules.

`create-booking.ts`, `createBooking`, receives internal-only saved quote/attempt
identity and resolved duration. Its transaction locks/rechecks the attempt, inserts
an initially unsettled booking, persists `persistBookingPricingSnapshot`, records
payment, and binds the booking to the attempt. A second handler cannot bind another
booking for the same attempt. Unsupported changes to the quoted duration fail
closed. The current scheduling/access/intake checks still run; this is not a hold.

Post-commit finalization failure cannot trigger a refund of a booking whose
attempt link already committed. Retries can return that booking, but unfinished
calendar/reminder/email work is **not** yet durably resumed. Legacy token Sessions
retain the previous Redis branch and its historical failure modes; new appointment
Sessions never write or destructively claim Redis booking input.

Zero-cash authoritative quotes skip Stripe and save a booking snapshot. Existing
approval behavior is retained; no paid status is invented. Automatic package-credit
selection remains the existing separate path, without applying cash promotions.
Commercial recurring series are rejected before new cash checkout (group events
retain their existing non-series behavior); no paid-series allocation is added.

`booking-routing.ts`, `originalBookingRefundRoute`, and cancellation lookup use
saved original route/fee facts for new paid bookings, including zero-fee Connect.
A failed lookup or inconsistent booking binding cannot fall back to the legacy
boolean. The existing best-effort refund lifecycle remains unchanged; durable
refund tasks, statuses, idempotency, and cancellation crash recovery are deferred.

### Remaining dependencies and validation

At the Slice 2 checkpoint, event recovery, PaymentIntent verification and truthful return pages were deferred. The Slice 3 implementation below now resolves those appointment concerns with an inbox, authenticated Intent/charge verification, a bounded recovery pass and durable finalization progress. Periodic scheduling and per-effect delivery remain operational/architectural dependencies.
Creation ambiguity, process crashes, or post-commit effects must not be mistaken
for complete recovery merely because input now survives in PostgreSQL.

The Slice 2 interim failed-booking path attempted one best-effort refund after recording review. Slice 3 replaces that behavior for new durable attempts with a retained paid obligation requiring review; no ambiguous automatic refund is issued. Durable compensation/refund recovery is Slice 4.
Package purchase verification, redemption authorization, concurrent cash-versus-
credit operation selection, exact credit restoration, and package refund policy
remain Slice 5. Current credit booking selection is not covered by the new cash
request identity. Old Redis Sessions, mixed-account credentials, client changes
that leave an old Session payable, encrypted-intent retention/key rotation, and
service/account deletion policies need deliberate cutover decisions.

Public page price labels still use the older static display calculation. Saved
checkout/booking terms are authoritative, but promotion-aware quote presentation
and truthful disabled/wrong-merchant capability display still need later UI work.
Production payments remain disabled by default and have not been enabled here.

New focused tests: `attempt-terms.test.ts`, `attempts.test.ts`,
`attempts.database.test.ts`, `fulfill-durable.test.ts`, and
`booking-routing.test.ts` under `apps/web/lib/payments`; gateway identity/expiry
coverage extends `stripe.test.ts`. PostgreSQL tests use only an explicitly supplied
loopback `PAYMENTS_TEST_DATABASE_URL` ending in `/dayotter_payments_test`, create
and drop a randomly named disposable database, and apply real migrations. They
cover immutable terms/identifiers, concurrent request preparation, coherent admin
revisions, frozen replay after configuration edits, and snapshot-before-settlement
handoff. Unit tests cover response-loss replay, exact key/parameters, expiration,
Session mismatch rejection, encrypted intent recovery without Redis, routing/fee
preservation, and post-commit failure handling. These tests have been implemented
but not executed; full typechecks, builds, and lint/Biome are deferred.

## Inspection baseline: source map

### Checkout, deposits, and booking creation

| Source / function | Observed behavior |
| --- | --- |
| `apps/web/app/api/book/route.ts:88`, `POST` | Loads current event price/currency/deposit/owner; automatically prefers a package credit; otherwise stores input in Redis and creates Checkout. Does not call the new pricing service. |
| `apps/web/lib/booking/money.ts:74`, `chargeFor` | Collects a smaller positive fixed deposit, otherwise the full price. No remaining-balance collection is implemented. |
| `apps/web/lib/payments/stripe.ts:35`, `createCheckoutSession` | Uses one server Stripe client and a server-supplied amount. Adds destination transfer and optional application fee only when a destination is present. No explicit Session expiration or request idempotency key. |
| `apps/web/lib/payments/connect.ts:9`, `hostDestinationAccount` | Returns an enabled owner's Connect account, otherwise `undefined`; the latter silently leaves money on the configured account. |
| `apps/web/lib/payments/pending.ts:9`, `stashPendingBooking` | Stores booking input in Redis for one hour. No saved quote or durable purchase record. |
| `apps/web/lib/payments/pending.ts:17`, `claimPendingBooking` | Destructively claims input with `GETDEL`. |
| `apps/web/lib/payments/fulfill.ts:14`, `fulfillCheckout` | Retrieves Session, requires paid status, looks up a booking by PaymentIntent, claims Redis input, then creates the booking or attempts a refund on `BookingError`. |
| `apps/web/lib/booking/create-booking.ts:160`, `createBooking` | Validates service/access code/intake/location/availability and persists booking/attendees, with transactional credit consumption. Does not yet persist pricing snapshots. |
| `apps/web/lib/booking/create-booking.ts:497` | Inserts payment facts with the booking; `paid` can mean a captured deposit or a credit redemption, not full cash settlement of service value. |
| `packages/db/src/schema/booking.ts:76`, `bookings` | Stores PaymentIntent, amount paid, currency/status, and nullable Connect destination. PaymentIntent has no unique index. |

Appointment Checkout metadata contains only an opaque Redis `token` and optional
`dest`, copied to the Session and PaymentIntent. Fulfillment uses Stripe's amount
and currency without comparing them to a stored expected quote; missing values
fall back to zero/USD. It takes the destination from metadata rather than
verifying the actual payment routing.

Most booking validation happens after collection. An invalid access code, intake
answer, expired booking link, or unavailable slot can therefore reach payment
before failing booking creation. Availability must still be checked after
payment even if a preflight check is added.

### Packages and session credits

| Source / function | Observed behavior |
| --- | --- |
| `apps/web/app/api/packages/[id]/buy/route.ts:19`, `POST` | Reads package price/count from the database and uses the same Checkout/destination helpers. Metadata copies package/org/service/email/credit count. |
| `apps/web/lib/packages/fulfill.ts:9`, `fulfillPackagePurchase` | Grants credits from Session metadata without checking paid status; accepts a null PaymentIntent. |
| `apps/web/lib/packages/credits.ts:85`, `grantCredits` | Lookup-then-insert deduplication by PaymentIntent. A database unique index prevents duplicate non-null PaymentIntents, but a concurrent losing insert throws. |
| `apps/web/lib/packages/credits.ts:35`, `consumeCredit` | The uncommitted correction locks the oldest available grant and repeats the capacity predicate on UPDATE. Consumption occurs inside the booking transaction. |
| `apps/web/lib/packages/credits.ts:63`, `restoreCredit` | Decrements the newest used grant for email/service; does not identify the original redemption or apply equivalent concurrency guards. |
| `packages/db/src/schema/packages.ts:38`, `packageCredits` | Stores credit counts and optional purchase PaymentIntent, but no paid amount/currency/destination/fee, Session, refund state, or per-booking redemption link. |

No package cash-refund or credit-revocation workflow was found. The package
Checkout success URL is `/packages/thanks`; no matching page was found in the
inspected application.

### Lifecycle, webhooks, and alternative entry points

| Source / function | Observed behavior |
| --- | --- |
| `apps/web/app/api/webhooks/stripe/route.ts:14`, `POST` | Verifies raw body/signature, then handles Checkout completion, Pro subscription events, and Connect `account.updated`. No async Checkout, expiration, or refund reconciliation handlers. |
| `apps/web/lib/payments/stripe.ts:96`, `constructWebhookEvent` | SDK verification rejects invalid signatures and missing signing secret. The route returns 200 before verification when payments are disabled. |
| `apps/web/app/booking/paid/route.ts:11`, `GET` | Calls shared fulfillment; all UID-less outcomes go to static processing, and all exceptions go to a generic slot-taken/refunded page. |
| `apps/web/lib/booking/cancel-booking.ts:15`, `cancelBooking` | Atomically marks cancelled before best-effort refund/restoration; already-cancelled bookings return without retrying compensation. |
| `apps/web/lib/payments/stripe.ts:79`, `refundPayment` | Full refund only; optionally reverses transfer and application fee; returns a boolean, discarding Refund ID/status. No request idempotency key. |
| `apps/web/lib/booking/reschedule-booking.ts:34`, `rescheduleBooking` | Updates time/reason at line 165 without pricing or payment adjustments. |
| `apps/web/lib/booking/finalize-booking.ts:48`, `finalizeConfirmedBooking` | Runs after booking commit; calendar, reminders, messages, and series work are not durably resumed by payment retries. |
| `apps/web/lib/booking/finalize-booking.ts:263`, nested `finalizeOccurrence` | Inserts later confirmed occurrences without pricing, payment fields, or credit consumption. Failures are logged/skipped. |
| `apps/web/app/api/v1/bookings/route.ts:81`, `POST` | Restricts service ownership and rejects positive-price event types. |
| `apps/web/lib/booking/host-booking.ts:80`, `createHostBooking` | Can insert a booking for a matched priced service without pricing/settlement. |
| `apps/web/lib/booking/internal-team-booking.ts`, `createInternalTeamBooking` | Separate internal meeting path; does not use commercial checkout/pricing. |
| `apps/web/lib/booking/confirm-booking.ts:37`, `approveBooking`; `:109`, `declineBooking` | Approval finalizes after status change; decline does not refund. Normal paid/credit bookings bypass approval via `create-booking.ts:269`, so missing decline refunds are not a normal paid-checkout failure today. |

The same Stripe client also serves DayOtter Pro subscriptions and its billing
portal (`apps/web/lib/payments/stripe.ts:102`,
`apps/web/lib/billing/subscription.ts:20`). Those subscriptions are separate from
recurring appointments and must remain a separate product concern.

### Connect, transfers, payouts, and settings

Connect assumptions are concentrated rather than pervasive:

- `apps/web/lib/payments/stripe.ts:10` enables payments when a key exists;
  `:190` sets `connectEnabled = paymentsEnabled`.
- `stripe.ts:210`, `createConnectAccount`, creates Express accounts with
  `settings.payouts.schedule.interval = "manual"`.
- `apps/web/app/api/payments/connect/route.ts:17` creates/stores the account and
  issues hosted onboarding links. `dashboard/route.ts` issues Express login links.
- `stripe.ts:271`, `connectedBalances`, reads balances in connected-account
  context; `:289`, `createConnectedPayout`, creates connected bank payouts.
- `apps/web/app/api/payments/withdraw/route.ts:14` pays eligible currency buckets;
  `apps/web/lib/booking/money.ts:68`, `withdrawMinimum`, imposes $100 for USD and
  other per-currency thresholds. This is application policy, not a direct-mode
  requirement from Stripe.
- No separate transfer-creation orchestration was found. Checkout's
  `transfer_data` creates destination transfers; `reverse_transfer` on refunds
  is the existing reversal mechanism.
- Routing uses `eventType.ownerId`, not the eventually assigned host. Ownerless
  team services can silently fall back to the platform account too.

UI/configuration touch points:

- `apps/web/components/nav-items.ts:41`, `SETTINGS_NAV`;
  `apps/web/components/settings-nav.tsx`;
  `apps/web/app/(app)/settings/payouts/page.tsx`;
  `apps/web/components/payouts-panel.tsx:28`, `PayoutsPanel`.
- `apps/web/app/api/payments/status/route.ts:20` reports Connect capabilities,
  balances, fee, and withdrawal minimum; `/api/me` exposes `paymentsEnabled`.
- `apps/mobile/app/payouts.tsx:50` and `apps/mobile/app/(tabs)/settings.tsx:462`.
- `apps/web/lib/apps/registry.ts:175` describes Stripe as Connect and links to
  Payouts; `apps/web/lib/apps/status.ts:41` treats a stored Connect ID as connected.
- `apps/web/components/event-type-form.tsx`, mobile `event-type.tsx`, and the
  individual/team event editing pages gate pricing controls on payments enabled.
- `apps/web/app/[handle]/[slug]/page.tsx:67`,
  `apps/web/app/team/[teamSlug]/[slug]/page.tsx:62`,
  `apps/web/app/embed/[handle]/[slug]/page.tsx:48`, and
  `apps/web/components/slot-picker.tsx` display the old static charge calculation.
- `apps/web/lib/server/env.ts:57`, `.env.example`, `deploy/.env.prod.example`,
  deployment Compose files, and `docs/SELF_HOSTING.md` document/configure Stripe.

## Known correctness and security risks

These are code findings. Their existence does not establish that a particular
customer or live payment has been affected; production state was not inspected.

### R1: Lost paid bookings after destructive claim or expiration

`pending.ts:17` and `fulfill.ts:35` permit this sequence:

1. Handler deletes the only booking input with `GETDEL`.
2. Process crashes or database work fails before booking commit.
3. Retry finds neither booking nor input and returns `pending: true`.
4. Webhook acknowledges HTTP 200; no durable recovery remains.

A competing redirect/webhook can acknowledge while the claimant later fails.
Redis eviction or expiry has the same consequence. The one-hour Redis TTL is also
shorter than Stripe Checkout's default 24-hour Session lifetime, because the
helper does not set `expires_at`.

### R2: Cancellation abandons failed or interrupted compensation

`cancel-booking.ts:21` exits for already-cancelled bookings, while the cancellation
claim precedes refund/restoration. A crash between those operations or a failed
refund cannot be repaired by retrying cancellation. A network timeout after
Stripe accepts a refund leaves an ambiguous outcome with no reconciliation.

`refundPayment` treats any returned Refund object as success without inspecting
its status. Refunds may be pending or later fail. Failed-booking compensation in
`fulfill.ts:69` ignores the helper's boolean entirely and retains no refund task.

### R3: Delayed payments and webhook lifecycle gaps

The webhook handles only `checkout.session.completed` for purchases. Appointment
fulfillment checks paid status but has no later async-success handler. Package
fulfillment grants credits without checking paid status. If delayed methods are
enabled, a completed-but-unpaid package can grant credits before funds succeed.
Async failure, Session expiration, externally issued refunds, and refund status
changes are not reconciled.

Missing package metadata is logged and acknowledged without a recovery record.
Disabling payments also makes the webhook acknowledge events before verification
or processing, potentially abandoning historical obligations.

### R4: Credit authorization and restoration

`api/book/route.ts:106` selects credits using an unauthenticated, caller-supplied
email. No proof of email possession is required before redemption. Someone who
knows a client's email/service can consume that client's credits, including by
adding themselves as a guest. CAPTCHA and throttling do not authorize entitlement
use.

Cancellation infers credit settlement from paid-without-PaymentIntent and uses
unordered `attendees[0]`. It can target a guest instead of the original client.
`restoreCredit` chooses a grant heuristically, without the original redemption
link, row selection lock, or outer `used_credits > 0` condition. Concurrent
cancellations of different bookings can select the same last-used grant and drive
usage negative. Schema bounds do not prevent this.

### R5: Incomplete idempotency and payment binding

Checkout/refund requests lack explicit stable idempotency keys. Appointment
PaymentIntent lookup has no database uniqueness constraint. Package grants have
useful uniqueness for non-null PaymentIntents, but concurrent inserts throw and
null PaymentIntents bypass deduplication.

Fulfillment does not match amount, currency, purpose, account, destination, and
Session identity against a durable expected purchase. Server-created Stripe
metadata is useful correlation data, but is not a substitute for that record.

### R6: Recurring appointments have no per-occurrence settlement

Only the primary booking receives payment/credit settlement. Later occurrences
are inserted confirmed with payment defaults and no independent quote. Cancelling
the first can refund the only cash payment while later appointments remain;
cancelling a later appointment has no associated refund/restoration. Partial
series creation has neither financial allocation nor reliable recovery.

### R7: Post-commit effects cannot reliably resume

`create-booking.ts:597` invokes finalization after the booking transaction commits.
Uncaught database/queue failures and process crashes can leave missing reminders,
calendar work, or occurrences. Fulfillment retries find the booking and return
without resuming finalization. A committed booking with pending ancillary work
must not be treated as an unfulfillable purchase and automatically refunded.

### R8: Configuration changes silently affect money movement

With no Stripe key, the public route falls through to unpaid creation even for a
priced service. With no ready Connect recipient, money falls back to the account
owning the key. Neither behavior should remain implicit for a positive cash quote.

Onboarding and withdrawal locks fail open on Redis errors
(`connect/route.ts:33`, `withdraw/route.ts:26`). Locks expire after 30 seconds and
are deleted without an ownership token. Account creation has no durable request
identity; withdrawal idempotency uses a minute bucket and observed balance.
These do not provide durable recovery across timeouts, crashes, or partial
multi-currency payout success. Isolate these paths from direct mode and harden
them if retained for active Connect use.

### R9: Status UI overstates payment and refund outcomes

`booking/processing/page.tsx` claims payment was received and confirmation is on
its way even for unpaid or unrecoverable outcomes. `booking/payment-failed/page.tsx`
claims a slot collision and completed full refund for every exception, including
operational errors and failed refunds. These pages need actual persisted status.

### R10: Missing package payment history and balance-collection semantics

Package grants omit purchase amount/currency/account/destination/fee/refund facts.
No workflow revokes credits when the funding purchase is refunded or disputed.
Partially consumed package refunds have no defined allocation policy.

A deposit sets payment status to paid but does not settle the full service price;
there is no subsequent collection workflow. Historical full service value cannot
be reconstructed reliably from a deposit and today's mutable event price.

## Proposed shared payment architecture

### Explicit routing boundary

Slice 1 adds the shared gateway boundary in
`apps/web/lib/payments/routing.ts` (`PaymentRoute`, `StripeContext`,
`resolvePaymentRoute`, `assertCheckoutRoute`) and connects both cash checkout
callers through `connect.ts`, `checkoutRouteForOrganization`. The concrete route
includes organization, charge account, mode, test/live identity, and a nonsecret
credential-context reference, plus destination and fee for Connect. Never store
raw keys in future attempt records. The Slice 1 section above records implemented
configuration and fail-closed behavior; persistence remains proposed.

Choose the route once for an attempt. Retrieval, fulfillment, refunds, and
reconciliation use that saved context rather than the current deployment mode.

### Durable records and recovery

Exact table names remain implementation choices. The required records are:

- **Payment attempt:** purpose (appointment/package), organization/service/client
  intent, immutable quoted terms, original route, expected amount/currency,
  Session/PaymentIntent references, expiration, lifecycle state, and fulfillment
  reference. Separate expected quote values from verified payment facts.
- **Refund operation:** original payment, requested amount/reason, stable operation
  ID, Stripe refund ID/status, and retry/reconciliation state.
- **Credit redemption:** exact grant, booking, client entitlement, quantity, and
  one permitted restoration.
- **Durable event receipt and pending work:** verified webhook receipt plus
  recoverable fulfillment/finalization tasks. These can use a small inbox/outbox
  design rather than a new general workflow framework.

Persist an attempt before requesting Checkout. Use stable request identity to
prevent duplicate Session creation on retries of the same intent. A changed
quote requires a new attempt; never reuse a key with changed Stripe parameters.
Persist the Session response; if it is lost, recover with the same request
identity. Stripe's finite idempotency retention means old ambiguous operations
must be reconciled before recreating them.

Use database uniqueness and transaction locks for business-level fulfillment,
including account/context-scoped Session and PaymentIntent identities. Do not
rely on one Redis claim or event ID alone. Distinct Stripe events can refer to the
same payment.

Record finalization work in the booking transaction, then perform external effects
after commit. Effects must have their own retry/deduplication strategy; repeatedly
running the entire current finalizer is not sufficient to prevent duplicate
calendar writes or messages. A crashed worker must be able to resume without
creating another booking or losing the remaining work.

### Webhook verification and processing

Retain raw-body SDK signature verification and reject missing/invalid signatures.
Require configured signing secrets for enabled payment intake. Bind incoming
events to the expected endpoint/account and live/test context; do not trust
unverified metadata to select arbitrary credentials. Handle Connect account
events in their appropriate configured context.

Support Checkout completed, async success/failure, expiration, and refund lifecycle
events, with external-refund reconciliation. Fulfill positive cash purchases only
after verified payment. Compare Session/purpose/amount/currency/account/routing
against the saved attempt; do not substitute zero or USD for missing facts.
Keep the initial integration's currency and totals consistent with the saved
quote; any later tax, currency conversion, or other amount adjustment requires
an explicit extension of that contract.

Acknowledge after durable acceptance or completed processing. If work is queued,
the database must retain enough to recover a lost queue notification. Duplicate
and out-of-order delivery must not regress settled state. Keep periodic
reconciliation for incomplete attempts, uncertain Stripe requests, pending
refunds, and interrupted effects.

The success redirect may invoke the same idempotent service, but is not necessary
for fulfillment. Show persisted processing/booked/refund-pending/refunded states.

### Failed, expired, and abandoned checkout

Validate eligibility before Checkout, then revalidate availability at fulfillment.
Retain existing slot/capacity constraints. Slot reservation is optional additional
scope; dependable compensation is mandatory when a paid slot cannot be honored.

Set Session expiration explicitly and separate offer validity from record
retention. Keep purchase evidence through retries and delayed settlement.
Visiting a cancel URL does not establish payment failure. Expired/failed attempts
must not grant bookings or credits, but a later verified successful payment must
receive fulfillment or durable compensation rather than being discarded.

## Pricing handoff and settlement

**CURRENT:** The new public appointment pipeline uses the pricing contract in
[PRICING-ARCHITECTURE.md](PRICING-ARCHITECTURE.md). `quoteAppointmentPrice` produces
a coherent server quote; `prepareAppointmentAttempt` saves positive-cash terms
before Stripe. Fulfillment verifies canonical Session/Intent/charge facts against
that quote and original routing. It never selects discounts or recalculates
prices, deposits, duration, or application fees from current configuration.

`createBooking` inserts an initially unsettled booking, persists the accepted
quote with `persistBookingPricingSnapshot`, applies verified settlement, and
binds the attempt inside one transaction. This ordering respects migration
0063's snapshot-before-settlement guards. Package redemption saves its credit
quote and proven ledger mutation in the booking transaction. Legacy paths lacking
these facts remain explicit compatibility paths, not reconstructed history.

| Settlement | Current new-path financial behavior |
| --- | --- |
| Full cash | Collect the saved effective service price through the original direct/Connect route. |
| Deposit | Collect the saved capped deposit. Preserve full service value separately from captured amount; cancellation refunds captured cash. |
| Zero cash / 100% promotion | No Stripe Session or positive-cash attempt; preserve cash snapshot/attribution. The zero-cash path has a durable operation claim and retry identity. |
| Package purchase | Save package price/currency/quantity/scope/owner/route before Checkout; grant once after verified payment. Appointment discounts do not implicitly price package sales. |
| Credit redemption | Authorize verified internal owner; save credit snapshot and exact redemption with booking; collect no cash and apply no cash promotion. |

Remaining deposit balance collection, arbitrary financial adjustments, and
staff/recurring commercial payment expansion are deferred. Slice 7 coupon
checkout binds one use reservation to the existing immutable attempt and quote;
verified fulfillment redeems it with the booking. Terminal expiry/failure
releases it, including by recovery after a crash. Ambiguous Stripe attempts
retain capacity pending reconciliation. Cancellation restores coupon allowance
in the existing local decision transaction; that does not prove a cash refund.

## Refund and cancellation responsibilities

| Original settlement | Compensation and implementation status |
| --- | --- |
| Direct cash payment | CURRENT for new verified durable bookings: refund the original account's payment without Connect flags. |
| Connect destination payment | CURRENT for new verified durable bookings: reverse the transfer; refund the saved actual application fee only when positive. |
| Redeemed package credit | CURRENT for new proven redemptions: restore that redemption once. Appointment cancellation does not refund the funding package purchase. |
| Package purchase | FUTURE / DEFERRED: coordinate returned cash with credit revocation; partially consumed packages need an explicit policy. |

Atomically record cancellation and its required compensation, then call Stripe
after commit using the refund-operation ID as an idempotency key. Record Refund
ID and status, reconcile uncertain results, and retry independently of booking
cancellation state. Refund the original captured amount,
never today's price or full service value when only a deposit was paid.

**CURRENT LIMIT:** Durable appointment cancellation supports a full refund of
captured cash. Partial-refund tooling and an authorized partial-refund policy
are deferred. Partial/external refund evidence
requires review rather than automatically calculating a remainder. A failed
Connect reversal must not trigger a silent retry without reversal. Failed or
cancelled destination refunds can leave returned funds on the platform and need
reconciliation. Disputes involving package-funded credits also need an explicit
review/revocation policy; they are not ordinary booking cancellations.

Slices 4–5 implement durable full appointment cash refunds and proven credit
restoration, respectively. New credit ownership uses verified internal user
identity, not supplied email or attendee ordering. Legacy payments lacking
verified charge facts and old credits lacking ownership/redemption provenance
retain their documented compatibility/review boundaries. Coupon use/restoration
is a separate future obligation; it must not replace or complete a cash refund.

## Rescheduling, recurring appointments, and other entry points

### Rescheduling

**CURRENT + DECIDED CONTRACT:** Moving the same booking changes scheduling facts
and preserves its historical pricing/settlement snapshot. This applies to
price-locked unpaid, deposit-paid, fully paid, $0 and package bookings, and coupon attribution/use. Do not re-evaluate discount eligibility, append a
replacement quote, refund/recharge, create a new cash attempt, or restore/redeem
value because the appointment moved. Preserve original payment, credit, and
coupon-use relationships even outside the original discount window.

There is **no grace-count/free-reschedule counter requirement**. This supersedes
the earlier one-free-move proposal and any unpaid-reschedule repricing guidance.
Availability, authorization, and safety restrictions still apply. Cancellation
plus a genuine new booking has a new operation and current pricing/eligibility.

`reschedule-booking.ts:rescheduleBooking` currently updates the same booking and
keeps actual duration/snapshots/payments/redemption. Slice 5 rechecks cancellation
under the booking lock and blocks package moves during ambiguous finalization.
Concurrent move/provider reconciliation and external-effect delivery remain
technical limitations; they do not authorize financial repricing. See the pricing
contract for the original-priced-instant distinction and entry-point coverage.

### Recurrence

**CURRENT:** New package recurring creation is rejected; new public cash creation
blocks commercial recurring series with the group-slot exception described in
[PRICING-ARCHITECTURE.md](PRICING-ARCHITECTURE.md). This is not universal legacy or
staff/internal coverage. **DECIDED:** Unsupported financial series must fail
closed; future independently funded occurrences need independent accepted terms,
while moving an existing occurrence preserves its history.

The later collection design remains a product decision: collect independently
per occurrence, or introduce a series purchase with explicit per-occurrence
allocations. Aggregate collection requires allocations for partial availability,
partial refunds, and first/later occurrence cancellation. Credits require an
explicit redemption for every covered occurrence. Do not copy the first date's
promotion or attach a whole-series refund to the first appointment by accident.

### API, staff, internal meetings, and approval

Preserve API v1's paid-service rejection until that API supports the shared
quote/payment contract. Staff creation of commercial services needs an explicit
authorized unpaid/offline policy rather than silently bypassing pricing.
Internal team meetings should retain an explicit noncommercial purpose.

Paid and credit bookings currently bypass approval. Preserve that deliberately,
or add compensation if paid bookings are later allowed to await approval. Define
the approval behavior of zero-cash promotional bookings explicitly too; absence
of a PaymentIntent must not accidentally decide product policy.

## Proposed configuration and direct-mode UI

Slice 1 adds deployment-level `STRIPE_PAYMENT_MODE=disabled|direct|connect` in
`apps/web/lib/server/env.ts`, defaulting to disabled. Existing deployments must
explicitly select Connect and provide the required account/environment fields
before new sales resume; a key alone no longer enables checkout. See the concrete
configuration table above. No deployment configuration has been changed.

In direct mode:

- Bind payments to the Light & Balance organization. The application's multi-org
  model must not let unrelated organizations collect through this account.
- Require a key and webhook configuration for positive cash checkout; validate
  expected account/live-test identity during implementation/deployment checks.
- Treat platform fee configuration as Connect-only.
- Separate acceptance of new purchases from processing historical events/refunds.
- Keep DayOtter Pro subscriptions/portal independently enabled and scoped.

Slice 1 uses `STRIPE_DIRECT_ORGANIZATION_ID` and `STRIPE_ACCOUNT_ID` for this
binding; broader multi-account credential management remains deferred.

Hide Payouts, withdrawal controls/minimums, Connect onboarding, connected balances,
and Express links on web and mobile. Gate backend Connect/withdraw/dashboard
routes as well; navigation hiding alone is insufficient. A small authorized
business payment-status surface may link to the normal Stripe Dashboard. Do not
replace Connect withdrawal UI with a new direct-account withdrawal implementation.

Retain service pricing/deposits and packages. Update public/team/embed booking
pages and SlotPicker to display the server quote for the selected appointment
time, and show truthful payment/refund state on return pages. Update Apps registry
copy and capabilities, `/api/me`, payment status responses, environment examples,
and deployment/self-hosting documentation consistently.

## Reuse versus changes

Reusable without topology-specific rewrites:

- Pure promotion calculation, server quote loading, and snapshot representation.
- Availability calculation, slot/capacity constraints, input validation, and most
  booking/attendee persistence logic.
- Hosted Checkout and the existing single Stripe-client approach.
- Raw-body webhook verification.
- Credit grant uniqueness and the corrected transactional consumption mechanism.
- Currency formatting and ordinary pricing/package editing controls.

Some of these callers still require integration changes. In particular,
`createBooking` needs transaction-boundary/snapshot ordering changes, the Checkout
helper needs durable idempotency/binding, and finalization needs recoverable work.
The current destructive claim, boolean refund API, heuristic credit restoration,
and unchecked package fulfillment should not be shared unchanged.

Isolate Connect account onboarding/status, destination/fee resolution, connected
balances/payouts, Express links, and related UI. Retain historical Connect refund
support even when new sales use direct mode. No Accounts API migration or broader
Stripe SDK modernization is necessary merely to select direct routing; assess
version compatibility separately when implementing and pin/test the chosen API
and webhook versions.

## Migration and cutover

1. Apply migrations 0063 and 0064 before code querying their tables. Even free
   booking requests now check durable attempt identity, so 0064 is required before
   deploying this Slice 2 code. Preserve handwritten
   snapshot triggers and the ordering of referenced indexes/foreign keys. Add new
   payment structures additively.
2. Audit existing records before introducing uniqueness constraints. Missing
   historical snapshots mean unknown pricing, never free; do not fabricate old
   prices or promotion attribution from current configuration.
3. Establish which Stripe account owns historical charges before replacing any
   credentials. The investigation did not establish whether the intended Light &
   Balance account is already the current charge-owning account.
4. Keep destination/account facts on old records. New mode governs new attempts
   only. A null destination does not prove account ownership, especially for
   records predating destination tracking.
5. If the charge-owning account changes, retain a deliberate legacy credential and
   webhook processing context, or resolve its obligations before removing access.
   A new account's key cannot retrieve/refund the old account's PaymentIntents.
6. Drain or transition outstanding Redis checkouts using actual Session lifetimes
   and delayed-payment behavior, not the one-hour Redis TTL. Retain legacy
   fulfillment handling until obligations are resolved. Already deleted/expired
   inputs cannot reliably be reconstructed from current Stripe metadata alone;
   unresolved cases may require records/logs/backups and manual reconciliation.
7. Mark package purchases without sufficient financial facts as legacy and
   reconcile them before offering automated cash refunds. Preserve existing
   credit balances; do not guess original routing or redeemed grants.
8. Changing application mode does not move connected balances or alter existing
   manual payout schedules. Resolve those historical obligations separately.
   Their existence and amount were not inspected.
9. Keep Pro subscription customer/price/subscription IDs and portal credentials in
   their original account context. Do not repoint them accidentally with booking
   payments.
10. Rehearse rollback with mixed historical/new records. Rollback must not return
    new durable attempts to destructive Redis-only processing or abandon new
    refund tasks. Retaining schema alone is not sufficient compatibility.

## Implementation slices and required validation

Slices 1–5 passed validation. Their implementation and adversarial tests are recorded below. Slices 6–7 remain proposed. Each slice should be independently reviewable; a
routing flag alone is not the live-payment readiness milestone.

| Slice | Implementation boundary | Tests / evidence required |
| --- | --- | --- |
| 1. Explicit topology and capabilities (validated) | Configuration, route resolver, typed routing identity and Stripe metadata (no attempt persistence), Connect backend/UI gates. | Direct omits transfers/fees despite stale Connect fields; Connect rejects absent/unready recipients; wrong org/config fails closed; old Connect payments retain original refund route after mode switch. |
| 2. Durable checkout and quotes (appointment implementation; validated) | Saved appointment terms, stable creation identity and expiration, minimal snapshot/booking transaction handoff. Package intent work remains deferred. | Stripe accepts Session before response/DB persistence fails; repeated request; promotion/service/package edits after quote; mismatched amount/currency/account; zero cash bypass; expiration and delayed payment. |
| 3. Transactional fulfillment and event recovery (appointment implementation; bounded finalization) | Shared paid fulfillment, database uniqueness, snapshot-before-settlement ordering, durable event receipt and finalization work. | Concurrent redirect/webhook; different events for one payment; crash before/after commit; DB/queue outage; slot conflict; async success/failure; missing/invalid signatures; out-of-order events; resume interrupted calendar/reminder work without duplicate booking/grant. |
| 4. Refund lifecycle (validated; full appointment cancellation only) | Durable compensation, original route selection, refund status/reconciliation, truthful return UI. | Cancellation crash before request; refund accepted before local persistence; ambiguous timeout; pending/failed/partial/external refunds; Connect fee/no-fee cases; failed reversal; repeated cancellation. |
| 5. Package entitlement integrity (implemented; purchase refunds/revocation deferred) | Internal owner identity, mutation provenance, atomic redemption/restoration, durable verified package purchases, recovery. | Victim email cannot authorize spending; unpaid/null-PI/duplicate purchase events; concurrent last-credit consumption; concurrent restorations; guest ordering; package changes/deletion; partially consumed purchase refund. |
| 6. Remaining pricing entry points | Staff/API pricing coverage, accepted-source extensibility, $0 operation identity, historical-price-preserving moves, occurrence settlement; coupons require separately scoped usage work. | Promotion date boundaries/DST; deposit changes; zero-cash versus credit; settled adjustment decisions; paid/credit series rejected until supported; partial series creation; first/later cancellation and allocation. |
| 7. Cutover and compatibility | Additive migration, legacy processing, web/mobile/docs/deployment updates. | Legacy missing snapshots/duplicate audit; old Connect plus new direct records; outstanding old Sessions; account-context change; connected-balance obligations; rollback preserving new financial work; direct routes expose no withdrawal capability. |

Retain and extend existing tests in `packages/core/src/pricing.test.ts`,
`apps/web/lib/booking/pricing.database.test.ts`,
`apps/web/lib/booking/booking-logic.test.ts`, and
`apps/web/lib/payments/fulfill.test.ts`. The original database suite covered pricing
constraints and concurrent credit consumption. Slices 2–5 now add real database
tests for checkout/refund durability, redemption/restoration, concurrency, and
crash boundaries. Continue requiring those guarantees beyond mocked happy paths. Future Stripe validation
should use an isolated test environment, never live money movement.

Before live direct payments, complete durable attempts/fulfillment/refunds and
accurate status reporting. If packages are enabled, complete their payment and
entitlement protections. Unsupported paid recurrence and settled adjustments must
be explicitly gated until implemented. Promotion integration must cover every
enabled creation/settlement path rather than enabling the calculator alone.

## Public Stripe references used in the review

- [Checkout Session creation](https://docs.stripe.com/api/checkout/sessions/create):
  explicit `expires_at`; default Session lifetime is 24 hours.
- [Event types](https://docs.stripe.com/api/events/types): completed, delayed
  success/failure, expiration, and refund events are distinct.
- [Webhook guidance](https://docs.stripe.com/webhooks): raw-body verification,
  duplicate delivery, asynchronous handling, and lack of delivery ordering.
- [Idempotent requests](https://docs.stripe.com/api/idempotent_requests): stable
  request parameters and finite idempotency retention.
- [Refund lifecycle](https://docs.stripe.com/refunds): pending/failed refunds,
  partial amounts, and account-balance implications.
- [Destination charges and refunds](https://docs.stripe.com/connect/destination-charges?platform=web&ui=stripe-hosted):
  charge ownership, destination transfer behavior, transfer/application-fee
  reversals, and reconciliation after failed refunds.

Recheck relevant API/SDK details during implementation. These references establish
provider semantics; the source map and risks above describe the inspected code.

## Slice 3 implementation: observed payment, transactional fulfillment and recovery

This section describes implemented and mechanically validated appointment code. It supersedes the Slice 2 interim fulfillment path and the baseline Redis audit for **new durable appointment attempts only**. At the Slice 3 checkpoint, packages, legacy Redis Sessions and refunds were unchanged; the Slice 4 section below supersedes that refund limitation for verified durable paid bookings. Production payments remain disabled by deployment configuration; this work does not enable them.

### Database and state transitions

`packages/db/src/schema/payment-attempts.ts` and migration `0065_payment_fulfillment.sql` extend `payment_attempts` with write-once `success_facts` and `payment_succeeded_at`, recovery progress/backoff, and review codes. Existing Slice 2 fulfilled rows retain their historical absence of these new observations/finalization context. The migration does not manufacture Stripe facts or replay their old finalization.

- `prepared/open → payment_succeeded`: successful Stripe payment has been verified and committed; booking is now owed.
- `payment_succeeded → fulfilling`: work has started. This is a progress marker, **not an exclusive process lease or completion**. After a crash it remains discoverable and retryable.
- `payment_succeeded/fulfilling → fulfilled`: booking, attendees, pricing snapshot, paid fields, immutable attempt→booking binding and encrypted finalization context commit in one transaction.
- Transient booking/database errors return unbound work to `payment_succeeded`, with bounded retry backoff. Availability/configuration/settlement contradictions requiring human resolution become `requires_review`; their saved success facts and customer obligation remain retained.
- Unpaid Session expiration/failure becomes `expired/payment_failed`. A later verified success may still establish an obligation; old failure events cannot erase observed success. Creation ambiguity alone may automatically leave review after original-identity payment verification; other review codes need explicit resolution.

The replacement PostgreSQL trigger preserves immutable Slice 2 financial terms and write-once Session/Intent/booking IDs. Success facts, observation time, finalization context and start time are also write-once. State transitions and new booking bindings are guarded in PostgreSQL. New bindings require observed success and pending durable context. Attempts and receipts cannot be deleted.

`payment_events` is a small encrypted signed-event inbox with unique `(environment, charge_account_id, stripe_event_id)`, immutable payload/hash/relationship, retry progress and terminal completion/review. This is appointment-only, not a new general queue subsystem. Apply 0065 **before** this application code. Existing 0064 observations/terms remain preserved. Stop/drain the old Slice 2 appointment fulfillment handlers for this cutover: their booking-binding path does not record the new required success facts and will fail the strengthened guard. Do not run mixed Slice 2/Slice 3 fulfillment against the upgraded schema or roll paid work back to the old handler; Stripe can retry deliveries during the controlled restart. No deployment was performed here.

### Verified Stripe facts and identity

`apps/web/lib/payments/payment-success.ts:verifiedPaymentFacts` validates the original account-scoped Session plus the SDK-retrieved PaymentIntent with expanded latest charge. It checks Session/Intent IDs, metadata relationship/quote hash/organization, amount/currency, test/live environment, original account/credential context, destination and application fee, absence of incompatible `on_behalf_of`, successful Intent status and fully received amount, and a paid/captured matching non-refunded charge. Direct routing rejects even a stale transfer or an explicitly supplied zero application fee. Zero-fee Connect remains a destination payment with fee amount zero.

`stripe.ts:retrievePaymentIntent` and `sessionForPaymentIntent` use the saved route, authenticated account identity check and original environment; they do not select a new merchant from current sales mode. Browser parameters/metadata alone are never evidence of payment. An unpaid completed Checkout or a processing/requires-action/requires-capture Intent does not satisfy settled success. Incomplete authenticated evidence and transient API/configuration access failures remain retryable. Contradictory financial identity/terms enter review without overwriting established identifiers.

`payment-work.ts:observePaymentSuccess` independently commits normalized facts (Session, Intent, charge, received amount, currency, environment/account/context, original topology/destination/fee). Duplicate observations compare against the already stored facts under `FOR UPDATE`. Fulfillment uses this immutable evidence and Slice 2's saved quote/input/duration; it does not rerun promotion selection or compute a new route/fee. Current availability and booking policy may reject the saved appointment into review; they cannot substitute new financial terms or a different duration.

### Concurrency and webhook/browser behavior

`payment-work.ts:fulfillObservedPayment` converges callers on `create-booking.ts:createBooking`. Its transaction locks the attempt row, validates original settlement, inserts the pricing snapshot before paid fields, and calls `payment-finalization.ts:bindPaidBooking` in the same transaction. The lock and write-once binding prevent two bookings from surviving concurrent workers, webhook/browser races or retries. A losing caller reads the already bound booking. There are no session advisory locks held outside database transactions and no correctness dependency on Redis. No durable payment path automatically issues a best-effort refund for a booking failure: compensation requires review/durable refund work in Slice 4.

`payment-events.ts:receiveAppointmentEvent` runs after the existing raw-body SDK signature/environment verification and stores the encrypted receipt **before** Stripe retrieval or fulfillment. It accepts Checkout completed/async-success/async-failure/expired and Intent-success events. Known durable Session/Intent IDs missing metadata cannot fall through to legacy Redis. Before Session binding, an immutable `client_reference_id` matching a saved attempt also selects the durable path, in both webhook intake and browser reconciliation; missing quote/routing metadata then requires review. Unknown durable UUIDs fail retryably; malformed relationships reject. Historical/package/Pro events without a durable relationship retain the existing explicit handler boundary.

`processAppointmentEvent` re-reads canonical Stripe objects under the saved account. Completed-but-unpaid events are acknowledged as waiting, with the open attempt still discoverable. Valid async success drives the same observation/fulfillment path. Pending receipt/transient work returns HTTP 500 so Stripe retries remain useful. Fulfilled/already-fulfilled events return 200; contradictions return 200 **only after durable review recording** and are discoverable separately. Failed intake/DB writes do not receive permanent success. Duplicate inbox processing is harmless through immutable evidence, guarded receipt progress and transactional booking binding.

`/booking/paid` requests authenticated reconciliation, returns the bound booking when known, and otherwise reports processing or review. It no longer sends transient errors to a page claiming an automatic refund. Processing copy does not assert payment receipt or email delivery prematurely. The browser is optional; success-URL visits cannot establish successful payment.

### Recovery and crash windows

`recovery.ts:recoverAppointmentPayments` is a bounded PostgreSQL pass over pending event receipts, prepared/open/observed/in-progress attempts and pending/interrupted finalization. It retries API reads, original Session creation only within Slice 2's fixed idempotency window, and booking obligations. It never creates a replacement financial intent to repair ambiguous creation. Signed webhooks and browser reconciliation drive individual records; operators can run a pass now using:

```bash
pnpm --filter @dayotter/worker exec tsx --tsconfig ../web/tsconfig.json ../web/scripts/recover-payments.ts
```

`scripts/recover-payments.ts` requires an explicit `DATABASE_URL`, existing payment/encryption configuration, and uses the saved historical route. It logs counts rather than payloads/secrets. Periodic deployment/worker scheduling and monitoring are **not implemented** in this slice and must be arranged before live operation; no production command/configuration was changed during this work. Review queries should include attempts with `state = 'requires_review'` **or non-null `review_code`** and finalization `requires_review`, plus pending inbox failures.

| Crash point | Durable next action |
| --- | --- |
| Before receipt/observation commit | Stripe delivery retry; recovery re-reads prepared/open Session with its saved terms. |
| After receipt, before success observation | Pending inbox reprocesses original event/account relationship. |
| After success observation, before booking | `payment_succeeded/fulfilling` retains paid obligation; retry requires no Redis or new quote. |
| During booking transaction | Entire booking/snapshot/attempt binding/context rolls back; paid observation remains. |
| Immediately after booking commit | Existing binding returns same booking; pending finalization is discoverable. |
| Before external invocation | Atomic pending→running claim permits one invocation. |
| During/after an external effect, before invocation status commit | Running state and saved start time remain; after ten minutes recovery records ambiguous review and **does not automatically replay**. |

### Bounded ancillary finalization and remaining gap

`payment-finalization.ts:finalizePaymentBooking` atomically claims `pending → running`, tracks the start time, and invokes the existing `finalizeConfirmedBooking` once. Concurrent callers leave an active invocation alone. Successful return records `attempted`; a thrown/interrupted invocation records `requires_review`. Ten minutes is a conservative ambiguity threshold, not proof the original worker is dead; even a slow original invocation never causes automatic duplicate invocation. Existing fulfilled Slice 2 rows with no context are not backfilled or replayed. A booking changed/cancelled before first invocation is reviewed instead of finalizing stale details.

**`attempted` is not a delivery guarantee.** The existing finalizer and helpers catch individual calendar/Zoom/reminder/email/webhook/plugin/automation/travel failures; a Redis queue request with unlimited retries can also leave an invocation running until an operator intervenes; missing email configuration can also return without delivery. This slice keeps financial/booking truth independent of these failures and persists enough context/progress for review, but does not make every external effect resumable or exactly once. A full per-effect outbox with provider idempotency, completion tracking and reconciliation is still required for guaranteed ancillary delivery. Cancellation/rescheduling racing external invocation likewise needs lifecycle-aware per-effect handling later. Do not blindly rerun the whole finalizer to resolve ambiguity.

### Slice 4 and operational dependencies

Durable refund/compensation lifecycle, paid slot-conflict resolution, provider reconciliation and operator review tooling remain next-slice work. An external refund after success observation is not automatically fenced against booking fulfillment in this slice; Slice 4 must reconcile later refund/dispute facts and coordinate compensation with the same attempt/booking transaction boundary. Original success facts remain true historical observations even if a later refund occurs; duplicates of an already bound booking do not reject it merely because its charge was subsequently refunded. Legacy Redis/payment-intent lookup/refund behavior retains its original weaker crash/concurrency guarantees and is not claimed to be hardened. Package entitlements, holds, resources and recurring paid-series semantics remain excluded. Periodic recovery, review monitoring and external-effect delivery guarantees are prerequisites to assess before enabling production payments.

### Slice 3 validation checkpoint

On 2026-10-01 (America/Boise), validation passed on the complete Slice 3 tree:

- Focused payment tests plus all database regressions: **149 passed** (including **51 PostgreSQL tests**: 32 fulfillment/concurrency/upgrade tests, 5 intent tests, 14 promotion/pricing tests).
- Full `@dayotter/web` suite with both guarded test database URLs enabled: **349 passed, none skipped**, 45 files. Both test commands used `--maxWorkers=1 --minWorkers=1`.
- `NODE_OPTIONS=--max-old-space-size=4096 pnpm --filter @dayotter/web typecheck`: passed.
- `pnpm --filter @dayotter/db typecheck`: passed.
- Scoped Biome over the 26 changed TypeScript/TSX files and `git diff --check`: passed.
- Generated snapshot comparison changed only `payment_attempts` and the new `payment_events`; the 0065 snapshot chain and migration journal match. Integration setup applied every repository migration, including the handwritten guards, and exercised upgrade of a real 0064 fulfilled fixture.

Tests used a disposable PostgreSQL 17 container with a free loopback-only port, tmpfs storage and no mounts/volumes. Test URLs existed only in validation process environments; each database suite created/migrated/dropped its own guarded disposable database. No deployed database, real Stripe credentials or production configuration was used. The container was removed after validation.

Final review specifically exercised duplicate receipts/events, twelve concurrent fulfillment calls, browser/webhook racing, commit/rollback boundaries, interrupted finalization, acknowledged unpaid receipts followed by observed success, conflicting identifiers/terms/environment/account, delayed settlement, API/DB/provider failures, cross-attempt payment identity conflicts, legacy distinction and current routing configuration changes. Ordinary formatting/test fixture fixes were incorporated. The review also removed connection-holding session locks, guarded stale ambiguity/failure decisions, classified identity uniqueness failures as review and sanitized new Stripe read errors. This is a Slice 3 checkpoint, not authorization to enable live payments or a claim of completed durable refunds/per-effect delivery.


## Slice 4 implementation: durable full cancellation refunds (validated at `0a90317`)

This section describes the code built on validated Slice 3 commit `4ec3d98dfb36c51bd795d1d617326fb344a83ad9`. Implementation and manual diff review were checkpointed without validation; a subsequent mechanical pass completed focused/full web and PostgreSQL tests, web/DB typechecks, scoped Biome and diff checks, with fixes committed at `0a903172fd7c8e8cea519eecb49658d8d6201011`. No build validation is claimed. No production runtime/configuration, real Stripe credentials, deployed database or local Compose file was used. Do not treat this checkpoint as authorization to enable payments.

### Boundary and historical refund terms

`packages/db/src/schema/refund-operations.ts` and migration `0066_refund_operations.sql` add `refund_operations`. This supports **one full cancellation refund of the captured appointment payment** per attempt/booking/charge. It does not implement partial refunds, refunding an outstanding service balance, paid-series policy, package-credit restoration or compensation of an unbound paid appointment that could not be booked. Those paid obligations remain in Slice 3 review pending an explicit resolution policy/tool.

Immutable columns retain organization, booking, original attempt, cancellation purpose, verified PaymentIntent/charge identity, captured amount/currency, Stripe test/live environment, charge account/primary credential context, direct/Connect mode, destination, actual saved application fee, stable operation UUID and Stripe idempotency key. The amount is `payment_attempts.success_facts.amount`, including a captured deposit where applicable; current service prices, promotions, deposit settings, fees or remaining balance are never recalculated. Stripe Refund ID, first submission time and successful observation time are write-once. No secret or booking-input copy is stored in a refund row.

Unique indexes on attempt, booking, account/environment/charge and idempotency key prevent independent full refunds or cumulative application operations exceeding this captured payment. The refund's scoped identity is also unique. The insert trigger checks the snapshot against the verified payment attempt and the same organization's cancelled paid booking. A caller cannot insert another organization's financial terms or an excessive amount. Terms/deletion/identifier/terminal-state guards retain obligations. No historical records are automatically backfilled during migration.

Apply 0066 before the new application code and drain old cancellation/refund handlers during cutover. Old Slice 3 cancellation cannot satisfy the new transaction-end obligation guard; an already in-flight legacy refund may still reach Stripe and must be reconciled as external history rather than recreated. Do not run old cancellation code against the upgraded schema or roll refund processing back after accepting new durable obligations. No cutover/deployment was performed in this pass.

### Cancellation transaction and fulfillment coordination

`apps/web/lib/payments/refunds.ts:decideBookingCancellation` takes the existing authorized capability UID, locks **attempt → booking**, validates settlement binding through `booking-routing.ts:originalBookingRefundRoute`, changes booking status and inserts/discovers its unique refund obligation in **one PostgreSQL transaction**, before any Stripe request. Repeated requests find the same operation even when the booking is already cancelled. A failure inserting the operation rolls cancellation back. An inconsistent durable settlement prevents cancellation and external refund execution, rather than guessing financial truth.

Deferred database guards require a newly cancelled verified paid booking to have an obligation at commit, and newly refunded booking status to have a succeeded operation. Another deferred guard requires operation success and booking refunded status to commit together. Once an operation exists, the booking cannot be resurrected/rerouted or regress from refunded to paid. Attempt binding remains immutable; Slice 3 recovery returns that same booking, including its cancellation state, and never creates a replacement.

`payment-finalization.ts:finalizePaymentBooking` now claims pending work while holding the same attempt → booking locks and checking current booking status. Cancellation marks pending finalization as review so it cannot start afterwards. If provider work was already running, cancellation retains `cancelled_during_finalization` review and continues its independent refund obligation. A transient booking/finalization failure still does **not** automatically decide that a refund is owed.

### Operation lifecycle and Stripe execution

| State | Meaning and next action |
| --- | --- |
| `owed` | Cancellation/refund decision committed; Stripe may not have been called. |
| `submitting` | First outbound creation time durably recorded; outcome may be unresolved. This is not completion or a process lease. |
| `pending` | Refund ID known and Stripe reports pending. Retrieve again; never create a replacement. |
| `retryable` | Stripe/config/read/database failure left unresolved work; retry/reconcile with backoff and original identity. |
| `succeeded` | Account-scoped refund/charge and required Connect reversal/fee facts verified; booking refunded status committed together. |
| `requires_review` | Contradictory identity/terms, external/partial refund, expired creation ambiguity, failed/canceled refund, or customer-action requirement. Obligation remains retained and visible; no automatic replacement request. |

`refunds.ts:executeRefundOperation` performs Stripe I/O outside database transactions. Multiple workers may issue the same outbound request, but always with identical immutable parameters and `appointment-refund:<operation-id>:v1`. Row locks serialize identifier binding and financial completion; stale pending/error observations cannot regress another worker's success. Review/complete records do not automatically reopen. A later contradictory observation may flag a succeeded row with a review code without erasing its established success.

`stripe.ts:createOperationRefund` refunds the original **charge** for its exact captured amount and a fixed `requested_by_customer` API reason. Customer cancellation text remains on the booking; it is not sent to Stripe. The primary credential's environment/runtime and authenticated account identity must match the historical route. Current sales mode, configured merchant ID, Connect readiness and current platform fee do not select a new refund merchant. Account access/config outages remain recoverable; replacing the primary key with a different merchant fails closed and needs original account access restored. There is still only one primary credential context.

Before creating an unknown refund, recovery lists refunds on the original charge. A matching operation metadata UUID is only correlation: completion must also verify charge/Intent identity, amount/currency, original account/environment and reversal facts. External, partial, conflicting or incompletely listed refunds enter review; the application never computes a guessed remainder. Known Refund IDs are retrieved without another create. An ID is retained immediately after an authenticated creation/list response, even if the subsequent verification read fails; contradictions cannot replace it or mark the booking refunded.

Creation may replay only for **20 hours from the first durably recorded submission**, comfortably within Stripe's minimum 24-hour idempotency retention. The gateway rechecks this deadline after account verification before sending. If Stripe accepted a request before a timeout/crash, recovery finds its original refund or replays that same key within the window. After the window, a found matching refund can still reconcile, but an unresolved absence becomes review; the key/time are never rotated. A list/charge race with another worker's accepted refund retries reconciliation rather than creating another obligation or declaring a contradiction.

These parameters follow Stripe's [refund creation API](https://docs.stripe.com/api/refunds/create), [refund states](https://docs.stripe.com/api/refunds/object), [idempotent request semantics](https://docs.stripe.com/api/idempotent_requests), and [transfer reversal relationship](https://docs.stripe.com/api/transfer_reversals/object).

### Direct, Connect and application fees

`refund-terms.ts:refundRoute` reconstructs only immutable operation routing. Direct creation omits reversal/fee flags and connected-account headers. Connect creation includes `reverse_transfer: true`; `refund_application_fee: true` appears **only** for the actual saved positive application fee. Zero-fee Connect retains its transfer reversal without the fee-refund flag. No current fee percentage is consulted.

`stripe.ts:retrieveOperationRefund` retrieves the Refund with expanded transfer reversal and the original Charge with expanded transfer/application fee. `refund-terms.ts:verifyRefundEvidence` checks the write-once Refund ID, operation/attempt metadata, charge/Intent relationship, exact amount/currency, authenticated account/context and charge environment/captured facts. A succeeded Connect refund requires a full matching destination transfer reversal. A positive application fee must show the original fee amount fully refunded. Missing/contradictory evidence goes to review instead of claiming completion. Pending is not refunded; failed/canceled/requires-action states retain the known identity for operator reconciliation, including possible reversed-transfer/platform-balance consequences. No automatic second refund is generated to fix a failed first refund.

The expanded transfer/fee/reversal verification and required restricted-key read permissions deserve particular validation attention. Unavailable reads do not authorize a different account/route or a guessed success.

### Recovery, webhook and browser behavior

`refunds.ts:recoverRefundOperations` selects bounded due owed/submitting/pending/retryable records independently of Redis. It also repairs a bounded set of pre-0066 cancelled bookings **only where Slice 3 already stored verified payment facts**; an already-refunded row without an operation enters explicit review. An inconsistent pre-upgrade booking binding is marked `refund_obligation_binding_requires_review` on its attempt, displayed as review, and excluded from repeated repair scans so other obligations can recover. Slice 2/legacy rows lacking charge observations are never synthesized into durable refund snapshots.

`apps/web/scripts/recover-payments.ts` now runs appointment recovery followed by refund recovery. The existing operator command is:

```bash
pnpm --filter @dayotter/worker exec tsx --tsconfig ../web/tsconfig.json ../web/scripts/recover-payments.ts
```

It requires the explicitly configured database and original payment credentials; it logs only counts. Periodic invocation/review monitoring remains an operational deployment task. No scheduling, deployment or runtime change was made. Query refund review work using `state = 'requires_review' OR review_code IS NOT NULL`; include retryable failures and their next recovery time when diagnosing stalled work. Review resolution tooling is not implemented in this slice.

Refund-related webhook events do **not** directly bind/advance operations in Slice 4. Existing webhook signature handling remains unchanged. Authenticated retrieval plus bounded PostgreSQL recovery is the authoritative refund path, so correctness does not depend on delivery of refund webhooks or trusting metadata supplied by an event/browser. Unknown refund events cannot mutate an unrelated operation. Automatic observation of arbitrary dashboard-issued refunds/disputes on unbound paid attempts remains outside this full-booking-cancellation implementation; it must be resolved before offering broader external compensation/reconciliation guarantees.

`cancel-booking.ts:cancelBookingWithResult` accepts cancellation, executes/re-drives durable work and returns safe public refund state. The boolean `cancelBooking` wrapper retains existing Otter/series count semantics. `/api/bookings/[uid]/cancel` returns success for repeated cancellation of an existing booking and reports `processing`, `refunded` or `requires_review`; no raw errors or internal financial IDs are returned. Series responses report the target booking's refund state, not a guarantee about every occurrence. The booking page reads the operation and displays processing/review independently of the cancelled status. Database failure before cancellation commit does not accept cancellation; failure after commit leaves discoverable debt even if the request itself fails.

### Crash review and remaining limits

| Window | Durable result / recovery |
| --- | --- |
| Before cancellation transaction commit | Neither decision nor obligation commits; retry authorized cancellation. |
| After cancellation/obligation commit, before Stripe | Owed operation is discoverable; already-cancelled requests still reuse it. |
| During create / timeout | Submission time/key survive; list/retrieve/replay same original operation within the window. |
| Stripe accepted, before Refund ID save | Metadata + original charge list recovers identity, or same key replays. |
| Refund ID saved, before success verification/commit | Retrieve known ID; keep booking paid until verified transaction completes. |
| During success transaction | Operation and booking status roll back together; retry known Refund. |
| Immediately after success commit | Duplicate calls return persisted refunded state; no new create. |
| Config change / server restart / Redis loss | Original operation snapshot and PostgreSQL discovery remain authoritative. |
| Cleanup/finalization failure | Cancellation/payment/refund truth remains committed; financial work is not replayed because calendar/email cleanup failed. |

Cancellation calendar/reminder/email/webhook/focus-block cleanup remains best effort and is not an outbox. A process crash can omit cleanup; an already-running booking finalizer/rescheduler may race cleanup and require provider reconciliation. Failures do not erase the refund operation, delete the booking, reopen it, or authorize another refund. Do not replay a whole finalizer to repair individual provider effects. Legacy boolean refunds still have their historical weaker failure semantics and zero-fee ambiguity where actual fees were never retained. Package restoration, paid recurring series, pre-booking compensation decisions, arbitrary partial refunds, external disputes and universal effect delivery remain excluded.

For this implementation's full-cancellation boundary, **once refund debt commits, it remains discoverable until verified success or explicit review**; cancelled status, retry, timeout, restart or mode/config changes cannot consume/delete that debt. This is an intended invariant backed by implemented guards/tests, not a claim that unrun tests have passed.

### Tests implemented and required validation

Added `apps/web/lib/payments/refunds.database.test.ts` with guarded disposable PostgreSQL setup, complete clean migration application, real 0065→0066 upgrade, concurrent/duplicate cancellation and worker recovery, rollback/crash boundaries, saved-key retries, pending/failed/ambiguous states, terminal contradictions, direct/zero-fee/positive-fee Connect history, financial guards/tenant binding, fulfillment/finalization races, cleanup failures and explicit legacy behavior. Each database suite creates/drops a random `dayotter_payments_test_*` database under a loopback-only `dayotter_payments_test` admin URL. No database or test container was launched in this implementation pass.

Added `refund-terms.test.ts`, shared `refund-fixtures.ts`, cancellation route response tests, and durable refund SDK cases in `stripe.test.ts`. They cover exact financial/context/reversal evidence, all supported refund statuses, stable idempotency parameters, historical mode/config changes, bounded creation, sanitized errors and truthful duplicate API responses. These tests were subsequently executed in the Slice 4 validation pass.

The later validation pass must use only disposable PostgreSQL 17 infrastructure, loopback binding, ephemeral storage and test-only credentials. Set both guarded test URLs only in the validation process. Run sequentially:

```bash
# With PAYMENTS_TEST_DATABASE_URL and PROMOTIONS_TEST_DATABASE_URL pointing only at guarded disposable DBs:
pnpm --filter @dayotter/web test lib/payments app/api/bookings --maxWorkers=1 --minWorkers=1
pnpm --filter @dayotter/web test lib/payments/refunds.database.test.ts lib/payments/fulfillment.database.test.ts lib/payments/attempts.database.test.ts lib/booking/pricing.database.test.ts --maxWorkers=1 --minWorkers=1
pnpm --filter @dayotter/web test --maxWorkers=1 --minWorkers=1
NODE_OPTIONS=--max-old-space-size=4096 pnpm --filter @dayotter/web typecheck
pnpm --filter @dayotter/db typecheck
# Scope Biome to the changed TS/TSX files in the Slice 4 commit:
pnpm exec biome check <changed-TS-and-TSX-files>
git diff --check HEAD^ HEAD
```

Pay special attention to deferred-trigger SQL syntax/order, transaction-end cancellation/completion guarantees, migration compatibility with both Slice 2 and Slice 3 fixtures, lock order under concurrency, stale Stripe reads after another worker succeeds, transfer/fee expansion shapes/permissions, safe creation-window boundaries, and the distinction between original captured deposits and total service price. Fix ordinary mechanical/test-fixture/format failures during validation; financial/concurrency/migration changes require careful review. Remove disposable infrastructure after that validation. No command above was executed for this Slice 4 checkpoint.


## Slice 5 implementation: package ownership, credit provenance, and durable purchase grants

This section supersedes the original audit's email-based package paths and the deferred package limitations in Slices 1–4. It does not implement package-purchase cash refunds/revocation, recurring financial policy, a universal outbox, or coupon usage. The earlier grace-reschedule proposal is superseded; no counter is required. Production payments are not enabled by this work.

### Checkpoint lineage

Validated Slice 5 checkpoint: `7ff1a9a8eac39151ae76db0dfc3bc50535542348` (`feat(packages): harden credit redemption integrity`).

Slice 5 starts from `0a903172fd7c8e8cea519eecb49658d8d6201011` on `feature/payment-routing`, after Slice 3 `4ec3d98dfb36c51bd795d1d617326fb344a83ad9` and Slice 4 `c407ac80d1c4598457eb7c950f4bf188c1eab01f`. Existing commits are retained. The local `compose.light-balance.yaml` is excluded.

### Authoritative ownership and compatibility

`packages/db/src/schema/packages.ts:packageCredits` now distinguishes `integrityVersion = 1` entitlements with immutable `ownerUserId` from version-0 legacy email-only balances. The authoritative owner is Better Auth's internal `users.id`; a server-resolved authenticated session and a currently verified account authorize customer redemption. Email is contact information, and matching it is not proof of ownership. Changing an owner's email does not move purchased value to a different user.

`credits.ts:requirePackageOwner`, `/api/book:POST`, and `/api/packages/[id]/buy:POST` enforce this boundary server-side. Client JSON cannot set internal owner/actor fields. Explicit redemption with a different attendee email fails generically before querying balances; an unauthenticated caller knowing the victim's email cannot spend their credits. Public cash booking remains possible without an account. Account verification is mandatory for new package purchase/redemption; this is a deliberate product compatibility change.

`grantPackageToCustomer` preserves the trusted staff path for the service owner, resolves exactly one verified recipient account, and binds the authenticated actor. A normalized email with ambiguous verified accounts fails closed. Manual grants need a stable `operationId`; web/mobile clients retain it until acknowledged success. Staff package listing includes `verified_account` versus `legacy_requires_review` and scopes both service and organization.

Migration `0067_package_integrity.sql` records **observed** legacy total/used counts into opening-balance columns. It does not infer a purchase, owner, grant, or historical redemption. Existing balances remain readable, unmodified, and frozen against automatic redemption/restoration. Old paid-without-Intent booking cancellation returns `legacy_unknown` when it has no proven redemption. Legacy package Sessions cannot automatically grant from metadata and request manual reconciliation. Ownership claims/backfills and cancellation correction tooling require a separate deliberate review; no silent reassignment is implemented. Deploy schema and application together: old email/counter-writing code is incompatible with the new guards.

### Ledger and database boundary

`schema/package-integrity.ts:packageCreditMutations` is an append-only financial mutation ledger: immutable entitlement/owner/organization/service, positive quantity, type, stable operation key, input fingerprint, booking/purchase/actor source, original redemption reference, and timestamp. Supported financial operations are grant, one-credit redemption, and exact restoration. There is no general adjustment or accounting subsystem.

The migration's guards enforce:

- identity/scope equality; verified recipient and authorized actor for manual grants; verified durable purchase for paid grants;
- one mutation per operation, one purchased grant, one redemption/restoration per booking, and one restoration per original redemption;
- restoration of the same entitlement, owner, booking and historical quantity;
- nonnegative durable balances, with counters equal to ledger sums at transaction commit;
- package booking/quote/redemption settlement together, cash-versus-credit exclusivity, and cancellation iff its redemption is restored;
- immutable ledger financial fields, ownership/opening balances, purchase terms, Stripe IDs and observed success facts; deletion is restricted.

Financial mutation triggers lock booking before credit, then apply counters. Runtime external-finalization status is deliberately separated from immutable mutation fields. Purchased grants lock their purchase before inserting the credit. The database, not Redis or Node locks, supplies cross-instance correctness.

### Redemption, retry, and restoration

`create-booking.ts:createBooking` validates the internal owner, finds prior operation results before mutable availability/price checks, and serializes retries with a PostgreSQL transaction advisory lock. `creditBookingIdentity` uses the same stable appointment request identity as cash checkout, with server-side owner authorization and input fingerprint checks; old clients fall back to a deterministic hash of canonical original input/return path. Reusing an operation with changed input is a conflict. An intentional second otherwise-identical booking needs a fresh request ID.

`bookingSettlementClaims` is a small shared immutable PostgreSQL claim keyed by that appointment operation. Database insert triggers for durable cash attempts and credit redemptions claim one settlement/source/fingerprint; the unique key makes concurrent cash-versus-credit selection fail closed even when the cash transaction has an older repeatable-read snapshot. Existing durable cash request/source associations are backfilled from explicit attempt facts; no credit provenance is inferred. Deferred binding guards prevent orphan claims. This closes a race where concurrent auto-selection could otherwise create a cash intent and a separate credit-paid booking for one request. Zero-cash creation retains its existing separate behavior; Slice 6 must address its operation identity if unified retry guarantees are required.

Within the booking transaction, current service eligibility/duration is checked under a share lock; recurring package creation is rejected. `quoteAppointmentPrice` retains its single-statement coherent pricing semantics, uses package settlement without a cash promotion, and `persistBookingPricingSnapshot` saves it before settlement. `redeemBookingCredit` locks the oldest eligible owner/service/org entitlement and writes the redemption, snapshot and paid booking atomically. Concurrent attempts for the last credit cannot both commit. Transaction failure rolls all of them back; response loss returns the original booking without another spend or finalizer invocation.

`refunds.ts:decideBookingCancellation` now calls `restoreBookingCredit` inside the same existing cancellation transaction. It restores exactly the proven original redemption and updates package booking settlement; repeated/already-cancelled requests discover the same restoration. Database deferred guards reject cancellation committed without its restoration. Today's package count/price and attendee ordering are irrelevant. Cancelling a credit-funded appointment restores one credit, not Stripe cash from its funding package purchase. Slice 4 cash refund operations retain their own historical route/fee and transaction boundary.

### Durable package purchases

`schema/package-integrity.ts:packagePurchases` is a small package-specific durable checkout intent. It reuses Slice 1 Stripe routing, Slice 2 stable creation/expiry conventions, and Slice 3 verified payment-fact shape, rather than pretending a package purchase is an appointment booking. It has no encrypted booking input because it does not contain an appointment intake; stored contact/ownership data follows the existing package/user storage model.

`purchases.ts:preparePackagePurchase` saves package price, currency, count, scope, verified owner/contact, immutable routing/environment/account/destination/actual fee, redirect URLs and terms hash before Stripe. A single locked package/service join in `packageConfigurationSnapshot` captures coherent terms under repeatable read, with bounded serialization/operation-conflict retries. This avoids READ COMMITTED lock-wait row re-evaluation combining revisions; no Stripe request is inside a retried transaction. Trusted manual grants use the same configuration boundary. Stable owner/request identity rejects changed package input, and retry returns original terms rather than today's package definition.

`packageCheckout` uses `package-checkout:<purchase UUID>:v1`, with immutable Stripe parameters, client reference and purchase/terms/owner metadata on Session and Intent. New Session creation still passes Slice 1's current-sales fail-closed routing boundary. Historical retrieval/verification always uses the saved route and validated matching credential/account context; disabled/changed sales mode cannot change the original paid grant. Once the bounded creation-replay deadline passes without a Session binding, automatic creation stops in `requires_review` rather than risk another independent payment. A webhook/canonical payment read can resolve that specific creation ambiguity. Expired Sessions do not become fresh operations; a genuinely new purchase requires a new request identity.

`validatePackageSession` / `verifyPackagePayment` validate saved amount/currency, Session/Intent metadata and write-once relationship, environment/account, destination/actual fee, complete **paid** Checkout, succeeded Intent with amount received, and expanded captured charge. Completed-but-unpaid/delayed payment grants nothing. Browser redirects are not payment evidence. Contradictions enter review; transient Stripe/database failures remain retryable. Unknown/legacy/malformed durable relationships cannot grant another account's entitlement.

`observePackagePayment` commits immutable success facts first. `grantObservedPackage` then locks the purchase and atomically creates entitlement + source grant + purchase binding. A crash after observation is recoverable without another Stripe call; a crash during grant rolls back to the durable paid obligation; a crash after grant commit or duplicate delivery returns the same grant. Scoped Session/Intent uniqueness and ledger uniqueness prevent repeated grants. A preexisting legacy credit bearing the same Intent causes review instead of another grant.

`receivePackageEvent` runs only after existing raw-body Stripe SDK signature/environment verification. It handles completed/async-success/async-failure/expired Checkout and Intent-success events, locates durable intent by saved IDs/immutable reference, and verifies canonical payment state. It returns retry on transient processing and review on contradiction; package events cannot fall through to legacy appointment Redis fulfillment. A separate event receipt/outbox is unnecessary for this bounded design because the original purchase itself remains a recovery receipt before Stripe creation.

### Recovery and side effects

`recoverPackagePurchases` queries bounded PostgreSQL prepared/open/paid work, with retry/backoff and fair rescheduling of unpaid observations. It is invoked by the existing `scripts/recover-payments.ts` alongside cash-payment/refund recovery. Webhook and authenticated `/packages/thanks` also reconcile; browser presence is not required. Periodic CLI invocation and monitoring review states remain operational deployment tasks, not changed production configuration.

Credit booking external finalization is tracked on its redemption (`pending`, `running`, `complete`, `requires_review`). `markCreditFinalization` shares the booking lock with cancellation. A failure cannot roll back settlement or authorize another spend. `recoverCreditFinalizations` marks interrupted work older than 15 minutes as visible review without blindly replaying calendar/reminder/email/workflow/webhook effects. Cancellation while finalization runs restores value and prevents a stale finalizer from declaring complete or reopening the booking. **`complete` means the outer finalizer returned, not that every individual effect was delivered.** Existing provider helpers can swallow individual failures or skip delivery when unconfigured. Provider cleanup still has the Slice 3/4 delivery gap; financial truth remains durable, but individual provider effects may require reconciliation.

### Rescheduling and recurrence

`reschedule-booking.ts:rescheduleBooking` preserves the same booking row, actual duration, original pricing snapshot and redemption. It neither restores/redeems nor recalculates price. It rechecks cancellation under the row lock and blocks package moves during ambiguous external finalization. The business contract requires no reschedule allowance/counter. Coupon redemptions and accepted prices also stay with this booking lineage, including moves outside the original validity window. Future move reconciliation must preserve these terms. Cash rescheduling remains unchanged financially.

A package cannot authorize multiple recurring occurrences: creation fails closed at both service/application and database boundaries when recurrence exceeds one. Paid recurring financial policy remains separate future work.

### Crash/adversarial walkthrough

| Failure | Durable outcome |
| --- | --- |
| A/B: before/during redemption transaction | No committed spend or booking; retry is safe. |
| C/D: after booking+redemption commit, response lost/retried | Original operation returns the same booking; no additional ledger mutation or side-effect replay. Interrupted delivery is reviewable. |
| E: two instances spend final credit | Entitlement row lock/capacity and transaction rollback permit exactly one committed redemption. |
| F/G/H: duplicate cancellation; crash before/after restoration | Cancellation and exact restoration commit together or neither commits; unique reverse identity converges on one restoration. |
| I: duplicate package webhook | Canonical success and purchase row lock converge on one grant. |
| J: paid, crash before grant | Original purchase/session is discoverable by webhook/recovery; immutable observed success survives independently of grant transaction. |
| K: supplied victim email/forged owner | Session identity and durable owner/scope checks reject without victim balance lookup. |
| L: historical entitlement missing provenance | Opening balance retained; automated spend/restore/grant denied; explicit legacy review. |
| M: current definition changes | Original credited count/owner and redemption/restoration quantity remain historical. New operations use current configuration coherently. |

Package purchase refunds, partially consumed credit revocation, disputes/chargebacks, ownership-claim tooling, arbitrary adjustments and per-effect outbox delivery remain deliberate limitations. Do not refund package cash without coordinating credit revocation in a later policy/operation design.

### Slice 5 validation

Validation completed: full web suite **476/476 across 50 files, none skipped**, including **125 PostgreSQL integration tests across five suites** (41 package-credit, 35 refund, 32 fulfillment, 5 attempt, and 12 pricing tests). The package PostgreSQL suite also passed its separate 41-test rerun. Core tests passed 91/91; focused package/payment/booking coverage passed before the final complete suite. Full web typecheck with a 4 GB Node heap, DB/mobile and the remaining workspace typechecks, scoped Biome over 30 changed TypeScript files, and diff checks passed. The final manual diff review covered ownership, operation identity, database locking/guards, migration metadata, purchase verification/recovery, cancellation/finalization races, and historical rescheduling terms. PostgreSQL used a disposable version-17 container on loopback with tmpfs storage and guarded test database names; test URLs existed only in validation processes. No deployed database, credentials, or Compose override was used.

## Slice 6 implementation: authoritative booking quotes

See [PRICING-ARCHITECTURE.md](PRICING-ARCHITECTURE.md) for the pricing contract and
[BUSINESS-RULES.md](BUSINESS-RULES.md) for finalized promotion/coupon decisions.
Slice 6 preserves existing durable cash fulfillment, refunds, historical routing,
package ownership/redemption, and purchase settlement. No Stripe operation or
production deployment configuration changes.

New unpaid commercial `createBooking` callers must prove zero cash through a
fresh shared quote in the booking transaction and persist it atomically with
booking/attendees. A public free preview cannot authorize a later booking after
service or promotion terms change. Staff explicit
service creation does the same; unsupported positive-cash staff/API creation
fails closed rather than inventing an offline payment workflow. Versioned API
creation accepts an optional stable `checkoutRequestId` and delegates pricing.

Migration `0068_zero_cash_booking.sql` extends `booking_settlement_claims` with
`zero_cash`, bound to its booking ID and immutable zero-cash snapshot. No legacy
free operation is backfilled. A single appointment operation cannot acquire cash,
credit and zero-cash settlements independently. The existing advisory transaction
lock and unique claim serialize retries; booking/snapshot/claim commit together.
A crash before commit leaves none; response loss after commit returns the same
booking before reading new prices or availability. Cancelled/moved bookings remain
that operation's result; a genuinely new booking needs a fresh operation ID.
Deferred guards reject orphan zero claims and later attaching cash settlement or
deleting the claimed booking. Exactly one accepted snapshot binds the claim;
appending another snapshot cannot reinterpret it as an uncollected revision.
Future explicit adjustments need their own design.

Rescheduling changes scheduling facts, never historical quote/settlement or
redemption. There is no grace counter. New free recurring occurrences save their
own zero quotes; paid/commercial expansion fails closed. Existing historical
series are not given fabricated financial allocations.

External calendar/email/reminder delivery for free/staff bookings and recurring
expansion still lacks a universal durable outbox. A committed booking is retained
and returned on retry without blindly replaying those effects.

## Slice 7 implementation: authenticated appointment coupons

Slice 7 adds authenticated coupon selection, checkout reservation, booking
redemption, exactly-once cancellation restoration, immutable quote attribution,
and owner/admin and customer UI. Staff coupon entry still depends on a safe
authenticated-customer commercial booking flow. Ambiguous Stripe attempts hold
reservations for review.


## Resource R2: paid obligations without a booking

Resource-enabled durable checkout captures immutable scheduling terms on the
PaymentAttempt and makes no resource hold. Fulfillment atomically binds its original
booking, claims, settlement and coupon redemption. Verified payment survives a lost
resource race; ordinary recovery stops at `booking_obligation_requires_review`.
Resource invariant diagnostics instead enter technical review and cannot be treated
as routine scheduling contention.

Authorized organization owners/admins inspect `GET /api/payments/review` and resolve
via stable, evidence-bearing `POST` actions: retry the ORIGINAL accepted time or
issue a full historical-route refund. `payment_review_actions` retains encrypted
contact/consent and resolution history. A different time requires refund plus a new
ordinary booking. The new `unbooked_obligation` refund purpose permits NULL booking
only for a verified unresolved paid attempt and authorized refund action. Starting
it prevents booking binding. Existing Stripe refund verification/idempotency/recovery
is reused; success, action completion and coupon reservation release commit together.
Pending/ambiguous money movement retains the reservation and review evidence. The
existing cancellation-purpose refund still requires its cancelled booking.

Kimberly/authorized staff monitor daily, contact the customer and escalate technical
or unresolved paid cases to Ben within one business day. See
[RESOURCE-SCHEDULING.md](RESOURCE-SCHEDULING.md) for the controlled procedure and
legacy Redis drain requirement. No production resource activation occurs in R2.
