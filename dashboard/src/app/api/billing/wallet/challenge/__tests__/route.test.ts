import { NextRequest } from "next/server";
import { POST } from "../route";
import { auth } from "@clerk/nextjs/server";
import {
  createWalletVerificationChallenge,
  isWalletClaimedByAnotherAccount,
} from "@/lib/billing/wallet-verification";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {},
}));

jest.mock("@/lib/billing/wallet-verification", () => ({
  createWalletVerificationChallenge: jest.fn(),
  isWalletClaimedByAnotherAccount: jest.fn(),
}));

describe("POST /api/billing/wallet/challenge", () => {
  const userId = "user_123";
  const address = "0x000000000000000000000000000000000000dEaD";

  beforeEach(() => {
    jest.clearAllMocks();
    (auth as unknown as jest.Mock).mockResolvedValue({ userId });
    (isWalletClaimedByAnotherAccount as jest.Mock).mockResolvedValue(false);
    (createWalletVerificationChallenge as jest.Mock).mockResolvedValue({
      id: "challenge_123",
      address: "0x000000000000000000000000000000000000dead",
      normalizedAddress: "0x000000000000000000000000000000000000dead",
      chainId: 8453,
      message: "Hivra wallet verification\n\nSign this message.",
      status: "pending",
      expiresAt: "2026-04-24T12:10:00.000Z",
    });
  });

  function createRequest(body: Record<string, unknown> = { address, chainId: 8453 }) {
    return new NextRequest("http://localhost/api/billing/wallet/challenge", {
      method: "POST",
      body: JSON.stringify(body),
      headers: new Headers({ "content-type": "application/json" }),
    });
  }

  function createRawRequest(body: string) {
    return new NextRequest("http://localhost/api/billing/wallet/challenge", {
      method: "POST",
      body,
      headers: new Headers({ "content-type": "application/json" }),
    });
  }

  it("returns 401 when unauthorized", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });

    const response = await POST(createRequest());

    expect(response.status).toBe(401);
    expect(createWalletVerificationChallenge).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const response = await POST(createRawRequest("{bad"));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid JSON body");
  });

  it("rejects invalid wallet addresses before creating a challenge", async () => {
    const response = await POST(createRequest({ address: "not-a-wallet", chainId: 8453 }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid wallet address");
    expect(createWalletVerificationChallenge).not.toHaveBeenCalled();
  });

  it("rejects unsupported chains before creating a challenge", async () => {
    const response = await POST(createRequest({ address, chainId: 1 }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Unsupported wallet network");
    expect(createWalletVerificationChallenge).not.toHaveBeenCalled();
  });

  it("creates a wallet verification challenge for the authenticated user", async () => {
    const response = await POST(createRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual({
      challengeId: "challenge_123",
      address: "0x000000000000000000000000000000000000dead",
      chainId: 8453,
      message: "Hivra wallet verification\n\nSign this message.",
      expiresAt: "2026-04-24T12:10:00.000Z",
      movesFromAnotherAccount: false,
    });
    expect(createWalletVerificationChallenge).toHaveBeenCalledWith({
      userId,
      address,
      chainId: 8453,
    });
  });

  it("warns when the address is currently verified on another account", async () => {
    (isWalletClaimedByAnotherAccount as jest.Mock).mockResolvedValueOnce(true);

    const response = await POST(createRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.movesFromAnotherAccount).toBe(true);
    expect(isWalletClaimedByAnotherAccount).toHaveBeenCalledWith({ userId, address });
  });

  it("still issues the challenge when the takeover scan fails", async () => {
    (isWalletClaimedByAnotherAccount as jest.Mock).mockRejectedValueOnce(new Error("db down"));

    const response = await POST(createRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.challengeId).toBe("challenge_123");
    expect(body.data.movesFromAnotherAccount).toBe(false);
  });

  it("does not leak backend errors", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    (createWalletVerificationChallenge as jest.Mock).mockRejectedValueOnce(
      new Error("wallet-secret-leak")
    );

    const response = await POST(createRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Failed to create wallet verification challenge");
    expect(JSON.stringify(body)).not.toContain("wallet-secret-leak");
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain("wallet-secret-leak");

    consoleErrorSpy.mockRestore();
  });
});
