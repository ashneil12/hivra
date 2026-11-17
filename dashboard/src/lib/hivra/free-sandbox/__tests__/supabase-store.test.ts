import type { SupabaseClient } from "@supabase/supabase-js";
import { type PaidCapacityReader, SupabaseBridgeStore } from "../supabase-store";
import type { ArchiveCopy, Placement } from "../ports";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const SANDBOX_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SANDBOX_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const COMPUTER_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const COMPUTER_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const MACHINE_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const HASH = "a".repeat(64);
const SHA = "b".repeat(64);
const OTHER_SHA = "c".repeat(64);
const SECRET = "enroll-code-SECRET-42";
const DAY = "2026-11-17";

/** Archive locations as archive-store.ts writes them: the sandbox id and digest are in the path. */
const LOCATION_A = `free-sandbox/${SANDBOX_A}/${SHA}.tar.zst`;
const LOCATION_NEW = `free-sandbox/${SANDBOX_A}/${OTHER_SHA}.tar.zst`;
const COPY_A: ArchiveCopy = { location: LOCATION_A, sha256: SHA, bytes: 2048 };
const COPY_NEW: ArchiveCopy = { location: LOCATION_NEW, sha256: OTHER_SHA, bytes: 7 };

/** Runs before each query executes; a test uses it to make another writer move a row first. */
interface Hooks {
  beforeExecute?: (table: string, op: string, db: FakeDb) => void;
}

// ---------------------------------------------------------------------------------------------------------------------
// The fake database. It enforces the migration's keys, foreign keys and CHECK constraints (the ones these tables have),
// so a write that the real database would refuse fails here too, and a write is atomic: a statement that breaks a
// constraint changes nothing. The tables and rules mirror dashboard/supabase/migrations/20261117210000_free_sandbox_bridge.sql;
// `free_sandbox_pending_erasures` is not in that migration yet, so its shape follows the store's contract.
// ---------------------------------------------------------------------------------------------------------------------

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64 = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const STATES = ["placing", "awake", "stopped", "packing", "packed", "restoring", "flagged"];

const isNull = (value: unknown) => value === null || value === undefined;
const isUuid = (value: unknown) => typeof value === "string" && UUID_SHAPE.test(value);
const isDigest = (value: unknown) => typeof value === "string" && HEX64.test(value);
const isTime = (value: unknown) => typeof value === "string" && !Number.isNaN(Date.parse(value));
const isCount = (value: unknown) =>
  (typeof value === "number" || typeof value === "string") &&
  /^\d+$/.test(String(value)) &&
  Number.isSafeInteger(Number(value));
const isPositive = (value: unknown) =>
  (typeof value === "number" || typeof value === "string") && /^\d+(\.\d+)?$/.test(String(value)) && Number(value) > 0;

/** Each table's row rules, by constraint name. A rule that returns false is a violated CHECK. */
const RULES: Record<string, [string, (row: Row) => boolean][]> = {
  free_sandbox_pool_servers: [
    ["id_format", (r) => typeof r.id === "string" && SLUG.test(r.id)],
    ["cpus_positive", (r) => isPositive(r.cpus)],
  ],
  free_sandbox_placements: [
    ["org_id_uuid", (r) => isUuid(r.org_id)],
    ["sandbox_id_uuid", (r) => isUuid(r.sandbox_id)],
    ["computer_id_uuid", (r) => isUuid(r.computer_id)],
    ["machine_id_uuid", (r) => isNull(r.machine_id) || isUuid(r.machine_id)],
    ["owner_hash_digest", (r) => isDigest(r.owner_hash)],
    ["state_in_set", (r) => STATES.includes(r.state as string)],
    ["server_by_state", (r) => (r.state === "packed") === isNull(r.server_id)],
    [
      "archive_whole",
      (r) =>
        isNull(r.archive_location) === isNull(r.archive_sha256) && isNull(r.archive_sha256) === isNull(r.archive_bytes),
    ],
    ["archive_sha256_digest", (r) => isNull(r.archive_sha256) || isDigest(r.archive_sha256)],
    ["archive_bytes_count", (r) => isNull(r.archive_bytes) || isCount(r.archive_bytes)],
    ["packed_has_archive", (r) => r.state !== "packed" || !isNull(r.archive_sha256)],
    ["problem_length", (r) => isNull(r.problem) || String(r.problem).length <= 200],
    ["placed_at_timestamp", (r) => isTime(r.placed_at)],
    ["state_at_timestamp", (r) => isTime(r.state_at)],
  ],
  free_sandbox_wakes: [
    ["org_id_uuid", (r) => isUuid(r.org_id)],
    ["wanted_at_timestamp", (r) => isTime(r.wanted_at)],
  ],
  free_sandbox_waitlist: [
    ["org_id_uuid", (r) => isUuid(r.org_id)],
    ["waiting_at_timestamp", (r) => isTime(r.waiting_at)],
  ],
  free_sandbox_ai_days: [
    ["day_format", (r) => DAY_SHAPE.test(String(r.day))],
    ["counts_non_negative", (r) => ["answered", "refused", "failed"].every((column) => isCount(r[column]))],
  ],
  free_sandbox_state: [
    ["singleton", (r) => r.id === true],
    ["cursor_length", (r) => isNull(r.events_cursor) || String(r.events_cursor).length <= 200],
  ],
  free_sandbox_pending_erasures: [
    ["location_present", (r) => typeof r.location === "string" && r.location.length > 0],
    ["sha256_digest", (r) => isDigest(r.sha256)],
    ["bytes_count", (r) => isCount(r.bytes)],
    ["added_at_timestamp", (r) => isTime(r.added_at)],
  ],
};

/** Primary and unique keys, each a list of columns. */
const KEYS: Record<string, string[][]> = {
  free_sandbox_pool_servers: [["id"]],
  free_sandbox_placements: [["org_id"], ["sandbox_id"], ["computer_id"]],
  free_sandbox_wakes: [["org_id"]],
  free_sandbox_waitlist: [["org_id"]],
  free_sandbox_ai_days: [["server_id", "day"]],
  free_sandbox_state: [["id"]],
  free_sandbox_pending_erasures: [["location"]],
};

/** Foreign keys. A cascade removes the child rows when the referenced row is deleted. */
const FOREIGN_KEYS: { table: string; column: string; references: string; target: string; cascade: boolean }[] = [
  {
    table: "free_sandbox_placements",
    column: "server_id",
    references: "free_sandbox_pool_servers",
    target: "id",
    cascade: false,
  },
  {
    table: "free_sandbox_wakes",
    column: "org_id",
    references: "free_sandbox_placements",
    target: "org_id",
    cascade: true,
  },
  {
    table: "free_sandbox_ai_days",
    column: "server_id",
    references: "free_sandbox_pool_servers",
    target: "id",
    cascade: true,
  },
];

/** The first violated constraint in a whole database state, or null when every constraint holds. */
function violationIn(tables: Tables): string | null {
  for (const [table, rules] of Object.entries(RULES)) {
    for (const row of tables[table] ?? []) {
      for (const [name, holds] of rules) if (!holds(row)) return `${table}.${name}`;
    }
  }
  for (const [table, keys] of Object.entries(KEYS)) {
    for (const columns of keys) {
      const seen = new Set<string>();
      for (const row of tables[table] ?? []) {
        const key = JSON.stringify(columns.map((column) => row[column] ?? null));
        if (seen.has(key)) return `${table} unique (${columns.join(", ")})`;
        seen.add(key);
      }
    }
  }
  for (const fk of FOREIGN_KEYS) {
    for (const row of tables[fk.table] ?? []) {
      const value = row[fk.column];
      if (isNull(value)) continue;
      if (!(tables[fk.references] ?? []).some((parent) => parent[fk.target] === value)) {
        return `${fk.table}.${fk.column} references a missing row`;
      }
    }
  }
  return null;
}

class FakeDb {
  tables: Tables;
  /** "table:op" pairs that fail, with the error carrying SECRET (which must never reach a thrown error). */
  failures = new Set<string>();
  hooks: Hooks = {};
  /** Every query issued, as operation and table, in order. */
  log: string[] = [];

  /**
   * `checked` (the default) refuses a seed that breaks a constraint, so a test cannot start from impossible data. Only
   * the tests that check how the store reads drifted rows pass `false`.
   */
  constructor(seed: Record<string, Row[]> = {}, checked = true) {
    this.tables = {
      free_sandbox_pool_servers: [],
      free_sandbox_placements: [],
      free_sandbox_wakes: [],
      free_sandbox_waitlist: [],
      free_sandbox_ai_days: [],
      free_sandbox_state: [],
      free_sandbox_pending_erasures: [],
      ...structuredClone(seed),
    };
    if (checked) {
      const violation = violationIn(this.tables);
      if (violation) throw new Error(`fixture breaks ${violation}`);
    }
  }

  client(): SupabaseClient {
    return { from: (table: string) => new Query(this, table) } as unknown as SupabaseClient;
  }
}

type Result = { data: unknown; error: unknown };

class Query implements PromiseLike<Result> {
  private op: "select" | "upsert" | "update" | "delete" = "select";
  private writing = false;
  private returning = false;
  private single = false;
  private filters: [string, unknown][] = [];
  private sorts: string[] = [];
  private payload: Row = {};
  private conflict: string[] = ["id"];
  private ignoreDuplicates = false;

  constructor(
    private readonly db: FakeDb,
    private readonly table: string,
  ) {}

  select(_columns?: string) {
    if (this.writing) this.returning = true;
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push([column, value]);
    return this;
  }
  order(column: string, _options?: { ascending?: boolean }) {
    this.sorts.push(column);
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }
  upsert(values: Row, options?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.op = "upsert";
    this.writing = true;
    this.payload = values;
    this.conflict = options?.onConflict?.split(",") ?? ["id"];
    this.ignoreDuplicates = options?.ignoreDuplicates ?? false;
    return this;
  }
  update(values: Row) {
    this.op = "update";
    this.writing = true;
    this.payload = values;
    return this;
  }
  delete() {
    this.op = "delete";
    this.writing = true;
    return this;
  }

  then<R1 = Result, R2 = never>(
    onFulfilled?: ((value: Result) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.run().then(onFulfilled, onRejected);
  }

  private matches(row: Row): boolean {
    return this.filters.every(([column, value]) => row[column] === value);
  }

  private sorted(list: Row[]): Row[] {
    return [...list].sort((a, b) => {
      for (const column of this.sorts) {
        const x = String(a[column] ?? "");
        const y = String(b[column] ?? "");
        if (x !== y) return x < y ? -1 : 1;
      }
      return 0;
    });
  }

  /**
   * Runs the statement against a copy of the tables, checks every constraint on the result, and only then makes it
   * the database's state. A statement that breaks a constraint therefore changes nothing, as in the real database.
   */
  private run(): Promise<Result> {
    const { db, table, op } = this;
    db.log.push(`${op} ${table}`);
    db.hooks.beforeExecute?.(table, op, db);
    if (db.failures.has(`${table}:${op}`)) {
      return Promise.resolve({ data: null, error: { message: `database said ${SECRET}` } });
    }
    if (!db.tables[table]) throw new Error(`fake has no table ${table}`);
    if (op === "select") {
      const found = this.sorted(db.tables[table].filter((row) => this.matches(row))).map((row) => ({ ...row }));
      return Promise.resolve({ data: this.single ? (found[0] ?? null) : found, error: null });
    }

    const working: Tables = structuredClone(db.tables);
    let changed: Row[] = [];
    if (op === "upsert") {
      const rows = working[table];
      const key = (row: Row) => this.conflict.every((column) => row[column] === this.payload[column]);
      const existing = rows.find(key);
      if (existing && this.ignoreDuplicates) {
        // ON CONFLICT DO NOTHING: nothing written, nothing returned.
      } else if (existing) {
        // Only the columns sent are updated; the rest keep their stored values.
        Object.assign(existing, this.payload);
        changed = [{ ...existing }];
      } else {
        const inserted = { ...this.payload };
        rows.push(inserted);
        changed = [{ ...inserted }];
      }
    } else if (op === "update") {
      for (const row of working[table].filter((candidate) => this.matches(candidate))) {
        Object.assign(row, this.payload);
        changed.push({ ...row });
      }
    } else {
      const doomed = working[table].filter((row) => this.matches(row));
      working[table] = working[table].filter((row) => !doomed.includes(row));
      for (const fk of FOREIGN_KEYS) {
        if (!fk.cascade || fk.references !== table) continue;
        const gone = new Set(doomed.map((row) => row[fk.target]));
        working[fk.table] = working[fk.table].filter((row) => !gone.has(row[fk.column]));
      }
      changed = doomed.map((row) => ({ ...row }));
    }

    const violation = violationIn(working);
    if (violation) return Promise.resolve({ data: null, error: { message: `database said ${violation}; ${SECRET}` } });
    db.tables = working;
    return Promise.resolve({ data: this.returning ? changed : null, error: null });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------------------------

const pool = (id: string, overrides: Row = {}): Row => ({
  id,
  cpus: 4,
  enabled: true,
  ai_refused_until: null,
  ...overrides,
});

/** The two enabled pool servers, and nothing else. */
const pools = (): Record<string, Row[]> => ({
  free_sandbox_pool_servers: [pool("pool-1"), pool("pool-2")],
});

function placement(overrides: Partial<Placement> = {}): Placement {
  return {
    orgId: ORG_A,
    sandbox: { sandboxId: SANDBOX_A, computerId: COMPUTER_A, ownerHash: HASH },
    machineId: null,
    serverId: "pool-1",
    state: "awake",
    placedAt: new Date("2026-11-01T00:00:00.000Z"),
    stateAt: new Date("2026-11-02T00:00:00.000Z"),
    archive: null,
    problem: null,
    ...overrides,
  };
}

const placementRow = (overrides: Row = {}): Row => ({
  org_id: ORG_A,
  sandbox_id: SANDBOX_A,
  computer_id: COMPUTER_A,
  owner_hash: HASH,
  machine_id: null,
  server_id: "pool-1",
  state: "awake",
  placed_at: "2026-11-01T00:00:00.000Z",
  state_at: "2026-11-02T00:00:00.000Z",
  archive_location: null,
  archive_sha256: null,
  archive_bytes: null,
  problem: null,
  ...overrides,
});

/** A consistent starting state: both pool servers, and workspace A awake on pool-1. Overrides replace tables. */
function world(overrides: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    ...pools(),
    free_sandbox_placements: [placementRow()],
    ...overrides,
  };
}

const freePaid: PaidCapacityReader = async () => ({ paidReserveIntact: true, paidWaiting: false });

function storeOver(db: FakeDb, paid: PaidCapacityReader = freePaid) {
  return new SupabaseBridgeStore(db.client(), paid);
}

/** Asserts a rejection that names the table and operation, and never carries the secret or a bad value. */
async function expectStoreError(run: () => Promise<unknown>, table: string, op: string) {
  const error = await run().then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(message).toContain(table);
  expect(message).toContain(op);
  expect(message).not.toContain(SECRET);
}

describe("fake database constraints", () => {
  it("refuses a seed that breaks a foreign key, unless the test asks for an unchecked seed", () => {
    expect(
      () => new FakeDb({ free_sandbox_wakes: [{ org_id: ORG_A, wanted_at: "2026-11-03T00:00:00.000Z" }] }),
    ).toThrow("free_sandbox_wakes.org_id references a missing row");
    expect(
      () => new FakeDb({ free_sandbox_wakes: [{ org_id: ORG_A, wanted_at: "2026-11-03T00:00:00.000Z" }] }, false),
    ).not.toThrow();
  });

  it("the database refuses a pool server with a malformed id, and a placement on a missing server", async () => {
    const db = new FakeDb(pools());
    const badId = await db.client().from("free_sandbox_pool_servers").upsert(pool("Bad Id"), { onConflict: "id" });
    expect(badId.error).toBeTruthy();
    const missing = await db
      .client()
      .from("free_sandbox_placements")
      .upsert(placementRow({ server_id: "pool-9" }), { onConflict: "org_id" });
    expect(missing.error).toBeTruthy();
    expect(db.tables.free_sandbox_pool_servers.map((row) => row.id)).toEqual(["pool-1", "pool-2"]);
    expect(db.tables.free_sandbox_placements).toEqual([]);
  });
});

describe("SupabaseBridgeStore.servers", () => {
  it("returns only enabled pool servers, by id, with their cpus and the paid side's capacity", async () => {
    const db = new FakeDb({
      free_sandbox_pool_servers: [
        pool("pool-2", { cpus: 8 }),
        pool("pool-1", { cpus: "4" }),
        pool("off", { enabled: false }),
      ],
    });
    const seen: string[] = [];
    const store = storeOver(db, async (serverId) => {
      seen.push(serverId);
      return { paidReserveIntact: serverId === "pool-1", paidWaiting: serverId === "pool-2" };
    });
    expect(await store.servers()).toEqual([
      { id: "pool-1", cpus: 4, paidReserveIntact: true, paidWaiting: false },
      { id: "pool-2", cpus: 8, paidReserveIntact: false, paidWaiting: true },
    ]);
    expect(seen.sort()).toEqual(["pool-1", "pool-2"]);
  });

  it("closes a server to Free when its paid read throws, without surfacing the error", async () => {
    const db = new FakeDb(pools());
    const store = storeOver(db, async (serverId) => {
      if (serverId === "pool-1") throw new Error(`paid read leaked ${SECRET}`);
      return { paidReserveIntact: true, paidWaiting: false };
    });
    const servers = await store.servers();
    expect(servers).toEqual([
      { id: "pool-1", cpus: 4, paidReserveIntact: false, paidWaiting: true },
      { id: "pool-2", cpus: 4, paidReserveIntact: true, paidWaiting: false },
    ]);
    expect(JSON.stringify(servers)).not.toContain(SECRET);
  });

  it("refuses a pool row whose cpus is not a positive number, without echoing it", async () => {
    // Unchecked seed: the database's own CHECK would refuse this row, so this tests the store's read guard.
    const db = new FakeDb({ free_sandbox_pool_servers: [pool("pool-1", { cpus: `0-${SECRET}` })] }, false);
    const error = await storeOver(db)
      .servers()
      .then(
        () => null,
        (caught: unknown) => caught as Error,
      );
    expect(error?.message).toContain("cpus");
    expect(error?.message).not.toContain(SECRET);
  });

  it("names the table and operation when the query fails", async () => {
    const db = new FakeDb(pools());
    db.failures.add(`free_sandbox_pool_servers:select`);
    await expectStoreError(() => storeOver(db).servers(), "free_sandbox_pool_servers", "select");
  });
});

describe("SupabaseBridgeStore placements", () => {
  it("returns null for an unknown workspace and maps a stored row to a Placement", async () => {
    const db = new FakeDb(
      world({
        free_sandbox_placements: [
          placementRow({
            state: "packed",
            server_id: null,
            archive_location: LOCATION_A,
            archive_sha256: SHA,
            archive_bytes: "2048",
            machine_id: MACHINE_A,
            problem: "disk full",
          }),
        ],
      }),
    );
    const store = storeOver(db);
    expect(await store.placement(ORG_B)).toBeNull();
    expect(await store.placement(ORG_A)).toEqual({
      orgId: ORG_A,
      sandbox: { sandboxId: SANDBOX_A, computerId: COMPUTER_A, ownerHash: HASH },
      machineId: MACHINE_A,
      serverId: null,
      state: "packed",
      placedAt: new Date("2026-11-01T00:00:00.000Z"),
      stateAt: new Date("2026-11-02T00:00:00.000Z"),
      archive: COPY_A,
      problem: "disk full",
    });
  });

  it("lists every placement, oldest first", async () => {
    const db = new FakeDb(
      world({
        free_sandbox_placements: [
          placementRow({
            org_id: ORG_B,
            sandbox_id: SANDBOX_B,
            computer_id: COMPUTER_B,
            placed_at: "2026-11-05T00:00:00.000Z",
          }),
          placementRow(),
        ],
      }),
    );
    const list = await storeOver(db).placements();
    expect(list.map((p) => p.orgId)).toEqual([ORG_A, ORG_B]);
  });

  it("saves a new placement, then replaces the same workspace's row on the next save", async () => {
    const db = new FakeDb(pools());
    const store = storeOver(db);
    await store.save(placement());
    await store.save(placement({ state: "stopped", serverId: "pool-2", problem: null }));
    const rows = db.tables.free_sandbox_placements;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      org_id: ORG_A,
      state: "stopped",
      server_id: "pool-2",
      placed_at: "2026-11-01T00:00:00.000Z",
    });
    expect(await store.placement(ORG_A)).toMatchObject({ state: "stopped", serverId: "pool-2" });
  });

  it("writes the archive as three columns and a packed placement with no server", async () => {
    const db = new FakeDb(pools());
    await storeOver(db).save(placement({ state: "packed", serverId: null, archive: COPY_NEW }));
    expect(db.tables.free_sandbox_placements[0]).toMatchObject({
      server_id: null,
      archive_location: LOCATION_NEW,
      archive_sha256: OTHER_SHA,
      archive_bytes: 7,
    });
  });

  it("keeps the stored copy when a save carries none, so no save can clear an archive", async () => {
    const db = new FakeDb(
      world({
        free_sandbox_placements: [
          placementRow({
            state: "packed",
            server_id: null,
            archive_location: LOCATION_A,
            archive_sha256: SHA,
            archive_bytes: 2048,
          }),
        ],
      }),
    );
    const store = storeOver(db);
    await store.save(placement({ state: "restoring", serverId: "pool-1", archive: null }));
    expect(db.tables.free_sandbox_placements[0]).toMatchObject({
      state: "restoring",
      archive_location: LOCATION_A,
      archive_sha256: SHA,
      archive_bytes: 2048,
    });
    expect(await store.placement(ORG_A)).toMatchObject({ state: "restoring", archive: COPY_A });
  });

  it("replaces the stored copy only with a new copy", async () => {
    const db = new FakeDb(
      world({
        free_sandbox_placements: [
          placementRow({
            state: "packed",
            server_id: null,
            archive_location: LOCATION_A,
            archive_sha256: SHA,
            archive_bytes: 2048,
          }),
        ],
      }),
    );
    await storeOver(db).save(placement({ state: "packed", serverId: null, archive: COPY_NEW }));
    expect(await storeOver(db).placement(ORG_A)).toMatchObject({ archive: COPY_NEW });
  });

  it("removes a workspace's placement", async () => {
    const db = new FakeDb(
      world({
        free_sandbox_placements: [
          placementRow(),
          placementRow({ org_id: ORG_B, sandbox_id: SANDBOX_B, computer_id: COMPUTER_B }),
        ],
      }),
    );
    await storeOver(db).remove(ORG_A);
    expect(db.tables.free_sandbox_placements.map((row) => row.org_id)).toEqual([ORG_B]);
  });

  it("refuses a save onto a pool server that is not in the pool table", async () => {
    const db = new FakeDb(pools());
    const store = storeOver(db);
    await expectStoreError(() => store.save(placement({ serverId: "pool-9" })), "free_sandbox_placements", "upsert");
    expect(db.tables.free_sandbox_placements).toEqual([]);
  });

  it("refuses a packed placement with no stored copy, and a packed placement that still has a server", async () => {
    const db = new FakeDb(pools());
    const store = storeOver(db);
    await expectStoreError(
      () => store.save(placement({ state: "packed", serverId: null, archive: null })),
      "free_sandbox_placements",
      "upsert",
    );
    await expectStoreError(
      () => store.save(placement({ state: "packed", serverId: "pool-1", archive: COPY_A })),
      "free_sandbox_placements",
      "upsert",
    );
    expect(db.tables.free_sandbox_placements).toEqual([]);
  });

  it("the database refuses a partial archive, and leaves the row as it was", async () => {
    const db = new FakeDb(world());
    const partial = await db
      .client()
      .from("free_sandbox_placements")
      .upsert(placementRow({ archive_sha256: SHA }), { onConflict: "org_id" });
    expect(partial.error).toBeTruthy();
    expect(db.tables.free_sandbox_placements[0]).toMatchObject({ archive_sha256: null, archive_location: null });
  });

  it("refuses an archive size that is not a safe non-negative integer, before any query", async () => {
    const db = new FakeDb(pools());
    const store = storeOver(db);
    for (const bytes of [-1, 1.5, Number.MAX_SAFE_INTEGER + 2, Number.NaN]) {
      await expect(store.save(placement({ archive: { ...COPY_A, bytes } }))).rejects.toThrow("invalid archive size");
    }
    expect(db.log).toEqual([]);
  });

  it("refuses an archive location the archive store would not write, and a digest that is not the location's", async () => {
    const db = new FakeDb(pools());
    const store = storeOver(db);
    await expect(store.save(placement({ archive: { ...COPY_A, location: "archive://example/one" } }))).rejects.toThrow(
      "invalid archive location",
    );
    await expect(store.save(placement({ archive: { ...COPY_A, sha256: OTHER_SHA } }))).rejects.toThrow(
      "invalid archive digest",
    );
    expect(db.log).toEqual([]);
  });

  it("refuses a workspace id that is not a UUID without querying, and does not echo it", async () => {
    const db = new FakeDb(pools());
    const store = storeOver(db);
    const error = await store.placement(`org-${SECRET}`).then(
      () => null,
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toBe("free sandbox store: invalid org id");
    await expect(store.remove(`org-${SECRET}`)).rejects.not.toThrow(SECRET);
    expect(db.log).toEqual([]);
  });

  it("refuses a malformed id or digest before any query, and does not echo it", async () => {
    const db = new FakeDb(pools());
    const store = storeOver(db);
    const bad = placement({ sandbox: { sandboxId: `not-a-uuid-${SECRET}`, computerId: COMPUTER_A, ownerHash: HASH } });
    await expect(store.save(bad)).rejects.toThrow("invalid sandbox id");
    await expect(store.save(bad)).rejects.not.toThrow(SECRET);
    await expect(store.save(placement({ archive: { location: LOCATION_A, sha256: "zz", bytes: 1 } }))).rejects.toThrow(
      "invalid archive digest",
    );
    expect(db.log).toEqual([]);
  });

  it("names the table and operation on a failed read, write or delete, and never the database message", async () => {
    const db = new FakeDb(world());
    const store = storeOver(db);
    db.failures.add("free_sandbox_placements:select");
    await expectStoreError(() => store.placement(ORG_A), "free_sandbox_placements", "select");
    await expectStoreError(() => store.placements(), "free_sandbox_placements", "select");
    db.failures.add("free_sandbox_placements:upsert");
    await expectStoreError(() => store.save(placement()), "free_sandbox_placements", "upsert");
    db.failures.add("free_sandbox_placements:delete");
    await expectStoreError(() => store.remove(ORG_A), "free_sandbox_placements", "delete");
  });

  it("refuses a stored timestamp that is not a timestamp, without echoing it", async () => {
    // Unchecked seed: the database's own CHECK would refuse this row, so this tests the store's read guard.
    const db = new FakeDb({ free_sandbox_placements: [placementRow({ placed_at: `soon-${SECRET}` })] }, false);
    const error = await storeOver(db)
      .placement(ORG_A)
      .then(
        () => null,
        (caught: unknown) => caught as Error,
      );
    expect(error?.message).toContain("placed_at");
    expect(error?.message).not.toContain(SECRET);
  });

  it("refuses a stored state the bridge does not know", async () => {
    // Unchecked seed: the database's own CHECK would refuse this row, so this tests the store's read guard.
    const db = new FakeDb({ free_sandbox_placements: [placementRow({ state: "exploded" })] }, false);
    await expect(storeOver(db).placement(ORG_A)).rejects.toThrow("state is not a known state");
  });

  it("refuses a stored archive whose columns are only partly set", async () => {
    // Unchecked seed: the database's own CHECK would refuse this row, so this tests the store's read guard.
    const db = new FakeDb(
      {
        free_sandbox_pool_servers: pools().free_sandbox_pool_servers,
        free_sandbox_placements: [placementRow({ archive_location: LOCATION_A })],
      },
      false,
    );
    await expect(storeOver(db).placement(ORG_A)).rejects.toThrow("archive columns are partial");
  });
});

describe("SupabaseBridgeStore cursor", () => {
  it("is null until stored, then round-trips, and can be cleared", async () => {
    const db = new FakeDb();
    const store = storeOver(db);
    expect(await store.cursor()).toBeNull();
    await store.setCursor("evt_100");
    expect(await store.cursor()).toBe("evt_100");
    await store.setCursor("evt_200");
    expect(db.tables.free_sandbox_state).toHaveLength(1);
    expect(await store.cursor()).toBe("evt_200");
    await store.setCursor(null);
    expect(await store.cursor()).toBeNull();
  });

  it("names the table on a failed cursor read or write", async () => {
    const db = new FakeDb();
    db.failures.add("free_sandbox_state:select");
    await expectStoreError(() => storeOver(db).cursor(), "free_sandbox_state", "select");
    db.failures.add("free_sandbox_state:upsert");
    await expectStoreError(() => storeOver(db).setCursor("x"), "free_sandbox_state", "upsert");
  });
});

describe("SupabaseBridgeStore wakes", () => {
  it("lists wakes oldest first, and removes them", async () => {
    const db = new FakeDb(
      world({
        free_sandbox_placements: [
          placementRow(),
          placementRow({ org_id: ORG_B, sandbox_id: SANDBOX_B, computer_id: COMPUTER_B }),
        ],
        free_sandbox_wakes: [
          { org_id: ORG_B, wanted_at: "2026-11-09T00:00:00.000Z" },
          { org_id: ORG_A, wanted_at: "2026-11-03T00:00:00.000Z" },
        ],
      }),
    );
    const store = storeOver(db);
    expect(await store.wakes()).toEqual([
      { orgId: ORG_A, wantedAt: new Date("2026-11-03T00:00:00.000Z") },
      { orgId: ORG_B, wantedAt: new Date("2026-11-09T00:00:00.000Z") },
    ]);
    await store.removeWake(ORG_A);
    expect((await store.wakes()).map((wake) => wake.orgId)).toEqual([ORG_B]);
  });

  it("keeps the first wanted time when a workspace wakes again", async () => {
    const db = new FakeDb(world());
    const store = storeOver(db);
    await store.addWake(ORG_A, new Date("2026-11-03T00:00:00.000Z"));
    await store.addWake(ORG_A, new Date("2026-11-08T00:00:00.000Z"));
    expect(await store.wakes()).toEqual([{ orgId: ORG_A, wantedAt: new Date("2026-11-03T00:00:00.000Z") }]);
  });

  it("refuses a wake for a workspace with no placement (the foreign key)", async () => {
    const db = new FakeDb(world({ free_sandbox_placements: [] }));
    await expectStoreError(() => storeOver(db).addWake(ORG_A, new Date()), "free_sandbox_wakes", "upsert");
    expect(db.tables.free_sandbox_wakes).toEqual([]);
  });

  it("removes a wake with its placement, by the table's cascade", async () => {
    const db = new FakeDb(world({ free_sandbox_wakes: [{ org_id: ORG_A, wanted_at: "2026-11-03T00:00:00.000Z" }] }));
    await storeOver(db).remove(ORG_A);
    expect(db.tables.free_sandbox_wakes).toEqual([]);
  });

  it("refuses an invalid wake time without querying", async () => {
    const db = new FakeDb(world());
    await expect(storeOver(db).addWake(ORG_A, new Date("nope"))).rejects.toThrow("invalid wake time");
    expect(db.log).toEqual([]);
  });

  it("names the table on a failed wake write", async () => {
    const db = new FakeDb(world());
    db.failures.add("free_sandbox_wakes:upsert");
    await expectStoreError(() => storeOver(db).addWake(ORG_A, new Date()), "free_sandbox_wakes", "upsert");
  });
});

describe("SupabaseBridgeStore AI counts", () => {
  it("reads zeros for a day with no counts, then the counts once they exist", async () => {
    const db = new FakeDb(world());
    const store = storeOver(db);
    expect(await store.aiDay("pool-1", DAY)).toEqual({ answered: 0, refused: 0, failed: 0 });
    await store.countAi("pool-1", DAY, "answered");
    await store.countAi("pool-1", DAY, "answered");
    await store.countAi("pool-1", DAY, "refused");
    await store.countAi("pool-1", DAY, "failed");
    expect(await store.aiDay("pool-1", DAY)).toEqual({ answered: 2, refused: 1, failed: 1 });
    expect(db.tables.free_sandbox_ai_days).toHaveLength(1);
  });

  it("keeps each server's and each day's counts apart", async () => {
    const db = new FakeDb(world());
    const store = storeOver(db);
    await store.countAi("pool-1", DAY, "answered");
    await store.countAi("pool-2", DAY, "answered");
    await store.countAi("pool-1", "2026-11-18", "answered");
    expect(await store.aiDay("pool-1", DAY)).toEqual({ answered: 1, refused: 0, failed: 0 });
    expect(await store.aiDay("pool-2", DAY)).toEqual({ answered: 1, refused: 0, failed: 0 });
    expect(await store.aiDay("pool-1", "2026-11-18")).toEqual({ answered: 1, refused: 0, failed: 0 });
  });

  it("retries a count when another writer moved the value between its read and its update", async () => {
    const db = new FakeDb(
      world({ free_sandbox_ai_days: [{ server_id: "pool-1", day: DAY, answered: 2, refused: 0, failed: 0 }] }),
    );
    let raced = false;
    db.hooks.beforeExecute = (table, op, fake) => {
      if (table === "free_sandbox_ai_days" && op === "update" && !raced) {
        raced = true;
        const row = fake.tables.free_sandbox_ai_days[0];
        row.answered = (row.answered as number) + 1;
      }
    };
    await storeOver(db).countAi("pool-1", DAY, "answered");
    expect(raced).toBe(true);
    // The other writer's +1 and this count's +1 both land: 2 -> 3 (other) -> 4 (this count, on a fresh read).
    expect(await storeOver(db).aiDay("pool-1", DAY)).toEqual({ answered: 4, refused: 0, failed: 0 });
    expect(db.log.filter((entry) => entry === "update free_sandbox_ai_days")).toHaveLength(2);
  });

  it("creates the day's row when another writer created it first, then counts onto it", async () => {
    const db = new FakeDb(world());
    let raced = false;
    db.hooks.beforeExecute = (table, op, fake) => {
      if (table === "free_sandbox_ai_days" && op === "upsert" && !raced) {
        raced = true;
        fake.tables.free_sandbox_ai_days.push({ server_id: "pool-1", day: DAY, answered: 5, refused: 0, failed: 0 });
      }
    };
    await storeOver(db).countAi("pool-1", DAY, "answered");
    expect(await storeOver(db).aiDay("pool-1", DAY)).toEqual({ answered: 6, refused: 0, failed: 0 });
  });

  it("throws, without the counts, when the value keeps moving and the bounded retries run out", async () => {
    const db = new FakeDb(
      world({ free_sandbox_ai_days: [{ server_id: "pool-1", day: DAY, answered: 0, refused: 0, failed: 0 }] }),
    );
    db.hooks.beforeExecute = (table, op, fake) => {
      if (table === "free_sandbox_ai_days" && op === "update") {
        const row = fake.tables.free_sandbox_ai_days[0];
        row.answered = (row.answered as number) + 1;
      }
    };
    const error = await storeOver(db)
      .countAi("pool-1", DAY, "answered")
      .then(
        () => null,
        (caught: unknown) => caught as Error,
      );
    expect(error?.message).toContain("did not settle");
    expect(db.log.filter((entry) => entry === "update free_sandbox_ai_days")).toHaveLength(5);
  });

  it("refuses a count for a server that is not in the pool table (the foreign key)", async () => {
    const db = new FakeDb(world());
    await expectStoreError(() => storeOver(db).countAi("pool-9", DAY, "answered"), "free_sandbox_ai_days", "upsert");
    expect(db.tables.free_sandbox_ai_days).toEqual([]);
  });

  it("refuses a bad server id, day or reply kind before querying, without echoing it", async () => {
    const db = new FakeDb(world());
    const store = storeOver(db);
    await expect(store.countAi(`Bad ${SECRET}`, DAY, "answered")).rejects.toThrow("invalid server id");
    await expect(store.countAi("pool-1", `2026/11/17 ${SECRET}`, "answered")).rejects.toThrow("invalid day");
    await expect(store.countAi("pool-1", DAY, `answered; drop ${SECRET}` as "answered")).rejects.toThrow(
      "invalid AI reply kind",
    );
    await expect(store.aiDay(`Bad ${SECRET}`, DAY)).rejects.not.toThrow(SECRET);
    expect(db.log).toEqual([]);
  });

  it("names the table and operation when a count query fails", async () => {
    const db = new FakeDb(world());
    db.failures.add("free_sandbox_ai_days:select");
    await expectStoreError(() => storeOver(db).countAi("pool-1", DAY, "answered"), "free_sandbox_ai_days", "select");
    await expectStoreError(() => storeOver(db).aiDay("pool-1", DAY), "free_sandbox_ai_days", "select");
  });
});

describe("SupabaseBridgeStore AI refusal horizon", () => {
  it("is null until set, then reads back the stored time", async () => {
    const db = new FakeDb(world());
    const store = storeOver(db);
    expect(await store.aiRefusedUntil("pool-1")).toBeNull();
    const until = new Date("2026-11-18T00:00:00.000Z");
    await store.setAiRefusedUntil("pool-1", until);
    expect(await store.aiRefusedUntil("pool-1")).toEqual(until);
  });

  it("refuses to record a refusal for a server that is not in the pool table", async () => {
    const db = new FakeDb(world());
    const error = await storeOver(db)
      .setAiRefusedUntil("pool-9", new Date())
      .then(
        () => null,
        (caught: unknown) => caught as Error,
      );
    expect(error?.message).toContain("matched no server");
    expect(db.tables.free_sandbox_pool_servers).toHaveLength(2);
  });

  it("names the table and operation on a failed read or write", async () => {
    const db = new FakeDb(world());
    db.failures.add("free_sandbox_pool_servers:select");
    await expectStoreError(() => storeOver(db).aiRefusedUntil("pool-1"), "free_sandbox_pool_servers", "select");
    db.failures.add("free_sandbox_pool_servers:update");
    await expectStoreError(
      () => storeOver(db).setAiRefusedUntil("pool-1", new Date()),
      "free_sandbox_pool_servers",
      "update",
    );
  });

  it("refuses a bad server id without querying", async () => {
    const db = new FakeDb(world());
    await expect(storeOver(db).aiRefusedUntil(`x/${SECRET}`)).rejects.toThrow("invalid server id");
    expect(db.log).toEqual([]);
  });
});

describe("SupabaseBridgeStore waitlist", () => {
  it("adds, keeps the first waiting time on a repeat, lists oldest first, and removes", async () => {
    const db = new FakeDb(
      world({ free_sandbox_waitlist: [{ org_id: ORG_B, waiting_at: "2000-01-01T00:00:00.000Z" }] }),
    );
    const store = storeOver(db);
    await store.setWaitlisted(ORG_A, true);
    expect(await store.waitlist()).toEqual([ORG_B, ORG_A]);
    await store.setWaitlisted(ORG_B, true);
    expect(db.tables.free_sandbox_waitlist.find((row) => row.org_id === ORG_B)?.waiting_at).toBe(
      "2000-01-01T00:00:00.000Z",
    );
    await store.setWaitlisted(ORG_B, false);
    expect(await store.waitlist()).toEqual([ORG_A]);
  });

  it("names the table on a failed waitlist write, and refuses a bad org id", async () => {
    const db = new FakeDb(world());
    db.failures.add("free_sandbox_waitlist:upsert");
    await expectStoreError(() => storeOver(db).setWaitlisted(ORG_A, true), "free_sandbox_waitlist", "upsert");
    await expect(storeOver(db).setWaitlisted(`bad-${SECRET}`, true)).rejects.not.toThrow(SECRET);
  });
});

describe("SupabaseBridgeStore pending erasures", () => {
  it("lists queued copies oldest first, keeps the first queue time on a repeat, and removes one", async () => {
    const db = new FakeDb({
      free_sandbox_pending_erasures: [
        { location: LOCATION_NEW, sha256: OTHER_SHA, bytes: 7, added_at: "2026-11-09T00:00:00.000Z" },
        { location: LOCATION_A, sha256: SHA, bytes: "2048", added_at: "2026-11-03T00:00:00.000Z" },
      ],
    });
    const store = storeOver(db);
    expect(await store.pendingErasures()).toEqual([COPY_A, COPY_NEW]);
    await store.addPendingErasure(COPY_A);
    expect(db.tables.free_sandbox_pending_erasures).toHaveLength(2);
    expect(db.tables.free_sandbox_pending_erasures.find((row) => row.location === LOCATION_A)?.added_at).toBe(
      "2026-11-03T00:00:00.000Z",
    );
    await store.removePendingErasure(LOCATION_A);
    expect(await store.pendingErasures()).toEqual([COPY_NEW]);
  });

  it("queues a copy with its size and a queue time", async () => {
    const db = new FakeDb();
    const store = storeOver(db);
    await store.addPendingErasure(COPY_A);
    expect(db.tables.free_sandbox_pending_erasures).toEqual([
      { location: LOCATION_A, sha256: SHA, bytes: 2048, added_at: expect.any(String) },
    ]);
    expect(await store.pendingErasures()).toEqual([COPY_A]);
  });

  it("refuses an invalid copy or location before any query", async () => {
    const db = new FakeDb();
    const store = storeOver(db);
    await expect(store.addPendingErasure({ ...COPY_A, location: `x/${SECRET}` })).rejects.toThrow(
      "invalid archive location",
    );
    await expect(store.addPendingErasure({ ...COPY_A, bytes: -1 })).rejects.toThrow("invalid archive size");
    await expect(store.addPendingErasure({ ...COPY_A, sha256: OTHER_SHA })).rejects.toThrow("invalid archive digest");
    await expect(store.removePendingErasure(`archive://${SECRET}`)).rejects.not.toThrow(SECRET);
    await expect(store.removePendingErasure("archive://example/one")).rejects.toThrow("invalid archive location");
    expect(db.log).toEqual([]);
  });

  it("refuses a stored queue row that is not a valid copy", async () => {
    // Unchecked seed: the database's own rule would refuse this row, so this tests the store's read guard.
    const db = new FakeDb(
      {
        free_sandbox_pending_erasures: [
          { location: "archive://example/one", sha256: SHA, bytes: 1, added_at: "2026-11-03T00:00:00.000Z" },
        ],
      },
      false,
    );
    await expect(storeOver(db).pendingErasures()).rejects.toThrow("invalid archive location");
  });

  it("names the table and operation on a failed read, write or delete", async () => {
    const db = new FakeDb();
    const store = storeOver(db);
    db.failures.add("free_sandbox_pending_erasures:select");
    await expectStoreError(() => store.pendingErasures(), "free_sandbox_pending_erasures", "select");
    db.failures.add("free_sandbox_pending_erasures:upsert");
    await expectStoreError(() => store.addPendingErasure(COPY_A), "free_sandbox_pending_erasures", "upsert");
    db.failures.add("free_sandbox_pending_erasures:delete");
    await expectStoreError(() => store.removePendingErasure(LOCATION_A), "free_sandbox_pending_erasures", "delete");
  });
});
