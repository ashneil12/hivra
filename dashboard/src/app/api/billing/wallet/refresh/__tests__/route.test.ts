/**
 * Per-user balance refresh endpoint. Locks down:
 *   - 401 / 404 gates fire before any work
 *   - On success, BOTH the snapshot refresh AND eligibility re-eval
 *     run; eligibility errors don't fail the response (snapshot is
 *     authoritative)
 *   - Internal errors don't leak to the response body
 */

const mockRefresh = jest.fn();
const mockEvaluate = jest.fn();
const mockBillingEnabled = jest.fn(() => true);

jest.mock("@/lib/billing/billing-v2-availability", () => ({
  BILLING_V2_UNAVAILABLE_MESSAGE: "Billing v2 is currently unavailable.",
  isBillingV2ServerEnabled: () => mockBillingEnabled(),
}));

jest.mock("@/lib/billing/token-holdings", () => ({
  refreshPrimaryHermesTokenHolding: (...args: unknown[]) => mockRefresh(...args),
}));

jest.mock("@/lib/billing/token-tier-eligibility", () => ({
  evaluateAndRecordTokenTierEligibility: (...args: unknown[]) => mockEvaluate(...args),
}));

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { POST } from "../route";

function createRequest() {
  return new NextRequest("http://localhost/api/billing/wallet/refresh", {
    method: "POST",
  });
}

describe("POST /api/billing/wallet/refresh", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBillingEnabled.mockReturnValue(true);
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_a" });
  });

  it("returns 404 when billing v2 is disabled", async () => {
    mockBillingEnabled.mockReturnValueOnce(false);
    const response = await POST(createRequest());
    expect(response.status).toBe(404);
  });

  it("returns 401 when unauthenticated", async () => {
    (auth as unknown as jest.Mock).mockResolvedValueOnce({ userId: null });
    const response = await POST(createRequest());
    expect(response.status).toBe(401);
  });

  it("returns 404 when refresh has no verified wallet", async () => {
    mockRefresh.mockResolvedValueOnce({ status: "no_verified_wallet", snapshot: null });
    const response = await POST(createRequest());
    expect(response.status).toBe(404);
  });

  it("returns 200 + runs eligibility re-eval against the fresh balance", async () => {
    mockRefresh.mockResolvedValueOnce({
      status: "refreshed",
      snapshot: {
        id: "snap_x",
        balanceRaw: "39022814000000000000000000",
        qualifiesBaseTier: true,
      },
    });
    mockEvaluate.mockResolvedValueOnce({ configured: true });

    const response = await POST(createRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.snapshotId).toBe("snap_x");
    expect(mockEvaluate).toHaveBeenCalledWith({
      userId: "user_a",
      currentBalance: 39022814000000000000000000n,
    });
  });

  it("still returns 200 if eligibility re-eval throws (snapshot is the source of truth)", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockRefresh.mockResolvedValueOnce({
      status: "refreshed",
      snapshot: { id: "snap_y", balanceRaw: "0", qualifiesBaseTier: false },
    });
    mockEvaluate.mockRejectedValueOnce(new Error("downstream_db_failed"));

    const response = await POST(createRequest());
    expect(response.status).toBe(200);
    consoleErrorSpy.mockRestore();
  });

  it("does not leak the underlying error message", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockRefresh.mockRejectedValueOnce(new Error("internal_secret_should_not_leak"));
    const response = await POST(createRequest());
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain("internal_secret_should_not_leak");
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain(
      "internal_secret_should_not_leak"
    );
    consoleErrorSpy.mockRestore();
  });
});
