/**
 * Regression tests for the withdraw endpoint. Locks down the contract
 * with the dashboard:
 *   - 401 when unauthenticated
 *   - 404 when billing v2 disabled
 *   - 422 when there's no on-chain balance
 *   - 422 when no originating wallet can be derived from chain history
 *   - 200 + the result shape on success
 */

import { NextRequest } from "next/server";

const mockWithdrawAll = jest.fn();
const mockBillingEnabled = jest.fn(() => true);
const mockGetHermesLockWallet = jest.fn();
const mockFetchHermesTokenBalance = jest.fn();
const mockRefreshPrimaryHolding = jest.fn();
const mockEvaluateAndRecord = jest.fn();

jest.mock("@/lib/billing/billing-v2-availability", () => ({
  BILLING_V2_UNAVAILABLE_MESSAGE: "Billing v2 is currently unavailable.",
  isBillingV2ServerEnabled: () => mockBillingEnabled(),
}));

jest.mock("@/lib/billing/bankr-withdraw", () => ({
  withdrawAllHermesTokensForUser: (...args: unknown[]) => mockWithdrawAll(...args),
}));

jest.mock("@/lib/billing/token-tier-eligibility", () => ({
  evaluateAndRecordTokenTierEligibility: (...args: unknown[]) =>
    mockEvaluateAndRecord(...args),
}));

jest.mock("@/lib/billing/token-holdings", () => ({
  getHermesLockWallet: (...args: unknown[]) => mockGetHermesLockWallet(...args),
  fetchHermesTokenBalance: (...args: unknown[]) =>
    mockFetchHermesTokenBalance(...args),
  refreshPrimaryHermesTokenHolding: (...args: unknown[]) =>
    mockRefreshPrimaryHolding(...args),
}));

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

const mockEnforceRateLimit = jest.fn(() => ({ success: true }));
jest.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...(args as [])),
  getIP: jest.fn(() => "127.0.0.1"),
}));

import { auth } from "@clerk/nextjs/server";
import { POST } from "../route";

function makeReq(body: unknown = {}): NextRequest {
  return new Request("http://localhost/api/billing/bankr/wallet/withdraw", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe("POST /api/billing/bankr/wallet/withdraw", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBillingEnabled.mockReturnValue(true);
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_a" });
  });

  it("returns 404 when billing v2 is disabled", async () => {
    mockBillingEnabled.mockReturnValueOnce(false);
    const response = await POST(makeReq());
    expect(response.status).toBe(404);
  });

  it("returns 401 when unauthenticated", async () => {
    (auth as unknown as jest.Mock).mockResolvedValueOnce({ userId: null });
    const response = await POST(makeReq());
    expect(response.status).toBe(401);
  });

  it("returns 404 when the user has no lock wallet", async () => {
    mockWithdrawAll.mockResolvedValueOnce({ status: "no_wallet" });
    const response = await POST(makeReq());
    expect(response.status).toBe(404);
  });

  it("returns 422 when the lock wallet is empty", async () => {
    mockWithdrawAll.mockResolvedValueOnce({ status: "no_balance" });
    const response = await POST(makeReq());
    expect(response.status).toBe(422);
  });

  it("returns 422 when the user has not yet set a withdraw address", async () => {
    mockWithdrawAll.mockResolvedValueOnce({ status: "no_withdraw_address" });
    const response = await POST(makeReq());
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error).toMatch(/withdraw destination/i);
  });

  it("returns 503 when Bankr partner config is missing", async () => {
    mockWithdrawAll.mockResolvedValueOnce({ status: "not_configured" });
    const response = await POST(makeReq());
    expect(response.status).toBe(503);
  });

  it("returns 502 when the Bankr transfer fails — withholds the underlying error from the response body", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockWithdrawAll.mockResolvedValueOnce({
      status: "transfer_failed",
      errorMessage: "bankr_internal_secret_should_not_leak",
    });
    const response = await POST(makeReq());
    const body = await response.json();
    expect(response.status).toBe(502);
    expect(JSON.stringify(body)).not.toContain("bankr_internal_secret_should_not_leak");
    // Diagnostic logging is gated on NODE_ENV !== 'test', so the test
    // run never sees the secret in console.error.
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain(
      "bankr_internal_secret_should_not_leak"
    );
    consoleErrorSpy.mockRestore();
  });

  it("returns 200 with status=submitted on success", async () => {
    mockWithdrawAll.mockResolvedValueOnce({
      status: "submitted",
      txHash: "0xabcdef",
      amountRaw: "500000000000000000000000",
      amountDisplay: "500000",
      recipientAddress: "0x1234567890abcdef1234567890abcdef12345678",
    });
    mockRefreshPrimaryHolding.mockResolvedValueOnce({
      status: "refreshed",
      snapshot: { id: "snap_1", balanceRaw: "0", qualifiesBaseTier: false },
    });
    mockEvaluateAndRecord.mockResolvedValueOnce({ configured: true });

    const response = await POST(makeReq({ expectedRecipient: "0xabc" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      status: "submitted",
      txHash: "0xabcdef",
      amountDisplay: "500000",
      recipientAddress: "0x1234567890abcdef1234567890abcdef12345678",
    });
  });

  it("refreshes the snapshot AND re-runs eligibility after a successful withdraw", async () => {
    mockWithdrawAll.mockResolvedValueOnce({
      status: "submitted",
      txHash: "0xfeed",
      amountDisplay: "500000",
      recipientAddress: "0xrecipient",
    });
    mockRefreshPrimaryHolding.mockResolvedValueOnce({
      status: "refreshed",
      snapshot: { id: "snap_x", balanceRaw: "0", qualifiesBaseTier: false },
    });
    mockEvaluateAndRecord.mockResolvedValueOnce({ configured: true });

    await POST(makeReq({}));

    // Snapshot refresh runs first so the wallet eligibility API reads
    // the post-withdraw balance, not the stale pre-withdraw row.
    expect(mockRefreshPrimaryHolding).toHaveBeenCalledWith({ userId: "user_a" });
    expect(mockEvaluateAndRecord).toHaveBeenCalledTimes(1);
    expect(mockEvaluateAndRecord).toHaveBeenCalledWith({
      userId: "user_a",
      currentBalance: 0n,
    });
  });

  it("falls back to direct chain read when refresh has no verified wallet", async () => {
    mockWithdrawAll.mockResolvedValueOnce({
      status: "submitted",
      txHash: "0xfeed",
      amountDisplay: "500000",
      recipientAddress: "0xrecipient",
    });
    mockRefreshPrimaryHolding.mockResolvedValueOnce({
      status: "no_verified_wallet",
      snapshot: null,
    });
    mockGetHermesLockWallet.mockResolvedValueOnce({ address: "0x1343" });
    mockFetchHermesTokenBalance.mockResolvedValueOnce({ balanceRaw: "0" });
    mockEvaluateAndRecord.mockResolvedValueOnce({ configured: true });

    const response = await POST(makeReq({}));
    expect(response.status).toBe(200);
    expect(mockEvaluateAndRecord).toHaveBeenCalledTimes(1);
  });

  it("does not 500 if the post-withdraw eligibility re-check throws", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockWithdrawAll.mockResolvedValueOnce({
      status: "submitted",
      txHash: "0xfeed",
      amountDisplay: "500000",
      recipientAddress: "0xrecipient",
    });
    mockRefreshPrimaryHolding.mockRejectedValueOnce(new Error("downstream_db_failed"));

    const response = await POST(makeReq({}));
    expect(response.status).toBe(200);
    consoleErrorSpy.mockRestore();
  });

  it("forwards expectedRecipient through to the underlying withdraw", async () => {
    mockWithdrawAll.mockResolvedValueOnce({
      status: "submitted",
      txHash: "0x",
      amountDisplay: "0",
      recipientAddress: "0x",
    });

    await POST(makeReq({ expectedRecipient: "0xCAFE" }));

    expect(mockWithdrawAll).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRecipient: "0xCAFE", userId: "user_a" })
    );
  });

  it("returns 429 when the rate limit fires", async () => {
    mockEnforceRateLimit.mockReturnValueOnce({ success: false });

    const response = await POST(makeReq({}));
    expect(response.status).toBe(429);
    // Critical: must NOT have invoked the underlying withdraw — that mints
    // a Bankr API key and submits a transfer.
    expect(mockWithdrawAll).not.toHaveBeenCalled();
  });

  it("rejects a second concurrent POST with 409 instead of double-submitting", async () => {
    // Pause the underlying withdraw so we can fire two POSTs while the
    // first is in flight. The second must short-circuit on the in-flight
    // lock — NOT call withdrawAllHermesTokensForUser a second time.
    let release: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    mockWithdrawAll.mockReturnValueOnce(pending);

    const first = POST(makeReq({ expectedRecipient: "0xA" }));
    // Yield enough microtasks for `first` to claim the in-flight lock
    // and (eventually) reach the withdraw call.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const second = await POST(makeReq({ expectedRecipient: "0xB" }));

    expect(second.status).toBe(409);

    // Let the first one finish so the test process doesn't hang.
    release({
      status: "submitted",
      txHash: "0x",
      amountDisplay: "0",
      recipientAddress: "0x",
    });
    await first;

    // After both POSTs have fully settled, the underlying withdraw must
    // have been invoked exactly ONCE total — confirming the second POST
    // short-circuited on the in-flight lock and never minted a second
    // Bankr API key / submitted a second transfer.
    expect(mockWithdrawAll).toHaveBeenCalledTimes(1);
    expect(mockWithdrawAll).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRecipient: "0xA" })
    );
  });
});
