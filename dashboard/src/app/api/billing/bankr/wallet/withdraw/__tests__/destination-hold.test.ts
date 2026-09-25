/** @jest-environment node */
/**
 * End to end through the lock-wallet withdraw route and the real withdraw
 * code: while the saved withdraw address is inside its cooldown the route
 * answers 422 with when it opens, and nothing is claimed, minted or sent.
 * Before this rule, the same request emptied the lock wallet into an address
 * saved a minute earlier.
 */
import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

const mockClaimInserts: unknown[] = [];
const mockBankrCalls: string[] = [];

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/billing/billing-v2-availability", () => ({
  BILLING_V2_UNAVAILABLE_MESSAGE: "unavailable",
  isBillingV2ServerEnabled: () => true,
}));
jest.mock("@/lib/rate-limit", () => ({ enforceRateLimit: () => ({ success: true }), getIP: () => "127.0.0.1" }));
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => ({
      insert: (row: unknown) => {
        mockClaimInserts.push(row);
        return { select: () => ({ single: async () => ({ data: { id: "claim_1" }, error: null }) }) };
      },
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
  },
}));
jest.mock("@/lib/billing/withdraw-address", () => ({
  getUserWithdrawAddress: jest.fn(async () => ({
    userId: "user_1",
    address: "0x1111111111111111111111111111111111111111",
    normalizedAddress: "0x1111111111111111111111111111111111111111",
    network: "base",
    acknowledgedResponsibility: true,
    // Saved ten minutes ago.
    setAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  })),
}));
jest.mock("@/lib/billing/token-holdings", () => ({
  ...jest.requireActual("@/lib/billing/token-holdings"),
  getHermesLockWallet: jest.fn(async () => ({ id: "lock", address: "0x00000000000000000000000000000000000010c4" })),
  fetchHermesTokenBalance: jest.fn(async () => ({ balanceRaw: "5000000000000000000000000", balanceDisplay: "5000000" })),
  refreshPrimaryHermesTokenHolding: jest.fn(),
}));
jest.mock("@/lib/billing/bankr-deposit-wallets", () => ({
  getBankrDepositWalletCredentialForUser: jest.fn(async () => ({ bankrWalletId: "bw_1" })),
}));
jest.mock("@/lib/billing/bankr-wallets", () => ({
  ...jest.requireActual("@/lib/billing/bankr-wallets"),
  getBankrPartnerConfig: () => ({ partnerKey: "partner", apiBaseUrl: "https://bankr.test" }),
}));
jest.mock("@/lib/billing/treasury-gas", () => ({
  ensureWalletHasGas: jest.fn(async () => ({ status: "already_funded" })),
}));
jest.mock("@/lib/billing/token-tier-eligibility", () => ({
  evaluateAndRecordTokenTierEligibility: jest.fn(),
  holdTierBreachesUntil: jest.fn(),
  clearTierBreachHold: jest.fn(),
}));

import { POST } from "../route";

const originalFetch = global.fetch;

beforeEach(() => {
  mockClaimInserts.length = 0;
  mockBankrCalls.length = 0;
  (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_1" });
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    mockBankrCalls.push(String(input));
    return new Response(JSON.stringify({ apiKey: "k", txHash: `0x${"ab".repeat(32)}` }), { status: 200 });
  }) as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

it("refuses a withdraw to an address saved minutes ago and sends nothing", async () => {
  const response = await POST(
    new NextRequest("http://localhost/api/billing/bankr/wallet/withdraw", { method: "POST", body: "{}" })
  );
  const body = await response.json();

  expect(response.status).toBe(422);
  expect(body.success).toBe(false);
  expect(body.error).toMatch(/withdraw address was saved less than 24 hours ago/);
  expect(mockClaimInserts).toEqual([]);
  expect(mockBankrCalls).toEqual([]);
});
