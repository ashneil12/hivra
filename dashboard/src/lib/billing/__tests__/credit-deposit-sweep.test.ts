import { sweepPendingCreditDepositReceipts } from "@/lib/billing/credit-deposit-sweep";
import { resetDiscoveredBaseLogRangeCap } from "@/lib/billing/base-rpc-logs";
import { USDC_BASE_TOKEN_ADDRESS } from "@/lib/billing/crypto-topups";
import {
  createBaseRpcFake,
  createBillingMemoryDb,
  type MemoryRow,
} from "@/test-utils/billing-memory-db";

jest.mock("@/lib/ops-events", () => ({
  ...jest.requireActual("@/lib/ops-events"),
  reportOpsEvent: jest.fn(async () => null),
}));

const mockSupabaseState: { admin: unknown } = { admin: null };
jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockSupabaseState.admin;
  },
}));

const DEPOSIT_ADDRESS = "0x000000000000000000000000000000000000beef";
const TREASURY_ADDRESS = "0x00000000000000000000000000000000000077ea";
const now = "2026-05-20T00:00:00.000Z";
const CLAIM_BLOCK = 500_000;
const HEAD = CLAIM_BLOCK + 5_000;

function submittedReceipt(): MemoryRow {
  return {
    id: "receipt_1",
    user_id: "user_1",
    provider: "bankr",
    reference_id: "ref_1",
    status: "settled",
    deposit_mode: "checkout",
    amount_minor: 5_000_000,
    chain_id: 8453,
    token_address: USDC_BASE_TOKEN_ADDRESS,
    normalized_deposit_address: DEPOSIT_ADDRESS,
    sweep_status: "submitted",
    sweep_attempts: 1,
    sweep_attempted_at: "2026-05-20T00:01:00.000Z",
    sweep_claim_block: CLAIM_BLOCK,
    sweep_destination_address: TREASURY_ADDRESS,
    sweep_transfer_requested_at: "2026-05-20T00:02:00.000Z",
    sweep_submitted_at: null,
    sweep_tx_hash: null,
  };
}

describe("credit deposit sweep evidence scan", () => {
  beforeEach(() => {
    // Discovered range caps are process state keyed by endpoint URL — a cap
    // another spec learned for the same URL must not pre-shrink this one's
    // first request.
    resetDiscoveredBaseLogRangeCap();
  });

  it("re-tiles eth_getLogs at the provider's cap when a 413 carries its JSON-RPC error body", async () => {
    // Regression: the sweep's own RPC wrapper used to throw on the HTTP
    // status before reading the body, so a 413 answering
    // "eth_getLogs is limited to a N range" arrived at the adaptive log
    // scan as a bare status it could not re-tile — every evidence search
    // failed identically on every tick. The error body must ride along.
    const memory = createBillingMemoryDb({
      crypto_deposit_receipts: [submittedReceipt()],
    });
    mockSupabaseState.admin = memory.db;
    // The endpoint serves at most 500-block ranges: the evidence window's
    // 1,800-block request is refused twice (1,800 then 900) before the
    // re-tiled 450-block spans succeed.
    const rpc = createBaseRpcFake({ latestBlock: HEAD, latestTimestamp: now, maxLogRangeBlocks: 500 });
    const sweepBlock = CLAIM_BLOCK + 100;
    rpc.addTransfer({
      txHash: "0xsweeptx",
      amountRaw: 5_000_000,
      block: sweepBlock,
      to: TREASURY_ADDRESS,
      from: DEPOSIT_ADDRESS,
    });

    const summary = await sweepPendingCreditDepositReceipts({
      rpcUrl: "https://base.test",
      fetchImpl: rpc.fetchImpl,
      env: { HERMES_TREASURY_ADDRESS: TREASURY_ADDRESS },
      now: new Date(now),
    });

    // The scan found the sweep transfer despite the cap refusals, adopted
    // it, and confirmed it once the head gave it enough confirmations.
    expect(summary.confirmed).toBe(1);
    expect(summary.results).toEqual([
      expect.objectContaining({ receiptId: "receipt_1", outcome: "confirmed", txHash: "0xsweeptx" }),
    ]);
    const row = memory.tables.crypto_deposit_receipts[0];
    expect(row.sweep_status).toBe("confirmed");
    expect(row.sweep_tx_hash).toBe("0xsweeptx");

    // The 413's JSON-RPC body drove the re-tile: the refused 1,800-span
    // request is followed by progressively narrower spans down to the
    // provider's real 500-block cap, which then serve. Before the fix the
    // error carried no detail — the scan threw after exactly one request.
    const spans = rpc.logRanges().map((range) => range.span);
    expect(spans[0]).toBe(1800);
    expect(spans.length).toBeGreaterThanOrEqual(3);
    expect(spans.some((span) => span <= 500)).toBe(true);
    expect(spans.filter((span) => span <= 500).length).toBeGreaterThanOrEqual(4);
  });
});
