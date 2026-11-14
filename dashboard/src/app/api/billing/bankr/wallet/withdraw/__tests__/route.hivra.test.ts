/**
 * The asset field on the lock-wallet withdraw. An empty body still calls the
 * $HERMESOS withdraw exactly as before (no asset key); { asset: "HIVRA" } is
 * passed through, and the library's refusal while $HIVRA is not live comes
 * back as a 400; a $HIVRA exit re-evaluates tiers on every platform token and
 * a $HIVRA move writes no $HERMESOS breach hold.
 */
import { NextRequest } from "next/server";

const mockWithdrawAll = jest.fn();
const mockRefreshVerified = jest.fn();
const mockRefreshPrimary = jest.fn();
const mockEvaluate = jest.fn();
const mockHold = jest.fn();

jest.mock("@/lib/billing/billing-v2-availability", () => ({
  BILLING_V2_UNAVAILABLE_MESSAGE: "Billing v2 is currently unavailable.",
  isBillingV2ServerEnabled: () => true,
}));
jest.mock("@/lib/billing/bankr-withdraw", () => ({
  withdrawAllHermesTokensForUser: (...args: unknown[]) => mockWithdrawAll(...args),
  getSelfCustodyPrimaryWallet: jest.fn(),
  waitForTransferReceipt: jest.fn(async () => "pending"),
}));
jest.mock("@/lib/billing/token-tier-eligibility", () => ({
  evaluateAndRecordTokenTierEligibility: (...args: unknown[]) => mockEvaluate(...args),
  holdTierBreachesUntil: (...args: unknown[]) => mockHold(...args),
  clearTierBreachHold: jest.fn(async () => undefined),
}));
jest.mock("@/lib/billing/token-holdings", () => ({
  getHermesLockWallet: jest.fn(),
  fetchHermesTokenBalance: jest.fn(),
  refreshPrimaryHermesTokenHolding: (...args: unknown[]) => mockRefreshPrimary(...args),
  refreshPrimaryVerifiedTokenHoldings: (...args: unknown[]) => mockRefreshVerified(...args),
}));
jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn(async () => ({ userId: "user_a" })) }));
jest.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: jest.fn(() => ({ success: true })),
  getIP: jest.fn(() => "127.0.0.1"),
}));

import { POST } from "../route";

function makeReq(body: unknown): NextRequest {
  return new Request("http://localhost/api/billing/bankr/wallet/withdraw", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const submitted = {
  status: "submitted",
  txHash: "0xabc",
  amountRaw: "7000000000000000000",
  amountDisplay: "7",
  recipientAddress: "0x1111111111111111111111111111111111111111",
};

beforeEach(() => {
  jest.clearAllMocks();
});

it("calls the $HERMESOS withdraw with no asset when the body names none", async () => {
  mockWithdrawAll.mockResolvedValueOnce({ status: "no_balance" });
  const response = await POST(makeReq({}));
  expect(response.status).toBe(422);
  expect((await response.json()).error).toBe("No $HERMESOS balance to withdraw.");
  expect(mockWithdrawAll.mock.calls[0][0]).not.toHaveProperty("asset");
});

it("rejects an unknown asset before withdrawing anything", async () => {
  const response = await POST(makeReq({ asset: "USDC" }));
  expect(response.status).toBe(400);
  expect(mockWithdrawAll).not.toHaveBeenCalled();
});

it("answers 400 when $HIVRA is not live yet", async () => {
  mockWithdrawAll.mockResolvedValueOnce({
    status: "asset_unavailable",
    errorMessage: "$HIVRA withdrawals open once $HIVRA is live.",
  });
  const response = await POST(makeReq({ asset: "HIVRA" }));
  expect(response.status).toBe(400);
  expect((await response.json()).error).toBe("$HIVRA withdrawals open once $HIVRA is live.");
  expect(mockWithdrawAll.mock.calls[0][0]).toMatchObject({ userId: "user_a", asset: "HIVRA" });
});

it("names $HIVRA when the lock wallet holds none", async () => {
  mockWithdrawAll.mockResolvedValueOnce({ status: "no_balance" });
  const response = await POST(makeReq({ asset: "HIVRA" }));
  expect(response.status).toBe(422);
  expect((await response.json()).error).toBe("No $HIVRA balance to withdraw.");
});

it("re-evaluates tiers on every platform token after a $HIVRA exit", async () => {
  mockWithdrawAll.mockResolvedValueOnce(submitted);
  const balances = { hermesos: 5n, hivra: 0n };
  mockRefreshVerified.mockResolvedValueOnce({ status: "refreshed", snapshot: null, snapshots: [], balances });

  const response = await POST(makeReq({ asset: "HIVRA" }));

  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.data).toMatchObject({
    status: "submitted",
    asset: "HIVRA",
    amountRaw: "7000000000000000000",
    postWithdrawEligibility: { evaluated: true, balanceRaw: "0" },
  });
  expect(mockEvaluate).toHaveBeenCalledWith({ userId: "user_a", balances });
  expect(mockRefreshPrimary).not.toHaveBeenCalled();
});

it("writes no $HERMESOS breach hold for a $HIVRA move to the verified wallet", async () => {
  mockWithdrawAll.mockResolvedValueOnce(submitted);
  const response = await POST(makeReq({ asset: "HIVRA", destination: "verified_wallet" }));
  expect(response.status).toBe(200);
  expect(mockWithdrawAll.mock.calls[0][0].beforeTransfer).toBeUndefined();
  expect(mockHold).not.toHaveBeenCalled();
});

it("still holds breaches for a $HERMESOS move to the verified wallet", async () => {
  mockWithdrawAll.mockResolvedValueOnce(submitted);
  await POST(makeReq({ destination: "verified_wallet" }));
  expect(typeof mockWithdrawAll.mock.calls[0][0].beforeTransfer).toBe("function");
});
