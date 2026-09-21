import { HERMESOS_TOKEN_ADDRESS } from "@/lib/billing/token-holdings";
import {
  computeBackoffDelayMs,
  isRetryableRpcError,
  reconcileManagedVeniceTokenQuote,
  reconcilePendingManagedVeniceTokenQuotes,
  RpcHttpError,
  type RpcRetryConfig,
} from "@/lib/billing/managed-venice-token-reconciliation";

type Row = Record<string, unknown>;

function createQuery(rows: Row[]) {
  const filters: Array<[string, unknown]> = [];
  const inFilters: Array<[string, unknown[]]> = [];
  let limitCount: number | null = null;
  let orderColumn: string | null = null;
  let orderAscending = true;
  const query: {
    select: () => typeof query;
    eq: (column: string, value: unknown) => typeof query;
    in: (column: string, values: unknown[]) => typeof query;
    order: (column: string, options?: { ascending?: boolean }) => typeof query;
    limit: (count: number) => Promise<{ data: Row[]; error: null }>;
    maybeSingle: () => Promise<{ data: Row | null; error: null }>;
  } = {} as typeof query;

  query.select = () => query;
  query.eq = (column, value) => {
    filters.push([column, value]);
    return query;
  };
  query.in = (column, values) => {
    inFilters.push([column, values]);
    return query;
  };
  query.order = (column, options) => {
    orderColumn = column;
    orderAscending = options?.ascending !== false;
    return query;
  };

  function filteredRows() {
    let selected = rows.filter((row) =>
      filters.every(([column, value]) => row[column] === value) &&
      inFilters.every(([column, values]) => values.includes(row[column]))
    );
    if (orderColumn) {
      selected = [...selected].sort((a, b) => {
        const left = String(a[orderColumn!] ?? "");
        const right = String(b[orderColumn!] ?? "");
        return orderAscending ? left.localeCompare(right) : right.localeCompare(left);
      });
    }
    return limitCount === null ? selected : selected.slice(0, limitCount);
  }

  query.limit = async (count) => {
    limitCount = count;
    return { data: filteredRows(), error: null };
  };
  query.maybeSingle = async () => ({
    data: filteredRows()[0] ?? null,
    error: null,
  });

  return query;
}

function createMemoryDb(rows: Row[]) {
  return {
    from: (name: string) => {
      if (name !== "managed_venice_token_quotes") {
        throw new Error(`Unexpected table ${name}`);
      }
      return {
        select: () => createQuery(rows),
      };
    },
  };
}

const quoteRow = {
  id: "quote_1",
  account_id: "account_1",
  user_id: "user_1",
  token_amount_raw: "1001202000000000000000000",
  snapshot_price_usd: "0.000009988",
  locked_value_micro_usd: 10_000_005,
  deposit_address: "0x000000000000000000000000000000000000ba5e",
  quoted_at: "2026-05-16T10:20:00.000Z",
  expires_at: "2026-05-16T10:40:00.000Z",
  status: "active",
  source: "dexscreener",
  cross_check_source: null,
  cross_check_price_usd: null,
  price_last_updated_at: "2026-05-16T10:19:30.000Z",
  cross_check_last_updated_at: null,
  transaction_hash: null,
  settled_at: null,
  metadata: {
    managedVeniceTopUp: {
      paidValueMicroUsd: 10_000_000,
      creditValueMicroUsd: 12_000_000,
      bonusValueMicroUsd: 2_000_000,
    },
  },
};

const transferTopic =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const toTopic =
  "0x000000000000000000000000000000000000000000000000000000000000ba5e";

function makeFetchWithLogs(
  logs: Array<Record<string, unknown>>,
  options: { latestBlockHex?: string } = {}
) {
  return jest.fn(async (_input: string, init: { body: string }) => {
    const request = JSON.parse(init.body) as { method: string; params: unknown[] };
    if (request.method === "eth_blockNumber") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: options.latestBlockHex ?? "0x6e",
        }),
      };
    }
    if (request.method === "eth_getLogs") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: "2.0", id: 1, result: logs }),
      };
    }
    if (request.method === "eth_getBlockByNumber") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: { number: "0x6d", timestamp: "0x6a0844d5" },
        }),
      };
    }
    throw new Error(`Unexpected RPC method ${request.method}`);
  });
}

function makeFetchWithLogsByToTopic(
  logsByToTopic: Record<string, Array<Record<string, unknown>>>,
  options: { latestBlockHex?: string } = {}
) {
  return jest.fn(async (_input: string, init: { body: string }) => {
    const request = JSON.parse(init.body) as { method: string; params: unknown[] };
    if (request.method === "eth_blockNumber") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: options.latestBlockHex ?? "0x6e",
        }),
      };
    }
    if (request.method === "eth_getLogs") {
      const filter = request.params[0] as { topics?: unknown[] };
      const to = typeof filter.topics?.[2] === "string" ? filter.topics[2] : "";
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: "2.0", id: 1, result: logsByToTopic[to] ?? [] }),
      };
    }
    if (request.method === "eth_getBlockByNumber") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: { number: "0x6d", timestamp: "0x6a0844d5" },
        }),
      };
    }
    throw new Error(`Unexpected RPC method ${request.method}`);
  });
}

describe("managed Venice token quote reconciliation", () => {
  it("settles a confirmed exact Hivra transfer to the quote deposit address", async () => {
    const settleQuote = jest.fn(async () => ({ status: "settled" as const, quoteId: "quote_1" }));
    const fetchImpl = makeFetchWithLogs([
      {
        address: HERMESOS_TOKEN_ADDRESS,
        topics: [
          transferTopic,
          "0x0000000000000000000000001111111111111111111111111111111111111111",
          toTopic,
        ],
        data: `0x${BigInt(quoteRow.token_amount_raw).toString(16)}`,
        transactionHash: "0xpaid",
        logIndex: "0x0",
        blockNumber: "0x6d",
        blockHash: "0xblock",
      },
    ]);

    const result = await reconcileManagedVeniceTokenQuote({
      quoteId: "quote_1",
      userId: "user_1",
      db: createMemoryDb([quoteRow]),
      rpcUrl: "https://base.test",
      fetchImpl,
      minConfirmations: 2,
      settleQuote,
      now: new Date("2026-05-16T10:22:00.000Z"),
    });

    expect(result.status).toBe("settled");
    expect(settleQuote).toHaveBeenCalledWith(
      {
        quoteId: "quote_1",
        transactionHash: "0xpaid",
        tokenAmountRaw: quoteRow.token_amount_raw,
        observedAt: "2026-05-16T10:22:00.000Z",
        blockTimestamp: "2026-05-16T10:20:05.000Z",
      },
      expect.anything()
    );
  });

  it("matches an over-send and settles it for the ACTUAL received amount (not no_match)", async () => {
    const settleQuote = jest.fn(async () => ({ status: "settled" as const, quoteId: "quote_1" }));
    // User sent 10% more than quoted — real money, inside the over-send ceiling.
    const overSentAmount = (BigInt(quoteRow.token_amount_raw) * 11n) / 10n;
    const fetchImpl = makeFetchWithLogs([
      {
        address: HERMESOS_TOKEN_ADDRESS,
        topics: [
          transferTopic,
          "0x0000000000000000000000001111111111111111111111111111111111111111",
          toTopic,
        ],
        data: `0x${overSentAmount.toString(16)}`,
        transactionHash: "0xoverpaid",
        logIndex: "0x0",
        blockNumber: "0x6d",
        blockHash: "0xblock",
      },
    ]);

    const result = await reconcileManagedVeniceTokenQuote({
      quoteId: "quote_1",
      userId: "user_1",
      db: createMemoryDb([quoteRow]),
      rpcUrl: "https://base.test",
      fetchImpl,
      minConfirmations: 2,
      settleQuote,
      now: new Date("2026-05-16T10:22:00.000Z"),
    });

    expect(result.status).toBe("settled");
    // The reconciler hands settle the OBSERVED on-chain amount, not the quote.
    expect(settleQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        quoteId: "quote_1",
        transactionHash: "0xoverpaid",
        tokenAmountRaw: overSentAmount.toString(),
      }),
      expect.anything()
    );
  });

  it("prefers the exact transfer over a co-present over-send (tightest match wins)", async () => {
    const settleQuote = jest.fn(async () => ({ status: "settled" as const, quoteId: "quote_1" }));
    const overSentAmount = (BigInt(quoteRow.token_amount_raw) * 12n) / 10n;
    const fetchImpl = makeFetchWithLogs([
      {
        address: HERMESOS_TOKEN_ADDRESS,
        topics: [transferTopic, "0x0", toTopic],
        data: `0x${overSentAmount.toString(16)}`,
        transactionHash: "0xover",
        logIndex: "0x0",
        blockNumber: "0x6c",
        blockHash: "0xblock",
      },
      {
        address: HERMESOS_TOKEN_ADDRESS,
        topics: [transferTopic, "0x0", toTopic],
        data: `0x${BigInt(quoteRow.token_amount_raw).toString(16)}`,
        transactionHash: "0xexact",
        logIndex: "0x1",
        blockNumber: "0x6d",
        blockHash: "0xblock",
      },
    ]);

    const result = await reconcileManagedVeniceTokenQuote({
      quoteId: "quote_1",
      userId: "user_1",
      db: createMemoryDb([quoteRow]),
      rpcUrl: "https://base.test",
      fetchImpl,
      minConfirmations: 2,
      settleQuote,
      now: new Date("2026-05-16T10:22:00.000Z"),
    });

    expect(result.status).toBe("settled");
    expect(settleQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionHash: "0xexact",
        tokenAmountRaw: quoteRow.token_amount_raw,
      }),
      expect.anything()
    );
  });

  it("does NOT match a wildly-over transfer beyond the 2x ceiling (stays no_match)", async () => {
    const settleQuote = jest.fn();
    const fatFinger = BigInt(quoteRow.token_amount_raw) * 3n;
    const fetchImpl = makeFetchWithLogs([
      {
        address: HERMESOS_TOKEN_ADDRESS,
        topics: [transferTopic, "0x0", toTopic],
        data: `0x${fatFinger.toString(16)}`,
        transactionHash: "0xfat",
        logIndex: "0x0",
        blockNumber: "0x6d",
        blockHash: "0xblock",
      },
    ]);

    const result = await reconcileManagedVeniceTokenQuote({
      quoteId: "quote_1",
      userId: "user_1",
      db: createMemoryDb([quoteRow]),
      rpcUrl: "https://base.test",
      fetchImpl,
      minConfirmations: 2,
      settleQuote,
      now: new Date("2026-05-16T10:22:00.000Z"),
    });

    expect(result.status).toBe("no_match");
    expect(settleQuote).not.toHaveBeenCalled();
  });

  it("returns no_match when Base has not seen the exact transfer yet", async () => {
    const settleQuote = jest.fn();

    const result = await reconcileManagedVeniceTokenQuote({
      quoteId: "quote_1",
      userId: "user_1",
      db: createMemoryDb([quoteRow]),
      rpcUrl: "https://base.test",
      fetchImpl: makeFetchWithLogs([]),
      settleQuote,
      now: new Date("2026-05-16T10:22:00.000Z"),
    });

    expect(result.status).toBe("no_match");
    expect(settleQuote).not.toHaveBeenCalled();
  });

  it("chunks Base log scans below provider range limits", async () => {
    const settleQuote = jest.fn();
    const fetchImpl = makeFetchWithLogs([], { latestBlockHex: "0x7530" });

    const result = await reconcileManagedVeniceTokenQuote({
      quoteId: "quote_1",
      userId: "user_1",
      db: createMemoryDb([quoteRow]),
      rpcUrl: "https://base.test",
      fetchImpl,
      lookbackBlocks: 20_000,
      settleQuote,
      now: new Date("2026-05-16T10:22:00.000Z"),
    });

    const logRequests = fetchImpl.mock.calls
      .map(([, init]) => JSON.parse(init.body) as { method: string; params: Array<Record<string, string>> })
      .filter((request) => request.method === "eth_getLogs");

    expect(result.status).toBe("no_match");
    expect(settleQuote).not.toHaveBeenCalled();
    expect(logRequests).toHaveLength(10);

    for (const request of logRequests) {
      const filter = request.params[0];
      const fromBlock = Number.parseInt(filter.fromBlock, 16);
      const toBlock = Number.parseInt(filter.toBlock, 16);
      expect(toBlock - fromBlock + 1).toBeLessThanOrEqual(2_000);
    }
  });

  it("reconciles active and expired quote candidates without a user clicking verify", async () => {
    const expiredQuoteRow = {
      ...quoteRow,
      id: "quote_expired",
      user_id: "user_2",
      token_amount_raw: "2000000000000000000000000",
      deposit_address: "0x000000000000000000000000000000000000cafe",
      status: "expired",
      created_at: "2026-05-16T10:21:00.000Z",
    };
    const settleQuote = jest.fn(async () => ({ status: "settled" as const, quoteId: "quote_1" }));
    const fetchImpl = makeFetchWithLogsByToTopic({
      [toTopic]: [
        {
          address: HERMESOS_TOKEN_ADDRESS,
          topics: [
            transferTopic,
            "0x0000000000000000000000001111111111111111111111111111111111111111",
            toTopic,
          ],
          data: `0x${BigInt(quoteRow.token_amount_raw).toString(16)}`,
          transactionHash: "0xpaid",
          logIndex: "0x0",
          blockNumber: "0x6d",
          blockHash: "0xblock",
        },
      ],
    });

    const summary = await reconcilePendingManagedVeniceTokenQuotes({
      db: createMemoryDb([quoteRow, expiredQuoteRow]),
      rpcUrl: "https://base.test",
      fetchImpl,
      minConfirmations: 2,
      settleQuote,
      now: new Date("2026-05-16T10:22:00.000Z"),
      // Keep the test deterministic + fast: no real wall-clock throttle.
      interQuoteDelayMs: 0,
      rpcSleepImpl: async () => {},
    });

    expect(summary.checked).toBe(2);
    expect(summary.settled).toBe(1);
    expect(summary.noMatch).toBe(1);
    expect(summary.failed).toBe(0);
    expect(settleQuote).toHaveBeenCalledTimes(1);
  });
});

describe("Base RPC 429 resilience (issue #362)", () => {
  describe("isRetryableRpcError", () => {
    it("retries on HTTP 429 (rate-limited)", () => {
      expect(isRetryableRpcError(new RpcHttpError(429))).toBe(true);
    });

    it("retries on 5xx server faults", () => {
      expect(isRetryableRpcError(new RpcHttpError(502))).toBe(true);
      expect(isRetryableRpcError(new RpcHttpError(503))).toBe(true);
    });

    it("retries on raw network failures (TypeError from fetch / ECONNRESET)", () => {
      expect(isRetryableRpcError(new TypeError("fetch failed"))).toBe(true);
      expect(isRetryableRpcError(new Error("read ECONNRESET"))).toBe(true);
      expect(isRetryableRpcError(new Error("socket hang up"))).toBe(true);
    });

    it("does NOT retry deterministic failures (4xx that isn't 429, JSON-RPC error, decode error)", () => {
      expect(isRetryableRpcError(new RpcHttpError(400))).toBe(false);
      expect(isRetryableRpcError(new RpcHttpError(404))).toBe(false);
      expect(isRetryableRpcError(new Error("Base RPC eth_getLogs returned an error: bad params"))).toBe(false);
      expect(isRetryableRpcError(new Error("Invalid block number RPC quantity"))).toBe(false);
    });
  });

  describe("computeBackoffDelayMs", () => {
    const config: RpcRetryConfig = { maxAttempts: 4, baseDelayMs: 250, maxDelayMs: 4000 };

    it("grows exponentially across attempts (with jitter pinned to the ceiling)", () => {
      // random() === 1 picks the top of the full-jitter window, exposing the
      // exponential ceiling for each attempt: base * 2^(attempt-1).
      const ceil = () => 1;
      expect(computeBackoffDelayMs(1, config, ceil)).toBe(250);
      expect(computeBackoffDelayMs(2, config, ceil)).toBe(500);
      expect(computeBackoffDelayMs(3, config, ceil)).toBe(1000);
      expect(computeBackoffDelayMs(4, config, ceil)).toBe(2000);
    });

    it("caps the backoff at maxDelayMs", () => {
      expect(computeBackoffDelayMs(10, config, () => 1)).toBe(4000);
    });

    it("never returns below baseDelayMs even when jitter draws ~0", () => {
      // Full jitter could otherwise collapse the wait to ~0 and re-hammer the
      // endpoint immediately; the floor prevents that.
      expect(computeBackoffDelayMs(3, config, () => 0)).toBe(250);
    });

    it("applies jitter between the floor and the exponential ceiling", () => {
      const delay = computeBackoffDelayMs(3, config, () => 0.5);
      expect(delay).toBeGreaterThanOrEqual(250);
      expect(delay).toBeLessThanOrEqual(1000);
    });
  });

  it("retries a 429 and then settles once the endpoint recovers (no lost deposit)", async () => {
    const settleQuote = jest.fn(async () => ({ status: "settled" as const, quoteId: "quote_1" }));
    const sleeps: number[] = [];
    let blockNumberCalls = 0;

    // First eth_blockNumber call is rate-limited (HTTP 429); the retry succeeds
    // and the rest of the scan finds the matching transfer + settles.
    const fetchImpl = jest.fn(async (_input: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string };
      if (request.method === "eth_blockNumber") {
        blockNumberCalls += 1;
        if (blockNumberCalls === 1) {
          return { ok: false, status: 429, json: async () => ({}) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x6e" }),
        };
      }
      if (request.method === "eth_getLogs") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: "2.0",
            id: 1,
            result: [
              {
                address: HERMESOS_TOKEN_ADDRESS,
                topics: [transferTopic, "0x0", toTopic],
                data: `0x${BigInt(quoteRow.token_amount_raw).toString(16)}`,
                transactionHash: "0xpaid",
                logIndex: "0x0",
                blockNumber: "0x6d",
                blockHash: "0xblock",
              },
            ],
          }),
        };
      }
      if (request.method === "eth_getBlockByNumber") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: "2.0",
            id: 1,
            result: { number: "0x6d", timestamp: "0x6a0844d5" },
          }),
        };
      }
      throw new Error(`Unexpected RPC method ${request.method}`);
    });

    const result = await reconcileManagedVeniceTokenQuote({
      quoteId: "quote_1",
      userId: "user_1",
      db: createMemoryDb([quoteRow]),
      rpcUrl: "https://base.test",
      fetchImpl,
      minConfirmations: 2,
      settleQuote,
      now: new Date("2026-05-16T10:22:00.000Z"),
      rpcOptions: {
        retryConfig: { maxAttempts: 4, baseDelayMs: 10, maxDelayMs: 40 },
        sleepImpl: async (ms: number) => {
          sleeps.push(ms);
        },
        random: () => 1,
      },
    });

    expect(result.status).toBe("settled");
    expect(settleQuote).toHaveBeenCalledTimes(1);
    // The 429 forced exactly one backoff sleep before the retry succeeded.
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(0);
    expect(blockNumberCalls).toBe(2);
  });

  it("re-throws the 429 after exhausting retries (surfaces as a failed quote, not a silent drop)", async () => {
    const settleQuote = jest.fn();
    const sleeps: number[] = [];
    // Always rate-limited: every attempt returns HTTP 429.
    const fetchImpl = jest.fn(async () => ({ ok: false, status: 429, json: async () => ({}) }));

    const summary = await reconcilePendingManagedVeniceTokenQuotes({
      db: createMemoryDb([quoteRow]),
      rpcUrl: "https://base.test",
      fetchImpl: fetchImpl as never,
      settleQuote,
      now: new Date("2026-05-16T10:22:00.000Z"),
      interQuoteDelayMs: 0,
      rpcRetryConfig: { maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 20 },
      rpcSleepImpl: async (ms: number) => {
        sleeps.push(ms);
      },
      rpcRandom: () => 1,
    });

    expect(summary.checked).toBe(1);
    expect(summary.settled).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.results[0].errorMessage).toBe("Base RPC request failed with status 429");
    expect(settleQuote).not.toHaveBeenCalled();
    // maxAttempts=3 → 2 backoff sleeps between the 3 attempts (one eth_blockNumber call, retried).
    expect(sleeps).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry a deterministic JSON-RPC error body (no wasted rate-limit budget)", async () => {
    const settleQuote = jest.fn();
    const sleeps: number[] = [];
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "invalid params" } }),
    }));

    const summary = await reconcilePendingManagedVeniceTokenQuotes({
      db: createMemoryDb([quoteRow]),
      rpcUrl: "https://base.test",
      fetchImpl: fetchImpl as never,
      settleQuote,
      now: new Date("2026-05-16T10:22:00.000Z"),
      interQuoteDelayMs: 0,
      rpcRetryConfig: { maxAttempts: 4, baseDelayMs: 5, maxDelayMs: 20 },
      rpcSleepImpl: async (ms: number) => {
        sleeps.push(ms);
      },
    });

    expect(summary.failed).toBe(1);
    // No retries: a JSON-RPC error body is deterministic, so we fail fast.
    expect(sleeps).toHaveLength(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throttles between quotes to keep request rate under the endpoint limit", async () => {
    const interQuoteSleeps: number[] = [];
    const settleQuote = jest.fn();
    const secondQuoteRow = {
      ...quoteRow,
      id: "quote_2",
      user_id: "user_2",
      deposit_address: "0x000000000000000000000000000000000000cafe",
      created_at: "2026-05-16T10:21:00.000Z",
    };
    const fetchImpl = makeFetchWithLogs([]);

    await reconcilePendingManagedVeniceTokenQuotes({
      db: createMemoryDb([quoteRow, secondQuoteRow]),
      rpcUrl: "https://base.test",
      fetchImpl,
      settleQuote,
      now: new Date("2026-05-16T10:22:00.000Z"),
      interQuoteDelayMs: 123,
      rpcSleepImpl: async (ms: number) => {
        interQuoteSleeps.push(ms);
      },
    });

    // Two quotes → exactly one inter-quote throttle (none before the first).
    expect(interQuoteSleeps).toContain(123);
    expect(interQuoteSleeps.filter((ms) => ms === 123)).toHaveLength(1);
  });
});
