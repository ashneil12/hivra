import { NextRequest } from "next/server";
import { POST } from "../route";
import { reconcileCryptoTopUpByReference } from "@/lib/billing/crypto-reconciliation";

jest.mock("@/lib/billing/crypto-reconciliation", () => ({
  reconcileCryptoTopUpByReference: jest.fn(),
}));

describe("POST /api/internal/billing/crypto/top-up/settle", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, BILLING_SETTLEMENT_SECRET: "settlement-secret" };
    (reconcileCryptoTopUpByReference as jest.Mock).mockResolvedValue({
      status: "settled",
      referenceId: "bankr_crypto_topup:test",
      transactionHash: "0xabc123",
      inserted: true,
      balance: 1500,
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function createRequest(body: Record<string, unknown> = {
    referenceId: "bankr_crypto_topup:test",
    transactionHash: "0xabc123",
    detectedAt: "2026-04-24T12:02:00.000Z",
  }, authorization = "Bearer settlement-secret") {
    return new NextRequest("http://localhost/api/internal/billing/crypto/top-up/settle", {
      method: "POST",
      body: JSON.stringify(body),
      headers: new Headers({
        "content-type": "application/json",
        authorization,
      }),
    });
  }

  function createRawRequest(body: string, authorization = "Bearer settlement-secret") {
    return new NextRequest("http://localhost/api/internal/billing/crypto/top-up/settle", {
      method: "POST",
      body,
      headers: new Headers({
        "content-type": "application/json",
        authorization,
      }),
    });
  }

  it("rejects requests without the settlement secret", async () => {
    const response = await POST(createRequest(undefined, "Bearer wrong-secret"));

    expect(response.status).toBe(401);
    expect(reconcileCryptoTopUpByReference).not.toHaveBeenCalled();
  });

  it("rejects requests when no settlement secret is configured", async () => {
    process.env = { ...originalEnv, BILLING_SETTLEMENT_SECRET: "", CRON_SECRET: "" };

    const response = await POST(createRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Settlement secret is not configured");
    expect(reconcileCryptoTopUpByReference).not.toHaveBeenCalled();
  });

  it("does NOT fall back to CRON_SECRET (billing-auth blast-radius scoping)", async () => {
    // Regression: previously the resolver tried CRON_SECRET when
    // BILLING_SETTLEMENT_SECRET was unset. That widened the keys-that-can-
    // credit-user-balances set to "everything with CRON_SECRET" — every
    // Vercel cron and operator debug shell. This intent must stay scoped
    // to the bankr_reconciler bearer.
    process.env = { ...originalEnv, BILLING_SETTLEMENT_SECRET: "", CRON_SECRET: "the-cron-secret" };

    const response = await POST(createRequest(undefined, "Bearer the-cron-secret"));

    expect(response.status).toBe(500);
    expect(reconcileCryptoTopUpByReference).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const response = await POST(createRawRequest("{bad"));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid JSON body");
    expect(reconcileCryptoTopUpByReference).not.toHaveBeenCalled();
  });

  it("settles only through on-chain verification, ignoring caller-supplied transfer details", async () => {
    const response = await POST(createRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({
      status: "settled",
      referenceId: "bankr_crypto_topup:test",
      transactionHash: "0xabc123",
      inserted: true,
      balance: 1500,
    });
    expect(reconcileCryptoTopUpByReference).toHaveBeenCalledWith({ referenceId: "bankr_crypto_topup:test" });
  });

  it("refuses a hash that differs from the transfer the intent was settled with", async () => {
    const response = await POST(
      createRequest({ referenceId: "bankr_crypto_topup:test", transactionHash: "0xsomething-else" })
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.status).toBe("transaction_mismatch");
    expect(body.transactionHash).toBe("0xabc123");
  });

  it("maps missing, closed, and unpaid intents to safe errors", async () => {
    (reconcileCryptoTopUpByReference as jest.Mock).mockResolvedValueOnce({
      status: "not_found",
      referenceId: "bankr_crypto_topup:test",
    });
    const missing = await POST(createRequest());
    expect(missing.status).toBe(404);

    (reconcileCryptoTopUpByReference as jest.Mock).mockResolvedValueOnce({
      status: "closed",
      referenceId: "bankr_crypto_topup:test",
      paymentStatus: "refunded",
    });
    const closed = await POST(createRequest());
    const closedBody = await closed.json();
    expect(closed.status).toBe(409);
    expect(closedBody.error).toBe("Crypto top-up intent is not settleable");
    expect(closedBody.paymentStatus).toBe("refunded");

    (reconcileCryptoTopUpByReference as jest.Mock).mockResolvedValueOnce({
      status: "no_match",
      referenceId: "bankr_crypto_topup:test",
    });
    const unpaid = await POST(createRequest());
    const unpaidBody = await unpaid.json();
    expect(unpaid.status).toBe(409);
    expect(unpaidBody.status).toBe("no_match");
  });

  it("does not leak backend errors", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    (reconcileCryptoTopUpByReference as jest.Mock).mockRejectedValueOnce(
      new Error("settlement-secret should stay private")
    );

    const response = await POST(createRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Failed to settle crypto top-up");
    expect(JSON.stringify(body)).not.toContain("settlement-secret");
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain("settlement-secret");

    consoleErrorSpy.mockRestore();
  });
});
