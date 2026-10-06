import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PUT } from "@/app/api/resource-requirements/route";
import { GET, PATCH, POST } from "@/app/api/resources/route";
import { type Database, createDatabase } from "@dayotter/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ userId: null as string | null, db: null as Database | null }));
vi.mock("@/lib/auth/session", () => ({
  getSession: async () =>
    state.userId
      ? { user: { id: state.userId, email: "admin@example.test", name: "Admin" } }
      : null,
}));
vi.mock("@dayotter/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dayotter/db")>()),
  getDb: () => state.db!,
}));
const testUrl = process.env.RESOURCES_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("resource configuration authenticated PostgreSQL API", () => {
  let db: ReturnType<typeof createDatabase>;
  let admin: ReturnType<typeof createDatabase>;
  let created = false;
  const databaseName = `dayotter_resources_test_${randomUUID().replaceAll("-", "")}`;
  const org = randomUUID();
  const otherOrg = randomUUID();
  const host = randomUUID();
  const customer = randomUUID();
  const outsider = randomUUID();
  const schedule = randomUUID();
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.pathname !== "/dayotter_resources_test"
    )
      throw new Error("Use an isolated loopback resource test database");
    admin = createDatabase(url.toString());
    await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    url.pathname = `/${databaseName}`;
    db = createDatabase(url.toString());
    state.db = db;
    const directory = new URL("../../../../packages/db/drizzle/", import.meta.url);
    const journal = JSON.parse(
      await readFile(new URL("meta/_journal.json", directory), "utf8"),
    ) as { entries: { tag: string }[] };
    const client = await db.$client.connect();
    try {
      for (const { tag } of journal.entries) {
        await client.query("BEGIN");
        for (const statement of (await readFile(new URL(`${tag}.sql`, directory), "utf8")).split(
          "--> statement-breakpoint",
        ))
          if (statement.trim()) await client.query(statement);
        await client.query("COMMIT");
      }
      await client.query(
        "insert into organizations(id,name,slug) values($1::uuid,'Configuration test',$1::text),($2::uuid,'Other organization',$2::text)",
        [org, otherOrg],
      );
      for (const id of [host, customer, outsider])
        await client.query(
          "insert into users(id,email,name) values($1::uuid,$1::text || '@example.test','Test user')",
          [id],
        );
      await client.query(
        "insert into memberships(organization_id,user_id,role) values($1,$2,'owner'),($1,$3,'member'),($4,$5,'admin')",
        [org, host, customer, otherOrg, outsider],
      );
      await client.query(
        "insert into schedules(id,user_id,name,timezone,is_default) values($1,$2,'Test hours','UTC',true)",
        [schedule, host],
      );
    } finally {
      client.release();
    }
  }, 180000);
  afterAll(async () => {
    await db?.$client.end();
    if (created) await admin.$client.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await admin?.$client.end();
  });
  beforeEach(() => {
    state.userId = host;
  });
  const request = (method: string, body?: unknown) =>
    new Request(`https://example.test/api/resources?organizationId=${org}`, {
      method,
      ...(body !== undefined
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    });
  async function create(capacity = 3, organizationId = org) {
    const response = await POST(
      request("POST", {
        organizationId,
        name: `Equipment ${randomUUID()}`,
        capacity,
        enabled: true,
      }),
      undefined,
    );
    expect(response.status).toBe(201);
    return (await response.json()).resource;
  }
  async function service() {
    const id = randomUUID();
    await db.$client.query(
      "insert into event_types(id,organization_id,owner_id,schedule_id,slug,title,description,price) values($1::uuid,$2,$3,$4,$1::text,'Consultation','Keep this description',2500)",
      [id, org, host, schedule],
    );
    return id;
  }
  async function readService(id: string) {
    return (await db.$client.query("select * from event_types where id=$1", [id])).rows[0];
  }
  async function requirements(
    eventTypeId: string,
    rows: { id: string; quantity: number }[],
    version?: number,
  ) {
    return PUT(
      request("PUT", {
        organizationId: org,
        eventTypeId,
        version:
          version ?? Number((await readService(eventTypeId)).resource_configuration_revision),
        requirements: rows,
      }),
      undefined,
    );
  }
  const patch = (r: { id: string; version: number }, values: unknown) =>
    PATCH(
      request("PATCH", {
        organizationId: org,
        id: r.id,
        version: r.version,
        ...(values as object),
      }),
      undefined,
    );
  const hours = {
    timezone: "America/Boise",
    rules: [{ dayOfWeek: 1, startTime: "09:00", endTime: "17:00" }],
    overrides: [{ date: "2030-01-01", startTime: null, endTime: null }],
  };
  async function occupied(capacity = 3, quantity = 2) {
    const r = await create(capacity);
    const event = await service();
    expect((await requirements(event, [{ id: r.id, quantity }])).status).toBe(200);
    await db.$client.query("update event_types set resource_admission_epoch=1 where id=$1", [
      event,
    ]);
    const client = await db.$client.connect();
    const booking = randomUUID();
    try {
      await client.query("BEGIN");
      const plan = (
        await client.query("select resource_accept_plan($1,60,$2) as plan", [event, host])
      ).rows[0].plan;
      await client.query(
        "insert into bookings(id,organization_id,event_type_id,host_id,title,uid,starts_at,ends_at,timezone,allow_overlap,scheduling_plan,allocation_revision) values($1::uuid,$2,$3,$4,'Accepted booking',$1::text,'2030-01-01T10:00:00Z','2030-01-01T11:00:00Z','UTC',true,$5,1)",
        [booking, org, event, host, plan],
      );
      await client.query("select resource_allocate_booking($1,'configuration-test')", [booking]);
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    const current = (await (await GET(request("GET"), undefined)).json()).resources.find(
      (x: { id: string }) => x.id === r.id,
    );
    return { r: current, event, booking };
  }
  it("lists only organization resources and omits claims/history", async () => {
    const r = await create();
    state.userId = outsider;
    await create(1, otherOrg);
    state.userId = host;
    const data = await (await GET(request("GET"), undefined)).json();
    expect(data.resources.some((x: { id: string }) => x.id === r.id)).toBe(true);
    expect(data.resources.every((x: { organizationId: string }) => x.organizationId === org)).toBe(
      true,
    );
    expect(data).not.toHaveProperty("claims");
  });
  it("creates, renames and increases capacity without changing other fields", async () => {
    const r = await create();
    const result = await patch(r, { name: "Renamed equipment", capacity: 4 });
    expect(result.status).toBe(200);
    expect((await result.json()).resource).toMatchObject({
      name: "Renamed equipment",
      capacity: 4,
      enabled: true,
      openingHours: null,
    });
  });
  it.each([0, -1, 1.5, 2147483648])("rejects invalid capacity %s", async (capacity) => {
    expect(
      (
        await POST(
          request("POST", { organizationId: org, name: "Equipment", capacity, enabled: true }),
          undefined,
        )
      ).status,
    ).toBe(400);
  });
  it("rejects stale edits without overwriting newer configuration", async () => {
    const r = await create();
    expect((await patch(r, { name: "Newer name" })).status).toBe(200);
    expect((await patch(r, { name: "Stale name" })).status).toBe(409);
  });
  it("safely reduces capacity to accepted demand", async () => {
    const { r } = await occupied();
    const response = await patch(r, { capacity: 2 });
    expect(response.status).toBe(200);
    expect((await response.json()).resource.capacity).toBe(2);
  });
  it("unsafe reduction preserves capacity and gives an actionable error", async () => {
    const { r } = await occupied();
    const response = await patch(r, { capacity: 1 });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("existing bookings");
    expect(
      (await db.$client.query("select capacity from resources where id=$1", [r.id])).rows[0]
        .capacity,
    ).toBe(3);
  });
  it("accepted demand blocks reductions even after current requirements are removed", async () => {
    const { r, event } = await occupied();
    expect((await requirements(event, [])).status).toBe(200);
    const latest = (await (await GET(request("GET"), undefined)).json()).resources.find(
      (x: { id: string }) => x.id === r.id,
    );
    expect((await patch(latest, { capacity: 1 })).status).toBe(409);
  });
  it("disable preserves accepted claims and re-enable remains guarded", async () => {
    const { r, booking } = await occupied();
    const response = await patch(r, { enabled: false });
    expect(response.status).toBe(200);
    const disabled = (await response.json()).resource;
    const claims = await db.$client.query(
      "select released_at from booking_resource_claims where booking_id=$1",
      [booking],
    );
    expect(claims.rows).toHaveLength(1);
    expect(claims.rows[0].released_at).toBe(null);
    const reduced = await patch(disabled, { capacity: 2 });
    expect(reduced.status).toBe(200);
    expect((await patch((await reduced.json()).resource, { enabled: true })).status).toBe(200);
  });
  it.each(["read", "create", "edit", "hours", "requirements"])(
    "customer cannot %s configuration",
    async (operation) => {
      const r = await create();
      const event = await service();
      state.userId = customer;
      const response =
        operation === "read"
          ? await GET(request("GET"), undefined)
          : operation === "create"
            ? await POST(
                request("POST", {
                  organizationId: org,
                  name: "Denied",
                  capacity: 1,
                  enabled: true,
                }),
                undefined,
              )
            : operation === "requirements"
              ? await requirements(event, [{ id: r.id, quantity: 1 }])
              : await patch(
                  r,
                  operation === "hours" ? { openingHours: hours } : { enabled: false },
                );
      expect(response.status).toBe(403);
    },
  );
  it("requires login", async () => {
    state.userId = null;
    expect((await GET(request("GET"), undefined)).status).toBe(401);
    expect((await POST(request("POST", {}), undefined)).status).toBe(401);
  });
  it("rejects cross-org resource edits and service requirement IDs", async () => {
    state.userId = outsider;
    const foreign = await create(3, otherOrg);
    const foreignEvent = randomUUID();
    await db.$client.query(
      "insert into event_types(id,organization_id,owner_id,slug,title) values($1::uuid,$2,$3,$1::text,'Foreign service')",
      [foreignEvent, otherOrg, outsider],
    );
    state.userId = host;
    expect((await patch(foreign, { name: "Cross-org" })).status).toBe(404);
    expect((await requirements(await service(), [{ id: foreign.id, quantity: 1 }])).status).toBe(
      400,
    );
    expect((await requirements(foreignEvent, [], 1)).status).toBe(404);
  });
  it("saves weekly hours and overrides then clears the restriction, preserving capacity/name", async () => {
    const r = await create();
    const saved = await patch(r, { openingHours: hours });
    expect(saved.status).toBe(200);
    const current = (await saved.json()).resource;
    expect(current).toMatchObject({ name: r.name, capacity: 3, openingHours: hours });
    const cleared = await patch(current, { openingHours: null });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).resource).toMatchObject({
      openingHours: null,
      name: r.name,
      capacity: 3,
    });
  });
  it.each([
    { ...hours, timezone: "Invalid/Timezone" },
    { ...hours, rules: [{ dayOfWeek: 1, startTime: "18:00", endTime: "09:00" }] },
    { ...hours, overrides: [{ date: "2030-02-30", startTime: null, endTime: null }] },
    { ...hours, overrides: [hours.overrides[0], hours.overrides[0]] },
  ])("PostgreSQL rejects malformed hours without mutation", async (openingHours) => {
    const r = await create();
    expect((await patch(r, { openingHours })).status).toBe(409);
    expect(
      (await db.$client.query("select opening_hours from resources where id=$1", [r.id])).rows[0]
        .opening_hours,
    ).toBe(null);
  });
  it("distinguishes explicit closed hours from no restriction and retains 24:00", async () => {
    const r = await create();
    const closed = await patch(r, { openingHours: { timezone: "UTC", rules: [], overrides: [] } });
    expect(closed.status).toBe(200);
    const allDay = await patch((await closed.json()).resource, {
      openingHours: {
        timezone: "UTC",
        rules: [{ dayOfWeek: 0, startTime: "00:00", endTime: "24:00" }],
        overrides: [],
      },
    });
    expect(allDay.status).toBe(200);
  });
  it("adds multiple requirements, edits quantity and removes them without service data loss or activation", async () => {
    const a = await create();
    const b = await create();
    const event = await service();
    const before = await readService(event);
    expect(
      (
        await requirements(event, [
          { id: a.id, quantity: 2 },
          { id: b.id, quantity: 1 },
        ])
      ).status,
    ).toBe(200);
    expect((await requirements(event, [{ id: a.id, quantity: 3 }])).status).toBe(200);
    expect((await requirements(event, [])).status).toBe(200);
    const after = await readService(event);
    expect(after).toMatchObject({
      price: before.price,
      description: before.description,
      duration_minutes: before.duration_minutes,
      resource_admission_epoch: "0",
    });
    expect(Number(after.resource_configuration_revision)).toBeGreaterThan(
      Number(before.resource_configuration_revision),
    );
  });
  it("rejects duplicate/impossible quantities without losing the old plan", async () => {
    const r = await create();
    const event = await service();
    expect((await requirements(event, [{ id: r.id, quantity: 1 }])).status).toBe(200);
    expect(
      (
        await requirements(event, [
          { id: r.id, quantity: 1 },
          { id: r.id, quantity: 2 },
        ])
      ).status,
    ).toBe(400);
    expect(
      (
        await requirements(event, [
          { id: r.id, quantity: 1 },
          { id: r.id.toUpperCase(), quantity: 1 },
        ])
      ).status,
    ).toBe(400);
    expect((await requirements(event, [{ id: r.id, quantity: 4 }])).status).toBe(409);
    expect(
      (
        await db.$client.query(
          "select quantity from event_type_resource_requirements where event_type_id=$1",
          [event],
        )
      ).rows,
    ).toEqual([{ quantity: 1 }]);
  });
  it("keeps disabled requirements visible and unchanged; removing them is explicit", async () => {
    const r = await create();
    const event = await service();
    await requirements(event, [{ id: r.id, quantity: 1 }]);
    const current = (await (await GET(request("GET"), undefined)).json()).resources.find(
      (x: { id: string }) => x.id === r.id,
    );
    await patch(current, { enabled: false });
    expect((await requirements(event, [{ id: r.id, quantity: 1 }])).status).toBe(200);
    expect((await requirements(event, [{ id: r.id, quantity: 2 }])).status).toBe(409);
    const data = await (await GET(request("GET"), undefined)).json();
    expect(data.services.find((s: { id: string }) => s.id === event).requirements).toEqual([
      { id: r.id, quantity: 1 },
    ]);
    expect((await requirements(event, [])).status).toBe(200);
  });
  it("rejects stale requirement saves", async () => {
    const r = await create();
    const event = await service();
    const old = Number((await readService(event)).resource_configuration_revision);
    await requirements(event, [{ id: r.id, quantity: 1 }]);
    expect((await requirements(event, [], old)).status).toBe(409);
  });
  it("configuration fence observes a capacity edit before admitting requirements", async () => {
    const r = await create();
    const event = await service();
    const result = await patch(r, { capacity: 1 });
    expect(result.status).toBe(200);
    expect((await requirements(event, [{ id: r.id, quantity: 2 }])).status).toBe(409);
  });
  it("rejects unsupported recurring service plans", async () => {
    const r = await create();
    const event = await service();
    await db.$client.query("update event_types set recurring_count=2 where id=$1", [event]);
    expect((await requirements(event, [{ id: r.id, quantity: 1 }])).status).toBe(409);
  });
  it("re-enabling rejects a capacity below configured quantity without mutation", async () => {
    const r = await create();
    const event = await service();
    expect((await requirements(event, [{ id: r.id, quantity: 3 }])).status).toBe(200);
    const current = (await (await GET(request("GET"), undefined)).json()).resources.find(
      (x: { id: string }) => x.id === r.id,
    );
    const disabled = await patch(current, { enabled: false, capacity: 2 });
    expect(disabled.status).toBe(200);
    expect((await patch((await disabled.json()).resource, { enabled: true })).status).toBe(409);
    expect(
      (await db.$client.query("select enabled,capacity from resources where id=$1", [r.id]))
        .rows[0],
    ).toEqual({ enabled: false, capacity: 2 });
  });
  it("managed requirement edits leave immutable accepted terms and financial facts intact", async () => {
    const { r, event, booking } = await occupied();
    const before = (await db.$client.query("select * from bookings where id=$1", [booking]))
      .rows[0];
    const replacement = await create();
    expect((await requirements(event, [{ id: replacement.id, quantity: 1 }])).status).toBe(200);
    const after = (await db.$client.query("select * from bookings where id=$1", [booking])).rows[0];
    expect(after).toEqual(before);
    expect(
      (
        await db.$client.query(
          "select resource_id,released_at from booking_resource_claims where booking_id=$1",
          [booking],
        )
      ).rows,
    ).toEqual([{ resource_id: r.id, released_at: null }]);
  });
  it("hidden Personal service cannot receive requirements or appear in configuration", async () => {
    const r = await create();
    const id = randomUUID();
    await db.$client.query(
      "insert into event_types(id,organization_id,owner_id,slug,title) values($1,$2,$3,'__personal','Personal')",
      [id, org, host],
    );
    expect((await requirements(id, [{ id: r.id, quantity: 1 }])).status).toBe(400);
    expect(
      (await (await GET(request("GET"), undefined)).json()).services.some(
        (s: { id: string }) => s.id === id,
      ),
    ).toBe(false);
  });
  async function waitBlocked() {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = await db.$client.query(
        "select exists(select 1 from pg_stat_activity where datname=$1 and cardinality(pg_blocking_pids(pid))>0) as blocked",
        [databaseName],
      );
      if (result.rows[0].blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Expected configuration operation to wait on the established fence");
  }
  it("capacity edit racing requirement admission validates the newly committed capacity", async () => {
    const r = await create();
    const event = await service();
    const holder = await db.$client.connect();
    let pending: ReturnType<typeof requirements> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("update resources set capacity=1 where id=$1", [r.id]);
      pending = requirements(event, [{ id: r.id, quantity: 2 }]);
      await waitBlocked();
      await holder.query("COMMIT");
      expect((await pending).status).toBe(409);
      expect(
        (
          await db.$client.query(
            "select * from event_type_resource_requirements where event_type_id=$1",
            [event],
          )
        ).rows,
      ).toHaveLength(0);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await pending;
    }
  });
  it("a concurrent role revocation prevents a waiting resource mutation", async () => {
    const holder = await db.$client.connect();
    let pending: Promise<Response> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query(
        "update memberships set role='member' where organization_id=$1 and user_id=$2",
        [org, host],
      );
      pending = POST(
        request("POST", {
          organizationId: org,
          name: "Unauthorized after revocation",
          capacity: 1,
          enabled: true,
        }),
        undefined,
      );
      await waitBlocked();
      await holder.query("COMMIT");
      expect((await pending).status).toBe(403);
      expect(
        (
          await db.$client.query(
            "select * from resources where organization_id=$1 and name='Unauthorized after revocation'",
            [org],
          )
        ).rows,
      ).toHaveLength(0);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await pending;
      await db.$client.query(
        "update memberships set role='owner' where organization_id=$1 and user_id=$2",
        [org, host],
      );
    }
  });
});
