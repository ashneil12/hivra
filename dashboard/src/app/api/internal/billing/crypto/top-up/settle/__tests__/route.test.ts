import { NextRequest } from "next/server";
import { POST } from "../route";
import { settleCryptoTopUpIntent } from "@/lib/billing/crypto-topups";

jest.mock("@/lib/billing/crypto-topups", () => ({
  settleCryptoTopUpIntent: jest.fn(),
}));

describe("POST /api/internal/billing/crypto/top-up/settle", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, BILLING_SETTLEMENT_SECRET: "settlement-secret" };
    (settleCryptoTopUpIntent as jest.Mock).mockResolvedValue({
      status: "settled",
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
    expect(settleCryptoTopUpIntent).not.toHaveBeenCalled();
  });

  it("rejects requests when no settlement secret is configured", async () => {
    process.env = { ...originalEnv, BILLING_SETTLEMENT_SECRET: "", CRON_SECRET: "" };

    const response = await POST(createRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Settlement secret is not configured");
    expect(settleCryptoTopUpIntent).not.toHaveBeenCalled();
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
    expect(settleCryptoTopUpIntent).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const response = await POST(createRawRequest("{bad"));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid JSON body");
    expect(settleCryptoTopUpIntent).not.toHaveBeenCalled();
  });

  it("settles a crypto top-up with the internal actor", async () => {
    const response = await POST(createRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({
      status: "settled",
      inserted: true,
      balance: 1500,
    });
    expect(settleCryptoTopUpIntent).toHaveBeenCalledWith({
      referenceId: "bankr_crypto_topup:test",
      transactionHash: "0xabc123",
      detectedAt: "2026-04-24T12:02:00.000Z",
      actor: "bankr_reconciler",
    });
  });

  it("maps missing and non-settleable intents to safe errors", async () => {
    (settleCryptoTopUpIntent as jest.Mock).mockResolvedValueOnce({
      status: "not_found",
    });
    const missing = await POST(createRequest());
    expect(missing.status).toBe(404);

    (settleCryptoTopUpIntent as jest.Mock).mockResolvedValueOnce({
      status: "not_settleable",
      paymentStatus: "failed",
    });
    const failed = await POST(createRequest());
    const body = await failed.json();

    expect(failed.status).toBe(409);
    expect(body.error).toBe("Crypto top-up intent is not settleable");
    expect(body.paymentStatus).toBe("failed");
  });

  it("does not leak backend errors", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    (settleCryptoTopUpIntent as jest.Mock).mockRejectedValueOnce(
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
