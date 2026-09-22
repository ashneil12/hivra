/** @jest-environment node */
/**
 * Check-now against the real reconciler, an in-memory Supabase and a Base
 * chain fake: the user pays inside the quote window, the window closes, then
 * they press "Check now" (audit of 2026-09-22, YR-4 on the user path).
 */

import { NextRequest } from "next/server";

import {
  TEST_DEPOSIT_ADDRESS,
  TEST_TREASURY_ADDRESS,
  TEST_USER_ID,
  txHash,
  yearlyQuoteRow,
} from "@/test-utils/yearly-token-memory-db";
import { createYearlyTokenWorld, MINUTE_MS, type YearlyTokenWorld } from "@/test-utils/yearly-token-world";

const mockState: { world: YearlyTokenWorld | null } = { world: null };

jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockState.world?.memory.db ?? null;
  },
}));

jest.mock("@/lib/billing/billing-v2-availability", () => ({
  BILLING_V2_UNAVAILABLE_MESSAGE: "Billing v2 is currently unavailable.",
  isBillingV2ServerEnabled: () => true,
}));

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(async () => ({ userId: "user_1" })),
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
  reportOpsEvent: jest.fn(),
}));

import { POST } from "../route";

const REQUIRED = 1_000n * 10n ** 18n;
const originalFetch = global.fetch;
const originalEnv = { ...process.env };

function checkNow(body: unknown = {}) {
  return POST(
    new Request("http://localhost/api/billing/yearly-token-quote/check-now", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as unknown as NextRequest
  );
}

beforeEach(() => {
  process.env = { ...originalEnv, HERMES_TREASURY_ADDRESS: TEST_TREASURY_ADDRESS };
  delete process.env.HERMES_BASE_RPC_URL;
  delete process.env.BASE_RPC_URL;
  const world = createYearlyTokenWorld();
  mockState.world = world;
  global.fetch = world.chain.fetchImpl as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
  process.env = originalEnv;
});

it("activates a payment made inside the window when the user checks after the quote expired", async () => {
  const world = mockState.world!;
  world.memory.insertRow(
    "yearly_token_quotes",
    yearlyQuoteRow({
      tokens_required_raw: REQUIRED.toString(),
      quoted_at: world.at(-22 * MINUTE_MS),
      expires_at: world.at(-2 * MINUTE_MS),
      status: "active",
    })
  );
  world.pay({ tx: txHash(1), amountRaw: REQUIRED, offsetMs: -3 * MINUTE_MS });

  const response = await checkNow({ tier: "pro" });

  expect(response.status).toBe(200);
  expect(world.subscriptions()).toEqual([
    expect.objectContaining({
      user_id: TEST_USER_ID,
      status: "active",
      deposit_tx_hash: txHash(1),
      deposit_address: TEST_DEPOSIT_ADDRESS,
      sweep_status: "swept",
    }),
  ]);
  const body = await response.json();
  expect(body.data.summary.activated).toBe(1);
});

it("only reconciles the signed-in user's quotes", async () => {
  const world = mockState.world!;
  world.memory.insertRow(
    "yearly_token_quotes",
    yearlyQuoteRow({
      id: "yq_other",
      user_id: "user_other",
      tokens_required_raw: REQUIRED.toString(),
      quoted_at: world.at(-10 * MINUTE_MS),
      expires_at: world.at(10 * MINUTE_MS),
    })
  );
  world.pay({ tx: txHash(1), amountRaw: REQUIRED, offsetMs: -3 * MINUTE_MS });

  const response = await checkNow();

  expect(response.status).toBe(200);
  expect(world.subscriptions()).toHaveLength(0);
  expect(world.quote("yq_other")).toMatchObject({ status: "active" });
});
