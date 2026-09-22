import {
  createBaseRpcFake,
  createManagedVeniceMemoryDb,
  managedVeniceQuoteRow,
  TEST_DEPOSIT_ADDRESS,
  type BaseRpcFake,
  type ManagedVeniceMemoryDb,
} from "@/test-utils/managed-venice-memory-db";
import { makeJsonRequest, makeRequest } from "@/test-utils/request";

// The check route runs the REAL reconciler and settlement against an
// in-memory DB and a Base RPC fake, the way a user's "Verify payment" poll
// hits it. Only auth, the DB client and fetch are substituted.

let mockMemory: ManagedVeniceMemoryDb;

jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockMemory.db;
  },
}));

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/logger", () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { auth } from "@clerk/nextjs/server";
import { POST } from "../route";

const QUOTED = 1000n * 10n ** 18n;
const HEAD_BLOCK = 5_000_000;
const originalFetch = global.fetch;
let nowMs: number;
let rpc: BaseRpcFake;

function isoAt(offsetMs: number) {
  return new Date(nowMs + offsetMs).toISOString();
}

function blockAt(offsetMs: number) {
  return HEAD_BLOCK + Math.floor(offsetMs / 2000);
}

function check(quoteId = "quote_1") {
  return POST(makeJsonRequest("/api/billing/managed-venice/hermesos/check", { quoteId }));
}

async function body(response: Response) {
  return (await response.json()) as { success: boolean; data?: Record<string, unknown>; error?: string };
}

function quoteRow(overrides: Record<string, unknown> = {}) {
  return managedVeniceQuoteRow({
    quoted_at: isoAt(-5 * 60_000),
    expires_at: isoAt(15 * 60_000),
    created_at: isoAt(-5 * 60_000),
    ...overrides,
  });
}

beforeEach(() => {
  nowMs = Date.now();
  (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_1" });
  rpc = createBaseRpcFake({ latestBlock: HEAD_BLOCK, latestTimestamp: isoAt(0) });
  global.fetch = rpc.fetchImpl as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe("POST /api/billing/managed-venice/hermesos/check", () => {
  it("returns 401 before touching the reconciler when signed out", async () => {
    mockMemory = createManagedVeniceMemoryDb({ managed_venice_token_quotes: [quoteRow()] });
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });

    const response = await check();

    expect(response.status).toBe(401);
    expect(rpc.fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects malformed requests", async () => {
    mockMemory = createManagedVeniceMemoryDb();

    const invalidJson = await POST(
      makeRequest("/api/billing/managed-venice/hermesos/check", {
        method: "POST",
        body: "{not json",
        headers: { "content-type": "application/json" },
      })
    );
    const missingQuote = await POST(makeJsonRequest("/api/billing/managed-venice/hermesos/check", {}));

    expect(invalidJson.status).toBe(400);
    expect(missingQuote.status).toBe(400);
  });

  it("returns 404 for another user's quote", async () => {
    mockMemory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [quoteRow({ user_id: "someone_else" })],
    });

    expect((await check()).status).toBe(404);
  });

  it("settles a paid quote and returns the settled payload", async () => {
    mockMemory = createManagedVeniceMemoryDb({ managed_venice_token_quotes: [quoteRow()] });
    rpc.addTransfer({ txHash: "0xpaid", amountRaw: QUOTED, block: blockAt(-4 * 60_000), to: TEST_DEPOSIT_ADDRESS });

    const response = await check();
    const payload = await body(response);

    expect(response.status).toBe(200);
    expect(payload.data).toMatchObject({
      status: "settled",
      transactionHash: "0xpaid",
      quote: expect.objectContaining({ id: "quote_1", status: "settled", transactionHash: "0xpaid" }),
    });
    expect(mockMemory.tables.managed_venice_token_lots).toHaveLength(1);
  });

  it("returns cancelled once an unpaid quote's window + grace has been fully scanned", async () => {
    mockMemory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [
        quoteRow({ quoted_at: isoAt(-3 * 3_600_000), expires_at: isoAt(-3 * 3_600_000 + 20 * 60_000) }),
      ],
    });

    const payload = await body(await check());

    expect(payload.data).toMatchObject({
      status: "cancelled",
      quote: expect.objectContaining({ status: "cancelled" }),
    });
    expect(mockMemory.tables.managed_venice_token_quotes[0].status).toBe("cancelled");
  });

  it("returns manual_review_required for an in-window over-ceiling transfer", async () => {
    mockMemory = createManagedVeniceMemoryDb({ managed_venice_token_quotes: [quoteRow()] });
    rpc.addTransfer({ txHash: "0xfat", amountRaw: QUOTED * 3n, block: blockAt(-4 * 60_000), to: TEST_DEPOSIT_ADDRESS });

    const payload = await body(await check());

    expect(payload.data).toMatchObject({ status: "manual_review_required" });
    expect(mockMemory.tables.managed_venice_reconciliation_items).toHaveLength(1);
  });

  it("maps transaction_already_claimed to the safe no_match state without leaking the other quote's tx", async () => {
    // Legacy poisoning: this quote holds a lot whose tx another quote claimed.
    mockMemory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [
        quoteRow({ id: "quote_other", deposit_address: "0x000000000000000000000000000000000000cafe", transaction_hash: "0xtaken", status: "settled" }),
        quoteRow(),
      ],
    });
    mockMemory.insertRow("managed_venice_token_lots", {
      account_id: "account_1",
      user_id: "user_1",
      quote_id: "quote_1",
      source: "hermesos_deposit",
      token_amount_raw: QUOTED.toString(),
      remaining_token_amount_raw: QUOTED.toString(),
      snapshot_price_usd: "0.05",
      original_value_micro_usd: 60_000_000,
      remaining_value_micro_usd: 60_000_000,
      quote_source: "dexscreener",
      quoted_at: isoAt(-5 * 60_000),
      transaction_hash: "0xtaken",
      status: "active",
      metadata: { observedAt: isoAt(-4 * 60_000) },
    });

    const payload = await body(await check());

    expect(payload.data).toEqual({
      status: "no_match",
      quote: expect.objectContaining({ id: "quote_1", status: "active", transactionHash: null }),
    });
    expect(JSON.stringify(payload.data)).not.toContain("0xtaken");
  });

  it("fails safely when Base rejects the scan", async () => {
    mockMemory = createManagedVeniceMemoryDb({ managed_venice_token_quotes: [quoteRow()] });
    rpc.failNext({
      method: "eth_getLogs",
      status: 413,
      body: { jsonrpc: "2.0", id: 1, error: { code: -32614, message: "eth_getLogs is limited to a 2,000 range" } },
    });

    const response = await check();

    expect(response.status).toBe(500);
    expect((await body(response)).error).toBe("Failed to check the managed Venice top-up.");
    expect(mockMemory.tables.managed_venice_token_quotes[0].status).toBe("active");
  });
});
