import {
  MANAGED_VENICE_TOKEN_DEPOSIT_REASONS,
  managedVeniceTokenTransferDedupeKey,
  retireManagedVeniceTokenQuote,
  settleManagedVeniceTokenQuote,
} from "@/lib/billing/managed-venice-token-quotes";
import { log } from "@/lib/logger";
import {
  createManagedVeniceMemoryDb,
  managedVeniceQuoteRow,
  type MemoryRow,
} from "@/test-utils/managed-venice-memory-db";

// Settlement is a claim-first saga with no multi-statement transaction: claim
// the tx on the quote (CAS), insert the lot, write the deposit + bonus events,
// then flip the quote to settled (CAS). These tests drive every crash point and
// read-then-write race through the real module against a memory DB that
// enforces the production unique indexes.

const QUOTED = "1000000000000000000000"; // 1000 tokens @ $0.05 = $50 paid, $10 launch bonus
const HALF = "500000000000000000000";
const OVER = "1100000000000000000000";
const IN_WINDOW = "2026-05-16T10:21:00.000Z";

function seed(quote: MemoryRow = {}) {
  return createManagedVeniceMemoryDb({
    managed_venice_token_quotes: [managedVeniceQuoteRow(quote)],
  });
}

function quoteRow(memory: ReturnType<typeof seed>, id = "quote_1") {
  return memory.tables.managed_venice_token_quotes.find((row) => row.id === id)!;
}

function events(memory: ReturnType<typeof seed>, type: string) {
  return memory.tables.managed_venice_financial_events.filter((event) => event.event_type === type);
}

const failFlip = { table: "managed_venice_token_quotes", op: "update" as const, match: (patch: MemoryRow) => patch.status === "settled" };

describe("managed Venice token settlement saga", () => {
  it("bug 1: a retry after the lot exists converges on the lot's tx and surfaces the retry's tx once", async () => {
    const memory = seed();
    // Pass 1 dies after lot + events are written, before the quote flip.
    memory.failNext(failFlip);
    await expect(
      settleManagedVeniceTokenQuote(
        { quoteId: "quote_1", transactionHash: "0xfirst", tokenAmountRaw: OVER, observedAt: IN_WINDOW, logIndex: 0 },
        memory.db
      )
    ).rejects.toThrow();
    expect(memory.tables.managed_venice_token_lots).toHaveLength(1);
    expect(quoteRow(memory).status).toBe("active");

    // Pass 2 sees a DIFFERENT transfer (e.g. a smaller in-band one confirmed later).
    const retry = await settleManagedVeniceTokenQuote(
      { quoteId: "quote_1", transactionHash: "0xsecond", tokenAmountRaw: QUOTED, observedAt: IN_WINDOW, logIndex: 0 },
      memory.db
    );

    expect(retry).toEqual({ status: "settled", quoteId: "quote_1" });
    const quote = quoteRow(memory);
    const [lot] = memory.tables.managed_venice_token_lots;
    expect(memory.tables.managed_venice_token_lots).toHaveLength(1);
    expect(quote.status).toBe("settled");
    expect(quote.transaction_hash).toBe("0xfirst");
    expect(lot.transaction_hash).toBe("0xfirst");
    // Values on the quote come from the lot (the 1.1x over-send), not the retry.
    expect(lot.token_amount_raw).toBe(OVER);
    expect(lot.original_value_micro_usd).toBe(65_000_000);
    expect((quote.metadata as MemoryRow).managedVeniceTopUp).toMatchObject({
      paidValueMicroUsd: 55_000_000,
      creditValueMicroUsd: 65_000_000,
      bonusValueMicroUsd: 10_000_000,
    });
    expect(events(memory, "token_deposit").map((event) => event.idempotency_key)).toEqual([
      "managed_venice_token_deposit:quote_1:0xfirst",
    ]);
    expect(events(memory, "subsidy_applied").map((event) => event.idempotency_key)).toEqual([
      "managed_venice_token_bonus:quote_1:0xfirst",
    ]);
    expect(memory.tables.managed_venice_reconciliation_items).toEqual([
      expect.objectContaining({
        reason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.extraTransfer,
        dedupe_key: managedVeniceTokenTransferDedupeKey("0xsecond"),
        status: "open",
        metadata: expect.objectContaining({ quoteId: "quote_1", transactionHash: "0xsecond" }),
      }),
    ]);

    // A further redelivery of 0xsecond never adds a second item.
    await settleManagedVeniceTokenQuote(
      { quoteId: "quote_1", transactionHash: "0xsecond", tokenAmountRaw: QUOTED, observedAt: IN_WINDOW, logIndex: 0 },
      memory.db
    );
    expect(memory.tables.managed_venice_reconciliation_items).toHaveLength(1);
  });

  it("converges a legacy crash state (lot exists, quote tx null, no claim) on the lot tx", async () => {
    const memory = seed();
    memory.insertRow("managed_venice_token_lots", {
      account_id: "account_1",
      user_id: "user_1",
      quote_id: "quote_1",
      source: "hermesos_deposit",
      token_amount_raw: QUOTED,
      remaining_token_amount_raw: QUOTED,
      snapshot_price_usd: "0.05",
      original_value_micro_usd: 60_000_000,
      remaining_value_micro_usd: 60_000_000,
      quote_source: "dexscreener",
      quoted_at: "2026-05-16T10:20:00.000Z",
      transaction_hash: "0xlegacy",
      status: "active",
      metadata: { quoteId: "quote_1", observedAt: IN_WINDOW, paidValueMicroUsd: 50_000_000, creditValueMicroUsd: 60_000_000, bonusValueMicroUsd: 10_000_000 },
    });

    const result = await settleManagedVeniceTokenQuote(
      { quoteId: "quote_1", transactionHash: "0xother", tokenAmountRaw: QUOTED, observedAt: IN_WINDOW },
      memory.db
    );

    expect(result.status).toBe("settled");
    expect(quoteRow(memory)).toMatchObject({ status: "settled", transaction_hash: "0xlegacy" });
    expect(memory.tables.managed_venice_token_lots).toHaveLength(1);
    expect(events(memory, "token_deposit")).toHaveLength(1);
    expect(events(memory, "token_deposit")[0].idempotency_key).toBe("managed_venice_token_deposit:quote_1:0xlegacy");
    expect(memory.tables.managed_venice_reconciliation_items).toEqual([
      expect.objectContaining({
        reason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.extraTransfer,
        dedupe_key: managedVeniceTokenTransferDedupeKey("0xother"),
      }),
    ]);
  });

  it("never inserts a lot before the quote durably claims the tx (no double credit across quotes)", async () => {
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [
        managedVeniceQuoteRow({ id: "quote_a", created_at: "2026-05-16T10:20:00.000Z" }),
        managedVeniceQuoteRow({ id: "quote_b", created_at: "2026-05-16T10:20:00.001Z" }),
      ],
    });

    const warn = jest.spyOn(log, "warn").mockImplementation(() => undefined);
    await settleManagedVeniceTokenQuote(
      { quoteId: "quote_a", transactionHash: "0xonce", tokenAmountRaw: QUOTED, observedAt: IN_WINDOW },
      memory.db
    );
    const second = await settleManagedVeniceTokenQuote(
      { quoteId: "quote_b", transactionHash: "0xonce", tokenAmountRaw: QUOTED, observedAt: IN_WINDOW },
      memory.db
    );

    expect(second).toEqual({ status: "transaction_already_claimed", quoteId: "quote_b" });
    expect(warn).toHaveBeenCalledWith(
      "managed Venice token transfer already claimed by another quote",
      expect.objectContaining({ quoteId: "quote_b", transactionHash: "0xonce" })
    );
    warn.mockRestore();
    expect(memory.tables.managed_venice_token_lots.map((lot) => lot.quote_id)).toEqual(["quote_a"]);
    expect(events(memory, "token_deposit")).toHaveLength(1);
    expect(quoteRow(memory, "quote_b")).toMatchObject({ status: "active", transaction_hash: null });
    expect(memory.tables.managed_venice_reconciliation_items).toHaveLength(0);
  });

  it("refuses a fresh claim of a tx that is already another quote's lot (legacy lot, that quote's tx never recorded)", async () => {
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [
        managedVeniceQuoteRow({ id: "quote_a", created_at: "2026-05-16T10:20:00.000Z" }),
        managedVeniceQuoteRow({ id: "quote_b", created_at: "2026-05-16T10:20:00.001Z" }),
      ],
    });
    memory.insertRow("managed_venice_token_lots", {
      account_id: "account_1",
      user_id: "user_1",
      quote_id: "quote_a",
      source: "hermesos_deposit",
      token_amount_raw: QUOTED,
      remaining_token_amount_raw: QUOTED,
      snapshot_price_usd: "0.05",
      original_value_micro_usd: 60_000_000,
      remaining_value_micro_usd: 60_000_000,
      quote_source: "dexscreener",
      quoted_at: "2026-05-16T10:20:00.000Z",
      transaction_hash: "0xlegacy",
      status: "active",
      metadata: { quoteId: "quote_a", observedAt: IN_WINDOW },
    });

    const warn = jest.spyOn(log, "warn").mockImplementation(() => undefined);
    const result = await settleManagedVeniceTokenQuote(
      { quoteId: "quote_b", transactionHash: "0xLEGACY", tokenAmountRaw: QUOTED, observedAt: IN_WINDOW },
      memory.db
    );

    expect(result).toEqual({ status: "transaction_already_claimed", quoteId: "quote_b" });
    expect(warn).toHaveBeenCalledWith(
      "managed Venice token transfer already claimed by another quote",
      expect.objectContaining({ quoteId: "quote_b", transactionHash: "0xlegacy", boundTo: "lot" })
    );
    warn.mockRestore();
    expect(quoteRow(memory, "quote_b")).toMatchObject({ status: "active", transaction_hash: null });
    expect(memory.tables.managed_venice_token_lots.map((lot) => lot.quote_id)).toEqual(["quote_a"]);
    expect(events(memory, "token_deposit")).toHaveLength(0);
    expect(memory.tables.managed_venice_reconciliation_items).toHaveLength(0);
  });

  it("keys a transfer's item by its lowercased tx hash alone (no log index)", () => {
    expect(managedVeniceTokenTransferDedupeKey(" 0xABC ")).toBe("managed_venice_token_transfer:0xabc");
  });

  it("CAS: a stale review can never overwrite a settled quote", async () => {
    const memory = seed();
    const snapshot = memory.tables.managed_venice_token_quotes.map((row) => ({ ...row }));
    await settleManagedVeniceTokenQuote(
      { quoteId: "quote_1", transactionHash: "0xgood", tokenAmountRaw: QUOTED, observedAt: IN_WINDOW },
      memory.db
    );

    await settleManagedVeniceTokenQuote(
      { quoteId: "quote_1", transactionHash: "0xunder", tokenAmountRaw: HALF, observedAt: IN_WINDOW },
      memory.withStaleReads("managed_venice_token_quotes", snapshot)
    ).catch(() => undefined);

    expect(quoteRow(memory)).toMatchObject({ status: "settled", transaction_hash: "0xgood" });
    expect(memory.tables.managed_venice_token_lots).toHaveLength(1);
  });

  it("CAS: a stale settle can never overwrite a manual-review quote (and inserts no lot)", async () => {
    const memory = seed();
    const snapshot = memory.tables.managed_venice_token_quotes.map((row) => ({ ...row }));
    await settleManagedVeniceTokenQuote(
      { quoteId: "quote_1", transactionHash: "0xunder", tokenAmountRaw: HALF, observedAt: IN_WINDOW },
      memory.db
    );
    expect(quoteRow(memory).status).toBe("manual_review_required");

    await settleManagedVeniceTokenQuote(
      { quoteId: "quote_1", transactionHash: "0xgood", tokenAmountRaw: QUOTED, observedAt: IN_WINDOW },
      memory.withStaleReads("managed_venice_token_quotes", snapshot)
    ).catch(() => undefined);

    expect(quoteRow(memory)).toMatchObject({ status: "manual_review_required", transaction_hash: null });
    expect(memory.tables.managed_venice_token_lots).toHaveLength(0);
    expect(events(memory, "token_deposit")).toHaveLength(0);
  });

  it("CAS: a claimed quote is never moved to review; the claim completes instead", async () => {
    const memory = seed();
    // Claim lands, then the lot insert fails: quote is claimed but not credited.
    memory.failNext({ table: "managed_venice_token_lots", op: "insert" });
    await expect(
      settleManagedVeniceTokenQuote(
        { quoteId: "quote_1", transactionHash: "0xclaimed", tokenAmountRaw: QUOTED, observedAt: IN_WINDOW },
        memory.db
      )
    ).rejects.toThrow();
    expect(quoteRow(memory)).toMatchObject({ status: "active", transaction_hash: "0xclaimed" });
    const claimedSnapshot = memory.tables.managed_venice_token_quotes.map((row) => ({ ...row, transaction_hash: null }));

    // A stale reader that still thinks the quote is unclaimed cannot review it.
    await settleManagedVeniceTokenQuote(
      { quoteId: "quote_1", transactionHash: "0xunder", tokenAmountRaw: HALF, observedAt: IN_WINDOW },
      memory.withStaleReads("managed_venice_token_quotes", claimedSnapshot)
    ).catch(() => undefined);
    expect(quoteRow(memory)).toMatchObject({ status: "active", transaction_hash: "0xclaimed" });

    // A fresh reader converges on the claim and surfaces the under-payment as an extra transfer.
    const result = await settleManagedVeniceTokenQuote(
      { quoteId: "quote_1", transactionHash: "0xunder", tokenAmountRaw: HALF, observedAt: IN_WINDOW },
      memory.db
    );
    expect(result).toEqual({ status: "settled", quoteId: "quote_1" });
    expect(quoteRow(memory)).toMatchObject({ status: "settled", transaction_hash: "0xclaimed" });
    expect(memory.tables.managed_venice_token_lots).toEqual([
      expect.objectContaining({ transaction_hash: "0xclaimed", token_amount_raw: QUOTED }),
    ]);
    expect(memory.tables.managed_venice_reconciliation_items.map((item) => item.dedupe_key)).toEqual([
      managedVeniceTokenTransferDedupeKey("0xunder"),
    ]);
  });

  it("reviews an under-payment without binding its tx to the quote and merges review metadata", async () => {
    const memory = seed();
    const result = await settleManagedVeniceTokenQuote(
      { quoteId: "quote_1", transactionHash: "0xUnder", tokenAmountRaw: HALF, observedAt: IN_WINDOW, logIndex: 3 },
      memory.db
    );

    expect(result).toEqual({ status: "manual_review_required" });
    const quote = quoteRow(memory);
    expect(quote.status).toBe("manual_review_required");
    expect(quote.transaction_hash).toBeNull();
    expect(quote.metadata).toMatchObject({
      primaryRaw: { pairAddress: "0xpair" },
      managedVeniceTopUp: expect.objectContaining({ launchPaidMicroUsd: 50_000_000, reason: "launch" }),
      manualReviewReason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.underpaid,
      observedTokenAmountRaw: HALF,
      observedAt: IN_WINDOW,
      reviewTransactionHash: "0xunder",
    });
    expect(memory.tables.managed_venice_reconciliation_items).toEqual([
      expect.objectContaining({
        reason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.underpaid,
        dedupe_key: "managed_venice_token_transfer:0xunder",
      }),
    ]);
    expect(memory.tables.managed_venice_token_lots).toHaveLength(0);
  });

  it("flips the review first: a failed item insert after the flip leaves the surfacing flag, and a redelivery writes one item", async () => {
    const memory = seed();
    memory.failNext({ table: "managed_venice_reconciliation_items", op: "insert" });
    await expect(
      settleManagedVeniceTokenQuote(
        { quoteId: "quote_1", transactionHash: "0xfat", tokenAmountRaw: "3000000000000000000000", observedAt: IN_WINDOW },
        memory.db
      )
    ).rejects.toThrow();
    // Terminal and owing surfacing: the reconciler's surface-only pass (or a
    // redelivery, below) writes the missing item.
    expect(quoteRow(memory)).toMatchObject({
      status: "manual_review_required",
      transaction_hash: null,
      transfer_surfacing_pending: true,
      metadata: expect.objectContaining({
        manualReviewReason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.amountMismatch,
        reviewTransactionHash: "0xfat",
      }),
    });
    expect(memory.tables.managed_venice_reconciliation_items).toHaveLength(0);

    for (let delivery = 0; delivery < 2; delivery += 1) {
      const retry = await settleManagedVeniceTokenQuote(
        { quoteId: "quote_1", transactionHash: "0xfat", tokenAmountRaw: "3000000000000000000000", observedAt: IN_WINDOW },
        memory.db
      );
      expect(retry.status).toBe("manual_review_required");
    }
    expect(memory.tables.managed_venice_reconciliation_items).toEqual([
      expect.objectContaining({
        reason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.amountMismatch,
        dedupe_key: managedVeniceTokenTransferDedupeKey("0xfat"),
      }),
    ]);
  });

  it("a review that loses its CAS to a claim of the same transfer writes no item: never credited AND surfaced", async () => {
    const memory = seed();
    // A bearer delivery claims 0xpaid (in window) and dies before the lot.
    memory.failNext({ table: "managed_venice_token_lots", op: "insert" });
    await expect(
      settleManagedVeniceTokenQuote(
        { quoteId: "quote_1", transactionHash: "0xpaid", tokenAmountRaw: QUOTED, observedAt: IN_WINDOW },
        memory.db
      )
    ).rejects.toThrow();
    const unclaimedSnapshot = memory.tables.managed_venice_token_quotes.map((row) => ({ ...row, transaction_hash: null }));

    // A stale reader saw the same transfer as late (outside the window) and
    // tries to review with it: its CAS loses to the claim on both passes.
    await expect(
      settleManagedVeniceTokenQuote(
        { quoteId: "quote_1", transactionHash: "0xpaid", tokenAmountRaw: QUOTED, observedAt: "2026-05-16T11:00:00.000Z" },
        memory.withStaleReads("managed_venice_token_quotes", unclaimedSnapshot)
      )
    ).rejects.toThrow("changed concurrently");
    expect(memory.tables.managed_venice_reconciliation_items).toHaveLength(0);

    // The claim completes: 0xpaid is credited and has no open item.
    const completed = await settleManagedVeniceTokenQuote(
      { quoteId: "quote_1", transactionHash: "0xpaid", tokenAmountRaw: QUOTED, observedAt: IN_WINDOW },
      memory.db
    );
    expect(completed.status).toBe("settled");
    expect(quoteRow(memory)).toMatchObject({ status: "settled", transaction_hash: "0xpaid" });
    expect(memory.tables.managed_venice_token_lots).toHaveLength(1);
    expect(memory.tables.managed_venice_reconciliation_items).toHaveLength(0);
  });

  it("surfaces a different tx against a settled quote exactly once and never mutates the quote", async () => {
    const memory = seed();
    await settleManagedVeniceTokenQuote(
      { quoteId: "quote_1", transactionHash: "0xpaid", tokenAmountRaw: QUOTED, observedAt: IN_WINDOW },
      memory.db
    );
    const settled = { ...quoteRow(memory) };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const replay = await settleManagedVeniceTokenQuote(
        { quoteId: "quote_1", transactionHash: "0xreplay", tokenAmountRaw: QUOTED, observedAt: IN_WINDOW },
        memory.db
      );
      expect(replay).toEqual({ status: "manual_review_required" });
    }

    expect(quoteRow(memory)).toEqual(settled);
    expect(memory.tables.managed_venice_reconciliation_items).toEqual([
      expect.objectContaining({ reason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.replayedAfterSettlement }),
    ]);
  });

  it("never settles or re-reviews a closed quote; surfaces an unbound transfer once", async () => {
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [
        managedVeniceQuoteRow({ id: "quote_review", status: "manual_review_required", metadata: { reviewTransactionHash: "0xreviewed" } }),
        managedVeniceQuoteRow({ id: "quote_cancelled", status: "cancelled" }),
        managedVeniceQuoteRow({ id: "quote_other", status: "settled", transaction_hash: "0xbound" }),
      ],
    });

    const reviewed = await settleManagedVeniceTokenQuote(
      { quoteId: "quote_review", transactionHash: "0xlate", tokenAmountRaw: QUOTED, observedAt: "2026-05-16T11:00:00.000Z" },
      memory.db
    );
    await settleManagedVeniceTokenQuote(
      { quoteId: "quote_review", transactionHash: "0xlate", tokenAmountRaw: QUOTED, observedAt: "2026-05-16T11:00:00.000Z" },
      memory.db
    );
    const cancelled = await settleManagedVeniceTokenQuote(
      { quoteId: "quote_cancelled", transactionHash: "0xbound", tokenAmountRaw: QUOTED, observedAt: IN_WINDOW },
      memory.db
    );
    await settleManagedVeniceTokenQuote(
      { quoteId: "quote_review", transactionHash: "0xreviewed", tokenAmountRaw: HALF, observedAt: IN_WINDOW },
      memory.db
    );

    expect(reviewed).toEqual({ status: "manual_review_required" });
    expect(cancelled).toEqual({ status: "cancelled" });
    expect(quoteRow(memory, "quote_review")).toMatchObject({ status: "manual_review_required", transaction_hash: null });
    expect(quoteRow(memory, "quote_cancelled")).toMatchObject({ status: "cancelled", transaction_hash: null });
    expect(memory.tables.managed_venice_token_lots).toHaveLength(0);
    // Only 0xlate is new: 0xbound belongs to another quote and 0xreviewed is the review's own transfer.
    expect(memory.tables.managed_venice_reconciliation_items).toEqual([
      expect.objectContaining({
        reason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.outsideQuoteWindow,
        dedupe_key: managedVeniceTokenTransferDedupeKey("0xlate"),
      }),
    ]);
  });

  it("merges settlement metadata (price provenance and the quoted bonus split survive)", async () => {
    const memory = seed();
    await settleManagedVeniceTokenQuote(
      { quoteId: "quote_1", transactionHash: "0xpaid", tokenAmountRaw: QUOTED, observedAt: IN_WINDOW, blockTimestamp: "2026-05-16T10:20:30.000Z", logIndex: 1 },
      memory.db
    );

    expect(quoteRow(memory).metadata).toEqual(
      expect.objectContaining({
        primaryRaw: { pairAddress: "0xpair" },
        crossCheckRaw: null,
        observedAt: "2026-05-16T10:20:30.000Z",
        blockTimestamp: "2026-05-16T10:20:30.000Z",
        managedVeniceTopUp: expect.objectContaining({
          policy: "deposit_bonus_v1",
          paidValueMicroUsd: 50_000_000,
          creditValueMicroUsd: 60_000_000,
          bonusValueMicroUsd: 10_000_000,
          launchPaidMicroUsd: 50_000_000,
          launchBonusMicroUsd: 10_000_000,
          reason: "launch",
        }),
        settlementClaim: expect.objectContaining({
          transactionHash: "0xpaid",
          logIndex: 1,
          tokenAmountRaw: QUOTED,
          creditValueMicroUsd: 60_000_000,
        }),
      })
    );
  });

  it("retires an unpaid quote to cancelled, but never a claimed one", async () => {
    const memory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [
        managedVeniceQuoteRow({ id: "quote_unpaid", status: "expired" }),
        managedVeniceQuoteRow({ id: "quote_claimed", transaction_hash: "0xclaimed" }),
      ],
    });

    const retired = await retireManagedVeniceTokenQuote(
      { quoteId: "quote_unpaid", closedAt: new Date("2026-05-16T13:00:00.000Z") },
      memory.db
    );
    const refused = await retireManagedVeniceTokenQuote(
      { quoteId: "quote_claimed", closedAt: new Date("2026-05-16T13:00:00.000Z") },
      memory.db
    );

    expect(retired).toEqual({ status: "cancelled" });
    expect(quoteRow(memory, "quote_unpaid")).toMatchObject({
      status: "cancelled",
      metadata: expect.objectContaining({
        closedReason: "expired_unpaid",
        closedAt: "2026-05-16T13:00:00.000Z",
        managedVeniceTopUp: expect.objectContaining({ reason: "launch" }),
      }),
    });
    expect(refused).toEqual({ status: "active" });
    expect(quoteRow(memory, "quote_claimed").status).toBe("active");
  });
});
