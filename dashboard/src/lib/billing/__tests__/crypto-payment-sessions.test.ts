import {
  ActiveCryptoPaymentSessionError,
  assertNoActiveCryptoPaymentSession,
} from "../crypto-payment-sessions";

type Row = Record<string, unknown>;

function createSessionDb(seed: {
  paymentTransactions?: Row[];
  depositQuotes?: Row[];
  yearlyTokenQuotes?: Row[];
  managedVeniceTokenQuotes?: Row[];
} = {}) {
  const paymentTransactions = [...(seed.paymentTransactions ?? [])];
  const depositQuotes = [...(seed.depositQuotes ?? [])];
  const yearlyTokenQuotes = [...(seed.yearlyTokenQuotes ?? [])];
  const managedVeniceTokenQuotes = [...(seed.managedVeniceTokenQuotes ?? [])];

  function matches(row: Row, filters: Array<[string, "eq" | "lt", unknown]>) {
    return filters.every(([column, op, value]) => {
      const actual = row[column];
      if (op === "eq") return actual === value;
      return String(actual ?? "") < String(value);
    });
  }

  function queryFor(rows: Row[], patch?: Row) {
    const filters: Array<[string, "eq" | "lt", unknown]> = [];
    const query: {
      eq: jest.Mock;
      lt: jest.Mock;
      order: jest.Mock;
      limit: jest.Mock;
      then: Promise<{ data: Row[] | null; error: null }>["then"];
    } = {} as {
      eq: jest.Mock;
      lt: jest.Mock;
      order: jest.Mock;
      limit: jest.Mock;
      then: Promise<{ data: Row[] | null; error: null }>["then"];
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

  const db = {
    from: jest.fn((name: string) => {
      if (name === "payment_transactions") {
        return {
          select: jest.fn(() => queryFor(paymentTransactions)),
          update: jest.fn((patch: Row) => queryFor(paymentTransactions, patch)),
        };
      }
      if (name === "deposit_quotes") {
        return {
          select: jest.fn(() => queryFor(depositQuotes)),
          update: jest.fn((patch: Row) => queryFor(depositQuotes, patch)),
        };
      }
      if (name === "yearly_token_quotes") {
        return {
          select: jest.fn(() => queryFor(yearlyTokenQuotes)),
          update: jest.fn((patch: Row) => queryFor(yearlyTokenQuotes, patch)),
        };
      }
      if (name === "managed_venice_token_quotes") {
        return {
          select: jest.fn(() => queryFor(managedVeniceTokenQuotes)),
          update: jest.fn((patch: Row) => queryFor(managedVeniceTokenQuotes, patch)),
        };
      }
      throw new Error(`Unexpected table ${name}`);
    }),
  };

  return { db, paymentTransactions, depositQuotes, yearlyTokenQuotes, managedVeniceTokenQuotes };
}

const now = new Date("2026-04-24T12:00:00.000Z");

describe("crypto payment sessions", () => {
  it("blocks a new session while a deposit quote is active", async () => {
    const { db } = createSessionDb({
      depositQuotes: [{
        id: "dq_1",
        user_id: "user_123",
        tier: "power",
        status: "active",
        quoted_at: "2026-04-24T11:58:00.000Z",
        expires_at: "2026-04-24T12:18:00.000Z",
        metadata: {},
      }],
    });

    await expect(
      assertNoActiveCryptoPaymentSession({
        userId: "user_123",
        db,
        now,
      })
    ).rejects.toMatchObject({
      session: expect.objectContaining({
        kind: "deposit_quote",
        table: "deposit_quotes",
        id: "dq_1",
      }),
    });
  });

  it("expires stale sessions before checking for an active conflict", async () => {
    const { db, paymentTransactions, yearlyTokenQuotes } = createSessionDb({
      paymentTransactions: [{
        id: "pt_old",
        user_id: "user_123",
        provider: "bankr",
        provider_reference_id: "bankr_crypto_topup:old",
        status: "pending",
        asset: "usdc_base",
        created_at: "2026-04-24T11:30:00.000Z",
        updated_at: "2026-04-24T11:30:00.000Z",
        metadata: { createdAt: "2026-04-24T11:30:00.000Z" },
      }],
      yearlyTokenQuotes: [{
        id: "yq_old",
        user_id: "user_123",
        tier: "pro",
        status: "active",
        quoted_at: "2026-04-24T11:30:00.000Z",
        expires_at: "2026-04-24T11:50:00.000Z",
        metadata: {},
      }],
    });

    await expect(
      assertNoActiveCryptoPaymentSession({
        userId: "user_123",
        db,
        now,
      })
    ).resolves.toBeNull();

    expect(paymentTransactions[0]).toMatchObject({
      status: "failed",
      metadata: expect.objectContaining({
        creditGrantStatus: "expired",
        failureType: "crypto_payment_session_expired",
      }),
    });
    expect(yearlyTokenQuotes[0]).toMatchObject({
      status: "expired",
      updated_at: now.toISOString(),
    });
  });

  it("throws a typed error with safe session details", async () => {
    const { db } = createSessionDb({
      paymentTransactions: [{
        id: "pt_1",
        user_id: "user_123",
        provider: "bankr",
        provider_reference_id: "bankr_crypto_topup:active",
        status: "pending",
        asset: "usdc_base",
        created_at: "2026-04-24T11:59:00.000Z",
        updated_at: "2026-04-24T11:59:00.000Z",
        metadata: {
          type: "crypto_topup_intent",
          amountDisplay: "10",
          tokenSymbol: "USDC",
          depositAddress: "0x000000000000000000000000000000000000dead",
          createdAt: "2026-04-24T11:59:00.000Z",
        },
      }],
    });

    await expect(
      assertNoActiveCryptoPaymentSession({ userId: "user_123", db, now })
    ).rejects.toBeInstanceOf(ActiveCryptoPaymentSessionError);
  });

  it("blocks new crypto sessions while a managed Venice token top-up quote is active", async () => {
    const { db } = createSessionDb({
      managedVeniceTokenQuotes: [{
        id: "mvq_1",
        user_id: "user_123",
        status: "active",
        quoted_at: "2026-04-24T11:59:30.000Z",
        expires_at: "2026-04-24T12:00:30.000Z",
        token_amount_raw: "1000000000000000000000",
        metadata: {},
      }],
    });

    await expect(
      assertNoActiveCryptoPaymentSession({
        userId: "user_123",
        db,
        now,
      })
    ).rejects.toMatchObject({
      session: expect.objectContaining({
        kind: "managed_venice_token_quote",
        table: "managed_venice_token_quotes",
        id: "mvq_1",
      }),
    });
  });
});
