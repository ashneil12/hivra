import {
  CRYPTO_TOPUP_ASSETS,
  cryptoCreditsToUsdcMinorUnits,
  createCryptoTopUpIntent,
  getCryptoTopUpAssets,
  isCryptoTopUpAssetKey,
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

const now = new Date("2026-04-24T12:00:00.000Z");
const depositAddress = "0x000000000000000000000000000000000000dEaD";
const normalizedDepositAddress = "0x000000000000000000000000000000000000dead";
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

  it("lets a new session start once the old one expires, without failing the old intent", async () => {
    // The old intent may have been paid minutes ago: only the reconciler,
    // after checking the chain, may close it.
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
      status: "pending",
      metadata: expect.objectContaining({ type: "crypto_topup_intent" }),
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
});
