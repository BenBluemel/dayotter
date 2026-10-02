# Payment architecture: direct Stripe and retained Connect support

Status: **Slices 1–2 validated (Slice 2: `6dfc4f3`); Slice 3 transactional appointment fulfillment and recovery implemented on `feature/payment-routing`, validated. Slices 4–7 remain proposed.**

Review date: 2026-10-01. Inspection baseline: commit `698897a` on
`feature/promotions`, including the uncommitted appointment-promotion foundation.
This document preserves the code review and Astra High audit. The source map and
risks below describe that inspection baseline; the Slice 1 section records the
subsequent routing changes. The Slice 2 section records durable appointment intent/pricing persistence. The Slice 3 section records durable success observations, transactional booking fulfillment, event recovery and bounded finalization tracking. Durable refunds and per-effect delivery guarantees remain proposed.

The investigation inspected source and public Stripe documentation. It did not
run tests, inspect live Stripe accounts or production data, change Stripe
configuration, or implement payment changes. Source references below are relative
to the repository root; line numbers describe the inspected working tree and may
move. Function names identify the relevant boundaries when lines change.

Read this together with [APPOINTMENT-PROMOTIONS.md](APPOINTMENT-PROMOTIONS.md).
Slice 2 uses that authoritative pricing boundary for new appointment cash checkout
and saves the exact quote to the resulting booking. Deployment configuration has
not been changed or production payments enabled.

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
checkout terms and the minimum booking handoff; Slice 3 adds appointment recovery described below.
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

## Interaction with appointment promotions and deposits

Retain these implemented foundation pieces:

- `packages/core/src/pricing.ts:119`, `calculateAppointmentPrice`: pure
  appointment-time eligibility, best single discount, rounding, deposit cap, and
  distinct cash/credit settlement.
- `apps/web/lib/booking/pricing.ts:22`, `quoteAppointmentPrice`: authoritative
  organization-scoped service/promotion reader. Callers authorize scope and select
  settlement on the server.
- `apps/web/lib/booking/pricing.ts:92`, `persistBookingPricingSnapshot`: detached
  immutable historical quote persistence inside a transaction.
- `packages/db/src/schema/booking-pricing.ts` and
  `packages/db/drizzle/0063_appointment_promotions.sql:90`: history constraints and
  guards against adding snapshots after settlement or mixing cash and credits.
- `booking-logic.ts:13`, `assertExclusiveSettlement`; the corrected credit locking
  in `credits.ts:35`; and the uncommitted Connect reversal correction in
  `payments/fulfill.ts:69`.

The following integration is proposed, not currently wired:

1. Resolve authorized booking intent and server-selected settlement.
2. Obtain a server quote and save it with the durable attempt before Checkout.
3. Bind Stripe metadata to the stored attempt/quote identity. Metadata should be
   correlation data; it should not replace the saved pricing contract.
4. On payment fulfillment, lock the attempt and validate the payment.
5. In one transaction: insert the booking without settlement facts, persist the
   exact saved quote, apply verified settlement, mark fulfilled, and record pending
   finalization work.

The ordering in step 5 matters: snapshots currently require a booking parent, and
the 0063 trigger rejects their insertion after PaymentIntent/positive amount/
destination/paid/refunded facts exist. Current `createBooking` writes payment
facts in its initial INSERT and must be adjusted at this boundary. Recalculating
from mutable prices/promotions during fulfillment would violate the quote.

| Settlement | Intended behavior in both direct and Connect modes |
| --- | --- |
| Full cash | Collect the saved effective service price. |
| Deposit | Discount full service price first, then cap the fixed deposit at effective price. Keep service value separate from amount captured. |
| Zero cash / 100% promotion | Create without Stripe, preserving cash settlement and promotion attribution. Never infer a credit from zero amount or absent PaymentIntent. |
| Package purchase | Save package price/currency/session count/service scope/route before Checkout; grant only after verified payment. Appointment promotions do not implicitly discount package sales. |
| Credit redemption | Verify entitlement; consume and record the exact grant with booking creation in one transaction; save a credit snapshot; collect no cash and apply no cash promotion. |

A remaining deposit balance is explicitly uncollected. Do not introduce automatic
later charges as a side effect of this topology change.

## Proposed refund and cancellation model

| Original settlement | Required compensation |
| --- | --- |
| Direct cash payment | Refund the original account's PaymentIntent without Connect flags. |
| Connect destination payment | Refund the original platform-owned PaymentIntent with transfer reversal; handle the actual application fee according to the retained fee-refund policy. |
| Redeemed package credit | Restore the exact recorded redemption once. Cancelling one appointment does not refund its funding package purchase. |
| Package purchase | Separate purchase-refund operation coordinating money returned with remaining/revoked credits; partially consumed packages require an explicit policy. |

Atomically record cancellation and its required compensation, then call Stripe
after commit using the refund-operation ID as an idempotency key. Record Refund
ID and status, reconcile uncertain results, and retry independently of booking
cancellation state. Refund the captured amount (or an explicit permitted part),
never today's price or full service value when only a deposit was paid.

Track pending/succeeded/failed/partial outcomes and external refunds. A failed
Connect reversal must not trigger a silent retry without reversal. Failed or
cancelled destination refunds can leave returned funds on the platform and need
reconciliation. Disputes involving package-funded credits also need an explicit
review/revocation policy; they are not ordinary booking cancellations.

Replace paid-without-PaymentIntent inference with explicit settlement/redemption
identity. Record a primary payer/client independently of attendee ordering. Add
credit bounds and a unique restoration operation. Prove entitlement using a
verified client session or suitable email/bearer flow before allowing redemption.

## Rescheduling, recurring appointments, and other entry points

### Rescheduling

For unsettled bookings, update time and append a replacement quote in one
transaction. Supersede any prior unpaid Checkout safely so an old URL cannot
silently settle a different appointment/price.

For settled bookings, retain original payment facts and snapshots. Requote for an
explicit adjustment decision, including zero-difference moves. A separate
adjustment history/workflow is required because the current snapshot guard
deliberately forbids new ordinary snapshots after settlement. Until that exists,
block unsupported settled rescheduling. A permitted same-service credit move
retains its original redemption rather than spending again.

### Recurrence

Initially reject paid/credit recurring checkout rather than preserving the
current one-payment-for-many-appointments behavior. Price each occurrence using
its own start and persist independent snapshots.

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

Slices 1–2 passed validation. Slice 3 implementation and adversarial tests are recorded below. Slices 4–7 remain proposed. Each slice should be independently reviewable; a
routing flag alone is not the live-payment readiness milestone.

| Slice | Implementation boundary | Tests / evidence required |
| --- | --- | --- |
| 1. Explicit topology and capabilities (validated) | Configuration, route resolver, typed routing identity and Stripe metadata (no attempt persistence), Connect backend/UI gates. | Direct omits transfers/fees despite stale Connect fields; Connect rejects absent/unready recipients; wrong org/config fails closed; old Connect payments retain original refund route after mode switch. |
| 2. Durable checkout and quotes (appointment implementation; validated) | Saved appointment terms, stable creation identity and expiration, minimal snapshot/booking transaction handoff. Package intent work remains deferred. | Stripe accepts Session before response/DB persistence fails; repeated request; promotion/service/package edits after quote; mismatched amount/currency/account; zero cash bypass; expiration and delayed payment. |
| 3. Transactional fulfillment and event recovery (appointment implementation; bounded finalization) | Shared paid fulfillment, database uniqueness, snapshot-before-settlement ordering, durable event receipt and finalization work. | Concurrent redirect/webhook; different events for one payment; crash before/after commit; DB/queue outage; slot conflict; async success/failure; missing/invalid signatures; out-of-order events; resume interrupted calendar/reminder work without duplicate booking/grant. |
| 4. Refund lifecycle | Durable compensation, original route selection, refund status/reconciliation, truthful return UI. | Cancellation crash before request; refund accepted before local persistence; ambiguous timeout; pending/failed/partial/external refunds; Connect fee/no-fee cases; failed reversal; repeated cancellation. |
| 5. Package entitlement integrity | Verified redemption, exact grant linkage, restoration constraints, purchase fulfillment/refund policy. | Victim email cannot authorize spending; unpaid/null-PI/duplicate purchase events; concurrent last-credit consumption; concurrent restorations; guest ordering; package changes/deletion; partially consumed purchase refund. |
| 6. Remaining pricing entry points | Staff/API policy, unpaid reprice, explicit settled adjustments, occurrence settlement. | Promotion date boundaries/DST; deposit changes; zero-cash versus credit; settled adjustment decisions; paid/credit series rejected until supported; partial series creation; first/later cancellation and allocation. |
| 7. Cutover and compatibility | Additive migration, legacy processing, web/mobile/docs/deployment updates. | Legacy missing snapshots/duplicate audit; old Connect plus new direct records; outstanding old Sessions; account-context change; connected-balance obligations; rollback preserving new financial work; direct routes expose no withdrawal capability. |

Retain and extend existing tests in `packages/core/src/pricing.test.ts`,
`apps/web/lib/booking/pricing.database.test.ts`,
`apps/web/lib/booking/booking-logic.test.ts`, and
`apps/web/lib/payments/fulfill.test.ts`. The current database suite covers pricing
constraints and concurrent credit consumption; it does not establish durability
of checkout/refunds or safety of restoration. Real database concurrency and crash
boundary tests are needed, not only mocked happy paths. Future Stripe validation
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

This section describes implemented and mechanically validated appointment code. It supersedes the Slice 2 interim fulfillment path and the baseline Redis audit for **new durable appointment attempts only**. Packages, legacy Redis Sessions and durable refunds are unchanged. Production payments remain disabled by deployment configuration; this work does not enable them.

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
