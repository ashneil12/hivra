import {
  CRYPTO_TOPUP_ASSETS,
  cryptoCreditsToUsdcMinorUnits,
  createCryptoTopUpIntent,
  getCryptoTopUpAssets,
  isCryptoTopUpAssetKey,
  settleCryptoTopUpIntent,
} from "@/lib/billing/crypto-topups";

function createPaymentDb() {
  const transactions: Array<Record<string, unknown>> = [];
  const yearlyTokenQuotes: Array<Record<string, unknown>> = [];
  const depositQuotes: Array<Record<string, unknown>> = [];
  const managedVeniceTokenQuotes: Array<Record<string, unknown>> = [];

  function matches(row: Record<string, unknown>, filters: Array<[string, "eq" | "lt", unknown]>) {
    return filters.every(([column, op, value]) => {
      const actual = row[column];
      if (op === "eq") return actual === value;
      return String(actual ?? "") < String(value);
    });
  }

  function queryFor(rows: Array<Record<string, unknown>>, patch?: Record<string, unknown>) {
    const filters: Array<[string, "eq" | "lt", unknown]> = [];
    const query: {
      eq: jest.Mock;
      lt: jest.Mock;
      order: jest.Mock;
      limit: jest.Mock;
      then: Promise<{ data: Array<Record<string, unknown>> | null; error: null }>["then"];
    } = {} as {
      eq: jest.Mock;
      lt: jest.Mock;
      order: jest.Mock;
      limit: jest.Mock;
      then: Promise<{ data: Array<Record<string, unknown>> | null; error: null }>["then"];
    };
    query.eq = jest.fn((column: string, value: unknown) => {
      filters.push([column, "eq", value]);
      return query;
    });
    query.lt = jest.fn((column: string, value: unknown) => {
      filters.push([column, "lt", value]);
      return query;
    });
    query.order = jest.fn(() => query);
    query.limit = jest.fn(() => query);
    query.then = (resolve, reject) => {
      const matched = rows.filter((row) => matches(row, filters));
      if (patch) {
        for (const row of matched) Object.assign(row, patch);
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      }
      return Promise.resolve({ data: matched, error: null }).then(resolve, reject);
    };
    return query;
  }

  return {
    transactions,
    yearlyTokenQuotes,
    depositQuotes,
    db: {
      from: jest.fn((name: string) => {
        if (name === "yearly_token_quotes") {
          return {
            select: jest.fn(() => queryFor(yearlyTokenQuotes)),
            update: jest.fn((patch: Record<string, unknown>) => queryFor(yearlyTokenQuotes, patch)),
          };
        }
        if (name === "deposit_quotes") {
          return {
            select: jest.fn(() => queryFor(depositQuotes)),
            update: jest.fn((patch: Record<string, unknown>) => queryFor(depositQuotes, patch)),
          };
        }
        if (name === "managed_venice_token_quotes") {
          return {
            select: jest.fn(() => queryFor(managedVeniceTokenQuotes)),
            update: jest.fn((patch: Record<string, unknown>) => queryFor(managedVeniceTokenQuotes, patch)),
          };
        }
        if (name !== "payment_transactions") throw new Error(`Unexpected table ${name}`);
        return {
          select: jest.fn(() => queryFor(transactions)),
          update: jest.fn((patch: Record<string, unknown>) => queryFor(transactions, patch)),
          upsert: jest.fn(async (row: Record<string, unknown>) => {
            transactions.push(row);
            return { error: null };
          }),
        };
      }),
    },
  };
}

function createSettlementDb(initialPayment?: Record<string, unknown>) {
  const accounts = new Map<
    string,
    {
      id: string;
      user_id: string;
      balance_cached_credits: number;
      stripe_customer_id: string | null;
    }
  >();
  const ledger: Array<Record<string, unknown>> = [];
  const ledgerKeys = new Set<string>();
  const payments = new Map<string, Record<string, unknown>>();

  if (initialPayment) {
    payments.set(String(initialPayment.provider_reference_id), initialPayment);
  }

  function creditAccountsTable() {
    return {
      upsert: (row: { user_id: string }) => ({
        select: () => ({
          single: async () => {
            const existing = accounts.get(row.user_id);
            if (existing) return { data: existing, error: null };

            const created = {
              id: `acct_${accounts.size + 1}`,
              user_id: row.user_id,
              balance_cached_credits: 0,
              stripe_customer_id: null,
            };
            accounts.set(row.user_id, created);
            return { data: created, error: null };
          },
        }),
      }),
      update: (patch: Record<string, unknown>) => ({
        eq: async (_column: string, id: string) => {
          for (const account of accounts.values()) {
            if (account.id === id) Object.assign(account, patch);
          }
          return { error: null };
        },
      }),
    };
  }

  function ledgerTable() {
    return {
      insert: async (row: Record<string, unknown>) => {
        const key = `${row.source}:${row.reference_id}:${row.reason}`;
        if (ledgerKeys.has(key)) {
          return { error: { code: "23505", message: "duplicate key" } };
        }

        ledgerKeys.add(key);
        ledger.push(row);
        return { error: null };
      },
      select: () => ({
        eq: async (_column: string, userId: string) => ({
          data: ledger.filter((entry) => entry.user_id === userId),
          error: null,
        }),
      }),
    };
  }

  function paymentTransactionsTable() {
    const filters: Record<string, unknown> = {};
    const selectQuery: {
      select: jest.Mock;
      eq: jest.Mock;
      maybeSingle: jest.Mock;
    } = {} as {
      select: jest.Mock;
      eq: jest.Mock;
      maybeSingle: jest.Mock;
    };
    selectQuery.select = jest.fn(() => selectQuery);
    selectQuery.eq = jest.fn((column: string, value: unknown) => {
      filters[column] = value;
      return selectQuery;
    });
    selectQuery.maybeSingle = jest.fn(async () => {
      const payment = Array.from(payments.values()).find((entry) =>
        entry.provider === filters.provider &&
        entry.provider_reference_id === filters.provider_reference_id
      );
      return { data: payment || null, error: null };
    });

    return {
      upsert: async (row: Record<string, unknown>) => {
        payments.set(String(row.provider_reference_id), row);
        return { error: null };
      },
      select: selectQuery.select,
      eq: selectQuery.eq,
      maybeSingle: selectQuery.maybeSingle,
      update: (patch: Record<string, unknown>) => {
        const updateFilters: Record<string, unknown> = {};
        const updateQuery: {
          eq: jest.Mock;
          then: Promise<{ error: null }>["then"];
        } = {} as {
          eq: jest.Mock;
          then: Promise<{ error: null }>["then"];
        };
        updateQuery.eq = jest.fn((column: string, value: unknown) => {
          updateFilters[column] = value;
          return updateQuery;
        });
        updateQuery.then = (resolve, reject) => {
          for (const payment of payments.values()) {
            if (
              payment.provider === updateFilters.provider &&
              payment.provider_reference_id === updateFilters.provider_reference_id
            ) {
              Object.assign(payment, patch);
            }
          }
          return Promise.resolve({ error: null }).then(resolve, reject);
        };
        return updateQuery;
      },
    };
  }

  return {
    db: {
      from: jest.fn((name: string) => {
        if (name === "credit_accounts") return creditAccountsTable();
        if (name === "credit_ledger_entries") return ledgerTable();
        if (name === "payment_transactions") return paymentTransactionsTable();
        throw new Error(`Unexpected table ${name}`);
      }),
    },
    ledger,
    payments,
  };
}

const now = new Date("2026-04-24T12:00:00.000Z");
const depositAddress = "0x000000000000000000000000000000000000dEaD";
const normalizedDepositAddress = "0x000000000000000000000000000000000000dead";
const pendingPayment = {
  id: "payment_1",
  user_id: "user_123",
  provider: "bankr",
  provider_reference_id: "bankr_crypto_topup:test",
  status: "pending",
  asset: "usdc_base",
  amount_minor: 10_000_000,
  package_credits: 1000,
  metadata: {
    type: "crypto_topup_intent",
    creditGrantStatus: "pending_detection",
  },
};

describe("crypto top-up intents", () => {
  it("exposes only Base crypto assets for the first crypto rail", () => {
    expect(getCryptoTopUpAssets()).toEqual([
      CRYPTO_TOPUP_ASSETS.usdc_base,
      CRYPTO_TOPUP_ASSETS.hermesos_base,
    ]);
    expect(CRYPTO_TOPUP_ASSETS.usdc_base.topUpEnabled).toBe(true);
    expect(CRYPTO_TOPUP_ASSETS.hermesos_base.topUpEnabled).toBe(false);
    expect(isCryptoTopUpAssetKey("usdc_base")).toBe(true);
    expect(isCryptoTopUpAssetKey("ethereum")).toBe(false);
  });

  it("converts credit packages into USDC minor units", () => {
    expect(cryptoCreditsToUsdcMinorUnits(500)).toBe(5_000_000);
    expect(cryptoCreditsToUsdcMinorUnits(1000)).toBe(10_000_000);
    expect(cryptoCreditsToUsdcMinorUnits(2500)).toBe(25_000_000);
    expect(cryptoCreditsToUsdcMinorUnits(5000)).toBe(50_000_000);
  });

  it("creates a pending Bankr payment transaction without granting credits", async () => {
    const { db, transactions } = createPaymentDb();

    const intent = await createCryptoTopUpIntent({
      userId: "user_123",
      asset: "usdc_base",
      packageCredits: 1000,
      depositWallet: {
        address: depositAddress,
        bankrWalletId: "wlt_A1b2C3d4",
      },
      db,
      referenceId: "bankr_crypto_topup:test",
      now,
    });

    expect(intent).toEqual({
      referenceId: "bankr_crypto_topup:test",
      status: "pending",
      provider: "bankr",
      packageCredits: 1000,
      creditUnit: "100 credits = $1",
      asset: CRYPTO_TOPUP_ASSETS.usdc_base,
      amountMinor: 10_000_000,
      amountDisplay: "10",
      depositAddress: normalizedDepositAddress,
      bankrWalletId: "wlt_A1b2C3d4",
    });
    expect(transactions).toEqual([
      expect.objectContaining({
        user_id: "user_123",
        provider: "bankr",
        provider_reference_id: "bankr_crypto_topup:test",
        idempotency_reference: "bankr_crypto_topup:test",
        status: "pending",
        asset: "usdc_base",
        amount_minor: 10_000_000,
        package_credits: 1000,
        metadata: expect.objectContaining({
          type: "crypto_topup_intent",
          chainId: 8453,
          network: "Base",
          tokenSymbol: "USDC",
          amountDisplay: "10",
          depositAddress: normalizedDepositAddress,
          bankrWalletId: "wlt_A1b2C3d4",
          creditGrantStatus: "pending_detection",
        }),
      }),
    ]);
    expect(JSON.stringify(transactions)).not.toContain("ledger");
  });

  it("blocks a new top-up while a yearly token payment is active on the shared wallet", async () => {
    const { db, transactions, yearlyTokenQuotes } = createPaymentDb();
    yearlyTokenQuotes.push({
      id: "yq_1",
      user_id: "user_123",
      tier: "pro",
      status: "active",
      quoted_at: "2026-04-24T11:59:00.000Z",
      expires_at: "2026-04-24T12:19:00.000Z",
      metadata: {},
    });

    await expect(
      createCryptoTopUpIntent({
        userId: "user_123",
        asset: "usdc_base",
        packageCredits: 1000,
        depositWallet: {
          address: depositAddress,
          bankrWalletId: "wlt_A1b2C3d4",
        },
        db,
        referenceId: "bankr_crypto_topup:blocked",
        now,
      })
    ).rejects.toThrow(/already active/i);

    expect(transactions).toHaveLength(0);
  });

  it("expires stale pending top-ups before creating a fresh payment session", async () => {
    const { db, transactions } = createPaymentDb();
    transactions.push({
      id: "payment_old",
      user_id: "user_123",
      provider: "bankr",
      provider_reference_id: "bankr_crypto_topup:old",
      status: "pending",
      asset: "usdc_base",
      amount_minor: 10_000_000,
      package_credits: 1000,
      created_at: "2026-04-24T11:20:00.000Z",
      updated_at: "2026-04-24T11:20:00.000Z",
      metadata: {
        type: "crypto_topup_intent",
        createdAt: "2026-04-24T11:20:00.000Z",
      },
    });

    const intent = await createCryptoTopUpIntent({
      userId: "user_123",
      asset: "usdc_base",
      packageCredits: 500,
      depositWallet: { address: depositAddress },
      db,
      referenceId: "bankr_crypto_topup:fresh",
      now,
    });

    expect(intent.referenceId).toBe("bankr_crypto_topup:fresh");
    expect(transactions[0]).toEqual(expect.objectContaining({
      status: "failed",
      metadata: expect.objectContaining({
        creditGrantStatus: "expired",
        failureType: "crypto_payment_session_expired",
      }),
    }));
    expect(transactions).toHaveLength(2);
  });

  it("rejects unsupported packages, assets, and non-quoted token assets", async () => {
    const { db } = createPaymentDb();

    await expect(
      createCryptoTopUpIntent({
        userId: "user_123",
        asset: "usdc_base",
        packageCredits: 750,
        depositWallet: { address: depositAddress },
        db,
      })
    ).rejects.toThrow(/Invalid credit top-up package/);

    await expect(
      createCryptoTopUpIntent({
        userId: "user_123",
        asset: "hermesos_base",
        packageCredits: 500,
        depositWallet: { address: depositAddress },
        db,
      })
    ).rejects.toThrow(/not enabled/);
  });

  it("settles a verified crypto top-up exactly once", async () => {
    const { db, ledger, payments } = createSettlementDb({ ...pendingPayment });

    const first = await settleCryptoTopUpIntent({
      referenceId: "bankr_crypto_topup:test",
      transactionHash: "0xabc123",
      detectedAt: "2026-04-24T12:02:00.000Z",
      now,
      db,
    });
    const second = await settleCryptoTopUpIntent({
      referenceId: "bankr_crypto_topup:test",
      transactionHash: "0xabc123",
      detectedAt: "2026-04-24T12:02:00.000Z",
      now,
      db,
    });

    expect(first).toEqual({
      status: "settled",
      inserted: true,
      balance: 1000,
    });
    expect(second).toEqual({
      status: "settled",
      inserted: false,
      balance: 1000,
    });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toEqual(expect.objectContaining({
      user_id: "user_123",
      amount_credits: 1000,
      source: "bankr",
      actor: "bankr_reconciler",
      reason: "crypto_topup",
      reference_id: "bankr_crypto_topup:test",
      metadata: expect.objectContaining({
        paymentTransactionId: "payment_1",
        asset: "usdc_base",
        amountMinor: 10_000_000,
        transactionHash: "0xabc123",
      }),
    }));
    expect(payments.get("bankr_crypto_topup:test")).toEqual(expect.objectContaining({
      status: "succeeded",
      metadata: expect.objectContaining({
        creditGrantStatus: "granted",
        settlement: {
          actor: "bankr_reconciler",
          transactionHash: "0xabc123",
          detectedAt: "2026-04-24T12:02:00.000Z",
          settledAt: now.toISOString(),
        },
      }),
    }));
  });

  it("credits the ledger BEFORE marking the payment succeeded (partial-failure regression)", async () => {
    // Regression guard: previously this function marked the payment row
    // `succeeded` first and then inserted the credit ledger entry. If the
    // ledger insert died after the payment update (DB blip, process kill),
    // the user was paid-but-uncredited and the reconciler would never re-pick
    // the row because it only re-processes `pending` rows.
    //
    // Simulate: payment-update returns an error. Assert the ledger row IS
    // still present (proving insert ran first), the payment row is still
    // `pending` (proving the failed update didn't half-flip it), and a
    // retry settles cleanly without double-crediting.
    const { db, ledger, payments } = createSettlementDb({ ...pendingPayment });

    // Patch the from() factory so the payment_transactions UPDATE fails the
    // first time. Read paths and ledger writes go through the real fakes.
    type LooseTable = {
      update: (patch: Record<string, unknown>) => unknown;
      [key: string]: unknown;
    };
    const originalFrom = db.from as unknown as (name: string) => LooseTable;
    let updateAttempt = 0;
    (db as { from: unknown }).from = jest.fn((name: string): LooseTable => {
      const base = originalFrom(name);
      if (name !== "payment_transactions") return base;
      const originalUpdate = base.update.bind(base);
      return {
        ...base,
        update: (patch: Record<string, unknown>) => {
          updateAttempt += 1;
          if (updateAttempt === 1) {
            // First attempt: simulate DB blip on the .eq().eq() chain end.
            return {
              eq: () => ({
                eq: () => Promise.resolve({ error: { message: "simulated DB blip" } }),
              }),
            } as never;
          }
          return originalUpdate(patch);
        },
      };
    });

    await expect(
      settleCryptoTopUpIntent({
        referenceId: "bankr_crypto_topup:test",
        now,
        db,
      })
    ).rejects.toThrow(/simulated DB blip|Failed to update/);

    // The critical assertion: ledger MUST already have the entry. Before the
    // swap, this was zero — payment was marked succeeded, then ledger insert
    // would have been the failing step.
    expect(ledger).toHaveLength(1);
    expect(payments.get("bankr_crypto_topup:test")?.status).toBe("pending");

    // Retry now lets the second update attempt through; ledger insert is a
    // no-op via the (source, reference_id, reason) unique conflict.
    const retry = await settleCryptoTopUpIntent({
      referenceId: "bankr_crypto_topup:test",
      now,
      db,
    });
    expect(retry.status).toBe("settled");
    expect(retry.inserted).toBe(false);
    expect(ledger).toHaveLength(1);
    expect(payments.get("bankr_crypto_topup:test")?.status).toBe("succeeded");
  });

  it("does not settle missing or failed crypto top-up intents", async () => {
    const missing = createSettlementDb();
    await expect(
      settleCryptoTopUpIntent({
        referenceId: "bankr_crypto_topup:missing",
        db: missing.db,
      })
    ).resolves.toEqual({ status: "not_found" });

    const failed = createSettlementDb({
      ...pendingPayment,
      status: "failed",
    });
    await expect(
      settleCryptoTopUpIntent({
        referenceId: "bankr_crypto_topup:test",
        db: failed.db,
      })
    ).resolves.toEqual({
      status: "not_settleable",
      paymentStatus: "failed",
    });
  });
});
