import {
  createManagedVeniceMemoryDb,
  managedVeniceQuoteRow,
  type ManagedVeniceMemoryDb,
} from "@/test-utils/managed-venice-memory-db";
import { makeJsonRequest } from "@/test-utils/request";

// The bearer settle route runs the REAL claim-first settlement against an
// in-memory DB that enforces the production unique indexes.

let mockMemory: ManagedVeniceMemoryDb;

jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockMemory.db;
  },
}));

jest.mock("@/lib/logger", () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { POST } from "../route";

const SECRET = "settlement-secret";
const QUOTED = "1000000000000000000000";
const IN_WINDOW = "2026-05-16T10:21:00.000Z";

function settle(body: unknown, authorization: string | null = `Bearer ${SECRET}`) {
  return POST(
    makeJsonRequest("/api/billing/managed-venice/hermesos/settle", body, {
      headers: authorization ? { authorization } : {},
    })
  );
}

async function data(response: Response) {
  return ((await response.json()) as { data?: Record<string, unknown> }).data;
}

describe("POST /api/billing/managed-venice/hermesos/settle", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, MANAGED_VENICE_SETTLEMENT_SECRET: SECRET };
    mockMemory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [managedVeniceQuoteRow()],
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("refuses to run without a settlement secret and never falls back to CRON_SECRET", async () => {
    process.env = { ...originalEnv, MANAGED_VENICE_SETTLEMENT_SECRET: "", BILLING_SETTLEMENT_SECRET: "", CRON_SECRET: SECRET };

    const response = await settle({ quoteId: "quote_1", transactionHash: "0xpaid", tokenAmountRaw: QUOTED, observedAt: IN_WINDOW });

    expect(response.status).toBe(500);
    expect(mockMemory.tables.managed_venice_token_lots).toHaveLength(0);
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

  it("settles an in-window transfer and is idempotent on redelivery", async () => {
    const first = await settle({ quoteId: "quote_1", transactionHash: "0xpaid", tokenAmountRaw: QUOTED, observedAt: IN_WINDOW });
    const replay = await settle({ quoteId: "quote_1", transactionHash: "0xpaid", tokenAmountRaw: QUOTED, observedAt: IN_WINDOW });

    expect(first.status).toBe(200);
    expect(await data(first)).toEqual({ status: "settled", quoteId: "quote_1" });
    expect(await data(replay)).toEqual({ status: "settled", quoteId: "quote_1", idempotent: true });
    expect(mockMemory.tables.managed_venice_token_lots).toHaveLength(1);
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

    const response = await settle({ quoteId: "quote_1", transactionHash: "0xpaid", tokenAmountRaw: QUOTED, observedAt: IN_WINDOW });

    expect(response.status).toBe(200);
    expect(await data(response)).toEqual({ status: "transaction_already_claimed", quoteId: "quote_1" });
    expect(mockMemory.tables.managed_venice_token_lots).toHaveLength(0);
  });

  it("never re-reviews or settles a quote already in manual review; surfaces the new transfer once", async () => {
    mockMemory = createManagedVeniceMemoryDb({
      managed_venice_token_quotes: [managedVeniceQuoteRow({ status: "manual_review_required" })],
    });

    for (let delivery = 0; delivery < 2; delivery += 1) {
      const response = await settle({ quoteId: "quote_1", transactionHash: "0xlate", tokenAmountRaw: QUOTED, observedAt: "2026-05-16T11:00:00.000Z" });
      expect(await data(response)).toEqual({ status: "manual_review_required" });
    }

    expect(mockMemory.tables.managed_venice_token_quotes[0]).toMatchObject({
      status: "manual_review_required",
      transaction_hash: null,
    });
    expect(mockMemory.tables.managed_venice_reconciliation_items).toHaveLength(1);
  });

  it("returns a safe 500 when the quote does not exist", async () => {
    const response = await settle({ quoteId: "missing", transactionHash: "0xpaid", tokenAmountRaw: QUOTED, observedAt: IN_WINDOW });

    expect(response.status).toBe(500);
    expect(((await response.json()) as { error?: string }).error).toBe("Failed to settle managed Venice token quote.");
  });
});
