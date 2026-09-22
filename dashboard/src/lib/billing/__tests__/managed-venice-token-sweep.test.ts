import {
  HERMESOS_TOKEN_ADDRESS,
  HERMESOS_TOKEN_DECIMALS,
} from "@/lib/billing/token-holdings";
import {
  sweepManagedVeniceTokenQuote,
  sweepPendingManagedVeniceTokenQuotes,
} from "@/lib/billing/managed-venice-token-sweep";

type Row = Record<string, unknown>;

const now = new Date("2026-05-16T12:00:00.000Z");
const treasuryAddress = "0x000000000000000000000000000000000000D00D";
const normalizedTreasuryAddress = "0x000000000000000000000000000000000000d00d";
const normalizedDepositAddress = "0x000000000000000000000000000000000000ba5e";
const normalizedSharedCreditDepositAddress = "0x000000000000000000000000000000000000c0de";
const tokenAmountRaw = "1000000000000000000000";

function createQuery(rows: Row[]) {
  const filters: Array<{ column: string; operator: "eq" | "in"; value: unknown }> = [];
  let orderedBy: { column: string; ascending: boolean } | null = null;
  let rowLimit: number | null = null;

  const query: {
    select: () => typeof query;
    eq: (column: string, value: unknown) => typeof query;
    in: (column: string, value: unknown[]) => typeof query;
    order: (column: string, options?: { ascending?: boolean }) => typeof query;
    limit: (count: number) => typeof query;
    maybeSingle: () => Promise<{ data: Row | null; error: null }>;
    single: () => Promise<{ data: Row | null; error: null }>;
    then: Promise<{ data: Row[]; error: null }>["then"];
  } = {} as typeof query;

  function filtered() {
    let result = rows.filter((row) =>
      filters.every((filter) => {
        if (filter.operator === "eq") return row[filter.column] === filter.value;
        return Array.isArray(filter.value) && filter.value.includes(row[filter.column]);
      })
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
    return rowLimit === null ? result : result.slice(0, rowLimit);
  }

  query.select = () => query;
  query.eq = (column, value) => {
    filters.push({ column, operator: "eq", value });
    return query;
  };
  query.in = (column, value) => {
    filters.push({ column, operator: "in", value });
    return query;
  };
  query.order = (column, options) => {
    orderedBy = { column, ascending: options?.ascending ?? true };
    return query;
  };
  query.limit = (count) => {
    rowLimit = count;
    return query;
  };
  query.maybeSingle = async () => ({ data: filtered()[0] ?? null, error: null });
  query.single = async () => ({ data: filtered()[0] ?? null, error: null });
  query.then = (resolve, reject) =>
    Promise.resolve({ data: filtered(), error: null }).then(resolve, reject);

  return query;
}

function createUpdate(rows: Row[], patch: Row) {
  const filters: Array<{ column: string; operator: "eq" | "in"; value: unknown }> = [];
  const query: {
    eq: (column: string, value: unknown) => typeof query;
    in: (column: string, value: unknown[]) => typeof query;
    then: Promise<{ error: null }>["then"];
  } = {} as typeof query;

  query.eq = (column, value) => {
    filters.push({ column, operator: "eq", value });
    return query;
  };
  query.in = (column, value) => {
    filters.push({ column, operator: "in", value });
    return query;
  };
  query.then = (resolve, reject) => {
    for (const row of rows) {
      const match = filters.every((filter) => {
        if (filter.operator === "eq") return row[filter.column] === filter.value;
        return Array.isArray(filter.value) && filter.value.includes(row[filter.column]);
      });
      if (match) Object.assign(row, patch);
    }
    return Promise.resolve({ error: null }).then(resolve, reject);
  };

  return query;
}

function createInsert(rows: Row[]) {
  return (row: Row) => {
    const stored = {
      id: row.id ?? `row_${rows.length + 1}`,
      created_at: row.created_at ?? now.toISOString(),
      ...row,
    };
    rows.push(stored);
    return Promise.resolve({ error: null, data: stored });
  };
}

function createMemoryDb(initialQuotes: Row[] = [], initialLots: Row[] = []) {
  const tables: Record<string, Row[]> = {
    managed_venice_token_quotes: initialQuotes,
    // Deposit lots hold the RECEIVED token amount the sweep moves. Quotes with
    // no lot row (legacy settlements) fall back to the quoted amount.
    managed_venice_token_lots: initialLots,
    managed_venice_financial_events: [],
    bankr_deposit_wallet_credentials: [
      {
        id: "credential_1",
        user_id: "user_1",
        purpose: "managed_venice_inference",
        wallet_id: "wallet_1",
        bankr_wallet_id: "wlt_venice_1",
        evm_address: normalizedDepositAddress,
        normalized_evm_address: normalizedDepositAddress,
        api_key_encrypted: "unused-because-sweeps-mint-scoped-key",
        api_key_status: "active",
        allowed_recipient_evm: normalizedTreasuryAddress,
        allowed_ips: [],
        permissions: {},
      },
      {
        id: "credential_credit",
        user_id: "user_1",
        purpose: "credit_deposit",
        wallet_id: "wallet_credit",
        bankr_wallet_id: "wlt_credit",
        evm_address: normalizedSharedCreditDepositAddress,
        normalized_evm_address: normalizedSharedCreditDepositAddress,
        api_key_status: "active",
        allowed_ips: [],
        permissions: {},
      },
    ],
  };

  return {
    tables,
    db: {
      from: (name: string) => {
        const rows = tables[name];
        if (!rows) throw new Error(`Unexpected table ${name}`);
        return {
          select: () => createQuery(rows),
          update: (patch: Row) => createUpdate(rows, patch),
          insert: createInsert(rows),
        };
      },
    },
  };
}

const baseQuote = {
  id: "quote_1",
  account_id: "account_1",
  user_id: "user_1",
  token_amount_raw: tokenAmountRaw,
  locked_value_micro_usd: 50_000_000,
  deposit_address: normalizedDepositAddress,
  status: "settled",
  sweep_status: "pending",
  settled_at: "2026-05-16T11:59:00.000Z",
};

describe("managed Venice token treasury sweeps", () => {
  it("sweeps a settled Hivra quote into the managed Venice treasury", async () => {
    const { db, tables } = createMemoryDb([{ ...baseQuote }]);
    const mintApiKey = jest.fn(async () => "bk_scoped_to_venice_treasury");
    const submitTransfer = jest.fn(async () => "0xsweep");

    const result = await sweepManagedVeniceTokenQuote(baseQuote, {
      db,
      env: {
        MANAGED_VENICE_TREASURY_BASE_ADDRESS: treasuryAddress,
        BANKR_PARTNER_KEY: "bk_partner",
      },
      now,
      readHermesBalance: jest.fn(async () => ({ balanceRaw: tokenAmountRaw })),
      ensureGas: jest.fn(async () => ({ status: "already_funded" as const })),
      mintApiKey,
      submitTransfer,
    });

    expect(result).toEqual({
      quoteId: "quote_1",
      userId: "user_1",
      outcome: "swept",
      txHash: "0xsweep",
      amountSweptDisplay: "1000",
      destinationAddress: normalizedTreasuryAddress,
    });
    expect(mintApiKey).toHaveBeenCalledWith(expect.objectContaining({
      bankrWalletId: "wlt_venice_1",
      recipientAddress: normalizedTreasuryAddress,
    }));
    expect(submitTransfer).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "bk_scoped_to_venice_treasury",
      tokenAddress: HERMESOS_TOKEN_ADDRESS,
      recipientAddress: normalizedTreasuryAddress,
      amountDisplay: "1000",
    }));
    expect(tables.managed_venice_token_quotes[0]).toMatchObject({
      sweep_status: "swept",
      sweep_tx_hash: "0xsweep",
      sweep_destination_address: normalizedTreasuryAddress,
      sweep_error: null,
      sweep_attempted_at: now.toISOString(),
    });
    expect(tables.managed_venice_financial_events).toContainEqual(
      expect.objectContaining({
        user_id: "user_1",
        account_id: "account_1",
        wallet_type: "hermesos",
        event_type: "treasury_sweep",
        reference_id: "quote_1",
        idempotency_key: "managed_venice_treasury_sweep:quote_1:0xsweep",
        token_amount_raw: tokenAmountRaw,
        amount_micro_usd: 50_000_000,
      })
    );
  });

  it("sweeps the RECEIVED amount from the deposit lot so an accepted over-send is not stranded", async () => {
    const receivedRaw = "1100000000000000000000"; // 1.1x the quoted 1000 tokens
    const { db, tables } = createMemoryDb(
      [{ ...baseQuote }],
      [
        {
          id: "lot_1",
          quote_id: "quote_1",
          source: "hermesos_deposit",
          token_amount_raw: receivedRaw,
          original_value_micro_usd: 55_000_000,
          transaction_hash: "0xdeposit",
          metadata: { observedAt: "2026-05-16T11:58:00.000Z" },
        },
      ]
    );
    const submitTransfer = jest.fn(async () => "0xsweep");

    const result = await sweepManagedVeniceTokenQuote(baseQuote, {
      db,
      env: { MANAGED_VENICE_TREASURY_BASE_ADDRESS: treasuryAddress },
      now,
      readHermesBalance: jest.fn(async () => ({ balanceRaw: receivedRaw })),
      ensureGas: jest.fn(async () => ({ status: "already_funded" as const })),
      mintApiKey: jest.fn(async () => "bk_scoped"),
      submitTransfer,
    });

    expect(result).toMatchObject({ outcome: "swept", amountSweptDisplay: "1100" });
    expect(submitTransfer).toHaveBeenCalledWith(expect.objectContaining({ amountDisplay: "1100" }));
    expect(tables.managed_venice_financial_events).toContainEqual(
      expect.objectContaining({
        event_type: "treasury_sweep",
        token_amount_raw: receivedRaw,
        amount_micro_usd: 55_000_000,
      })
    );
  });

  it("still skips when the wallet holds less than the received amount", async () => {
    const receivedRaw = "1100000000000000000000";
    const { db, tables } = createMemoryDb(
      [{ ...baseQuote }],
      [{ id: "lot_1", quote_id: "quote_1", source: "hermesos_deposit", token_amount_raw: receivedRaw, original_value_micro_usd: 55_000_000 }]
    );
    const submitTransfer = jest.fn();

    const result = await sweepManagedVeniceTokenQuote(baseQuote, {
      db,
      env: { MANAGED_VENICE_TREASURY_BASE_ADDRESS: treasuryAddress },
      now,
      readHermesBalance: jest.fn(async () => ({ balanceRaw: tokenAmountRaw })),
      ensureGas: jest.fn(),
      mintApiKey: jest.fn(),
      submitTransfer,
    });

    expect(result.outcome).toBe("no_balance");
    expect(submitTransfer).not.toHaveBeenCalled();
    expect(tables.managed_venice_token_quotes[0]).toMatchObject({
      sweep_status: "skipped",
      sweep_error: `live balance ${tokenAmountRaw} < expected ${receivedRaw}`,
    });
  });

  it("sweeps managed Venice deposits from the shared credit_deposit Bankr wallet", async () => {
    const { db } = createMemoryDb([
      { ...baseQuote, id: "quote_shared", deposit_address: normalizedSharedCreditDepositAddress },
    ]);
    const mintApiKey = jest.fn(async () => "bk_scoped_to_venice_treasury");

    const result = await sweepManagedVeniceTokenQuote(
      { ...baseQuote, id: "quote_shared", deposit_address: normalizedSharedCreditDepositAddress },
      {
        db,
        env: {
          MANAGED_VENICE_TREASURY_BASE_ADDRESS: treasuryAddress,
          BANKR_PARTNER_KEY: "bk_partner",
        },
        now,
        readHermesBalance: jest.fn(async () => ({ balanceRaw: tokenAmountRaw })),
        ensureGas: jest.fn(async () => ({ status: "already_funded" as const })),
        mintApiKey,
        submitTransfer: jest.fn(async () => "0xsweep"),
      }
    );

    expect(result.outcome).toBe("swept");
    expect(mintApiKey).toHaveBeenCalledWith(expect.objectContaining({
      bankrWalletId: "wlt_credit",
      recipientAddress: normalizedTreasuryAddress,
    }));
  });

  it("marks the quote failed when the managed Venice treasury is missing", async () => {
    const { db, tables } = createMemoryDb([{ ...baseQuote }]);

    const result = await sweepManagedVeniceTokenQuote(baseQuote, {
      db,
      env: {},
      now,
      readHermesBalance: jest.fn(),
      ensureGas: jest.fn(),
      mintApiKey: jest.fn(),
      submitTransfer: jest.fn(),
    });

    expect(result.outcome).toBe("no_treasury_configured");
    expect(tables.managed_venice_token_quotes[0]).toMatchObject({
      sweep_status: "failed",
      sweep_attempted_at: now.toISOString(),
    });
    expect(String(tables.managed_venice_token_quotes[0].sweep_error)).toContain(
      "MANAGED_VENICE_TREASURY_BASE_ADDRESS"
    );
  });

  it("skips instead of double-sweeping when the wallet no longer has the quoted balance", async () => {
    const { db, tables } = createMemoryDb([{ ...baseQuote }]);
    const submitTransfer = jest.fn();

    const result = await sweepManagedVeniceTokenQuote(baseQuote, {
      db,
      env: { MANAGED_VENICE_TREASURY_BASE_ADDRESS: treasuryAddress },
      now,
      readHermesBalance: jest.fn(async () => ({ balanceRaw: "0" })),
      ensureGas: jest.fn(),
      mintApiKey: jest.fn(),
      submitTransfer,
    });

    expect(result.outcome).toBe("no_balance");
    expect(submitTransfer).not.toHaveBeenCalled();
    expect(tables.managed_venice_token_quotes[0]).toMatchObject({
      sweep_status: "skipped",
      sweep_error: `live balance 0 < expected ${tokenAmountRaw}`,
    });
  });

  it("records transfer failures so the cron can retry", async () => {
    const { db, tables } = createMemoryDb([{ ...baseQuote }]);

    const result = await sweepManagedVeniceTokenQuote(baseQuote, {
      db,
      env: { MANAGED_VENICE_TREASURY_BASE_ADDRESS: treasuryAddress },
      now,
      readHermesBalance: jest.fn(async () => ({ balanceRaw: tokenAmountRaw })),
      ensureGas: jest.fn(async () => ({ status: "already_funded" as const })),
      mintApiKey: jest.fn(async () => "bk_scoped"),
      submitTransfer: jest.fn(async () => {
        throw new Error("bankr transfer rejected");
      }),
    });

    expect(result.outcome).toBe("transfer_failed");
    expect(tables.managed_venice_token_quotes[0]).toMatchObject({
      sweep_status: "failed",
      sweep_attempted_at: now.toISOString(),
    });
    expect(String(tables.managed_venice_token_quotes[0].sweep_error)).toContain(
      "bankr transfer rejected"
    );
  });

  it("loads only settled pending or failed quotes for retryable sweep", async () => {
    const { db } = createMemoryDb([
      { ...baseQuote, id: "quote_pending", sweep_status: "pending", settled_at: "2026-05-16T10:00:00.000Z" },
      { ...baseQuote, id: "quote_failed", sweep_status: "failed", settled_at: "2026-05-16T10:01:00.000Z" },
      { ...baseQuote, id: "quote_active", status: "active", sweep_status: "pending" },
      { ...baseQuote, id: "quote_swept", sweep_status: "swept" },
    ]);

    const result = await sweepPendingManagedVeniceTokenQuotes({
      db,
      env: { MANAGED_VENICE_TREASURY_BASE_ADDRESS: treasuryAddress },
      now,
      readHermesBalance: jest.fn(async () => ({ balanceRaw: tokenAmountRaw })),
      ensureGas: jest.fn(async () => ({ status: "already_funded" as const })),
      mintApiKey: jest.fn(async () => "bk_scoped"),
      submitTransfer: jest.fn(async () => "0xsweep"),
    });

    expect(result.checked).toBe(2);
    expect(result.swept).toBe(2);
    expect(result.results.map((item) => item.quoteId)).toEqual([
      "quote_pending",
      "quote_failed",
    ]);
    expect(HERMESOS_TOKEN_DECIMALS).toBe(18);
  });
});
