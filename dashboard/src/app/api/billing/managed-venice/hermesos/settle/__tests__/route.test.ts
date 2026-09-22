import {
  createBaseRpcFake,
  createManagedVeniceMemoryDb,
  managedVeniceQuoteRow,
  TEST_DEPOSIT_ADDRESS,
  type BaseRpcFake,
  type FakeTransfer,
  type ManagedVeniceMemoryDb,
  type MemoryRow,
} from "@/test-utils/managed-venice-memory-db";
import { makeJsonRequest } from "@/test-utils/request";

// The bearer settle route runs the REAL claim-first settlement against an
// in-memory DB that enforces the production unique indexes, and resolves each
// delivery to its on-chain Transfer log through a Base RPC fake (the route's
// fetch). The cron ticks run the REAL reconciler against the same fake chain.

let mockMemory: ManagedVeniceMemoryDb;

jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockMemory.db;
  },
}));

jest.mock("@/lib/logger", () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { MANAGED_VENICE_TOKEN_DEPOSIT_REASONS } from "@/lib/billing/managed-venice-token-quotes";
import { reconcilePendingManagedVeniceTokenQuotes } from "@/lib/billing/managed-venice-token-reconciliation";
import { POST } from "../route";

const SECRET = "settlement-secret";
const QUOTED = 1000n * 10n ** 18n;
const IN_WINDOW = "2026-05-16T10:21:00.000Z";
// quote_1: quoted 10:20, expires 10:40, grace end 12:40. 2 s blocks.
const ANCHOR_BLOCK = 5_000_000;
const ANCHOR_TIME = "2026-05-16T10:35:00.000Z";
const originalFetch = global.fetch;
let rpc: BaseRpcFake;

function blockAt(iso: string) {
  return ANCHOR_BLOCK + Math.floor((Date.parse(iso) - Date.parse(ANCHOR_TIME)) / 2000);
}

function transfer(txHash: string, amount: bigint, iso: string, extra: Partial<FakeTransfer> = {}): FakeTransfer {
  return { txHash, amountRaw: amount, block: blockAt(iso), to: TEST_DEPOSIT_ADDRESS, ...extra };
}

function settle(body: unknown, authorization: string | null = `Bearer ${SECRET}`) {
  return POST(
    makeJsonRequest("/api/billing/managed-venice/hermesos/settle", body, {
      headers: authorization ? { authorization } : {},
    })
  );
}

// A bearer delivery as the bankr reconciler posts it: tx, amount, time. No
// log index: the route resolves the log from the tx receipt.
function deliver(txHash: string, amount: bigint, minedAt: string, quoteId = "quote_1") {
  return settle({ quoteId, transactionHash: txHash, tokenAmountRaw: amount.toString(), observedAt: minedAt, blockTimestamp: minedAt });
}

async function data(response: Response) {
  return ((await response.json()) as { data?: Record<string, unknown> }).data;
}

async function tickAt(iso: string) {
  rpc.setLatestBlock(blockAt(iso));
  const summary = await reconcilePendingManagedVeniceTokenQuotes({
    db: mockMemory.db,
    rpcUrl: "https://base.test",
    fetchImpl: rpc.fetchImpl,
    minConfirmations: 3,
    now: new Date(iso),
    interQuoteDelayMs: 0,
    rpcSleepImpl: async () => {},
  });
  expect(summary.failed).toBe(0);
  return summary;
}

function quote(id = "quote_1") {
  return mockMemory.tables.managed_venice_token_quotes.find((row) => row.id === id)!;
}

function transferKey(txHash: string, logIndex?: number) {
  return `managed_venice_token_transfer:${txHash}:${TEST_DEPOSIT_ADDRESS}${logIndex === undefined ? "" : `:${logIndex}`}`;
}

// Every item, with the log and amount it records: I6 wants exactly one per
// transfer (log), carrying that log's own amount and index.
function items() {
  return mockMemory.tables.managed_venice_reconciliation_items.map((row) => ({
    key: row.dedupe_key,
    reason: row.reason,
    status: row.status,
    logIndex: (row.metadata as MemoryRow).logIndex,
    amount: (row.metadata as MemoryRow).observedTokenAmountRaw,
  }));
}

function item(txHash: string, logIndex: number, amount: bigint, reason: string, keyLogIndex: number | undefined) {
  return { key: transferKey(txHash, keyLogIndex), reason, status: "open", logIndex, amount: amount.toString() };
}

describe("POST /api/billing/managed-venice/hermesos/settle", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, MANAGED_VENICE_SETTLEMENT_SECRET: SECRET };
    mockMemory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [managedVeniceQuoteRow()],
    });
    rpc = createBaseRpcFake({ latestBlock: blockAt("2026-05-16T11:00:00.000Z"), latestTimestamp: "2026-05-16T11:00:00.000Z" });
    global.fetch = rpc.fetchImpl as unknown as typeof fetch;
  });

  afterAll(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it("refuses to run without a settlement secret and never falls back to CRON_SECRET", async () => {
    process.env = { ...originalEnv, MANAGED_VENICE_SETTLEMENT_SECRET: "", BILLING_SETTLEMENT_SECRET: "", CRON_SECRET: SECRET };

    const response = await settle({ quoteId: "quote_1", transactionHash: "0xpaid", tokenAmountRaw: QUOTED.toString(), observedAt: IN_WINDOW });

    expect(response.status).toBe(500);
    expect(mockMemory.tables.managed_venice_token_lots).toHaveLength(0);
    expect(rpc.fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a missing or wrong bearer", async () => {
    const missing = await settle({ quoteId: "quote_1" }, null);
    const wrong = await settle({ quoteId: "quote_1" }, "Bearer nope");

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
  });

  it("rejects an invalid settlement body", async () => {
    const response = await settle({ quoteId: "quote_1", transactionHash: "0xpaid", tokenAmountRaw: "-1", observedAt: IN_WINDOW });

    expect(response.status).toBe(400);
  });

  it("settles an in-window transfer on its own log and is idempotent on redelivery", async () => {
    rpc.addTransfer(transfer("0xpaid", QUOTED, IN_WINDOW, { logIndex: 4 }));

    const first = await deliver("0xpaid", QUOTED, IN_WINDOW);
    const replay = await deliver("0xpaid", QUOTED, IN_WINDOW);

    expect(first.status).toBe(200);
    expect(await data(first)).toEqual({ status: "settled", quoteId: "quote_1" });
    expect(await data(replay)).toEqual({ status: "settled", quoteId: "quote_1", idempotent: true });
    expect(quote().metadata).toMatchObject({ settlementClaim: expect.objectContaining({ logIndex: 4 }) });
    expect(mockMemory.tables.managed_venice_token_lots).toEqual([
      expect.objectContaining({ transaction_hash: "0xpaid", metadata: expect.objectContaining({ logIndex: 4 }) }),
    ]);
    expect(
      mockMemory.tables.managed_venice_financial_events.filter((event) => event.event_type === "token_deposit")
    ).toHaveLength(1);
  });

  it("returns transaction_already_claimed (not a 500) when the tx belongs to another quote", async () => {
    mockMemory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [
        managedVeniceQuoteRow({ id: "quote_other", status: "settled", transaction_hash: "0xpaid" }),
        managedVeniceQuoteRow(),
      ],
    });
    rpc.addTransfer(transfer("0xpaid", QUOTED, IN_WINDOW));

    const response = await deliver("0xpaid", QUOTED, IN_WINDOW);

    expect(response.status).toBe(200);
    expect(await data(response)).toEqual({ status: "transaction_already_claimed", quoteId: "quote_1" });
    expect(mockMemory.tables.managed_venice_token_lots).toHaveLength(0);
  });

  it("never re-reviews or settles a quote already in manual review; surfaces the new transfer once", async () => {
    mockMemory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [managedVeniceQuoteRow({ status: "manual_review_required" })],
    });
    rpc.addTransfer(transfer("0xlate", QUOTED, "2026-05-16T11:00:00.000Z"));

    for (let delivery = 0; delivery < 2; delivery += 1) {
      const response = await deliver("0xlate", QUOTED, "2026-05-16T11:00:00.000Z");
      expect(await data(response)).toEqual({ status: "manual_review_required" });
    }

    expect(quote()).toMatchObject({ status: "manual_review_required", transaction_hash: null });
    expect(mockMemory.tables.managed_venice_reconciliation_items).toHaveLength(1);
  });

  it("returns a safe 500 when the quote does not exist", async () => {
    const response = await deliver("0xpaid", QUOTED, IN_WINDOW, "missing");

    expect(response.status).toBe(500);
    expect(((await response.json()) as { error?: string }).error).toBe("Failed to settle managed Venice token quote.");
  });
});

describe("POST /api/billing/managed-venice/hermesos/settle: one tx paying the deposit address twice", () => {
  const PAID_AT = "2026-05-16T10:22:00.000Z";
  const FIVE = 5n * 10n ** 18n;
  const SEVEN = 7n * 10n ** 18n;
  const NINE = 9n * 10n ** 18n;
  const FAT = QUOTED * 3n;
  const { underpaid, amountMismatch, replayedAfterSettlement } = MANAGED_VENICE_TOKEN_DEPOSIT_REASONS;

  beforeEach(() => {
    process.env = { ...process.env, MANAGED_VENICE_SETTLEMENT_SECRET: SECRET };
    mockMemory = createManagedVeniceMemoryDb({ managed_venice_token_quotes: [managedVeniceQuoteRow()] });
    rpc = createBaseRpcFake({ latestBlock: ANCHOR_BLOCK, latestTimestamp: ANCHOR_TIME });
    global.fetch = rpc.fetchImpl as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("A1: the cron credits log 0; a bearer delivery of log 1 is that log's one item, never a bare-key copy", async () => {
    rpc.addTransfer(transfer("0xmulti", QUOTED, PAID_AT, { logIndex: 0 }));
    rpc.addTransfer(transfer("0xmulti", FIVE, PAID_AT, { logIndex: 1 }));

    await tickAt("2026-05-16T10:25:00.000Z");
    expect(quote()).toMatchObject({ status: "settled", transaction_hash: "0xmulti", transfer_surfacing_pending: true });

    expect(await data(await deliver("0xmulti", FIVE, PAID_AT))).toEqual({ status: "manual_review_required" });
    await tickAt("2026-05-16T10:30:00.000Z");
    expect(quote().transfer_surfacing_pending).toBe(true);
    await tickAt("2026-05-16T13:30:00.000Z");

    expect(items()).toEqual([item("0xmulti", 1, FIVE, underpaid, 1)]);
    expect(quote()).toMatchObject({ status: "settled", transfer_surfacing_pending: false });
    expect(mockMemory.tables.managed_venice_token_lots).toEqual([
      expect.objectContaining({ token_amount_raw: QUOTED.toString(), metadata: expect.objectContaining({ logIndex: 0 }) }),
    ]);
  });

  it("A2: bearer deliveries of both logs credit log 0 and give log 1 its one item", async () => {
    rpc.addTransfer(transfer("0xmulti", QUOTED, PAID_AT, { logIndex: 0 }));
    rpc.addTransfer(transfer("0xmulti", FIVE, PAID_AT, { logIndex: 1 }));

    expect(await data(await deliver("0xmulti", QUOTED, PAID_AT))).toEqual({ status: "settled", quoteId: "quote_1" });
    expect(await data(await deliver("0xmulti", FIVE, PAID_AT))).toEqual({ status: "manual_review_required" });
    expect(quote().transfer_surfacing_pending).toBe(true);
    for (const iso of ["2026-05-16T10:30:00.000Z", "2026-05-16T13:30:00.000Z"]) await tickAt(iso);

    expect(items()).toEqual([item("0xmulti", 1, FIVE, replayedAfterSettlement, 1)]);
    expect(quote()).toMatchObject({
      status: "settled",
      transfer_surfacing_pending: false,
      metadata: expect.objectContaining({ settlementClaim: expect.objectContaining({ logIndex: 0 }) }),
    });
    expect(mockMemory.tables.managed_venice_token_lots).toHaveLength(1);
  });

  it("an in-band later log is its own transfer, never an idempotent redelivery of the credited log", async () => {
    const MORE = (QUOTED * 3n) / 2n;
    rpc.addTransfer(transfer("0xmulti", QUOTED, PAID_AT, { logIndex: 0 }));
    rpc.addTransfer(transfer("0xmulti", MORE, PAID_AT, { logIndex: 1 }));

    expect(await data(await deliver("0xmulti", QUOTED, PAID_AT))).toEqual({ status: "settled", quoteId: "quote_1" });
    expect(await data(await deliver("0xmulti", MORE, PAID_AT))).toEqual({ status: "manual_review_required" });
    expect(await data(await deliver("0xmulti", QUOTED, PAID_AT))).toEqual({ status: "settled", quoteId: "quote_1", idempotent: true });
    for (const iso of ["2026-05-16T10:30:00.000Z", "2026-05-16T13:30:00.000Z"]) await tickAt(iso);

    expect(items()).toEqual([item("0xmulti", 1, MORE, replayedAfterSettlement, 1)]);
    expect(mockMemory.tables.managed_venice_token_lots).toHaveLength(1);
  });

  it("B: after settlement, a bearer delivery of a multi-log tx's later log never takes its first log's key", async () => {
    rpc.addTransfer(transfer("0xpaid", QUOTED, IN_WINDOW));
    await tickAt("2026-05-16T10:23:00.000Z");
    expect(quote()).toMatchObject({ status: "settled", transaction_hash: "0xpaid" });
    rpc.addTransfer(transfer("0xmulti", SEVEN, "2026-05-16T10:30:00.000Z", { logIndex: 0 }));
    rpc.addTransfer(transfer("0xmulti", NINE, "2026-05-16T10:30:00.000Z", { logIndex: 1 }));
    rpc.setLatestBlock(blockAt("2026-05-16T10:31:00.000Z"));

    expect(await data(await deliver("0xmulti", NINE, "2026-05-16T10:30:00.000Z"))).toEqual({ status: "manual_review_required" });
    expect(items()).toEqual([item("0xmulti", 1, NINE, replayedAfterSettlement, 1)]);
    expect(quote().transfer_surfacing_pending).toBe(true);

    for (const iso of ["2026-05-16T10:35:00.000Z", "2026-05-16T13:30:00.000Z"]) await tickAt(iso);

    expect(items()).toEqual([
      item("0xmulti", 1, NINE, replayedAfterSettlement, 1),
      item("0xmulti", 0, SEVEN, underpaid, undefined),
    ]);
    expect(quote()).toMatchObject({ status: "settled", transaction_hash: "0xpaid", transfer_surfacing_pending: false });
  });

  it.each([
    ["C: log 0 = 7 tokens, log 1 = 3x the quote", { small: SEVEN, smallLog: 0, over: FAT, overLog: 1 }],
    ["S1: log 3 = 5 tokens, log 7 = 3000 tokens", { small: FIVE, smallLog: 3, over: 3000n * 10n ** 18n, overLog: 7 }],
  ])("%s: a bearer review with the over-ceiling later log keys and binds that log; the first log still gets its item", async (_label, setup) => {
    rpc.addTransfer(transfer("0xmulti", setup.small, PAID_AT, { logIndex: setup.smallLog }));
    rpc.addTransfer(transfer("0xmulti", setup.over, PAID_AT, { logIndex: setup.overLog }));
    rpc.setLatestBlock(blockAt("2026-05-16T10:23:00.000Z"));

    expect(await data(await deliver("0xmulti", setup.over, PAID_AT))).toEqual({ status: "manual_review_required" });
    expect(quote()).toMatchObject({
      status: "manual_review_required",
      transaction_hash: null,
      transfer_surfacing_pending: true,
      metadata: expect.objectContaining({
        manualReviewReason: amountMismatch,
        reviewTransactionHash: "0xmulti",
        reviewLogIndex: setup.overLog,
        reviewDedupeLogIndex: setup.overLog,
        observedTokenAmountRaw: setup.over.toString(),
      }),
    });
    expect(items()).toEqual([item("0xmulti", setup.overLog, setup.over, amountMismatch, setup.overLog)]);

    await tickAt("2026-05-16T10:30:00.000Z");
    expect(quote().transfer_surfacing_pending).toBe(true);
    await tickAt("2026-05-16T13:30:00.000Z");

    expect(items()).toEqual([
      item("0xmulti", setup.overLog, setup.over, amountMismatch, setup.overLog),
      item("0xmulti", setup.smallLog, setup.small, underpaid, undefined),
    ]);
    expect(quote()).toMatchObject({ status: "manual_review_required", transfer_surfacing_pending: false });
    expect(mockMemory.tables.managed_venice_token_lots).toHaveLength(0);
  });

  it("S2: a bearer settle, the cron, then a bearer redelivery of the other log leave one item for that log", async () => {
    const OVER = 3000n * 10n ** 18n;
    rpc.addTransfer(transfer("0xbb", QUOTED, PAID_AT, { logIndex: 3 }));
    rpc.addTransfer(transfer("0xbb", OVER, PAID_AT, { logIndex: 7 }));
    rpc.setLatestBlock(blockAt("2026-05-16T10:23:00.000Z"));

    expect(await data(await deliver("0xbb", QUOTED, PAID_AT))).toEqual({ status: "settled", quoteId: "quote_1" });
    for (const iso of ["2026-05-16T10:30:00.000Z", "2026-05-16T13:30:00.000Z"]) await tickAt(iso);
    expect(await data(await deliver("0xbb", OVER, PAID_AT))).toEqual({ status: "manual_review_required" });

    expect(items()).toEqual([item("0xbb", 7, OVER, amountMismatch, 7)]);
    expect(quote()).toMatchObject({
      status: "settled",
      transaction_hash: "0xbb",
      transfer_surfacing_pending: false,
      metadata: expect.objectContaining({ settlementClaim: expect.objectContaining({ logIndex: 3 }) }),
    });
    expect(mockMemory.tables.managed_venice_token_lots).toHaveLength(1);
  });

  it("keys a delivery by the scan's own filter: other tokens', other addresses', self and zero-value logs never count as the first log", async () => {
    const OTHER_TOKEN = "0x00000000000000000000000000000000000c0ffe";
    const D2 = "0x000000000000000000000000000000000000d2d2";
    rpc.addTransfer(transfer("0xmixed", QUOTED, PAID_AT, { logIndex: 0, tokenAddress: OTHER_TOKEN }));
    rpc.addTransfer(transfer("0xmixed", QUOTED, PAID_AT, { logIndex: 1, to: D2 }));
    rpc.addTransfer(transfer("0xmixed", QUOTED, PAID_AT, { logIndex: 2, from: TEST_DEPOSIT_ADDRESS }));
    rpc.addTransfer(transfer("0xmixed", 0n, PAID_AT, { logIndex: 3 }));
    rpc.addTransfer(transfer("0xmixed", FIVE, PAID_AT, { logIndex: 4 }));
    rpc.addTransfer(transfer("0xmixed", QUOTED, PAID_AT, { logIndex: 5 }));
    rpc.setLatestBlock(blockAt("2026-05-16T10:23:00.000Z"));

    expect(await data(await deliver("0xmixed", QUOTED, PAID_AT))).toEqual({ status: "settled", quoteId: "quote_1" });
    expect(await data(await deliver("0xmixed", FIVE, PAID_AT))).toEqual({ status: "manual_review_required" });
    for (const iso of ["2026-05-16T10:30:00.000Z", "2026-05-16T13:30:00.000Z"]) await tickAt(iso);

    // Log 4 is the tx's first accepted log to the address: the bare key, as the scan keys it.
    expect(items()).toEqual([item("0xmixed", 4, FIVE, replayedAfterSettlement, undefined)]);
    expect(quote().metadata).toMatchObject({ settlementClaim: expect.objectContaining({ logIndex: 5 }) });
  });

  it.each([
    [
      "two logs carry the delivered amount",
      "ambiguous_log",
      () => {
        rpc.addTransfer(transfer("0xtwin", QUOTED, PAID_AT, { logIndex: 0 }));
        rpc.addTransfer(transfer("0xtwin", QUOTED, PAID_AT, { logIndex: 1 }));
      },
    ],
    ["the tx has no receipt (unknown or not mined yet)", "receipt_unavailable", () => undefined],
    [
      "the tx reverted",
      "transaction_failed",
      () => {
        rpc.addTransfer(transfer("0xtwin", QUOTED, PAID_AT, { logIndex: 0 }));
        rpc.setReceiptStatus("0xtwin", "0x0");
      },
    ],
    [
      "no accepted log carries the delivered amount",
      "no_matching_log",
      () => rpc.addTransfer(transfer("0xtwin", FIVE, PAID_AT, { logIndex: 0 })),
    ],
    [
      "the Base RPC refuses the receipt lookup",
      "rpc_unavailable",
      () => {
        rpc.addTransfer(transfer("0xtwin", QUOTED, PAID_AT, { logIndex: 0 }));
        rpc.failNext({ method: "eth_getTransactionReceipt", status: 400 });
      },
    ],
  ])("returns a retryable error and writes nothing when %s", async (_label, reason, setup) => {
    setup();
    rpc.setLatestBlock(blockAt("2026-05-16T10:23:00.000Z"));

    const response = await deliver("0xtwin", QUOTED, PAID_AT);

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.json()).toMatchObject({ success: false, retryable: true, reason });
    expect(mockMemory.calls).toEqual([]);
    expect(quote()).toMatchObject({ status: "active", transaction_hash: null, transfer_surfacing_pending: false });
    expect(rpc.methodCount("eth_getTransactionReceipt")).toBe(1);
  });

  it("leaves an ambiguous delivery to the cron, which credits one log and surfaces the other once", async () => {
    rpc.addTransfer(transfer("0xtwin", QUOTED, PAID_AT, { logIndex: 0 }));
    rpc.addTransfer(transfer("0xtwin", QUOTED, PAID_AT, { logIndex: 1 }));
    rpc.setLatestBlock(blockAt("2026-05-16T10:23:00.000Z"));

    expect((await deliver("0xtwin", QUOTED, PAID_AT)).status).toBe(503);
    for (const iso of ["2026-05-16T10:25:00.000Z", "2026-05-16T13:30:00.000Z"]) await tickAt(iso);

    expect(quote()).toMatchObject({ status: "settled", transaction_hash: "0xtwin", transfer_surfacing_pending: false });
    expect(items()).toEqual([item("0xtwin", 1, QUOTED, MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.extraTransfer, 1)]);
  });
});
