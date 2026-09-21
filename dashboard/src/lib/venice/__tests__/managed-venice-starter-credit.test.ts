import {
  grantManagedVeniceStarterCredit,
  isManagedVeniceStarterCreditEnabled,
  getManagedVeniceStarterCreditMicroUsd,
  managedVeniceStarterGrantReference,
  MANAGED_VENICE_STARTER_GRANT_REFERENCE,
} from "../managed-venice-starter-credit";

// The risk-assessment repository is the abuse gate input. Mock it per-test.
const getRiskAssessment = jest.fn();
jest.mock("@/lib/abuse/repository", () => ({
  getRiskAssessment: (...args: unknown[]) => getRiskAssessment(...args),
}));

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

// Keep supabaseAdmin importable but unused — every call passes an explicit db.
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));

type Row = Record<string, unknown>;
type DbError = { message?: string; code?: string };

/**
 * The REAL unique indexes these tables carry in prod. The card-ledger one is
 * the whole reason for the global-cap bug: it has NO user_id, so a constant
 * reference_id could only ever admit one row for the entire system.
 *
 *   managed_venice_card_ledger_entri_source_reference_id_reason_key
 *     UNIQUE (source, reference_id, reason)
 *   managed_venice_financial_events_idempotency_idx
 *     UNIQUE (idempotency_key)
 *
 * Modelling them here is load-bearing: without the ledger unique index the
 * two-distinct-users regression test below would pass even against the buggy
 * constant-reference code.
 */
const UNIQUE_INDEXES: Record<string, { name: string; columns: string[] }> = {
  managed_venice_card_ledger_entries: {
    name: "managed_venice_card_ledger_entri_source_reference_id_reason_key",
    columns: ["source", "reference_id", "reason"],
  },
  managed_venice_financial_events: {
    name: "managed_venice_financial_events_idempotency_idx",
    columns: ["idempotency_key"],
  },
};

// Minimal in-memory Supabase double covering the tables the grant touches:
//   managed_venice_wallet_accounts (ensureManagedVeniceWalletAccount upsert/select)
//   managed_venice_card_ledger_entries (dedupe select + insert)
//   managed_venice_financial_events (append: idempotency select + insert)
function createMemoryDb(options: { insertErrors?: Record<string, DbError> } = {}) {
  const tables: Record<string, Row[]> = {
    managed_venice_wallet_accounts: [],
    managed_venice_card_ledger_entries: [],
    managed_venice_financial_events: [],
  };

  /** Emulate the table's unique index; returns a Postgres 23505 or null. */
  function uniqueViolation(name: string, row: Row): DbError | null {
    const index = UNIQUE_INDEXES[name];
    if (!index) return null;
    const clash = tables[name].some((existing) =>
      index.columns.every((column) => existing[column] === row[column])
    );
    if (!clash) return null;
    return {
      code: "23505",
      message: `duplicate key value violates unique constraint "${index.name}"`,
    };
  }

  function insertRow(name: string, row: Row) {
    const stored = {
      id: row.id ?? `${name}_${tables[name].length + 1}`,
      created_at: row.created_at ?? new Date(2026, 5, tables[name].length + 1).toISOString(),
      ...row,
    };
    tables[name].push(stored);
    return stored;
  }

  /** Seed a pre-existing row, bypassing the insert path (fixtures only). */
  function seed(name: string, row: Row) {
    return insertRow(name, row);
  }

  function makeSelect(rows: Row[]) {
    const eqFilters: Array<[string, unknown]> = [];
    const inFilters: Array<[string, unknown[]]> = [];
    let limitCount = Number.POSITIVE_INFINITY;

    function matched() {
      return rows
        .filter(
          (row) =>
            eqFilters.every(([column, value]) => row[column] === value) &&
            inFilters.every(([column, values]) => values.includes(row[column]))
        )
        .slice(0, limitCount);
    }

    const chain = {
      eq(column: string, value: unknown) {
        eqFilters.push([column, value]);
        return chain;
      },
      in(column: string, values: readonly unknown[]) {
        inFilters.push([column, [...values]]);
        return chain;
      },
      limit(count: number) {
        limitCount = count;
        return chain;
      },
      async maybeSingle() {
        const found = matched();
        // PostgREST's maybeSingle() errors when the filter matches >1 row.
        if (found.length > 1) {
          return {
            data: null,
            error: { code: "PGRST116", message: "multiple rows returned" },
          };
        }
        return { data: found[0] ?? null, error: null };
      },
      async single() {
        const found = matched();
        return { data: found[0] ?? null, error: null };
      },
    };
    return chain;
  }

  function table(name: string) {
    const rows = tables[name];
    if (!rows) throw new Error(`Unexpected table ${name}`);
    return {
      insert(row: Row) {
        const injected = options.insertErrors?.[name] ?? null;
        const error = injected ?? uniqueViolation(name, row);
        if (error) {
          return {
            select: () => ({ single: async () => ({ data: null, error }) }),
            then: (
              resolve: (value: { data: null; error: DbError }) => unknown,
              reject?: (reason: unknown) => unknown
            ) => Promise.resolve({ data: null, error }).then(resolve, reject),
          };
        }
        const stored = insertRow(name, row);
        return {
          select: () => ({ single: async () => ({ data: stored, error: null }) }),
          then: (
            resolve: (value: { data: Row; error: null }) => unknown,
            reject?: (reason: unknown) => unknown
          ) => Promise.resolve({ data: stored, error: null }).then(resolve, reject),
        };
      },
      upsert(row: Row, upsertOptions?: { onConflict?: string }) {
        const conflictColumns = (upsertOptions?.onConflict || "id")
          .split(",")
          .map((column) => column.trim());
        const existing = rows.find((candidate) =>
          conflictColumns.every((column) => candidate[column] === row[column])
        );
        const stored = existing ? Object.assign(existing, row) : insertRow(name, row);
        return { select: () => ({ single: async () => ({ data: stored, error: null }) }) };
      },
      select: () => makeSelect(rows),
    };
  }

  return { db: { from: table }, tables, seed };
}

/** Fixture: a ledger row exactly as the grant path (or an ops backfill) wrote it. */
function starterLedgerRow(userId: string, referenceId: string): Row {
  return {
    account_id: "acct_legacy",
    user_id: userId,
    amount_micro_usd: 500_000,
    source: "system",
    actor: "managed_venice_starter_grant",
    reason: "admin_adjustment",
    reference_id: referenceId,
    metadata: { grant: "managed_venice_starter" },
  };
}

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.clearAllMocks();
});

describe("managed Venice starter credit — env config", () => {
  it("is OFF by default and ON only for truthy flag values", () => {
    delete process.env.HERMES_MANAGED_VENICE_STARTER_CREDIT_ENABLED;
    expect(isManagedVeniceStarterCreditEnabled()).toBe(false);

    process.env.HERMES_MANAGED_VENICE_STARTER_CREDIT_ENABLED = "true";
    expect(isManagedVeniceStarterCreditEnabled()).toBe(true);

    process.env.HERMES_MANAGED_VENICE_STARTER_CREDIT_ENABLED = "off";
    expect(isManagedVeniceStarterCreditEnabled()).toBe(false);
  });

  it("defaults to $0.50 (500000 microUSD) and honors a valid override", () => {
    delete process.env.HERMES_MANAGED_VENICE_STARTER_CREDIT_MICRO_USD;
    expect(getManagedVeniceStarterCreditMicroUsd()).toBe(500_000);

    process.env.HERMES_MANAGED_VENICE_STARTER_CREDIT_MICRO_USD = "1000000";
    expect(getManagedVeniceStarterCreditMicroUsd()).toBe(1_000_000);

    process.env.HERMES_MANAGED_VENICE_STARTER_CREDIT_MICRO_USD = "-5";
    expect(getManagedVeniceStarterCreditMicroUsd()).toBe(500_000);
  });
});

describe("managed Venice starter credit — grant reference", () => {
  it("is namespaced per user under the shared prefix", () => {
    expect(managedVeniceStarterGrantReference("user_1")).toBe("managed_venice_starter:user_1");
    expect(managedVeniceStarterGrantReference("user_2")).toBe("managed_venice_starter:user_2");
    expect(managedVeniceStarterGrantReference("user_1")).toContain(
      MANAGED_VENICE_STARTER_GRANT_REFERENCE
    );
  });

  it("is byte-stable with the idempotency key every pre-fix event row already carries", () => {
    // The seven starter_grant rows written before this fix all have
    // idempotency_key = 'managed_venice_starter:<userId>'. That table's unique
    // index is on idempotency_key alone, so this string must never change shape
    // or an already-granted user would look ungranted to the event layer.
    expect(managedVeniceStarterGrantReference("user_fixture_existing")).toBe(
      "managed_venice_starter:user_fixture_existing"
    );
  });
});

describe("the in-memory Supabase double", () => {
  it("enforces the card ledger's global unique (source, reference_id, reason)", async () => {
    // Guards the guard: if this ever stops holding, the two-distinct-users
    // regression test below silently stops testing anything.
    const { db } = createMemoryDb();
    type InsertResult = { error: DbError | null };

    const row = starterLedgerRow("user_a", "shared_reference");
    const first = (await db
      .from("managed_venice_card_ledger_entries")
      .insert(row)) as InsertResult;
    expect(first.error).toBeNull();

    // Same (source, reference_id, reason), DIFFERENT user — still a violation.
    const second = (await db
      .from("managed_venice_card_ledger_entries")
      .insert(starterLedgerRow("user_b", "shared_reference"))) as InsertResult;
    expect(second.error).toMatchObject({ code: "23505" });
  });
});

describe("grantManagedVeniceStarterCredit", () => {
  beforeEach(() => {
    process.env.HERMES_MANAGED_VENICE_STARTER_CREDIT_ENABLED = "true";
    delete process.env.HERMES_MANAGED_VENICE_STARTER_CREDIT_MICRO_USD;
    getRiskAssessment.mockResolvedValue(null);
  });

  it("no-ops when the flag is disabled", async () => {
    process.env.HERMES_MANAGED_VENICE_STARTER_CREDIT_ENABLED = "false";
    const { db, tables } = createMemoryDb();
    const result = await grantManagedVeniceStarterCredit({ userId: "user_1" }, db);
    expect(result).toEqual({ granted: false, reason: "flag_disabled" });
    expect(tables.managed_venice_card_ledger_entries).toHaveLength(0);
  });

  it("grants the default $0.50 once and writes a starter_grant financial event", async () => {
    const { db, tables } = createMemoryDb();
    const result = await grantManagedVeniceStarterCredit({ userId: "user_1" }, db);

    expect(result).toEqual({ granted: true, amountMicroUsd: 500_000 });

    const ledger = tables.managed_venice_card_ledger_entries;
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      user_id: "user_1",
      amount_micro_usd: 500_000,
      source: "system",
      reason: "admin_adjustment",
      reference_id: "managed_venice_starter:user_1",
    });

    const events = tables.managed_venice_financial_events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      user_id: "user_1",
      event_type: "starter_grant",
      wallet_type: "card",
      reference_id: "managed_venice_starter:user_1",
      idempotency_key: "managed_venice_starter:user_1",
      amount_micro_usd: 500_000,
    });
  });

  // ── THE BUG ────────────────────────────────────────────────────────────────
  it("REGRESSION: grants to two different users (the constant reference used to cap this at one)", async () => {
    // Before the fix both users wrote reference_id='managed_venice_starter',
    // so user_2's insert tripped the global unique index, was misread as a lost
    // race, and returned already_granted — silently, on a best-effort path.
    const { db, tables } = createMemoryDb();

    const first = await grantManagedVeniceStarterCredit({ userId: "user_1" }, db);
    const second = await grantManagedVeniceStarterCredit({ userId: "user_2" }, db);

    expect(first).toEqual({ granted: true, amountMicroUsd: 500_000 });
    expect(second).toEqual({ granted: true, amountMicroUsd: 500_000 });

    const ledger = tables.managed_venice_card_ledger_entries;
    expect(ledger).toHaveLength(2);
    expect(ledger.map((row) => row.reference_id)).toEqual([
      "managed_venice_starter:user_1",
      "managed_venice_starter:user_2",
    ]);
    expect(tables.managed_venice_financial_events).toHaveLength(2);
  });

  it("REGRESSION: grants to many distinct users without exhausting the unique index", async () => {
    const { db, tables } = createMemoryDb();
    const userIds = ["user_a", "user_b", "user_c", "user_d", "user_e"];

    for (const userId of userIds) {
      const result = await grantManagedVeniceStarterCredit({ userId }, db);
      expect(result).toEqual({ granted: true, amountMicroUsd: 500_000 });
    }

    expect(tables.managed_venice_card_ledger_entries).toHaveLength(userIds.length);
    expect(tables.managed_venice_financial_events).toHaveLength(userIds.length);
  });

  it("grants exactly once per user (second call dedupes on the ledger reference)", async () => {
    const { db, tables } = createMemoryDb();
    const first = await grantManagedVeniceStarterCredit({ userId: "user_1" }, db);
    const second = await grantManagedVeniceStarterCredit({ userId: "user_1" }, db);

    expect(first).toEqual({ granted: true, amountMicroUsd: 500_000 });
    expect(second).toEqual({ granted: false, reason: "already_granted" });
    expect(tables.managed_venice_card_ledger_entries).toHaveLength(1);
    expect(tables.managed_venice_financial_events).toHaveLength(1);
  });

  // ── LEGACY ROWS ────────────────────────────────────────────────────────────
  it("LEGACY: the user holding the bare constant reference receives ZERO additional grants", async () => {
    // Model the historical bare-reference row without exposing a live account identity.
    const legacyUserId = "user_fixture_legacy";
    const { db, tables, seed } = createMemoryDb();
    seed(
      "managed_venice_card_ledger_entries",
      starterLedgerRow(legacyUserId, MANAGED_VENICE_STARTER_GRANT_REFERENCE)
    );

    const result = await grantManagedVeniceStarterCredit({ userId: legacyUserId }, db);

    expect(result).toEqual({ granted: false, reason: "already_granted" });
    expect(tables.managed_venice_card_ledger_entries).toHaveLength(1);
    expect(tables.managed_venice_financial_events).toHaveLength(0);
  });

  it("LEGACY: a backfilled user receives ZERO additional grants", async () => {
    // Historical users were granted by the 2026-06-25 ops backfill under
    // reference_id = 'managed_venice_starter_backfill:<userId>'.
    const backfilledUserId = "user_fixture_backfilled";
    const { db, tables, seed } = createMemoryDb();
    seed(
      "managed_venice_card_ledger_entries",
      starterLedgerRow(backfilledUserId, `managed_venice_starter_backfill:${backfilledUserId}`)
    );

    const result = await grantManagedVeniceStarterCredit({ userId: backfilledUserId }, db);

    expect(result).toEqual({ granted: false, reason: "already_granted" });
    expect(tables.managed_venice_card_ledger_entries).toHaveLength(1);
  });

  it("LEGACY: the legacy constant row does NOT block a different, ungranted user", async () => {
    // The dedupe select is scoped by user_id, so the bare constant can only
    // ever match the one user who holds it. This is the fix's whole point.
    const { db, tables, seed } = createMemoryDb();
    seed(
      "managed_venice_card_ledger_entries",
      starterLedgerRow("user_legacy", MANAGED_VENICE_STARTER_GRANT_REFERENCE)
    );

    const result = await grantManagedVeniceStarterCredit({ userId: "user_fresh" }, db);

    expect(result).toEqual({ granted: true, amountMicroUsd: 500_000 });
    expect(tables.managed_venice_card_ledger_entries).toHaveLength(2);
    expect(tables.managed_venice_card_ledger_entries[1]).toMatchObject({
      user_id: "user_fresh",
      reference_id: "managed_venice_starter:user_fresh",
    });
  });

  it("LEGACY: a user holding BOTH the constant and a backfill row still receives zero grants", async () => {
    // maybeSingle() would error on a 2-row match without the .limit(1).
    const userId = "user_double";
    const { db, tables, seed } = createMemoryDb();
    seed("managed_venice_card_ledger_entries", starterLedgerRow(userId, MANAGED_VENICE_STARTER_GRANT_REFERENCE));
    seed(
      "managed_venice_card_ledger_entries",
      starterLedgerRow(userId, `managed_venice_starter_backfill:${userId}`)
    );

    const result = await grantManagedVeniceStarterCredit({ userId }, db);

    expect(result).toEqual({ granted: false, reason: "already_granted" });
    expect(tables.managed_venice_card_ledger_entries).toHaveLength(2);
  });

  it("LEGACY: an existing starter_grant event is not duplicated by the event layer", async () => {
    // Defence in depth: even if the ledger row were missing, the financial
    // event's unique idempotency_key returns the existing row rather than
    // double-writing the audit trail.
    const userId = "user_event_only";
    const { db, tables, seed } = createMemoryDb();
    seed("managed_venice_financial_events", {
      user_id: userId,
      account_id: "acct_legacy",
      wallet_type: "card",
      event_type: "starter_grant",
      reference_id: MANAGED_VENICE_STARTER_GRANT_REFERENCE,
      idempotency_key: `managed_venice_starter:${userId}`,
      amount_micro_usd: 500_000,
      venice_cost_micro_usd: 0,
      discount_micro_usd: 0,
    });

    const result = await grantManagedVeniceStarterCredit({ userId }, db);

    expect(result).toEqual({ granted: true, amountMicroUsd: 500_000 });
    expect(tables.managed_venice_financial_events).toHaveLength(1);
  });

  // ── ABUSE GATE ─────────────────────────────────────────────────────────────
  it("refuses when the abuse assessment is a hard block", async () => {
    getRiskAssessment.mockResolvedValue({
      decision: "block",
      card_satisfied_at: null,
    });
    const { db, tables } = createMemoryDb();
    const result = await grantManagedVeniceStarterCredit({ userId: "bad_user" }, db);
    expect(result).toEqual({ granted: false, reason: "abuse_blocked" });
    expect(tables.managed_venice_card_ledger_entries).toHaveLength(0);
    expect(tables.managed_venice_financial_events).toHaveLength(0);
  });

  it("refuses when the assessment requires a card and none is on file", async () => {
    getRiskAssessment.mockResolvedValue({
      decision: "require_card",
      card_satisfied_at: null,
    });
    const { db, tables } = createMemoryDb();
    const result = await grantManagedVeniceStarterCredit({ userId: "needs_card" }, db);
    expect(result).toEqual({ granted: false, reason: "abuse_blocked" });
    expect(tables.managed_venice_card_ledger_entries).toHaveLength(0);
  });

  it("still refuses a blocked user even though the reference is now per-user", async () => {
    // The per-user reference must not turn the abuse gate into a no-op.
    getRiskAssessment.mockResolvedValue({ decision: "block", card_satisfied_at: null });
    const { db, tables } = createMemoryDb();

    await grantManagedVeniceStarterCredit({ userId: "bad_1" }, db);
    await grantManagedVeniceStarterCredit({ userId: "bad_2" }, db);

    expect(tables.managed_venice_card_ledger_entries).toHaveLength(0);
  });

  it("grants when require_card is satisfied by a card on file", async () => {
    getRiskAssessment.mockResolvedValue({
      decision: "require_card",
      card_satisfied_at: "2026-06-01T00:00:00.000Z",
    });
    const { db } = createMemoryDb();
    const result = await grantManagedVeniceStarterCredit({ userId: "carded" }, db);
    expect(result).toEqual({ granted: true, amountMicroUsd: 500_000 });
  });

  // ── BEST-EFFORT: never throw into the deploy hot path ──────────────────────
  it("returns db_unavailable (never throws) when no client is provided", async () => {
    const result = await grantManagedVeniceStarterCredit({ userId: "user_1" }, null);
    expect(result).toEqual({ granted: false, reason: "db_unavailable" });
  });

  it("swallows a ledger insert failure — never throws into deploy", async () => {
    const { db, tables } = createMemoryDb({
      insertErrors: { managed_venice_card_ledger_entries: { message: "ledger unavailable" } },
    });

    const result = await grantManagedVeniceStarterCredit({ userId: "user_1" }, db);

    expect(result).toEqual({ granted: false, reason: "error" });
    expect(tables.managed_venice_card_ledger_entries).toHaveLength(0);
    expect(tables.managed_venice_financial_events).toHaveLength(0);
  });

  it("swallows a financial-event failure — never throws into deploy", async () => {
    const { db, tables } = createMemoryDb({
      insertErrors: { managed_venice_financial_events: { message: "events unavailable" } },
    });

    const result = await grantManagedVeniceStarterCredit({ userId: "user_1" }, db);

    expect(result).toEqual({ granted: false, reason: "error" });
    // The ledger row (the money) landed before the event (the audit trail)
    // failed. The next deploy dedupes on it, so the user is not double-granted.
    expect(tables.managed_venice_card_ledger_entries).toHaveLength(1);
    expect(tables.managed_venice_financial_events).toHaveLength(0);
  });

  it("reads a lost insert race as already_granted, not as an error", async () => {
    // reference_id embeds the userId, so a 23505 here can only mean a concurrent
    // deploy already granted THIS user.
    const { db } = createMemoryDb({
      insertErrors: {
        managed_venice_card_ledger_entries: {
          code: "23505",
          message:
            'duplicate key value violates unique constraint "managed_venice_card_ledger_entri_source_reference_id_reason_key"',
        },
      },
    });

    const result = await grantManagedVeniceStarterCredit({ userId: "user_racing" }, db);

    expect(result).toEqual({ granted: false, reason: "already_granted" });
  });

  it("rejects a blank user id without touching the ledger", async () => {
    const { db, tables } = createMemoryDb();
    const result = await grantManagedVeniceStarterCredit({ userId: "   " }, db);
    expect(result).toEqual({ granted: false, reason: "error" });
    expect(tables.managed_venice_card_ledger_entries).toHaveLength(0);
  });
});
