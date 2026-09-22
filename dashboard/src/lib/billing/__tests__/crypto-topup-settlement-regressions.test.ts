/**
 * Regression tests for the USDC top-up reconciliation audit (2026-09-22,
 * findings CT-1 … CT-6) and the production incident it explains: a user paid
 * 50 USDC twice (2026-09-11 and 2026-09-12) and was credited nothing.
 *
 * Every test drives the real reconciler/settlement (and, for CT-4, the real
 * bearer settle route) against an in-memory database with production unique
 * constraints and a Base RPC fake. Tests that isolate a bug other than the
 * public endpoint's 2,000-block eth_getLogs limit widen that limit so the bug
 * itself, not the 413, is what they observe.
 */

import { NextRequest } from "next/server";
import { reconcilePendingCryptoTopUps } from "@/lib/billing/crypto-reconciliation";
import { USDC_BASE_TOKEN_ADDRESS, createCryptoTopUpIntent } from "@/lib/billing/crypto-topups";
import { reportOpsEvent } from "@/lib/ops-events";
import {
  createBaseRpcFake,
  addressTopic,
  createBillingMemoryDb,
  type BaseRpcFake,
  type BillingMemoryDb,
  type MemoryRow,
} from "@/test-utils/billing-memory-db";

const mockSupabase: { db: unknown } = { db: null };

jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockSupabase.db;
  },
  supabase: null,
}));

jest.mock("@/lib/ops-events", () => ({
  ...jest.requireActual("@/lib/ops-events"),
  reportOpsEvent: jest.fn(async () => null),
}));

const SESSION_MS = 20 * 60_000;
const USDC = 1_000_000;
const NO_SLEEP = { sleepImpl: async () => undefined };

let addressCounter = 0;
function depositAddress() {
  addressCounter += 1;
  return `0x${addressCounter.toString(16).padStart(40, "0")}`;
}

function addMs(iso: string, ms: number) {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function intentRow(params: {
  ref: string;
  userId: string;
  address: string;
  createdAt: string;
  packageCredits?: number;
  status?: string;
  metadata?: MemoryRow;
}): MemoryRow {
  const packageCredits = params.packageCredits ?? 1000;
  const amountMinor = packageCredits * 10_000;
  return {
    id: `pt_${params.ref.split(":").pop()}`,
    user_id: params.userId,
    provider: "bankr",
    provider_reference_id: params.ref,
    idempotency_reference: params.ref,
    status: params.status ?? "pending",
    asset: "usdc_base",
    amount_minor: amountMinor,
    package_credits: packageCredits,
    metadata: {
      type: "crypto_topup_intent",
      chainId: 8453,
      depositAddress: params.address,
      amountDisplay: String(amountMinor / USDC),
      createdAt: params.createdAt,
      sessionExpiresAt: addMs(params.createdAt, SESSION_MS),
      creditGrantStatus: "pending_detection",
      ...(params.metadata ?? {}),
    },
    created_at: params.createdAt,
    updated_at: params.createdAt,
  };
}

function setup(options: { now: string; maxLogRangeBlocks?: number; intents?: MemoryRow[] }) {
  const memory = createBillingMemoryDb({ payment_transactions: options.intents ?? [] });
  const rpc = createBaseRpcFake({
    latestBlock: 51_700_000,
    latestTimestamp: options.now,
    maxLogRangeBlocks: options.maxLogRangeBlocks,
  });
  mockSupabase.db = memory.db;
  return { memory, rpc };
}

function pay(rpc: BaseRpcFake, params: { to: string; at: string; amountMinor: number; tx: string; logIndex?: number }) {
  rpc.addTransfer({
    txHash: params.tx,
    amountRaw: params.amountMinor,
    block: rpc.blockAt(params.at),
    logIndex: params.logIndex ?? 7,
    to: params.to,
  });
}

function reconcile(memory: BillingMemoryDb, rpc: BaseRpcFake, now: string, extra: Record<string, unknown> = {}) {
  return reconcilePendingCryptoTopUps({
    db: memory.db,
    fetchImpl: rpc.fetchImpl,
    now: new Date(now),
    rpcOptions: NO_SLEEP,
    ...extra,
  } as Parameters<typeof reconcilePendingCryptoTopUps>[0]);
}

function payment(memory: BillingMemoryDb, ref: string) {
  const row = memory.tables.payment_transactions.find((candidate) => candidate.provider_reference_id === ref);
  if (!row) throw new Error(`no payment ${ref}`);
  return row as MemoryRow & { metadata: Record<string, unknown> };
}

function ledgerFor(memory: BillingMemoryDb, userId: string) {
  return memory.tables.credit_ledger_entries.filter((entry) => entry.user_id === userId);
}

function receiptFor(memory: BillingMemoryDb, ref: string) {
  return memory.tables.crypto_deposit_receipts.find((receipt) => receipt.reference_id === ref);
}

function items(memory: BillingMemoryDb) {
  return memory.tables.crypto_topup_reconciliation_items;
}

beforeEach(() => {
  (reportOpsEvent as jest.Mock).mockClear();
});

describe("CT-1: abandoned intents and the fixed 5,000-block lookback", () => {
  it("credits a paid intent even when 60 older abandoned intents are still pending", async () => {
    const createdAt = "2026-09-22T09:00:00.000Z";
    const now = addMs(createdAt, 3.5 * 60 * 60_000);
    const abandoned = Array.from({ length: 60 }, (_, index) =>
      intentRow({
        ref: `bankr_crypto_topup:abandoned-${index}`,
        userId: `user_abandoned_${index}`,
        address: depositAddress(),
        createdAt: addMs("2026-09-10T00:00:00.000Z", index * 60_000),
      })
    );
    const address = depositAddress();
    const paid = intentRow({ ref: "bankr_crypto_topup:paid", userId: "user_paid", address, createdAt });
    const { memory, rpc } = setup({ now, maxLogRangeBlocks: 100_000, intents: [...abandoned, paid] });
    pay(rpc, { to: address, at: addMs(createdAt, 30_000), amountMinor: 10 * USDC, tx: "0xpaid" });

    await reconcile(memory, rpc, now);

    expect(payment(memory, "bankr_crypto_topup:paid").status).toBe("succeeded");
    expect(ledgerFor(memory, "user_paid")).toEqual([
      expect.objectContaining({ amount_credits: 1000, reason: "crypto_topup", reference_id: "bankr_crypto_topup:paid" }),
    ]);
  });

  it("finds a payment however late the reconciler runs (scan anchored to the intent window)", async () => {
    const createdAt = "2026-09-12T04:55:20.219Z";
    const now = "2026-09-22T14:00:00.000Z";
    const address = depositAddress();
    const { memory, rpc } = setup({
      now,
      maxLogRangeBlocks: 100_000,
      intents: [intentRow({ ref: "bankr_crypto_topup:late", userId: "user_late", address, createdAt })],
    });
    pay(rpc, { to: address, at: addMs(createdAt, 25_000), amountMinor: 10 * USDC, tx: "0xlate" });

    await reconcile(memory, rpc, now);

    expect(payment(memory, "bankr_crypto_topup:late").status).toBe("succeeded");
    expect(receiptFor(memory, "bankr_crypto_topup:late")).toEqual(
      expect.objectContaining({ tx_hash: "0xlate", status: "settled" })
    );
  });

  it("never asks Base for more than 2,000 blocks in one eth_getLogs call", async () => {
    const createdAt = "2026-09-22T12:00:00.000Z";
    const now = addMs(createdAt, 30 * 60_000);
    const address = depositAddress();
    const { memory, rpc } = setup({
      now,
      intents: [intentRow({ ref: "bankr_crypto_topup:range", userId: "user_range", address, createdAt })],
    });
    pay(rpc, { to: address, at: addMs(createdAt, 60_000), amountMinor: 10 * USDC, tx: "0xrange" });

    const result = await reconcile(memory, rpc, now);

    expect(result.failed).toBe(0);
    expect(payment(memory, "bankr_crypto_topup:range").status).toBe("succeeded");
    expect(rpc.logRanges().length).toBeGreaterThan(0);
    for (const range of rpc.logRanges()) expect(range.span).toBeLessThanOrEqual(2_000);
  });

  it("retires an abandoned intent once its window and late-payment grace are fully scanned", async () => {
    const now = "2026-09-22T12:00:00.000Z";
    const staleAddress = depositAddress();
    const { memory, rpc } = setup({
      now,
      intents: [
        intentRow({
          ref: "bankr_crypto_topup:stale",
          userId: "user_stale",
          address: staleAddress,
          createdAt: addMs(now, -3 * 60 * 60_000),
        }),
        intentRow({
          ref: "bankr_crypto_topup:fresh",
          userId: "user_fresh",
          address: depositAddress(),
          createdAt: addMs(now, -60 * 60_000),
        }),
      ],
    });

    await reconcile(memory, rpc, now);

    const stale = payment(memory, "bankr_crypto_topup:stale");
    expect(stale.status).toBe("failed");
    expect(stale.metadata).toEqual(
      expect.objectContaining({
        creditGrantStatus: "expired",
        failureType: "crypto_payment_session_expired",
        reconciliationClosedAt: now,
      })
    );
    // Still inside its late-payment grace: keep watching.
    expect(payment(memory, "bankr_crypto_topup:fresh").status).toBe("pending");

    // A retired intent is never scanned again.
    const before = rpc.requests.length;
    await reconcile(memory, rpc, addMs(now, 10 * 60_000));
    const staleScans = rpc.requests
      .slice(before)
      .filter(
        (request) =>
          request.method === "eth_getLogs" &&
          (request.params[0] as { topics?: unknown[] }).topics?.[2] === addressTopic(staleAddress)
      );
    expect(staleScans).toEqual([]);
  });
});

describe("CT-2: session expiry must not fail a paid-but-unreconciled intent", () => {
  it("keeps the paid intent open when the user starts another payment, then credits it", async () => {
    const t0 = "2026-09-22T12:00:00.000Z";
    const address = depositAddress();
    const { memory, rpc } = setup({
      now: addMs(t0, 25 * 60_000),
      maxLogRangeBlocks: 100_000,
      intents: [intentRow({ ref: "bankr_crypto_topup:a", userId: "user_ct2", address, createdAt: t0 })],
    });
    pay(rpc, { to: address, at: addMs(t0, 17 * 60_000), amountMinor: 10 * USDC, tx: "0xpaid-at-17" });

    // Minute 21: A's 20-minute session has expired; the user opens a new top-up.
    await createCryptoTopUpIntent({
      userId: "user_ct2",
      asset: "usdc_base",
      packageCredits: 500,
      depositWallet: { address },
      db: memory.db,
      referenceId: "bankr_crypto_topup:b",
      now: new Date(addMs(t0, 21 * 60_000)),
    });

    expect(payment(memory, "bankr_crypto_topup:a").status).toBe("pending");

    await reconcile(memory, rpc, addMs(t0, 25 * 60_000));

    expect(payment(memory, "bankr_crypto_topup:a").status).toBe("succeeded");
    expect(payment(memory, "bankr_crypto_topup:b").status).toBe("pending");
    expect(ledgerFor(memory, "user_ct2")).toEqual([
      expect.objectContaining({ amount_credits: 1000, reference_id: "bankr_crypto_topup:a" }),
    ]);
  });

  it("prod 2026-09-12: recovers both 50 USDC payments, including the one the old session expiry failed", async () => {
    const now = "2026-09-22T14:00:00.000Z";
    const address = "0xf53f6db364da210c7bd873b71ccce299ea9813a3";
    const aCreated = "2026-09-11T19:57:40.939Z";
    const bCreated = "2026-09-12T04:55:20.219Z";
    const { memory, rpc } = setup({
      now,
      intents: [
        intentRow({
          ref: "bankr_crypto_topup:4639bbce",
          userId: "user_prod",
          address,
          createdAt: aCreated,
          packageCredits: 5000,
          status: "failed",
          metadata: {
            creditGrantStatus: "expired",
            failureType: "crypto_payment_session_expired",
            expiredAt: bCreated,
          },
        }),
        intentRow({ ref: "bankr_crypto_topup:73ca2602", userId: "user_prod", address, createdAt: bCreated, packageCredits: 5000 }),
        // An unpaid intent the old code expired: closed, never credited.
        intentRow({
          ref: "bankr_crypto_topup:unpaid",
          userId: "user_other",
          address: depositAddress(),
          createdAt: "2026-08-11T11:22:15.224Z",
          packageCredits: 500,
          status: "failed",
          metadata: { creditGrantStatus: "expired", failureType: "crypto_payment_session_expired" },
        }),
      ],
    });
    pay(rpc, { to: address, at: "2026-09-11T19:58:17.000Z", amountMinor: 50 * USDC, tx: "0x4ea29fcd", logIndex: 417 });
    pay(rpc, { to: address, at: "2026-09-12T04:55:45.000Z", amountMinor: 50 * USDC, tx: "0x6531f19f", logIndex: 78 });

    const result = await reconcile(memory, rpc, now);

    expect(result.failed).toBe(0);
    expect(payment(memory, "bankr_crypto_topup:4639bbce").status).toBe("succeeded");
    expect(payment(memory, "bankr_crypto_topup:73ca2602").status).toBe("succeeded");
    expect(receiptFor(memory, "bankr_crypto_topup:4639bbce")).toEqual(
      expect.objectContaining({ tx_hash: "0x4ea29fcd", log_index: 417, status: "settled" })
    );
    expect(receiptFor(memory, "bankr_crypto_topup:73ca2602")).toEqual(
      expect.objectContaining({ tx_hash: "0x6531f19f", log_index: 78, status: "settled" })
    );
    expect(ledgerFor(memory, "user_prod").map((entry) => entry.amount_credits)).toEqual([5000, 5000]);

    const unpaid = payment(memory, "bankr_crypto_topup:unpaid");
    expect(unpaid.status).toBe("failed");
    expect(unpaid.metadata.reconciliationClosedAt).toBe(now);
    expect(ledgerFor(memory, "user_other")).toEqual([]);
  });
});

describe("CT-3: non-exact amounts go to manual review", () => {
  async function runWith(transfers: Array<{ amountMinor: number; tx: string; offsetMs: number }>) {
    const createdAt = "2026-09-22T08:00:00.000Z";
    const now = "2026-09-22T12:00:00.000Z";
    const address = depositAddress();
    const { memory, rpc } = setup({
      now,
      maxLogRangeBlocks: 100_000,
      intents: [intentRow({ ref: "bankr_crypto_topup:review", userId: "user_review", address, createdAt })],
    });
    transfers.forEach((transfer, index) =>
      pay(rpc, { to: address, at: addMs(createdAt, transfer.offsetMs), amountMinor: transfer.amountMinor, tx: transfer.tx, logIndex: index })
    );
    await reconcile(memory, rpc, now);
    return { memory, rpc };
  }

  it.each([
    ["an under-payment", [{ amountMinor: 9_990_000, tx: "0xunder", offsetMs: 60_000 }], ["underpaid"]],
    ["an over-payment", [{ amountMinor: 10_500_000, tx: "0xover", offsetMs: 60_000 }], ["overpaid"]],
    [
      "a split payment",
      [
        { amountMinor: 5 * USDC, tx: "0xsplit-1", offsetMs: 60_000 },
        { amountMinor: 5 * USDC, tx: "0xsplit-2", offsetMs: 120_000 },
      ],
      ["underpaid", "underpaid"],
    ],
  ])("surfaces %s for review instead of ignoring it", async (_label, transfers, reasons) => {
    const { memory } = await runWith(transfers);

    const intent = payment(memory, "bankr_crypto_topup:review");
    expect(intent.status).toBe("failed");
    expect(intent.metadata).toEqual(
      expect.objectContaining({
        creditGrantStatus: "manual_review",
        failureType: "crypto_topup_manual_review",
        observedTotalMinor: transfers.reduce((sum, transfer) => sum + transfer.amountMinor, 0),
      })
    );
    expect(ledgerFor(memory, "user_review")).toEqual([]);
    expect(items(memory).map((item) => item.reason)).toEqual(reasons);
    expect(items(memory)[0]).toEqual(
      expect.objectContaining({
        user_id: "user_review",
        reference_id: "bankr_crypto_topup:review",
        status: "open",
        tx_hash: transfers[0].tx,
        observed_amount_minor: String(transfers[0].amountMinor),
        expected_amount_minor: 10 * USDC,
      })
    );
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringMatching(/USDC top-up needs manual review/i) })
    );
  });

  it("surfaces each transfer exactly once across repeated runs", async () => {
    const { memory, rpc } = await runWith([{ amountMinor: 9 * USDC, tx: "0xonce", offsetMs: 60_000 }]);
    // Reopen the intent to force a second full pass over the same transfer.
    payment(memory, "bankr_crypto_topup:review").status = "pending";
    delete payment(memory, "bankr_crypto_topup:review").metadata.reconciliationClosedAt;

    await reconcile(memory, rpc, "2026-09-22T12:00:00.000Z");

    expect(items(memory)).toHaveLength(1);
    expect(reportOpsEvent).toHaveBeenCalledTimes(1);
  });

  it("waits for the window to close before reviewing an under-payment", async () => {
    const createdAt = "2026-09-22T12:00:00.000Z";
    const now = addMs(createdAt, 10 * 60_000);
    const address = depositAddress();
    const { memory, rpc } = setup({
      now,
      intents: [intentRow({ ref: "bankr_crypto_topup:open", userId: "user_open", address, createdAt })],
    });
    pay(rpc, { to: address, at: addMs(createdAt, 60_000), amountMinor: 4 * USDC, tx: "0xpartial" });

    await reconcile(memory, rpc, now);

    expect(payment(memory, "bankr_crypto_topup:open").status).toBe("pending");
    expect(items(memory)).toEqual([]);
  });
});

describe("CT-4: settlement cannot be replayed, rewritten, or done without a verified transfer", () => {
  function settleRequest(body: Record<string, unknown>) {
    return new NextRequest("http://localhost/api/internal/billing/crypto/top-up/settle", {
      method: "POST",
      body: JSON.stringify(body),
      headers: new Headers({ "content-type": "application/json", authorization: "Bearer settlement-secret" }),
    });
  }

  const originalEnv = process.env;
  const originalFetch = global.fetch;
  beforeEach(() => {
    process.env = { ...originalEnv, BILLING_SETTLEMENT_SECRET: "settlement-secret", HERMES_BASE_RPC_URL: "http://base.test" };
  });
  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  async function settleRoute() {
    return (await import("@/app/api/internal/billing/crypto/top-up/settle/route")).POST;
  }

  it("keeps the first settlement's transaction when settle is retried with a different hash", async () => {
    const createdAt = "2026-09-22T11:00:00.000Z";
    const now = "2026-09-22T11:30:00.000Z";
    const address = depositAddress();
    const { memory, rpc } = setup({
      now,
      maxLogRangeBlocks: 100_000,
      intents: [intentRow({ ref: "bankr_crypto_topup:retry", userId: "user_retry", address, createdAt })],
    });
    pay(rpc, { to: address, at: addMs(createdAt, 60_000), amountMinor: 10 * USDC, tx: "0xt1" });
    global.fetch = rpc.fetchImpl as unknown as typeof fetch;
    const POST = await settleRoute();

    const first = await POST(settleRequest({ referenceId: "bankr_crypto_topup:retry", transactionHash: "0xt1" }));
    expect(first.status).toBe(200);
    await POST(settleRequest({ referenceId: "bankr_crypto_topup:retry", transactionHash: "0xt2" }));

    const settled = payment(memory, "bankr_crypto_topup:retry");
    expect(settled.status).toBe("succeeded");
    expect((settled.metadata.settlement as Record<string, unknown>).transactionHash).toBe("0xt1");
    expect(receiptFor(memory, "bankr_crypto_topup:retry")).toEqual(expect.objectContaining({ tx_hash: "0xt1" }));
    expect(ledgerFor(memory, "user_retry")).toHaveLength(1);
  });

  it("does not credit an intent from a caller-supplied hash that is not on chain", async () => {
    const createdAt = "2026-09-22T11:00:00.000Z";
    const now = "2026-09-22T11:10:00.000Z";
    const { memory, rpc } = setup({
      now,
      intents: [intentRow({ ref: "bankr_crypto_topup:unpaid", userId: "user_unpaid", address: depositAddress(), createdAt })],
    });
    global.fetch = rpc.fetchImpl as unknown as typeof fetch;
    const POST = await settleRoute();

    const response = await POST(settleRequest({ referenceId: "bankr_crypto_topup:unpaid", transactionHash: "0xinvented" }));

    expect(response.status).toBe(409);
    expect(payment(memory, "bankr_crypto_topup:unpaid").status).toBe("pending");
    expect(ledgerFor(memory, "user_unpaid")).toEqual([]);
  });

  it("claims the transfer a bearer settle credits, so a newer same-package intent cannot reuse it", async () => {
    const aCreated = "2026-09-22T11:00:00.000Z";
    const bCreated = "2026-09-22T11:40:00.000Z";
    const now = "2026-09-22T11:50:00.000Z";
    const address = depositAddress();
    const { memory, rpc } = setup({
      now,
      maxLogRangeBlocks: 100_000,
      intents: [intentRow({ ref: "bankr_crypto_topup:bearer-a", userId: "user_bearer", address, createdAt: aCreated })],
    });
    pay(rpc, { to: address, at: addMs(aCreated, 60_000), amountMinor: 10 * USDC, tx: "0xonly-payment" });
    global.fetch = rpc.fetchImpl as unknown as typeof fetch;
    const POST = await settleRoute();

    await POST(settleRequest({ referenceId: "bankr_crypto_topup:bearer-a", transactionHash: "0xonly-payment" }));
    memory.insertRow(
      "payment_transactions",
      intentRow({ ref: "bankr_crypto_topup:bearer-b", userId: "user_bearer", address, createdAt: bCreated })
    );
    await reconcile(memory, rpc, now);

    expect(payment(memory, "bankr_crypto_topup:bearer-a").status).toBe("succeeded");
    expect(payment(memory, "bankr_crypto_topup:bearer-b").status).toBe("pending");
    expect(ledgerFor(memory, "user_bearer")).toHaveLength(1);
    expect(receiptFor(memory, "bankr_crypto_topup:bearer-a")).toEqual(
      expect.objectContaining({ tx_hash: "0xonly-payment", status: "settled" })
    );
  });

  it("never rewrites a claimed receipt to a later transfer", async () => {
    const createdAt = "2026-09-22T09:00:00.000Z";
    const now = "2026-09-22T12:00:00.000Z";
    const address = depositAddress();
    const ref = "bankr_crypto_topup:claimed";
    const { memory, rpc } = setup({
      now,
      maxLogRangeBlocks: 100_000,
      intents: [intentRow({ ref, userId: "user_claimed", address, createdAt })],
    });
    // T1 (the claimed, credited payment) is older than the old 5,000-block
    // lookback; T2 is an exact-amount late transfer inside the grace.
    pay(rpc, { to: address, at: addMs(createdAt, 60_000), amountMinor: 10 * USDC, tx: "0xt1", logIndex: 1 });
    pay(rpc, { to: address, at: addMs(createdAt, 110 * 60_000), amountMinor: 10 * USDC, tx: "0xt2", logIndex: 2 });
    // A previous run claimed T1 and credited, then died before flipping the payment.
    memory.insertRow("crypto_deposit_receipts", {
      user_id: "user_claimed",
      payment_transaction_id: payment(memory, ref).id,
      provider: "bankr",
      reference_id: ref,
      chain_id: 8453,
      token_address: USDC_BASE_TOKEN_ADDRESS,
      token_symbol: "USDC",
      token_decimals: 6,
      deposit_address: address,
      normalized_deposit_address: address,
      amount_minor: 10 * USDC,
      tx_hash: "0xt1",
      log_index: 1,
      block_number: rpc.blockAt(addMs(createdAt, 60_000)),
      confirmations: 3,
      status: "confirmed",
      metadata: {},
    });
    memory.insertRow("credit_accounts", { id: "acct_claimed", user_id: "user_claimed", balance_cached_credits: 1000 });
    memory.insertRow("credit_ledger_entries", {
      account_id: "acct_claimed",
      user_id: "user_claimed",
      amount_credits: 1000,
      source: "bankr",
      actor: "bankr_reconciler",
      reason: "crypto_topup",
      reference_id: ref,
      metadata: { transactionHash: "0xt1" },
    });

    await reconcile(memory, rpc, now);

    expect(receiptFor(memory, ref)).toEqual(expect.objectContaining({ tx_hash: "0xt1", log_index: 1, status: "settled" }));
    const settled = payment(memory, ref);
    expect(settled.status).toBe("succeeded");
    expect((settled.metadata.settlement as Record<string, unknown>).transactionHash).toBe("0xt1");
    expect(ledgerFor(memory, "user_claimed")).toHaveLength(1);
    expect(items(memory)).toEqual([expect.objectContaining({ tx_hash: "0xt2", reason: "extra_transfer" })]);
  });
});

describe("CT-5: transfers are attributed by the intent's time window", () => {
  it("ignores an older same-amount transfer sent before the intent existed", async () => {
    const createdAt = "2026-09-22T11:00:00.000Z";
    const now = "2026-09-22T11:15:00.000Z";
    const address = depositAddress();
    const { memory, rpc } = setup({
      now,
      maxLogRangeBlocks: 100_000,
      intents: [intentRow({ ref: "bankr_crypto_topup:window", userId: "user_window", address, createdAt })],
    });
    pay(rpc, { to: address, at: addMs(createdAt, -30 * 60_000), amountMinor: 10 * USDC, tx: "0xstranded", logIndex: 1 });
    pay(rpc, { to: address, at: addMs(createdAt, 2 * 60_000), amountMinor: 10 * USDC, tx: "0xown", logIndex: 2 });

    await reconcile(memory, rpc, now);

    expect(receiptFor(memory, "bankr_crypto_topup:window")).toEqual(expect.objectContaining({ tx_hash: "0xown" }));
  });

  it("gives a transfer sent after the next intent was created to the next intent", async () => {
    const aCreated = "2026-09-22T10:00:00.000Z";
    const bCreated = "2026-09-22T10:30:00.000Z";
    const now = "2026-09-22T12:40:00.000Z";
    const address = depositAddress();
    const { memory, rpc } = setup({
      now,
      intents: [
        intentRow({ ref: "bankr_crypto_topup:first", userId: "user_next", address, createdAt: aCreated }),
        intentRow({ ref: "bankr_crypto_topup:second", userId: "user_next", address, createdAt: bCreated }),
      ],
    });
    // Inside the first intent's late-payment grace, but after the second began.
    pay(rpc, { to: address, at: addMs(bCreated, 60_000), amountMinor: 10 * USDC, tx: "0xfor-second" });

    await reconcile(memory, rpc, now);

    expect(payment(memory, "bankr_crypto_topup:second").status).toBe("succeeded");
    expect(payment(memory, "bankr_crypto_topup:first").status).toBe("failed");
    expect(payment(memory, "bankr_crypto_topup:first").metadata.creditGrantStatus).toBe("expired");
    expect(items(memory)).toEqual([]);
  });
});

describe("CT-6: settlement is a compare-and-set on the intent status", () => {
  it("does not overwrite an intent an operator refunded between the read and the write", async () => {
    const createdAt = "2026-09-22T11:00:00.000Z";
    const now = "2026-09-22T11:10:00.000Z";
    const address = depositAddress();
    const ref = "bankr_crypto_topup:refunded";
    const { memory, rpc } = setup({
      now,
      maxLogRangeBlocks: 100_000,
      intents: [intentRow({ ref, userId: "user_refunded", address, createdAt })],
    });
    pay(rpc, { to: address, at: addMs(createdAt, 60_000), amountMinor: 10 * USDC, tx: "0xrefund-race" });
    memory.beforeUpdate({
      table: "payment_transactions",
      match: (patch) => patch.status === "succeeded",
      run: (tables) => {
        const row = tables.payment_transactions.find((candidate) => candidate.provider_reference_id === ref);
        if (row) row.status = "refunded";
      },
    });

    await reconcile(memory, rpc, now);

    expect(payment(memory, ref).status).toBe("refunded");
    expect(ledgerFor(memory, "user_refunded")).toEqual([]);
    expect(receiptFor(memory, ref)).toEqual(expect.objectContaining({ tx_hash: "0xrefund-race", status: "failed" }));
    expect(items(memory)).toEqual([
      expect.objectContaining({ tx_hash: "0xrefund-race", reason: "intent_closed_during_settlement" }),
    ]);
  });

  it("finishes the credit on the next run when settlement dies after flipping the intent", async () => {
    const createdAt = "2026-09-22T11:00:00.000Z";
    const now = "2026-09-22T11:10:00.000Z";
    const address = depositAddress();
    const ref = "bankr_crypto_topup:crash";
    const { memory, rpc } = setup({
      now,
      maxLogRangeBlocks: 100_000,
      intents: [intentRow({ ref, userId: "user_crash", address, createdAt })],
    });
    pay(rpc, { to: address, at: addMs(createdAt, 60_000), amountMinor: 10 * USDC, tx: "0xcrash" });
    // The credit write fails for the whole first run (the intent flip lands).
    memory.failNext({ table: "credit_ledger_entries", op: "insert", times: 2 });

    const first = await reconcile(memory, rpc, now);
    expect(first.failed).toBeGreaterThan(0);
    expect(payment(memory, ref).status).toBe("succeeded");
    expect(ledgerFor(memory, "user_crash")).toEqual([]);

    await reconcile(memory, rpc, addMs(now, 10 * 60_000));

    expect(payment(memory, ref).status).toBe("succeeded");
    expect(ledgerFor(memory, "user_crash")).toEqual([
      expect.objectContaining({ amount_credits: 1000, reference_id: ref }),
    ]);
    expect(receiptFor(memory, ref)).toEqual(expect.objectContaining({ tx_hash: "0xcrash", status: "settled" }));
  });
});
