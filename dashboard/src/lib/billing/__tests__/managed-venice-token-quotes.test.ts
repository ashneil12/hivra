import {
  MANAGED_VENICE_PRICE_MAX_AGE_MS,
  MANAGED_VENICE_PRICE_MAX_DISAGREEMENT_BPS,
  MANAGED_VENICE_QUOTE_LIFETIME_MS,
  ManagedVeniceTokenQuotePriceError,
  ManagedVeniceTopUpExceedsHiddenCapError,
  calculateManagedVeniceLockedValueMicroUsd,
  calculateManagedVeniceTokenAmountRawForUsd,
  createManagedVeniceTokenQuote,
  createManagedVeniceTokenQuoteForUsdTarget,
  settleManagedVeniceTokenQuote,
} from "@/lib/billing/managed-venice-token-quotes";
import { MANAGED_VENICE_HIDDEN_USER_BONUS_CAP_MICRO_USD } from "@/lib/venice/managed-credit-topup";

import {
  MANAGED_VENICE_TOKEN_DEPOSIT_REASONS,
  managedVeniceTokenTransferDedupeKey,
} from "@/lib/billing/managed-venice-token-quotes";
import { createManagedVeniceMemoryDb } from "@/test-utils/managed-venice-memory-db";

// Shared memory DB: real filters, compare-and-set updates that report affected
// rows, and the production unique indexes (23505) on the venice tables.
function createMemoryDb() {
  return createManagedVeniceMemoryDb();
}

const now = new Date("2026-05-12T12:00:00.000Z");
const tokenAmountRaw = "1000000000000000000000";
const freshPrimary = {
  priceUsd: "0.05",
  lastUpdatedAt: Math.floor(now.getTime() / 1000),
  source: "dexscreener" as const,
  raw: { pairAddress: "0xpair" },
};
const freshCrossCheck = {
  priceUsd: "0.051",
  lastUpdatedAt: Math.floor(now.getTime() / 1000),
  source: "uniswap_v4_base_quoter" as const,
};

describe("managed Venice token deposit quotes", () => {
  it("locks a token deposit quote for exactly 20 minutes", async () => {
    const { db } = createMemoryDb();

    const quote = await createManagedVeniceTokenQuote(
      {
        userId: "user_1",
        tokenAmountRaw,
        depositAddress: "0xmanagedvenice",
        now,
        priceQuote: freshPrimary,
        crossCheckQuote: freshCrossCheck,
      },
      db
    );

    expect(MANAGED_VENICE_QUOTE_LIFETIME_MS).toBe(20 * 60_000);
    expect(quote.quotedAt).toBe("2026-05-12T12:00:00.000Z");
    expect(quote.expiresAt).toBe("2026-05-12T12:20:00.000Z");
  });

  it("refuses quotes from an oracle price older than five minutes", async () => {
    const { db } = createMemoryDb();
    const stalePrice = {
      ...freshPrimary,
      lastUpdatedAt: Math.floor((now.getTime() - MANAGED_VENICE_PRICE_MAX_AGE_MS - 1000) / 1000),
    };

    await expect(
      createManagedVeniceTokenQuote(
        {
          userId: "user_1",
          tokenAmountRaw,
          depositAddress: "0xmanagedvenice",
          now,
          priceQuote: stalePrice,
          crossCheckQuote: freshCrossCheck,
        },
        db
      )
    ).rejects.toBeInstanceOf(ManagedVeniceTokenQuotePriceError);
  });

  it("refuses quotes when primary and cross-check prices disagree by more than 5%", async () => {
    const { db } = createMemoryDb();

    await expect(
      createManagedVeniceTokenQuote(
        {
          userId: "user_1",
          tokenAmountRaw,
          depositAddress: "0xmanagedvenice",
          now,
          priceQuote: freshPrimary,
          crossCheckQuote: { ...freshCrossCheck, priceUsd: "0.053" },
        },
        db
      )
    ).rejects.toBeInstanceOf(ManagedVeniceTokenQuotePriceError);

    expect(MANAGED_VENICE_PRICE_MAX_DISAGREEMENT_BPS).toBe(500);
  });

  it("creates quotes from the DEXScreener Hivra price while the cross-check source is not live", async () => {
    const { db } = createMemoryDb();

    const quote = await createManagedVeniceTokenQuote(
      {
        userId: "user_1",
        tokenAmountRaw,
        depositAddress: "0xmanagedvenice",
        now,
        priceQuote: freshPrimary,
        crossCheckQuote: null,
      },
      db
    );

    expect(quote.source).toBe("dexscreener");
    expect(quote.crossCheckSource).toBeNull();
    expect(quote.snapshotPriceUsd).toBe("0.05");
  });

  it("converts the deposited token amount into a locked microdollar credit value", async () => {
    const { db } = createMemoryDb();

    expect(
      calculateManagedVeniceLockedValueMicroUsd({
        tokenAmountRaw,
        priceUsdPerToken: "0.05",
        tokenDecimals: 18,
      })
    ).toBe(50_000_000);

    const quote = await createManagedVeniceTokenQuote(
      {
        userId: "user_1",
        tokenAmountRaw,
        depositAddress: "0xmanagedvenice",
        now,
        priceQuote: freshPrimary,
        crossCheckQuote: freshCrossCheck,
      },
      db
    );

    expect(quote.lockedValueMicroUsd).toBe(50_000_000);
    expect(quote.paidValueMicroUsd).toBe(50_000_000);
    expect(quote.creditValueMicroUsd).toBe(50_000_000);
    expect(quote.bonusValueMicroUsd).toBe(0);
    expect(quote.tokenAmountRaw).toBe(tokenAmountRaw);
    expect(quote.snapshotPriceUsd).toBe("0.05");
  });

  it("calculates the token amount needed for a desired USD top-up", async () => {
    expect(
      calculateManagedVeniceTokenAmountRawForUsd({
        targetMicroUsd: 50_000_000,
        priceUsdPerToken: "0.05",
        tokenDecimals: 18,
      })
    ).toBe(tokenAmountRaw);

    const { db } = createMemoryDb();
    const quote = await createManagedVeniceTokenQuoteForUsdTarget(
      {
        userId: "user_1",
        targetMicroUsd: 50_000_000,
        depositAddress: "0xmanagedvenice",
        now,
        priceQuote: freshPrimary,
        crossCheckQuote: freshCrossCheck,
      },
      db
    );

    expect(quote.tokenAmountRaw).toBe(tokenAmountRaw);
    expect(quote.lockedValueMicroUsd).toBe(50_000_000);
    expect(quote.paidValueMicroUsd).toBe(50_000_000);
    expect(quote.creditValueMicroUsd).toBe(60_000_000);
    expect(quote.bonusValueMicroUsd).toBe(10_000_000);
    expect(quote.launchBonusMicroUsd).toBe(10_000_000);
    expect(quote.standardBonusMicroUsd).toBe(0);
  });

  it("blocks a top-up that would push a user past the hidden per-user lifetime bonus cap", async () => {
    const { db, insertRow } = createMemoryDb();
    // Seed the user just under the hidden cap. One penny of bonus room
    // left — a $50 top-up would earn $5 in launch bonus, far over.
    insertRow("managed_venice_financial_events", {
      user_id: "user_1",
      event_type: "subsidy_applied",
      discount_micro_usd: MANAGED_VENICE_HIDDEN_USER_BONUS_CAP_MICRO_USD - 10_000,
      metadata: { rate: "launch_20" },
      created_at: "2026-05-01T00:00:00.000Z",
    });

    await expect(
      createManagedVeniceTokenQuoteForUsdTarget(
        {
          userId: "user_1",
          targetMicroUsd: 50_000_000,
          depositAddress: "0xmanagedvenice",
          now,
          priceQuote: freshPrimary,
          crossCheckQuote: freshCrossCheck,
        },
        db,
      ),
    ).rejects.toBeInstanceOf(ManagedVeniceTopUpExceedsHiddenCapError);
  });

  it("rounds USD-targeted top-ups up to a whole token amount", () => {
    expect(
      calculateManagedVeniceTokenAmountRawForUsd({
        targetMicroUsd: 10_000_000,
        priceUsdPerToken: "0.000009988",
        tokenDecimals: 18,
      })
    ).toBe("1001202000000000000000000");
  });

  it("calculates a USD-targeted $HermesOS top-up using the DEXScreener price without a cross-check quote", async () => {
    const { db } = createMemoryDb();

    const quote = await createManagedVeniceTokenQuoteForUsdTarget(
      {
        userId: "user_1",
        targetMicroUsd: 10_000_000,
        depositAddress: "0xmanagedvenice",
        now,
        priceQuote: freshPrimary,
        crossCheckQuote: null,
      },
      db
    );

    expect(quote.source).toBe("dexscreener");
    expect(quote.crossCheckSource).toBeNull();
    expect(quote.paidValueMicroUsd).toBe(10_000_000);
    expect(quote.creditValueMicroUsd).toBe(12_000_000);
    expect(quote.bonusValueMicroUsd).toBe(2_000_000);
  });

  it("marks late confirmations for manual review instead of creating spendable credit", async () => {
    const { db, tables } = createMemoryDb();
    const quote = await createManagedVeniceTokenQuote(
      {
        userId: "user_1",
        tokenAmountRaw,
        depositAddress: "0xmanagedvenice",
        now,
        priceQuote: freshPrimary,
        crossCheckQuote: freshCrossCheck,
      },
      db
    );

    const result = await settleManagedVeniceTokenQuote(
      {
        quoteId: quote.id,
        transactionHash: "0xlate",
        tokenAmountRaw,
        observedAt: "2026-05-12T12:21:00.000Z",
      },
      db
    );

    expect(result.status).toBe("manual_review_required");
    expect(tables.managed_venice_token_lots).toHaveLength(0);
    expect(tables.managed_venice_reconciliation_items).toContainEqual(
      expect.objectContaining({
        user_id: "user_1",
        reason: "managed_venice_token_deposit_outside_quote_window",
      })
    );
  });

  it("settles legacy one-minute quotes when the exact transfer arrived inside the 20-minute window", async () => {
    const { db, tables } = createMemoryDb();
    const quote = await createManagedVeniceTokenQuote(
      {
        userId: "user_1",
        tokenAmountRaw,
        depositAddress: "0xmanagedvenice",
        now,
        priceQuote: freshPrimary,
        crossCheckQuote: freshCrossCheck,
      },
      db
    );
    tables.managed_venice_token_quotes[0].expires_at = "2026-05-12T12:01:00.000Z";
    tables.managed_venice_token_quotes[0].status = "expired";

    const result = await settleManagedVeniceTokenQuote(
      {
        quoteId: quote.id,
        transactionHash: "0xlegacy",
        tokenAmountRaw,
        observedAt: "2026-05-12T12:03:00.000Z",
      },
      db
    );

    expect(result.status).toBe("settled");
    expect(tables.managed_venice_token_lots).toContainEqual(
      expect.objectContaining({
        quote_id: quote.id,
        transaction_hash: "0xlegacy",
      })
    );
  });

  it("settles an in-window confirmation into a FIFO token lot and immutable financial event", async () => {
    const { db, tables } = createMemoryDb();
    const quote = await createManagedVeniceTokenQuote(
      {
        userId: "user_1",
        tokenAmountRaw,
        depositAddress: "0xmanagedvenice",
        now,
        priceQuote: freshPrimary,
        crossCheckQuote: freshCrossCheck,
      },
      db
    );

    const result = await settleManagedVeniceTokenQuote(
      {
        quoteId: quote.id,
        transactionHash: "0xinwindow",
        tokenAmountRaw,
        observedAt: "2026-05-12T12:00:30.000Z",
      },
      db
    );

    expect(result.status).toBe("settled");
    expect(tables.managed_venice_token_lots).toContainEqual(
      expect.objectContaining({
        quote_id: quote.id,
        user_id: "user_1",
        token_amount_raw: tokenAmountRaw,
        remaining_token_amount_raw: tokenAmountRaw,
        original_value_micro_usd: 50_000_000,
        remaining_value_micro_usd: 50_000_000,
        transaction_hash: "0xinwindow",
        status: "active",
      })
    );
    expect(tables.managed_venice_financial_events).toContainEqual(
      expect.objectContaining({
        user_id: "user_1",
        wallet_type: "hermesos",
        event_type: "token_deposit",
        reference_id: quote.id,
        idempotency_key: `managed_venice_token_deposit:${quote.id}:0xinwindow`,
        token_amount_raw: tokenAmountRaw,
        amount_micro_usd: 50_000_000,
      })
    );
  });

  it("treats replayed settlement callbacks for the same quote and tx as idempotent", async () => {
    const { db, tables } = createMemoryDb();
    const quote = await createManagedVeniceTokenQuote(
      {
        userId: "user_1",
        tokenAmountRaw,
        depositAddress: "0xmanagedvenice",
        now,
        priceQuote: freshPrimary,
        crossCheckQuote: freshCrossCheck,
      },
      db
    );

    await settleManagedVeniceTokenQuote(
      {
        quoteId: quote.id,
        transactionHash: "0xreplayed",
        tokenAmountRaw,
        observedAt: "2026-05-12T12:00:30.000Z",
      },
      db
    );
    const replay = await settleManagedVeniceTokenQuote(
      {
        quoteId: quote.id,
        transactionHash: "0xreplayed",
        tokenAmountRaw,
        observedAt: "2026-05-12T12:00:31.000Z",
      },
      db
    );

    expect(replay).toEqual({
      status: "settled",
      quoteId: quote.id,
      idempotent: true,
    });
    expect(tables.managed_venice_token_lots).toHaveLength(1);
    expect(
      tables.managed_venice_financial_events.filter(
        (event) => event.event_type === "token_deposit"
      )
    ).toHaveLength(1);
    expect(tables.managed_venice_reconciliation_items).toHaveLength(0);
  });

  it("does not create a second spendable lot when a prior settlement left the quote stuck at active", async () => {
    const { db, tables } = createMemoryDb();
    const quote = await createManagedVeniceTokenQuote(
      {
        userId: "user_1",
        tokenAmountRaw,
        depositAddress: "0xmanagedvenice",
        now,
        priceQuote: freshPrimary,
        crossCheckQuote: freshCrossCheck,
      },
      db
    );

    // First settlement creates the lot + financial event.
    await settleManagedVeniceTokenQuote(
      {
        quoteId: quote.id,
        transactionHash: "0xfirst",
        tokenAmountRaw,
        observedAt: "2026-05-12T12:00:30.000Z",
      },
      db
    );
    expect(tables.managed_venice_token_lots).toHaveLength(1);

    // Simulate the partial-failure window the fix targets: the lot/event
    // persisted but the final quote-status flip never did, so the quote is
    // still `active`. The reconciler re-observes the deposit and settles
    // again — here with a DIFFERENT tx hash, the case the per-tx
    // idempotency_key would NOT have caught, which previously inserted a
    // second spendable lot (double credit).
    const stuckQuote = tables.managed_venice_token_quotes.find(
      (row) => row.id === quote.id
    )!;
    stuckQuote.status = "active";
    stuckQuote.settled_at = null;
    stuckQuote.transaction_hash = null;

    const retry = await settleManagedVeniceTokenQuote(
      {
        quoteId: quote.id,
        transactionHash: "0xsecond",
        tokenAmountRaw,
        observedAt: "2026-05-12T12:00:45.000Z",
      },
      db
    );

    // No second lot => no double credit. The quote converges to settled ON
    // THE LOT'S TX (0xfirst): the retry's different tx is never recorded as the
    // settlement, never gets its own deposit event, and is surfaced once for
    // review instead of being silently absorbed.
    const settledQuote = tables.managed_venice_token_quotes.find((row) => row.id === quote.id)!;
    expect(tables.managed_venice_token_lots).toHaveLength(1);
    expect(retry.status).toBe("settled");
    expect(settledQuote.status).toBe("settled");
    expect(settledQuote.transaction_hash).toBe(tables.managed_venice_token_lots[0].transaction_hash);
    expect(settledQuote.transaction_hash).toBe("0xfirst");
    expect(
      tables.managed_venice_financial_events
        .filter((event) => event.event_type === "token_deposit")
        .map((event) => event.idempotency_key)
    ).toEqual([`managed_venice_token_deposit:${quote.id}:0xfirst`]);
    expect(
      tables.managed_venice_financial_events.filter((event) => event.event_type === "subsidy_applied")
    ).toHaveLength(0);
    expect(tables.managed_venice_reconciliation_items).toEqual([
      expect.objectContaining({
        reason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.extraTransfer,
        dedupe_key: managedVeniceTokenTransferDedupeKey("0xsecond", null),
      }),
    ]);
  });

  it("settles a USD-targeted $HermesOS top-up with bonus credits and subsidy accounting", async () => {
    const { db, tables } = createMemoryDb();
    const quote = await createManagedVeniceTokenQuoteForUsdTarget(
      {
        userId: "user_1",
        targetMicroUsd: 50_000_000,
        depositAddress: "0xmanagedvenice",
        now,
        priceQuote: freshPrimary,
        crossCheckQuote: freshCrossCheck,
      },
      db
    );

    const result = await settleManagedVeniceTokenQuote(
      {
        quoteId: quote.id,
        transactionHash: "0xbonus",
        tokenAmountRaw,
        observedAt: "2026-05-12T12:00:30.000Z",
      },
      db
    );

    expect(result.status).toBe("settled");
    expect(tables.managed_venice_token_lots).toContainEqual(
      expect.objectContaining({
        quote_id: quote.id,
        original_value_micro_usd: 60_000_000,
        remaining_value_micro_usd: 60_000_000,
        metadata: expect.objectContaining({
          paidValueMicroUsd: 50_000_000,
          creditValueMicroUsd: 60_000_000,
          bonusValueMicroUsd: 10_000_000,
        }),
      })
    );
    expect(tables.managed_venice_financial_events).toContainEqual(
      expect.objectContaining({
        event_type: "token_deposit",
        amount_micro_usd: 50_000_000,
      })
    );
    expect(tables.managed_venice_financial_events).toContainEqual(
      expect.objectContaining({
        event_type: "subsidy_applied",
        discount_micro_usd: 10_000_000,
        metadata: expect.objectContaining({
          source: "managed_venice_deposit_bonus",
          launchSubsidyMicroUsd: 10_000_000,
          standardSubsidyMicroUsd: 0,
        }),
      })
    );
  });

  it("credits an over-send for the ACTUAL received amount instead of dead-ending at manual review", async () => {
    const { db, tables } = createMemoryDb();
    const quote = await createManagedVeniceTokenQuote(
      {
        userId: "user_1",
        tokenAmountRaw, // 1000 tokens @ $0.05 => $50 paid, $50 credit, no bonus
        depositAddress: "0xmanagedvenice",
        now,
        priceQuote: freshPrimary,
        crossCheckQuote: freshCrossCheck,
      },
      db
    );

    // User over-sends 10% more than quoted (1100 tokens vs 1000 quoted) —
    // real funds, comfortably inside the over-send ceiling.
    const overSentTokenAmountRaw = "1100000000000000000000";
    const result = await settleManagedVeniceTokenQuote(
      {
        quoteId: quote.id,
        transactionHash: "0xoversend",
        tokenAmountRaw: overSentTokenAmountRaw,
        observedAt: "2026-05-12T12:00:30.000Z",
      },
      db
    );

    expect(result.status).toBe("settled");
    // No reconciliation item — the over-send is auto-credited, not dead-ended.
    expect(tables.managed_venice_reconciliation_items).toHaveLength(0);
    // The lot holds the ACTUAL received tokens and the pro-rata paid value
    // ($55 = $50 * 1100/1000). Bonus stays as quoted (0 here).
    expect(tables.managed_venice_token_lots).toContainEqual(
      expect.objectContaining({
        quote_id: quote.id,
        token_amount_raw: overSentTokenAmountRaw,
        remaining_token_amount_raw: overSentTokenAmountRaw,
        original_value_micro_usd: 55_000_000,
        remaining_value_micro_usd: 55_000_000,
        metadata: expect.objectContaining({
          overSend: true,
          quotedTokenAmountRaw: tokenAmountRaw,
          observedTokenAmountRaw: overSentTokenAmountRaw,
          paidValueMicroUsd: 55_000_000,
          creditValueMicroUsd: 55_000_000,
          bonusValueMicroUsd: 0,
        }),
      })
    );
    expect(tables.managed_venice_financial_events).toContainEqual(
      expect.objectContaining({
        event_type: "token_deposit",
        token_amount_raw: overSentTokenAmountRaw,
        amount_micro_usd: 55_000_000,
      })
    );
  });

  it("does NOT scale the deposit bonus up on an over-send (stays cap-safe at the quoted bonus)", async () => {
    const { db, tables } = createMemoryDb();
    const quote = await createManagedVeniceTokenQuoteForUsdTarget(
      {
        userId: "user_1",
        targetMicroUsd: 50_000_000, // $50 paid => $10 launch bonus => $60 credit
        depositAddress: "0xmanagedvenice",
        now,
        priceQuote: freshPrimary,
        crossCheckQuote: freshCrossCheck,
      },
      db
    );

    // 10% over-send: paid scales to $55, bonus stays $10 => $65 credit.
    const result = await settleManagedVeniceTokenQuote(
      {
        quoteId: quote.id,
        transactionHash: "0xoversendbonus",
        tokenAmountRaw: "1100000000000000000000",
        observedAt: "2026-05-12T12:00:30.000Z",
      },
      db
    );

    expect(result.status).toBe("settled");
    expect(tables.managed_venice_token_lots).toContainEqual(
      expect.objectContaining({
        quote_id: quote.id,
        original_value_micro_usd: 65_000_000,
        metadata: expect.objectContaining({
          paidValueMicroUsd: 55_000_000,
          bonusValueMicroUsd: 10_000_000,
          creditValueMicroUsd: 65_000_000,
        }),
      })
    );
    // Subsidy event still records ONLY the quoted bonus, not a scaled-up one.
    expect(tables.managed_venice_financial_events).toContainEqual(
      expect.objectContaining({
        event_type: "subsidy_applied",
        discount_micro_usd: 10_000_000,
      })
    );
  });

  it("routes an UNDER-payment to manual review instead of crediting partial funds", async () => {
    const { db, tables } = createMemoryDb();
    const quote = await createManagedVeniceTokenQuote(
      {
        userId: "user_1",
        tokenAmountRaw,
        depositAddress: "0xmanagedvenice",
        now,
        priceQuote: freshPrimary,
        crossCheckQuote: freshCrossCheck,
      },
      db
    );

    // 10% short of the quote.
    const result = await settleManagedVeniceTokenQuote(
      {
        quoteId: quote.id,
        transactionHash: "0xunderpay",
        tokenAmountRaw: "900000000000000000000",
        observedAt: "2026-05-12T12:00:30.000Z",
      },
      db
    );

    expect(result.status).toBe("manual_review_required");
    expect(tables.managed_venice_token_lots).toHaveLength(0);
    expect(tables.managed_venice_reconciliation_items).toContainEqual(
      expect.objectContaining({
        user_id: "user_1",
        reason: "managed_venice_token_deposit_underpaid",
      })
    );
  });

  it("routes a wildly-over deposit (beyond the 2x ceiling) to manual review", async () => {
    const { db, tables } = createMemoryDb();
    const quote = await createManagedVeniceTokenQuote(
      {
        userId: "user_1",
        tokenAmountRaw, // 1000 tokens quoted
        depositAddress: "0xmanagedvenice",
        now,
        priceQuote: freshPrimary,
        crossCheckQuote: freshCrossCheck,
      },
      db
    );

    // ~3x the quoted amount — a fat-finger, not a benign over-send.
    const result = await settleManagedVeniceTokenQuote(
      {
        quoteId: quote.id,
        transactionHash: "0xfatfinger",
        tokenAmountRaw: "3000000000000000000000",
        observedAt: "2026-05-12T12:00:30.000Z",
      },
      db
    );

    expect(result.status).toBe("manual_review_required");
    expect(tables.managed_venice_token_lots).toHaveLength(0);
    expect(tables.managed_venice_reconciliation_items).toContainEqual(
      expect.objectContaining({
        user_id: "user_1",
        reason: "managed_venice_token_deposit_amount_mismatch",
      })
    );
  });

  it("treats a redelivery of an accepted over-send as idempotent (no spurious replay item)", async () => {
    const { db, tables } = createMemoryDb();
    const quote = await createManagedVeniceTokenQuote(
      {
        userId: "user_1",
        tokenAmountRaw,
        depositAddress: "0xmanagedvenice",
        now,
        priceQuote: freshPrimary,
        crossCheckQuote: freshCrossCheck,
      },
      db
    );

    const overSentTokenAmountRaw = "1100000000000000000000";
    await settleManagedVeniceTokenQuote(
      {
        quoteId: quote.id,
        transactionHash: "0xoversend",
        tokenAmountRaw: overSentTokenAmountRaw,
        observedAt: "2026-05-12T12:00:30.000Z",
      },
      db
    );
    const replay = await settleManagedVeniceTokenQuote(
      {
        quoteId: quote.id,
        transactionHash: "0xoversend",
        tokenAmountRaw: overSentTokenAmountRaw,
        observedAt: "2026-05-12T12:00:31.000Z",
      },
      db
    );

    expect(replay).toEqual({
      status: "settled",
      quoteId: quote.id,
      idempotent: true,
    });
    expect(tables.managed_venice_token_lots).toHaveLength(1);
    expect(tables.managed_venice_reconciliation_items).toHaveLength(0);
  });
});
