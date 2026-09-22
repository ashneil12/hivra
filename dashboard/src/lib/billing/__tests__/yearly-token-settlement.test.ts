/** @jest-environment node */
/**
 * Transfer attribution and settlement for yearly $HermesOS quotes, against an
 * in-memory Supabase (production unique indexes + the settlement function's
 * contract) and a Base chain fake.
 */

const mockReportOpsEvent = jest.fn();
jest.mock("@/lib/ops-events", () => ({
  ...jest.requireActual("@/lib/ops-events"),
  reportOpsEvent: (...args: unknown[]) => mockReportOpsEvent(...args),
}));

import {
  reconcilePendingYearlyTokenQuotes,
  reconcileYearlyTokenQuote,
  yearlyTransferDedupeKey,
} from "@/lib/billing/yearly-token-settlement";
import { asYearlyTokenQuote, type YearlyQuoteRow } from "@/lib/billing/yearly-token-quotes";
import {
  managedVeniceQuoteRow,
  TEST_DEPOSIT_ADDRESS,
  txHash,
  yearlyQuoteRow,
  yearlySubscriptionRow,
} from "@/test-utils/yearly-token-memory-db";
import { createYearlyTokenWorld, HOUR_MS, MINUTE_MS, type YearlyTokenWorld } from "@/test-utils/yearly-token-world";

const REQUIRED = 1_000n * 10n ** 18n;
const noDelay = async () => {};

function openQuote(world: YearlyTokenWorld, overrides: Record<string, unknown> = {}) {
  return world.memory.insertRow(
    "yearly_token_quotes",
    yearlyQuoteRow({
      tokens_required_raw: REQUIRED.toString(),
      quoted_at: world.at(-10 * MINUTE_MS),
      expires_at: world.at(10 * MINUTE_MS),
      ...overrides,
    })
  );
}

function reconcile(world: YearlyTokenWorld, quoteId = "yq_1", options: { minConfirmations?: number } = {}) {
  const row = world.quote(quoteId) as unknown as YearlyQuoteRow;
  return reconcileYearlyTokenQuote({
    quote: asYearlyTokenQuote(row),
    db: world.memory.db,
    fetchImpl: world.chain.fetchImpl,
    now: new Date(world.nowMs),
    ...options,
  });
}

beforeEach(() => {
  mockReportOpsEvent.mockReset();
});

describe("settlement", () => {
  it("binds the earliest qualifying transfer, surfaces the later one once, and stamps the conversion write-once", async () => {
    const world = createYearlyTokenWorld();
    world.memory.insertRow("hermes_subscriptions", { user_id: "user_1", upgraded_at: null });
    openQuote(world);
    world.pay({ tx: txHash(1), amountRaw: REQUIRED, offsetMs: -6 * MINUTE_MS });
    world.pay({ tx: txHash(2), amountRaw: REQUIRED, offsetMs: -4 * MINUTE_MS });

    const first = await reconcile(world);
    expect(first).toMatchObject({ status: "activated", transactionHash: txHash(1), amountReceivedRaw: REQUIRED.toString() });
    expect(world.items()).toEqual([
      expect.objectContaining({
        reason: "extra_transfer",
        transaction_hash: txHash(2),
        subscription_id: first.subscriptionId,
        dedupe_key: yearlyTransferDedupeKey({ transactionHash: txHash(2), logIndex: 0 }),
      }),
    ]);
    expect(world.memory.tables.hermes_subscriptions[0]).toMatchObject({ upgrade_source: "token_payment" });
    const stampedAt = world.memory.tables.hermes_subscriptions[0].upgraded_at;
    expect(mockReportOpsEvent).toHaveBeenCalledTimes(1);

    // A later renewal keeps the original conversion timestamp.
    openQuote(world, { id: "yq_2", quoted_at: world.at(-2 * MINUTE_MS), expires_at: world.at(18 * MINUTE_MS) });
    world.pay({ tx: txHash(3), amountRaw: REQUIRED, offsetMs: -1 * MINUTE_MS });
    expect(await reconcile(world, "yq_2")).toMatchObject({ status: "renewed" });
    expect(world.memory.tables.hermes_subscriptions[0].upgraded_at).toBe(stampedAt);
  });

  it("accepts an over-send up to twice the quote and records what was actually received", async () => {
    const world = createYearlyTokenWorld();
    openQuote(world);
    world.pay({ tx: txHash(1), amountRaw: REQUIRED * 2n, offsetMs: -5 * MINUTE_MS });

    expect(await reconcile(world)).toMatchObject({ status: "activated" });
    expect(world.subscriptions()[0]).toMatchObject({ amount_received_raw: (REQUIRED * 2n).toString() });
  });

  it("surfaces a payment above twice the quote without activating, and keeps the quote payable while its window is open", async () => {
    const world = createYearlyTokenWorld();
    openQuote(world);
    world.pay({ tx: txHash(1), amountRaw: REQUIRED * 2n + 1n, offsetMs: -8 * MINUTE_MS });

    expect(await reconcile(world)).toMatchObject({ status: "no_match" });
    expect(world.subscriptions()).toHaveLength(0);
    expect(world.items()).toEqual([expect.objectContaining({ reason: "overpaid", transaction_hash: txHash(1) })]);
    expect(world.quote("yq_1")).toMatchObject({ status: "active" });

    // The user then sends the right amount inside the window: it settles.
    world.pay({ tx: txHash(2), amountRaw: REQUIRED, offsetMs: -2 * MINUTE_MS });
    expect(await reconcile(world)).toMatchObject({ status: "activated", transactionHash: txHash(2) });
    expect(world.items()).toHaveLength(1);
  });

  it("sends an over-paid quote to review once its window has closed", async () => {
    const world = createYearlyTokenWorld();
    openQuote(world, { quoted_at: world.at(-40 * MINUTE_MS), expires_at: world.at(-20 * MINUTE_MS), status: "expired" });
    world.pay({ tx: txHash(1), amountRaw: REQUIRED * 3n, offsetMs: -30 * MINUTE_MS });

    expect(await reconcile(world)).toMatchObject({ status: "manual_review", reason: "overpaid" });
    expect(world.items()).toEqual([expect.objectContaining({ reason: "overpaid" })]);
    expect(world.quote("yq_1")).toMatchObject({ status: "manual_review", attribution_closed_at: null });
  });

  it("waits for confirmations on the candidate instead of skipping to a later transfer", async () => {
    const world = createYearlyTokenWorld();
    openQuote(world);
    world.chain.addTransfer({ txHash: txHash(1), amountRaw: REQUIRED, block: world.chain.latestBlock() - 1, to: TEST_DEPOSIT_ADDRESS });

    expect(await reconcile(world)).toMatchObject({ status: "underconfirmed", confirmations: 2 });
    expect(world.subscriptions()).toHaveLength(0);

    world.chain.setLatestBlock(world.chain.latestBlock() + 1);
    expect(await reconcile(world)).toMatchObject({ status: "activated", transactionHash: txHash(1) });
  });

  it("keeps an in-window under-payment open until the window closes", async () => {
    const world = createYearlyTokenWorld();
    openQuote(world);
    world.pay({ tx: txHash(1), amountRaw: REQUIRED - 1n, offsetMs: -5 * MINUTE_MS });

    expect(await reconcile(world)).toMatchObject({ status: "no_match" });
    expect(world.items()).toHaveLength(0);
    expect(world.quote("yq_1")).toMatchObject({ status: "active" });
  });

  it("ignores zero-value transfers (address-poisoning spam) and self-transfers", async () => {
    const world = createYearlyTokenWorld();
    openQuote(world, { quoted_at: world.at(-3 * HOUR_MS), expires_at: world.at(-3 * HOUR_MS + 20 * MINUTE_MS), status: "expired" });
    world.pay({ tx: txHash(1), amountRaw: 0n, offsetMs: -3 * HOUR_MS + 5 * MINUTE_MS });
    world.chain.addTransfer({
      txHash: txHash(2),
      amountRaw: REQUIRED,
      block: world.blockAt(-3 * HOUR_MS + 6 * MINUTE_MS),
      from: TEST_DEPOSIT_ADDRESS,
      to: TEST_DEPOSIT_ADDRESS,
    });

    expect(await reconcile(world)).toMatchObject({ status: "cancelled" });
    expect(world.items()).toHaveLength(0);
  });

  it("scans a long late-payment range in chunks the public RPC accepts", async () => {
    const world = createYearlyTokenWorld();
    openQuote(world, { quoted_at: world.at(-3 * HOUR_MS), expires_at: world.at(-3 * HOUR_MS + 20 * MINUTE_MS), status: "expired" });
    world.pay({ tx: txHash(1), amountRaw: REQUIRED, offsetMs: -3 * HOUR_MS + 19 * MINUTE_MS });

    expect(await reconcile(world)).toMatchObject({ status: "activated" });
    // 2h20m of 2 s blocks = 4,200 blocks => at least three eth_getLogs chunks.
    expect(world.chain.methodCount("eth_getLogs")).toBeGreaterThanOrEqual(3);
  });
});

describe("attribution on the shared wallet", () => {
  it("leaves a transfer after the user's next payment session to that session", async () => {
    const world = createYearlyTokenWorld();
    openQuote(world, { quoted_at: world.at(-60 * MINUTE_MS), expires_at: world.at(-40 * MINUTE_MS), status: "expired" });
    // The user opened a managed-Venice quote on the same wallet after this one.
    world.memory.insertRow(
      "managed_venice_token_quotes",
      managedVeniceQuoteRow({ quoted_at: world.at(-30 * MINUTE_MS), expires_at: world.at(-10 * MINUTE_MS), status: "expired" })
    );
    world.pay({ tx: txHash(1), amountRaw: REQUIRED, offsetMs: -25 * MINUTE_MS });

    const result = await reconcile(world);

    expect(result.status).toBe("cancelled");
    expect(world.items()).toHaveLength(0);
    expect(world.subscriptions()).toHaveLength(0);
  });

  it("does not re-attribute a transfer another yearly quote already consumed", async () => {
    const world = createYearlyTokenWorld();
    openQuote(world, { quoted_at: world.at(-30 * MINUTE_MS), expires_at: world.at(-10 * MINUTE_MS), status: "expired" });
    world.memory.insertRow(
      "yearly_token_quotes",
      yearlyQuoteRow({ id: "yq_power", tier: "power", status: "consumed", consumed_tx_hash: txHash(1), quoted_at: world.at(-2 * HOUR_MS) })
    );
    world.pay({ tx: txHash(1), amountRaw: REQUIRED, offsetMs: -20 * MINUTE_MS });

    expect(await reconcile(world)).toMatchObject({ status: "no_match" });
    expect(world.subscriptions()).toHaveLength(0);
  });

  it("surfaces a late out-of-band transfer without closing the quote, then retires it", async () => {
    const world = createYearlyTokenWorld();
    openQuote(world, { quoted_at: world.at(-60 * MINUTE_MS), expires_at: world.at(-40 * MINUTE_MS), status: "expired" });
    world.pay({ tx: txHash(1), amountRaw: REQUIRED / 10n, offsetMs: -30 * MINUTE_MS });

    expect(await reconcile(world)).toMatchObject({ status: "no_match" });
    expect(world.items()).toEqual([expect.objectContaining({ reason: "unattributed_late_transfer" })]);
    expect(world.quote("yq_1")).toMatchObject({ status: "expired" });
  });

  it("sends a quote the pre-attribution flow half-activated to an operator instead of granting another year", async () => {
    const world = createYearlyTokenWorld();
    openQuote(world);
    world.memory.insertRow("yearly_token_subscriptions", yearlySubscriptionRow({ yearly_quote_id: "yq_1" }));
    world.pay({ tx: txHash(1), amountRaw: REQUIRED, offsetMs: -5 * MINUTE_MS });

    expect(await reconcile(world)).toMatchObject({ status: "manual_review", reason: "legacy_subscription_exists" });
    expect(world.subscriptions()).toHaveLength(1);
    expect(world.items()).toEqual([expect.objectContaining({ reason: "legacy_subscription_exists" })]);
    expect(world.quote("yq_1")).toMatchObject({ status: "manual_review" });
  });

  it("reports a claim another flow won between the scan and the settlement", async () => {
    const world = createYearlyTokenWorld();
    openQuote(world);
    world.pay({ tx: txHash(1), amountRaw: REQUIRED, offsetMs: -5 * MINUTE_MS });
    // A managed-Venice settlement binds the tx after our bound-hash read but
    // before the yearly claim runs.
    const originalRpc = world.memory.db.rpc;
    world.memory.db.rpc = (name, args) => {
      world.memory.insertRow("managed_venice_token_quotes", managedVeniceQuoteRow({ transaction_hash: txHash(1) }));
      return originalRpc(name, args);
    };

    expect(await reconcile(world)).toMatchObject({ status: "transaction_already_claimed" });
    expect(world.subscriptions()).toHaveLength(0);
    expect(world.quote("yq_1")).toMatchObject({ status: "active", consumed_tx_hash: null });
  });
});

describe("batch", () => {
  it("reconciles newest quotes first and keeps going past a failing quote", async () => {
    const world = createYearlyTokenWorld();
    openQuote(world, { id: "yq_old", user_id: "user_old", deposit_address: "0xbad", quoted_at: world.at(-50 * MINUTE_MS), expires_at: world.at(-30 * MINUTE_MS), status: "expired" });
    openQuote(world);
    world.pay({ tx: txHash(1), amountRaw: REQUIRED, offsetMs: -5 * MINUTE_MS });

    const summary = await reconcilePendingYearlyTokenQuotes({
      db: world.memory.db,
      fetchImpl: world.chain.fetchImpl,
      now: new Date(world.nowMs),
      rpcSleepImpl: noDelay,
    });

    expect(summary.results.map((result) => result.quoteId)).toEqual(["yq_1", "yq_old"]);
    expect(summary).toMatchObject({ checked: 2, activated: 1, failed: 1 });
  });

  it("scopes to one user and tier", async () => {
    const world = createYearlyTokenWorld();
    openQuote(world, { id: "yq_other", user_id: "user_other" });
    openQuote(world, { id: "yq_power", tier: "power", quoted_at: world.at(-9 * MINUTE_MS) });

    const summary = await reconcilePendingYearlyTokenQuotes({
      db: world.memory.db,
      fetchImpl: world.chain.fetchImpl,
      now: new Date(world.nowMs),
      userId: "user_1",
      tier: "pro",
      rpcSleepImpl: noDelay,
    });

    expect(summary.checked).toBe(0);
  });
});

describe("a quote's range stays watched after it settles or goes to review", () => {
  function runBatch(world: YearlyTokenWorld) {
    return reconcilePendingYearlyTokenQuotes({
      db: world.memory.db,
      fetchImpl: world.chain.fetchImpl,
      now: new Date(world.nowMs),
      rpcSleepImpl: noDelay,
    });
  }

  it("surfaces a second transfer that was still unconfirmed when the first one settled", async () => {
    const world = createYearlyTokenWorld();
    openQuote(world);
    world.pay({ tx: txHash(1), amountRaw: REQUIRED, offsetMs: -5 * MINUTE_MS });
    world.chain.addTransfer({ txHash: txHash(2), amountRaw: REQUIRED, block: world.chain.latestBlock(), to: TEST_DEPOSIT_ADDRESS });

    expect(await reconcile(world)).toMatchObject({ status: "activated", transactionHash: txHash(1) });
    expect(world.items()).toHaveLength(0);

    world.chain.setLatestBlock(world.chain.latestBlock() + 10);
    const summary = await runBatch(world);

    expect(summary.results).toEqual([expect.objectContaining({ quoteId: "yq_1", status: "watching" })]);
    expect(world.items()).toEqual([
      expect.objectContaining({
        reason: "extra_transfer",
        transaction_hash: txHash(2),
        subscription_id: world.subscriptions()[0].id,
      }),
    ]);
  });

  it("surfaces a duplicate payment sent after the quote already settled", async () => {
    const world = createYearlyTokenWorld();
    openQuote(world);
    world.pay({ tx: txHash(1), amountRaw: REQUIRED, offsetMs: -6 * MINUTE_MS });
    await reconcile(world);
    world.pay({ tx: txHash(2), amountRaw: REQUIRED, offsetMs: -2 * MINUTE_MS });

    await runBatch(world);

    expect(world.items()).toEqual([expect.objectContaining({ reason: "extra_transfer", transaction_hash: txHash(2) })]);
  });

  it("surfaces a top-up sent in the late grace after an under-payment went to review", async () => {
    const world = createYearlyTokenWorld();
    openQuote(world, { quoted_at: world.at(-50 * MINUTE_MS), expires_at: world.at(-30 * MINUTE_MS), status: "expired" });
    world.pay({ tx: txHash(1), amountRaw: REQUIRED / 2n, offsetMs: -40 * MINUTE_MS });
    expect(await reconcile(world)).toMatchObject({ status: "manual_review", reason: "underpaid" });

    world.pay({ tx: txHash(2), amountRaw: REQUIRED / 2n, offsetMs: -10 * MINUTE_MS });
    await runBatch(world);

    expect(world.items().map((item) => [item.reason, item.transaction_hash])).toEqual([
      ["underpaid", txHash(1)],
      ["unattributed_late_transfer", txHash(2)],
    ]);
  });

  it("records a correct payment that arrives after an over-payment sent the quote to review", async () => {
    const world = createYearlyTokenWorld();
    openQuote(world, { quoted_at: world.at(-50 * MINUTE_MS), expires_at: world.at(-30 * MINUTE_MS), status: "expired" });
    world.pay({ tx: txHash(1), amountRaw: REQUIRED * 3n, offsetMs: -40 * MINUTE_MS });
    await reconcile(world);
    world.pay({ tx: txHash(2), amountRaw: REQUIRED, offsetMs: -35 * MINUTE_MS });

    await runBatch(world);

    expect(world.items().map((item) => item.reason)).toEqual(["overpaid", "payment_after_review"]);
    expect(world.subscriptions()).toHaveLength(0);
  });

  it("surfaces the transfer when a racing pass closed the quote before this pass could settle it", async () => {
    const world = createYearlyTokenWorld();
    openQuote(world);
    world.pay({ tx: txHash(1), amountRaw: REQUIRED, offsetMs: -5 * MINUTE_MS });
    // This pass loaded the quote while it was active; another pass has since
    // moved it to review.
    const loadedWhileActive = asYearlyTokenQuote(world.quote("yq_1") as unknown as YearlyQuoteRow);
    Object.assign(world.quote("yq_1")!, { status: "manual_review" });

    const result = await reconcileYearlyTokenQuote({
      quote: loadedWhileActive,
      db: world.memory.db,
      fetchImpl: world.chain.fetchImpl,
      now: new Date(world.nowMs),
    });

    expect(result).toMatchObject({ status: "closed", quoteStatus: "manual_review" });
    expect(world.items()).toEqual([expect.objectContaining({ reason: "payment_after_review", transaction_hash: txHash(1) })]);
  });

  it("closes the range once it is fully scanned, and stops loading the quote", async () => {
    const world = createYearlyTokenWorld();
    openQuote(world, { quoted_at: world.at(-3 * HOUR_MS), expires_at: world.at(-3 * HOUR_MS + 20 * MINUTE_MS), status: "expired" });
    world.pay({ tx: txHash(1), amountRaw: REQUIRED, offsetMs: -3 * HOUR_MS + 5 * MINUTE_MS });

    expect((await runBatch(world)).results).toEqual([expect.objectContaining({ status: "activated" })]);
    expect(world.quote("yq_1")).toMatchObject({ status: "consumed", attribution_closed_at: null });

    expect((await runBatch(world)).results).toEqual([expect.objectContaining({ status: "closed" })]);
    expect(world.quote("yq_1")?.attribution_closed_at).toEqual(expect.any(String));

    expect((await runBatch(world)).checked).toBe(0);
  });

  it("retires an unpaid quote and closes its range in one step", async () => {
    const world = createYearlyTokenWorld();
    openQuote(world, { quoted_at: world.at(-3 * HOUR_MS), expires_at: world.at(-3 * HOUR_MS + 20 * MINUTE_MS), status: "expired" });

    expect(await reconcile(world)).toMatchObject({ status: "cancelled" });
    expect(world.quote("yq_1")).toMatchObject({ status: "cancelled", attribution_closed_at: expect.any(String) });
  });
});

describe("range edges", () => {
  it("does not attribute an unbound transfer mined just before the quote was created", async () => {
    const world = createYearlyTokenWorld();
    openQuote(world, { quoted_at: world.at(-10 * MINUTE_MS + 500), expires_at: world.at(10 * MINUTE_MS) });
    world.pay({ tx: txHash(1), amountRaw: REQUIRED, offsetMs: -10 * MINUTE_MS - 2_000 });

    expect(await reconcile(world)).toMatchObject({ status: "no_match" });
    expect(world.subscriptions()).toHaveLength(0);
  });

  it("uses the exact range even when the scanned block range is padded", async () => {
    // 1 s blocks: the scanner's 2 s/block estimate misses and it may return
    // blocks up to a minute outside the range, as it can on a real chain.
    const world = createYearlyTokenWorld({ blockTimeSec: 1 });
    openQuote(world, { quoted_at: world.at(-60 * MINUTE_MS), expires_at: world.at(-40 * MINUTE_MS), status: "expired" });
    openQuote(world, { id: "yq_next", quoted_at: world.at(-20 * MINUTE_MS), expires_at: world.at(0) });
    world.pay({ tx: txHash(1), amountRaw: REQUIRED, offsetMs: -60 * MINUTE_MS - 20_000 });
    world.pay({ tx: txHash(2), amountRaw: REQUIRED, offsetMs: -20 * MINUTE_MS + 20_000 });

    expect(await reconcile(world, "yq_1")).toMatchObject({ status: "cancelled" });
    expect(world.items()).toHaveLength(0);
    expect(world.subscriptions()).toHaveLength(0);
  });

  it("leaves a transfer after the user's next yearly quote to that quote", async () => {
    const world = createYearlyTokenWorld();
    openQuote(world, { quoted_at: world.at(-60 * MINUTE_MS), expires_at: world.at(-40 * MINUTE_MS), status: "expired" });
    openQuote(world, { id: "yq_next", quoted_at: world.at(-20 * MINUTE_MS), expires_at: world.at(0) });
    // Inside the first quote's late grace, but after the next quote opened.
    world.pay({ tx: txHash(1), amountRaw: REQUIRED, offsetMs: -15 * MINUTE_MS });

    expect(await reconcile(world, "yq_1")).toMatchObject({ status: "cancelled" });
    expect(world.items()).toHaveLength(0);
    expect(await reconcile(world, "yq_next")).toMatchObject({ status: "activated", transactionHash: txHash(1) });
  });
});

describe("managed-Venice reviews do not own a transfer", () => {
  it("credits a yearly payment an old managed-Venice review recorded, and flags the conflict", async () => {
    const world = createYearlyTokenWorld();
    // Canary's pre-attribution Venice flow wrote a transfer it REJECTED into
    // transaction_hash when it sent its own stale quote to review.
    world.memory.insertRow(
      "managed_venice_token_quotes",
      managedVeniceQuoteRow({
        quoted_at: world.at(-3 * HOUR_MS),
        expires_at: world.at(-3 * HOUR_MS + 20 * MINUTE_MS),
        status: "manual_review_required",
        transaction_hash: txHash(1),
      })
    );
    openQuote(world);
    world.pay({ tx: txHash(1), amountRaw: REQUIRED, offsetMs: -5 * MINUTE_MS });

    expect(await reconcile(world)).toMatchObject({ status: "activated", transactionHash: txHash(1) });
    expect(world.items()).toEqual([
      expect.objectContaining({
        reason: "contested_by_managed_venice_review",
        transaction_hash: txHash(1),
        subscription_id: world.subscriptions()[0].id,
      }),
    ]);
  });
});

describe("batch time budget", () => {
  it("defers the remaining quotes once its deadline has passed", async () => {
    const world = createYearlyTokenWorld();
    openQuote(world, { id: "yq_a", user_id: "user_a", quoted_at: world.at(-10 * MINUTE_MS) });
    openQuote(world, { id: "yq_b", user_id: "user_b", quoted_at: world.at(-11 * MINUTE_MS) });

    const summary = await reconcilePendingYearlyTokenQuotes({
      db: world.memory.db,
      fetchImpl: world.chain.fetchImpl,
      now: new Date(world.nowMs),
      rpcSleepImpl: noDelay,
      deadlineMs: Date.now() - 1,
    });

    expect(summary).toMatchObject({ checked: 0, deferred: 2 });
  });
});
