/** @jest-environment node */
/**
 * Yearly treasury sweep: claim-first compare-and-set, the attributed amount
 * only, and an operator (not a blind retry) whenever the outcome is unknown.
 */

const mockReportOpsEvent = jest.fn();
jest.mock("@/lib/ops-events", () => ({
  ...jest.requireActual("@/lib/ops-events"),
  reportOpsEvent: (...args: unknown[]) => mockReportOpsEvent(...args),
}));

import {
  sweepPendingYearlyTokenSubscriptions,
  sweepYearlyTokenSubscription,
  YEARLY_SWEEP_CLAIM_STALE_MS,
  YEARLY_SWEEP_STUCK_ALERT_MS,
  type YearlySweepOptions,
} from "@/lib/billing/yearly-sweep";
import {
  depositCredentialRow,
  TEST_DEPOSIT_ADDRESS,
  TEST_TREASURY_ADDRESS,
  txHash,
  yearlySubscriptionRow,
} from "@/test-utils/yearly-token-memory-db";
import { createYearlyTokenWorld, MINUTE_MS, type YearlyTokenWorld } from "@/test-utils/yearly-token-world";

const REQUIRED = 1_000n * 10n ** 18n;

type BatchOptions = YearlySweepOptions & { limit?: number };

function options(world: YearlyTokenWorld, overrides: Partial<BatchOptions> = {}): BatchOptions {
  return {
    db: world.memory.db,
    now: new Date(world.nowMs),
    env: { HERMES_TREASURY_ADDRESS: TEST_TREASURY_ADDRESS },
    fetchImpl: world.chain.fetchImpl as unknown as YearlySweepOptions["fetchImpl"],
    readHermesBalance: async ({ walletAddress }) => ({ balanceRaw: world.chain.balanceOf(walletAddress).toString() }),
    ensureGas: async () => ({ status: "already_funded" }),
    mintApiKey: world.bankr.mintScopedTransferApiKey as unknown as YearlySweepOptions["mintApiKey"],
    submitTransfer: world.bankr.submitBankrTransfer as unknown as YearlySweepOptions["submitTransfer"],
    ...overrides,
  };
}

function pendingSub(world: YearlyTokenWorld, overrides: Record<string, unknown> = {}) {
  return world.memory.insertRow(
    "yearly_token_subscriptions",
    yearlySubscriptionRow({
      id: "ys_1",
      paid_at: world.at(-1 * MINUTE_MS),
      deposit_tx_hash: txHash(1),
      deposit_log_index: 0,
      amount_received_raw: REQUIRED.toString(),
      sweep_status: "pending",
      ...overrides,
    })
  );
}

function sub(world: YearlyTokenWorld, id = "ys_1") {
  return world.subscriptions().find((row) => row.id === id);
}

beforeEach(() => {
  mockReportOpsEvent.mockReset();
});

it("sweeps the subscription's amount from its deposit wallet and records the tx", async () => {
  const world = createYearlyTokenWorld();
  pendingSub(world);
  world.pay({ tx: txHash(1), amountRaw: REQUIRED * 3n, offsetMs: -2 * MINUTE_MS });

  const result = await sweepYearlyTokenSubscription({ id: "ys_1", user_id: "user_1" }, options(world));

  expect(result).toMatchObject({ outcome: "swept", txHash: world.submitted[0].txHash });
  expect(sub(world)).toMatchObject({ sweep_status: "swept", sweep_tx_hash: world.submitted[0].txHash, sweep_error: null });
  expect(world.chain.balanceOf(TEST_DEPOSIT_ADDRESS)).toBe(REQUIRED * 2n);
});

it("does nothing when another sweeper holds the claim", async () => {
  const world = createYearlyTokenWorld();
  pendingSub(world, { sweep_status: "sweeping", sweep_attempted_at: world.at(-1 * MINUTE_MS) });

  const result = await sweepYearlyTokenSubscription({ id: "ys_1", user_id: "user_1" }, options(world));

  expect(result.outcome).toBe("claimed_elsewhere");
  expect(world.bankr.mintScopedTransferApiKey).not.toHaveBeenCalled();
});

describe("parks for an operator instead of guessing", () => {
  it("a pre-attribution row with no bound deposit transfer", async () => {
    const world = createYearlyTokenWorld();
    pendingSub(world, { deposit_tx_hash: null });
    world.pay({ tx: txHash(1), amountRaw: REQUIRED, offsetMs: -2 * MINUTE_MS });

    const result = await sweepYearlyTokenSubscription({ id: "ys_1", user_id: "user_1" }, options(world));

    expect(result.outcome).toBe("needs_operator");
    expect(sub(world)).toMatchObject({ sweep_status: "needs_operator" });
    expect(world.submitted).toHaveLength(0);
    expect(mockReportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ failureType: "yearly_token_sweep_needs_operator" }) })
    );
  });

  it("a manual grant recorded with another asset's tx and no transfer log", async () => {
    const world = createYearlyTokenWorld();
    // e.g. an operator's grant for a USDC payment: tx hash set, no log index.
    pendingSub(world, { deposit_tx_hash: txHash(0x55), deposit_log_index: null, amount_received_raw: "49000000" });
    world.pay({ tx: txHash(0x77), amountRaw: REQUIRED, offsetMs: -60 * MINUTE_MS }); // someone else's deposit

    expect((await sweepYearlyTokenSubscription({ id: "ys_1", user_id: "user_1" }, options(world))).outcome).toBe(
      "needs_operator"
    );
    expect(world.submitted).toHaveLength(0);
    expect(world.chain.balanceOf(TEST_DEPOSIT_ADDRESS)).toBe(REQUIRED);
  });

  it("a deposit wallet that resolves to a hermesos_lock credential", async () => {
    const world = createYearlyTokenWorld();
    world.memory.tables.bankr_deposit_wallet_credentials[0].purpose = "hermesos_lock";
    pendingSub(world);
    world.pay({ tx: txHash(1), amountRaw: REQUIRED, offsetMs: -2 * MINUTE_MS });

    expect((await sweepYearlyTokenSubscription({ id: "ys_1", user_id: "user_1" }, options(world))).outcome).toBe(
      "needs_operator"
    );
    expect(world.submitted).toHaveLength(0);
  });

  it("a wallet that no longer holds the subscription's tokens", async () => {
    const world = createYearlyTokenWorld();
    pendingSub(world);
    world.pay({ tx: txHash(1), amountRaw: REQUIRED - 1n, offsetMs: -2 * MINUTE_MS });

    expect((await sweepYearlyTokenSubscription({ id: "ys_1", user_id: "user_1" }, options(world))).outcome).toBe(
      "needs_operator"
    );
    expect(sub(world)?.sweep_error).toMatch(/live balance/);
  });

  it("a transfer whose outcome is unknown (Bankr 5xx / network error)", async () => {
    const world = createYearlyTokenWorld();
    pendingSub(world);
    world.pay({ tx: txHash(1), amountRaw: REQUIRED, offsetMs: -2 * MINUTE_MS });
    const result = await sweepYearlyTokenSubscription(
      { id: "ys_1", user_id: "user_1" },
      options(world, { submitTransfer: async () => Promise.reject(new Error("Bankr transfer failed status=502 body=")) })
    );

    expect(result.outcome).toBe("needs_operator");
    expect(sub(world)).toMatchObject({ sweep_status: "needs_operator" });
    expect(sub(world)?.sweep_submitted_at).toEqual(expect.any(String));
  });
});

it("releases a definite Bankr rejection back to failed for a later retry", async () => {
  const world = createYearlyTokenWorld();
  pendingSub(world);
  world.pay({ tx: txHash(1), amountRaw: REQUIRED, offsetMs: -2 * MINUTE_MS });

  const result = await sweepYearlyTokenSubscription(
    { id: "ys_1", user_id: "user_1" },
    options(world, { submitTransfer: async () => Promise.reject(new Error("Bankr transfer failed status=400 body=bad")) })
  );

  expect(result.outcome).toBe("transfer_failed");
  expect(sub(world)).toMatchObject({ sweep_status: "failed", sweep_submitted_at: null });
});

it("keeps a failed row retryable when the treasury is not configured", async () => {
  const world = createYearlyTokenWorld();
  pendingSub(world);

  const result = await sweepYearlyTokenSubscription({ id: "ys_1", user_id: "user_1" }, options(world, { env: {} }));

  expect(result.outcome).toBe("no_treasury_configured");
  expect(sub(world)).toMatchObject({ sweep_status: "failed" });
});

describe("batch", () => {
  it("retries a stale claim that never submitted, and parks one that did", async () => {
    const world = createYearlyTokenWorld();
    const stale = world.at(-YEARLY_SWEEP_CLAIM_STALE_MS - MINUTE_MS);
    pendingSub(world, { id: "ys_unsent", sweep_status: "sweeping", sweep_attempted_at: stale, sweep_submitted_at: null });
    world.memory.insertRow(
      "bankr_deposit_wallet_credentials",
      depositCredentialRow({ id: "cred_2", user_id: "user_2", bankr_wallet_id: "bankr_wallet_2", evm_address: "0x000000000000000000000000000000000000cafe" })
    );
    pendingSub(world, {
      id: "ys_sent",
      user_id: "user_2",
      deposit_tx_hash: txHash(2),
      deposit_address: "0x000000000000000000000000000000000000cafe",
      sweep_status: "sweeping",
      sweep_attempted_at: stale,
      sweep_submitted_at: stale,
    });
    world.pay({ tx: txHash(1), amountRaw: REQUIRED, offsetMs: -30 * MINUTE_MS });

    const summary = await sweepPendingYearlyTokenSubscriptions(options(world));

    expect(summary).toMatchObject({ staleClaimsReleased: 1, staleClaimsParked: 1 });
    expect(sub(world, "ys_sent")).toMatchObject({ sweep_status: "needs_operator" });
    // Released to 'failed' this tick; retried once its backoff has passed.
    expect(sub(world, "ys_unsent")).toMatchObject({ sweep_status: "failed" });
    expect(world.submitted).toHaveLength(0);
  });

  it("alerts on sweeps still failing hours after activation", async () => {
    const world = createYearlyTokenWorld();
    pendingSub(world, { paid_at: world.at(-YEARLY_SWEEP_STUCK_ALERT_MS - MINUTE_MS) });

    const summary = await sweepPendingYearlyTokenSubscriptions(options(world, { env: {} }));

    expect(summary.stuck).toBe(1);
    expect(mockReportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ failureType: "yearly_token_sweep_stuck" }) })
    );
  });

  it("retries failed rows least-recently-attempted first, whatever their activation order", async () => {
    const world = createYearlyTokenWorld();
    // Activation order runs opposite to attempt order, so paid_at ordering
    // (the YR-6 bug) would pick the wrong rows.
    const rows: Array<[string, number, number]> = [
      ["ys_recent", 5, 60],
      ["ys_oldest", 300, 1],
      ["ys_older", 120, 30],
    ];
    for (const [id, attemptedMinutesAgo, paidMinutesAgo] of rows) {
      pendingSub(world, {
        id,
        user_id: id,
        paid_at: world.at(-paidMinutesAgo * 60 * MINUTE_MS),
        deposit_tx_hash: txHash(id.length * 1000 + attemptedMinutesAgo),
        sweep_status: "failed",
        sweep_attempted_at: world.at(-attemptedMinutesAgo * MINUTE_MS),
      });
    }

    const summary = await sweepPendingYearlyTokenSubscriptions(options(world, { env: {} }));

    expect(summary.results.map((result) => result.subscriptionId)).toEqual(["ys_oldest", "ys_older"]);
    expect(summary.backoffSkipped).toBe(1);
  });

  it("reaches failed rows beyond the first page on the next pass", async () => {
    const world = createYearlyTokenWorld();
    for (const [index, id] of ["ys_a", "ys_b", "ys_c"].entries()) {
      pendingSub(world, {
        id,
        user_id: id,
        paid_at: world.at(-(10 - index) * 60 * MINUTE_MS),
        deposit_tx_hash: txHash(0x500 + index),
        sweep_status: "failed",
        sweep_attempted_at: world.at(-(3 - index) * 60 * MINUTE_MS),
      });
    }
    const first = await sweepPendingYearlyTokenSubscriptions(options(world, { env: {}, limit: 2 }));
    const later = new Date(world.nowMs + 31 * MINUTE_MS);
    const second = await sweepPendingYearlyTokenSubscriptions(options(world, { env: {}, limit: 2, now: later }));

    expect(first.results.map((result) => result.subscriptionId)).toEqual(["ys_a", "ys_b"]);
    expect(second.results.map((result) => result.subscriptionId)[0]).toBe("ys_c");
  });

  it("never lets a pass acting on a stale read release a claim another sweeper holds", async () => {
    const world = createYearlyTokenWorld();
    const staleAt = world.at(-YEARLY_SWEEP_CLAIM_STALE_MS - MINUTE_MS);
    const staleRead = { ...pendingSub(world, { sweep_status: "sweeping", sweep_attempted_at: staleAt, sweep_submitted_at: null }) };
    // Since that read, another pass recovered the stale claim, re-claimed the
    // row and submitted its transfer.
    const liveClaim = world.at(-1 * MINUTE_MS);
    Object.assign(sub(world)!, { sweep_attempted_at: liveClaim, sweep_submitted_at: liveClaim });

    const stalePass = world.memory.withStaleReads("yearly_token_subscriptions", [staleRead]);
    await sweepPendingYearlyTokenSubscriptions(options(world, { db: stalePass }));

    expect(sub(world)).toMatchObject({
      sweep_status: "sweeping",
      sweep_attempted_at: liveClaim,
      sweep_submitted_at: liveClaim,
    });
  });

  it("parks a failed row that still carries a submitted transfer instead of retrying it", async () => {
    const world = createYearlyTokenWorld();
    pendingSub(world, {
      sweep_status: "failed",
      sweep_attempted_at: world.at(-2 * 60 * MINUTE_MS),
      sweep_submitted_at: world.at(-2 * 60 * MINUTE_MS),
    });
    world.pay({ tx: txHash(1), amountRaw: REQUIRED, offsetMs: -3 * 60 * MINUTE_MS });

    const summary = await sweepPendingYearlyTokenSubscriptions(options(world));

    expect(sub(world)).toMatchObject({ sweep_status: "needs_operator" });
    expect(summary.needsOperator).toBe(1);
    expect(world.submitted).toHaveLength(0);
  });
});
