// `withdrawal-history.ts` is a `server-only` module. Under jest (node env, no
// `react-server` export condition) the real `server-only` package throws on
// import, so stub it to a no-op the way a Server Component runtime would.
jest.mock("server-only", () => ({}));

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: null,
}));

import {
  getUserWithdrawalHistory,
  normalizeWithdrawalHistoryLimit,
} from "../withdrawal-history";

// Minimal supabase read stub: from().select().eq().order().limit() resolves to
// { data, error }. Captures the table name + filters so we can assert the query
// is user-scoped and newest-first.
function makeReadDb(result: { data: unknown; error: unknown }) {
  const calls = {
    table: null as string | null,
    selected: null as unknown,
    eqArgs: [] as unknown[][],
    orderArgs: [] as unknown[][],
    limit: null as number | null,
  };
  type Chain = {
    eq: (...args: unknown[]) => Chain;
    order: (...args: unknown[]) => Chain;
    limit: (count: number) => Promise<{ data: unknown; error: unknown }>;
  };
  const limit = jest.fn(async (count: number) => {
    calls.limit = count;
    return result;
  });
  const order = jest.fn((...args: unknown[]): Chain => {
    calls.orderArgs.push(args);
    return chain;
  });
  const eq = jest.fn((...args: unknown[]): Chain => {
    calls.eqArgs.push(args);
    return chain;
  });
  const chain: Chain = { eq, order, limit };
  const select = jest.fn((cols: unknown): Chain => {
    calls.selected = cols;
    return chain;
  });
  const db = {
    from: jest.fn((table: string) => {
      calls.table = table;
      return { select };
    }),
  };
  return { db: db as never, calls, select, eq, order, limit };
}

describe("normalizeWithdrawalHistoryLimit", () => {
  it("defaults, clamps, and floors", () => {
    expect(normalizeWithdrawalHistoryLimit(undefined)).toBe(25);
    expect(normalizeWithdrawalHistoryLimit("not-a-number")).toBe(25);
    expect(normalizeWithdrawalHistoryLimit(0)).toBe(1);
    expect(normalizeWithdrawalHistoryLimit(9999)).toBe(100);
    expect(normalizeWithdrawalHistoryLimit("7")).toBe(7);
    expect(normalizeWithdrawalHistoryLimit(7.9)).toBe(7);
  });
});

describe("getUserWithdrawalHistory", () => {
  it("reads bankr_withdrawals scoped to the user, newest-first, and maps rows", async () => {
    const { db, calls } = makeReadDb({
      data: [
        {
          id: "wd_1",
          status: "submitted",
          amount_raw: "2500000",
          recipient: "0x1111111111111111111111111111111111111111",
          tx_hash: "0xabc",
          chain: "base",
          token_symbol: "USDC",
          token_address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
          token_decimals: 6,
          error_message: null,
          created_at: "2026-06-13T01:00:00.000Z",
          updated_at: "2026-06-13T01:05:00.000Z",
        },
        {
          id: "wd_2",
          status: "failed",
          amount_raw: 1000000,
          recipient: null,
          tx_hash: null,
          chain: "base",
          token_symbol: "HERMESOS",
          token_address: null,
          token_decimals: 18,
          error_message: "transfer rejected",
          created_at: "2026-06-12T01:00:00.000Z",
          updated_at: "2026-06-12T01:05:00.000Z",
        },
      ],
      error: null,
    });

    const result = await getUserWithdrawalHistory("user_777", { limit: 10, db });

    expect(calls.table).toBe("bankr_withdrawals");
    expect(calls.eqArgs).toContainEqual(["user_id", "user_777"]);
    expect(calls.orderArgs).toContainEqual(["created_at", { ascending: false }]);
    expect(calls.limit).toBe(10);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: "wd_1",
      status: "submitted",
      amountRaw: "2500000",
      recipient: "0x1111111111111111111111111111111111111111",
      txHash: "0xabc",
      chain: "base",
      tokenSymbol: "USDC",
      tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      tokenDecimals: 6,
      errorMessage: null,
      createdAt: "2026-06-13T01:00:00.000Z",
      updatedAt: "2026-06-13T01:05:00.000Z",
    });
    // numeric amount_raw is normalized to a string; null token fields preserved.
    expect(result[1]).toMatchObject({
      id: "wd_2",
      status: "failed",
      amountRaw: "1000000",
      recipient: null,
      txHash: null,
      tokenAddress: null,
      errorMessage: "transfer rejected",
    });
  });

  it("clamps the limit via normalizeWithdrawalHistoryLimit", async () => {
    const { db, calls } = makeReadDb({ data: [], error: null });
    await getUserWithdrawalHistory("user_777", { limit: 9999, db });
    expect(calls.limit).toBe(100);
  });

  it("returns an empty array when the table has no rows", async () => {
    const { db } = makeReadDb({ data: null, error: null });
    const result = await getUserWithdrawalHistory("user_777", { db });
    expect(result).toEqual([]);
  });

  it("throws when the read errors", async () => {
    const { db } = makeReadDb({ data: null, error: { message: "boom" } });
    await expect(getUserWithdrawalHistory("user_777", { db })).rejects.toThrow("boom");
  });

  it("throws when no DB client is configured (fail closed)", async () => {
    // No db passed and supabaseAdmin is mocked null → requireDb throws.
    await expect(getUserWithdrawalHistory("user_777")).rejects.toThrow("Database not configured");
  });

  it("maps an unknown status to in_flight", async () => {
    const { db } = makeReadDb({
      data: [
        {
          id: "wd_x",
          status: "weird",
          amount_raw: null,
          recipient: null,
          tx_hash: null,
          chain: null,
          token_symbol: null,
          token_address: null,
          token_decimals: null,
          error_message: null,
          created_at: null,
          updated_at: null,
        },
      ],
      error: null,
    });
    const result = await getUserWithdrawalHistory("user_777", { db });
    expect(result[0].status).toBe("in_flight");
    expect(result[0].amountRaw).toBeNull();
    expect(result[0].tokenDecimals).toBeNull();
  });
});
