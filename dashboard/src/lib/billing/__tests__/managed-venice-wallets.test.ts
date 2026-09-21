import {
  ManagedVeniceInsufficientBalanceError,
  captureManagedVeniceReservation,
  createManagedVeniceReservation,
  ensureManagedVeniceWalletAccount,
  getManagedVeniceWalletSummary,
  grantManagedVeniceCardTopUpCredit,
  releaseManagedVeniceReservation,
} from "@/lib/billing/managed-venice-wallets";

type Row = Record<string, unknown>;

function createQuery(rows: Row[]) {
  const filters: Array<[string, unknown]> = [];
  const query: {
    eq: (column: string, value: unknown) => typeof query;
    order: (column: string, options?: { ascending?: boolean }) => typeof query;
    single: () => Promise<{ data: Row | null; error: null }>;
    maybeSingle: () => Promise<{ data: Row | null; error: null }>;
    then: Promise<{ data: Row[]; error: null }>["then"];
  } = {} as typeof query;

  let orderedBy: { column: string; ascending: boolean } | null = null;

  function filtered() {
    const result = rows.filter((row) =>
      filters.every(([column, value]) => row[column] === value)
    );
    if (!orderedBy) return result;
    const order = orderedBy;

    return [...result].sort((left, right) => {
      const leftValue = String(left[order.column] ?? "");
      const rightValue = String(right[order.column] ?? "");
      const comparison = leftValue.localeCompare(rightValue);
      return order.ascending ? comparison : -comparison;
    });
  }

  query.eq = (column, value) => {
    filters.push([column, value]);
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
    then: Promise<{ error: null }>["then"];
  } = {} as typeof query;

  query.eq = (column, value) => {
    filters.push([column, value]);
    return query;
  };
  query.then = (resolve, reject) => {
    for (const row of rows) {
      if (filters.every(([column, value]) => row[column] === value)) {
        Object.assign(row, patch);
      }
    }
    return Promise.resolve({ error: null }).then(resolve, reject);
  };

  return query;
}

function createMemoryDb() {
  const tables: Record<string, Row[]> = {
    managed_venice_wallet_accounts: [],
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
      ...row,
    };
    table.push(stored);
    return stored;
  }

  function table(name: string) {
    const rows = tables[name];
    if (!rows) throw new Error(`Unexpected table ${name}`);

    return {
      insert: (row: Row) => {
        const stored = insertRow(name, row);
        return {
          select: () => ({
            single: async () => ({ data: stored, error: null }),
          }),
          then: (
            resolve: (value: { data: Row; error: null }) => unknown,
            reject?: (reason: unknown) => unknown
          ) => Promise.resolve({ data: stored, error: null }).then(resolve, reject),
        };
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
      select: () => createQuery(rows),
      update: (patch: Row) => createUpdate(rows, patch),
    };
  }

  return {
    db: { from: table },
    tables,
    insertRow,
  };
}

describe("managed Venice wallet accounting", () => {
  it("creates a single managed Venice wallet account per user", async () => {
    const { db, tables } = createMemoryDb();

    const first = await ensureManagedVeniceWalletAccount("user_1", db);
    const second = await ensureManagedVeniceWalletAccount("user_1", db);

    expect(first.id).toBe(second.id);
    expect(tables.managed_venice_wallet_accounts).toHaveLength(1);
  });

  it("subtracts active reservations from available wallet balances", async () => {
    const { db, insertRow } = createMemoryDb();
    const account = await ensureManagedVeniceWalletAccount("user_1", db);
    insertRow("managed_venice_token_lots", {
      account_id: account.id,
      user_id: "user_1",
      status: "active",
      remaining_value_micro_usd: 1_000_000,
      remaining_token_amount_raw: "1000",
      token_amount_raw: "1000",
    });

    await createManagedVeniceReservation(
      {
        userId: "user_1",
        walletType: "hermesos",
        amountMicroUsd: 250_000,
        referenceId: "reservation_1",
      },
      db
    );

    await expect(
      createManagedVeniceReservation(
        {
          userId: "user_1",
          walletType: "hermesos",
          amountMicroUsd: 800_000,
          referenceId: "reservation_2",
        },
        db
      )
    ).rejects.toBeInstanceOf(ManagedVeniceInsufficientBalanceError);

    await expect(getManagedVeniceWalletSummary("user_1", db)).resolves.toMatchObject({
      hermesos: {
        totalValueMicroUsd: 1_000_000,
        reservedMicroUsd: 250_000,
        availableMicroUsd: 750_000,
      },
    });
  });

  it("maps the DB balance-guard rejection (concurrent race-loss) to ManagedVeniceInsufficientBalanceError", async () => {
    const { db, insertRow } = createMemoryDb();
    const account = await ensureManagedVeniceWalletAccount("user_1", db);
    // Plenty of balance, so the application-level pre-check passes...
    insertRow("managed_venice_token_lots", {
      account_id: account.id,
      user_id: "user_1",
      status: "active",
      remaining_value_micro_usd: 1_000_000,
      remaining_token_amount_raw: "1000",
      token_amount_raw: "1000",
    });

    // ...but the DB-level guard trigger (not run by the in-memory db) rejects
    // the insert — i.e. a concurrent request won the race and consumed the
    // balance. The error must surface as the typed insufficient-balance error.
    const racingDb = {
      from: (name: string) => {
        const base = db.from(name);
        if (name !== "managed_venice_reservations") return base;
        return {
          ...base,
          upsert: () => ({
            select: () => ({
              single: async () => ({
                data: null,
                error: {
                  code: "P0001",
                  message: "managed_venice_insufficient_balance: available=0 requested=250000",
                },
              }),
            }),
          }),
        };
      },
    };

    await expect(
      createManagedVeniceReservation(
        {
          userId: "user_1",
          walletType: "hermesos",
          amountMicroUsd: 250_000,
          referenceId: "race_ref",
        },
        racingDb as never
      )
    ).rejects.toBeInstanceOf(ManagedVeniceInsufficientBalanceError);
  });

  it("captures Hivra reservations by spending token lots FIFO", async () => {
    const { db, insertRow, tables } = createMemoryDb();
    const account = await ensureManagedVeniceWalletAccount("user_1", db);
    insertRow("managed_venice_token_lots", {
      id: "lot_old",
      account_id: account.id,
      user_id: "user_1",
      status: "active",
      remaining_value_micro_usd: 1_000_000,
      remaining_token_amount_raw: "1000",
      token_amount_raw: "1000",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    insertRow("managed_venice_token_lots", {
      id: "lot_new",
      account_id: account.id,
      user_id: "user_1",
      status: "active",
      remaining_value_micro_usd: 2_000_000,
      remaining_token_amount_raw: "2000",
      token_amount_raw: "2000",
      created_at: "2026-01-02T00:00:00.000Z",
    });

    await createManagedVeniceReservation(
      {
        userId: "user_1",
        walletType: "hermesos",
        amountMicroUsd: 1_500_000,
        referenceId: "usage_1",
      },
      db
    );
    const capture = await captureManagedVeniceReservation(
      { userId: "user_1", referenceId: "usage_1", captureMicroUsd: 1_500_000 },
      db
    );

    expect(capture.capturedMicroUsd).toBe(1_500_000);
    expect(tables.managed_venice_token_lots).toEqual([
      expect.objectContaining({
        id: "lot_old",
        remaining_value_micro_usd: 0,
        remaining_token_amount_raw: "0",
        status: "depleted",
      }),
      expect.objectContaining({
        id: "lot_new",
        remaining_value_micro_usd: 1_500_000,
        remaining_token_amount_raw: "1500",
        status: "active",
      }),
    ]);
  });

  it("releases unused reservations back to available balance", async () => {
    const { db, insertRow } = createMemoryDb();
    const account = await ensureManagedVeniceWalletAccount("user_1", db);
    insertRow("managed_venice_token_lots", {
      account_id: account.id,
      user_id: "user_1",
      status: "active",
      remaining_value_micro_usd: 1_000_000,
      remaining_token_amount_raw: "1000",
      token_amount_raw: "1000",
    });

    await createManagedVeniceReservation(
      {
        userId: "user_1",
        walletType: "hermesos",
        amountMicroUsd: 600_000,
        referenceId: "usage_release",
      },
      db
    );
    await releaseManagedVeniceReservation(
      { userId: "user_1", referenceId: "usage_release" },
      db
    );

    await expect(getManagedVeniceWalletSummary("user_1", db)).resolves.toMatchObject({
      hermesos: {
        reservedMicroUsd: 0,
        availableMicroUsd: 1_000_000,
      },
    });
  });

  it("captures card reservations by writing a card ledger debit", async () => {
    const { db, insertRow, tables } = createMemoryDb();
    const account = await ensureManagedVeniceWalletAccount("user_1", db);
    insertRow("managed_venice_card_ledger_entries", {
      account_id: account.id,
      user_id: "user_1",
      amount_micro_usd: 2_000_000,
      source: "stripe",
      reason: "stripe_topup",
      reference_id: "topup_1",
    });

    await createManagedVeniceReservation(
      {
        userId: "user_1",
        walletType: "card",
        amountMicroUsd: 500_000,
        referenceId: "usage_card",
      },
      db
    );
    await captureManagedVeniceReservation(
      { userId: "user_1", referenceId: "usage_card", captureMicroUsd: 400_000 },
      db
    );

    expect(tables.managed_venice_card_ledger_entries).toContainEqual(
      expect.objectContaining({
        user_id: "user_1",
        amount_micro_usd: -400_000,
        source: "system",
        reason: "managed_venice_debit",
        reference_id: "usage_card",
      })
    );
    await expect(getManagedVeniceWalletSummary("user_1", db)).resolves.toMatchObject({
      card: {
        totalValueMicroUsd: 1_600_000,
        availableMicroUsd: 1_600_000,
      },
    });
  });

  it("credits managed Venice card top-ups idempotently and records a financial event", async () => {
    const { db, tables } = createMemoryDb();

    await grantManagedVeniceCardTopUpCredit(
      {
        userId: "user_1",
        amountMicroUsd: 50_000_000,
        sessionId: "cs_managed_venice_1",
        amountTotalCents: 5000,
      },
      db
    );
    await grantManagedVeniceCardTopUpCredit(
      {
        userId: "user_1",
        amountMicroUsd: 50_000_000,
        sessionId: "cs_managed_venice_1",
        amountTotalCents: 5000,
      },
      db
    );

    expect(tables.managed_venice_card_ledger_entries).toHaveLength(1);
    expect(tables.managed_venice_card_ledger_entries).toContainEqual(
      expect.objectContaining({
        user_id: "user_1",
        amount_micro_usd: 50_000_000,
        source: "stripe",
        reason: "stripe_topup",
        reference_id: "cs_managed_venice_1",
      })
    );
    expect(tables.managed_venice_financial_events).toContainEqual(
      expect.objectContaining({
        user_id: "user_1",
        wallet_type: "card",
        event_type: "card_topup",
        reference_id: "cs_managed_venice_1",
        amount_micro_usd: 50_000_000,
      })
    );
  });
});
