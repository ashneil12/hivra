import { HERMESOS_TOKEN_ADDRESS } from "@/lib/billing/token-holdings";
import {
  computeBackoffDelayMs,
  isRetryableRpcError,
  reconcileManagedVeniceTokenQuote,
  reconcilePendingManagedVeniceTokenQuotes,
  RpcHttpError,
  type RpcRetryConfig,
} from "@/lib/billing/managed-venice-token-reconciliation";

import {
  createBaseRpcFake,
  createManagedVeniceMemoryDb,
  managedVeniceQuoteRow,
  TEST_DEPOSIT_ADDRESS,
  type FakeTransfer,
  type MemoryRow,
} from "@/test-utils/managed-venice-memory-db";

type Row = MemoryRow;

// Shared memory DB (the reconciler also reads lots, yearly quotes and binds
// tx hashes, so a quotes-only stub is no longer enough).
function createMemoryDb(rows: Row[]) {
  return createManagedVeniceMemoryDb({ managed_venice_token_quotes: rows }).db;
}

const quoteRow = managedVeniceQuoteRow({
  id: "quote_1",
  account_id: "account_1",
  user_id: "user_1",
  token_amount_raw: "1001202000000000000000000",
  snapshot_price_usd: "0.000009988",
  locked_value_micro_usd: 10_000_005,
  deposit_address: TEST_DEPOSIT_ADDRESS,
  quoted_at: "2026-05-16T10:20:00.000Z",
  expires_at: "2026-05-16T10:40:00.000Z",
  price_last_updated_at: "2026-05-16T10:19:30.000Z",
  metadata: {
    managedVeniceTopUp: {
      paidValueMicroUsd: 10_000_000,
      creditValueMicroUsd: 12_000_000,
      bonusValueMicroUsd: 2_000_000,
    },
  },
});

const transferTopic =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const toTopic =
  "0x000000000000000000000000000000000000000000000000000000000000ba5e";

// Chain head: block 110 at 10:22:00, 2 s blocks (block 109 = 10:21:58,
// block 50 = 10:20:00 = the quote's quotedAt).
const HEAD_BLOCK = 110;
const HEAD_TIME = "2026-05-16T10:22:00.000Z";

function transferAt(block: number, amount: bigint | string, txHash: string, logIndex = 0): FakeTransfer {
  return { txHash, amountRaw: amount, block, logIndex, to: TEST_DEPOSIT_ADDRESS };
}

function makeChain(transfers: FakeTransfer[] = [], head = { block: HEAD_BLOCK, time: HEAD_TIME }) {
  return createBaseRpcFake({ latestBlock: head.block, latestTimestamp: head.time, transfers });
}

describe("managed Venice token quote reconciliation", () => {
  it("settles a confirmed exact Hivra transfer to the quote deposit address", async () => {
    const settleQuote = jest.fn(async () => ({ status: "settled" as const, quoteId: "quote_1" }));
    const chain = makeChain([transferAt(109, BigInt(quoteRow.token_amount_raw as string), "0xpaid")]);

    const result = await reconcileManagedVeniceTokenQuote({
      quoteId: "quote_1",
      userId: "user_1",
      db: createMemoryDb([quoteRow]),
      rpcUrl: "https://base.test",
      fetchImpl: chain.fetchImpl,
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
        blockTimestamp: "2026-05-16T10:21:58.000Z",
        logIndex: 0,
        // The tx's first (only) log to the address: the bare item key.
        dedupeLogIndex: null,
      },
      expect.anything()
    );
  });

  it("matches an over-send and settles it for the ACTUAL received amount (not no_match)", async () => {
    const settleQuote = jest.fn(async () => ({ status: "settled" as const, quoteId: "quote_1" }));
    // User sent 10% more than quoted — real money, inside the over-send ceiling.
    const overSentAmount = (BigInt(quoteRow.token_amount_raw as string) * 11n) / 10n;
    const chain = makeChain([transferAt(109, overSentAmount, "0xoverpaid")]);

    const result = await reconcileManagedVeniceTokenQuote({
      quoteId: "quote_1",
      userId: "user_1",
      db: createMemoryDb([quoteRow]),
      rpcUrl: "https://base.test",
      fetchImpl: chain.fetchImpl,
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

  // Previously "tightest match wins": the amount-first sort let a later (or an
  // older, out-of-window) transfer displace the first qualifying payment, so
  // the chosen tx changed as new transfers arrived (bug 3). Selection is now
  // the EARLIEST qualifying in-window transfer in chain order.
  it("settles the earliest qualifying transfer even when a tighter one arrives later", async () => {
    const settleQuote = jest.fn(async () => ({ status: "settled" as const, quoteId: "quote_1" }));
    const overSentAmount = (BigInt(quoteRow.token_amount_raw as string) * 12n) / 10n;
    const chain = makeChain([
      transferAt(108, overSentAmount, "0xover"),
      transferAt(109, BigInt(quoteRow.token_amount_raw as string), "0xexact", 1),
    ]);

    const result = await reconcileManagedVeniceTokenQuote({
      quoteId: "quote_1",
      userId: "user_1",
      db: createMemoryDb([quoteRow]),
      rpcUrl: "https://base.test",
      fetchImpl: chain.fetchImpl,
      minConfirmations: 2,
      settleQuote,
      now: new Date("2026-05-16T10:22:00.000Z"),
    });

    expect(result.status).toBe("settled");
    expect(settleQuote).toHaveBeenCalledTimes(1);
    expect(settleQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionHash: "0xover",
        tokenAmountRaw: overSentAmount.toString(),
      }),
      expect.anything()
    );
  });

  // Previously asserted no_match: a confirmed transfer above the 2x ceiling
  // was never surfaced (bug 2). It now goes to manual review through settle.
  it("routes a wildly-over in-window transfer (beyond the 2x ceiling) to review via settle", async () => {
    const settleQuote = jest.fn(async () => ({ status: "manual_review_required" as const }));
    const fatFinger = BigInt(quoteRow.token_amount_raw as string) * 3n;
    const chain = makeChain([transferAt(109, fatFinger, "0xfat")]);

    const result = await reconcileManagedVeniceTokenQuote({
      quoteId: "quote_1",
      userId: "user_1",
      db: createMemoryDb([quoteRow]),
      rpcUrl: "https://base.test",
      fetchImpl: chain.fetchImpl,
      minConfirmations: 2,
      settleQuote,
      now: new Date("2026-05-16T10:22:00.000Z"),
    });

    expect(result.status).toBe("manual_review_required");
    expect(settleQuote).toHaveBeenCalledWith(
      expect.objectContaining({ transactionHash: "0xfat", tokenAmountRaw: fatFinger.toString() }),
      expect.anything()
    );
  });

  it("returns no_match when Base has not seen the exact transfer yet", async () => {
    const settleQuote = jest.fn();

    const result = await reconcileManagedVeniceTokenQuote({
      quoteId: "quote_1",
      userId: "user_1",
      db: createMemoryDb([quoteRow]),
      rpcUrl: "https://base.test",
      fetchImpl: makeChain().fetchImpl,
      settleQuote,
      now: new Date("2026-05-16T10:22:00.000Z"),
    });

    expect(result.status).toBe("no_match");
    expect(settleQuote).not.toHaveBeenCalled();
  });

  it("chunks the quote-anchored Base log scan below provider range limits", async () => {
    const settleQuote = jest.fn();
    // Head at 13:00, long after the 10:40 expiry + 2 h grace: the full
    // anchored range (10:20 -> 12:40, 4,200 blocks) is scanned.
    const chain = makeChain([], { block: 5_000, time: "2026-05-16T13:00:00.000Z" });

    const result = await reconcileManagedVeniceTokenQuote({
      quoteId: "quote_1",
      userId: "user_1",
      db: createMemoryDb([quoteRow]),
      rpcUrl: "https://base.test",
      fetchImpl: chain.fetchImpl,
      settleQuote,
      now: new Date("2026-05-16T13:00:00.000Z"),
    });

    const logRequests = chain.fetchImpl.mock.calls
      .map(([, init]) => JSON.parse(init.body) as { method: string; params: Array<Record<string, string>> })
      .filter((request) => request.method === "eth_getLogs");

    // Fully scanned with nothing attributable: the quote retires.
    expect(result.status).toBe("cancelled");
    expect(settleQuote).not.toHaveBeenCalled();
    expect(logRequests).toHaveLength(3);

    for (const request of logRequests) {
      const filter = request.params[0];
      const fromBlock = Number.parseInt(filter.fromBlock, 16);
      const toBlock = Number.parseInt(filter.toBlock, 16);
      expect(toBlock - fromBlock + 1).toBeLessThanOrEqual(2_000);
      expect(filter.topics).toEqual([transferTopic, null, toTopic]);
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
    const chain = makeChain([transferAt(109, BigInt(quoteRow.token_amount_raw as string), "0xpaid")]);

    const summary = await reconcilePendingManagedVeniceTokenQuotes({
      db: createMemoryDb([quoteRow, expiredQuoteRow]),
      rpcUrl: "https://base.test",
      fetchImpl: chain.fetchImpl,
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
    // One head fetch per batch, shared by both quotes.
    expect(chain.methodCount("eth_blockNumber")).toBe(1);
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
                data: `0x${BigInt(quoteRow.token_amount_raw as string).toString(16)}`,
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
    const fetchImpl = makeChain().fetchImpl;

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

describe("managed Venice reconciliation tick time budget", () => {
  // Five open quotes and three settled quotes that still owe a surface-only
  // pass, each on its own wallet. The fake clock advances 50 s per eth_getLogs
  // (one chunk per quote here), so the open loop reaches its 150 s budget
  // after three scans.
  function budgetFixture() {
    const open = Array.from({ length: 5 }, (_, index) =>
      managedVeniceQuoteRow({
        id: `open_${index}`,
        user_id: `user_open_${index}`,
        deposit_address: `0x${String(index + 1).padStart(40, "0")}`,
        created_at: `2026-05-16T10:20:0${index}.000Z`,
      })
    );
    const surfacing = Array.from({ length: 3 }, (_, index) =>
      managedVeniceQuoteRow({
        id: `settled_${index}`,
        user_id: `user_settled_${index}`,
        deposit_address: `0x${String(index + 11).padStart(40, "0")}`,
        status: "settled",
        transaction_hash: `0xpaid_${index}`,
        transfer_surfacing_pending: true,
        created_at: `2026-05-16T10:19:0${index}.000Z`,
      })
    );
    const memory = createManagedVeniceMemoryDb({ managed_venice_token_quotes: [...open, ...surfacing] });
    const chain = makeChain([], { block: 200, time: "2026-05-16T10:25:00.000Z" });
    let nowMs = 0;
    const inner = chain.fetchImpl.getMockImplementation()!;
    chain.fetchImpl.mockImplementation(async (url: string, init: { body: string }) => {
      if ((JSON.parse(init.body) as { method: string }).method === "eth_getLogs") nowMs += 50_000;
      return inner(url, init);
    });
    return { memory, chain, clock: () => nowMs };
  }

  it("stops starting open scans at its budget, still runs the surface-only pass, and reports what it deferred", async () => {
    const { memory, chain, clock } = budgetFixture();

    const summary = await reconcilePendingManagedVeniceTokenQuotes({
      db: memory.db,
      rpcUrl: "https://base.test",
      fetchImpl: chain.fetchImpl,
      now: new Date("2026-05-16T10:25:00.000Z"),
      interQuoteDelayMs: 0,
      rpcSleepImpl: async () => {},
      clock,
    });

    // Open scans start at 0 s, 50 s and 100 s; the fourth would start at 150 s.
    expect(summary.checked).toBe(3);
    expect(summary.results.map((result) => result.quoteId)).toEqual(["open_4", "open_3", "open_2"]);
    // Surface-only scans start at 150 s and 200 s; the third would start at 250 s.
    expect(summary.transferSurfacing).toEqual({ checked: 2, complete: 0, pending: 2, failed: 0 });
    expect(summary.deferred).toEqual({ open: 2, surfacing: 1 });
    expect(summary.failed).toBe(0);
  });

  it("defers nothing when the tick finishes inside its budget", async () => {
    const { memory, chain } = budgetFixture();

    const summary = await reconcilePendingManagedVeniceTokenQuotes({
      db: memory.db,
      rpcUrl: "https://base.test",
      fetchImpl: chain.fetchImpl,
      now: new Date("2026-05-16T10:25:00.000Z"),
      interQuoteDelayMs: 0,
      rpcSleepImpl: async () => {},
      clock: () => 0,
    });

    expect(summary.checked).toBe(5);
    expect(summary.transferSurfacing.checked).toBe(3);
    expect(summary.deferred).toEqual({ open: 0, surfacing: 0 });
  });
});
