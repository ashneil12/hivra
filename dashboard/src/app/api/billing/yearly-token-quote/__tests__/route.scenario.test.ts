/** @jest-environment node */
/**
 * POST /api/billing/yearly-token-quote against the real quote module and an
 * in-memory Supabase that enforces yearly_token_quotes_user_tier_active_idx.
 * A double-click or retry sends two mints for the same tier, and both pass the
 * "already active?" check before either inserts (post-deploy review of PR #37,
 * 2026-09-22).
 */

import { NextRequest } from "next/server";

import type { HermesPriceQuote } from "@/lib/billing/price-feed";
import {
  createYearlyTokenMemoryDb,
  depositCredentialRow,
  type YearlyTokenMemoryDb,
} from "@/test-utils/yearly-token-memory-db";

const mockState: { memory: YearlyTokenMemoryDb | null; priceGate: (() => Promise<void>) | null } = {
  memory: null,
  priceGate: null,
};

const mockPriceQuote: HermesPriceQuote = {
  priceUsd: "0.000002582",
  lastUpdatedAt: 1_790_000_000,
  source: "dexscreener",
  raw: null,
};

jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockState.memory?.db ?? null;
  },
}));

jest.mock("@/lib/billing/billing-v2-availability", () => ({
  BILLING_V2_UNAVAILABLE_MESSAGE: "Billing v2 is currently unavailable.",
  isBillingV2ServerEnabled: () => true,
}));

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(async () => ({ userId: "user_1" })),
}));

jest.mock("@/lib/billing/price-feed", () => ({
  ...jest.requireActual("@/lib/billing/price-feed"),
  fetchHermesPriceUsd: async () => {
    await mockState.priceGate?.();
    return mockPriceQuote;
  },
  // Yearly quotes price the quote's own platform token.
  fetchPlatformTokenPriceUsd: async () => {
    await mockState.priceGate?.();
    return mockPriceQuote;
  },
}));

import { POST } from "../route";

function mint(tier: string) {
  return POST(
    new Request("http://localhost/api/billing/yearly-token-quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier }),
    }) as unknown as NextRequest
  );
}

/** Holds every caller until `parties` of them have arrived. */
function barrier(parties: number) {
  let arrived = 0;
  let release!: () => void;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived === parties) release();
    await open;
  };
}

beforeEach(() => {
  mockState.memory = createYearlyTokenMemoryDb({
    bankr_deposit_wallet_credentials: [depositCredentialRow()],
  });
  mockState.priceGate = null;
});

it("returns the one quote the database kept to both of two concurrent mints", async () => {
  const memory = mockState.memory!;
  // The price is fetched only after the "already active?" check found nothing,
  // so holding both requests here puts both past that check before either inserts.
  mockState.priceGate = barrier(2);

  const responses = await Promise.all([mint("pro"), mint("pro")]);
  const bodies = await Promise.all(responses.map((response) => response.json()));

  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  const active = memory.tables.yearly_token_quotes.filter((row) => row.status === "active");
  expect(active).toHaveLength(1);
  expect(bodies.map((body) => body.data.id)).toEqual([active[0].id, active[0].id]);
  expect(bodies[1].data).toEqual(bodies[0].data);
  // The race really happened: the second insert hit the unique index.
  expect(
    memory.calls.filter((call) => call.table === "yearly_token_quotes" && call.kind === "insert_23505")
  ).toHaveLength(1);
});

it("still fails when the unique index rejects the insert but no active quote is left to return", async () => {
  const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  mockState.memory!.failNext({
    table: "yearly_token_quotes",
    op: "insert",
    error: {
      code: "23505",
      message: 'duplicate key value violates unique constraint "yearly_token_quotes_user_tier_active_idx"',
    },
  });

  const response = await mint("pro");

  expect(response.status).toBe(500);
  expect(mockState.memory!.tables.yearly_token_quotes).toEqual([]);
  consoleErrorSpy.mockRestore();
});
