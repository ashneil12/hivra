import { log } from "@/lib/logger";
import {
  MANAGED_VENICE_TOKEN_DEPOSIT_REASONS,
  settleManagedVeniceTokenQuote,
} from "@/lib/billing/managed-venice-token-quotes";
import { reconcilePendingManagedVeniceTokenQuotes } from "@/lib/billing/managed-venice-token-reconciliation";
import {
  createBaseRpcFake,
  createManagedVeniceMemoryDb,
  managedVeniceQuoteRow,
  TEST_DEPOSIT_ADDRESS,
  type FakeTransfer,
  type MemoryRow,
} from "@/test-utils/managed-venice-memory-db";

// A transfer is one ERC-20 Transfer log: (tx, deposit address, log index).
// One tx can pay several users' deposit addresses (an ERC-4337 bundle such as
// Coinbase Smart Wallet, an exchange or disperse batch withdrawal) or pay one
// address twice (two userOps from one sender in one bundle). Bindings are
// checked per deposit address and per log, and each transfer gets its own
// item key, so every such transfer is credited or surfaced exactly once.
//
// quote_1: user_1 on D1 (TEST_DEPOSIT_ADDRESS); quote_2: user_2 on D2. Both
// quoted 10:20, expire 10:40, grace end 12:40. 2 s blocks, 3 confirmations.

const ANCHOR_BLOCK = 5_000_000;
const ANCHOR_TIME = "2026-05-16T10:35:00.000Z";
const QUOTED = 1000n * 10n ** 18n;
const D1 = TEST_DEPOSIT_ADDRESS;
const D2 = "0x000000000000000000000000000000000000d2d2";

function blockAt(iso: string) {
  return ANCHOR_BLOCK + Math.floor((Date.parse(iso) - Date.parse(ANCHOR_TIME)) / 2000);
}

function transfer(txHash: string, amount: bigint, iso: string, extra: Partial<FakeTransfer> = {}): FakeTransfer {
  return { txHash, amountRaw: amount, block: blockAt(iso), to: D1, ...extra };
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

const quote2 = (overrides: MemoryRow = {}) =>
  managedVeniceQuoteRow({
    id: "quote_2",
    user_id: "user_2",
    account_id: "account_2",
    deposit_address: D2,
    created_at: "2026-05-16T10:20:01.000Z",
    ...overrides,
  });

function seed(...quotes: MemoryRow[]) {
  return createManagedVeniceMemoryDb({
    managed_venice_token_quotes: quotes.length ? quotes : [managedVeniceQuoteRow()],
  });
}

function quote(memory: Memory, id = "quote_1") {
  return memory.tables.managed_venice_token_quotes.find((row) => row.id === id)!;
}

function transferKey(txHash: string, depositAddress: string, logIndex?: number) {
  return `managed_venice_token_transfer:${txHash}:${depositAddress}${logIndex === undefined ? "" : `:${logIndex}`}`;
}

function openItems(memory: Memory) {
  return memory.tables.managed_venice_reconciliation_items
    .filter((row) => row.status === "open")
    .map((row) => ({
      key: row.dedupe_key,
      reason: row.reason,
      quoteId: (row.metadata as MemoryRow).quoteId,
      amount: (row.metadata as MemoryRow).observedTokenAmountRaw,
    }));
}

const LATER_TICKS = ["2026-05-16T11:00:00.000Z", "2026-05-16T13:00:00.000Z", "2026-05-16T13:30:00.000Z"];

describe("managed Venice transfers: one tx paying several deposit addresses", () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(log, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it("a bundle tx paying two users exactly: one quote settles, the other goes to review as a claim conflict, never cancelled", async () => {
    const memory = seed(managedVeniceQuoteRow(), quote2());
    const rpc = chain([
      transfer("0xbundle", QUOTED, "2026-05-16T10:22:00.000Z", { logIndex: 3 }),
      transfer("0xbundle", QUOTED, "2026-05-16T10:22:00.000Z", { logIndex: 7, to: D2 }),
    ]);

    const first = await tickAt(memory, rpc, "2026-05-16T10:25:00.000Z");
    expect(first.failed).toBe(0);
    for (const iso of LATER_TICKS) expect((await tickAt(memory, rpc, iso)).failed).toBe(0);

    // quote_2 (newest) claimed the tx; its lot holds its own log.
    expect(quote(memory, "quote_2")).toMatchObject({ status: "settled", transaction_hash: "0xbundle" });
    expect(memory.tables.managed_venice_token_lots).toEqual([
      expect.objectContaining({ quote_id: "quote_2", transaction_hash: "0xbundle" }),
    ]);
    // user_1's payment can never be claimed (the claim is unique per tx), so
    // it reaches the operator instead of vanishing.
    expect(quote(memory)).toMatchObject({
      status: "manual_review_required",
      transaction_hash: null,
      metadata: expect.objectContaining({
        manualReviewReason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.claimConflict,
        reviewTransactionHash: "0xbundle",
        reviewLogIndex: 3,
        primaryRaw: { pairAddress: "0xpair" },
      }),
    });
    expect(openItems(memory)).toEqual([
      {
        key: transferKey("0xbundle", D1),
        reason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.claimConflict,
        quoteId: "quote_1",
        amount: QUOTED.toString(),
      },
    ]);
    // Both quotes' surfacing finished once their ranges were confirmed.
    expect(quote(memory).transfer_surfacing_pending).toBe(false);
    expect(quote(memory, "quote_2").transfer_surfacing_pending).toBe(false);
  });

  it("a bearer delivery of a tx claimed on another address reviews the quote as a claim conflict (not a silent refusal)", async () => {
    const memory = seed(managedVeniceQuoteRow(), quote2({ status: "settled", transaction_hash: "0xbundle" }));

    const result = await settleManagedVeniceTokenQuote(
      { quoteId: "quote_1", transactionHash: "0xBUNDLE", tokenAmountRaw: QUOTED.toString(), observedAt: "2026-05-16T10:22:00.000Z" },
      memory.db
    );

    expect(result).toEqual({ status: "manual_review_required" });
    expect(quote(memory)).toMatchObject({
      status: "manual_review_required",
      transaction_hash: null,
      transfer_surfacing_pending: true,
      metadata: expect.objectContaining({
        manualReviewReason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.claimConflict,
        reviewTransactionHash: "0xbundle",
      }),
    });
    expect(openItems(memory)).toEqual([
      expect.objectContaining({ key: transferKey("0xbundle", D1), reason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.claimConflict }),
    ]);
    expect(warn).toHaveBeenCalledWith(
      "managed Venice token transfer is claimed on another deposit address; sending the quote to review",
      expect.objectContaining({ quoteId: "quote_1", transactionHash: "0xbundle", boundTo: "quote" })
    );
  });

  it("a tx bound on the SAME address is still refused silently and excluded from attribution", async () => {
    const memory = seed(
      managedVeniceQuoteRow({ id: "quote_old", status: "settled", transaction_hash: "0xpaid", created_at: "2026-05-16T10:19:00.000Z" }),
      managedVeniceQuoteRow()
    );
    const rpc = chain([transfer("0xpaid", QUOTED, "2026-05-16T10:22:00.000Z")]);

    const bearer = await settleManagedVeniceTokenQuote(
      { quoteId: "quote_1", transactionHash: "0xpaid", tokenAmountRaw: QUOTED.toString(), observedAt: "2026-05-16T10:22:00.000Z" },
      memory.db
    );
    const tick = await tickAt(memory, rpc, "2026-05-16T10:25:00.000Z");

    expect(bearer).toEqual({ status: "transaction_already_claimed", quoteId: "quote_1" });
    expect(tick.results).toEqual([expect.objectContaining({ quoteId: "quote_1", status: "no_match" })]);
    expect(quote(memory)).toMatchObject({ status: "active", transaction_hash: null });
    expect(openItems(memory)).toEqual([]);
  });

  it("a bundle over-paying two users gives each reviewed quote its own item with its own amount", async () => {
    const memory = seed(managedVeniceQuoteRow(), quote2());
    const rpc = chain([
      transfer("0xbundle", QUOTED * 3n, "2026-05-16T10:22:00.000Z", { logIndex: 3 }),
      transfer("0xbundle", QUOTED * 5n, "2026-05-16T10:22:00.000Z", { logIndex: 7, to: D2 }),
    ]);

    for (const iso of ["2026-05-16T10:25:00.000Z", ...LATER_TICKS]) {
      expect((await tickAt(memory, rpc, iso)).failed).toBe(0);
    }

    expect(quote(memory)).toMatchObject({ status: "manual_review_required", transfer_surfacing_pending: false });
    expect(quote(memory, "quote_2")).toMatchObject({ status: "manual_review_required", transfer_surfacing_pending: false });
    expect(openItems(memory)).toEqual(
      expect.arrayContaining([
        {
          key: transferKey("0xbundle", D1),
          reason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.amountMismatch,
          quoteId: "quote_1",
          amount: (QUOTED * 3n).toString(),
        },
        {
          key: transferKey("0xbundle", D2),
          reason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.amountMismatch,
          quoteId: "quote_2",
          amount: (QUOTED * 5n).toString(),
        },
      ])
    );
    expect(openItems(memory)).toHaveLength(2);
    expect(memory.tables.managed_venice_token_lots).toHaveLength(0);
  });
});

describe("managed Venice transfers: two logs to one deposit address in one tx", () => {
  it("credits the first log once and surfaces the second as an extra transfer under its own log key", async () => {
    const memory = seed();
    const rpc = chain([
      transfer("0xbatch", QUOTED, "2026-05-16T10:22:00.000Z", { logIndex: 1 }),
      transfer("0xbatch", QUOTED, "2026-05-16T10:22:00.000Z", { logIndex: 2 }),
    ]);

    for (const iso of ["2026-05-16T10:25:00.000Z", ...LATER_TICKS]) {
      expect((await tickAt(memory, rpc, iso)).failed).toBe(0);
    }

    expect(quote(memory)).toMatchObject({ status: "settled", transaction_hash: "0xbatch", transfer_surfacing_pending: false });
    expect(memory.tables.managed_venice_token_lots).toEqual([
      expect.objectContaining({ transaction_hash: "0xbatch", token_amount_raw: QUOTED.toString() }),
    ]);
    expect(openItems(memory)).toEqual([
      {
        key: transferKey("0xbatch", D1, 2),
        reason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.extraTransfer,
        quoteId: "quote_1",
        amount: QUOTED.toString(),
      },
    ]);
  });

  it("keeps the surfacing flag until the second log's item exists", async () => {
    const memory = seed();
    const rpc = chain([
      transfer("0xbatch", QUOTED, "2026-05-16T10:22:00.000Z", { logIndex: 1 }),
      transfer("0xbatch", QUOTED, "2026-05-16T10:22:00.000Z", { logIndex: 2 }),
    ]);
    // Every insert of the second log's item fails for the first three tries:
    // after the settle flip, in that tick's surface-only pass, and in the next
    // tick's pass, which already covers the fully confirmed range.
    memory.failNext({
      table: "managed_venice_reconciliation_items",
      op: "insert",
      match: (row) => row.dedupe_key === transferKey("0xbatch", D1, 2),
      times: 3,
    });

    const settling = await tickAt(memory, rpc, "2026-05-16T10:25:00.000Z");
    expect(settling).toMatchObject({ settled: 0, failed: 2, transferSurfacing: { checked: 1, failed: 1 } });
    expect(quote(memory)).toMatchObject({ status: "settled", transfer_surfacing_pending: true });

    const failing = await tickAt(memory, rpc, "2026-05-16T13:30:00.000Z");
    expect(failing.transferSurfacing).toMatchObject({ checked: 1, failed: 1 });
    expect(quote(memory).transfer_surfacing_pending).toBe(true);
    expect(openItems(memory)).toEqual([]);

    const recovered = await tickAt(memory, rpc, "2026-05-16T13:35:00.000Z");
    expect(recovered.transferSurfacing).toMatchObject({ checked: 1, complete: 1 });
    expect(quote(memory).transfer_surfacing_pending).toBe(false);
    expect(openItems(memory).map((item) => item.key)).toEqual([transferKey("0xbatch", D1, 2)]);
    expect(memory.tables.managed_venice_token_lots).toHaveLength(1);
  });
});

describe("managed Venice transfers: a binding without a log index on a two-log tx", () => {
  // 0xbatch pays D1 twice: log 0 = 5 tokens, log 1 = the quoted 1000.
  const SMALL = 5n * 10n ** 18n;
  const PAID_AT = "2026-05-16T10:22:00.000Z";
  const batch = () =>
    chain([
      transfer("0xbatch", SMALL, PAID_AT, { logIndex: 0 }),
      transfer("0xbatch", QUOTED, PAID_AT, { logIndex: 1 }),
    ]);
  const smallLogItem = (quoteId: string) => ({
    key: transferKey("0xbatch", D1),
    reason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.underpaid,
    quoteId,
    amount: SMALL.toString(),
  });

  it("a settlement recorded without a log index binds the log whose amount it credited; the uncredited log is surfaced under the bare key", async () => {
    const memory = seed();
    const rpc = batch();

    // A settlement from before bearer deliveries were resolved to their log
    // records no log index: the claim and lot hold only the amount.
    const bearer = await settleManagedVeniceTokenQuote(
      { quoteId: "quote_1", transactionHash: "0xbatch", tokenAmountRaw: QUOTED.toString(), observedAt: PAID_AT, blockTimestamp: PAID_AT },
      memory.db
    );
    expect(bearer).toEqual({ status: "settled", quoteId: "quote_1" });
    for (const iso of ["2026-05-16T10:30:00.000Z", "2026-05-16T13:30:00.000Z"]) {
      expect((await tickAt(memory, rpc, iso)).failed).toBe(0);
    }

    expect(quote(memory)).toMatchObject({ status: "settled", transaction_hash: "0xbatch", transfer_surfacing_pending: false });
    expect(memory.tables.managed_venice_token_lots).toEqual([
      expect.objectContaining({ quote_id: "quote_1", transaction_hash: "0xbatch", token_amount_raw: QUOTED.toString() }),
    ]);
    // The credited 1000 (log 1) is never shown as uncredited; the 5 tokens are.
    expect(openItems(memory)).toEqual([smallLogItem("quote_1")]);
  });

  it("a legacy settled quote's lot without a log index binds its log by amount on a later quote's scan", async () => {
    // quote_A predates settlement claims and lot log indexes: its tx and lot
    // record only the tx and the amount. The tx was mined in quote_1's window.
    const memory = seed(
      managedVeniceQuoteRow({
        id: "quote_A",
        status: "settled",
        transaction_hash: "0xbatch",
        settled_at: "2026-05-16T10:23:00.000Z",
        quoted_at: "2026-05-16T10:00:00.000Z",
        expires_at: "2026-05-16T10:20:00.000Z",
        created_at: "2026-05-16T10:00:00.000Z",
      }),
      managedVeniceQuoteRow()
    );
    memory.insertRow("managed_venice_token_lots", {
      account_id: "account_1",
      user_id: "user_1",
      quote_id: "quote_A",
      source: "hermesos_deposit",
      token_amount_raw: QUOTED.toString(),
      transaction_hash: "0xbatch",
      status: "active",
      metadata: {},
    });
    const rpc = batch();

    for (const iso of ["2026-05-16T10:30:00.000Z", "2026-05-16T13:30:00.000Z"]) {
      expect((await tickAt(memory, rpc, iso)).failed).toBe(0);
    }

    // quote_A's credited 1000 is bound; the 5 tokens are surfaced on quote_1,
    // which retires once its range is covered instead of retrying the claimed
    // tx every tick.
    expect(quote(memory)).toMatchObject({ status: "cancelled", transaction_hash: null });
    expect(quote(memory, "quote_A")).toMatchObject({ status: "settled", transaction_hash: "0xbatch" });
    expect(memory.tables.managed_venice_token_lots).toHaveLength(1);
    expect(openItems(memory)).toEqual([smallLogItem("quote_1")]);
  });
});

describe("managed Venice transfers: a review trigger binds its transfer", () => {
  // quote_A's window holds the payment; quote_B (a later quote on the same
  // address) was quoted after it. A bearer delivery posts the payment against
  // quote_B.
  const quoteA = () =>
    managedVeniceQuoteRow({
      id: "quote_A",
      status: "expired",
      quoted_at: "2026-05-16T10:00:00.000Z",
      expires_at: "2026-05-16T10:20:00.000Z",
      created_at: "2026-05-16T10:00:00.000Z",
    });
  const quoteB = () =>
    managedVeniceQuoteRow({
      id: "quote_B",
      status: "active",
      quoted_at: "2026-05-16T10:45:00.000Z",
      expires_at: "2026-05-16T11:05:00.000Z",
      created_at: "2026-05-16T10:45:00.000Z",
    });
  const PAID_AT = "2026-05-16T10:10:00.000Z";
  const deliverToB = (memory: Memory) =>
    settleManagedVeniceTokenQuote(
      { quoteId: "quote_B", transactionHash: "0xx", tokenAmountRaw: QUOTED.toString(), observedAt: PAID_AT, blockTimestamp: PAID_AT },
      memory.db
    );

  it("R1: after a bearer delivery reviews quote_B, the cron never credits quote_A with the same transfer", async () => {
    const memory = seed(quoteA(), quoteB());
    const rpc = chain([transfer("0xx", QUOTED, PAID_AT)]);

    expect(await deliverToB(memory)).toEqual({ status: "manual_review_required" });
    for (const iso of ["2026-05-16T10:50:00.000Z", "2026-05-16T12:30:00.000Z", "2026-05-16T13:30:00.000Z"]) {
      expect((await tickAt(memory, rpc, iso)).failed).toBe(0);
    }

    expect(quote(memory, "quote_B")).toMatchObject({
      status: "manual_review_required",
      metadata: expect.objectContaining({
        manualReviewReason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.outsideQuoteWindow,
        reviewTransactionHash: "0xx",
      }),
    });
    expect(quote(memory, "quote_A")).toMatchObject({ transaction_hash: null });
    expect(quote(memory, "quote_A").status).not.toBe("settled");
    expect(memory.tables.managed_venice_token_lots).toHaveLength(0);
    expect(openItems(memory)).toEqual([
      expect.objectContaining({ key: transferKey("0xx", D1), quoteId: "quote_B" }),
    ]);
  });

  it.each([
    ["claimed by a settled quote", { quoteTx: "0xx", lot: true }],
    ["held only by a legacy lot", { quoteTx: null, lot: true }],
  ])("R2: a bearer delivery of a tx %s on the same address leaves quote_B active with no item", async (_label, setup) => {
    const memory = seed(
      { ...quoteA(), status: setup.quoteTx ? "settled" : "cancelled", transaction_hash: setup.quoteTx },
      quoteB()
    );
    memory.insertRow("managed_venice_token_lots", {
      account_id: "account_1",
      user_id: "user_1",
      quote_id: "quote_A",
      source: "hermesos_deposit",
      token_amount_raw: QUOTED.toString(),
      transaction_hash: "0xx",
      status: "active",
      metadata: {},
    });
    const warn = jest.spyOn(log, "warn").mockImplementation(() => undefined);

    const result = await deliverToB(memory);
    warn.mockRestore();

    expect(result).toEqual({ status: "transaction_already_claimed", quoteId: "quote_B" });
    expect(quote(memory, "quote_B")).toMatchObject({
      status: "active",
      transaction_hash: null,
      transfer_surfacing_pending: false,
    });
    expect((quote(memory, "quote_B").metadata as MemoryRow).reviewTransactionHash).toBeUndefined();
    expect(memory.tables.managed_venice_reconciliation_items).toEqual([]);
  });
});
