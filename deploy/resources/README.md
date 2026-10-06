# Resource scheduling: DEV readiness and activation

This is the reviewed operator procedure for the resource-only model introduced
in `9e220e3`. It supersedes the activation and readiness SQL in
`/tmp/dayotter-launch-readiness-2026-10-05`; those files remain historical evidence
and must not be used for this cutover. No application, schema, runtime, or data
migration is performed by installing these source files.

The Light & Balance manifest is:

| Role | Attendance | Equipment | Admission epoch after this procedure |
| --- | --- | --- | --- |
| Energy Session | Required | None | **0, unchanged** |
| Light Therapy | Not required | LumiCeutical Light ×1 | **1** |
| PEMF mat | Not required | PEMF Mat ×1 | **1** |

Energy does not need resource activation. This tool neither enables nor changes
it. Its responsible owner, attendance, equipment-free definition, and epoch zero
are checked. Verify that Energy is enabled before the eventual concurrency test;
normal service enablement is a separate administrator action if needed.

`run.sh` requires Bash 4+, Python 3, and an explicitly supplied `psql` command.
It does not discover a database, use a default DATABASE_URL, load credentials,
inspect Redis, contact payment providers, install tools in containers, migrate,
restart applications, or run payment recovery. The command supplied below uses
the existing PostgreSQL client's stdin. Only `activate` mutates the database.

## 1. Verify the existing DEV boundary and code

Commands here are for the later operator session. No command against DEV is run
as part of implementing or validating this procedure.

Before proceeding, confirm the exact Compose project, HTTPS origin
`https://dev-dayotter.light-and-balance.com`, isolated PostgreSQL/Redis storage,
controlled attendee/email/calendar targets, and test-only payment identities.
The Compose project name alone is not isolation evidence. Confirm migration 0075
and web/worker image provenance at `9e220e3` or a reviewed descendant. Health's
default `version=dev` is not code provenance. If code/schema are not established,
stop here and use the separate coordinated deployment/migration procedure; this
runbook does not deploy or apply migrations.

From the repository, fill the verified project name; no default is provided:

```bash
cd /tank/docker/light-and-balance/scheduler/dayotter
set -euo pipefail
umask 077
export DAYOTTER_DEV_PROJECT='REPLACE_WITH_VERIFIED_DEV_COMPOSE_PROJECT'
DC=(docker compose --project-name "${DAYOTTER_DEV_PROJECT:?}" --env-file .env.dev \
  -f docker-compose.yml -f compose.light-balance-dev.yaml --profile app)
"${DC[@]}" config --quiet
"${DC[@]}" ps
"${DC[@]}" images
for service in postgres redis; do
  docker inspect "$("${DC[@]}" ps -q "$service")" --format '{{json .Mounts}}'
done
"${DC[@]}" exec -T postgres psql -X -U dayotter -d dayotter \
  -c 'SELECT current_database(),current_user,version(); SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 5;'
sha256sum packages/db/drizzle/0075_resource_only_services.sql
```

Expected persistent paths from the preserved DEV overlay are
`/tank/docker/light-and-balance-dev/scheduler/data/postgres` and
`/tank/docker/light-and-balance-dev/scheduler/data/redis`. Verify the actual mounts,
not just this source configuration. Match the migration ledger's 0075 hash and
timestamp to the committed SQL and `packages/db/drizzle/meta/_journal.json`.
Never use the ordinary `dayotter` project, non-DEV overlay, a host default database,
Client Notes storage, or a live Redis/provider namespace for this DEV procedure.

## 2. Bind exact IDs and inspect read-only

Use the existing UI/API IDs or this read-only inventory. Labels help discovery;
they never select activation targets:

```bash
"${DC[@]}" exec -T postgres psql -X -U dayotter -d dayotter -c "
SELECT o.id AS organization_id,o.slug,e.id AS service_id,e.title,e.owner_id,
 e.is_active,e.requires_host,e.resource_admission_epoch,e.resource_configuration_revision,
 q.resource_id,r.name AS resource_name,q.quantity,r.capacity,r.enabled
FROM event_types e JOIN organizations o ON o.id=e.organization_id
LEFT JOIN event_type_resource_requirements q ON q.event_type_id=e.id
LEFT JOIN resources r ON r.id=q.resource_id AND r.organization_id=q.organization_id
WHERE lower(btrim(e.title)) IN ('energy session','light therapy','pemf mat')
ORDER BY o.id,e.id,q.resource_id;"

export DAYOTTER_ORG_ID='REPLACE_WITH_EXACT_ORGANIZATION_UUID'
export DAYOTTER_ENERGY_SERVICE_ID='REPLACE_WITH_EXACT_ENERGY_UUID'
export DAYOTTER_LIGHT_SERVICE_ID='REPLACE_WITH_EXACT_LIGHT_UUID'
export DAYOTTER_PEMF_SERVICE_ID='REPLACE_WITH_EXACT_PEMF_UUID'
export DAYOTTER_LIGHT_RESOURCE_ID='REPLACE_WITH_EXACT_LUMICEUTICAL_UUID'
export DAYOTTER_PEMF_RESOURCE_ID='REPLACE_WITH_EXACT_MAT_UUID'
export DAYOTTER_LIGHT_REQUIRES_HOST=false DAYOTTER_PEMF_REQUIRES_HOST=false
DAYOTTER_REVIEW_DIR=$(mktemp -d /tmp/dayotter-dev-resource-review.XXXXXX)
export DAYOTTER_RESOURCE_REVIEW="$DAYOTTER_REVIEW_DIR/readiness.json"

bash deploy/resources/run.sh inspect -- \
  "${DC[@]}" exec -T postgres psql -U dayotter -d dayotter \
  > "$DAYOTTER_RESOURCE_REVIEW"
python3 -m json.tool "$DAYOTTER_RESOURCE_REVIEW"
```

The inspection transaction is `REPEATABLE READ READ ONLY` and rolls back. It
returns one JSON object without updating services, resources, versions, bookings,
claims, or financial records. Successful process exit alone is not readiness:
review **`ready=true`**, the exact organization/service/resource IDs, shared real
owner, attendance `[true,false,false]`, both equipment quantities 1, and intended
initial capacities **1**. Selected resource services must be individual, one
attendee, nonrecurring, non-Personal, and have exactly their intended requirement.
Equipment must be enabled, scoped to the organization, with sufficient capacity
and valid opening hours. NULL resource hours mean unrestricted, not office hours;
review service/resource hours explicitly. Owned schedule fallback is allowed only
with exactly one default schedule. Duration, cadence, buffers and timezones are
validated. No host becomes nullable and no helper is created.

The report includes full definition revisions, resource allocation versions,
service schedules/rules/overrides, and owner/organization timezones in
`configuration_snapshot`. The access-code hash is omitted. Treat reports as
private operator artifacts; they include internal booking/payment identifiers.
Keep the report for audit. A blocked report cannot be used for activation.

`ready=true` certifies database definitions and the selected service census at
inspection time. It does **not** certify deployed code, externally quiesced
writers, email delivery, Redis/provider/payment review, or available future slots.
The tool also supports attended equipment services when their expected host flag
is explicitly set to `true`; the Light & Balance flags above must remain `false`.

## 3. Complete the existing external and historical gates

Review `services[].activation_blocked`, `accepted_bookings`,
`unbound_selected_attempts`, organization-wide payment/refund review, and
`organization_legacy_bookings`. The existing database
`resource_incompatible_commitments` function is reused unchanged, including
completed historical NULL-plan bookings and unbound NULL/empty-plan attempts.
Local expiry or an empty Redis namespace does not prove provider payment finality.
Accepted attendance is compared with the booking's frozen terms, not today's
service policy. Proven attended history may coexist with a newly resource-only
service; it is never rewritten. Cancelled/rejected history is retained.

Do not repair blockers by editing plans/attendance/claims, fabricating bookings,
resetting epochs, deleting custody, or declaring historical obligations irrelevant.
Do not cancel legitimate historical appointments just to clear the census. Prefer
fresh, reviewed service IDs when retained history prevents activation, and keep
the old obligations under their established lifecycle. Fresh IDs do not discharge
old obligations. Review equivalent legacy appointments across the organization for physical equipment commitments; the tool cannot infer
which old service names used equipment. Ordinary Energy appointments remain valid
person-only commitments and do not automatically block resource activation.

Separately review legacy Redis checkout records and original provider Sessions,
including missing/expired payloads and delayed payment events. A genuinely fresh,
isolated DEV namespace with no such obligations can record that fact. Reused
stores require the prior archived launch-audit legacy review procedure and the
financial boundaries in [RESOURCE-SCHEDULING.md](../../docs/RESOURCE-SCHEDULING.md).
This tool neither drains Redis nor adopts/fulfills/refunds payments.

For initial free, fully discounted, or supported package tests, independently
verify `STRIPE_PAYMENT_MODE=disabled` in the approved DEV runtime, then use
`DAYOTTER_PAID_READINESS=disabled`. For any possible positive-cash/deposit testing,
verify explicit test routing, original credential context, signed webhook delivery,
assigned paid-unbooked/customer-contact ownership, a working bounded recovery
invocation, and the tested contention/retry/full-refund/idempotency drill. Only
then use `DAYOTTER_PAID_READINESS=test_workflow_reviewed`. This is an operator
attestation, not proof inferred from SQL or permission to alter runtime settings.
Technical/broader financial review remains necessary even when the selected census
is clear. Never substitute live money/provider credentials for a DEV drill.

## 4. Later authorized activation: quiesce, re-inspect, review, commit

Establish the existing maintenance/backup boundary before the one-way operation.
Quiesce **all** admission/finalization/configuration writers, including staff/API,
workers, old checkouts/recurring writers, and other direct SQL operators. Keep
organization/owner timezones and service/resource schedules/configuration quiet
through activation. Read-only clients can continue. A separately approved way to
quiesce this identified stack is:

```bash
"${DC[@]}" stop web worker
"${DC[@]}" exec -T postgres pg_dump -U dayotter -d dayotter -Fc \
  > "$DAYOTTER_REVIEW_DIR/before-resource-activation.dump"

# Repeat inspection after quiescing, then review this new report explicitly.
bash deploy/resources/run.sh inspect -- \
  "${DC[@]}" exec -T postgres psql -U dayotter -d dayotter \
  > "$DAYOTTER_RESOURCE_REVIEW"
python3 -m json.tool "$DAYOTTER_RESOURCE_REVIEW"
```

Resolve/review blockers through supported workflows before continuing. If that
requires writes, repeat inspection and review again afterward. Once the maintenance
boundary, the fresh snapshot, and external gates are actually reviewed:

```bash
export DAYOTTER_WRITERS_QUIESCED=true
export DAYOTTER_LEGACY_BOUNDARY_REVIEWED=true
export DAYOTTER_PAID_READINESS=disabled  # only after verifying runtime cash disabled

bash deploy/resources/run.sh activate -- \
  "${DC[@]}" exec -T postgres psql -U dayotter -d dayotter \
  > "$DAYOTTER_REVIEW_DIR/activation.txt"

bash deploy/resources/run.sh verify -- \
  "${DC[@]}" exec -T postgres psql -U dayotter -d dayotter \
  > "$DAYOTTER_REVIEW_DIR/verification.json"
python3 -m json.tool "$DAYOTTER_REVIEW_DIR/verification.json"
```

Do not set acknowledgements in advance or simply copy them to bypass incomplete
review. `activate` locks the three service rows in UUID order, holds the complete
scoped resource union and resolved schedule definitions, and recomputes readiness
at **READ COMMITTED** after waiting. It compares the current full configuration
snapshot to the reviewed JSON. Service revision, resource version/state, schedule,
rule, timezone, policy, and requirement edits invalidate a stale review. The
unchanged database guard performs the authoritative locked commitment census.
Only Light and PEMF atomically become active at epoch 1. Accepted plan proofs run
before COMMIT and retain the real owner with `requiredHostIds=[]`. Existing
booking/attempt terms, claims and finances are not edited.

`ON_ERROR_STOP`, a 5-second lock timeout and 30-second statement timeout fail closed.
Any SQL error disconnects without COMMIT and rolls back both changes. Do not treat
printed plan rows as success without zero process exit **and** read-only verification.
On lock/deadlock/stale-review failure, diagnose, re-inspect and re-review; the tool
never retries an irreversible operation automatically. On a lost response, run
`verify` first: both epoch-1 rows mean it committed; both epoch-0 rows mean it did
not. `verify` emits the actual report and exits nonzero if the intended state is
not established; read that report before deciding the next action. A mixed state
requires operator investigation, not a reset or second blind activation. Repeated
activation and epoch 1→0 are rejected.

Before reopening writers under the separately approved maintenance procedure,
verify `[energy=0,light=1,pemf=1]`, resource policies/quantities, unchanged Energy,
both active equipment services, and correct accepted-test plans. Reopen only the
already reviewed, unchanged DEV images; this runbook performs no deployment.
Then run the controlled Energy + Light + PEMF simultaneous-booking test, equipment
duplicate/race tests, normal reschedule/cancel checks, and optional approved paid
drill. Provider calendar visibility should remain free for resource-only services.
Cancel test bookings through the normal lifecycle to retain financial/claim history.

Rollback is disabling new admissions or a separately reviewed whole-environment
restore; there is no reverse epoch transition, claim erasure, or old-code downgrade.

## Local automated validation

The database tests run the actual Bash/psql scripts using only an explicitly
identified disposable PostgreSQL 17 container. They require
`RESOURCES_TEST_DATABASE_URL` with loopback host and database
`dayotter_resources_test`, plus `RESOURCE_OPERATOR_TEST_CONTAINER` whose name starts
`dayotter-activation-test-`, label `dayotter.audit=resource-activation`, tmpfs data,
test user, and matching loopback-only port. The tests create/drop their own database,
mock provider transports, and never use DATABASE_URL or inspect DEV containers.
Without both test variables this operator suite is skipped; supply both for release
validation. Do not point either variable at a persistent or running DayOtter stack.

Validation on 2026-10-06: all 42 operator tests passed; the complete root/core test
run passed 964 tests across 70 files with no skips, including resource Slices 1–6,
launch-readiness fixes, person/calendar/configuration, lifecycle and financial DB
regressions. All 16 workspace typecheck tasks passed. Changed-file Biome, Bash
syntax, production build, and whitespace checks passed. Schema generation reported
no changes; the full migration journal through 0075 applied successfully to fresh
disposable PostgreSQL 17. Tests used a loopback-only, tmpfs-backed test container,
mocked provider transports, and no Redis service. The test container was removed.
No DEV database, runtime, service, activation, or deployment was accessed or changed.

Self-review checked the actual tooling/docs/test diff against the archived guards.
It corrected scoped equipment locking, explicitly validated resource opening hours
and frozen plan identities, and made verification fail with the actual report when
the expected epoch state is absent or an activated equipment service is disabled.
Stale service/resource edits were tested while locks were held. Individual schedule-rule and owner/organization timezone writes
remain part of the explicitly required quiesced configuration boundary; SQL does
not certify that external boundary. No application/schema guards were changed.
