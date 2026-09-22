import {
  MANAGED_VENICE_TOKEN_DEPOSIT_REASONS,
  settleManagedVeniceTokenQuote,
} from "@/lib/billing/managed-venice-token-quotes";
import {
  reconcileManagedVeniceTokenQuote,
  reconcilePendingManagedVeniceTokenQuotes,
} from "@/lib/billing/managed-venice-token-reconciliation";
import {
  createBaseRpcFake,
  createManagedVeniceMemoryDb,
  managedVeniceQuoteRow,
  TEST_DEPOSIT_ADDRESS,
  type FakeTransfer,
  type MemoryRow,
} from "@/test-utils/managed-venice-memory-db";

// I6 for quotes that are already settled or in review: a transfer that
// confirms or arrives after the quote became terminal, or whose item insert
// failed right after the flip, is still surfaced exactly once. The flip sets
// transfer_surfacing_pending in the same compare-and-set; the cron's
// surface-only pass rescans the quote's own range until it is fully confirmed.
//
// Quote_1: quoted 10:20, expires 10:40, grace end 12:40. 2 s blocks, 3
// confirmations.

const ANCHOR_BLOCK = 5_000_000;
const ANCHOR_TIME = "2026-05-16T10:35:00.000Z";
const QUOTED = 1000n * 10n ** 18n;
const UNDER = (QUOTED * 9n) / 10n;
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

async function tickAt(memory: Memory, rpc: Chain, iso: string) {
  rpc.setLatestBlock(blockAt(iso));
  return reconcilePendingManagedVeniceTokenQuotes({
    db: memory.db,
    rpcUrl: "https://base.test",
    fetchImpl: rpc.fetchImpl,
    minConfirmations: 3,
    now: new Date(iso),
    interQuoteDelayMs: 0,
    rpcSleepImpl: async () => {},
  });
}

async function checkAt(memory: Memory, rpc: Chain, iso: string) {
  rpc.setLatestBlock(blockAt(iso));
  return reconcileManagedVeniceTokenQuote({
    quoteId: "quote_1",
    userId: "user_1",
    db: memory.db,
    rpcUrl: "https://base.test",
    fetchImpl: rpc.fetchImpl,
    minConfirmations: 3,
    now: new Date(iso),
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

function transferKey(txHash: string) {
  return `managed_venice_token_transfer:${txHash}`;
}

// Open items per transfer dedupe key; I6 wants exactly one per transfer.
function openItems(memory: Memory) {
  return memory.tables.managed_venice_reconciliation_items
    .filter((row) => row.status === "open")
    .map((row) => ({ key: row.dedupe_key, reason: row.reason }));
}

describe("managed Venice terminal quotes: durable transfer surfacing", () => {
  it("J3: a double-send still under-confirmed at settlement is surfaced once it confirms", async () => {
    const memory = seed();
    const rpc = chain([
      transfer("0xpaid", QUOTED, "2026-05-16T10:21:00.000Z"),
      // 2 of 3 confirmations at the settling tick.
      transfer("0xdouble", QUOTED, "2026-05-16T10:24:58.000Z"),
    ]);

    const settling = await tickAt(memory, rpc, "2026-05-16T10:25:00.000Z");
    expect(settling.settled).toBe(1);
    expect(quote(memory)).toMatchObject({ status: "settled", transaction_hash: "0xpaid", transfer_surfacing_pending: true });
    expect(openItems(memory)).toEqual([]);

    await tickAt(memory, rpc, "2026-05-16T10:30:00.000Z");
    await tickAt(memory, rpc, "2026-05-16T13:30:00.000Z");
    await checkAt(memory, rpc, "2026-05-16T13:31:00.000Z");

    expect(openItems(memory)).toEqual([
      { key: transferKey("0xdouble"), reason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.extraTransfer },
    ]);
    expect(quote(memory)).toMatchObject({ status: "settled", transaction_hash: "0xpaid", transfer_surfacing_pending: false });
    expect(memory.tables.managed_venice_token_lots).toHaveLength(1);
  });

  it("J4: a second in-window send after settlement is surfaced once across ticks and checks", async () => {
    const memory = seed();
    const rpc = chain([transfer("0xpaid", QUOTED, "2026-05-16T10:21:00.000Z")]);

    await tickAt(memory, rpc, "2026-05-16T10:22:00.000Z");
    rpc.addTransfer(transfer("0xagain", QUOTED, "2026-05-16T10:24:00.000Z"));
    await tickAt(memory, rpc, "2026-05-16T10:30:00.000Z");
    // The user's own check of the settled quote runs the same surface-only pass.
    const check = await checkAt(memory, rpc, "2026-05-16T10:31:00.000Z");
    await tickAt(memory, rpc, "2026-05-16T10:35:00.000Z");
    await tickAt(memory, rpc, "2026-05-16T13:30:00.000Z");

    expect(check.status).toBe("settled");
    expect(openItems(memory)).toEqual([
      { key: transferKey("0xagain"), reason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.extraTransfer },
    ]);
    expect(quote(memory)).toMatchObject({ status: "settled", transaction_hash: "0xpaid", transfer_surfacing_pending: false });
    expect(memory.tables.managed_venice_token_lots).toEqual([
      expect.objectContaining({ transaction_hash: "0xpaid" }),
    ]);
  });

  it("J5a: a correct send after a fat-finger review is surfaced once, never credited", async () => {
    const memory = seed();
    const rpc = chain([transfer("0xfat", FAT, "2026-05-16T10:21:00.000Z")]);

    await tickAt(memory, rpc, "2026-05-16T10:22:00.000Z");
    expect(quote(memory)).toMatchObject({ status: "manual_review_required", transfer_surfacing_pending: true });
    rpc.addTransfer(transfer("0xcorrect", QUOTED, "2026-05-16T10:25:00.000Z"));
    await tickAt(memory, rpc, "2026-05-16T10:30:00.000Z");
    await tickAt(memory, rpc, "2026-05-16T10:35:00.000Z");
    await tickAt(memory, rpc, "2026-05-16T13:30:00.000Z");

    expect(openItems(memory)).toEqual([
      { key: transferKey("0xfat"), reason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.amountMismatch },
      // In window and in band, but the quote is closed: an extra transfer.
      { key: transferKey("0xcorrect"), reason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.extraTransfer },
    ]);
    expect(quote(memory)).toMatchObject({
      status: "manual_review_required",
      transaction_hash: null,
      transfer_surfacing_pending: false,
    });
    expect(memory.tables.managed_venice_token_lots).toHaveLength(0);
  });

  it("J5b: a full top-up inside the grace after an under-payment review is surfaced once", async () => {
    const memory = seed();
    const rpc = chain([transfer("0xunder", UNDER, "2026-05-16T10:21:00.000Z")]);

    await tickAt(memory, rpc, "2026-05-16T10:41:00.000Z");
    expect(quote(memory).status).toBe("manual_review_required");
    rpc.addTransfer(transfer("0xtopup", QUOTED, "2026-05-16T10:50:00.000Z"));
    await tickAt(memory, rpc, "2026-05-16T11:00:00.000Z");
    await tickAt(memory, rpc, "2026-05-16T13:30:00.000Z");

    expect(openItems(memory)).toEqual([
      { key: transferKey("0xunder"), reason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.underpaid },
      { key: transferKey("0xtopup"), reason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.outsideQuoteWindow },
    ]);
    expect(quote(memory)).toMatchObject({ status: "manual_review_required", transfer_surfacing_pending: false });
    expect(memory.tables.managed_venice_token_lots).toHaveLength(0);
  });

  it("J6: a crash between claim and flip still surfaces the extra transfer after recovery settles", async () => {
    const memory = seed();
    const rpc = chain([
      transfer("0xpaid", QUOTED, "2026-05-16T10:21:00.000Z"),
      transfer("0xextra", QUOTED, "2026-05-16T10:22:00.000Z"),
    ]);
    // Crash after the claim and lot, before the deposit event and the flip.
    memory.failNext({ table: "managed_venice_financial_events", op: "insert" });

    const crashed = await tickAt(memory, rpc, "2026-05-16T10:26:00.000Z");
    expect(crashed.failed).toBe(1);
    expect(quote(memory)).toMatchObject({ status: "active", transaction_hash: "0xpaid" });

    await tickAt(memory, rpc, "2026-05-16T10:30:00.000Z");
    await tickAt(memory, rpc, "2026-05-16T10:35:00.000Z");
    await tickAt(memory, rpc, "2026-05-16T13:30:00.000Z");

    expect(quote(memory)).toMatchObject({ status: "settled", transaction_hash: "0xpaid", transfer_surfacing_pending: false });
    expect(openItems(memory)).toEqual([
      { key: transferKey("0xextra"), reason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.extraTransfer },
    ]);
    expect(memory.tables.managed_venice_token_lots).toHaveLength(1);
  });

  it("surfaces a post-settle transfer against its own quote, never the next quote on the address", async () => {
    const memory = seed(
      managedVeniceQuoteRow(),
      managedVeniceQuoteRow({
        id: "quote_2",
        quoted_at: "2026-05-16T11:00:00.000Z",
        expires_at: "2026-05-16T11:20:00.000Z",
        created_at: "2026-05-16T11:00:00.000Z",
      })
    );
    const rpc = chain([transfer("0xpaid", QUOTED, "2026-05-16T10:21:00.000Z")]);

    await tickAt(memory, rpc, "2026-05-16T10:22:00.000Z");
    rpc.addTransfer(transfer("0xagain", QUOTED, "2026-05-16T10:24:00.000Z"));
    await tickAt(memory, rpc, "2026-05-16T14:00:00.000Z");
    await tickAt(memory, rpc, "2026-05-16T14:05:00.000Z");

    expect(openItems(memory)).toEqual([
      { key: transferKey("0xagain"), reason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.extraTransfer },
    ]);
    expect(memory.tables.managed_venice_reconciliation_items[0].metadata).toMatchObject({ quoteId: "quote_1" });
    expect(quote(memory)).toMatchObject({ status: "settled", transfer_surfacing_pending: false });
    expect(quote(memory, "quote_2")).toMatchObject({ status: "cancelled", transaction_hash: null });
  });
});

describe("managed Venice terminal quotes: surfacing after a failed item insert", () => {
  it("J1: an extra transfer whose item insert fails right after the flip is surfaced exactly once", async () => {
    const memory = seed();
    const rpc = chain([
      transfer("0xpaid", QUOTED, "2026-05-16T10:21:00.000Z"),
      transfer("0xextra", QUOTED, "2026-05-16T10:22:00.000Z"),
    ]);
    memory.failNext({ table: "managed_venice_reconciliation_items", op: "insert" });

    const first = await tickAt(memory, rpc, "2026-05-16T10:26:00.000Z");
    expect(first.failed).toBe(1);
    expect(quote(memory)).toMatchObject({ status: "settled", transaction_hash: "0xpaid", transfer_surfacing_pending: true });

    await checkAt(memory, rpc, "2026-05-16T10:27:00.000Z");
    await tickAt(memory, rpc, "2026-05-16T10:30:00.000Z");
    await tickAt(memory, rpc, "2026-05-16T13:30:00.000Z");

    expect(openItems(memory)).toEqual([
      { key: transferKey("0xextra"), reason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.extraTransfer },
    ]);
    expect(quote(memory)).toMatchObject({ status: "settled", transaction_hash: "0xpaid", transfer_surfacing_pending: false });
    expect(memory.tables.managed_venice_token_lots).toHaveLength(1);
  });

  it("J2: the review flips first; an item insert that fails after the flip is finished by the surface-only pass", async () => {
    const memory = seed();
    const rpc = chain([
      transfer("0xunder", UNDER, "2026-05-16T10:21:00.000Z"),
      transfer("0xfat", FAT, "2026-05-16T10:22:00.000Z"),
    ]);
    memory.failNext({
      table: "managed_venice_reconciliation_items",
      op: "insert",
      match: (row) => String(row.dedupe_key).includes("0xunder"),
    });

    const first = await tickAt(memory, rpc, "2026-05-16T10:26:00.000Z");
    // 0xfat reviews the quote (flip, then its item); 0xunder's insert fails
    // after the flip, so that reconcile fails, and the same tick's
    // surface-only pass writes the missing item.
    expect(first).toMatchObject({
      manualReview: 0,
      failed: 1,
      transferSurfacing: { checked: 1, complete: 0, pending: 1, failed: 0 },
    });
    expect(quote(memory)).toMatchObject({
      status: "manual_review_required",
      transaction_hash: null,
      transfer_surfacing_pending: true,
    });
    expect(openItems(memory)).toEqual([
      { key: transferKey("0xfat"), reason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.amountMismatch },
      { key: transferKey("0xunder"), reason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.underpaid },
    ]);

    await tickAt(memory, rpc, "2026-05-16T10:30:00.000Z");
    await tickAt(memory, rpc, "2026-05-16T13:30:00.000Z");

    expect(quote(memory)).toMatchObject({
      status: "manual_review_required",
      transaction_hash: null,
      transfer_surfacing_pending: false,
    });
    expect(openItems(memory)).toHaveLength(2);
    expect(memory.tables.managed_venice_token_lots).toHaveLength(0);
  });
});

describe("managed Venice terminal quotes: surfacing flag lifecycle", () => {
  it("keeps the flag until the whole grace is confirmed, then never scans the quote again", async () => {
    const memory = seed();
    const rpc = chain([transfer("0xpaid", QUOTED, "2026-05-16T10:21:00.000Z")]);

    await tickAt(memory, rpc, "2026-05-16T10:22:00.000Z");
    // Head just past the grace end (12:40), confirmed head 2 s short of it.
    const almost = await tickAt(memory, rpc, "2026-05-16T12:40:02.000Z");
    expect(almost.transferSurfacing).toEqual({ checked: 1, complete: 0, pending: 1, failed: 0 });
    expect(quote(memory).transfer_surfacing_pending).toBe(true);

    const covered = await tickAt(memory, rpc, "2026-05-16T12:40:04.000Z");
    expect(covered.transferSurfacing).toEqual({ checked: 1, complete: 1, pending: 0, failed: 0 });
    expect(quote(memory).transfer_surfacing_pending).toBe(false);

    const scans = rpc.methodCount("eth_getLogs");
    const later = await tickAt(memory, rpc, "2026-05-16T13:30:00.000Z");
    const check = await checkAt(memory, rpc, "2026-05-16T13:31:00.000Z");
    expect(later.transferSurfacing).toEqual({ checked: 0, complete: 0, pending: 0, failed: 0 });
    expect(check.status).toBe("settled");
    expect(rpc.methodCount("eth_getLogs")).toBe(scans);
    expect(quote(memory)).toMatchObject({ status: "settled", transaction_hash: "0xpaid" });
    expect(openItems(memory)).toEqual([]);
  });

  it("never rescans legacy settled or in-review quotes that predate the flag", async () => {
    const memory = seed(
      managedVeniceQuoteRow({
        status: "settled",
        transaction_hash: "0xlegacy_paid",
        settled_at: "2026-05-16T10:22:00.000Z",
      }),
      managedVeniceQuoteRow({
        id: "quote_review",
        status: "manual_review_required",
        metadata: {
          ...(managedVeniceQuoteRow().metadata as MemoryRow),
          manualReviewReason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.underpaid,
          reviewTransactionHash: "0xlegacy_under",
        },
      })
    );
    const rpc = chain([
      transfer("0xlegacy_paid", QUOTED, "2026-05-16T10:21:00.000Z"),
      transfer("0xlegacy_under", UNDER, "2026-05-16T10:21:30.000Z"),
      transfer("0xstray", QUOTED, "2026-05-16T10:25:00.000Z"),
    ]);

    const tick = await tickAt(memory, rpc, "2026-05-16T10:30:00.000Z");
    const check = await checkAt(memory, rpc, "2026-05-16T10:31:00.000Z");
    await tickAt(memory, rpc, "2026-05-16T13:30:00.000Z");

    expect(tick.transferSurfacing.checked).toBe(0);
    expect(check.status).toBe("settled");
    expect(rpc.methodCount("eth_getLogs")).toBe(0);
    expect(memory.tables.managed_venice_reconciliation_items).toEqual([]);
    expect(quote(memory)).toMatchObject({ status: "settled", transaction_hash: "0xlegacy_paid" });
    expect(quote(memory, "quote_review")).toMatchObject({ status: "manual_review_required" });
  });

  it("does not count terminal quotes as manual reviews and reports a failed surface-only pass", async () => {
    const memory = seed();
    const rpc = chain([transfer("0xfat", FAT, "2026-05-16T10:21:00.000Z")]);

    const reviewing = await tickAt(memory, rpc, "2026-05-16T10:22:00.000Z");
    expect(reviewing.manualReview).toBe(1);

    rpc.addTransfer(transfer("0xcorrect", QUOTED, "2026-05-16T10:25:00.000Z"));
    rpc.failNext({ method: "eth_getLogs", status: 413, body: { error: { message: "eth_getLogs is limited to a 2,000 range" } } });
    const failing = await tickAt(memory, rpc, "2026-05-16T10:30:00.000Z");
    expect(failing).toMatchObject({
      checked: 0,
      manualReview: 0,
      failed: 1,
      transferSurfacing: { checked: 1, complete: 0, pending: 0, failed: 1 },
    });
    expect(failing.results).toEqual([
      expect.objectContaining({
        quoteId: "quote_1",
        status: "failed",
        errorMessage: expect.stringContaining("eth_getLogs is limited to a 2,000 range"),
      }),
    ]);
    expect(quote(memory).transfer_surfacing_pending).toBe(true);

    const retry = await tickAt(memory, rpc, "2026-05-16T10:35:00.000Z");
    expect(retry).toMatchObject({ manualReview: 0, failed: 0, transferSurfacing: { checked: 1, pending: 1 } });
    expect(openItems(memory).map((item) => item.key)).toEqual([transferKey("0xfat"), transferKey("0xcorrect")]);
    expect(quote(memory)).toMatchObject({ status: "manual_review_required", transaction_hash: null });
  });
});

describe("managed Venice settlement: surfacing relative to what actually happened", () => {
  it("a competing claim that wins mid-reconcile: reports its tx and never surfaces the credited tx as an extra", async () => {
    const memory = seed();
    const rpc = chain([
      transfer("0xfirst", QUOTED, "2026-05-16T10:21:00.000Z"),
      transfer("0xsecond", QUOTED, "2026-05-16T10:22:00.000Z"),
    ]);
    // Between this reconcile's scan and its settle, a bearer delivery of
    // 0xsecond claims the quote and dies before writing its lot.
    let raced = false;
    const settleQuote: typeof settleManagedVeniceTokenQuote = async (params, db) => {
      if (!raced) {
        raced = true;
        memory.failNext({ table: "managed_venice_token_lots", op: "insert" });
        await settleManagedVeniceTokenQuote(
          {
            quoteId: "quote_1",
            transactionHash: "0xsecond",
            tokenAmountRaw: QUOTED.toString(),
            observedAt: "2026-05-16T10:22:00.000Z",
          },
          db
        ).catch(() => undefined);
      }
      return settleManagedVeniceTokenQuote(params, db);
    };

    rpc.setLatestBlock(blockAt("2026-05-16T10:26:00.000Z"));
    const result = await reconcileManagedVeniceTokenQuote({
      quoteId: "quote_1",
      userId: "user_1",
      db: memory.db,
      rpcUrl: "https://base.test",
      fetchImpl: rpc.fetchImpl,
      minConfirmations: 3,
      now: new Date("2026-05-16T10:26:00.000Z"),
      settleQuote,
    });

    // The settle converged on the claimed 0xsecond; 0xfirst is the extra.
    expect(result).toMatchObject({
      status: "settled",
      transactionHash: "0xsecond",
      quote: expect.objectContaining({ status: "settled", transactionHash: "0xsecond" }),
    });
    expect(quote(memory)).toMatchObject({ status: "settled", transaction_hash: "0xsecond" });
    expect(memory.tables.managed_venice_token_lots).toEqual([
      expect.objectContaining({ transaction_hash: "0xsecond" }),
    ]);
    expect(openItems(memory)).toEqual([
      { key: transferKey("0xfirst"), reason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.extraTransfer },
    ]);
  });

  it("the bearer route and the reconciler key the same transfer identically: one item", async () => {
    const memory = seed();
    const rpc = chain([
      transfer("0xpaid", QUOTED, "2026-05-16T10:21:00.000Z"),
      transfer("0xagain", QUOTED, "2026-05-16T10:22:00.000Z", { logIndex: 7 }),
    ]);

    // The reconciler settles with 0xpaid and surfaces 0xagain (log index 7).
    await tickAt(memory, rpc, "2026-05-16T10:26:00.000Z");
    expect(openItems(memory)).toEqual([
      { key: transferKey("0xagain"), reason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.extraTransfer },
    ]);

    // The bearer route redelivers the same transfer without a log index.
    const bearer = await settleManagedVeniceTokenQuote(
      {
        quoteId: "quote_1",
        transactionHash: "0xAGAIN",
        tokenAmountRaw: QUOTED.toString(),
        observedAt: "2026-05-16T10:22:00.000Z",
      },
      memory.db
    );
    await tickAt(memory, rpc, "2026-05-16T13:30:00.000Z");

    expect(bearer).toEqual({ status: "manual_review_required" });
    expect(openItems(memory)).toEqual([
      { key: transferKey("0xagain"), reason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.extraTransfer },
    ]);
  });
});
