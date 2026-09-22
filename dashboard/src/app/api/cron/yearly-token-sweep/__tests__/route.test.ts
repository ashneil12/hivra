/** @jest-environment node */
/**
 * Route-level regressions for the yearly $HermesOS payment cron, run against
 * an in-memory Supabase and a Base chain fake holding the user's shared
 * credit_deposit wallet (the audit of 2026-09-22, YR-1..YR-4, YR-6, YR-7).
 *
 * The wallet is shared with managed-Venice $HermesOS deposits, so a yearly
 * quote must be paid by a specific on-chain transfer inside its own window,
 * and the treasury sweep must move exactly that transfer's amount out of the
 * wallet the quote pointed the user at.
 */

import { NextRequest } from "next/server";

import {
  depositCredentialRow,
  managedVeniceQuoteRow,
  TEST_DEPOSIT_ADDRESS,
  TEST_TREASURY_ADDRESS,
  TEST_USER_ID,
  txHash,
  yearlyQuoteRow,
  yearlySubscriptionRow,
} from "@/test-utils/yearly-token-memory-db";
import {
  createYearlyTokenWorld,
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  YEAR_MS,
  type YearlyTokenWorld,
} from "@/test-utils/yearly-token-world";

const mockState: { world: YearlyTokenWorld | null } = { world: null };
const mockReportOpsEvent = jest.fn();

jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockState.world?.memory.db ?? null;
  },
}));

jest.mock("@/lib/billing/bankr-withdraw", () => ({
  mintScopedTransferApiKey: (params: { bankrWalletId: string }) =>
    mockState.world!.bankr.mintScopedTransferApiKey(params),
  submitBankrTransfer: (params: { apiKey: string; recipientAddress: string; amountDisplay: string }) =>
    mockState.world!.bankr.submitBankrTransfer(params),
}));

jest.mock("@/lib/billing/treasury-gas", () => ({
  ensureWalletHasGas: jest.fn(async () => ({ status: "already_funded" })),
}));

jest.mock("@/lib/ops-events", () => ({
  ...jest.requireActual("@/lib/ops-events"),
  reportOpsEvent: (...args: unknown[]) => mockReportOpsEvent(...args),
}));

import { GET } from "../route";

const REQUIRED = 1_000n * 10n ** 18n;
const originalFetch = global.fetch;
const originalEnv = { ...process.env };

function cronRequest(query = "") {
  return new Request(`http://localhost/api/cron/yearly-token-sweep${query}`, {
    headers: { authorization: "Bearer cron-secret" },
  }) as unknown as NextRequest;
}

async function runCron(query = "") {
  const response = await GET(cronRequest(query));
  expect(response.status).toBe(200);
  return response;
}

function setup() {
  const world = createYearlyTokenWorld();
  mockState.world = world;
  global.fetch = world.chain.fetchImpl as unknown as typeof fetch;
  return world;
}

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

function liveSubscriptions(world: YearlyTokenWorld) {
  return world.subscriptions().filter((row) => row.status === "active" || row.status === "grace");
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env = {
    ...originalEnv,
    CRON_SECRET: "cron-secret",
    HERMES_TREASURY_ADDRESS: TEST_TREASURY_ADDRESS,
  };
  delete process.env.HERMES_BASE_RPC_URL;
  delete process.env.BASE_RPC_URL;
});

afterAll(() => {
  global.fetch = originalFetch;
  process.env = originalEnv;
});

describe("YR-1: activation and sweep use the quote's credit_deposit wallet", () => {
  it("activates from the attributed transfer and sweeps exactly that amount to the treasury", async () => {
    const world = setup();
    openQuote(world);
    world.pay({ tx: txHash(1), amountRaw: REQUIRED, offsetMs: -5 * MINUTE_MS });

    await runCron();

    const [sub] = world.subscriptions();
    expect(world.subscriptions()).toHaveLength(1);
    expect(sub).toMatchObject({
      status: "active",
      deposit_tx_hash: txHash(1),
      amount_received_raw: REQUIRED.toString(),
      sweep_status: "swept",
    });
    expect(world.quote("yq_1")).toMatchObject({ status: "consumed", consumed_tx_hash: txHash(1) });
    expect(world.submitted).toEqual([
      expect.objectContaining({ from: TEST_DEPOSIT_ADDRESS, to: TEST_TREASURY_ADDRESS, amountRaw: REQUIRED }),
    ]);
    expect(world.chain.balanceOf(TEST_DEPOSIT_ADDRESS)).toBe(0n);
    expect(world.chain.balanceOf(TEST_TREASURY_ADDRESS)).toBe(REQUIRED);
  });

  it("sweeps only the subscription's own amount when the shared wallet also holds a managed-Venice deposit", async () => {
    const world = setup();
    const veniceAmount = 1_500n * 10n ** 18n;
    world.memory.insertRow(
      "managed_venice_token_quotes",
      managedVeniceQuoteRow({
        quoted_at: world.at(-70 * MINUTE_MS),
        expires_at: world.at(-50 * MINUTE_MS),
        transaction_hash: txHash(0x77),
        token_amount_raw: veniceAmount.toString(),
      })
    );
    world.pay({ tx: txHash(0x77), amountRaw: veniceAmount, offsetMs: -60 * MINUTE_MS });
    openQuote(world);
    world.pay({ tx: txHash(1), amountRaw: REQUIRED, offsetMs: -5 * MINUTE_MS });

    await runCron();

    expect(world.subscriptions()).toEqual([
      expect.objectContaining({ amount_received_raw: REQUIRED.toString(), sweep_status: "swept" }),
    ]);
    expect(world.submitted.map((transfer) => transfer.amountRaw)).toEqual([REQUIRED]);
    // The managed-Venice deposit is still there for its own sweep.
    expect(world.chain.balanceOf(TEST_DEPOSIT_ADDRESS)).toBe(veniceAmount);
  });
});

describe("YR-2: other flows' $HermesOS in the shared wallet never pays a yearly quote", () => {
  it("does not activate from $HermesOS that landed in the wallet before the quote", async () => {
    const world = setup();
    // A managed-Venice deposit whose quote has not bound it (yet): only the
    // yearly quote's own window keeps it out.
    world.memory.insertRow(
      "managed_venice_token_quotes",
      managedVeniceQuoteRow({
        quoted_at: world.at(-70 * MINUTE_MS),
        expires_at: world.at(-50 * MINUTE_MS),
        status: "expired",
        transaction_hash: null,
        token_amount_raw: (REQUIRED * 2n).toString(),
      })
    );
    world.pay({ tx: txHash(0x77), amountRaw: REQUIRED * 2n, offsetMs: -60 * MINUTE_MS });
    world.pay({ tx: txHash(0x76), amountRaw: REQUIRED, offsetMs: -10 * MINUTE_MS - 5_000 });
    openQuote(world);

    await runCron();

    expect(world.subscriptions()).toHaveLength(0);
    expect(world.quote("yq_1")).toMatchObject({ status: "active", consumed_tx_hash: null });
    expect(world.submitted).toHaveLength(0);
  });

  it("does not count a transfer inside the quote window that a managed-Venice quote owns", async () => {
    const world = setup();
    world.memory.insertRow(
      "managed_venice_token_quotes",
      managedVeniceQuoteRow({
        quoted_at: world.at(-40 * MINUTE_MS),
        expires_at: world.at(-20 * MINUTE_MS),
        status: "settled",
        transaction_hash: txHash(0x78),
        token_amount_raw: REQUIRED.toString(),
      })
    );
    openQuote(world);
    world.pay({ tx: txHash(0x78), amountRaw: REQUIRED, offsetMs: -5 * MINUTE_MS });

    await runCron();

    expect(world.subscriptions()).toHaveLength(0);
    expect(world.quote("yq_1")).toMatchObject({ status: "active", consumed_tx_hash: null });
  });

  it("still credits a yearly payment that canary's managed-Venice flow put in one of its reviews", async () => {
    const world = setup();
    // The pre-attribution Venice reconciler rescans ~11 h for any in-band
    // transfer and writes a REJECTED one into its stale quote's
    // transaction_hash when it sends that quote to review.
    world.memory.insertRow(
      "managed_venice_token_quotes",
      managedVeniceQuoteRow({
        quoted_at: world.at(-3 * HOUR_MS),
        expires_at: world.at(-3 * HOUR_MS + 20 * MINUTE_MS),
        status: "manual_review_required",
        transaction_hash: txHash(0x79),
        token_amount_raw: ((REQUIRED * 2n) / 3n).toString(),
      })
    );
    openQuote(world);
    world.pay({ tx: txHash(0x79), amountRaw: REQUIRED, offsetMs: -5 * MINUTE_MS });

    await runCron();

    expect(liveSubscriptions(world)).toEqual([expect.objectContaining({ deposit_tx_hash: txHash(0x79) })]);
    expect(world.items()).toEqual([
      expect.objectContaining({ reason: "contested_by_managed_venice_review", transaction_hash: txHash(0x79) }),
    ]);
  });
});

describe("YR-3: a renewal payment is credited", () => {
  it("extends an active subscription by a year from its current end", async () => {
    const world = setup();
    const currentEnd = world.at(5 * DAY_MS);
    world.memory.insertRow(
      "yearly_token_subscriptions",
      yearlySubscriptionRow({ id: "ys_current", expires_at: currentEnd, paid_at: world.at(5 * DAY_MS - YEAR_MS) })
    );
    openQuote(world);
    world.pay({ tx: txHash(1), amountRaw: REQUIRED, offsetMs: -5 * MINUTE_MS });

    await runCron();

    const live = liveSubscriptions(world);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ status: "active", deposit_tx_hash: txHash(1), sweep_status: "swept" });
    expect(Date.parse(String(live[0].expires_at))).toBe(Date.parse(currentEnd) + YEAR_MS);
    expect(world.subscriptions().find((row) => row.id === "ys_current")).toMatchObject({ status: "renewed" });
    expect(world.quote("yq_1")).toMatchObject({ status: "consumed" });
  });

  it("runs a renewal paid during grace for a year from the payment", async () => {
    const world = setup();
    world.memory.insertRow(
      "yearly_token_subscriptions",
      yearlySubscriptionRow({ id: "ys_current", status: "grace", expires_at: world.at(-2 * DAY_MS) })
    );
    openQuote(world);
    world.pay({ tx: txHash(1), amountRaw: REQUIRED, offsetMs: -5 * MINUTE_MS });

    const before = Date.now();
    await runCron();
    const after = Date.now();

    const live = liveSubscriptions(world);
    expect(live).toHaveLength(1);
    const expiresAt = Date.parse(String(live[0].expires_at));
    expect(expiresAt).toBeGreaterThanOrEqual(before + YEAR_MS - 1000);
    expect(expiresAt).toBeLessThanOrEqual(after + YEAR_MS);
  });
});

describe("YR-4: late checks, under-payments and late payments are never dropped", () => {
  it("activates an in-window payment even when the first check runs after the quote expired", async () => {
    const world = setup();
    openQuote(world, {
      quoted_at: world.at(-40 * MINUTE_MS),
      expires_at: world.at(-20 * MINUTE_MS),
      status: "expired",
    });
    world.pay({ tx: txHash(1), amountRaw: REQUIRED, offsetMs: -22 * MINUTE_MS });

    await runCron();

    expect(liveSubscriptions(world)).toEqual([
      expect.objectContaining({ deposit_tx_hash: txHash(1), amount_received_raw: REQUIRED.toString() }),
    ]);
  });

  it("surfaces an under-payment for manual review once the window has closed, exactly once", async () => {
    const world = setup();
    openQuote(world, {
      quoted_at: world.at(-40 * MINUTE_MS),
      expires_at: world.at(-20 * MINUTE_MS),
      status: "expired",
    });
    world.pay({ tx: txHash(1), amountRaw: REQUIRED / 2n, offsetMs: -30 * MINUTE_MS });

    await runCron();
    await runCron();

    expect(world.subscriptions()).toHaveLength(0);
    expect(world.items()).toEqual([
      expect.objectContaining({
        user_id: TEST_USER_ID,
        quote_id: "yq_1",
        status: "open",
        reason: "underpaid",
        transaction_hash: txHash(1),
        token_amount_raw: (REQUIRED / 2n).toString(),
      }),
    ]);
    expect(world.quote("yq_1")).toMatchObject({ status: "manual_review" });
  });

  it("surfaces a full payment made after the window closed for manual review", async () => {
    const world = setup();
    openQuote(world, {
      quoted_at: world.at(-60 * MINUTE_MS),
      expires_at: world.at(-40 * MINUTE_MS),
      status: "expired",
    });
    world.pay({ tx: txHash(1), amountRaw: REQUIRED, offsetMs: -30 * MINUTE_MS });

    await runCron();

    expect(world.subscriptions()).toHaveLength(0);
    expect(world.items()).toEqual([
      expect.objectContaining({ reason: "late_payment", transaction_hash: txHash(1) }),
    ]);
    expect(world.quote("yq_1")).toMatchObject({ status: "manual_review" });
  });

  it("retires an unpaid quote once its window and late-payment grace are fully scanned", async () => {
    const world = setup();
    openQuote(world, {
      quoted_at: world.at(-3 * HOUR_MS),
      expires_at: world.at(-3 * HOUR_MS + 20 * MINUTE_MS),
      status: "expired",
    });

    await runCron();

    expect(world.quote("yq_1")).toMatchObject({ status: "cancelled" });
    expect(world.items()).toHaveLength(0);
  });
});

describe("YR-6: sweep retries do not starve newer subscriptions", () => {
  it("sweeps a new pending subscription while 50 older failed rows are held off by backoff", async () => {
    const world = setup();
    for (let index = 0; index < 50; index += 1) {
      world.memory.insertRow(
        "yearly_token_subscriptions",
        yearlySubscriptionRow({
          id: `ys_failed_${index}`,
          user_id: `user_failed_${index}`,
          status: "expired",
          paid_at: world.at(-30 * DAY_MS + index * MINUTE_MS),
          deposit_tx_hash: txHash(0x1000 + index),
          sweep_status: "failed",
          sweep_attempted_at: world.at(-5 * MINUTE_MS),
          sweep_error: "transfer failed",
        })
      );
    }
    world.memory.insertRow(
      "yearly_token_subscriptions",
      yearlySubscriptionRow({
        id: "ys_new",
        paid_at: world.at(-1 * MINUTE_MS),
        expires_at: world.at(YEAR_MS),
        deposit_tx_hash: txHash(1),
        deposit_log_index: 0,
        sweep_status: "pending",
      })
    );
    world.pay({ tx: txHash(1), amountRaw: REQUIRED, offsetMs: -3 * MINUTE_MS });

    await runCron();

    expect(world.subscriptions().find((row) => row.id === "ys_new")).toMatchObject({ sweep_status: "swept" });
    expect(world.submitted).toHaveLength(1);
  });
});

describe("YR-7: sweep transitions are compare-and-set", () => {
  it("submits one treasury transfer when two sweeps race for the same subscription", async () => {
    const world = setup();
    // A quote minted on a legacy yearly_subscription wallet (the pre-2026-05
    // flow) — the sweep must work from whichever wallet the quote used.
    const legacyWallet = "0x000000000000000000000000000000000000beef";
    world.memory.insertRow(
      "bankr_deposit_wallet_credentials",
      depositCredentialRow({
        id: "cred_legacy",
        bankr_wallet_id: "bankr_wallet_legacy",
        evm_address: legacyWallet,
        purpose: "yearly_subscription",
      })
    );
    world.memory.insertRow(
      "yearly_token_subscriptions",
      yearlySubscriptionRow({
        id: "ys_new",
        paid_at: world.at(-1 * MINUTE_MS),
        expires_at: world.at(YEAR_MS),
        deposit_tx_hash: txHash(1),
        deposit_log_index: 0,
        deposit_address: legacyWallet,
        sweep_status: "pending",
      })
    );
    world.pay({ tx: txHash(1), amountRaw: REQUIRED, offsetMs: -3 * MINUTE_MS, to: legacyWallet });

    // Hold every key mint until both sweeps are in flight (or 200 ms pass).
    const mint = world.bankr.mintScopedTransferApiKey.getMockImplementation()!;
    let arrivals = 0;
    let release: () => void = () => {};
    const bothArrived = new Promise<void>((resolve) => {
      release = resolve;
      setTimeout(resolve, 200);
    });
    world.bankr.mintScopedTransferApiKey.mockImplementation(async (params) => {
      arrivals += 1;
      if (arrivals >= 2) release();
      await bothArrived;
      return mint(params);
    });

    await Promise.all([runCron(), runCron()]);

    expect(world.bankr.submitBankrTransfer).toHaveBeenCalledTimes(1);
    expect(world.submitted).toEqual([expect.objectContaining({ from: legacyWallet, amountRaw: REQUIRED })]);
    expect(world.subscriptions().find((row) => row.id === "ys_new")).toMatchObject({ sweep_status: "swept" });
  });
});
