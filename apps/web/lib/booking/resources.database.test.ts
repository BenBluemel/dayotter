import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { classifyResourceError, createDatabase } from "@dayotter/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type PoolClient = Pick<ReturnType<typeof createDatabase>["$client"], "query"> & { release(): void };

const testUrl = process.env.RESOURCES_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("resource allocation PostgreSQL foundation", () => {
  let db: ReturnType<typeof createDatabase>;
  let admin: ReturnType<typeof createDatabase>;
  let created = false;
  const databaseName = `dayotter_resources_test_${randomUUID().replaceAll("-", "")}`;
  const org = randomUUID();
  const otherOrg = randomUUID();
  const host = randomUUID();
  const schedule = randomUUID();
  const at = (minutes: number) => new Date(Date.UTC(2030, 0, 1, 10, minutes));
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
        "insert into organizations(id,name,slug) values($1::uuid,'Resources test',$1::text),($2::uuid,'Other test',$2::text)",
        [org, otherOrg],
      );
      await client.query(
        "insert into users(id,name,email,timezone) values($1,'Host',$2,'America/Boise')",
        [host, `${host}@example.test`],
      );
      await client.query(
        "insert into schedules(id,user_id,timezone,is_default) values($1,$2,'America/Boise',true)",
        [schedule, host],
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }, 60000);
  afterAll(async () => {
    await db?.$client.end();
    if (created) await admin.$client.query(`DROP DATABASE "${databaseName}"`);
    await admin?.$client.end();
  });
  async function resource(capacity = 1, organization = org) {
    const id = randomUUID();
    await db.$client.query(
      "insert into resources(id,organization_id,name,capacity) values($1,$2,'Light',$3)",
      [id, organization, capacity],
    );
    return id;
  }
  async function service(requirements: { id: string; quantity?: number }[], before = 0, after = 0) {
    const id = randomUUID();
    await db.$client.query(
      "insert into event_types(id,organization_id,owner_id,schedule_id,slug,title,buffer_before_minutes,buffer_after_minutes) values($1::uuid,$2,$3,$4,$1::text,'Treatment',$5,$6)",
      [id, org, host, schedule, before, after],
    );
    for (const r of requirements)
      await db.$client.query(
        "insert into event_type_resource_requirements(organization_id,event_type_id,resource_id,quantity) values($1,$2,$3,$4)",
        [org, id, r.id, r.quantity ?? 1],
      );
    return id;
  }
  async function transaction<T>(body: (c: PoolClient) => Promise<T>, isolation = "read committed") {
    const c = await db.$client.connect();
    try {
      await c.query(`begin isolation level ${isolation}`);
      const result = await body(c);
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async function insert(c: PoolClient, event: string, from = 0, to = 60, planOverride?: unknown) {
    const id = randomUUID();
    const plan =
      planOverride ??
      (await c.query("select resource_accept_plan($1,$2,$3) as plan", [event, to - from, host]))
        .rows[0].plan;
    await c.query(
      "insert into bookings(id,organization_id,event_type_id,host_id,title,uid,starts_at,ends_at,timezone,allow_overlap,scheduling_plan,allocation_revision) values($1::uuid,$2,$3,$4,'Treatment',$1::text,$5,$6,'UTC',true,$7,1)",
      [id, org, event, host, at(from), at(to), plan],
    );
    return id;
  }
  async function rawClaim(
    c: PoolClient,
    bookingId: string,
    overrides: Record<string, unknown> = {},
    resourceIndex = 0,
  ) {
    const b = (await c.query("select * from bookings where id=$1", [bookingId])).rows[0];
    const item = b.scheduling_plan.resources[resourceIndex];
    const capacity = (await c.query("select capacity from resources where id=$1", [item.id]))
      .rows[0].capacity;
    const occupied = (
      await c.query(
        "select lower(resource_occupied_interval(starts_at,ends_at,scheduling_plan)) as a,upper(resource_occupied_interval(starts_at,ends_at,scheduling_plan)) as z from bookings where id=$1",
        [bookingId],
      )
    ).rows[0];
    const fields: Record<string, unknown> = {
      organization_id: b.organization_id,
      event_type_id: b.event_type_id,
      booking_id: bookingId,
      resource_id: item.id,
      configuration_revision: b.scheduling_plan.configurationRevision,
      allocation_revision: b.allocation_revision,
      quantity: item.quantity,
      resource_name: item.name,
      capacity_at_allocation: capacity,
      starts_at: occupied.a,
      ends_at: occupied.z,
      source: "claim-diagnostic-test",
      ...overrides,
    };
    // Only test-owned column names enter this statement; values are parameters.
    await c.query(
      `insert into booking_resource_claims(${Object.keys(fields).join(",")}) values(${Object.values(
        fields,
      )
        .map((_, i) => `$${i + 1}`)
        .join(",")})`,
      Object.values(fields),
    );
  }
  const allocate = (c: PoolClient, bid: string) =>
    c.query("select resource_allocate_booking($1,'integration-test')", [bid]);
  const book = (event: string, from = 0, to = 60) =>
    transaction(async (c) => {
      const id = await insert(c, event, from, to);
      await allocate(c, id);
      return id;
    });
  async function expectError(p: Promise<unknown>, identity: string) {
    const e = await p.then(
      () => null,
      (error: unknown) => error,
    );
    const diagnostic = classifyResourceError(e);
    expect(diagnostic && "identity" in diagnostic ? diagnostic.identity : null).toBe(identity);
  }
  async function waitBlocked(pid: number) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (
        (await db.$client.query("select cardinality(pg_blocking_pids($1))>0 as blocked", [pid]))
          .rows[0].blocked
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Expected deterministic resource lock wait");
  }
  async function heldRace(capacity: number, contenders: number, isolation = "read committed") {
    const r = await resource(capacity);
    const e = await service([{ id: r }]);
    const first = await db.$client.connect();
    const waiting: PoolClient[] = [];
    try {
      await first.query("begin");
      const id = await insert(first, e);
      await allocate(first, id);
      const operations: Promise<unknown>[] = [];
      for (let i = 0; i < contenders; i++) {
        const c = await db.$client.connect();
        waiting.push(c);
        await c.query(`begin isolation level ${isolation}`);
        const bid = await insert(c, e);
        const pid = (await c.query("select pg_backend_pid() as pid")).rows[0].pid;
        const operation = allocate(c, bid)
          .then(() => c.query("COMMIT"))
          .then(
            () => true,
            async (error: unknown) => {
              await c.query("ROLLBACK");
              return error;
            },
          );
        operations.push(operation);
        await waitBlocked(pid);
      }
      await first.query("COMMIT");
      return { r, results: await Promise.all(operations) };
    } finally {
      await first.query("ROLLBACK");
      first.release();
      for (const c of waiting) c.release();
    }
  }

  it("capacity one: final-use race admits exactly one and reads freshly after fence", async () => {
    const { r, results } = await heldRace(1, 1);
    expect(classifyResourceError(results[0])).toEqual({
      category: "conflict",
      identity: "resource_capacity_conflict",
    });
    expect(
      (
        await db.$client.query(
          "select count(*)::int as n from booking_resource_claims where resource_id=$1",
          [r],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("capacity two: three concurrent quantity-one allocations admit exactly two", async () => {
    const { results } = await heldRace(2, 2);
    expect(results.filter((x) => x === true)).toHaveLength(1);
    expect(results.filter((x) => classifyResourceError(x)?.category === "conflict")).toHaveLength(
      1,
    );
  });
  it("repeatable-read stale admission aborts with serialization failure", async () => {
    const { results } = await heldRace(2, 1, "repeatable read");
    expect(classifyResourceError(results[0])).toEqual({ category: "transient", code: "40001" });
  });
  it("quantity two consumes weighted capacity", async () => {
    const r = await resource(3);
    const e = await service([{ id: r, quantity: 2 }]);
    await book(e);
    await expectError(book(e), "resource_capacity_conflict");
  });
  it("chained overlaps use endpoint peak, not total overlapping quantity", async () => {
    const r = await resource(2);
    const e = await service([{ id: r }]);
    await book(e, 0, 30);
    await book(e, 30, 60);
    await book(e, 0, 60);
    expect(
      (await db.$client.query("select resource_peak($1,$2,$3) as p", [r, at(0), at(60)])).rows[0].p,
    ).toBe("2");
  });
  it("half-open adjacency and simultaneous starts/ends have no transient peak", async () => {
    const r = await resource(2);
    const e = await service([{ id: r }]);
    await book(e, 0, 60);
    await book(e, 0, 60);
    await book(e, 60, 120);
    await book(e, 60, 120);
    expect(
      (await db.$client.query("select resource_peak($1,$2,$3) as p", [r, at(0), at(120)])).rows[0]
        .p,
    ).toBe("2");
  });
  it("crossing-window claims are clipped; accepted buffers define one interval", async () => {
    const r = await resource();
    const e = await service([{ id: r }], 10, 15);
    const b = await book(e);
    const c = (
      await db.$client.query("select * from booking_resource_claims where booking_id=$1", [b])
    ).rows[0];
    expect(c.starts_at).toEqual(at(-10));
    expect(c.ends_at).toEqual(at(75));
    await expectError(book(e, 70, 130), "resource_capacity_conflict");
    await book(e, 85, 145);
  });
  it("release is idempotent, preserves evidence and frees capacity even when disabled", async () => {
    const r = await resource();
    const e = await service([{ id: r }]);
    const b = await book(e);
    await db.$client.query("update resources set enabled=false where id=$1", [r]);
    await transaction(async (c) => {
      await c.query("update bookings set status='cancelled' where id=$1", [b]);
      await c.query("select resource_release_booking($1)", [b]);
      await c.query("select resource_release_booking($1)", [b]);
    });
    const rows = (
      await db.$client.query("select * from booking_resource_claims where booking_id=$1", [b])
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].release_reason).toBe("cancelled");
    await db.$client.query("update resources set enabled=true where id=$1", [r]);
    await book(e);
  });
  it("multiple resources fail all-or-nothing and rollback has no partial claims", async () => {
    const x = await resource();
    const y = await resource();
    await book(await service([{ id: y }]));
    const e = await service([{ id: x }, { id: y }]);
    await expectError(book(e), "resource_capacity_conflict");
    expect(
      (
        await db.$client.query(
          "select count(*)::int as n from booking_resource_claims where resource_id=$1",
          [x],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("opposite logical requirement orders acquire the same sorted resource union", async () => {
    const x = await resource(2);
    const y = await resource(2);
    const a = await service([{ id: x }, { id: y }]);
    const b = await service([{ id: y }, { id: x }]);
    expect(await Promise.allSettled([book(a), book(b)])).toEqual([
      expect.objectContaining({ status: "fulfilled" }),
      expect.objectContaining({ status: "fulfilled" }),
    ]);
  });
  it("capacity reduction cannot pass a competing committed allocation", async () => {
    const r = await resource(2);
    const e = await service([{ id: r }]);
    const c = await db.$client.connect();
    try {
      await c.query("begin");
      const b = await insert(c, e);
      await allocate(c, b);
      const other = await db.$client.connect();
      try {
        const pid = (await other.query("select pg_backend_pid() as pid")).rows[0].pid;
        const change = other.query("update resources set capacity=1 where id=$1", [r]);
        await waitBlocked(pid);
        await c.query("COMMIT");
        await change;
        await expectError(book(e), "resource_capacity_conflict");
      } finally {
        other.release();
      }
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });
  it("capacity reduction below existing ongoing/future peak is rejected", async () => {
    const r = await resource(2);
    const e = await service([{ id: r }]);
    await book(e);
    await book(e);
    await expectError(
      db.$client.query("update resources set capacity=1 where id=$1", [r]),
      "resource_capacity_conflict",
    );
  });
  it("disabled resources preserve old claims and reject new allocation", async () => {
    const r = await resource();
    const e = await service([{ id: r }]);
    await book(e);
    await db.$client.query("update resources set enabled=false where id=$1", [r]);
    const existing = (
      await db.$client.query(
        "select booking_id from booking_resource_claims where resource_id=$1",
        [r],
      )
    ).rows[0].booking_id;
    await transaction((c) => allocate(c, existing));
    await expectError(book(e, 120, 180), "resource_disabled");
    expect(
      (
        await db.$client.query(
          "select count(*)::int as n from booking_resource_claims where resource_id=$1",
          [r],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("missing claim fails at COMMIT, even without calling an allocation helper", async () => {
    const e = await service([{ id: await resource() }]);
    await expectError(
      transaction((c) => insert(c, e)),
      "resource_plan_completeness_violation",
    );
  });
  for (const [field, value] of [
    ["quantity", 2],
    ["starts_at", at(-1)],
    ["allocation_revision", 2],
    ["configuration_revision", 999],
  ] as const) {
    it(`wrong ${field} fails immediate claim-vs-plan validation`, async () => {
      const e = await service([{ id: await resource(10) }]);
      let inserted = false;
      await expectError(
        transaction(async (c) => {
          const b = await insert(c, e);
          const plan = (await c.query("select scheduling_plan as p from bookings where id=$1", [b]))
            .rows[0].p;
          const interval = (
            await c.query(
              "select lower(resource_occupied_interval(starts_at,ends_at,scheduling_plan)) as a,upper(resource_occupied_interval(starts_at,ends_at,scheduling_plan)) as z from bookings where id=$1",
              [b],
            )
          ).rows[0];
          const args: unknown[] = [
            org,
            e,
            b,
            plan.resources[0].id,
            plan.configurationRevision,
            1,
            1,
            plan.resources[0].name,
            10,
            interval.a,
            interval.z,
          ];
          const columns = [
            "organization_id",
            "event_type_id",
            "booking_id",
            "resource_id",
            "configuration_revision",
            "allocation_revision",
            "quantity",
            "resource_name",
            "capacity_at_allocation",
            "starts_at",
            "ends_at",
          ];
          args[columns.indexOf(field)] = value;
          await c.query(
            `insert into booking_resource_claims(${columns.join(",")},source) values(${args.map((_, i) => `$${i + 1}`).join(",")},'raw-test')`,
            args,
          );
          inserted = true;
        }),
        "resource_plan_completeness_violation",
      );
      expect(inserted).toBe(false);
    });
  }
  it("extra active claim is rejected without admitting a partially claimed booking", async () => {
    const r = await resource(10);
    const extra = await resource(10);
    const e = await service([{ id: r }]);
    let inserted = false;
    await expectError(
      transaction(async (c) => {
        const b = await insert(c, e);
        await allocate(c, b);
        await c.query(
          "insert into booking_resource_claims(organization_id,event_type_id,booking_id,resource_id,configuration_revision,allocation_revision,quantity,resource_name,capacity_at_allocation,starts_at,ends_at,source) select organization_id,event_type_id,id,$2,(scheduling_plan->>'configurationRevision')::bigint,allocation_revision,1,'Light',10,starts_at,ends_at,'raw-test' from bookings where id=$1",
          [b, extra],
        );
        inserted = true;
      }),
      "resource_plan_completeness_violation",
    );
    expect(inserted).toBe(false);
  });
  for (const demand of [0, 1]) {
    it(`quantity mismatch is invariant with ${demand} existing unit(s), capacity two`, async () => {
      const e = await service([{ id: await resource(2) }]);
      if (demand) await book(e);
      await expectError(
        transaction(async (c) => {
          await rawClaim(c, await insert(c, e), { quantity: 2 });
        }),
        "resource_plan_completeness_violation",
      );
    });
    for (const [field, value, diagnostic] of [
      ["resource_id", "extra", "resource_plan_completeness_violation"],
      ["organization_id", otherOrg, "resource_scope_violation"],
      ["event_type_id", "other-service", "resource_scope_violation"],
      ["configuration_revision", 999, "resource_plan_completeness_violation"],
      ["allocation_revision", 2, "resource_plan_completeness_violation"],
      ["starts_at", at(-1), "resource_plan_completeness_violation"],
      ["ends_at", at(61), "resource_plan_completeness_violation"],
      ["resource_name", "Forged name", "resource_plan_completeness_violation"],
      ["capacity_at_allocation", 2, "resource_plan_completeness_violation"],
      ["predecessor_id", "random-id", "resource_claim_lifecycle_violation"],
    ] as const) {
      it(`${field} mismatch stays invariant with ${demand} competing claim(s)`, async () => {
        const r = await resource();
        const e = await service([{ id: r }]);
        if (demand) await book(e);
        let submitted: unknown = value;
        if (value === "extra") {
          submitted = await resource();
          if (demand) await book(await service([{ id: submitted as string }]));
        } else if (value === "other-service") submitted = await service([]);
        else if (value === "random-id") submitted = randomUUID();
        await expectError(
          transaction(async (c) => {
            await rawClaim(c, await insert(c, e), { [field]: submitted });
          }),
          diagnostic,
        );
      });
    }
  }
  for (const capacity of [1, 2]) {
    it(`duplicate claim is invariant regardless of spare capacity (${capacity})`, async () => {
      const e = await service([{ id: await resource(capacity) }]);
      const b = await book(e);
      await expectError(
        transaction((c) => rawClaim(c, b)),
        "resource_plan_completeness_violation",
      );
    });
  }
  it("invalid allocation provenance is not ordinary capacity contention", async () => {
    const e = await service([{ id: await resource() }]);
    await book(e);
    await expectError(
      transaction(async (c) => {
        await rawClaim(c, await insert(c, e), { source: "" });
      }),
      "resource_claim_lifecycle_violation",
    );
  });
  it("a structurally valid raw claim still reports occupied capacity", async () => {
    const e = await service([{ id: await resource() }]);
    await book(e);
    await expectError(
      transaction(async (c) => {
        await rawClaim(c, await insert(c, e));
      }),
      "resource_capacity_conflict",
    );
  });
  it("malformed claims do not become disabled-resource scheduling conflicts", async () => {
    const r = await resource(2);
    const e = await service([{ id: r }]);
    await db.$client.query("update resources set enabled=false where id=$1", [r]);
    await expectError(
      transaction(async (c) => {
        await rawClaim(c, await insert(c, e), { quantity: 2 });
      }),
      "resource_plan_completeness_violation",
    );
  });
  it("partial multi-claim intermediate state is legal; missing final claim is deferred", async () => {
    const e = await service([{ id: await resource(2) }, { id: await resource(2) }]);
    await transaction(async (c) => {
      const b = await insert(c, e);
      await rawClaim(c, b, {}, 0);
      expect(
        (
          await c.query(
            "select count(*)::int as n from booking_resource_claims where booking_id=$1",
            [b],
          )
        ).rows[0].n,
      ).toBe(1);
      await rawClaim(c, b, {}, 1);
    });
    let firstClaimInserted = false;
    await expectError(
      transaction(async (c) => {
        const b = await insert(c, e);
        await rawClaim(c, b, {}, 0);
        firstClaimInserted = true;
      }),
      "resource_plan_completeness_violation",
    );
    expect(firstClaimInserted).toBe(true);
  });
  it("multi-resource weighted replacement accepts old-revision releases and rolls back failed moves", async () => {
    const x = await resource(2);
    const y = await resource(2);
    const e = await service([
      { id: x, quantity: 2 },
      { id: y, quantity: 2 },
    ]);
    const b = await book(e);
    await book(await service([{ id: y }]), 120, 180);
    const move = (from: number) =>
      transaction(async (c) => {
        await c.query(
          "update bookings set starts_at=$2,ends_at=$3,allocation_revision=2 where id=$1",
          [b, at(from), at(from + 60)],
        );
        await allocate(c, b);
      });
    await expectError(move(120), "resource_capacity_conflict");
    expect(
      (await db.$client.query("select allocation_revision from bookings where id=$1", [b])).rows[0]
        .allocation_revision,
    ).toBe("1");
    await move(60);
    const history = (
      await db.$client.query(
        "select allocation_revision,release_reason from booking_resource_claims where booking_id=$1 order by allocation_revision",
        [b],
      )
    ).rows;
    expect(history.map((c) => c.release_reason)).toEqual([
      "rescheduled",
      "rescheduled",
      null,
      null,
    ]);
  });
  it("cross-organization requirement is rejected", async () => {
    const r = await resource(1, otherOrg);
    const e = await service([]);
    await expectError(
      db.$client.query(
        "insert into event_type_resource_requirements values($1,$2,$3,1,now(),now())",
        [org, e, r],
      ),
      "resource_scope_violation",
    );
  });
  it("cross-organization claim is rejected", async () => {
    const r = await resource();
    const foreign = await resource(1, otherOrg);
    const e = await service([{ id: r }]);
    await expectError(
      transaction(async (c) => {
        const b = await insert(c, e);
        await c.query(
          "insert into booking_resource_claims(organization_id,event_type_id,booking_id,resource_id,configuration_revision,allocation_revision,quantity,resource_name,capacity_at_allocation,starts_at,ends_at,source) select organization_id,event_type_id,id,$2,(scheduling_plan->>'configurationRevision')::bigint,1,1,'Light',1,starts_at,ends_at,'raw-test' from bookings where id=$1",
          [b, foreign],
        );
      }),
      "resource_scope_violation",
    );
  });
  it("accepted plans cannot be forged by empty resources, changed hosts or a boolean", async () => {
    const e = await service([{ id: await resource() }]);
    const plan = (await db.$client.query("select resource_accept_plan($1,60,$2) as p", [e, host]))
      .rows[0].p;
    await expectError(
      transaction((c) => insert(c, e, 0, 60, { ...plan, resources: [] })),
      "resource_plan_completeness_violation",
    );
    await expectError(
      transaction((c) => insert(c, e, 0, 60, { ...plan, requiresHost: false })),
      "resource_plan_completeness_violation",
    );
  });
  it("legacy bookings remain unmanaged; raw adoption is unavailable", async () => {
    const e = await service([{ id: await resource() }]);
    const b = randomUUID();
    await db.$client.query(
      "insert into bookings(id,organization_id,event_type_id,host_id,title,uid,starts_at,ends_at,timezone,allow_overlap) values($1::uuid,$2,$3,$4,'Legacy',$1::text,$5,$6,'UTC',true)",
      [b, org, e, host, at(0), at(60)],
    );
    await expectError(
      db.$client.query(
        "update bookings set scheduling_plan=resource_accept_plan(event_type_id,60,host_id),allocation_revision=1 where id=$1",
        [b],
      ),
      "resource_plan_completeness_violation",
    );
  });
  it("resource and claim history cannot be deleted or rewritten", async () => {
    const r = await resource();
    const e = await service([{ id: r }]);
    const b = await book(e);
    await expectError(
      db.$client.query("delete from booking_resource_claims where booking_id=$1", [b]),
      "resource_claim_lifecycle_violation",
    );
    await expectError(
      db.$client.query("update booking_resource_claims set quantity=2 where booking_id=$1", [b]),
      "resource_claim_lifecycle_violation",
    );
    await expectError(
      db.$client.query("truncate booking_resource_claims"),
      "resource_claim_lifecycle_violation",
    );
    await expectError(
      db.$client.query("delete from resources where id=$1", [r]),
      "resource_claim_lifecycle_violation",
    );
    await expectError(
      db.$client.query("update resources set organization_id=$2 where id=$1", [r, otherOrg]),
      "resource_scope_violation",
    );
  });
  it("claim replacement appends revision history; failed destination restores old state", async () => {
    const r = await resource();
    const e = await service([{ id: r }]);
    const a = await book(e);
    await book(e, 120, 180);
    await expectError(
      transaction(async (c) => {
        await c.query(
          "update bookings set starts_at=$2,ends_at=$3,allocation_revision=allocation_revision+1 where id=$1",
          [a, at(120), at(180)],
        );
        await allocate(c, a);
      }),
      "resource_capacity_conflict",
    );
    expect(
      (await db.$client.query("select starts_at from bookings where id=$1", [a])).rows[0].starts_at,
    ).toEqual(at(0));
    for (const start of [60, 180])
      await transaction(async (c) => {
        await c.query(
          "update bookings set starts_at=$2,ends_at=$3,allocation_revision=allocation_revision+1 where id=$1",
          [a, at(start), at(start + 60)],
        );
        await allocate(c, a);
      });
    const history = (
      await db.$client.query(
        "select * from booking_resource_claims where booking_id=$1 order by allocation_revision",
        [a],
      )
    ).rows;
    expect(history).toHaveLength(3);
    expect(history.map((x) => x.release_reason)).toEqual(["rescheduled", "rescheduled", null]);
    expect(history[1].predecessor_id).toBe(history[0].id);
  });
  it("requirement edits preserve accepted resource/name/quantity history", async () => {
    const r = await resource(3);
    const e = await service([{ id: r }]);
    const b = await book(e);
    const old = (await db.$client.query("select scheduling_plan from bookings where id=$1", [b]))
      .rows[0].scheduling_plan;
    await db.$client.query("update resources set name='Renamed' where id=$1", [r]);
    await db.$client.query("delete from event_type_resource_requirements where event_type_id=$1", [
      e,
    ]);
    expect(
      (await db.$client.query("select scheduling_plan from bookings where id=$1", [b])).rows[0]
        .scheduling_plan,
    ).toEqual(old);
    await transaction(async (c) => {
      await c.query(
        "update bookings set starts_at=$2,ends_at=$3,allocation_revision=2 where id=$1",
        [b, at(120), at(180)],
      );
      await allocate(c, b);
    });
  });
  it("managed completion retains buffers; cancellation without release fails at COMMIT", async () => {
    const e = await service([{ id: await resource() }], 0, 15);
    const b = await book(e);
    await db.$client.query("update bookings set status='completed' where id=$1", [b]);
    expect(
      (
        await db.$client.query(
          "select released_at from booking_resource_claims where booking_id=$1",
          [b],
        )
      ).rows[0].released_at,
    ).toBeNull();
    await expectError(
      db.$client.query("update bookings set status='cancelled' where id=$1", [b]),
      "resource_plan_completeness_violation",
    );
  });
  it("admission activation and host-free configuration are unavailable in R1", async () => {
    const e = await service([]);
    await expectError(
      db.$client.query("update event_types set resource_admission_epoch=1 where id=$1", [e]),
      "resource_plan_completeness_violation",
    );
    await expectError(
      db.$client.query("update event_types set requires_host=false where id=$1", [e]),
      "resource_plan_completeness_violation",
    );
  });
  it("atomic configuration replacement rolls back every edit on invalid new resource", async () => {
    const x = await resource(2);
    const y = await resource(2);
    const e = await service([{ id: x }]);
    await db.$client.query("update resources set enabled=false where id=$1", [y]);
    await expectError(
      db.$client.query("select resource_set_requirements($1,$2)", [
        e,
        JSON.stringify([
          { id: x, quantity: 2 },
          { id: y, quantity: 1 },
        ]),
      ]),
      "resource_disabled",
    );
    expect(
      (
        await db.$client.query(
          "select resource_id,quantity from event_type_resource_requirements where event_type_id=$1",
          [e],
        )
      ).rows,
    ).toEqual([{ resource_id: x, quantity: 1 }]);
    await db.$client.query("update resources set enabled=true where id=$1", [y]);
    await db.$client.query("select resource_set_requirements($1,$2)", [
      e,
      JSON.stringify([
        { id: y, quantity: 1 },
        { id: x, quantity: 2 },
      ]),
    ]);
    await book(e);
  });
  it("empty accepted plans are proven, not merely empty, and retain schedule history", async () => {
    const e = await service([]);
    const b = await book(e);
    expect(
      (await db.$client.query("select scheduling_plan from bookings where id=$1", [b])).rows[0]
        .scheduling_plan.resources,
    ).toEqual([]);
    await expectError(
      db.$client.query("delete from schedules where id=$1", [schedule]),
      "resource_claim_lifecycle_violation",
    );
  });
  it("direct SQL claim writes wait on the resource fence without a helper", async () => {
    const r = await resource();
    const e = await service([{ id: r }]);
    const c = await db.$client.connect();
    const other = await db.$client.connect();
    try {
      await c.query("begin");
      const a = await insert(c, e);
      await allocate(c, a);
      await other.query("begin");
      const b = await insert(other, e);
      const pid = (await other.query("select pg_backend_pid() as pid")).rows[0].pid;
      const write = other
        .query(
          "insert into booking_resource_claims(organization_id,event_type_id,booking_id,resource_id,configuration_revision,allocation_revision,quantity,resource_name,capacity_at_allocation,starts_at,ends_at,source) select organization_id,event_type_id,id,$2,(scheduling_plan->>'configurationRevision')::bigint,1,1,'Light',1,starts_at,ends_at,'raw-test' from bookings where id=$1",
          [b, r],
        )
        .then(
          () => null,
          (error: unknown) => error,
        );
      await waitBlocked(pid);
      await c.query("COMMIT");
      expect(classifyResourceError(await write)).toEqual({
        category: "conflict",
        identity: "resource_capacity_conflict",
      });
    } finally {
      await c.query("ROLLBACK");
      await other.query("ROLLBACK");
      c.release();
      other.release();
    }
  });
  it("ongoing buffered demand prevents reduction, elapsed history does not", async () => {
    const r = await resource(2);
    const e = await service([{ id: r }], 0, 10);
    const now = new Date();
    // Separate two synthetic accepted occurrences whose raw end passed but
    // accepted cleanup still occupies now; authoritative duration stays 30 min.
    for (let i = 0; i < 2; i++)
      await transaction(async (c) => {
        const id = randomUUID();
        const plan = (await c.query("select resource_accept_plan($1,30,$2) as p", [e, host]))
          .rows[0].p;
        await c.query(
          "insert into bookings(id,organization_id,event_type_id,host_id,title,uid,starts_at,ends_at,timezone,allow_overlap,scheduling_plan,allocation_revision) values($1::uuid,$2,$3,$4,'Ongoing',$1::text,$5,$6,'UTC',true,$7,1)",
          [
            id,
            org,
            e,
            host,
            new Date(now.getTime() - 35 * 60000),
            new Date(now.getTime() - 5 * 60000),
            plan,
          ],
        );
        await allocate(c, id);
        await c.query("update bookings set status='completed' where id=$1", [id]);
      });
    await expectError(
      db.$client.query("update resources set capacity=1 where id=$1", [r]),
      "resource_capacity_conflict",
    );
    const elapsed = await resource(2);
    const event = await service([{ id: elapsed, quantity: 2 }]);
    await transaction(async (c) => {
      const id = randomUUID();
      const plan = (await c.query("select resource_accept_plan($1,60,$2) as p", [event, host]))
        .rows[0].p;
      await c.query(
        "insert into bookings(id,organization_id,event_type_id,host_id,title,uid,starts_at,ends_at,timezone,allow_overlap,scheduling_plan,allocation_revision) values($1::uuid,$2,$3,$4,'Past',$1::text,'2020-01-01T10:00Z','2020-01-01T11:00Z','UTC',true,$5,1)",
        [id, org, event, host, plan],
      );
      await allocate(c, id);
      await c.query("update bookings set status='completed' where id=$1", [id]);
    });
    await db.$client.query("select resource_set_requirements($1,'[]')", [event]);
    await db.$client.query("update resources set capacity=1 where id=$1", [elapsed]);
  });
  it("capacity increase is observed after a waiting allocation's fence", async () => {
    const r = await resource();
    const e = await service([{ id: r }]);
    await book(e);
    const config = await db.$client.connect();
    const booking = await db.$client.connect();
    try {
      await config.query("begin");
      await config.query("update resources set capacity=2 where id=$1", [r]);
      await booking.query("begin");
      const b = await insert(booking, e);
      const pid = (await booking.query("select pg_backend_pid() as pid")).rows[0].pid;
      const result = allocate(booking, b);
      await waitBlocked(pid);
      await config.query("COMMIT");
      await result;
      await booking.query("COMMIT");
      expect(
        (
          await db.$client.query(
            "select capacity_at_allocation from booking_resource_claims where booking_id=$1",
            [b],
          )
        ).rows[0].capacity_at_allocation,
      ).toBe(2);
    } finally {
      await config.query("ROLLBACK");
      await booking.query("ROLLBACK");
      config.release();
      booking.release();
    }
  });
  it("re-enabling cannot restore an invalid configured quantity", async () => {
    const r = await resource(2);
    await service([{ id: r, quantity: 2 }]);
    await db.$client.query("update resources set enabled=false,capacity=1 where id=$1", [r]);
    await expectError(
      db.$client.query("update resources set enabled=true where id=$1", [r]),
      "resource_capacity_conflict",
    );
  });
});
