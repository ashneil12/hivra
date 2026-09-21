import { NextRequest } from "next/server";

import { GET } from "../route";
import { reconcilePendingCryptoTopUps } from "@/lib/billing/crypto-reconciliation";
import { sweepPendingCreditDepositReceipts } from "@/lib/billing/credit-deposit-sweep";
import { sweepPendingManagedVeniceTokenQuotes } from "@/lib/billing/managed-venice-token-sweep";

jest.mock("@/lib/billing/crypto-reconciliation", () => ({
  reconcilePendingCryptoTopUps: jest.fn(),
}));

jest.mock("@/lib/billing/credit-deposit-sweep", () => ({
  sweepPendingCreditDepositReceipts: jest.fn(),
}));

jest.mock("@/lib/billing/managed-venice-token-sweep", () => ({
  sweepPendingManagedVeniceTokenQuotes: jest.fn(),
}));

describe("GET /api/cron/reconcile-crypto-topups", () => {
  const originalEnv = process.env;

  const reconciliationPayload = {
    checked: 2,
    settled: 1,
    noMatch: 1,
    underconfirmed: 0,
    invalidIntent: 0,
    failed: 0,
    results: [
      {
        status: "settled",
        referenceId: "bankr_crypto_topup:one",
        transactionHash: "0xabc123",
        inserted: true,
        balance: 1000,
      },
      {
        status: "no_match",
        referenceId: "bankr_crypto_topup:two",
      },
    ],
  };

  const sweepPayload = {
    checked: 1,
    swept: 1,
    failed: 0,
    skipped: 0,
    noTreasury: 0,
    results: [
      {
        receiptId: "receipt-1",
        userId: "user-1",
        outcome: "swept",
        txHash: "0xsweep",
        amountSweptDisplay: "10",
      },
    ],
  };

  const managedVeniceSweepPayload = {
    checked: 1,
    swept: 1,
    failed: 0,
    skipped: 0,
    noTreasury: 0,
    results: [
      {
        quoteId: "quote-1",
        userId: "user-1",
        outcome: "swept",
        txHash: "0xvenicesweep",
        amountSweptDisplay: "1000",
      },
    ],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, CRON_SECRET: "cron-secret" };
    (reconcilePendingCryptoTopUps as jest.Mock).mockResolvedValue(reconciliationPayload);
    (sweepPendingCreditDepositReceipts as jest.Mock).mockResolvedValue(sweepPayload);
    (sweepPendingManagedVeniceTokenQuotes as jest.Mock).mockResolvedValue(managedVeniceSweepPayload);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const makeRequest = (
    authorization?: string,
    url = "http://localhost/api/cron/reconcile-crypto-topups"
  ) =>
    new Request(url, {
      headers: authorization ? { authorization } : {},
    }) as unknown as NextRequest;

  it("rejects requests without the cron secret", async () => {
    const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
    expect(reconcilePendingCryptoTopUps).not.toHaveBeenCalled();
    expect(sweepPendingCreditDepositReceipts).not.toHaveBeenCalled();
    expect(sweepPendingManagedVeniceTokenQuotes).not.toHaveBeenCalled();

    consoleWarnSpy.mockRestore();
  });

  it("rejects requests when the cron secret is not configured", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    process.env = { ...originalEnv, CRON_SECRET: "" };

    const response = await GET(makeRequest("Bearer cron-secret"));
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Cron secret is not configured");
    expect(reconcilePendingCryptoTopUps).not.toHaveBeenCalled();
    expect(sweepPendingCreditDepositReceipts).not.toHaveBeenCalled();
    expect(sweepPendingManagedVeniceTokenQuotes).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it("reconciles pending crypto top-ups and sweeps credit plus managed Venice deposits with a safe limit", async () => {
    const response = await GET(makeRequest(
      "Bearer cron-secret",
      "http://localhost/api/cron/reconcile-crypto-topups?limit=25"
    ));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(reconcilePendingCryptoTopUps).toHaveBeenCalledWith({ limit: 25 });
    expect(sweepPendingCreditDepositReceipts).toHaveBeenCalledWith({ limit: 25 });
    expect(sweepPendingManagedVeniceTokenQuotes).toHaveBeenCalledWith({ limit: 25 });
    expect(json.data).toEqual({
      reconciliation: reconciliationPayload,
      sweep: sweepPayload,
      managedVeniceSweep: managedVeniceSweepPayload,
      // Honest top-level flag: false on a fully-successful run; true if either
      // treasury sweep threw (which is now also reported to the ops feed).
      sweepFailed: false,
    });
  });

  it("surfaces sweep errors as a sub-field without failing the whole route", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    (sweepPendingCreditDepositReceipts as jest.Mock).mockRejectedValueOnce(
      new Error("sweep-blew-up")
    );

    const response = await GET(makeRequest("Bearer cron-secret"));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.reconciliation).toEqual(reconciliationPayload);
    expect(json.data.sweep).toEqual({ error: "sweep-blew-up" });
    expect(json.data.managedVeniceSweep).toEqual(managedVeniceSweepPayload);

    consoleErrorSpy.mockRestore();
  });

  it("surfaces managed Venice sweep errors as a sub-field without failing the whole route", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    (sweepPendingManagedVeniceTokenQuotes as jest.Mock).mockRejectedValueOnce(
      new Error("managed-venice-sweep-blew-up")
    );

    const response = await GET(makeRequest("Bearer cron-secret"));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.reconciliation).toEqual(reconciliationPayload);
    expect(json.data.sweep).toEqual(sweepPayload);
    expect(json.data.managedVeniceSweep).toEqual({
      error: "managed-venice-sweep-blew-up",
    });

    consoleErrorSpy.mockRestore();
  });

  it("does not leak backend errors", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    (reconcilePendingCryptoTopUps as jest.Mock).mockRejectedValueOnce(
      new Error("rpc-url-secret should stay private")
    );

    const response = await GET(makeRequest("Bearer cron-secret"));
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Failed to reconcile crypto top-ups");
    expect(JSON.stringify(json)).not.toContain("rpc-url-secret");
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain("rpc-url-secret");

    consoleErrorSpy.mockRestore();
  });
});
