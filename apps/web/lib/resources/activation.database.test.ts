import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createDatabase, eq, schema } from "@dayotter/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  fixturePaidSession,
  fixturePaymentIntent,
  fixtureSession,
} from "../payments/attempt-fixtures";
import { bindAttemptSession, prepareAppointmentAttempt } from "../payments/attempts";
import { observePaymentSuccess } from "../payments/payment-work";
const mock = vi.hoisted(() => ({ pi: vi.fn() }));
vi.mock("../server/env", () => ({ env: { APP_URL: "https://example.test" } }));
vi.mock("../payments/connect", () => ({
  checkoutRouteForOrganization: async (organizationId: string) => ({
    mode: "direct",
    organizationId,
    environment: "test",
    chargeAccountId: "acct_test",
    credentialContext: "primary",
  }),
}));
vi.mock("../payments/stripe", () => ({ retrievePaymentIntent: mock.pi }));
const execute = promisify(execFile);
const testUrl = process.env.RESOURCES_TEST_DATABASE_URL;
const container = process.env.RESOURCE_OPERATOR_TEST_CONTAINER;
const script = fileURLToPath(new URL("../../../../deploy/resources/run.sh", import.meta.url));
type Fixture = {
  org: string;
  host: string;
  schedule: string;
  energy: string;
  light: string;
  pemf: string;
  lightResource: string;
  pemfResource: string;
  attended: boolean;
};
type Report = {
  ready: boolean;
  configuration_snapshot: {
    services: {
      role: string;
      service: { resource_admission_epoch: number; requires_host: boolean };
    }[];
  };
  issues: string[];
  services: { role: string; issues: string[]; activation_blocked: boolean }[];
  accepted_bookings: { requires_host: boolean; accepted_policy_invalid: boolean }[];
  unbound_selected_attempts: { scheduling_plan: unknown }[];
  organization_payment_review: { observed_paid: boolean }[];
};
describe.skipIf(!testUrl || !container)(
  "operator resource readiness and activation PostgreSQL",
  () => {
    let admin: ReturnType<typeof createDatabase>;
    let db: ReturnType<typeof createDatabase>;
    let created = false;
    let files: string;
    let user: string;
    const database = `dayotter_resources_test_${randomUUID().replaceAll("-", "")}`;
    const oldKey = process.env.ENCRYPTION_KEY;
    beforeAll(async () => {
      const url = new URL(testUrl!);
      if (
        !["localhost", "127.0.0.1"].includes(url.hostname) ||
        url.pathname !== "/dayotter_resources_test" ||
        !/^dayotter-activation-test-/.test(container!)
      )
        throw new Error(
          "Use only the guarded loopback resource test DB and disposable activation-test container",
        );
      const inspected = JSON.parse((await execute("docker", ["inspect", container!])).stdout)[0];
      const binding = inspected.HostConfig.PortBindings["5432/tcp"];
      if (
        inspected.Config.Labels["dayotter.audit"] !== "resource-activation" ||
        !inspected.HostConfig.Tmpfs["/var/lib/postgresql/data"] ||
        binding.length !== 1 ||
        binding[0].HostIp !== "127.0.0.1" ||
        binding[0].HostPort !== url.port
      )
        throw new Error("Refuse non-ephemeral, non-test or non-loopback PostgreSQL");
      user = url.username;
      if (!inspected.Config.Env.includes(`POSTGRES_USER=${user}`))
        throw new Error("Test identity mismatch");
      process.env.ENCRYPTION_KEY = "ab".repeat(32);
      files = await mkdtemp(join(tmpdir(), "dayotter-resource-operator-test-"));
      admin = createDatabase(url.toString());
      await admin.$client.query(`CREATE DATABASE "${database}"`);
      created = true;
      url.pathname = `/${database}`;
      db = createDatabase(url.toString());
      const directory = new URL("../../../../packages/db/drizzle/", import.meta.url);
      const journal = JSON.parse(
        await readFile(new URL("meta/_journal.json", directory), "utf8"),
      ) as { entries: { tag: string }[] };
      const c = await db.$client.connect();
      try {
        for (const { tag } of journal.entries) {
          await c.query("BEGIN");
          for (const statement of (await readFile(new URL(`${tag}.sql`, directory), "utf8")).split(
            "--> statement-breakpoint",
          ))
            if (statement.trim()) await c.query(statement);
          await c.query("COMMIT");
        }
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    }, 180000);
    afterAll(async () => {
      await db?.$client.end();
      if (created) await admin.$client.query(`DROP DATABASE "${database}"`);
      await admin?.$client.end();
      if (files) await rm(files, { recursive: true });
      // biome-ignore lint/performance/noDelete: process.env absence must be restored
      if (oldKey === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = oldKey;
    });
    async function fixture(attended = false): Promise<Fixture> {
      const f = {
        org: randomUUID(),
        host: randomUUID(),
        schedule: randomUUID(),
        energy: randomUUID(),
        light: randomUUID(),
        pemf: randomUUID(),
        lightResource: randomUUID(),
        pemfResource: randomUUID(),
        attended,
      };
      await db.insert(schema.organizations).values({
        id: f.org,
        slug: randomUUID(),
        name: "Isolated readiness",
        businessTimezone: "America/Boise",
      });
      await db
        .insert(schema.users)
        .values({ id: f.host, email: `${f.host}@example.test`, timezone: "America/Boise" });
      await db
        .insert(schema.memberships)
        .values({ organizationId: f.org, userId: f.host, role: "owner" });
      await db
        .insert(schema.schedules)
        .values({ id: f.schedule, userId: f.host, timezone: "America/Boise", isDefault: true });
      await db.insert(schema.availabilityRules).values(
        Array.from({ length: 7 }, (_, dayOfWeek) => ({
          scheduleId: f.schedule,
          dayOfWeek,
          startTime: "08:00",
          endTime: "18:00",
        })),
      );
      await db.insert(schema.resources).values([
        { id: f.lightResource, organizationId: f.org, name: "LumiCeutical Light", capacity: 1 },
        { id: f.pemfResource, organizationId: f.org, name: "PEMF Mat", capacity: 1 },
      ]);
      await db.insert(schema.eventTypes).values(
        [f.energy, f.light, f.pemf].map((id, i) => ({
          id,
          organizationId: f.org,
          ownerId: f.host,
          scheduleId: f.schedule,
          slug: randomUUID(),
          title: ["Energy Session", "Light Therapy", "PEMF mat"][i]!,
          durationMinutes: 30,
          slotIntervalMinutes: null,
          minimumNoticeMinutes: 0,
          isActive: i === 0,
          location: "in_person" as const,
        })),
      );
      await db.insert(schema.eventTypeResourceRequirements).values([
        { organizationId: f.org, eventTypeId: f.light, resourceId: f.lightResource, quantity: 1 },
        { organizationId: f.org, eventTypeId: f.pemf, resourceId: f.pemfResource, quantity: 1 },
      ]);
      if (!attended)
        await db.$client.query(
          "UPDATE event_types SET requires_host=false WHERE id=ANY($1::uuid[])",
          [[f.light, f.pemf]],
        );
      return f;
    }
    async function run(
      f: Fixture,
      mode: "inspect" | "activate" | "verify",
      report?: Report,
      overrides: Record<string, string> = {},
    ) {
      const env = {
        ...process.env,
        DAYOTTER_ORG_ID: f.org,
        DAYOTTER_ENERGY_SERVICE_ID: f.energy,
        DAYOTTER_LIGHT_SERVICE_ID: f.light,
        DAYOTTER_PEMF_SERVICE_ID: f.pemf,
        DAYOTTER_LIGHT_RESOURCE_ID: f.lightResource,
        DAYOTTER_PEMF_RESOURCE_ID: f.pemfResource,
        DAYOTTER_LIGHT_REQUIRES_HOST: String(f.attended),
        DAYOTTER_PEMF_REQUIRES_HOST: String(f.attended),
        DAYOTTER_WRITERS_QUIESCED: "true",
        DAYOTTER_LEGACY_BOUNDARY_REVIEWED: "true",
        DAYOTTER_PAID_READINESS: "disabled",
        DAYOTTER_RESOURCE_REVIEW: join(files, `${randomUUID()}.json`),
        ...overrides,
      };
      if (report) await writeFile(env.DAYOTTER_RESOURCE_REVIEW, JSON.stringify(report));
      return execute(
        "bash",
        [
          script,
          mode,
          "--",
          "docker",
          "exec",
          "-i",
          container!,
          "psql",
          "-U",
          user,
          "-d",
          database,
        ],
        { env, timeout: 45000, maxBuffer: 4 * 1024 * 1024 },
      );
    }
    const inspect = async (f: Fixture) => JSON.parse((await run(f, "inspect")).stdout) as Report;
    async function rows(f: Fixture) {
      return (
        await db.$client.query(
          "SELECT to_jsonb(e) AS row FROM event_types e WHERE organization_id=$1 ORDER BY id",
          [f.org],
        )
      ).rows;
    }
    async function legacyBooking(f: Fixture, managed = false, cancelled = false) {
      const c = await db.$client.connect();
      const id = randomUUID();
      await c.query("BEGIN");
      try {
        await c.query("UPDATE event_types SET requires_host=true,is_active=true WHERE id=$1", [
          f.light,
        ]);
        const plan = managed
          ? (await c.query("SELECT resource_accept_plan($1,30,$2) AS plan", [f.light, f.host]))
              .rows[0].plan
          : null;
        await c.query(
          "INSERT INTO bookings(id,organization_id,event_type_id,host_id,title,uid,starts_at,ends_at,timezone,status,scheduling_plan,allocation_revision) VALUES($1::uuid,$2,$3,$4,'Historical',$1::text,'2020-01-01T10:00Z','2020-01-01T10:30Z','UTC',$5,$6,$7)",
          [
            id,
            f.org,
            f.light,
            f.host,
            cancelled ? "cancelled" : "confirmed",
            plan,
            plan ? 1 : null,
          ],
        );
        if (plan) await c.query("SELECT resource_allocate_booking($1,'operator_test')", [id]);
        if (!f.attended)
          await c.query("UPDATE event_types SET requires_host=false WHERE id=$1", [f.light]);
        await c.query("COMMIT");
        return id;
      } catch (error) {
        await c.query("ROLLBACK");
        throw error;
      } finally {
        c.release();
      }
    }
    it("readiness is read-only, includes exact equipment/attendance/hours and defaults to the resource-only business model", async () => {
      const f = await fixture();
      const before = await rows(f);
      const equipment = await db.query.resources.findMany({
        where: eq(schema.resources.organizationId, f.org),
      });
      const report = await inspect(f);
      expect(report.ready).toBe(true);
      expect(report.configuration_snapshot.services.map((s) => s.service.requires_host)).toEqual([
        true,
        false,
        false,
      ]);
      expect(await rows(f)).toEqual(before);
      expect(
        await db.query.resources.findMany({ where: eq(schema.resources.organizationId, f.org) }),
      ).toEqual(equipment);
    });
    it("activates only Light and PEMF atomically, proves empty person IDs, and refuses repeat activation or epoch reversal", async () => {
      const f = await fixture();
      const before = (await rows(f)).find((r) => r.row.id === f.energy);
      const report = await inspect(f);
      const activated = JSON.parse(
        (await run(f, "activate", report)).stdout.trim().split("\n").at(-1)!,
      );
      expect(activated.activated).toHaveLength(2);
      for (const service of activated.activated)
        expect(service.accepted_test_plan).toMatchObject({
          requiresHost: false,
          requiredHostIds: [],
          scheduleOwnerId: f.host,
          admissionEpoch: "1",
        });
      expect((await rows(f)).find((r) => r.row.id === f.energy)).toEqual(before);
      expect((await run(f, "verify")).stdout).toContain('"ready": true');
      await expect(run(f, "activate", report)).rejects.toMatchObject({ code: 3 });
      await expect(
        db.$client.query("UPDATE event_types SET resource_admission_epoch=0 WHERE id=$1", [
          f.light,
        ]),
      ).rejects.toThrow();
      expect(
        await db.query.bookings.findMany({ where: eq(schema.bookings.organizationId, f.org) }),
      ).toEqual([]);
    });
    it("retains supported attended-equipment activation when that policy is explicitly reviewed", async () => {
      const f = await fixture(true);
      const report = await inspect(f);
      expect(report.ready).toBe(true);
      const activated = JSON.parse(
        (await run(f, "activate", report)).stdout.trim().split("\n").at(-1)!,
      );
      for (const service of activated.activated)
        expect(service.accepted_test_plan).toMatchObject({
          requiresHost: true,
          requiredHostIds: [f.host],
        });
    });
    it.each([
      "organization",
      "duplicate_service",
      "equipment_mapping",
      "attendance",
      "disabled",
      "duration",
      "foreign_schedule",
      "timezone",
      "extra_equipment",
      "energy_requirement",
    ] as const)(
      "refuses invalid %s configuration without activating either service",
      async (kind) => {
        const f = await fixture();
        let overrides: Record<string, string> = {};
        if (kind === "organization") overrides = { DAYOTTER_ORG_ID: (await fixture()).org };
        if (kind === "duplicate_service") overrides = { DAYOTTER_PEMF_SERVICE_ID: f.light };
        if (kind === "equipment_mapping")
          overrides = { DAYOTTER_LIGHT_RESOURCE_ID: (await fixture()).lightResource };
        if (kind === "attendance") overrides = { DAYOTTER_LIGHT_REQUIRES_HOST: "true" };
        if (kind === "disabled")
          await db.$client.query("UPDATE resources SET enabled=false WHERE id=$1", [
            f.lightResource,
          ]);
        if (kind === "duration")
          await db.$client.query("UPDATE event_types SET duration_minutes=0 WHERE id=$1", [
            f.light,
          ]);
        if (kind === "foreign_schedule")
          await db.$client.query("UPDATE event_types SET schedule_id=$2 WHERE id=$1", [
            f.light,
            (await fixture()).schedule,
          ]);
        if (kind === "timezone")
          await db.$client.query("UPDATE schedules SET timezone='Invalid/Zone' WHERE id=$1", [
            f.schedule,
          ]);
        if (kind === "extra_equipment" || kind === "energy_requirement")
          await db.insert(schema.eventTypeResourceRequirements).values({
            organizationId: f.org,
            eventTypeId: kind === "energy_requirement" ? f.energy : f.light,
            resourceId: f.pemfResource,
            quantity: 1,
          });
        const report = JSON.parse((await run(f, "inspect", undefined, overrides)).stdout) as Report;
        expect(report.ready).toBe(false);
        // Use a previously reviewed ready report to test the authoritative SQL path.
        const copied = { ...report, ready: true };
        const before = await rows(f);
        await expect(run(f, "activate", copied, overrides)).rejects.toMatchObject({ code: 3 });
        expect(await rows(f)).toEqual(before);
      },
    );
    it.each([
      "service",
      "resource",
      "schedule",
      "rules",
      "organization",
      "owner_timezone",
    ] as const)(
      "rejects a stale reviewed %s snapshot even when current configuration is otherwise valid",
      async (kind) => {
        const f = await fixture();
        const report = await inspect(f);
        if (kind === "service")
          await db.$client.query("UPDATE event_types SET title='Edited' WHERE id=$1", [f.light]);
        if (kind === "resource")
          await db.$client.query("UPDATE resources SET name='Edited Light' WHERE id=$1", [
            f.lightResource,
          ]);
        if (kind === "schedule")
          await db.$client.query("UPDATE schedules SET timezone='UTC' WHERE id=$1", [f.schedule]);
        if (kind === "rules")
          await db.$client.query(
            "UPDATE availability_rules SET start_time='09:00' WHERE schedule_id=$1",
            [f.schedule],
          );
        if (kind === "organization")
          await db.$client.query("UPDATE organizations SET business_timezone='UTC' WHERE id=$1", [
            f.org,
          ]);
        if (kind === "owner_timezone")
          await db.$client.query("UPDATE users SET timezone='UTC' WHERE id=$1", [f.host]);
        expect((await inspect(f)).ready).toBe(true);
        const before = await rows(f);
        await expect(run(f, "activate", report)).rejects.toMatchObject({ code: 3 });
        expect(await rows(f)).toEqual(before);
      },
    );
    it("preserves the historical NULL-plan census and does not confuse current false policy with accepted attended history", async () => {
      const f = await fixture();
      await legacyBooking(f);
      const report = await inspect(f);
      expect(report.ready).toBe(false);
      expect(report.services.find((s) => s.role === "light")!.activation_blocked).toBe(true);
      expect(report.accepted_bookings[0]).toMatchObject({
        requires_host: true,
        accepted_policy_invalid: false,
      });
      await expect(run(f, "activate", { ...report, ready: true })).rejects.toMatchObject({
        code: 3,
      });
    });
    it("cancelled legacy history is retained and does not block guarded activation", async () => {
      const f = await fixture();
      const booking = await legacyBooking(f, false, true);
      const before = await db.query.bookings.findFirst({ where: eq(schema.bookings.id, booking) });
      const report = await inspect(f);
      expect(report.ready).toBe(true);
      await run(f, "activate", report);
      expect(await db.query.bookings.findFirst({ where: eq(schema.bookings.id, booking) })).toEqual(
        before,
      );
    });
    it("proven attended bookings/claims remain immutable when their service activates as resource-only", async () => {
      const f = await fixture();
      const booking = await legacyBooking(f, true);
      const before = await db.query.bookings.findFirst({ where: eq(schema.bookings.id, booking) });
      const claims = await db.query.bookingResourceClaims.findMany({
        where: eq(schema.bookingResourceClaims.bookingId, booking),
      });
      const report = await inspect(f);
      expect(report.ready).toBe(true);
      await run(f, "activate", report);
      expect(await db.query.bookings.findFirst({ where: eq(schema.bookings.id, booking) })).toEqual(
        before,
      );
      expect(
        await db.query.bookingResourceClaims.findMany({
          where: eq(schema.bookingResourceClaims.bookingId, booking),
        }),
      ).toEqual(claims);
    });
    it.each(["prepared", "expired_without_session", "paid"] as const)(
      "preserves the unbound %s payment census and operational review",
      async (kind) => {
        const f = await fixture();
        await db.$client.query(
          "UPDATE event_types SET requires_host=true,is_active=true,price=5000,currency='usd' WHERE id=$1",
          [f.light],
        );
        vi.useFakeTimers({ toFake: ["Date"] });
        let attempt: typeof schema.paymentAttempts.$inferSelect;
        try {
          vi.setSystemTime(new Date("2020-01-01T00:00Z"));
          const prepared = await prepareAppointmentAttempt(
            {
              eventTypeId: f.light,
              start: "2030-01-01T10:00:00.000Z",
              attendee: { email: "customer@example.test", name: "Test", timezone: "UTC" },
            },
            "/",
            randomUUID(),
            db,
          );
          attempt = prepared.attempt!;
        } finally {
          vi.useRealTimers();
        }
        if (kind === "expired_without_session")
          await db.$client.query("UPDATE payment_attempts SET state='expired' WHERE id=$1", [
            attempt.id,
          ]);
        if (kind === "paid") {
          const session = {
            ...fixtureSession(attempt),
            id: `cs_${randomUUID().replaceAll("-", "")}`,
          };
          const bound = await bindAttemptSession(attempt, session, db);
          const paid = fixturePaidSession(bound);
          mock.pi.mockResolvedValue(fixturePaymentIntent(bound, paid));
          await observePaymentSuccess(bound, paid, db);
        }
        await db.$client.query("UPDATE event_types SET requires_host=false WHERE id=$1", [f.light]);
        const report = await inspect(f);
        expect(report.ready).toBe(false);
        expect(report.unbound_selected_attempts).toHaveLength(1);
        if (kind === "paid")
          expect(report.organization_payment_review).toContainEqual(
            expect.objectContaining({ observed_paid: true }),
          );
        const before = await db.query.paymentAttempts.findFirst({
          where: eq(schema.paymentAttempts.id, attempt.id),
        });
        await expect(run(f, "activate", { ...report, ready: true })).rejects.toMatchObject({
          code: 3,
        });
        expect(
          await db.query.paymentAttempts.findFirst({
            where: eq(schema.paymentAttempts.id, attempt.id),
          }),
        ).toEqual(before);
      },
    );
    it.each([
      "DAYOTTER_WRITERS_QUIESCED",
      "DAYOTTER_LEGACY_BOUNDARY_REVIEWED",
      "DAYOTTER_PAID_READINESS",
    ])(
      "requires explicit external %s review without treating SQL as Redis/provider evidence",
      async (key) => {
        const f = await fixture();
        const report = await inspect(f);
        const before = await rows(f);
        await expect(run(f, "activate", report, { [key]: "" })).rejects.toMatchObject({ code: 2 });
        expect(await rows(f)).toEqual(before);
      },
    );
    it("refuses a report with blockers instead of treating a successful inspection process as readiness", async () => {
      const f = await fixture();
      const report = await inspect(f);
      const before = await rows(f);
      await expect(run(f, "activate", { ...report, ready: false })).rejects.toThrow();
      expect(await rows(f)).toEqual(before);
    });
    it("refuses an unconstrained attended staging service instead of granting a resource-only exemption", async () => {
      const f = await fixture(true);
      await db.$client.query(
        "DELETE FROM event_type_resource_requirements WHERE event_type_id=$1",
        [f.light],
      );
      const report = await inspect(f);
      expect(report.ready).toBe(false);
      expect(report.services.find((s) => s.role === "light")!.issues).toContain(
        "unexpected_equipment_requirement",
      );
      await expect(run(f, "activate", { ...report, ready: true })).rejects.toMatchObject({
        code: 3,
      });
    });
    it("validates staged quantities against enabled equipment capacity", async () => {
      const f = await fixture();
      // Model a corrupted historic definition only in this disposable fixture.
      const c = await db.$client.connect();
      try {
        await c.query("BEGIN");
        await c.query("ALTER TABLE event_type_resource_requirements DISABLE TRIGGER USER");
        await c.query(
          "UPDATE event_type_resource_requirements SET quantity=2 WHERE event_type_id=$1",
          [f.light],
        );
        await c.query("ALTER TABLE event_type_resource_requirements ENABLE TRIGGER USER");
        await c.query("COMMIT");
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
      const report = await inspect(f);
      expect(report.ready).toBe(false);
      expect(report.issues).toContain("resource_scope_enabled_or_capacity_invalid");
      await expect(run(f, "activate", { ...report, ready: true })).rejects.toMatchObject({
        code: 3,
      });
    });
    it("fails closed on corrupt resource opening hours before issuing a ready report", async () => {
      const f = await fixture();
      const c = await db.$client.connect();
      try {
        await c.query("BEGIN");
        await c.query("ALTER TABLE resources DISABLE TRIGGER USER");
        await c.query("UPDATE resources SET opening_hours='{}'::jsonb WHERE id=$1", [
          f.lightResource,
        ]);
        await c.query("ALTER TABLE resources ENABLE TRIGGER USER");
        await c.query("COMMIT");
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
      await expect(inspect(f)).rejects.toMatchObject({ code: 3 });
    });
    it("fails closed on inconsistent historical accepted attendance while leaving that history untouched", async () => {
      const f = await fixture();
      const booking = await legacyBooking(f, true);
      const c = await db.$client.connect();
      try {
        await c.query("BEGIN");
        await c.query("ALTER TABLE bookings DISABLE TRIGGER USER");
        await c.query("UPDATE bookings SET requires_host=false WHERE id=$1", [booking]);
        await c.query("ALTER TABLE bookings ENABLE TRIGGER USER");
        await c.query("COMMIT");
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
      const report = await inspect(f);
      expect(report.ready).toBe(false);
      expect(report.issues).toContain("invalid_frozen_booking_attendance");
      const before = await db.query.bookings.findFirst({ where: eq(schema.bookings.id, booking) });
      await expect(run(f, "activate", { ...report, ready: true })).rejects.toMatchObject({
        code: 3,
      });
      expect(await db.query.bookings.findFirst({ where: eq(schema.bookings.id, booking) })).toEqual(
        before,
      );
    });
    it("rechecks new legacy commitments after a previously ready inspection", async () => {
      const f = await fixture(true);
      const report = await inspect(f);
      await db.$client.query(
        "INSERT INTO bookings(organization_id,event_type_id,host_id,title,uid,starts_at,ends_at,timezone) VALUES($1,$2,$3,'Late legacy',$4,'2030-01-01T10:00Z','2030-01-01T10:30Z','UTC')",
        [f.org, f.light, f.host, randomUUID()],
      );
      // Insertion does not bump a service configuration revision.
      const before = await rows(f);
      await expect(run(f, "activate", report)).rejects.toMatchObject({ code: 3 });
      expect(await rows(f)).toEqual(before);
    });
    it.each(["service", "resource"] as const)(
      "waits for a concurrent %s edit and then rejects its stale reviewed configuration",
      async (kind) => {
        const f = await fixture();
        const report = await inspect(f);
        const c = await db.$client.connect();
        await c.query("BEGIN");
        let outcome: Promise<{ ok: boolean; error?: unknown }> | undefined;
        try {
          if (kind === "service")
            await c.query("UPDATE event_types SET title='Concurrent edit' WHERE id=$1", [f.light]);
          else
            await c.query("UPDATE resources SET name='Concurrent equipment edit' WHERE id=$1", [
              f.lightResource,
            ]);
          outcome = run(f, "activate", report).then(
            () => ({ ok: true }),
            (error: unknown) => ({ ok: false, error }),
          );
          const deadline = Date.now() + 3500;
          let waiting = false;
          while (Date.now() < deadline) {
            const result = await db.$client.query(
              "SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND application_name='psql' AND wait_event_type='Lock'",
              [database],
            );
            if (result.rowCount) {
              waiting = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          expect(waiting).toBe(true);
          await c.query("COMMIT");
          expect(await outcome).toMatchObject({ ok: false, error: { code: 3 } });
        } finally {
          await c.query("ROLLBACK");
          c.release();
          if (outcome) await outcome;
        }
        expect(
          (await rows(f))
            .filter((r) => r.row.id !== f.energy)
            .map((r) => r.row.resource_admission_epoch),
        ).toEqual([0, 0]);
      },
    );
    it("rolls back both service changes if a later activation proof fails", async () => {
      const f = await fixture();
      const report = await inspect(f);
      const before = await rows(f);
      const name = `activation_test_${randomUUID().replaceAll("-", "")}`;
      await db.$client.query(
        `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.pemf}'::uuid AND NEW.resource_admission_epoch=1 THEN RAISE EXCEPTION 'test-only second service failure'; END IF; RETURN NEW; END $$`,
      );
      await db.$client.query(
        `CREATE TRIGGER ${name} AFTER UPDATE ON event_types FOR EACH ROW EXECUTE FUNCTION ${name}()`,
      );
      try {
        await expect(run(f, "activate", report)).rejects.toMatchObject({ code: 3 });
        expect(await rows(f)).toEqual(before);
      } finally {
        await db.$client.query(`DROP TRIGGER ${name} ON event_types`);
        await db.$client.query(`DROP FUNCTION ${name}()`);
      }
    });
    it("verification returns the actual state and fails until both resource services have activated", async () => {
      const f = await fixture();
      await expect(run(f, "verify")).rejects.toMatchObject({
        code: 3,
        stdout: expect.stringContaining('"ready": false'),
      });
      const report = await inspect(f);
      await run(f, "activate", report);
      expect(JSON.parse((await run(f, "verify")).stdout).ready).toBe(true);
    });
    it("verification rejects an equipment service disabled after activation", async () => {
      const f = await fixture();
      await run(f, "activate", await inspect(f));
      await db.$client.query("UPDATE event_types SET is_active=false WHERE id=$1", [f.light]);
      await expect(run(f, "verify")).rejects.toMatchObject({
        code: 3,
        stdout: expect.stringContaining("activated_service_disabled"),
      });
      expect((await rows(f)).find((r) => r.row.id === f.light)!.row.resource_admission_epoch).toBe(
        1,
      );
    });
    it.each(["missing", "ambiguous"] as const)(
      "preserves the strict %s default-schedule activation gate",
      async (kind) => {
        const f = await fixture();
        await db.$client.query("UPDATE event_types SET schedule_id=NULL WHERE id=$1", [f.light]);
        if (kind === "missing")
          await db.$client.query("UPDATE schedules SET is_default=false WHERE id=$1", [f.schedule]);
        else
          await db
            .insert(schema.schedules)
            .values({ userId: f.host, timezone: "UTC", isDefault: true });
        const report = await inspect(f);
        expect(report.ready).toBe(false);
        expect(report.services.find((s) => s.role === "light")!.issues).toContain(
          "invalid_owned_schedule",
        );
        await expect(run(f, "activate", { ...report, ready: true })).rejects.toMatchObject({
          code: 3,
        });
      },
    );
    it("rejects malformed identifiers before opening the operator database command", async () => {
      const f = await fixture();
      const before = await rows(f);
      await expect(
        run(f, "inspect", undefined, {
          DAYOTTER_LIGHT_SERVICE_ID: "'; UPDATE event_types SET resource_admission_epoch=1; --",
        }),
      ).rejects.toMatchObject({ code: 2 });
      expect(await rows(f)).toEqual(before);
    });
  },
);
