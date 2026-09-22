import { MANAGED_VENICE_TOKEN_DEPOSIT_REASONS } from "@/lib/billing/managed-venice-token-quotes";
import {
  reconcileManagedVeniceTokenQuote,
  reconcilePendingManagedVeniceTokenQuotes,
  RpcHttpError,
} from "@/lib/billing/managed-venice-token-reconciliation";
import {
  createBaseRpcFake,
  createManagedVeniceMemoryDb,
  managedVeniceQuoteRow,
  TEST_DEPOSIT_ADDRESS,
  type FakeTransfer,
  type MemoryRow,
} from "@/test-utils/managed-venice-memory-db";

// End-to-end reconciler behaviour: real reconcile -> real settle against the
// memory DB, with a Base RPC fake that has real per-block timestamps (2 s
// blocks) and enforces the public endpoint's 2,000-block eth_getLogs limit.

const ANCHOR_BLOCK = 5_000_000;
const ANCHOR_TIME = "2026-05-16T10:35:00.000Z";
const QUOTED = 1000n * 10n ** 18n;
const UNDER = (QUOTED * 9n) / 10n;
const OVER = (QUOTED * 11n) / 10n;
const FAT = QUOTED * 3n;

function blockAt(iso: string) {
  return ANCHOR_BLOCK + Math.floor((Date.parse(iso) - Date.parse(ANCHOR_TIME)) / 2000);
}

function transfer(txHash: string, amount: bigint, iso: string, extra: Partial<FakeTransfer> = {}): FakeTransfer {
  return { txHash, amountRaw: amount, block: blockAt(iso), to: TEST_DEPOSIT_ADDRESS, ...extra };
}

function chain(transfers: FakeTransfer[] = []) {
  return createBaseRpcFake({ latestBlock: ANCHOR_BLOCK, latestTimestamp: ANCHOR_TIME, transfers });
}

type Chain = ReturnType<typeof chain>;
type Memory = ReturnType<typeof createManagedVeniceMemoryDb>;

// Move the chain head to `iso` and reconcile with `now` = `iso`.
async function reconcileAt(memory: Memory, rpc: Chain, iso: string, quoteId = "quote_1", userId = "user_1") {
  rpc.setLatestBlock(blockAt(iso));
  return reconcileManagedVeniceTokenQuote({
    quoteId,
    userId,
    db: memory.db,
    rpcUrl: "https://base.test",
    fetchImpl: rpc.fetchImpl,
    minConfirmations: 3,
    now: new Date(iso),
  });
}

async function tickAt(memory: Memory, rpc: Chain, iso: string, extra: { limit?: number } = {}) {
  rpc.setLatestBlock(blockAt(iso));
  return reconcilePendingManagedVeniceTokenQuotes({
    db: memory.db,
    rpcUrl: "https://base.test",
    fetchImpl: rpc.fetchImpl,
    minConfirmations: 3,
    now: new Date(iso),
    interQuoteDelayMs: 0,
    rpcSleepImpl: async () => {},
    ...extra,
  });
}

function seed(...quotes: MemoryRow[]) {
  return createManagedVeniceMemoryDb({
    managed_venice_token_quotes: quotes.length ? quotes : [managedVeniceQuoteRow()],
  });
}

function quote(memory: Memory, id = "quote_1") {
  return memory.tables.managed_venice_token_quotes.find((row) => row.id === id)!;
}

function items(memory: Memory) {
  return memory.tables.managed_venice_reconciliation_items;
}

describe("managed Venice reconciler: attribution and selection", () => {
  it("bug 3: an old historical exact transfer never beats a newer in-window over-send", async () => {
    const memory = seed();
    const rpc = chain([
      transfer("0xold_exact", QUOTED, "2026-05-16T09:00:00.000Z"),
      transfer("0xnew_over", OVER, "2026-05-16T10:21:00.000Z"),
    ]);

    const result = await reconcileAt(memory, rpc, "2026-05-16T10:25:00.000Z");

    expect(result.status).toBe("settled");
    expect(quote(memory)).toMatchObject({ status: "settled", transaction_hash: "0xnew_over" });
    expect(memory.tables.managed_venice_token_lots).toEqual([
      expect.objectContaining({ transaction_hash: "0xnew_over", token_amount_raw: OVER.toString() }),
    ]);
    expect(items(memory)).toHaveLength(0);
  });

  it("settles the EARLIEST qualifying in-window transfer and surfaces later ones once", async () => {
    const memory = seed();
    const rpc = chain([
      transfer("0xfirst_over", OVER, "2026-05-16T10:21:00.000Z"),
      transfer("0xsecond_exact", QUOTED, "2026-05-16T10:22:00.000Z"),
    ]);

    await reconcileAt(memory, rpc, "2026-05-16T10:25:00.000Z");
    // A bearer redelivery of the extra transfer and a repeat check add nothing.
    await reconcileAt(memory, rpc, "2026-05-16T10:26:00.000Z");

    expect(quote(memory)).toMatchObject({ status: "settled", transaction_hash: "0xfirst_over" });
    expect(items(memory)).toEqual([
      expect.objectContaining({
        reason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.extraTransfer,
        dedupe_key: "managed_venice_token_transfer:0xsecond_exact",
      }),
    ]);
  });

  it("returns underconfirmed for an under-confirmed earliest candidate instead of acting on anything else", async () => {
    const memory = seed();
    const rpc = chain([
      transfer("0xold", QUOTED, "2026-05-16T09:00:00.000Z"),
      transfer("0xfat", FAT, "2026-05-16T10:21:00.000Z"),
      transfer("0xexact", QUOTED, "2026-05-16T10:24:58.000Z"),
    ]);

    // Head at 10:25:00 -> the exact transfer has 2 confirmations (< 3).
    const pending = await reconcileAt(memory, rpc, "2026-05-16T10:25:00.000Z");
    expect(pending).toMatchObject({ status: "underconfirmed", confirmations: 2 });
    expect(quote(memory)).toMatchObject({ status: "active", transaction_hash: null });
    expect(items(memory)).toHaveLength(0);

    const settled = await reconcileAt(memory, rpc, "2026-05-16T10:25:10.000Z");
    expect(settled.status).toBe("settled");
    expect(quote(memory).transaction_hash).toBe("0xexact");
    // Surfaced after the settle with its class reason (above the 2x ceiling),
    // the same reason the surface-only pass would give it.
    expect(items(memory)).toEqual([
      expect.objectContaining({
        reason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.amountMismatch,
        dedupe_key: "managed_venice_token_transfer:0xfat",
      }),
    ]);
  });

  it("ignores zero-value dust transfers", async () => {
    const memory = seed();
    const rpc = chain([transfer("0xdust", 0n, "2026-05-16T10:21:00.000Z")]);

    const result = await reconcileAt(memory, rpc, "2026-05-16T10:45:00.000Z");

    expect(result.status).toBe("no_match");
    expect(items(memory)).toHaveLength(0);
  });
});

describe("managed Venice reconciler: cross-quote capture on the shared deposit wallet", () => {
  const q1 = () =>
    managedVeniceQuoteRow({
      id: "quote_1",
      status: "expired",
      quoted_at: "2026-05-16T10:00:00.000Z",
      expires_at: "2026-05-16T10:20:00.000Z",
      created_at: "2026-05-16T10:00:00.000Z",
    });
  const q2 = (overrides: MemoryRow = {}) =>
    managedVeniceQuoteRow({
      id: "quote_2",
      quoted_at: "2026-05-16T10:30:00.000Z",
      expires_at: "2026-05-16T10:50:00.000Z",
      created_at: "2026-05-16T10:30:00.000Z",
      ...overrides,
    });

  it("bug 6a: an earlier expired quote never binds a later quote's transfer; 0 failures over two ticks", async () => {
    const memory = seed(q1(), q2());
    const rpc = chain([transfer("0xq2paid", QUOTED, "2026-05-16T10:31:00.000Z")]);

    // Cron-first ordering hazard: reconcile the OLD quote before the new one.
    const old = await reconcileAt(memory, rpc, "2026-05-16T10:35:00.000Z", "quote_1");
    const tick1 = await tickAt(memory, rpc, "2026-05-16T10:35:00.000Z");
    const tick2 = await tickAt(memory, rpc, "2026-05-16T10:40:00.000Z");

    expect(old.status).toBe("no_match");
    expect(tick1.failed).toBe(0);
    expect(tick2.failed).toBe(0);
    expect(quote(memory, "quote_2")).toMatchObject({ status: "settled", transaction_hash: "0xq2paid" });
    expect(quote(memory, "quote_1")).toMatchObject({ status: "expired", transaction_hash: null });
    expect(memory.tables.managed_venice_token_lots.map((lot) => lot.quote_id)).toEqual(["quote_2"]);
    expect(items(memory)).toHaveLength(0);
  });

  it("bug 6b: after the user's check settles the new quote, the cron never fails on the old one", async () => {
    const memory = seed(q1(), q2());
    const rpc = chain([transfer("0xq2paid", QUOTED, "2026-05-16T10:31:00.000Z")]);

    await reconcileAt(memory, rpc, "2026-05-16T10:33:00.000Z", "quote_2");
    const tick = await tickAt(memory, rpc, "2026-05-16T10:35:00.000Z");

    expect(tick.failed).toBe(0);
    expect(quote(memory, "quote_1")).toMatchObject({ status: "expired", transaction_hash: null });
  });

  it("a repeat same-amount top-up settles the new quote with its own transfer", async () => {
    const memory = seed(
      managedVeniceQuoteRow({
        id: "quote_1",
        status: "settled",
        transaction_hash: "0xq1paid",
        settled_at: "2026-05-16T10:02:00.000Z",
        quoted_at: "2026-05-16T10:00:00.000Z",
        expires_at: "2026-05-16T10:20:00.000Z",
        created_at: "2026-05-16T10:00:00.000Z",
      }),
      q2()
    );
    const rpc = chain([
      transfer("0xq1paid", QUOTED, "2026-05-16T10:01:00.000Z"),
      transfer("0xq2paid", QUOTED, "2026-05-16T10:31:00.000Z"),
    ]);

    const tick = await tickAt(memory, rpc, "2026-05-16T10:35:00.000Z");

    expect(tick.failed).toBe(0);
    expect(quote(memory, "quote_2")).toMatchObject({ status: "settled", transaction_hash: "0xq2paid" });
  });

  it("never attributes a transfer already bound to another quote or lot", async () => {
    const memory = seed(
      managedVeniceQuoteRow({ id: "quote_other", deposit_address: "0x000000000000000000000000000000000000cafe", status: "settled", transaction_hash: "0xbound" }),
      managedVeniceQuoteRow()
    );
    const rpc = chain([transfer("0xbound", QUOTED, "2026-05-16T10:21:00.000Z")]);

    const result = await reconcileAt(memory, rpc, "2026-05-16T10:25:00.000Z");

    expect(result.status).toBe("no_match");
    expect(quote(memory)).toMatchObject({ status: "active", transaction_hash: null });
    expect(items(memory)).toHaveLength(0);
  });

  it("stops attribution at the user's next $HermesOS payment session (yearly quote) and skips yearly-bound txs", async () => {
    const memory = seed(
      managedVeniceQuoteRow({ status: "expired" })
    );
    memory.insertRow("yearly_token_quotes", {
      id: "yearly_1",
      user_id: "user_1",
      tier: "pro",
      deposit_address: TEST_DEPOSIT_ADDRESS,
      quoted_at: "2026-05-16T10:50:00.000Z",
      expires_at: "2026-05-16T11:10:00.000Z",
      status: "consumed",
      consumed_tx_hash: "0xyearly_consumed",
    });
    const rpc = chain([
      // Late and in band for the venice quote, but it is the yearly payment.
      transfer("0xyearly_consumed", QUOTED, "2026-05-16T10:45:00.000Z"),
      // After the yearly quote was minted: belongs to the yearly session.
      transfer("0xyearly_payment", QUOTED, "2026-05-16T10:51:00.000Z"),
    ]);

    const result = await reconcileAt(memory, rpc, "2026-05-16T11:00:00.000Z");

    expect(result.status).toBe("no_match");
    expect(quote(memory)).toMatchObject({ status: "expired", transaction_hash: null });
    expect(items(memory)).toHaveLength(0);
  });
});

describe("managed Venice reconciler: non-qualifying transfers reach review", () => {
  it("bug 2: an in-window under-payment goes to review once the window has closed, with one item", async () => {
    const memory = seed();
    const rpc = chain([transfer("0xunder", UNDER, "2026-05-16T10:21:00.000Z")]);

    const open = await reconcileAt(memory, rpc, "2026-05-16T10:35:00.000Z");
    expect(open.status).toBe("no_match");
    expect(items(memory)).toHaveLength(0);

    const closed = await reconcileAt(memory, rpc, "2026-05-16T10:45:00.000Z");
    expect(closed.status).toBe("manual_review_required");
    expect(quote(memory)).toMatchObject({ status: "manual_review_required", transaction_hash: null });
    expect(quote(memory).metadata).toMatchObject({
      manualReviewReason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.underpaid,
      reviewTransactionHash: "0xunder",
      managedVeniceTopUp: expect.objectContaining({ reason: "launch" }),
    });

    await reconcileAt(memory, rpc, "2026-05-16T10:50:00.000Z");
    expect(items(memory)).toEqual([
      expect.objectContaining({ reason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.underpaid }),
    ]);
  });

  it("an in-window transfer above 2x goes to review immediately", async () => {
    const memory = seed();
    const rpc = chain([transfer("0xfat", FAT, "2026-05-16T10:21:00.000Z")]);

    const result = await reconcileAt(memory, rpc, "2026-05-16T10:25:00.000Z");

    expect(result.status).toBe("manual_review_required");
    expect(quote(memory).metadata).toMatchObject({
      manualReviewReason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.amountMismatch,
    });
    expect(items(memory)).toHaveLength(1);
  });

  it("a late in-band transfer goes to review as outside the quote window", async () => {
    const memory = seed();
    const rpc = chain([transfer("0xlate", QUOTED, "2026-05-16T10:50:00.000Z")]);

    const result = await reconcileAt(memory, rpc, "2026-05-16T11:00:00.000Z");

    expect(result.status).toBe("manual_review_required");
    expect(quote(memory)).toMatchObject({ transaction_hash: null });
    expect(quote(memory).metadata).toMatchObject({
      manualReviewReason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.outsideQuoteWindow,
    });
  });

  it("a late out-of-band transfer is surfaced once across ticks and does not block retirement", async () => {
    const memory = seed();
    const rpc = chain([transfer("0xlate_small", UNDER, "2026-05-16T10:50:00.000Z")]);

    await tickAt(memory, rpc, "2026-05-16T11:00:00.000Z");
    await tickAt(memory, rpc, "2026-05-16T11:05:00.000Z");
    expect(quote(memory).status).toBe("active");
    expect(items(memory)).toEqual([
      expect.objectContaining({ reason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.unattributedLateTransfer }),
    ]);

    const tick = await tickAt(memory, rpc, "2026-05-16T12:45:00.000Z");
    expect(tick.cancelled).toBe(1);
    expect(quote(memory).status).toBe("cancelled");
    expect(items(memory)).toHaveLength(1);
  });
});

describe("managed Venice reconciler: candidates, retirement and recovery", () => {
  it("bug 4: newest-first candidates reach a fresh paid quote behind 30 abandoned ones", async () => {
    const abandoned = Array.from({ length: 30 }, (_, index) =>
      managedVeniceQuoteRow({
        id: `old_${String(index).padStart(2, "0")}`,
        user_id: `user_old_${index}`,
        deposit_address: `0x${String(index + 1).padStart(40, "0")}`,
        status: "expired",
        quoted_at: `2026-05-01T00:${String(index).padStart(2, "0")}:00.000Z`,
        expires_at: `2026-05-01T00:${String(index + 20).padStart(2, "0")}:00.000Z`,
        created_at: `2026-05-01T00:${String(index).padStart(2, "0")}:00.000Z`,
      })
    );
    const memory = seed(...abandoned, managedVeniceQuoteRow({ id: "fresh", created_at: "2026-05-16T10:20:00.000Z" }));
    const rpc = chain([transfer("0xpaid", QUOTED, "2026-05-16T10:21:00.000Z")]);

    const tick = await tickAt(memory, rpc, "2026-05-16T10:25:00.000Z");

    expect(tick.results[0]).toMatchObject({ quoteId: "fresh", status: "settled" });
    expect(tick.checked).toBe(25);
    expect(tick.failed).toBe(0);
    expect(quote(memory, "fresh")).toMatchObject({ status: "settled", transaction_hash: "0xpaid" });
    // The abandoned quotes are fully scanned and retire instead of pinning the batch.
    expect(tick.cancelled).toBe(24);
  });

  it("retires an unpaid quote to cancelled only after the window + grace is fully confirmed", async () => {
    const memory = seed();
    const rpc = chain();
    const graceEnd = "2026-05-16T12:40:00.000Z"; // 10:40 expiry + 2 h grace

    expect((await reconcileAt(memory, rpc, "2026-05-16T12:00:00.000Z")).status).toBe("no_match");
    // Head exactly at the grace end: the last blocks are not yet confirmed.
    expect((await reconcileAt(memory, rpc, graceEnd)).status).toBe("no_match");
    expect(quote(memory).status).toBe("active");

    const retired = await reconcileAt(memory, rpc, "2026-05-16T12:40:04.000Z");
    expect(retired.status).toBe("cancelled");
    expect(quote(memory)).toMatchObject({
      status: "cancelled",
      metadata: expect.objectContaining({ closedReason: "expired_unpaid" }),
    });

    const tick = await tickAt(memory, rpc, "2026-05-16T13:00:00.000Z");
    expect(tick.checked).toBe(0);
  });

  it("scans the quote's anchored range in <= 2,000-block eth_getLogs chunks", async () => {
    const memory = seed();
    const rpc = chain();

    await reconcileAt(memory, rpc, "2026-05-16T13:00:00.000Z");

    const ranges = rpc.requests
      .filter((request) => request.method === "eth_getLogs")
      .map((request) => request.params[0] as { fromBlock: string; toBlock: string })
      .map((filter) => [Number.parseInt(filter.fromBlock, 16), Number.parseInt(filter.toBlock, 16)]);
    expect(ranges.length).toBeGreaterThanOrEqual(3);
    for (const [from, to] of ranges) expect(to - from + 1).toBeLessThanOrEqual(2_000);
    expect(ranges[0][0]).toBeLessThanOrEqual(blockAt("2026-05-16T10:20:00.000Z"));
    expect(ranges.at(-1)![1]).toBeGreaterThanOrEqual(blockAt("2026-05-16T12:40:00.000Z"));
  });

  it("recovers a claimed-but-unsettled quote from its claim without scanning", async () => {
    const memory = seed(
      managedVeniceQuoteRow({
        transaction_hash: "0xclaimed",
        metadata: {
          ...(managedVeniceQuoteRow().metadata as MemoryRow),
          settlementClaim: {
            transactionHash: "0xclaimed",
            logIndex: 2,
            tokenAmountRaw: QUOTED.toString(),
            observedAt: "2026-05-16T10:21:00.000Z",
            blockTimestamp: "2026-05-16T10:21:00.000Z",
            paidValueMicroUsd: 50_000_000,
            creditValueMicroUsd: 60_000_000,
            bonusValueMicroUsd: 10_000_000,
            claimedAt: "2026-05-16T10:21:30.000Z",
          },
        },
      })
    );
    const rpc = chain();

    const result = await reconcileAt(memory, rpc, "2026-05-16T10:25:00.000Z");

    expect(result.status).toBe("settled");
    expect(rpc.methodCount("eth_getLogs")).toBe(0);
    expect(quote(memory)).toMatchObject({ status: "settled", transaction_hash: "0xclaimed" });
    expect(memory.tables.managed_venice_token_lots).toEqual([
      expect.objectContaining({ transaction_hash: "0xclaimed", original_value_micro_usd: 60_000_000 }),
    ]);
  });

  it("includes the JSON-RPC error message in RpcHttpError and does not retry a 413", async () => {
    const memory = seed();
    const rpc = chain();
    rpc.failNext({
      method: "eth_getLogs",
      status: 413,
      body: { jsonrpc: "2.0", id: 1, error: { code: -32614, message: "eth_getLogs is limited to a 2,000 range" } },
    });

    const failure = await reconcileAt(memory, rpc, "2026-05-16T10:25:00.000Z").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RpcHttpError);
    expect((failure as RpcHttpError).status).toBe(413);
    expect((failure as Error).message).toBe(
      "Base RPC request failed with status 413: eth_getLogs is limited to a 2,000 range"
    );
    expect(rpc.methodCount("eth_getLogs")).toBe(1);
  });
});
