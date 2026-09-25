import {
  MANAGED_VENICE_TOKEN_LOT_DEBIT_MAX_ATTEMPTS,
  ManagedVeniceInsufficientBalanceError,
  captureManagedVeniceReservation,
  createManagedVeniceReservation,
  debitManagedVeniceWallet,
  ensureManagedVeniceWalletAccount,
  getManagedVeniceWalletSummary,
  grantManagedVeniceCardTopUpCredit,
  releaseManagedVeniceReservation,
} from "@/lib/billing/managed-venice-wallets";
import { createManagedVeniceSpendWorld } from "@/test-utils/managed-venice-spend-world";

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
    select: () => Promise<{ data: Row[]; error: null }>;
    then: Promise<{ error: null }>["then"];
  } = {} as typeof query;

  const apply = () => {
    const changed: Row[] = [];
    for (const row of rows) {
      if (filters.every(([column, value]) => row[column] === value)) {
        Object.assign(row, patch);
        changed.push(row);
      }
    }
    return changed;
  };

  query.eq = (column, value) => {
    filters.push([column, value]);
    return query;
  };
  // Like PostgREST: update(...).select() resolves to the rows it changed.
  query.select = async () => ({ data: apply(), error: null });
  query.then = (resolve, reject) => {
    apply();
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

  it("captures a card reservation that holds the whole balance (its own hold is not counted against it)", async () => {
    // Regression: the card debit's balance check subtracted EVERY active card
    // hold — including the one being captured — so a user whose hold covered
    // most of the balance could never be charged (capture threw "insufficient").
    const { db, insertRow, tables } = createMemoryDb();
    const account = await ensureManagedVeniceWalletAccount("user_1", db);
    insertRow("managed_venice_card_ledger_entries", {
      account_id: account.id,
      user_id: "user_1",
      amount_micro_usd: 500_000,
      source: "stripe",
      reason: "stripe_topup",
      reference_id: "topup_1",
    });
    await createManagedVeniceReservation(
      { userId: "user_1", walletType: "card", amountMicroUsd: 500_000, referenceId: "usage_full" },
      db
    );

    await expect(
      captureManagedVeniceReservation(
        { userId: "user_1", referenceId: "usage_full", captureMicroUsd: 300_000 },
        db
      )
    ).resolves.toMatchObject({ captured: true, capturedMicroUsd: 300_000 });

    expect(tables.managed_venice_card_ledger_entries).toContainEqual(
      expect.objectContaining({ amount_micro_usd: -300_000, reference_id: "usage_full" })
    );
    await expect(getManagedVeniceWalletSummary("user_1", db)).resolves.toMatchObject({
      card: { totalValueMicroUsd: 200_000, reservedMicroUsd: 0, availableMicroUsd: 200_000 },
    });
  });

  it("still refuses a direct card debit that would eat into other requests' holds", async () => {
    const { db, insertRow } = createMemoryDb();
    const account = await ensureManagedVeniceWalletAccount("user_1", db);
    insertRow("managed_venice_card_ledger_entries", {
      account_id: account.id,
      user_id: "user_1",
      amount_micro_usd: 500_000,
      source: "stripe",
      reason: "stripe_topup",
      reference_id: "topup_1",
    });
    await createManagedVeniceReservation(
      { userId: "user_1", walletType: "card", amountMicroUsd: 200_000, referenceId: "usage_a" },
      db
    );
    await createManagedVeniceReservation(
      { userId: "user_1", walletType: "card", amountMicroUsd: 300_000, referenceId: "usage_b" },
      db
    );

    // An overage-style debit outside any reservation sees every hold.
    await expect(
      debitManagedVeniceWallet(
        { userId: "user_1", walletType: "card", amountMicroUsd: 100_000, referenceId: "usage_a:overage" },
        db
      )
    ).rejects.toBeInstanceOf(ManagedVeniceInsufficientBalanceError);
    // Each capture only excludes its OWN hold, so both still settle in full.
    await expect(
      captureManagedVeniceReservation({ userId: "user_1", referenceId: "usage_a", captureMicroUsd: 200_000 }, db)
    ).resolves.toMatchObject({ captured: true });
    await expect(
      captureManagedVeniceReservation({ userId: "user_1", referenceId: "usage_b", captureMicroUsd: 300_000 }, db)
    ).resolves.toMatchObject({ captured: true });
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

// Regression (pre-launch review, MEDIUM "Token-lot debit race"): a token-lot
// debit wrote the lot's new remaining value filtered by id alone, so debits
// that read the lot at the same time overwrote each other. Ten $0.05 media
// captures on a $1.00 lot left $0.95, and every hold still closed as captured.
// These run the real wallet code against the in-memory DB, whose
// update(...).select() returns only the rows the filters still matched.
describe("token lot debits under concurrency", () => {
  const USER = "user_lot_race";

  function lotWrites(world: ReturnType<typeof createManagedVeniceSpendWorld>) {
    return world.calls
      .filter((call) => call.table === "managed_venice_token_lots" && call.kind === "update")
      .map((call) => call.filters?.find((filter) => filter.column === "remaining_value_micro_usd")?.value);
  }

  it("ten captures of one lot at the same time each debit it", async () => {
    const world = createManagedVeniceSpendWorld();
    world.fundHermesos(USER, 1_000_000);
    for (let index = 0; index < 10; index += 1) {
      await createManagedVeniceReservation(
        { userId: USER, walletType: "hermesos", amountMicroUsd: 50_000, referenceId: `media_${index}` },
        world.db
      );
    }

    const captures = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        captureManagedVeniceReservation({ userId: USER, referenceId: `media_${index}`, captureMicroUsd: 50_000 }, world.db)
      )
    );

    expect(captures.every((capture) => capture.captured)).toBe(true);
    expect(world.tables.managed_venice_token_lots[0]).toMatchObject({
      remaining_value_micro_usd: 500_000,
      remaining_token_amount_raw: "500000",
      status: "active",
    });
    await expect(getManagedVeniceWalletSummary(USER, world.db)).resolves.toMatchObject({
      hermesos: { totalValueMicroUsd: 500_000, reservedMicroUsd: 0, availableMicroUsd: 500_000 },
    });
  });

  it("a debit whose read was overtaken by another debit re-reads the lot instead of overwriting it", async () => {
    const world = createManagedVeniceSpendWorld();
    world.fundHermesos(USER, 1_000_000);
    // This debit reads the lot at $1.00, then another debit of $0.40 commits.
    const racing = world.withStaleReads(
      "managed_venice_token_lots",
      world.tables.managed_venice_token_lots,
      { untilWrite: true }
    );
    await debitManagedVeniceWallet(
      { userId: USER, walletType: "hermesos", amountMicroUsd: 400_000, referenceId: "other_debit" },
      world.db
    );

    await debitManagedVeniceWallet(
      { userId: USER, walletType: "hermesos", amountMicroUsd: 50_000, referenceId: "racing_debit" },
      racing
    );

    // $1.00 - $0.40 - $0.05, not the $0.95 a blind write of its stale read would leave.
    expect(world.tables.managed_venice_token_lots[0]).toMatchObject({
      remaining_value_micro_usd: 550_000,
      remaining_token_amount_raw: "550000",
    });
    // The other debit's write, the racing debit's lost compare-and-set on the
    // $1.00 it read, then its write against the $0.60 it re-read.
    expect(lotWrites(world)).toEqual([1_000_000, 1_000_000, 600_000]);
  });

  it("skips a lot that was voided after it was read", async () => {
    const world = createManagedVeniceSpendWorld();
    world.fundHermesos(USER, 300_000);
    world.fundHermesos(USER, 300_000);
    const racing = world.withStaleReads(
      "managed_venice_token_lots",
      world.tables.managed_venice_token_lots,
      { untilWrite: true }
    );
    world.tables.managed_venice_token_lots[0].status = "voided";

    await debitManagedVeniceWallet(
      { userId: USER, walletType: "hermesos", amountMicroUsd: 100_000, referenceId: "after_void" },
      racing
    );

    expect(world.tables.managed_venice_token_lots.map((lot) => [lot.status, lot.remaining_value_micro_usd])).toEqual([
      ["voided", 300_000],
      ["active", 200_000],
    ]);
  });

  it("gives up with an error after losing every attempt, leaving the lot and the hold as they were", async () => {
    const world = createManagedVeniceSpendWorld();
    world.fundHermesos(USER, 1_000_000);
    await createManagedVeniceReservation(
      { userId: USER, walletType: "hermesos", amountMicroUsd: 50_000, referenceId: "starved" },
      world.db
    );
    // Every read this capture makes still shows $1.00; the lot really holds $0.60.
    const alwaysStale = world.withStaleReads("managed_venice_token_lots", world.tables.managed_venice_token_lots);
    await debitManagedVeniceWallet(
      { userId: USER, walletType: "hermesos", amountMicroUsd: 400_000, referenceId: "other_debit" },
      world.db
    );

    await expect(
      captureManagedVeniceReservation({ userId: USER, referenceId: "starved", captureMicroUsd: 50_000 }, alwaysStale)
    ).rejects.toThrow(`lost ${MANAGED_VENICE_TOKEN_LOT_DEBIT_MAX_ATTEMPTS} races`);

    expect(world.tables.managed_venice_token_lots[0].remaining_value_micro_usd).toBe(600_000);
    expect(lotWrites(world).filter((value) => value === 1_000_000)).toHaveLength(
      1 + MANAGED_VENICE_TOKEN_LOT_DEBIT_MAX_ATTEMPTS
    );
    // The hold still backs the debt; the caller files it for reconciliation.
    expect(world.reservations()[0]).toMatchObject({ reference_id: "starved", status: "active" });
  });
});
