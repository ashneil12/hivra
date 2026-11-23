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
  addressTopic,
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

  it("is not stalled by a spray of dust transfers across more blocks than the timestamp lookup cap", async () => {
    const settleQuote = jest.fn(async () => ({ status: "settled" as const, quoteId: "quote_1" }));
    const dust = Array.from({ length: 250 }, (_, i) =>
      transferAt(60 + i, 1_000n, `0xdust${i.toString(16).padStart(4, "0")}`)
    );
    // Head at block 400 = 10:31:40, still inside the quote window.
    const chain = makeChain(
      [...dust, transferAt(380, BigInt(quoteRow.token_amount_raw as string), "0xpaid")],
      { block: 400, time: "2026-05-16T10:31:40.000Z" }
    );

    const result = await reconcileManagedVeniceTokenQuote({
      quoteId: "quote_1",
      userId: "user_1",
      db: createMemoryDb([quoteRow]),
      rpcUrl: "https://base.test",
      fetchImpl: chain.fetchImpl,
      minConfirmations: 2,
      settleQuote,
      now: new Date("2026-05-16T10:31:40.000Z"),
    });

    expect(result.status).toBe("settled");
    expect(settleQuote).toHaveBeenCalledWith(
      expect.objectContaining({ transactionHash: "0xpaid" }),
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

  it("keeps old claimed and lot-holding quotes eligible for recovery while old unclaimed quotes are not scanned", async () => {
    // All three expired well past the stale cutoff. Only the claimed and
    // lot-holding ones may reach the per-quote recovery branch — the unclaimed
    // one is left for the once-a-day stale pass (this tick has no heartbeat
    // row, so it is not the day's first and nothing expires sight-unseen).
    const oldExpiry = "2026-05-01T00:00:00.000Z";
    const claimed = managedVeniceQuoteRow({
      id: "quote_claimed",
      user_id: "user_claimed",
      transaction_hash: "0xclaimedbeef",
      quoted_at: "2026-04-30T00:00:00.000Z",
      expires_at: oldExpiry,
      created_at: "2026-04-30T00:00:00.000Z",
      deposit_address: "0x000000000000000000000000000000000000c1a1",
    });
    const lotHeld = managedVeniceQuoteRow({
      id: "quote_lot",
      user_id: "user_lot",
      transaction_hash: null,
      quoted_at: "2026-04-30T00:00:00.000Z",
      expires_at: oldExpiry,
      created_at: "2026-04-30T00:00:00.000Z",
      deposit_address: "0x000000000000000000000000000000000000c0de",
    });
    const unclaimed = managedVeniceQuoteRow({
      id: "quote_unclaimed",
      user_id: "user_unclaimed",
      transaction_hash: null,
      quoted_at: "2026-04-30T00:00:00.000Z",
      expires_at: oldExpiry,
      created_at: "2026-04-30T00:00:00.000Z",
      deposit_address: "0x000000000000000000000000000000000000dead",
    });
    const lot = {
      id: "lot_1",
      account_id: "account_lot",
      user_id: "user_lot",
      quote_id: "quote_lot",
      source: "hermesos_deposit",
      token_amount_raw: "1000000000000000000000",
      remaining_token_amount_raw: "1000000000000000000000",
      snapshot_price_usd: "0.05",
      original_value_micro_usd: 50_000_000,
      remaining_value_micro_usd: 50_000_000,
      quote_source: "dexscreener",
      quoted_at: "2026-04-30T00:00:00.000Z",
      quote_expires_at: oldExpiry,
      transaction_hash: "0xlotpaidcafe",
      status: "active",
      metadata: { observedAt: "2026-04-30T00:05:00.000Z" },
      created_at: "2026-04-30T00:05:00.000Z",
      updated_at: "2026-04-30T00:05:00.000Z",
    };
    const settleQuote = jest.fn(async (transfer: { quoteId?: string }) => ({
      status: "settled" as const,
      quoteId: transfer?.quoteId ?? "quote_unknown",
    }));
    const chain = makeChain();

    const summary = await reconcilePendingManagedVeniceTokenQuotes({
      db: createManagedVeniceMemoryDb({
        managed_venice_token_quotes: [claimed, lotHeld, unclaimed],
        managed_venice_token_lots: [lot],
      }).db,
      rpcUrl: "https://base.test",
      fetchImpl: chain.fetchImpl,
      minConfirmations: 2,
      settleQuote,
      now: new Date("2026-05-16T10:22:00.000Z"),
      interQuoteDelayMs: 0,
      rpcSleepImpl: async () => {},
    });

    // The two recovery candidates were checked and settled on their claimed /
    // lot transaction without a log scan; the unclaimed stale quote was left
    // for the daily stale pass and never reached the scan loop or the expiry.
    expect(summary.checked).toBe(2);
    expect(summary.settled).toBe(2);
    const settledHashes = settleQuote.mock.calls.map(
      (call) => (call[0] as { transactionHash?: string }).transactionHash
    );
    expect(settledHashes).toEqual(expect.arrayContaining(["0xclaimedbeef", "0xlotpaidcafe"]));
    expect(settledHashes).toHaveLength(2);
  });

  it("rotates failing claimed quotes so a batch of them cannot starve newer claims", async () => {
    // Three claimed quotes > limit 2, every recovery attempt throwing. Under
    // created_at order the same two would fill every batch forever and the
    // third claim — too old for the fresh lane, holding no lot — would never
    // be reached. The claimed lane orders by the updated_at last-attempt
    // cursor instead, and every attempt bumps the row to the back.
    const oldExpiry = "2026-05-01T00:00:00.000Z";
    const claimedRow = (index: number, createdAt: string, updatedAt: string) =>
      managedVeniceQuoteRow({
        id: `quote_claimed_${index}`,
        user_id: `user_claimed_${index}`,
        transaction_hash: `0xclaimed${index}`,
        deposit_address: `0x${String(index + 1).repeat(40)}`,
        quoted_at: "2026-04-30T00:00:00.000Z",
        expires_at: oldExpiry,
        created_at: createdAt,
        updated_at: updatedAt,
      });
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [
        // Created FIRST but claimed most recently: under created_at order it
        // would head the lane; under the attempt cursor it is last.
        claimedRow(0, "2026-04-29T00:00:00.000Z", "2026-04-30T02:00:00.000Z"),
        claimedRow(1, "2026-04-30T00:00:00.000Z", "2026-04-30T00:00:00.000Z"),
        claimedRow(2, "2026-04-30T00:01:00.000Z", "2026-04-30T01:00:00.000Z"),
      ],
    });
    const settleQuote = jest.fn(async (_transfer: { quoteId?: string }) => {
      throw new Error("settlement keeps crashing");
    });
    const run = (now: Date) =>
      reconcilePendingManagedVeniceTokenQuotes({
        db: memory.db,
        rpcUrl: "https://base.test",
        fetchImpl: makeChain().fetchImpl,
        settleQuote,
        now,
        limit: 2,
        interQuoteDelayMs: 0,
        rpcSleepImpl: async () => {},
      });
    const attempted = () =>
      settleQuote.mock.calls.map((call) => (call[0] as { quoteId?: string }).quoteId);

    const tick1Now = new Date("2026-05-16T10:22:00.000Z");
    const tick1 = await run(tick1Now);

    // Least-recently-attempted first: claims 1 (00:00) and 2 (01:00), NOT the
    // created-first row 0 whose claim was written most recently.
    expect(tick1.checked).toBe(2);
    expect(tick1.failed).toBe(2);
    expect(attempted()).toEqual(["quote_claimed_1", "quote_claimed_2"]);
    const rows = memory.tables.managed_venice_token_quotes;
    const updatedAtOf = (id: string) => rows.find((row) => row.id === id)?.updated_at;
    // Failed attempts still moved the cursor: claims 1 and 2 go to the back,
    // claim 0 — never attempted — keeps its older stamp.
    expect(updatedAtOf("quote_claimed_1")).toBe(tick1Now.toISOString());
    expect(updatedAtOf("quote_claimed_2")).toBe(tick1Now.toISOString());
    expect(updatedAtOf("quote_claimed_0")).toBe("2026-04-30T02:00:00.000Z");

    const tick2Now = new Date("2026-05-16T10:37:00.000Z");
    const tick2 = await run(tick2Now);

    // The un-attempted claim is now the least-recently-touched row and gets
    // in ahead of the two that already failed — nothing is starved and
    // nothing is lost.
    expect(tick2.checked).toBe(2);
    expect(attempted().slice(2)).toEqual(["quote_claimed_0", "quote_claimed_1"]);
  });

  it("reaches claimed recovery candidates ahead of a fresh backlog that would spend the whole scan budget", async () => {
    // The open loop used to merge fresh candidates first: with a fresh
    // backlog deep enough to spend the whole open-scan budget, a claimed
    // quote — a settlement that already claimed its tx and crashed before
    // finishing — sat behind all of them and could be deferred forever.
    // Recovery lanes now lead the merge: claimed and lot-held candidates
    // finish from their already-known transaction evidence WITHOUT a log
    // scan, so budget-bounded work can never starve them out.
    const now = new Date("2026-05-20T00:00:00.000Z");
    const claimed = managedVeniceQuoteRow({
      id: "quote_claimed",
      user_id: "user_claimed",
      transaction_hash: "0xclaimedbeef",
      // Past the stale cutoff, so it is a claimed-lane candidate, not fresh.
      quoted_at: "2026-05-01T10:00:00.000Z",
      expires_at: "2026-05-01T10:20:00.000Z",
      created_at: "2026-05-01T10:00:00.000Z",
      updated_at: "2026-05-01T10:00:00.000Z",
      deposit_address: `0x${"9".repeat(40)}`,
    });
    // Three fresh quotes, each costing 50 s of fake-RPC time on a 75 s
    // budget: under fresh-first order the claim never starts; under
    // recovery-first it settles before the first scan request is made.
    const fresh = Array.from({ length: 3 }, (_, index) =>
      managedVeniceQuoteRow({
        id: `quote_fresh_${index}`,
        user_id: `user_fresh_${index}`,
        deposit_address: `0x${String(index + 1).repeat(40)}`,
        quoted_at: "2026-05-19T23:00:00.000Z",
        expires_at: "2026-05-19T23:20:00.000Z",
        created_at: `2026-05-19T23:00:0${index}.000Z`,
        updated_at: `2026-05-19T23:00:0${index}.000Z`,
      })
    );
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [claimed, ...fresh],
    });
    // A head far enough out that the fresh quotes' windows map to blocks.
    const chain = createBaseRpcFake({
      latestBlock: 1_000_000,
      latestTimestamp: "2026-05-20T00:00:00.000Z",
    });
    let nowMs = 0;
    const inner = chain.fetchImpl.getMockImplementation()!;
    chain.fetchImpl.mockImplementation(async (url: string, init: { body: string }) => {
      if ((JSON.parse(init.body) as { method: string }).method === "eth_getLogs") nowMs += 50_000;
      return inner(url, init);
    });
    const settleQuote = jest.fn(async (transfer: { quoteId?: string }) => ({
      status: "settled" as const,
      quoteId: transfer?.quoteId ?? "quote_unknown",
    }));

    const summary = await reconcilePendingManagedVeniceTokenQuotes({
      db: memory.db,
      rpcUrl: "https://base.test",
      fetchImpl: chain.fetchImpl,
      minConfirmations: 2,
      settleQuote,
      now,
      clock: () => nowMs,
      openScanBudgetMs: 75_000,
      interQuoteDelayMs: 0,
      rpcSleepImpl: async () => {},
    });

    // The claim's recovery was the FIRST candidate processed and settled on
    // its own transaction evidence — before a single fresh scan ran.
    expect(summary.results[0]).toEqual(
      expect.objectContaining({ quoteId: "quote_claimed", status: "settled" })
    );
    expect(settleQuote.mock.calls[0][0]).toEqual(
      expect.objectContaining({ quoteId: "quote_claimed", transactionHash: "0xclaimedbeef" })
    );
    // The fresh lane still runs newest-first behind the recovery lanes, and
    // the budget still bounds it: two scans start (0 s and 50 s), the third
    // would start past the 75 s slice and is deferred, not dropped.
    expect(summary.results.map((result) => result.quoteId)).toEqual([
      "quote_claimed",
      "quote_fresh_2",
      "quote_fresh_1",
    ]);
    expect(summary.deferred.open).toBe(1);
    expect(chain.methodCount("eth_getLogs")).toBeGreaterThan(0);
  });

  it("bounds the recovery lanes' share of the open budget so a failing-claim storm cannot starve fresh payments", async () => {
    // Recovery-first ordering is only fair while recovery candidates are
    // cheap: a settled-in-crash quote finishes without a scan. But a
    // settlement backend that keeps failing turns every recovery attempt
    // into budget spend — enough of them, each slow, would consume the
    // whole open slice ahead of fresh discovery and defer every fresh
    // payment to the once-a-day stale pass. The claimed + lot-held lanes
    // are bounded to a share of the open budget; un-attempted claims stay
    // admitted (they were never tried, so the cursor keeps them first).
    const now = new Date("2026-05-20T00:00:00.000Z");
    const claimed = [0, 1, 2].map((index) =>
      managedVeniceQuoteRow({
        id: `quote_claimed_${index}`,
        user_id: `user_claimed_${index}`,
        transaction_hash: `0xclaimed${index}`,
        deposit_address: `0x${String(index + 1).repeat(40)}`,
        quoted_at: "2026-05-01T10:00:00.000Z",
        expires_at: "2026-05-01T10:20:00.000Z",
        created_at: "2026-05-01T10:00:00.000Z",
        updated_at: `2026-05-01T10:0${index}:00.000Z`,
      })
    );
    const lotHeld = managedVeniceQuoteRow({
      id: "quote_lotheld",
      user_id: "user_lotheld",
      deposit_address: `0x${"8".repeat(40)}`,
      quoted_at: "2026-05-01T10:00:00.000Z",
      expires_at: "2026-05-01T10:20:00.000Z",
      created_at: "2026-05-01T10:00:00.000Z",
      updated_at: "2026-05-01T10:00:00.000Z",
    });
    const fresh = [0, 1].map((index) =>
      managedVeniceQuoteRow({
        id: `quote_fresh_${index}`,
        user_id: `user_fresh_${index}`,
        deposit_address: `0x${String(index + 20).padStart(40, "0")}`,
        quoted_at: "2026-05-19T23:00:00.000Z",
        expires_at: "2026-05-19T23:20:00.000Z",
        created_at: `2026-05-19T23:00:0${index}.000Z`,
        updated_at: `2026-05-19T23:00:0${index}.000Z`,
      })
    );
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [...claimed, lotHeld, ...fresh],
      managed_venice_token_lots: [
        {
          id: "lot_held_storm",
          account_id: "account_1",
          user_id: "user_lotheld",
          quote_id: "quote_lotheld",
          source: "hermesos_deposit",
          token_amount_raw: "1000000000000000000000",
          remaining_token_amount_raw: "1000000000000000000000",
          snapshot_price_usd: "0.05",
          original_value_micro_usd: 50_000_000,
          remaining_value_micro_usd: 50_000_000,
          quote_source: "dexscreener",
          quoted_at: "2026-05-01T10:00:00.000Z",
          quote_expires_at: "2026-05-01T10:20:00.000Z",
          transaction_hash: "0xlotstorm",
          status: "active",
          metadata: {},
        },
      ],
    });
    const chain = createBaseRpcFake({
      latestBlock: 1_000_000,
      latestTimestamp: "2026-05-20T00:00:00.000Z",
    });
    // Every recovery attempt burns 30 s of the tick clock and still fails:
    // an unbounded lane would spend 0/30/60/90 of a 100 s budget on all four
    // recovery candidates and defer both fresh quotes to tomorrow's pass.
    let nowMs = 0;
    const settleQuote = jest.fn(async () => {
      nowMs += 30_000;
      throw new Error("settlement keeps crashing");
    });

    const summary = await reconcilePendingManagedVeniceTokenQuotes({
      db: memory.db,
      rpcUrl: "https://base.test",
      fetchImpl: chain.fetchImpl,
      minConfirmations: 2,
      settleQuote,
      now,
      clock: () => nowMs,
      openScanBudgetMs: 100_000,
      interQuoteDelayMs: 0,
      rpcSleepImpl: async () => {},
    });

    // The recovery lanes stop at their half-share: attempts start at 0 s and
    // 30 s; the third would start at 60 s — past the 50 s recovery slice —
    // so the remaining recovery candidates defer (not fail, never dropped:
    // they retry first on the next tick).
    expect(summary.failed).toBe(2);
    expect(summary.deferred.open).toBe(2);
    // Fresh quotes still ran their real scans inside the same tick.
    expect(summary.results.map((result) => result.quoteId)).toEqual([
      "quote_claimed_0",
      "quote_claimed_1",
      "quote_fresh_1",
      "quote_fresh_0",
    ]);
    expect(summary.noMatch).toBe(2);
    expect(chain.methodCount("eth_getLogs")).toBeGreaterThan(0);
  });

  it("gives the fresh lane its own slots when claimed quotes fill the newest in-grace rows", async () => {
    // The fresh selection used to read the `limit` newest in-grace open
    // quotes regardless of claim state. When those are all claimed — a
    // settlement backend that keeps failing can hold them claimed forever —
    // they were already the claimed lane's candidates, so the merge added
    // zero fresh work: the unclaimed quotes just behind them were never
    // read and the fresh share of the budget sat idle every tick. Claimed
    // rows are now excluded at the query level: the same rows still recover
    // first, and the fresh slots fill with genuinely-unscanned quotes.
    const now = new Date("2026-05-20T00:00:00.000Z");
    const claimed = [0, 1].map((index) =>
      managedVeniceQuoteRow({
        id: `quote_claimed_${index}`,
        user_id: `user_claimed_${index}`,
        transaction_hash: `0xclaimed${index}`,
        deposit_address: `0x${String(index + 1).repeat(40)}`,
        quoted_at: "2026-05-19T20:00:00.000Z",
        expires_at: "2026-05-19T20:20:00.000Z",
        // Newest in the window: under the old read they took BOTH fresh slots.
        created_at: `2026-05-19T23:00:0${index}.000Z`,
        updated_at: `2026-05-19T23:00:0${index}.000Z`,
      })
    );
    const fresh = [0, 1].map((index) =>
      managedVeniceQuoteRow({
        id: `quote_fresh_${index}`,
        user_id: `user_fresh_${index}`,
        deposit_address: `0x${String(index + 20).padStart(40, "0")}`,
        quoted_at: "2026-05-19T22:00:00.000Z",
        expires_at: "2026-05-19T22:20:00.000Z",
        created_at: `2026-05-19T22:00:0${index}.000Z`,
        updated_at: `2026-05-19T22:00:0${index}.000Z`,
      })
    );
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [...claimed, ...fresh],
    });
    const chain = createBaseRpcFake({ latestBlock: 1_000_000, latestTimestamp: now.toISOString() });
    const settleQuote = jest.fn(async (transfer: { quoteId?: string }) => ({
      status: "settled" as const,
      quoteId: transfer?.quoteId ?? "quote_unknown",
    }));

    const summary = await reconcilePendingManagedVeniceTokenQuotes({
      db: memory.db,
      rpcUrl: "https://base.test",
      fetchImpl: chain.fetchImpl,
      minConfirmations: 2,
      settleQuote,
      now,
      limit: 2,
      interQuoteDelayMs: 0,
      rpcSleepImpl: async () => {},
    });

    // Recovery still leads: both claims settle on their own txs. And the two
    // fresh quotes are now ALSO in the batch and got real log scans — before
    // the fix they were never selected (checked was 2, noMatch 0, no
    // eth_getLogs at all).
    expect(summary.results.map((result) => result.quoteId)).toEqual([
      "quote_claimed_0",
      "quote_claimed_1",
      "quote_fresh_1",
      "quote_fresh_0",
    ]);
    expect(summary.checked).toBe(4);
    expect(summary.settled).toBe(2);
    expect(summary.noMatch).toBe(2);
    expect(chain.methodCount("eth_getLogs")).toBeGreaterThan(0);
    const settledHashes = settleQuote.mock.calls.map(
      (call) => (call[0] as { transactionHash?: string }).transactionHash
    );
    expect(settledHashes).toEqual(["0xclaimed0", "0xclaimed1"]);
  });

  it("keeps probe-known lot-held rows out of the fresh window and backfills the slots", async () => {
    // A lot-holding quote needs no log scan — its recovery rides the lot-held
    // lane — yet the old fresh read still spent newest-first slots on such
    // rows, so `limit` window rows could yield fewer genuine scans. The lane
    // now filters probe-known holders out of its pages and reads on —
    // bounded — until the slots fill with quotes that will be scanned.
    const now = new Date("2026-05-20T00:00:00.000Z");
    const held = managedVeniceQuoteRow({
      id: "quote_held",
      user_id: "user_held",
      deposit_address: `0x${"8".repeat(40)}`,
      quoted_at: "2026-05-19T23:00:00.000Z",
      expires_at: "2026-05-19T23:20:00.000Z",
      // Newest in the window: the first row of the old read's first page.
      created_at: "2026-05-19T23:00:00.000Z",
      updated_at: "2026-05-19T23:00:00.000Z",
    });
    const fresh = [0, 1, 2].map((index) =>
      managedVeniceQuoteRow({
        id: `quote_fresh_${index}`,
        user_id: `user_fresh_${index}`,
        deposit_address: `0x${String(index + 20).padStart(40, "0")}`,
        quoted_at: "2026-05-19T22:00:00.000Z",
        expires_at: "2026-05-19T22:20:00.000Z",
        created_at: `2026-05-19T22:00:0${index}.000Z`,
        updated_at: `2026-05-19T22:00:0${index}.000Z`,
      })
    );
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [held, ...fresh],
      managed_venice_token_lots: [
        {
          id: "lot_held",
          account_id: "account_held",
          user_id: "user_held",
          quote_id: "quote_held",
          source: "hermesos_deposit",
          token_amount_raw: "1000000000000000000000",
          remaining_token_amount_raw: "1000000000000000000000",
          snapshot_price_usd: "0.05",
          original_value_micro_usd: 50_000_000,
          remaining_value_micro_usd: 50_000_000,
          quote_source: "dexscreener",
          quoted_at: "2026-05-19T23:00:00.000Z",
          quote_expires_at: "2026-05-19T23:20:00.000Z",
          transaction_hash: "0xheldlotpaid",
          status: "active",
          metadata: {},
        },
      ],
    });
    const chain = createBaseRpcFake({ latestBlock: 1_000_000, latestTimestamp: now.toISOString() });
    const settleQuote = jest.fn(async (transfer: { quoteId?: string }) => ({
      status: "settled" as const,
      quoteId: transfer?.quoteId ?? "quote_unknown",
    }));

    const summary = await reconcilePendingManagedVeniceTokenQuotes({
      db: memory.db,
      rpcUrl: "https://base.test",
      fetchImpl: chain.fetchImpl,
      minConfirmations: 2,
      settleQuote,
      now,
      limit: 2,
      interQuoteDelayMs: 0,
      rpcSleepImpl: async () => {},
    });

    // quote_held recovered WITHOUT a scan on its lot's tx (recovery lane
    // first); the two fresh slots went to fresh_2 and fresh_1 — quote_fresh_1
    // is the row the old read left behind (its page ended at held+fresh_2).
    expect(summary.results.map((result) => result.quoteId)).toEqual([
      "quote_held",
      "quote_fresh_2",
      "quote_fresh_1",
    ]);
    expect(summary.checked).toBe(3);
    expect(summary.settled).toBe(1);
    expect(summary.noMatch).toBe(2);
    expect(settleQuote).toHaveBeenCalledWith(
      expect.objectContaining({ quoteId: "quote_held", transactionHash: "0xheldlotpaid" }),
      expect.anything()
    );
    expect(chain.methodCount("eth_getLogs")).toBeGreaterThan(0);
  });

  it("still recovers a lot-holding quote the bounded probe cannot reach, through its fresh slot", async () => {
    // Filtering known holders from the fresh window must not strand a holder
    // the probe's bounded slice never reached: such a row is NOT a "known"
    // lot holder, so it keeps its fresh slot and the reconcile recovers its
    // lot without a scan — the same coverage it had before.
    const now = new Date("2026-05-20T00:00:00.000Z");
    const probeFirst = managedVeniceQuoteRow({
      id: "quote_probe_first",
      user_id: "user_probe_first",
      deposit_address: `0x${"7".repeat(40)}`,
      quoted_at: "2026-05-19T20:00:00.000Z",
      // Longest-expired open row: the probe's one-row budget lands here.
      expires_at: "2026-05-19T20:20:00.000Z",
      created_at: "2026-05-19T20:00:00.000Z",
      updated_at: "2026-05-19T20:00:00.000Z",
    });
    const fresh = managedVeniceQuoteRow({
      id: "quote_fresh",
      user_id: "user_fresh",
      deposit_address: `0x${"6".repeat(40)}`,
      quoted_at: "2026-05-19T22:00:00.000Z",
      expires_at: "2026-05-19T22:20:00.000Z",
      created_at: "2026-05-19T22:00:00.000Z",
      updated_at: "2026-05-19T22:00:00.000Z",
    });
    const held = managedVeniceQuoteRow({
      id: "quote_held",
      user_id: "user_held",
      deposit_address: `0x${"8".repeat(40)}`,
      quoted_at: "2026-05-19T23:00:00.000Z",
      // Newest expiry: deeper than the probe's one-row slice can reach.
      expires_at: "2026-05-19T23:20:00.000Z",
      created_at: "2026-05-19T23:00:00.000Z",
      updated_at: "2026-05-19T23:00:00.000Z",
    });
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [probeFirst, fresh, held],
      managed_venice_token_lots: [
        {
          id: "lot_held",
          account_id: "account_held",
          user_id: "user_held",
          quote_id: "quote_held",
          source: "hermesos_deposit",
          token_amount_raw: "1000000000000000000000",
          remaining_token_amount_raw: "1000000000000000000000",
          snapshot_price_usd: "0.05",
          original_value_micro_usd: 50_000_000,
          remaining_value_micro_usd: 50_000_000,
          quote_source: "dexscreener",
          quoted_at: "2026-05-19T23:00:00.000Z",
          quote_expires_at: "2026-05-19T23:20:00.000Z",
          transaction_hash: "0xdeepheldlotpaid",
          status: "active",
          metadata: {},
        },
      ],
    });
    const chain = createBaseRpcFake({ latestBlock: 1_000_000, latestTimestamp: now.toISOString() });
    const settleQuote = jest.fn(async (transfer: { quoteId?: string }) => ({
      status: "settled" as const,
      quoteId: transfer?.quoteId ?? "quote_unknown",
    }));

    const summary = await reconcilePendingManagedVeniceTokenQuotes({
      db: memory.db,
      rpcUrl: "https://base.test",
      fetchImpl: chain.fetchImpl,
      minConfirmations: 2,
      settleQuote,
      now,
      limit: 3,
      lotProbeBudget: 1,
      interQuoteDelayMs: 0,
      rpcSleepImpl: async () => {},
    });

    // The probe's slice could not reach the holder — but the fresh window
    // could, and its reconcile settled on the lot's tx without a scan-shaped
    // decision being needed first.
    expect(settleQuote).toHaveBeenCalledWith(
      expect.objectContaining({ quoteId: "quote_held", transactionHash: "0xdeepheldlotpaid" }),
      expect.anything()
    );
    expect(summary.settled).toBe(1);
    expect(summary.results.map((result) => result.quoteId)).toContain("quote_held");
  });

  it("still reaches an open lot-holding quote when settled lots outnumber the scan limit", async () => {
    // limit=10 but 15 older settled lots fill a naive .limit() read: the open
    // quote's lot is newest, so it must be found by paging all lot ids and
    // filtering to open quotes — not by truncating the lot list.
    const oldExpiry = "2026-05-01T00:00:00.000Z";
    const settledQuotes = Array.from({ length: 15 }, (_, i) =>
      managedVeniceQuoteRow({
        id: `quote_settled_${i}`,
        user_id: `user_settled_${i}`,
        status: "settled",
        settled_at: "2026-05-02T00:00:00.000Z",
        quoted_at: "2026-04-30T00:00:00.000Z",
        expires_at: oldExpiry,
        created_at: "2026-04-30T00:00:00.000Z",
      })
    );
    const settledLots = settledQuotes.map((quote, i) => ({
      id: `lot_settled_${i}`,
      account_id: `account_settled_${i}`,
      user_id: `user_settled_${i}`,
      quote_id: quote.id,
      source: "hermesos_deposit",
      token_amount_raw: "1000000000000000000000",
      remaining_token_amount_raw: "0",
      snapshot_price_usd: "0.05",
      original_value_micro_usd: 50_000_000,
      remaining_value_micro_usd: 0,
      quote_source: "dexscreener",
      quoted_at: "2026-04-30T00:00:00.000Z",
      quote_expires_at: oldExpiry,
      transaction_hash: `0xsettled${i}`,
      status: "settled",
      metadata: {},
      created_at: `2026-04-30T00:0${i % 10}:00.000Z`,
      updated_at: `2026-04-30T00:0${i % 10}:00.000Z`,
    }));
    const openQuote = managedVeniceQuoteRow({
      id: "quote_open_lot",
      user_id: "user_open_lot",
      transaction_hash: null,
      quoted_at: "2026-04-30T00:00:00.000Z",
      expires_at: oldExpiry,
      created_at: "2026-04-30T00:00:00.000Z",
      deposit_address: "0x000000000000000000000000000000000000c0de",
    });
    const openLot = {
      id: "lot_open",
      account_id: "account_open",
      user_id: "user_open_lot",
      quote_id: "quote_open_lot",
      source: "hermesos_deposit",
      token_amount_raw: "1000000000000000000000",
      remaining_token_amount_raw: "1000000000000000000000",
      snapshot_price_usd: "0.05",
      original_value_micro_usd: 50_000_000,
      remaining_value_micro_usd: 50_000_000,
      quote_source: "dexscreener",
      quoted_at: "2026-04-30T00:00:00.000Z",
      quote_expires_at: oldExpiry,
      transaction_hash: "0xopenlotpaid",
      status: "active",
      metadata: { observedAt: "2026-04-30T00:05:00.000Z" },
      // Newest lot: a bounded oldest-first lot read never reaches it.
      created_at: "2026-05-10T00:00:00.000Z",
      updated_at: "2026-05-10T00:00:00.000Z",
    };
    const settleQuote = jest.fn(async (transfer: { quoteId?: string }) => ({
      status: "settled" as const,
      quoteId: transfer?.quoteId ?? "quote_unknown",
    }));
    const chain = makeChain();

    const summary = await reconcilePendingManagedVeniceTokenQuotes({
      db: createManagedVeniceMemoryDb({
        managed_venice_token_quotes: [...settledQuotes, openQuote],
        managed_venice_token_lots: [...settledLots, openLot],
      }).db,
      rpcUrl: "https://base.test",
      fetchImpl: chain.fetchImpl,
      minConfirmations: 2,
      settleQuote,
      now: new Date("2026-05-16T10:22:00.000Z"),
      limit: 10,
      interQuoteDelayMs: 0,
      rpcSleepImpl: async () => {},
    });

    // Only the open quote is a candidate; it settles on its lot's tx.
    expect(summary.checked).toBe(1);
    expect(summary.settled).toBe(1);
    const settledHashes = settleQuote.mock.calls.map(
      (call) => (call[0] as { transactionHash?: string }).transactionHash
    );
    expect(settledHashes).toEqual(["0xopenlotpaid"]);
  });

  it("matches deposit lots to paged open quotes instead of probing every historical lot id", async () => {
    // Regression for the lot-recovery starvation: with ~2,100 historical
    // deposit lots the old code paged the WHOLE lot id list (three 1,000-row
    // pages) and then probed each id for an open quote before any fresh work
    // ran. The check now pages open quote ids and matches lots to them, so
    // the lots table sees a bounded probe per open-id chunk no matter how
    // many settled lots accumulate. The settled lots' quotes need no rows —
    // only their quote_id matters, and the open-side filter excludes them.
    const oldExpiry = "2026-05-01T00:00:00.000Z";
    const settledLots = Array.from({ length: 2_100 }, (_, i) => ({
      id: `lot_settled_${i}`,
      account_id: `account_settled_${i}`,
      user_id: `user_settled_${i}`,
      quote_id: `quote_settled_${i}`,
      source: "hermesos_deposit",
      transaction_hash: `0xsettled${i}`,
      status: "depleted",
      created_at: `2026-04-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00.000Z`,
      updated_at: `2026-04-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00.000Z`,
    }));
    const openQuote = managedVeniceQuoteRow({
      id: "quote_open_lot",
      user_id: "user_open_lot",
      transaction_hash: null,
      quoted_at: "2026-04-30T00:00:00.000Z",
      expires_at: oldExpiry,
      created_at: "2026-04-30T00:00:00.000Z",
      deposit_address: "0x000000000000000000000000000000000000c0de",
    });
    const openLot = {
      id: "lot_open",
      account_id: "account_open",
      user_id: "user_open_lot",
      quote_id: "quote_open_lot",
      source: "hermesos_deposit",
      token_amount_raw: "1000000000000000000000",
      remaining_token_amount_raw: "1000000000000000000000",
      snapshot_price_usd: "0.05",
      original_value_micro_usd: 50_000_000,
      remaining_value_micro_usd: 50_000_000,
      quote_source: "dexscreener",
      quoted_at: "2026-04-30T00:00:00.000Z",
      quote_expires_at: oldExpiry,
      transaction_hash: "0xopenlotpaid",
      status: "active",
      metadata: { observedAt: "2026-04-30T00:05:00.000Z" },
      created_at: "2026-05-10T00:00:00.000Z",
      updated_at: "2026-05-10T00:00:00.000Z",
    };
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [openQuote],
      managed_venice_token_lots: [...settledLots, openLot],
    });
    let lotsTableReads = 0;
    const countingDb = {
      from: (name: string) => {
        if (name === "managed_venice_token_lots") lotsTableReads += 1;
        return memory.db.from(name);
      },
    };
    const settleQuote = jest.fn(async (transfer: { quoteId?: string }) => ({
      status: "settled" as const,
      quoteId: transfer?.quoteId ?? "quote_unknown",
    }));

    const summary = await reconcilePendingManagedVeniceTokenQuotes({
      db: countingDb,
      rpcUrl: "https://base.test",
      fetchImpl: makeChain().fetchImpl,
      minConfirmations: 2,
      settleQuote,
      now: new Date("2026-05-16T10:22:00.000Z"),
      limit: 10,
      interQuoteDelayMs: 0,
      rpcSleepImpl: async () => {},
    });

    // The open quote is still recovered — it settles on its lot's tx.
    expect(summary.settled).toBe(1);
    expect(settleQuote).toHaveBeenCalledWith(
      expect.objectContaining({ quoteId: "quote_open_lot", transactionHash: "0xopenlotpaid" }),
      expect.anything()
    );
    // And the lots table saw at most two reads: the .in() probe on the open
    // id chunk plus the recovery path's own per-quote lot read — NOT the
    // three full-history pages + eleven chunks the id-first read would pay.
    expect(lotsTableReads).toBeLessThanOrEqual(2);
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

  it("times out a stalled Base RPC request with a signal and retries it (no unbounded hang)", async () => {
    const settleQuote = jest.fn();
    const sleeps: number[] = [];
    // Every attempt is aborted by its request timeout, as a stalled provider would be.
    const fetchImpl = jest.fn(async (_url: string, init: { signal?: AbortSignal }) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    });

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

    expect(summary.failed).toBe(1);
    expect(summary.results[0].errorMessage).toBe("Base RPC eth_blockNumber timed out after 10000 ms");
    expect(settleQuote).not.toHaveBeenCalled();
    // The timeout is retryable: all 3 attempts were made, with 2 backoff sleeps.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleeps).toHaveLength(2);
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

describe("stale unpaid quote expiry", () => {
  const staleNow = new Date("2026-05-20T00:00:00.000Z");
  const VENICE_CRON = "managed-venice-token-reconciliation";
  // last_run_at on a previous UTC day makes staleNow the day's first tick.
  const heartbeatYesterday = { cron_name: VENICE_CRON, last_run_at: "2026-05-19T12:00:00.000Z" };
  const heartbeatSameDay = { cron_name: VENICE_CRON, last_run_at: "2026-05-20T06:00:00.000Z" };

  function staleQuoteRow(overrides: Row = {}): Row {
    return managedVeniceQuoteRow({
      id: "quote_stale",
      quoted_at: "2026-05-01T10:00:00.000Z",
      expires_at: "2026-05-01T10:20:00.000Z",
      created_at: "2026-05-01T10:00:00.000Z",
      updated_at: "2026-05-01T10:00:00.000Z",
      ...overrides,
    });
  }

  // A chain head far enough back that the May-1 quote window maps to real
  // blocks (the shared HEAD_BLOCK=110 anchor cannot reach it).
  function staleChain() {
    return createBaseRpcFake({ latestBlock: 1_000_000, latestTimestamp: staleNow.toISOString() });
  }

  function runBatch(
    memory: ReturnType<typeof createManagedVeniceMemoryDb>["db"],
    chain = makeChain(),
    now: Date = staleNow
  ) {
    return reconcilePendingManagedVeniceTokenQuotes({
      db: memory,
      rpcUrl: "https://base.test",
      fetchImpl: chain.fetchImpl,
      minConfirmations: 2,
      settleQuote: jest.fn(async () => ({ status: "settled" as const, quoteId: "quote_stale" })),
      now,
      interQuoteDelayMs: 0,
      rpcSleepImpl: async () => {},
    });
  }

  it("log-scans a stale quote before expiring it on the first tick of a new UTC day", async () => {
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [staleQuoteRow()],
      ops_cron_heartbeats: [heartbeatYesterday],
    });
    const chain = staleChain();

    const summary = await runBatch(memory.db, chain);

    expect(summary.failed).toBe(0);
    // The closure was preceded by a real log scan of the quote's window —
    // a clean fully-scanned window retires the quote itself.
    expect(chain.methodCount("eth_getLogs")).toBeGreaterThan(0);
    expect(summary.cancelled).toBe(1);
    expect(summary.results).toEqual([
      expect.objectContaining({ quoteId: "quote_stale", status: "cancelled" }),
    ]);

    const row = memory.tables.managed_venice_token_quotes[0];
    expect(row.status).toBe("cancelled");
    expect((row.metadata as Row).closedReason).toBe("expired_unpaid");
  });

  it("settles a stale quote whose deposit the daily scan finds instead of expiring it", async () => {
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [staleQuoteRow()],
      ops_cron_heartbeats: [heartbeatYesterday],
    });
    const chain = staleChain();
    chain.addTransfer(
      transferAt(
        chain.blockAt("2026-05-01T10:10:00.000Z"),
        BigInt(staleQuoteRow().token_amount_raw as string),
        "0xstalepaid"
      )
    );

    const summary = await runBatch(memory.db, chain);

    // The scan found the deposit: the quote settles instead of closing unpaid.
    expect(summary.settled).toBe(1);
    expect(summary.checked).toBe(1);
    expect(summary.results).toEqual([
      expect.objectContaining({ quoteId: "quote_stale", status: "settled" }),
    ]);
  });

  it("does no stale work on a tick that is not the day's first", async () => {
    // The day's slot is held by the keyed claim row an earlier tick planted
    // and claimed — the unkeyed base row being same-day is irrelevant to the
    // keyed pass once its own row exists.
    const keyedHeldToday = {
      cron_name: `${VENICE_CRON}:stale-scan`,
      last_run_at: "2026-05-20T06:00:00.000Z",
    };
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [staleQuoteRow()],
      ops_cron_heartbeats: [heartbeatSameDay, keyedHeldToday],
    });
    const chain = staleChain();

    const summary = await runBatch(memory.db, chain);

    expect(summary.checked).toBe(0);
    expect(summary.cancelled).toBe(0);
    expect(chain.methodCount("eth_getLogs")).toBe(0);
    expect(memory.tables.managed_venice_token_quotes[0].status).toBe("active");
  });

  it("gives an already-expired no_deposit_after_grace quote its one catch-up scan", async () => {
    // The expire-without-scan era marked rows no_deposit_after_grace without
    // ever reading their deposit window — a payment arriving inside it could
    // be hidden forever. Each such row is owed exactly one real scan before
    // it is out for good: this one completes clean and the row retires like
    // any fully-scanned stale quote.
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [
        {
          ...staleQuoteRow(),
          status: "expired",
          metadata: {
            ...(staleQuoteRow().metadata as Row),
            closedReason: "no_deposit_after_grace",
          },
        },
      ],
      ops_cron_heartbeats: [heartbeatYesterday],
    });
    const chain = staleChain();

    const summary = await runBatch(memory.db, chain);

    expect(summary.checked).toBe(1);
    expect(summary.cancelled).toBe(1);
    expect(chain.methodCount("eth_getLogs")).toBeGreaterThan(0);
    const row = memory.tables.managed_venice_token_quotes[0];
    expect(row.status).toBe("cancelled");
    expect((row.metadata as Row).closedReason).toBe("expired_unpaid");
  });

  it("keeps a grace-expired row eligible while its catch-up scan cannot cover the window", async () => {
    // A no_match is only "nothing in what we scanned" — NOT proof the window
    // is empty. When the chain head sits before the quote's grace end, a
    // transfer in the unscanned tail would be invisible, so the row must NOT
    // be stamped graceWindowScannedAt and must stay in the rotation: only an
    // explicit full-window outcome may bound it to one scan.
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [
        {
          ...staleQuoteRow(),
          status: "expired",
          metadata: {
            ...(staleQuoteRow().metadata as Row),
            closedReason: "no_deposit_after_grace",
          },
        },
      ],
      ops_cron_heartbeats: [heartbeatYesterday],
    });
    // Head at 12:00 sits before the quote's grace end (12:20): the window
    // cannot be fully scanned, so the row stays 'expired' WITHOUT a marker.
    const chain = createBaseRpcFake({
      latestBlock: 1_000,
      latestTimestamp: "2026-05-01T12:00:00.000Z",
    });

    const day1 = await runBatch(memory.db, chain);

    expect(day1.checked).toBe(1);
    expect(day1.results).toEqual([
      expect.objectContaining({ quoteId: "quote_stale", status: "no_match" }),
    ]);
    const scannedAt = chain.methodCount("eth_getLogs");
    expect(scannedAt).toBeGreaterThan(0);
    let row = memory.tables.managed_venice_token_quotes[0];
    expect(row.status).toBe("expired");
    expect((row.metadata as Row).closedReason).toBe("no_deposit_after_grace");
    expect((row.metadata as Row).graceWindowScannedAt).toBeUndefined();
    // The incomplete scan still rotated the row's queue cursor — it retries
    // from the back of tomorrow's selection, not from the head.
    expect(row.updated_at).toBe(staleNow.toISOString());

    // The next day's first tick re-selects the same row: a partial no_match
    // never discharges the one-scan obligation. Day 1's checkpoint covered
    // the head-bounded range — but only the blocks the finality margin puts
    // beyond a reorg are trusted as immutable, so the re-scan pays exactly
    // one more request for the still-non-final tail (FINALITY_MARGIN_BLOCKS
    // behind the head) instead of the whole range.
    const day2 = await runBatch(
      memory.db,
      chain,
      new Date("2026-05-21T00:00:00.000Z")
    );
    expect(day2.checked).toBe(1);
    expect(chain.methodCount("eth_getLogs")).toBe(scannedAt + 1);
    row = memory.tables.managed_venice_token_quotes[0];
    expect(row.status).toBe("expired");
    expect((row.metadata as Row).graceWindowScannedAt).toBeUndefined();

    // Once the head really does cover the window + grace, the same row's
    // scan retires it like any confirmed-empty stale quote.
    const covered = createBaseRpcFake({
      latestBlock: 1_000_000,
      latestTimestamp: "2026-05-01T13:00:00.000Z",
    });
    const day3 = await runBatch(
      memory.db,
      covered,
      new Date("2026-05-22T00:00:00.000Z")
    );
    expect(day3.cancelled).toBe(1);
    row = memory.tables.managed_venice_token_quotes[0];
    expect(row.status).toBe("cancelled");
    expect((row.metadata as Row).closedReason).toBe("expired_unpaid");
  });

  it("settles the deposit a no_deposit_after_grace row's catch-up scan finds", async () => {
    // The finding's money path: a payment that landed inside the window of a
    // quote the old pass expired sight-unseen is still credited by its one
    // catch-up scan instead of staying invisible forever.
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [
        {
          ...staleQuoteRow(),
          status: "expired",
          metadata: {
            ...(staleQuoteRow().metadata as Row),
            closedReason: "no_deposit_after_grace",
          },
        },
      ],
      ops_cron_heartbeats: [heartbeatYesterday],
    });
    const chain = staleChain();
    chain.addTransfer(
      transferAt(
        chain.blockAt("2026-05-01T10:10:00.000Z"),
        BigInt(staleQuoteRow().token_amount_raw as string),
        "0xlatepaid"
      )
    );

    const summary = await runBatch(memory.db, chain);

    expect(summary.settled).toBe(1);
    expect(summary.results).toEqual([
      expect.objectContaining({ quoteId: "quote_stale", status: "settled" }),
    ]);
  });

  it("still scans a quote inside the 7-day grace", async () => {
    // Expires an hour before `now`: inside the grace, so it must be scanned
    // like any open quote.
    const graceQuote = staleQuoteRow({
      id: "quote_grace",
      quoted_at: "2026-05-19T22:40:00.000Z",
      expires_at: "2026-05-19T23:00:00.000Z",
      created_at: "2026-05-19T22:40:00.000Z",
    });
    const memory = createManagedVeniceMemoryDb({ managed_venice_token_quotes: [graceQuote] });
    const chain = makeChain([], { block: 900, time: "2026-05-20T00:00:00.000Z" });

    const summary = await runBatch(memory.db, chain);

    expect(summary.checked).toBe(1);
    expect(chain.methodCount("eth_getLogs")).toBeGreaterThan(0);
  });

  it("drains a stale backlog a bounded scan-and-expire batch per UTC day", async () => {
    // 30 stale unpaid quotes > STALE_QUOTE_DAILY_SCAN_LIMIT (25). Each daily
    // pass log-scans its batch before expiring it; closed rows are excluded
    // from later selects so the backlog keeps moving.
    const quotes = Array.from({ length: 30 }, (_, index) =>
      staleQuoteRow({
        id: `quote_stale_${index}`,
        // Deterministic expires_at ordering: oldest first.
        quoted_at: new Date(Date.parse("2026-05-01T10:00:00.000Z") + index * 1000).toISOString(),
        expires_at: new Date(Date.parse("2026-05-01T10:20:00.000Z") + index * 1000).toISOString(),
        created_at: new Date(Date.parse("2026-05-01T10:00:00.000Z") + index * 1000).toISOString(),
        updated_at: new Date(Date.parse("2026-05-01T10:00:00.000Z") + index * 1000).toISOString(),
      })
    );
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: quotes,
      ops_cron_heartbeats: [heartbeatYesterday],
    });
    const chain = staleChain();

    const day1 = await runBatch(memory.db, chain);
    expect(day1.cancelled).toBe(25);
    expect(chain.methodCount("eth_getLogs")).toBeGreaterThan(0);

    // A later tick the same UTC day does no stale work at all.
    memory.tables.ops_cron_heartbeats[0].last_run_at = "2026-05-20T00:30:00.000Z";
    const sameDay = await runBatch(memory.db, chain);
    expect(sameDay.checked).toBe(0);
    expect(sameDay.cancelled).toBe(0);

    // The next UTC day's first tick scans and closes the remaining 5.
    memory.tables.ops_cron_heartbeats[0].last_run_at = "2026-05-20T23:30:00.000Z";
    const day2 = await runBatch(memory.db, chain, new Date("2026-05-21T00:00:00.000Z"));
    expect(day2.cancelled).toBe(5);

    const rows = memory.tables.managed_venice_token_quotes;
    expect(rows).toHaveLength(30);
    expect(rows.every((row) => row.status === "cancelled")).toBe(true);
    expect(
      rows.every(
        (row) =>
          (row.metadata as Row).closedReason === "expired_unpaid"
      )
    ).toBe(true);
  });

  it("does not expire a stale quote that already carries a transaction hash", async () => {
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [staleQuoteRow({ transaction_hash: "0xclaimed" })],
    });
    const chain = makeChain();

    const summary = await runBatch(memory.db, chain);

    // A claimed quote stays eligible for the scan at any age: the recovery
    // branch is the only automatic path that finishes a crashed settlement.
    expect(summary.checked).toBe(1);
    expect(memory.tables.managed_venice_token_quotes[0].status).toBe("active");
  });

  it("rotates failing stale quotes to the back of the daily selection", async () => {
    // 26 stale quotes > the 25-row daily batch, and every scan fails (the RPC
    // answers 500 to everything). Under oldest-expires ordering the same 25
    // would pin the batch forever. Scanned rows move to the back of the
    // selection via updated_at, so the 26th is reached on day 2 even though
    // the other 25 still fail — nothing is permanently lost.
    const quotes = Array.from({ length: 26 }, (_, index) =>
      staleQuoteRow({
        id: `quote_stale_${index}`,
        quoted_at: new Date(Date.parse("2026-05-01T10:00:00.000Z") + index * 1000).toISOString(),
        expires_at: new Date(Date.parse("2026-05-01T10:20:00.000Z") + index * 1000).toISOString(),
        created_at: new Date(Date.parse("2026-05-01T10:00:00.000Z") + index * 1000).toISOString(),
        updated_at: new Date(Date.parse("2026-05-01T10:00:00.000Z") + index * 1000).toISOString(),
      })
    );
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: quotes,
      ops_cron_heartbeats: [heartbeatYesterday],
    });
    // Every RPC call fails fast: the stale scan of each quote errors out.
    const downFetch = jest.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    const runDown = (now: Date) =>
      reconcilePendingManagedVeniceTokenQuotes({
        db: memory.db,
        rpcUrl: "https://base.test",
        fetchImpl: downFetch,
        minConfirmations: 2,
        settleQuote: jest.fn(async () => ({ status: "settled" as const, quoteId: "x" })),
        now,
        interQuoteDelayMs: 0,
        rpcRetryConfig: { maxAttempts: 1 },
        rpcSleepImpl: async () => {},
      });

    const day1 = await runDown(staleNow);
    expect(day1.failed).toBe(25);
    const rows = memory.tables.managed_venice_token_quotes;
    // The 25 scanned rows were touched (their scan cursor is the batch's own
    // `now`); the one that did not fit keeps its seeded stamp.
    expect(rows[25].updated_at).toBe("2026-05-01T10:00:25.000Z");
    expect(rows.slice(0, 25).every((row) => row.updated_at === staleNow.toISOString())).toBe(true);

    // Next day's first tick: the untouched row is the oldest in the rotation
    // and is scanned first — the other 25 still fail but it is not starved.
    memory.tables.ops_cron_heartbeats[0].last_run_at = "2026-05-20T23:30:00.000Z";
    const day2Now = new Date("2026-05-21T00:00:00.000Z");
    const day2 = await runDown(day2Now);
    expect(day2.failed).toBe(25);
    expect(rows[25].updated_at).toBe(day2Now.toISOString());
    // One scanned row again waits for tomorrow — this time it is row 24.
    expect(rows[24].updated_at).toBe(staleNow.toISOString());
  });

  it("still scans a stale quote on the daily tick when the regular open loop exhausts the budget", async () => {
    // The daily stale pass runs BEFORE the open loop inside its own slice of
    // the tick clock, so a regular batch that burns the whole open-scan
    // budget cannot starve it. Here the fake clock advances 50 s per
    // eth_getLogs: the stale scan itself pushes elapsed past a 1 ms
    // open-scan budget, the fresh quote defers — but the stale row is
    // already scanned and retired.
    const freshQuote = staleQuoteRow({
      id: "quote_fresh",
      deposit_address: `0x${"9".repeat(40)}`,
      quoted_at: "2026-05-19T22:40:00.000Z",
      expires_at: "2026-05-19T23:00:00.000Z",
      created_at: "2026-05-19T22:40:00.000Z",
      updated_at: "2026-05-19T22:40:00.000Z",
    });
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [staleQuoteRow(), freshQuote],
      ops_cron_heartbeats: [heartbeatYesterday],
    });
    const chain = staleChain();
    let nowMs = 0;
    const inner = chain.fetchImpl.getMockImplementation()!;
    chain.fetchImpl.mockImplementation(async (url: string, init: { body: string }) => {
      if ((JSON.parse(init.body) as { method: string }).method === "eth_getLogs") nowMs += 50_000;
      return inner(url, init);
    });

    const summary = await reconcilePendingManagedVeniceTokenQuotes({
      db: memory.db,
      rpcUrl: "https://base.test",
      fetchImpl: chain.fetchImpl,
      minConfirmations: 2,
      settleQuote: jest.fn(async () => ({ status: "settled" as const, quoteId: "x" })),
      now: staleNow,
      clock: () => nowMs,
      openScanBudgetMs: 1,
      staleScanBudgetMs: 240_000,
      interQuoteDelayMs: 0,
      rpcSleepImpl: async () => {},
    });

    // The stale quote got its real log scan (past the open budget) and was
    // retired; the fresh quote defers to a later tick.
    expect(chain.methodCount("eth_getLogs")).toBeGreaterThan(0);
    expect(summary.cancelled).toBe(1);
    expect(summary.results.map((result) => result.quoteId)).toEqual(["quote_stale"]);
    expect(summary.deferred.open).toBe(1);
  });

  it("defers the rest of the daily stale batch once its own slice is spent", async () => {
    // The guaranteed slice is bounded: with each stale scan costing ~150 s
    // of tick clock, a 200 s stale budget scans the first row to completion,
    // interrupts the second's scan mid-flight (it is deferred, never decided
    // on partial data) and leaves both leftovers for a later day instead of
    // eating the open loop's share.
    const quotes = [
      staleQuoteRow({ id: "quote_stale_0" }),
      staleQuoteRow({
        id: "quote_stale_1",
        deposit_address: `0x${"8".repeat(40)}`,
        quoted_at: "2026-05-01T11:00:00.000Z",
        expires_at: "2026-05-01T11:20:00.000Z",
        created_at: "2026-05-01T11:00:00.000Z",
        updated_at: "2026-05-01T11:00:00.000Z",
      }),
      staleQuoteRow({
        id: "quote_stale_2",
        deposit_address: `0x${"7".repeat(40)}`,
        quoted_at: "2026-05-01T12:00:00.000Z",
        expires_at: "2026-05-01T12:20:00.000Z",
        created_at: "2026-05-01T12:00:00.000Z",
        updated_at: "2026-05-01T12:00:00.000Z",
      }),
    ];
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: quotes,
      ops_cron_heartbeats: [heartbeatYesterday],
    });
    const chain = staleChain();
    let nowMs = 0;
    const inner = chain.fetchImpl.getMockImplementation()!;
    chain.fetchImpl.mockImplementation(async (url: string, init: { body: string }) => {
      if ((JSON.parse(init.body) as { method: string }).method === "eth_getLogs") nowMs += 50_000;
      return inner(url, init);
    });

    const summary = await reconcilePendingManagedVeniceTokenQuotes({
      db: memory.db,
      rpcUrl: "https://base.test",
      fetchImpl: chain.fetchImpl,
      minConfirmations: 2,
      settleQuote: jest.fn(async () => ({ status: "settled" as const, quoteId: "x" })),
      now: staleNow,
      clock: () => nowMs,
      staleScanBudgetMs: 200_000,
      interQuoteDelayMs: 0,
      rpcSleepImpl: async () => {},
    });

    expect(summary.cancelled).toBe(1);
    expect(summary.results.map((result) => result.quoteId)).toEqual(["quote_stale_0"]);
    // The two rows the slice could not finish are reported deferred, not
    // lost: still open, still eligible on the next day.
    expect(summary.deferred.open).toBe(2);
    expect(memory.tables.managed_venice_token_quotes.map((row) => row.status)).toEqual([
      "cancelled",
      "active",
      "active",
    ]);
  });

  it("defers a stale row mid-scan when its slice runs out inside the log scan", async () => {
    // The stale deadline is threaded into the per-quote RPC loop, not just
    // checked between quotes: a single scan — dozens of serial RPC calls —
    // that crosses the slice is interrupted between requests. An aborted
    // scan is never authoritative: the row is counted deferred (not failed,
    // not closed on partial data) and stays fully eligible for the next
    // day's pass — only its queue cursor moves, so it retries from the back
    // instead of pinning the head and re-running the same expensive scan.
    const quotes = [
      staleQuoteRow({ id: "quote_stale_0" }),
      staleQuoteRow({
        id: "quote_stale_1",
        deposit_address: `0x${"8".repeat(40)}`,
        quoted_at: "2026-05-01T11:00:00.000Z",
        expires_at: "2026-05-01T11:20:00.000Z",
        created_at: "2026-05-01T11:00:00.000Z",
        updated_at: "2026-05-01T11:00:00.000Z",
      }),
      staleQuoteRow({
        id: "quote_stale_2",
        deposit_address: `0x${"7".repeat(40)}`,
        quoted_at: "2026-05-01T12:00:00.000Z",
        expires_at: "2026-05-01T12:20:00.000Z",
        created_at: "2026-05-01T12:00:00.000Z",
        updated_at: "2026-05-01T12:00:00.000Z",
      }),
    ];
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: quotes,
      ops_cron_heartbeats: [heartbeatYesterday],
    });
    const chain = staleChain();
    let nowMs = 0;
    const inner = chain.fetchImpl.getMockImplementation()!;
    chain.fetchImpl.mockImplementation(async (url: string, init: { body: string }) => {
      if ((JSON.parse(init.body) as { method: string }).method === "eth_getLogs") nowMs += 50_000;
      return inner(url, init);
    });

    const summary = await reconcilePendingManagedVeniceTokenQuotes({
      db: memory.db,
      rpcUrl: "https://base.test",
      fetchImpl: chain.fetchImpl,
      minConfirmations: 2,
      settleQuote: jest.fn(async () => ({ status: "settled" as const, quoteId: "x" })),
      now: staleNow,
      clock: () => nowMs,
      staleScanBudgetMs: 60_000,
      interQuoteDelayMs: 0,
      rpcSleepImpl: async () => {},
    });

    // The first row's own scan is aborted after its second of three getLogs
    // chunks: no settle/expire decision was made on partial data, and the
    // abort is a deferral (deferred.open), never a per-quote failure.
    expect(summary.cancelled).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.deferred.open).toBe(3);
    expect(summary.results).toHaveLength(0);
    const rows = memory.tables.managed_venice_token_quotes;
    expect(rows.map((row) => row.status)).toEqual(["active", "active", "active"]);
    // The interrupted row carries no marker and no status change — but its
    // queue cursor DID advance: it retries from the back of tomorrow's
    // selection instead of pinning the head and restarting the same scan.
    expect(rows[0].updated_at).toBe(staleNow.toISOString());
    expect((rows[0].metadata as Row).graceWindowScannedAt).toBeUndefined();
    expect(chain.methodCount("eth_getLogs")).toBe(2);

    // Day 2 proves the rotation: the least-recently-touched row (the second,
    // at 11:00) is scanned first — the getLogs target its deposit address,
    // not the day-1 head's — and IT takes the interrupt + cursor touch.
    const day2LogsBefore = chain.methodCount("eth_getLogs");
    const day2RequestsBefore = chain.requests.length;
    const day2Now = new Date("2026-05-21T00:00:00.000Z");
    const day2 = await reconcilePendingManagedVeniceTokenQuotes({
      db: memory.db,
      rpcUrl: "https://base.test",
      fetchImpl: chain.fetchImpl,
      minConfirmations: 2,
      settleQuote: jest.fn(async () => ({ status: "settled" as const, quoteId: "x" })),
      now: day2Now,
      clock: () => nowMs,
      staleScanBudgetMs: 60_000,
      interQuoteDelayMs: 0,
      rpcSleepImpl: async () => {},
    });

    expect(day2.deferred.open).toBe(3);
    const day2LogTopics = chain.requests
      .slice(day2RequestsBefore)
      .filter((request) => request.method === "eth_getLogs")
      .map((request) => (request.params[0] as { topics: Array<string | null> }).topics[2]);
    expect(day2LogTopics.length).toBeGreaterThan(0);
    expect(
      day2LogTopics.every(
        (topic) => topic === addressTopic("0x8888888888888888888888888888888888888888")
      )
    ).toBe(true);
    expect(rows[1].updated_at).toBe(day2Now.toISOString());
    expect(chain.methodCount("eth_getLogs")).toBeGreaterThan(day2LogsBefore);
  });

  it("resumes an interrupted stale scan at its checkpoint and settles the deposit it never reached", async () => {
    // The exact starvation the checkpoint fixes: a stale quote whose window
    // needs more RPC time than the daily slice aborted at the same chunk
    // every day — every attempt restarted at the window's first block, so a
    // payment in the unscanned tail could never be seen. Answered chunks are
    // now checkpointed on the row (metadata.depositScanProgress) and the next
    // day's pass resumes at scannedThroughBlock + 1 — while partial coverage
    // still decides nothing by itself (the row stays open until the whole
    // window is read).
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [staleQuoteRow()],
      ops_cron_heartbeats: [heartbeatYesterday],
    });
    const chain = staleChain();
    // The payment sits in the window's LAST chunk — the part day 1's slice
    // never reaches before the budget runs out (12:15 is inside the grace
    // end at 12:20).
    chain.addTransfer(
      transferAt(
        chain.blockAt("2026-05-01T12:15:00.000Z"),
        BigInt(staleQuoteRow().token_amount_raw as string),
        "0xstalepaid"
      )
    );
    let nowMs = 0;
    const inner = chain.fetchImpl.getMockImplementation()!;
    chain.fetchImpl.mockImplementation(async (url: string, init: { body: string }) => {
      if ((JSON.parse(init.body) as { method: string }).method === "eth_getLogs") nowMs += 50_000;
      return inner(url, init);
    });
    const settleQuote = jest.fn(async (transfer: { quoteId?: string }) => ({
      status: "settled" as const,
      quoteId: transfer?.quoteId ?? "quote_stale",
    }));
    const run = (now: Date) =>
      reconcilePendingManagedVeniceTokenQuotes({
        db: memory.db,
        rpcUrl: "https://base.test",
        fetchImpl: chain.fetchImpl,
        minConfirmations: 2,
        settleQuote,
        now,
        clock: () => nowMs,
        staleScanBudgetMs: 60_000,
        interQuoteDelayMs: 0,
        rpcSleepImpl: async () => {},
      });

    const day1 = await run(staleNow);

    // Day 1 still dies mid-window — but the two chunks it answered are now
    // persisted on the row instead of being thrown away.
    expect(day1.settled).toBe(0);
    expect(day1.cancelled).toBe(0);
    expect(day1.deferred.open).toBe(1);
    expect(settleQuote).not.toHaveBeenCalled();
    const fromBlock = chain.blockAt("2026-05-01T10:00:00.000Z");
    const day1Row = memory.tables.managed_venice_token_quotes[0];
    expect(day1Row.status).toBe("active");
    expect((day1Row.metadata as Row).graceWindowScannedAt).toBeUndefined();
    const progress = (day1Row.metadata as Row).depositScanProgress as Record<
      string,
      {
        tokenAddress: string;
        fromBlock: number;
        toBlock: number;
        scannedThroughBlock: number;
        transfers: unknown[];
      }
    >;
    const tokenProgress = progress?.[HERMESOS_TOKEN_ADDRESS.toLowerCase()];
    expect(tokenProgress?.fromBlock).toBe(fromBlock);
    // Two 2,000-block chunks answered before the slice ran out.
    expect(tokenProgress?.scannedThroughBlock).toBe(fromBlock + 3999);
    // The tail payment is NOT in the checkpoint — it was never scanned.
    expect(tokenProgress?.transfers).toEqual([]);

    // Day 2: the same 60 s slice is now enough — the pass resumes inside the
    // last chunk instead of re-paying for the covered prefix, reaches the
    // payment day 1 could not, and settles it.
    const day2RequestsBefore = chain.requests.length;
    const day2 = await run(new Date("2026-05-21T00:00:00.000Z"));

    expect(day2.settled).toBe(1);
    expect(settleQuote).toHaveBeenCalledWith(
      expect.objectContaining({ quoteId: "quote_stale", transactionHash: "0xstalepaid" }),
      expect.anything()
    );
    const day2GetLogs = chain.requests
      .slice(day2RequestsBefore)
      .filter((request) => request.method === "eth_getLogs")
      .map((request) => request.params[0] as { fromBlock: string; toBlock: string });
    // Exactly one log call — the uncovered tail — not three from the top.
    expect(day2GetLogs).toHaveLength(1);
    expect(Number.parseInt(day2GetLogs[0].fromBlock, 16)).toBe(fromBlock + 4000);
  });

  it("keeps a checkpointed prefix's transfers when the resume finishes the window", async () => {
    // The other half of the resume contract: a transfer found BEFORE the
    // abort is checkpointed with the coverage, and the resumed scan must
    // still see it — a resume that skipped blocks but dropped the persisted
    // set would read an "empty" window and retire a paid quote.
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [staleQuoteRow()],
      ops_cron_heartbeats: [heartbeatYesterday],
    });
    const chain = staleChain();
    // In-window payment in the FIRST chunk — day 1 scans it, checkpoints it,
    // and dies before the tail.
    chain.addTransfer(
      transferAt(
        chain.blockAt("2026-05-01T10:10:00.000Z"),
        BigInt(staleQuoteRow().token_amount_raw as string),
        "0xprefixpaid"
      )
    );
    let nowMs = 0;
    const inner = chain.fetchImpl.getMockImplementation()!;
    chain.fetchImpl.mockImplementation(async (url: string, init: { body: string }) => {
      if ((JSON.parse(init.body) as { method: string }).method === "eth_getLogs") nowMs += 50_000;
      return inner(url, init);
    });
    const settleQuote = jest.fn(async (transfer: { quoteId?: string }) => ({
      status: "settled" as const,
      quoteId: transfer?.quoteId ?? "quote_stale",
    }));
    const run = (now: Date) =>
      reconcilePendingManagedVeniceTokenQuotes({
        db: memory.db,
        rpcUrl: "https://base.test",
        fetchImpl: chain.fetchImpl,
        minConfirmations: 2,
        settleQuote,
        now,
        clock: () => nowMs,
        staleScanBudgetMs: 60_000,
        interQuoteDelayMs: 0,
        rpcSleepImpl: async () => {},
      });

    const day1 = await run(staleNow);
    expect(day1.deferred.open).toBe(1);
    const day1Row = memory.tables.managed_venice_token_quotes[0];
    const progress = (day1Row.metadata as Row).depositScanProgress as Record<
      string,
      { scannedThroughBlock: number; transfers: Array<{ transactionHash: string }> }
    >;
    const tokenProgress = progress?.[HERMESOS_TOKEN_ADDRESS.toLowerCase()];
    // The checkpoint carries the prefix's transfer, not just the block mark.
    expect(tokenProgress?.transfers).toEqual([
      expect.objectContaining({ transactionHash: "0xprefixpaid" }),
    ]);
    expect(settleQuote).not.toHaveBeenCalled();

    const day2 = await run(new Date("2026-05-21T00:00:00.000Z"));

    // Resumed coverage + the persisted transfer = the deposit settles even
    // though day 2's own RPC only walked the tail.
    expect(day2.settled).toBe(1);
    expect(settleQuote).toHaveBeenCalledWith(
      expect.objectContaining({ quoteId: "quote_stale", transactionHash: "0xprefixpaid" }),
      expect.anything()
    );
  });

  it("still runs the regular lanes when the daily stale pass cannot load its candidates", async () => {
    // The stale pass's candidate SELECT is the first quotes read of the daily
    // tick. If it fails, the batch must not go down with it: the open loop and
    // the transfer-surfacing pass still run, and the summary reports the
    // failure so the route's ops event and heartbeat read a degraded tick —
    // not a clean one that simply found nothing stale.
    const freshQuote = staleQuoteRow({
      id: "quote_fresh",
      deposit_address: `0x${"9".repeat(40)}`,
      quoted_at: "2026-05-19T22:40:00.000Z",
      expires_at: "2026-05-19T23:00:00.000Z",
      created_at: "2026-05-19T22:40:00.000Z",
      updated_at: "2026-05-19T22:40:00.000Z",
    });
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [staleQuoteRow(), freshQuote],
      ops_cron_heartbeats: [heartbeatYesterday],
    });
    const chain = staleChain();
    memory.failNext({ table: "managed_venice_token_quotes", op: "select" });

    const summary = await runBatch(memory.db, chain);

    // Reported, not thrown — the pass retries on the next day's first tick.
    expect(summary.staleScanLoadFailed).toBe(true);
    // The stale quote was never scanned: still open, not expired sight-unseen.
    const stale = memory.tables.managed_venice_token_quotes.find((row) => row.id === "quote_stale");
    expect(stale?.status).toBe("active");
    // The regular open lane still ran: the in-grace fresh quote got its real
    // log scan and outcome instead of dying with the stale pass.
    expect(chain.methodCount("eth_getLogs")).toBeGreaterThan(0);
    expect(summary.checked).toBe(1);
    expect(summary.results.map((result) => result.quoteId)).toEqual(["quote_fresh"]);
  });

  it("scans the stale batch before regular candidate discovery runs", async () => {
    // Discovery (the fresh/claimed/lot-held SELECTs) is the slow part of a
    // daily tick — the lot-held lookup pages the open quotes. Running it
    // before the stale pass would charge its time — or its failure — to the
    // day before the stale pass ever started. Failing ONLY the discovery
    // SELECT proves the order: the batch still rejects on the main lane, but
    // the stale quote was already scanned and retired ahead of it.
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [staleQuoteRow()],
      ops_cron_heartbeats: [heartbeatYesterday],
    });
    const chain = staleChain();
    memory.failNext({
      table: "managed_venice_token_quotes",
      op: "select",
      // The stale loader bounds expires_at with `lte`; only the regular
      // candidate SELECT bounds it with `gt`.
      match: (payload) =>
        ((payload.filters as Array<{ column: string; op: string }> | undefined) ?? []).some(
          (filter) => filter.column === "expires_at" && filter.op === "gt"
        ),
    });

    await expect(runBatch(memory.db, chain)).rejects.toThrow();

    // The batch died on discovery — but the day's one stale pass had already
    // done its real log scan and retired the quote, instead of waiting
    // behind the failed select.
    expect(chain.methodCount("eth_getLogs")).toBeGreaterThan(0);
    expect(memory.tables.managed_venice_token_quotes[0].status).toBe("cancelled");
  });

  it("runs the next day's stale pass even when the previous tick's heartbeat landed after midnight", async () => {
    // A tick that starts before UTC midnight and finishes after it stamps its
    // run heartbeat in the NEW day. Keying the daily pass off that heartbeat's
    // landing day would then skip the new day's pass entirely: 05-20's pass
    // would be recorded as 05-21's. The pass claims a dedicated
    // "<cron>:stale-scan" day row at run START instead, so the day that ran
    // the work is the day that is marked taken.
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [staleQuoteRow({ id: "quote_stale_a" })],
      ops_cron_heartbeats: [heartbeatYesterday],
    });
    const chain = staleChain();

    // Tick 1 starts 2026-05-20T23:59 — before midnight — and claims 05-20.
    const day1 = await runBatch(memory.db, chain, new Date("2026-05-20T23:59:00.000Z"));
    expect(day1.cancelled).toBe(1);
    const claimRow = memory.tables.ops_cron_heartbeats.find(
      (row) => row.cron_name === `${VENICE_CRON}:stale-scan`
    );
    expect(claimRow?.last_run_at).toBe("2026-05-20T23:59:00.000Z");

    // The run's heartbeat lands AFTER midnight, as the real end-of-run write
    // would. Under heartbeat-day keying this alone would suppress 05-21.
    const runRow = memory.tables.ops_cron_heartbeats.find((row) => row.cron_name === VENICE_CRON);
    runRow!.last_run_at = "2026-05-21T00:05:00.000Z";

    // A second stale quote ages in; 05-21's first tick still claims its own
    // day and scans it — the claim row says 05-20 ran, not 05-21.
    memory.insertRow(
      "managed_venice_token_quotes",
      staleQuoteRow({
        id: "quote_stale_b",
        deposit_address: `0x${"6".repeat(40)}`,
      })
    );
    const logsBefore = chain.methodCount("eth_getLogs");
    const day2 = await runBatch(memory.db, chain, new Date("2026-05-21T00:10:00.000Z"));

    expect(day2.cancelled).toBe(1);
    expect(chain.methodCount("eth_getLogs")).toBeGreaterThan(logsBefore);
    expect(memory.tables.managed_venice_token_quotes.map((row) => row.status)).toEqual([
      "cancelled",
      "cancelled",
    ]);
  });

  it("bounds the lot probe to its tick budget and still reaches an old lot-holding quote", async () => {
    // The probe may not page the whole open table before fresh work: it reads
    // a bounded slice of the longest-expired open quotes per tick. A
    // lot-holding quote deeper than the slice is NOT found by the probe —
    // but it is never lost either: the daily stale pass scans every
    // unclaimed open quote (bounded per day, rotating) and runs the same
    // lot recovery inside its reconcile.
    const expiryOf = (index: number) =>
      new Date(Date.parse("2026-05-01T10:20:00.000Z") + index * 60_000).toISOString();
    const quotes = Array.from({ length: 5 }, (_, index) =>
      staleQuoteRow({
        id: `quote_probe_${index}`,
        deposit_address: `0x${String(5 - index).repeat(40)}`,
        quoted_at: new Date(Date.parse("2026-05-01T10:00:00.000Z") + index * 60_000).toISOString(),
        expires_at: expiryOf(index),
        created_at: new Date(Date.parse("2026-05-01T10:00:00.000Z") + index * 60_000).toISOString(),
        updated_at: new Date(Date.parse("2026-05-01T10:00:00.000Z") + index * 60_000).toISOString(),
      })
    );
    // The lot-holder sits at probe position 5 — past a budget of 2.
    const lot = {
      id: "lot_deep",
      account_id: "account_deep",
      user_id: "user_1",
      quote_id: "quote_probe_4",
      source: "hermesos_deposit",
      token_amount_raw: "1000000000000000000000",
      remaining_token_amount_raw: "1000000000000000000000",
      snapshot_price_usd: "0.05",
      original_value_micro_usd: 50_000_000,
      remaining_value_micro_usd: 50_000_000,
      quote_source: "dexscreener",
      quoted_at: "2026-05-01T10:00:00.000Z",
      quote_expires_at: expiryOf(4),
      transaction_hash: "0xlotpaiddeep",
      status: "active",
      metadata: { observedAt: "2026-05-01T10:05:00.000Z" },
      created_at: "2026-05-01T10:05:00.000Z",
      updated_at: "2026-05-01T10:05:00.000Z",
    };
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: quotes,
      managed_venice_token_lots: [lot],
    });
    // The real settle is a compare-and-set that flips the row out of the open
    // set; this mock does the same so the probe can't hand the just-settled
    // quote back to the batch a second time inside one tick.
    const settleQuote = jest.fn(async (transfer: { quoteId?: string; transactionHash?: string }) => {
      const row = memory.tables.managed_venice_token_quotes.find(
        (candidate) => candidate.id === transfer.quoteId
      );
      if (row) {
        row.status = "settled";
        row.transaction_hash = transfer.transactionHash ?? "0xsettled";
      }
      return { status: "settled" as const, quoteId: transfer?.quoteId ?? "quote_unknown" };
    });
    const chain = staleChain();
    const run = (now: Date) =>
      reconcilePendingManagedVeniceTokenQuotes({
        db: memory.db,
        rpcUrl: "https://base.test",
        fetchImpl: chain.fetchImpl,
        minConfirmations: 2,
        settleQuote,
        now,
        interQuoteDelayMs: 0,
        rpcSleepImpl: async () => {},
        lotProbeBudget: 2,
      });

    // Tick 1 (no prior tick → no daily pass): the probe reads only the
    // budgeted slice — the two longest-expired open quotes — so the deep
    // lot-holder is NOT recovered by it.
    const tick1 = await run(staleNow);
    expect(tick1.checked).toBe(0);
    expect(settleQuote).not.toHaveBeenCalled();

    // The daily stale pass is the guaranteed reach: the next day's first
    // tick scans every unclaimed open quote and the deep quote settles on
    // its lot's tx — the other four retire on their clean scans. (Tick 1
    // planted the "<cron>:stale-scan" claim row, so this tick claims
    // 05-21 without needing any heartbeat baseline.)
    const tick2 = await run(new Date("2026-05-21T00:00:00.000Z"));
    expect(tick2.settled).toBe(1);
    expect(tick2.cancelled).toBe(4);
    expect(settleQuote).toHaveBeenCalledWith(
      expect.objectContaining({ quoteId: "quote_probe_4", transactionHash: "0xlotpaiddeep" }),
      expect.anything()
    );
  });

  it("persists resolved transfer timestamps in the checkpoint so a resumed pass never re-pays the lookup", async () => {
    // The resume used to re-run a serial timestamp pass from an empty
    // per-batch cache: every checkpointed transfer's block was re-read one
    // RPC at a time before the scan itself, enough to eat a day's whole
    // 60 s slice before reaching the uncovered tail — the scan starved at
    // the same place forever. Resolved stamps now ride the coverage record:
    // day 2 seeds them from the checkpoint and spends zero timestamp reads
    // on covered work.
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [staleQuoteRow()],
      ops_cron_heartbeats: [heartbeatYesterday],
    });
    const chain = staleChain();
    const paymentBlock = chain.blockAt("2026-05-01T10:10:00.000Z");
    chain.addTransfer(
      transferAt(paymentBlock, BigInt(staleQuoteRow().token_amount_raw as string), "0xprefixpaid")
    );
    let nowMs = 0;
    const inner = chain.fetchImpl.getMockImplementation()!;
    chain.fetchImpl.mockImplementation(async (url: string, init: { body: string }) => {
      if ((JSON.parse(init.body) as { method: string }).method === "eth_getLogs") nowMs += 50_000;
      return inner(url, init);
    });
    const settleQuote = jest.fn(async (transfer: { quoteId?: string }) => ({
      status: "settled" as const,
      quoteId: transfer?.quoteId ?? "quote_stale",
    }));
    const run = (now: Date) =>
      reconcilePendingManagedVeniceTokenQuotes({
        db: memory.db,
        rpcUrl: "https://base.test",
        fetchImpl: chain.fetchImpl,
        minConfirmations: 2,
        settleQuote,
        now,
        clock: () => nowMs,
        staleScanBudgetMs: 60_000,
        interQuoteDelayMs: 0,
        rpcSleepImpl: async () => {},
      });
    const blockReadsFor = (block: number) =>
      chain.requests.filter(
        (request) =>
          request.method === "eth_getBlockByNumber" &&
          request.params[0] === `0x${block.toString(16)}`
      ).length;

    const day1 = await run(staleNow);
    expect(day1.deferred.open).toBe(1);
    // Day 1 resolved the stamp inside the scan — and wrote it into the
    // coverage record.
    const day1Reads = blockReadsFor(paymentBlock);
    expect(day1Reads).toBeGreaterThanOrEqual(1);
    const day1Progress = (memory.tables.managed_venice_token_quotes[0].metadata as Row)
      .depositScanProgress as Record<
      string,
      { transfers: Array<{ transactionHash: string; logTimestampSec: number | null }> }
    >;
    const stamped = day1Progress?.[HERMESOS_TOKEN_ADDRESS.toLowerCase()]?.transfers?.[0];
    expect(stamped).toEqual(
      expect.objectContaining({
        transactionHash: "0xprefixpaid",
        logTimestampSec: Math.floor(Date.parse(chain.blockTimestamp(paymentBlock)) / 1000),
      })
    );

    const day2 = await run(new Date("2026-05-21T00:00:00.000Z"));

    expect(day2.settled).toBe(1);
    // The seeded stamp made the resume's timestamp resolution a no-op: the
    // payment's block was NOT re-read on day 2, so the slice went to the
    // uncovered tail instead of another serial timestamp pass.
    expect(blockReadsFor(paymentBlock)).toBe(day1Reads);
  });

  it("keeps the timestamps a deadline-aborted lookup already resolved, so the next day resumes it", async () => {
    // A fully-covered checkpoint whose transfers carry no stamps sends the
    // whole serial timestamp pass through the stale slice with nothing
    // persisted until it returns: an abort mid-lookup used to lose every
    // resolved stamp, so a quote with enough unstamped transfers died at
    // the same lookup every day — permanently. Stamps now flush into the
    // coverage record as they land (batched + on abort), so the next pass
    // resumes the lookup instead of restarting it.
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [staleQuoteRow()],
      ops_cron_heartbeats: [heartbeatYesterday],
    });
    const chain = staleChain();
    const amount = BigInt(staleQuoteRow().token_amount_raw as string);
    const fromBlock = chain.blockAt("2026-05-01T10:00:00.000Z");
    const toBlock = chain.blockAt("2026-05-01T12:20:00.000Z");
    const unstampedBlocks = [
      chain.blockAt("2026-05-01T10:10:00.000Z"),
      chain.blockAt("2026-05-01T10:30:00.000Z"),
      chain.blockAt("2026-05-01T10:50:00.000Z"),
    ];
    const seedProgress = {
      [HERMESOS_TOKEN_ADDRESS.toLowerCase()]: {
        v: 1,
        tokenAddress: HERMESOS_TOKEN_ADDRESS.toLowerCase(),
        fromBlock,
        toBlock,
        scannedThroughBlock: toBlock, // fully covered: no eth_getLogs at all
        transfers: unstampedBlocks.map((blockNumber, index) => ({
          transactionHash: `0xunstamped${index}`,
          logIndex: 0,
          blockNumber,
          amount: amount.toString(),
          logTimestampSec: null,
        })),
      },
    };
    const row = memory.tables.managed_venice_token_quotes[0];
    row.metadata = { ...(row.metadata as Row), depositScanProgress: seedProgress };

    // Every transfer-block lookup burns 50 s of the slice, so the pass dies
    // inside the timestamp pass after exactly two resolutions.
    let nowMs = 0;
    const lookupBlocks = new Set(unstampedBlocks);
    const inner = chain.fetchImpl.getMockImplementation()!;
    chain.fetchImpl.mockImplementation(async (url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string; params: unknown[] };
      if (
        request.method === "eth_getBlockByNumber" &&
        lookupBlocks.has(Number.parseInt(String(request.params[0]), 16))
      ) {
        nowMs += 50_000;
      }
      return inner(url, init);
    });
    const settleQuote = jest.fn(async (transfer: { quoteId?: string }) => ({
      status: "settled" as const,
      quoteId: transfer?.quoteId ?? "quote_stale",
    }));
    const run = (now: Date) =>
      reconcilePendingManagedVeniceTokenQuotes({
        db: memory.db,
        rpcUrl: "https://base.test",
        fetchImpl: chain.fetchImpl,
        minConfirmations: 2,
        settleQuote,
        now,
        clock: () => nowMs,
        staleScanBudgetMs: 60_000,
        interQuoteDelayMs: 0,
        rpcSleepImpl: async () => {},
      });
    const blockReadsFor = (block: number) =>
      chain.requests.filter(
        (request) =>
          request.method === "eth_getBlockByNumber" &&
          request.params[0] === `0x${block.toString(16)}`
      ).length;

    const day1 = await run(staleNow);

    expect(day1.deferred.open).toBe(1);
    expect(day1.settled).toBe(0);
    const day1Progress = (memory.tables.managed_venice_token_quotes[0].metadata as Row)
      .depositScanProgress as Record<
      string,
      { scannedThroughBlock: number; transfers: Array<{ logTimestampSec: number | null }> }
    >;
    const day1Transfers = day1Progress?.[HERMESOS_TOKEN_ADDRESS.toLowerCase()]?.transfers ?? [];
    // The two lookups the slice paid for are stamped IN the checkpoint; the
    // third — aborted before its request — stays null.
    expect(day1Transfers.map((entry) => entry.logTimestampSec !== null)).toEqual([
      true,
      true,
      false,
    ]);

    const day2 = await run(new Date("2026-05-21T00:00:00.000Z"));

    expect(day2.settled).toBe(1);
    // Day 2 spent exactly one lookup — on the one block day 1 never reached.
    // Under the old behaviour all three were re-read and the slice died the
    // same way again.
    expect(blockReadsFor(unstampedBlocks[0])).toBe(1);
    expect(blockReadsFor(unstampedBlocks[1])).toBe(1);
    expect(blockReadsFor(unstampedBlocks[2])).toBe(1);
    const day2Transfers = (
      (memory.tables.managed_venice_token_quotes[0].metadata as Row).depositScanProgress as Record<
        string,
        { transfers: Array<{ logTimestampSec: number | null }> }
      >
    )?.[HERMESOS_TOKEN_ADDRESS.toLowerCase()]?.transfers;
    expect(day2Transfers?.every((entry) => entry.logTimestampSec !== null)).toBe(true);
  });

  it("checkpoints only final coverage and re-scans the non-final tail on resume", async () => {
    // A resumable scan running close behind the head used to persist every
    // covered block — including ones a reorg could still replace. The record
    // is authoritative (the tail is never refetched once it is in the mark),
    // so a transfer mined into a replaced block would stay missed forever
    // and the quote could retire over it. Only coverage the finality margin
    // puts beyond a reorg is checkpointed; the still-non-final tail is
    // re-scanned on every attempt until it finalizes.
    const chain = makeChain();
    const nonFinalBlock = HEAD_BLOCK - 10; // inside the 30-block margin
    const finalBlock = HEAD_BLOCK - 50; // outside it
    chain.addTransfer(
      transferAt(finalBlock, BigInt(quoteRow.token_amount_raw as string), "0xfinalpaid")
    );
    chain.addTransfer(
      transferAt(nonFinalBlock, BigInt(quoteRow.token_amount_raw as string), "0xnonfinalpaid")
    );
    const recorded: Array<{
      scannedThroughBlock: number;
      transfers: Array<{ transactionHash: string; blockNumber: number }>;
    }> = [];
    const settleQuote = jest.fn(async () => ({ status: "settled" as const, quoteId: "quote_1" }));
    const reconcileWith = (
      saved: unknown,
      sink: typeof recorded
    ) =>
      reconcileManagedVeniceTokenQuote({
        quoteId: "quote_1",
        userId: "user_1",
        db: createMemoryDb([quoteRow]),
        rpcUrl: "https://base.test",
        fetchImpl: chain.fetchImpl,
        minConfirmations: 2,
        settleQuote,
        now: new Date("2026-05-16T10:22:00.000Z"),
        scanProgress: { saved, checkpoint: async (scan) => void sink.push(scan) },
      });

    await reconcileWith({}, recorded);

    // The scan covered through the head, but the persisted mark stops at the
    // finality margin — and so does the persisted transfer set.
    expect(recorded.length).toBeGreaterThan(0);
    const persisted = recorded[recorded.length - 1];
    expect(persisted.scannedThroughBlock).toBe(HEAD_BLOCK - 30);
    expect(persisted.transfers.map((t) => t.transactionHash)).toEqual(["0xfinalpaid"]);

    // Resume off that record: the non-final tail — including the second
    // transfer's block — is re-read, never trusted from coverage.
    const requestsBefore = chain.requests.length;
    await reconcileWith(
      { [HERMESOS_TOKEN_ADDRESS.toLowerCase()]: persisted },
      []
    );
    const resumeRanges = chain.requests
      .slice(requestsBefore)
      .filter((request) => request.method === "eth_getLogs")
      .map((request) => request.params[0] as { fromBlock: string; toBlock: string });
    expect(resumeRanges.length).toBeGreaterThan(0);
    expect(Number.parseInt(resumeRanges[0].fromBlock, 16)).toBe(HEAD_BLOCK - 30 + 1);
    expect(
      Number.parseInt(resumeRanges[resumeRanges.length - 1].toBlock, 16)
    ).toBeGreaterThanOrEqual(nonFinalBlock);
  });

  it("rejects a checkpoint whose persisted transfer lies outside its covered range", async () => {
    // A corrupt record claims coverage through block 100 but carries a
    // transfer at block 105 — that log was never part of the proven scan,
    // yet seeding it makes it a settle candidate with confirmations computed
    // off today's head. The record must fail closed like any other malformed
    // checkpoint: the whole range is re-scanned and the phantom transfer
    // never reaches settle.
    const chain = makeChain();
    const settleQuote = jest.fn(async () => ({ status: "settled" as const, quoteId: "quote_1" }));
    // quoteRow's window maps fromBlock 50 (quoted_at) to toBlock 110 (head
    // below the grace end): scannedThroughBlock 100 is a valid-looking
    // checkpoint, blockNumber 105 is outside it.
    const corrupt = {
      v: 1,
      tokenAddress: HERMESOS_TOKEN_ADDRESS.toLowerCase(),
      fromBlock: 50,
      toBlock: HEAD_BLOCK,
      scannedThroughBlock: 100,
      transfers: [
        {
          transactionHash: "0xghost",
          logIndex: 0,
          blockNumber: 105,
          amount: quoteRow.token_amount_raw,
          logTimestampSec: null,
        },
      ],
    };

    const result = await reconcileManagedVeniceTokenQuote({
      quoteId: "quote_1",
      userId: "user_1",
      db: createMemoryDb([quoteRow]),
      rpcUrl: "https://base.test",
      fetchImpl: chain.fetchImpl,
      minConfirmations: 2,
      settleQuote,
      now: new Date("2026-05-16T10:22:00.000Z"),
      scanProgress: {
        saved: { [HERMESOS_TOKEN_ADDRESS.toLowerCase()]: corrupt },
        checkpoint: async () => {},
      },
    });

    // The record was dropped: the scan re-ran from the window's first block
    // instead of resuming at 101, and the phantom transfer was never a
    // settle candidate.
    const scanRanges = chain.requests
      .filter((request) => request.method === "eth_getLogs")
      .map((request) => request.params[0] as { fromBlock: string });
    expect(scanRanges.length).toBeGreaterThan(0);
    expect(Number.parseInt(scanRanges[0].fromBlock, 16)).toBe(50);
    expect(settleQuote).not.toHaveBeenCalled();
    expect(result.status).toBe("no_match");
  });

  it("never stamps the grace-scan marker over a settlement claim that landed mid-scan", async () => {
    // A stale row's catch-up scan runs while a competing worker claims the
    // quote: the claim CAS writes transaction_hash plus the claim payload in
    // metadata.settlementClaim. The marker write that used to follow rewrote
    // the SELECTION-time metadata — erasing settlementClaim while leaving
    // transaction_hash — and recovery then read a paid quote as
    // claimed-but-claimless and sent it to manual review. The marker's
    // transaction_hash IS NULL guard (the same one the scan checkpoint
    // writes carry) makes the write a no-op instead.
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [
        {
          ...staleQuoteRow(),
          status: "expired",
          metadata: {
            ...(staleQuoteRow().metadata as Row),
            closedReason: "no_deposit_after_grace",
          },
        },
      ],
      ops_cron_heartbeats: [heartbeatYesterday],
    });
    const chain = staleChain();
    const liveRow = memory.tables.managed_venice_token_quotes[0];
    // The claim lands between the pass's selection read and its post-scan
    // marker write — hook the first log request for a deterministic point.
    const inner = chain.fetchImpl.getMockImplementation()!;
    let claimed = false;
    chain.fetchImpl.mockImplementation(async (url: string, init: { body: string }) => {
      const response = await inner(url, init);
      if (!claimed && (JSON.parse(init.body) as { method: string }).method === "eth_getLogs") {
        claimed = true;
        liveRow.transaction_hash = "0xclaimedmidscan";
        liveRow.metadata = {
          ...(liveRow.metadata as Row),
          settlementClaim: { claimedAt: "2026-05-20T00:00:00.000Z", transactionHash: "0xclaimedmidscan" },
        };
      }
      return response;
    });

    const summary = await runBatch(memory.db, chain);

    expect(chain.methodCount("eth_getLogs")).toBeGreaterThan(0);
    // The claim survived intact: hash AND claim payload both present.
    expect(liveRow.transaction_hash).toBe("0xclaimedmidscan");
    expect((liveRow.metadata as Row).settlementClaim).toEqual(
      expect.objectContaining({ transactionHash: "0xclaimedmidscan" })
    );
    // The marker write refused to touch a claimed row: no grace stamp, and
    // the selection-read metadata did not overwrite the claim's.
    expect((liveRow.metadata as Row).graceWindowScannedAt).toBeUndefined();
    expect(summary.checked).toBeGreaterThanOrEqual(1);
  });

  it("refuses the grace-scan marker over a deposit lot, then recovers it on the next pass", async () => {
    // The marker's transaction_hash guard refuses claimed rows — but a lot
    // is not a claim: a settlement that crashed between the lot insert and
    // the quote flip holds a lot with transaction_hash still null, and a
    // lot can also land mid-scan right here (the retire re-read finds it
    // and refuses to cancel). Stamping the marker over either would
    // exclude the row from the stale selection for good while the open
    // lane's bounded lot probe may never reach it — settlement recovery is
    // the lot's only path, so the marker must not discharge the row.
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [
        {
          ...staleQuoteRow(),
          status: "expired",
          metadata: {
            ...(staleQuoteRow().metadata as Row),
            closedReason: "no_deposit_after_grace",
          },
        },
      ],
      ops_cron_heartbeats: [heartbeatYesterday],
    });
    const chain = staleChain();
    const inner = chain.fetchImpl.getMockImplementation()!;
    let landed = false;
    chain.fetchImpl.mockImplementation(async (url: string, init: { body: string }) => {
      const response = await inner(url, init);
      if (!landed && (JSON.parse(init.body) as { method: string }).method === "eth_getLogs") {
        landed = true;
        memory.insertRow("managed_venice_token_lots", {
          id: "lot_midscan",
          account_id: "account_1",
          user_id: "user_1",
          quote_id: "quote_stale",
          source: "hermesos_deposit",
          token_amount_raw: "1000000000000000000000",
          remaining_token_amount_raw: "1000000000000000000000",
          snapshot_price_usd: "0.05",
          original_value_micro_usd: 50_000_000,
          remaining_value_micro_usd: 50_000_000,
          quote_source: "dexscreener",
          quoted_at: "2026-05-01T10:00:00.000Z",
          quote_expires_at: "2026-05-01T10:20:00.000Z",
          transaction_hash: "0xlotpaidmidscan",
          status: "active",
          metadata: {},
        });
      }
      return response;
    });

    await runBatch(memory.db, chain);

    const row = memory.tables.managed_venice_token_quotes[0];
    expect(chain.methodCount("eth_getLogs")).toBeGreaterThan(0);
    expect(row.status).toBe("expired");
    expect(row.transaction_hash).toBeNull();
    // No marker: the row keeps its place, so a later pass's recovery branch
    // — not a scan — finishes the settlement the lot belongs to.
    expect((row.metadata as Row).graceWindowScannedAt).toBeUndefined();
  });

  it("recovers a marked lot-only quote the stale selection excludes", async () => {
    // The stale selection drops rows carrying both closedReason =
    // no_deposit_after_grace and the grace marker — correct for a proved
    // empty window, but a row in that state can still hold a deposit lot
    // (one landed while its catch-up scan ran before the marker learned the
    // lot check, or a legacy lot-only row was expired sight-unseen and
    // marked under an older guard). Such a row owes settlement recovery,
    // needs no scan, and can sit beyond the open lane's bounded lot probe —
    // so the pass hands a rotating slice of marked rows a lot check and
    // finishes this one on the lot's tx.
    const marked = staleQuoteRow({
      status: "expired",
      metadata: {
        ...(staleQuoteRow().metadata as Row),
        closedReason: "no_deposit_after_grace",
        graceWindowScannedAt: "2026-05-19T00:00:00.000Z",
      },
    });
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [marked],
      managed_venice_token_lots: [
        {
          id: "lot_marked",
          account_id: "account_1",
          user_id: "user_1",
          quote_id: "quote_stale",
          source: "hermesos_deposit",
          token_amount_raw: "1000000000000000000000",
          remaining_token_amount_raw: "1000000000000000000000",
          snapshot_price_usd: "0.05",
          original_value_micro_usd: 50_000_000,
          remaining_value_micro_usd: 50_000_000,
          quote_source: "dexscreener",
          quoted_at: "2026-05-01T10:00:00.000Z",
          quote_expires_at: "2026-05-01T10:20:00.000Z",
          transaction_hash: "0xmarkedlotpaid",
          status: "active",
          metadata: {},
        },
      ],
      ops_cron_heartbeats: [heartbeatYesterday],
    });
    const chain = staleChain();
    const settleQuote = jest.fn(async () => ({ status: "settled" as const, quoteId: "quote_stale" }));

    const summary = await reconcilePendingManagedVeniceTokenQuotes({
      db: memory.db,
      rpcUrl: "https://base.test",
      fetchImpl: chain.fetchImpl,
      minConfirmations: 2,
      settleQuote,
      now: staleNow,
      interQuoteDelayMs: 0,
      rpcSleepImpl: async () => {},
    });

    // The marked row was never scanned — it settles on the lot's tx.
    expect(chain.methodCount("eth_getLogs")).toBe(0);
    expect(settleQuote).toHaveBeenCalledWith(
      expect.objectContaining({ quoteId: "quote_stale", transactionHash: "0xmarkedlotpaid" }),
      expect.anything()
    );
    expect(summary.settled).toBe(1);
    expect(summary.results).toEqual([
      expect.objectContaining({ quoteId: "quote_stale", status: "settled" }),
    ]);
  });

  it("only lot-checks marked rows — a marked lot-free row is rotated, not reconciled", async () => {
    // The marked-row probe exists for lot recovery only: a marked row with
    // no lot must NOT be re-admitted to reconcile — re-scanning it every
    // day is exactly what the marker exists to prevent. It is only
    // cursor-rotated so the whole marked backlog gets its lot check across
    // days.
    const marked = staleQuoteRow({
      status: "expired",
      metadata: {
        ...(staleQuoteRow().metadata as Row),
        closedReason: "no_deposit_after_grace",
        graceWindowScannedAt: "2026-05-19T00:00:00.000Z",
      },
    });
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [marked],
      ops_cron_heartbeats: [heartbeatYesterday],
    });
    const chain = staleChain();
    const settleQuote = jest.fn(async () => ({ status: "settled" as const, quoteId: "quote_stale" }));

    const summary = await reconcilePendingManagedVeniceTokenQuotes({
      db: memory.db,
      rpcUrl: "https://base.test",
      fetchImpl: chain.fetchImpl,
      minConfirmations: 2,
      settleQuote,
      now: staleNow,
      interQuoteDelayMs: 0,
      rpcSleepImpl: async () => {},
    });

    // No scan, no settle, no outcome — the marker's exclusion held. The row
    // did move to the back of the probe queue (its updated_at cursor ran).
    expect(chain.methodCount("eth_getLogs")).toBe(0);
    expect(settleQuote).not.toHaveBeenCalled();
    expect(summary.results).toEqual([]);
    expect(summary.checked).toBe(0);
    const row = memory.tables.managed_venice_token_quotes[0];
    expect(row.status).toBe("expired");
    expect(row.updated_at).toBe(staleNow.toISOString());
  });

  it("advances marked-probe cursors in bulk so the writes cannot eat the day's scan slice", async () => {
    // Every probed marked row's queue cursor must advance so the probe
    // rotates — but the advance used to be an awaited UPDATE per row, paid
    // out of the same clock the scans are bounded by: ~200 ids at a
    // round-trip each cost more than the whole 60 s slice, so every day's
    // stale scan deferred before it started. The advance is now one bounded
    // bulk update for the whole probed-id set.
    const marked = Array.from({ length: 8 }, (_, index) =>
      staleQuoteRow({
        id: `quote_marked_${index}`,
        status: "expired",
        deposit_address: `0x${String(index + 16).padStart(40, "0")}`,
        metadata: {
          ...(staleQuoteRow().metadata as Row),
          closedReason: "no_deposit_after_grace",
          graceWindowScannedAt: "2026-05-19T00:00:00.000Z",
        },
        updated_at: `2026-05-01T10:0${index}:00.000Z`,
      })
    );
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [...marked, staleQuoteRow({ id: "quote_scan", deposit_address: `0x${"9".repeat(40)}` })],
      ops_cron_heartbeats: [heartbeatYesterday],
    });
    const chain = staleChain();
    // Each cursor-advance UPDATE costs 30 s of tick clock: the old per-row
    // loop would burn 240 s — four times the 60 s slice — before a single
    // scan started. One bulk write leaves the slice nearly whole. Only
    // {updated_at}-only patches count: checkpoint and marker writes merge
    // metadata, and the retire write flips status.
    let nowMs = 0;
    const baseDb = memory.db;
    const clockDb = {
      ...baseDb,
      from(name: string) {
        const table = baseDb.from(name) as {
          select: () => unknown;
          insert: (input: MemoryRow) => unknown;
          upsert: (input: MemoryRow, options?: unknown) => unknown;
          update: (patch: MemoryRow) => unknown;
        };
        return {
          ...table,
          update(patch: MemoryRow) {
            if (name === "managed_venice_token_quotes" && Object.keys(patch).length === 1) {
              nowMs += 30_000;
            }
            return table.update(patch);
          },
        };
      },
    };

    const summary = await reconcilePendingManagedVeniceTokenQuotes({
      db: clockDb,
      rpcUrl: "https://base.test",
      fetchImpl: chain.fetchImpl,
      minConfirmations: 2,
      settleQuote: jest.fn(async () => ({ status: "settled" as const, quoteId: "quote_scan" })),
      now: staleNow,
      clock: () => nowMs,
      staleScanBudgetMs: 60_000,
      interQuoteDelayMs: 0,
      rpcSleepImpl: async () => {},
    });

    // The slice survived the cursor phase: the stale quote got its real log
    // scan and retired — before the fix all eight writes ran serially, the
    // budget was already spent, and the scan deferred (eth_getLogs: 0).
    expect(chain.methodCount("eth_getLogs")).toBeGreaterThan(0);
    expect(summary.cancelled).toBe(1);
    expect(summary.results).toEqual([
      expect.objectContaining({ quoteId: "quote_scan", status: "cancelled" }),
    ]);
    expect(summary.deferred.open).toBe(0);
    // The rotation itself is unchanged: every probed marked row moved to the
    // back of tomorrow's probe.
    const rows = memory.tables.managed_venice_token_quotes;
    expect(
      rows
        .filter((row) => (row.id as string).startsWith("quote_marked_"))
        .every((row) => row.updated_at === staleNow.toISOString())
    ).toBe(true);
    // And it was a bounded write set — the bulk advance plus the scanned
    // row's own post-scan touch — not eight serial round-trips.
    const cursorWrites = memory.calls.filter(
      (call) =>
        call.table === "managed_venice_token_quotes" &&
        call.kind === "update" &&
        call.payload &&
        Object.keys(call.payload).length === 1 &&
        "updated_at" in call.payload
    );
    expect(cursorWrites.length).toBeLessThanOrEqual(2);
  });

  it("bounds the marked-lot lane to a share of the stale slice so the day's scans still run", async () => {
    // Each marked lot-holder's recovery attempt burns ~35 s of tick clock
    // inside its settle. Two of them used to consume the whole 60 s stale
    // slice ahead of the first ordinary stale scan — the budget was only
    // checked between attempts — and the UTC-day claim blocks a same-day
    // retry, so a persistently slow marked set starved the day's scans
    // every day. The lane is now bounded to a share of the slice: the
    // second holder is deferred out of the pass and the stale quote gets
    // its scan.
    const markedRow = (index: number) =>
      staleQuoteRow({
        id: `quote_marked_${index}`,
        status: "expired",
        deposit_address: `0x${String(index + 16).padStart(40, "0")}`,
        metadata: {
          ...(staleQuoteRow().metadata as Row),
          closedReason: "no_deposit_after_grace",
          graceWindowScannedAt: "2026-05-19T00:00:00.000Z",
        },
        // Probe order: least-recently-touched first, so marked_0 attempts
        // ahead of marked_1.
        updated_at: `2026-05-01T10:0${index}:00.000Z`,
      });
    const marked = [markedRow(0), markedRow(1)];
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [
        ...marked,
        staleQuoteRow({ id: "quote_scan", deposit_address: `0x${"9".repeat(40)}` }),
      ],
      managed_venice_token_lots: marked.map((row, index) => ({
        id: `lot_marked_${index}`,
        account_id: "account_1",
        user_id: "user_1",
        quote_id: row.id,
        source: "hermesos_deposit",
        token_amount_raw: "1000000000000000000000",
        remaining_token_amount_raw: "1000000000000000000000",
        snapshot_price_usd: "0.05",
        original_value_micro_usd: 50_000_000,
        remaining_value_micro_usd: 50_000_000,
        quote_source: "dexscreener",
        quoted_at: "2026-05-01T10:00:00.000Z",
        quote_expires_at: "2026-05-01T10:20:00.000Z",
        transaction_hash: `0xmarkedlotpaid${index}`,
        status: "active",
        metadata: {},
      })),
      ops_cron_heartbeats: [heartbeatYesterday],
    });
    const chain = staleChain();
    // The fake clock moves only inside a settle call: 35 s per marked
    // attempt, the starvation scenario.
    let nowMs = 0;
    const settleQuote = jest.fn(async (transfer: { quoteId?: string }) => {
      nowMs += 35_000;
      return { status: "settled" as const, quoteId: transfer.quoteId ?? "unknown" };
    });

    const summary = await reconcilePendingManagedVeniceTokenQuotes({
      db: memory.db,
      rpcUrl: "https://base.test",
      fetchImpl: chain.fetchImpl,
      minConfirmations: 2,
      settleQuote,
      now: staleNow,
      clock: () => nowMs,
      staleScanBudgetMs: 60_000,
      interQuoteDelayMs: 0,
      rpcSleepImpl: async () => {},
    });

    // The stale quote got its real log scan inside the window the marked
    // lane can never take: before the fix both attempts ran (70 s), the
    // scan loop found the slice already spent, and the row deferred to
    // tomorrow — every day the marked set stayed slow (eth_getLogs: 0).
    expect(chain.methodCount("eth_getLogs")).toBeGreaterThan(0);
    expect(summary.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ quoteId: "quote_scan", status: "cancelled" }),
      ])
    );
    // One marked attempt fit inside the lane's share; the second was
    // deferred out of the pass — then the open lane's own lot probe
    // reached it and settled it later in the same tick, so no owed
    // settlement was lost to the bound.
    expect(summary.deferred.open).toBe(1);
    expect(summary.settled).toBe(2);
    // The deferred holder keeps the front of tomorrow's probe: only the
    // attempted row's queue cursor advanced.
    const markedRows = memory.tables.managed_venice_token_quotes.filter((row) =>
      (row.id as string).startsWith("quote_marked_")
    );
    expect(markedRows.find((row) => row.id === "quote_marked_0")?.updated_at).toBe(
      staleNow.toISOString()
    );
    expect(markedRows.find((row) => row.id === "quote_marked_1")?.updated_at).toBe(
      "2026-05-01T10:01:00.000Z"
    );
  });

  it("degrades the tick — but still runs the regular lanes — when the day's claim write fails", async () => {
    // claimCronUtcDay collapses "another run holds today" and "the claim
    // write failed" into one false: the first is a clean skip, the second
    // means the once-daily pass ran on NO tick while the route could stamp
    // a clean heartbeat. A failed claim now flags the summary so the route
    // degrades — while the regular lanes are completely unaffected.
    const freshQuote = staleQuoteRow({
      id: "quote_fresh",
      deposit_address: `0x${"9".repeat(40)}`,
      quoted_at: "2026-05-19T22:40:00.000Z",
      expires_at: "2026-05-19T23:00:00.000Z",
      created_at: "2026-05-19T22:40:00.000Z",
      updated_at: "2026-05-19T22:40:00.000Z",
    });
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [staleQuoteRow(), freshQuote],
      ops_cron_heartbeats: [heartbeatYesterday],
    });
    const chain = staleChain();
    memory.failNext({ table: "ops_cron_heartbeats", op: "update" });

    const summary = await runBatch(memory.db, chain);

    expect(summary.staleScanClaimFailed).toBe(true);
    expect(summary.staleScanLoadFailed).toBe(false);
    // The stale quote was never scanned: still open, not expired sight-unseen.
    const stale = memory.tables.managed_venice_token_quotes.find((row) => row.id === "quote_stale");
    expect(stale?.status).toBe("active");
    // The regular open lane still ran: the in-grace fresh quote got its real
    // log scan and outcome instead of dying with the claim.
    expect(chain.methodCount("eth_getLogs")).toBeGreaterThan(0);
    expect(summary.checked).toBe(1);
    expect(summary.results.map((result) => result.quoteId)).toEqual(["quote_fresh"]);
  });
});
