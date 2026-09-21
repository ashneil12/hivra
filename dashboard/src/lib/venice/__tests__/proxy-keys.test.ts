import {
  AgentModelKeyInUseError,
  createManagedVeniceProxyKey,
  hashManagedVeniceProxyKey,
  listManagedVeniceProxyKeys,
  revokeManagedVeniceProxyKey,
  verifyManagedVeniceProxyKey,
} from "@/lib/venice/proxy-keys";

it("turns an agent-key custody guard rejection into safe clear/replace guidance", async () => {
  const query = { eq: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: null, error: { code: "55000", message: "PRIVATE fixture-key-evidence" } }) };
  const db = { from: jest.fn(() => ({ update: jest.fn(() => query) })) };
  await expect(revokeManagedVeniceProxyKey({ userId: "owner", keyId: "fixture-key" }, db)).rejects.toThrow(AgentModelKeyInUseError);
  await expect(revokeManagedVeniceProxyKey({ userId: "owner", keyId: "fixture-key" }, db)).rejects.not.toThrow("PRIVATE");
  expect(query.eq).toHaveBeenCalledWith("id", "fixture-key");
  expect(query.eq).toHaveBeenCalledWith("user_id", "owner");
});

// The starter-credit grant reaches for the risk-assessment repository (its abuse
// gate) through the module-level supabaseAdmin, not the injected db. Mock it so
// the wallet-binding tests below exercise the grant without a real client.
const getRiskAssessment = jest.fn();
jest.mock("@/lib/abuse/repository", () => ({
  getRiskAssessment: (...args: unknown[]) => getRiskAssessment(...args),
}));

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

type Row = Record<string, unknown>;

function createQuery(rows: Row[]) {
  const filters: Array<[string, unknown]> = [];
  const inFilters: Array<[string, unknown[]]> = [];
  const query: {
    eq: (column: string, value: unknown) => typeof query;
    in: (column: string, values: readonly unknown[]) => typeof query;
    limit: (count: number) => typeof query;
    order: (column: string, options?: { ascending?: boolean }) => typeof query;
    single: () => Promise<{ data: Row | null; error: null }>;
    maybeSingle: () => Promise<{ data: Row | null; error: null }>;
    then: Promise<{ data: Row[]; error: null }>["then"];
  } = {} as typeof query;

  let orderedBy: { column: string; ascending: boolean } | null = null;
  let limitCount = Number.POSITIVE_INFINITY;

  function filtered() {
    let result = rows.filter(
      (row) =>
        filters.every(([column, value]) => row[column] === value) &&
        inFilters.every(([column, values]) => values.includes(row[column]))
    );
    if (orderedBy) {
      const order = orderedBy;
      result = [...result].sort((left, right) => {
        const leftValue = String(left[order.column] ?? "");
        const rightValue = String(right[order.column] ?? "");
        const comparison = leftValue.localeCompare(rightValue);
        return order.ascending ? comparison : -comparison;
      });
    }
    return result.slice(0, limitCount);
  }

  query.eq = (column, value) => {
    filters.push([column, value]);
    return query;
  };
  query.in = (column, values) => {
    inFilters.push([column, [...values]]);
    return query;
  };
  query.limit = (count) => {
    limitCount = count;
    return query;
  };
  query.order = (column, options) => {
    orderedBy = { column, ascending: options?.ascending ?? true };
    return query;
  };
  query.single = async () => ({ data: filtered()[0] ?? null, error: null });
  query.maybeSingle = async () => ({ data: filtered()[0] ?? null, error: null });
  query.then = (resolve, reject) =>
    Promise.resolve({ data: filtered(), error: null }).then(resolve, reject);

  return query;
}

function createUpdate(rows: Row[], patch: Row) {
  const filters: Array<[string, unknown]> = [];
  const query: {
    eq: (column: string, value: unknown) => typeof query;
    select: () => { single: () => Promise<{ data: Row | null; error: null }> };
    then: Promise<{ error: null }>["then"];
  } = {} as typeof query;

  function applyPatch() {
    let last: Row | null = null;
    for (const row of rows) {
      if (filters.every(([column, value]) => row[column] === value)) {
        Object.assign(row, patch);
        last = row;
      }
    }
    return last;
  }

  query.eq = (column, value) => {
    filters.push([column, value]);
    return query;
  };
  query.select = () => ({
    single: async () => ({ data: applyPatch(), error: null }),
  });
  query.then = (resolve, reject) =>
    Promise.resolve({ error: null }).then(resolve, reject);

  return query;
}

function createMemoryDb(options: { failBalanceRead?: boolean } = {}) {
  const tables: Record<string, Row[]> = {
    managed_venice_wallet_accounts: [],
    managed_venice_proxy_keys: [],
    // Read by getManagedVeniceWalletSummary to resolve the funded wallet, and
    // written by the starter-credit grant.
    managed_venice_token_lots: [],
    managed_venice_card_ledger_entries: [],
    managed_venice_reservations: [],
    managed_venice_financial_events: [],
  };

  function insertRow(tableName: string, row: Row) {
    const table = tables[tableName];
    const stored = {
      id: row.id ?? `${tableName}_${table.length + 1}`,
      created_at: row.created_at ?? new Date(2026, 0, table.length + 1).toISOString(),
      updated_at: row.updated_at ?? new Date(2026, 0, table.length + 1).toISOString(),
      ...row,
    };
    table.push(stored);
    return stored;
  }

  /** Seed a fixture row directly, bypassing insert semantics. */
  function seed(name: string, row: Row) {
    return insertRow(name, row);
  }

  function table(name: string) {
    const rows = tables[name];
    if (!rows) throw new Error(`Unexpected table ${name}`);

    return {
      // Returns a chain that is BOTH awaitable (card ledger / financial-event
      // callers do `await table.insert(row)`) and `.select().single()`-able
      // (the proxy-key + financial-event insert paths).
      insert: (row: Row) => {
        const stored = insertRow(name, row);
        const chain = {
          select: () => ({
            single: async () => ({ data: stored, error: null }),
          }),
          then: (
            resolve: (value: { data: Row; error: null }) => unknown,
            reject?: (reason: unknown) => unknown
          ) => Promise.resolve({ data: stored, error: null }).then(resolve, reject),
        };
        return chain;
      },
      upsert: (row: Row, options?: { onConflict?: string }) => {
        const conflictColumns = (options?.onConflict || "id")
          .split(",")
          .map((column) => column.trim());
        const existing = rows.find((candidate) =>
          conflictColumns.every((column) => candidate[column] === row[column])
        );
        const stored = existing ? Object.assign(existing, row) : insertRow(name, row);

        return {
          select: () => ({
            single: async () => ({ data: stored, error: null }),
          }),
        };
      },
      select: () => {
        // Simulate a balance-read outage: the wallet summary reads token lots
        // first, so blowing up there is faithful to a real Supabase failure.
        if (options.failBalanceRead && name === "managed_venice_token_lots") {
          throw new Error("token lot read exploded");
        }
        return createQuery(rows);
      },
      update: (patch: Row) => createUpdate(rows, patch),
    };
  }

  return { db: { from: table }, tables, seed };
}

/** An active token lot worth `valueMicroUsd` — the only thing that funds hermesos. */
function seedHermesosLot(
  seed: (name: string, row: Row) => Row,
  userId: string,
  valueMicroUsd: number
) {
  seed("managed_venice_token_lots", {
    user_id: userId,
    status: "active",
    remaining_value_micro_usd: valueMicroUsd,
    remaining_token_amount_raw: "1000",
  });
}

/** A positive card-ledger entry — the wallet the starter credit lands in. */
function seedCardBalance(
  seed: (name: string, row: Row) => Row,
  userId: string,
  amountMicroUsd: number
) {
  seed("managed_venice_card_ledger_entries", {
    user_id: userId,
    amount_micro_usd: amountMicroUsd,
    source: "stripe",
    reason: "stripe_topup",
    reference_id: `topup_${userId}`,
  });
}

function walletTypeOf(tables: Record<string, Row[]>, index = 0) {
  const metadata = tables.managed_venice_proxy_keys[index]?.metadata as
    | { defaultWalletType?: string }
    | undefined;
  return metadata?.defaultWalletType;
}

const env = { MANAGED_VENICE_PROXY_KEY_PEPPER: "pepper_test_secret" };
const fixedRandomBytes = () => Buffer.alloc(32, 1);

describe("managed Venice proxy keys", () => {
  it("creates a one-time plaintext key while storing only hash and prefix", async () => {
    const { db, tables } = createMemoryDb();

    const created = await createManagedVeniceProxyKey(
      {
        userId: "user_1",
        name: "Production key",
        randomBytes: fixedRandomBytes,
        env,
      },
      db
    );

    expect(created.plaintextKey).toMatch(/^hven_live_[A-Za-z0-9_-]+$/);
    expect(created.keyPrefix).toBe(created.plaintextKey.slice(0, 14));
    expect(tables.managed_venice_proxy_keys).toContainEqual(
      expect.objectContaining({
        user_id: "user_1",
        name: "Production key",
        key_prefix: created.keyPrefix,
        key_hash: hashManagedVeniceProxyKey(created.plaintextKey, env),
        status: "active",
      })
    );
    expect(JSON.stringify(tables.managed_venice_proxy_keys)).not.toContain(
      created.plaintextKey
    );
  });

  it("verifies a valid key and updates last_used_at", async () => {
    const { db, tables } = createMemoryDb();
    const created = await createManagedVeniceProxyKey(
      { userId: "user_1", randomBytes: fixedRandomBytes, env },
      db
    );

    const verified = await verifyManagedVeniceProxyKey(
      {
        plaintextKey: created.plaintextKey,
        now: new Date("2026-05-12T12:00:00.000Z"),
        env,
      },
      db
    );

    expect(verified).toMatchObject({
      id: created.id,
      userId: "user_1",
      status: "active",
    });
    expect(tables.managed_venice_proxy_keys[0]).toMatchObject({
      last_used_at: "2026-05-12T12:00:00.000Z",
    });
  });

  it("stores and verifies the key default wallet type for managed deploys", async () => {
    const { db, tables } = createMemoryDb();
    const created = await createManagedVeniceProxyKey(
      {
        userId: "user_1",
        name: "Agent wallet key",
        randomBytes: fixedRandomBytes,
        env,
        defaultWalletType: "card",
      },
      db
    );

    expect(tables.managed_venice_proxy_keys[0]).toMatchObject({
      metadata: { defaultWalletType: "card" },
    });

    const verified = await verifyManagedVeniceProxyKey(
      { plaintextKey: created.plaintextKey, env },
      db
    );

    expect(verified).toMatchObject({
      id: created.id,
      defaultWalletType: "card",
    });
  });

  it("rejects revoked keys", async () => {
    const { db } = createMemoryDb();
    const created = await createManagedVeniceProxyKey(
      { userId: "user_1", randomBytes: fixedRandomBytes, env },
      db
    );

    await revokeManagedVeniceProxyKey({ userId: "user_1", keyId: created.id }, db);

    await expect(
      verifyManagedVeniceProxyKey({ plaintextKey: created.plaintextKey, env }, db)
    ).resolves.toBeNull();
  });

  it("lists key metadata without plaintext or hashes", async () => {
    const { db } = createMemoryDb();
    const created = await createManagedVeniceProxyKey(
      { userId: "user_1", randomBytes: fixedRandomBytes, env },
      db
    );

    const keys = await listManagedVeniceProxyKeys("user_1", db);

    expect(keys).toEqual([
      expect.objectContaining({
        id: created.id,
        keyPrefix: created.keyPrefix,
        status: "active",
      }),
    ]);
    expect(JSON.stringify(keys)).not.toContain(created.plaintextKey);
    expect(JSON.stringify(keys)).not.toContain("key_hash");
  });
});

/**
 * The wallet a key is minted against is the wallet EVERY managed-Venice endpoint
 * bills for that key's whole life (proxy-chat-core and the twelve multi-modal
 * routes all read `verifiedKey.defaultWalletType`, and none of them has a
 * cross-wallet fallback). Binding it to an empty wallet is a permanent 402.
 */
describe("managed Venice proxy key wallet binding", () => {
  const STARTER_FLAG = "HERMES_MANAGED_VENICE_STARTER_CREDIT_ENABLED";

  beforeEach(() => {
    getRiskAssessment.mockReset();
    // No risk row ⇒ the grant's abuse gate fails open, matching the deploy gate.
    getRiskAssessment.mockResolvedValue(null);
    delete process.env[STARTER_FLAG];
  });

  afterEach(() => {
    delete process.env[STARTER_FLAG];
  });

  it("binds a brand-new free user's key to the CARD wallet the starter credit just funded", async () => {
    process.env[STARTER_FLAG] = "1";
    const { db, tables } = createMemoryDb();

    // A virgin free user: no token lots, no card entries. The deploy card
    // therefore submits its 'hermesos' default.
    const created = await createManagedVeniceProxyKey(
      {
        userId: "user_free",
        randomBytes: fixedRandomBytes,
        env,
        defaultWalletType: "hermesos",
        autoSelectFundedWallet: true,
      },
      db
    );

    // The grant landed in the card ledger...
    expect(tables.managed_venice_card_ledger_entries).toEqual([
      expect.objectContaining({
        user_id: "user_free",
        amount_micro_usd: 500_000,
        reference_id: "managed_venice_starter:user_free",
      }),
    ]);

    // ...and, crucially, it landed BEFORE the key was minted, so the key is
    // bound to card. If the grant still ran after the insert (the bug), the
    // balance read would have seen an empty card wallet and bound hermesos.
    expect(walletTypeOf(tables)).toBe("card");
    expect(created.defaultWalletType).toBe("card");

    // What the chat proxy will read on the user's very first message.
    const verified = await verifyManagedVeniceProxyKey(
      { plaintextKey: created.plaintextKey, env },
      db
    );
    expect(verified?.defaultWalletType).toBe("card");
  });

  it("leaves a token holder on hermesos — their lots are never bypassed for card", async () => {
    process.env[STARTER_FLAG] = "1";
    const { db, tables, seed } = createMemoryDb();
    seedHermesosLot(seed, "user_token", 2_000_000);
    // Even with card money sitting there, a funded hermesos request wins.
    seedCardBalance(seed, "user_token", 900_000);

    const created = await createManagedVeniceProxyKey(
      {
        userId: "user_token",
        randomBytes: fixedRandomBytes,
        env,
        defaultWalletType: "hermesos",
        autoSelectFundedWallet: true,
      },
      db
    );

    expect(walletTypeOf(tables)).toBe("hermesos");
    expect(created.defaultWalletType).toBe("hermesos");
  });

  it("is deterministic for a user with BOTH wallets funded: the requested wallet wins", async () => {
    const { db, seed } = createMemoryDb();
    seedHermesosLot(seed, "user_both", 1_000_000);
    seedCardBalance(seed, "user_both", 1_000_000);

    const hermesosKey = await createManagedVeniceProxyKey(
      {
        userId: "user_both",
        randomBytes: fixedRandomBytes,
        env,
        defaultWalletType: "hermesos",
        autoSelectFundedWallet: true,
      },
      db
    );
    const cardKey = await createManagedVeniceProxyKey(
      {
        userId: "user_both",
        randomBytes: fixedRandomBytes,
        env,
        defaultWalletType: "card",
        autoSelectFundedWallet: true,
      },
      db
    );

    expect(hermesosKey.defaultWalletType).toBe("hermesos");
    expect(cardKey.defaultWalletType).toBe("card");
  });

  it("never falls card -> hermesos: an empty card request will not liquidate token lots", async () => {
    const { db, tables, seed } = createMemoryDb();
    seedHermesosLot(seed, "user_card_pick", 5_000_000);
    // Card wallet is empty. The permissive thing would be to spend the lots.
    // We refuse: the user asked to bill card, and lots are their token holdings.
    const created = await createManagedVeniceProxyKey(
      {
        userId: "user_card_pick",
        randomBytes: fixedRandomBytes,
        env,
        defaultWalletType: "card",
        autoSelectFundedWallet: true,
      },
      db
    );

    expect(walletTypeOf(tables)).toBe("card");
    expect(created.defaultWalletType).toBe("card");
  });

  it("switches only off a PROVABLY empty wallet — a fully-reserved hermesos balance counts as empty", async () => {
    const { db, seed } = createMemoryDb();
    seedHermesosLot(seed, "user_reserved", 1_000_000);
    seed("managed_venice_reservations", {
      user_id: "user_reserved",
      wallet_type: "hermesos",
      status: "active",
      reserved_micro_usd: 1_000_000,
      reference_id: "res_1",
    });
    seedCardBalance(seed, "user_reserved", 500_000);

    const created = await createManagedVeniceProxyKey(
      {
        userId: "user_reserved",
        randomBytes: fixedRandomBytes,
        env,
        defaultWalletType: "hermesos",
        autoSelectFundedWallet: true,
      },
      db
    );

    // available = total - reserved = 0, so the key would have bricked on hermesos.
    expect(created.defaultWalletType).toBe("card");
  });

  it("honors the requested wallet verbatim on explicit surfaces (autoSelectFundedWallet off)", async () => {
    const { db, tables, seed } = createMemoryDb();
    seedCardBalance(seed, "user_explicit", 500_000);

    // Same balances as the free-user case, but this is the billing UI's key form
    // (or managed-WebUI enable): the wallet picker is a deliberate choice.
    const created = await createManagedVeniceProxyKey(
      {
        userId: "user_explicit",
        randomBytes: fixedRandomBytes,
        env,
        defaultWalletType: "hermesos",
      },
      db
    );

    expect(walletTypeOf(tables)).toBe("hermesos");
    expect(created.defaultWalletType).toBe("hermesos");
  });

  it("grants exactly once per user and never double-credits across mints", async () => {
    process.env[STARTER_FLAG] = "1";
    const { db, tables } = createMemoryDb();

    await createManagedVeniceProxyKey(
      {
        userId: "user_twice",
        randomBytes: fixedRandomBytes,
        env,
        defaultWalletType: "hermesos",
        autoSelectFundedWallet: true,
      },
      db
    );
    const second = await createManagedVeniceProxyKey(
      {
        userId: "user_twice",
        randomBytes: fixedRandomBytes,
        env,
        defaultWalletType: "hermesos",
        autoSelectFundedWallet: true,
      },
      db
    );

    // One grant row, one financial event — the second mint saw "already_granted".
    const grants = tables.managed_venice_card_ledger_entries.filter(
      (row) => row.reference_id === "managed_venice_starter:user_twice"
    );
    expect(grants).toHaveLength(1);
    expect(tables.managed_venice_financial_events).toHaveLength(1);
    // ...and the second key still binds to the (still-funded) card wallet.
    expect(second.defaultWalletType).toBe("card");
  });

  it("still mints when the starter grant fails — the deploy never throws", async () => {
    process.env[STARTER_FLAG] = "1";
    const { db, tables } = createMemoryDb();
    getRiskAssessment.mockRejectedValue(new Error("risk repo down"));

    const created = await createManagedVeniceProxyKey(
      {
        userId: "user_grant_fail",
        randomBytes: fixedRandomBytes,
        env,
        defaultWalletType: "hermesos",
        autoSelectFundedWallet: true,
      },
      db
    );

    expect(created.plaintextKey).toMatch(/^hven_live_/);
    expect(tables.managed_venice_card_ledger_entries).toHaveLength(0);
    // No funds anywhere ⇒ nothing to switch to; the request stands.
    expect(created.defaultWalletType).toBe("hermesos");
  });

  it("refuses the grant (and stays on hermesos) when the abuse gate blocks", async () => {
    process.env[STARTER_FLAG] = "1";
    const { db, tables } = createMemoryDb();
    getRiskAssessment.mockResolvedValue({ decision: "block", card_satisfied_at: null });

    const created = await createManagedVeniceProxyKey(
      {
        userId: "user_blocked",
        randomBytes: fixedRandomBytes,
        env,
        defaultWalletType: "hermesos",
        autoSelectFundedWallet: true,
      },
      db
    );

    expect(tables.managed_venice_card_ledger_entries).toHaveLength(0);
    expect(created.defaultWalletType).toBe("hermesos");
  });

  it("degrades to the requested wallet when the balance read fails", async () => {
    const { db, seed } = createMemoryDb({ failBalanceRead: true });
    seedCardBalance(seed, "user_db_flaky", 500_000);

    const created = await createManagedVeniceProxyKey(
      {
        userId: "user_db_flaky",
        randomBytes: fixedRandomBytes,
        env,
        defaultWalletType: "hermesos",
        autoSelectFundedWallet: true,
      },
      db
    );

    // Unknown balance must never throw into the deploy path, and must not
    // guess: it binds exactly what the caller asked for (today's behavior).
    expect(created.defaultWalletType).toBe("hermesos");
  });

  it("leaves a wholly unfunded user on hermesos when the starter flag is off", async () => {
    const { db, tables } = createMemoryDb();

    const created = await createManagedVeniceProxyKey(
      {
        userId: "user_no_flag",
        randomBytes: fixedRandomBytes,
        env,
        defaultWalletType: "hermesos",
        autoSelectFundedWallet: true,
      },
      db
    );

    expect(tables.managed_venice_card_ledger_entries).toHaveLength(0);
    expect(created.defaultWalletType).toBe("hermesos");
  });
});
