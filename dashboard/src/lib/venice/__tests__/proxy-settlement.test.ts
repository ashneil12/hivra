import { ManagedVeniceInsufficientBalanceError } from "@/lib/billing/managed-venice-wallets";
import {
  captureManagedVeniceChatUsage,
  markManagedVeniceReconciliationRequired,
  releaseManagedVeniceChatReservation,
  reserveManagedVeniceChatRequest,
} from "@/lib/venice/proxy-settlement";

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
    let result = rows.filter((row) =>
      filters.every(([column, value]) => row[column] === value)
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
    return result;
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
  query.then = (resolve, reject) => {
    applyPatch();
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
    managed_venice_usage_events: [],
    managed_venice_financial_events: [],
    managed_venice_reconciliation_items: [],
    managed_venice_proxy_keys: [],
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

  return { db: { from: table }, tables, insertRow };
}

async function seedBalance(db: ReturnType<typeof createMemoryDb>, userId = "user_1") {
  const account = db.insertRow("managed_venice_wallet_accounts", {
    id: "account_1",
    user_id: userId,
    default_payment_wallet: "hermesos",
  });
  db.insertRow("managed_venice_token_lots", {
    id: "lot_1",
    account_id: account.id,
    user_id: userId,
    status: "active",
    remaining_value_micro_usd: 1_000_000,
    remaining_token_amount_raw: "1000000000000000000",
    token_amount_raw: "1000000000000000000",
    snapshot_price_usd: "1",
    quote_source: "test",
    quoted_at: "2026-05-12T12:00:00.000Z",
  });
}

const requestBody = {
  model: "venice-uncensored-1-2",
  messages: [{ role: "user", content: "hello world" }],
  max_completion_tokens: 100,
};

describe("managed Venice proxy settlement", () => {
  it.each([200, "bad", -1])("does not capture or record fabricated Responses cache-write costs: %s", async writes => {
    const memory = createMemoryDb(); await seedBalance(memory);
    const identity = { userId: "user_1", proxyKeyId: "key_1", walletType: "hermesos" as const, referenceId: "responses_write", endpoint: "/api/v1/responses" as const };
    await reserveManagedVeniceChatRequest({ ...identity, requestBody }, memory.db);
    await expect(captureManagedVeniceChatUsage({ ...identity, model: "zai-org-glm-4.7", upstreamStatus: 200,
      usage: { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 800, cache_creation_input_tokens: writes } } }, memory.db)).rejects.toThrow();
    expect(memory.tables.managed_venice_reservations[0].status).toBe("active");
    expect(memory.tables.managed_venice_usage_events).toHaveLength(0);
  });
  it("attributes Responses reservations and charges uncached input once while retaining total tokens", async () => {
    const memory = createMemoryDb();
    await seedBalance(memory);
    const identity = { userId: "user_1", proxyKeyId: "key_1", walletType: "hermesos" as const, referenceId: "responses_cache", endpoint: "/api/v1/responses" as const };
    await reserveManagedVeniceChatRequest({ ...identity, requestBody }, memory.db);
    const result = await captureManagedVeniceChatUsage({ ...identity, model: "zai-org-glm-4.7", upstreamStatus: 200,
      usage: { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 800 }, output_tokens_details: { reasoning_tokens: 80 } } }, memory.db);
    expect(result.actualCostMicroUsd).toBe(463);
    expect(memory.tables.managed_venice_reservations).toContainEqual(expect.objectContaining({ endpoint: "/api/v1/responses", reference_id: identity.referenceId }));
    expect(memory.tables.managed_venice_usage_events).toContainEqual(expect.objectContaining({ endpoint: "/api/v1/responses", prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, actual_cost_micro_usd: 463 }));
  });
  it("reserves provider-rate wallet balance before an upstream call", async () => {
    const memory = createMemoryDb();
    await seedBalance(memory);

    const reservation = await reserveManagedVeniceChatRequest(
      {
        userId: "user_1",
        proxyKeyId: "key_1",
        walletType: "hermesos",
        referenceId: "req_1",
        requestBody,
        subsidyState: {
          userLaunchSubsidyUsedMicroUsd: 0,
          weeklySubsidyUsedMicroUsd: 0,
        },
      },
      memory.db
    );

    expect(reservation.reservedMicroUsd).toBe(101);
    expect(memory.tables.managed_venice_reservations).toContainEqual(
      expect.objectContaining({
        reference_id: "req_1",
        wallet_type: "hermesos",
        reserved_micro_usd: 101,
        estimated_cost_micro_usd: 91,
        discount_micro_usd: 0,
        model: "venice-uncensored-1-2",
      })
    );
  });

  it("fails before upstream work when the wallet cannot cover the reservation", async () => {
    const memory = createMemoryDb();

    await expect(
      reserveManagedVeniceChatRequest(
        {
          userId: "user_1",
          proxyKeyId: "key_1",
          walletType: "hermesos",
          referenceId: "req_1",
          requestBody,
          subsidyState: {
            userLaunchSubsidyUsedMicroUsd: 0,
            weeklySubsidyUsedMicroUsd: 0,
          },
        },
        memory.db
      )
    ).rejects.toBeInstanceOf(ManagedVeniceInsufficientBalanceError);
    expect(memory.tables.managed_venice_reservations).toHaveLength(0);
  });

  it("captures actual usage, releases unused reservation, and writes financial events", async () => {
    const memory = createMemoryDb();
    await seedBalance(memory);
    await reserveManagedVeniceChatRequest(
      {
        userId: "user_1",
        proxyKeyId: "key_1",
        walletType: "hermesos",
        referenceId: "req_1",
        requestBody,
        subsidyState: {
          userLaunchSubsidyUsedMicroUsd: 0,
          weeklySubsidyUsedMicroUsd: 0,
        },
      },
      memory.db
    );

    const capture = await captureManagedVeniceChatUsage(
      {
        userId: "user_1",
        proxyKeyId: "key_1",
        walletType: "hermesos",
        referenceId: "req_1",
        model: "venice-uncensored-1-2",
        upstreamStatus: 200,
        usage: { prompt_tokens: 4, completion_tokens: 100 },
        subsidyState: {
          userLaunchSubsidyUsedMicroUsd: 0,
          weeklySubsidyUsedMicroUsd: 0,
        },
      },
      memory.db
    );

    expect(capture).toMatchObject({
      actualCostMicroUsd: 91,
      chargedMicroUsd: 91,
      discountMicroUsd: 0,
    });
    expect(memory.tables.managed_venice_usage_events).toContainEqual(
      expect.objectContaining({
        reference_id: "req_1",
        actual_cost_micro_usd: 91,
        charged_micro_usd: 91,
        discount_micro_usd: 0,
      })
    );
    expect(memory.tables.managed_venice_financial_events).toContainEqual(
      expect.objectContaining({
        event_type: "usage_capture",
        amount_micro_usd: 91,
      })
    );
    expect(memory.tables.managed_venice_financial_events).not.toContainEqual(
      expect.objectContaining({ event_type: "subsidy_applied" })
    );
  });

  it("releases a reservation when upstream fails before billable usage", async () => {
    const memory = createMemoryDb();
    await seedBalance(memory);
    await reserveManagedVeniceChatRequest(
      {
        userId: "user_1",
        proxyKeyId: "key_1",
        walletType: "hermesos",
        referenceId: "req_1",
        requestBody,
        subsidyState: {
          userLaunchSubsidyUsedMicroUsd: 0,
          weeklySubsidyUsedMicroUsd: 0,
        },
      },
      memory.db
    );

    await releaseManagedVeniceChatReservation(
      { userId: "user_1", referenceId: "req_1" },
      memory.db
    );

    expect(memory.tables.managed_venice_reservations).toContainEqual(
      expect.objectContaining({
        reference_id: "req_1",
        status: "released",
        released_micro_usd: 101,
      })
    );
  });

  it("debits the overage when actual usage exceeds the reservation", async () => {
    const memory = createMemoryDb();
    // Seed a fat hermesos lot — we want the overage debit to succeed.
    const account = memory.insertRow("managed_venice_wallet_accounts", {
      id: "account_1",
      user_id: "user_1",
      default_payment_wallet: "hermesos",
    });
    memory.insertRow("managed_venice_token_lots", {
      id: "lot_1",
      account_id: account.id,
      user_id: "user_1",
      status: "active",
      remaining_value_micro_usd: 10_000_000,
      remaining_token_amount_raw: "1000000000000000000",
      token_amount_raw: "1000000000000000000",
      snapshot_price_usd: "1",
      quote_source: "test",
      quoted_at: "2026-05-12T12:00:00.000Z",
    });

    await reserveManagedVeniceChatRequest(
      {
        userId: "user_1",
        proxyKeyId: "key_1",
        walletType: "hermesos",
        referenceId: "req_overage",
        // No max_completion_tokens — reservation lands on the defensive
        // default (4096) but the response will pretend to run longer.
        requestBody: {
          model: "venice-uncensored-1-2",
          messages: [{ role: "user", content: "hi" }],
        },
      },
      memory.db
    );

    const capture = await captureManagedVeniceChatUsage(
      {
        userId: "user_1",
        proxyKeyId: "key_1",
        walletType: "hermesos",
        referenceId: "req_overage",
        model: "venice-uncensored-1-2",
        upstreamStatus: 200,
        usage: { prompt_tokens: 4, completion_tokens: 8_192 },
      },
      memory.db
    );

    expect(capture.overageStatus).toBe("captured");
    expect(capture.overageMicroUsd).toBeGreaterThan(0);
    expect(capture.chargedMicroUsd).toBe(capture.actualCostMicroUsd);
    expect(memory.tables.managed_venice_card_ledger_entries.concat(
      memory.tables.managed_venice_token_lots
    )).not.toBeNull();
    expect(memory.tables.managed_venice_usage_events).toContainEqual(
      expect.objectContaining({
        reference_id: "req_overage",
        actual_cost_micro_usd: capture.actualCostMicroUsd,
        charged_micro_usd: capture.actualCostMicroUsd,
      })
    );
  });

  it("flags reconciliation when the wallet cannot cover the overage", async () => {
    const memory = createMemoryDb();
    const account = memory.insertRow("managed_venice_wallet_accounts", {
      id: "account_1",
      user_id: "user_1",
      default_payment_wallet: "hermesos",
    });
    // Just enough to cover the reservation, not the overage.
    memory.insertRow("managed_venice_token_lots", {
      id: "lot_1",
      account_id: account.id,
      user_id: "user_1",
      status: "active",
      remaining_value_micro_usd: 5_000,
      remaining_token_amount_raw: "1000000000000000000",
      token_amount_raw: "1000000000000000000",
      snapshot_price_usd: "1",
      quote_source: "test",
      quoted_at: "2026-05-12T12:00:00.000Z",
    });
    memory.insertRow("managed_venice_proxy_keys", {
      id: "key_1",
      account_id: account.id,
      user_id: "user_1",
      status: "active",
      key_hash: "hash",
      key_prefix: "hven_live_abc",
      name: "key",
    });

    await reserveManagedVeniceChatRequest(
      {
        userId: "user_1",
        proxyKeyId: "key_1",
        walletType: "hermesos",
        referenceId: "req_overage_uncovered",
        requestBody: {
          model: "venice-uncensored-1-2",
          messages: [{ role: "user", content: "hi" }],
          max_completion_tokens: 4,
        },
      },
      memory.db
    );

    const capture = await captureManagedVeniceChatUsage(
      {
        userId: "user_1",
        proxyKeyId: "key_1",
        walletType: "hermesos",
        referenceId: "req_overage_uncovered",
        model: "venice-uncensored-1-2",
        upstreamStatus: 200,
        usage: { prompt_tokens: 4, completion_tokens: 8_192 },
      },
      memory.db
    );

    expect(capture.overageStatus).toBe("reconciliation_required");
    expect(capture.chargedMicroUsd).toBeLessThan(capture.actualCostMicroUsd);
    expect(memory.tables.managed_venice_reconciliation_items).toContainEqual(
      expect.objectContaining({
        reason: "managed_venice_overage_uncovered",
      })
    );
    expect(memory.tables.managed_venice_proxy_keys).toContainEqual(
      expect.objectContaining({
        id: "key_1",
        status: "paused",
        paused_reason: "managed_venice_overage_uncovered",
      })
    );
  });

  it("reads OpenAI-style cached_tokens via prompt_tokens_details", async () => {
    const memory = createMemoryDb();
    await seedBalance(memory);
    await reserveManagedVeniceChatRequest(
      {
        userId: "user_1",
        proxyKeyId: "key_1",
        walletType: "hermesos",
        referenceId: "req_cache",
        requestBody,
      },
      memory.db
    );

    const capture = await captureManagedVeniceChatUsage(
      {
        userId: "user_1",
        proxyKeyId: "key_1",
        walletType: "hermesos",
        referenceId: "req_cache",
        model: "zai-org-glm-4.7",
        upstreamStatus: 200,
        usage: {
          prompt_tokens: 1_000,
          completion_tokens: 100,
          prompt_tokens_details: { cached_tokens: 800 },
        },
      },
      memory.db
    );

    // GLM 4.7: input 0.55/M, output 2.65/M, cache_read 0.11/M
    // Cost = 1000 * 0.55 + 100 * 2.65 + 800 * 0.11 = 550 + 265 + 88 = 903 microUsd
    expect(capture.actualCostMicroUsd).toBe(903);
  });

  it("marks missing usage for reconciliation and pauses the proxy key", async () => {
    const memory = createMemoryDb();
    memory.insertRow("managed_venice_proxy_keys", {
      id: "key_1",
      account_id: "account_1",
      user_id: "user_1",
      status: "active",
      key_hash: "hash",
      key_prefix: "hven_live_abc",
      name: "key",
    });

    await markManagedVeniceReconciliationRequired(
      {
        userId: "user_1",
        proxyKeyId: "key_1",
        referenceId: "req_1",
        reason: "managed_venice_missing_usage",
        metadata: { model: "venice-uncensored-1-2" },
      },
      memory.db
    );

    expect(memory.tables.managed_venice_reconciliation_items).toContainEqual(
      expect.objectContaining({
        user_id: "user_1",
        proxy_key_id: "key_1",
        reason: "managed_venice_missing_usage",
      })
    );
    expect(memory.tables.managed_venice_proxy_keys).toContainEqual(
      expect.objectContaining({
        id: "key_1",
        status: "paused",
        paused_reason: "managed_venice_missing_usage",
      })
    );
  });

  it("files a reconciliation item WITHOUT pausing when pauseKey is false", async () => {
    const memory = createMemoryDb();
    memory.insertRow("managed_venice_proxy_keys", {
      id: "key_1",
      account_id: "account_1",
      user_id: "user_1",
      status: "active",
      key_hash: "hash",
      key_prefix: "hven_live_abc",
      name: "key",
    });

    const result = await markManagedVeniceReconciliationRequired(
      {
        userId: "user_1",
        proxyKeyId: "key_1",
        referenceId: "req_1",
        reason: "managed_venice_stream_settlement_failed",
        metadata: { model: "venice-uncensored-1-2" },
        pauseKey: false,
      },
      memory.db
    );

    // The reconciliation item is still filed for offline follow-up...
    expect(memory.tables.managed_venice_reconciliation_items).toContainEqual(
      expect.objectContaining({
        user_id: "user_1",
        proxy_key_id: "key_1",
        reason: "managed_venice_stream_settlement_failed",
      })
    );
    // ...but the key stays active so a paying customer isn't bricked over a
    // telemetry/settlement hiccup on an otherwise-successful request.
    expect(memory.tables.managed_venice_proxy_keys).toContainEqual(
      expect.objectContaining({ id: "key_1", status: "active" })
    );
    expect(result).toEqual({ status: "open", paused: false });
  });

  it("records late usage without changing a revoked or deliberately paused key", async () => {
    for (const status of ["revoked", "paused"]) {
      const memory = createMemoryDb();
      memory.insertRow("managed_venice_proxy_keys", {
        id: "key_1", account_id: "account_1", user_id: "user_1", status,
        paused_reason: "original-reason", revoked_at: status === "revoked" ? "original-revocation" : null,
      });
      await markManagedVeniceReconciliationRequired({
        userId: "user_1", proxyKeyId: "key_1", referenceId: "late-usage", reason: "managed_venice_overage_uncovered",
      }, memory.db);
      expect(memory.tables.managed_venice_reconciliation_items).toHaveLength(1);
      expect(memory.tables.managed_venice_proxy_keys[0]).toMatchObject({ status, paused_reason: "original-reason" });
    }
  });
});
