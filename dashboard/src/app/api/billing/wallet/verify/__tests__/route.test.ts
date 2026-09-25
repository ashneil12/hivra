import { NextRequest } from "next/server";
import { POST } from "../route";
import { auth } from "@clerk/nextjs/server";
import { verifyWalletChallenge } from "@/lib/billing/wallet-verification";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {},
}));

jest.mock("@/lib/billing/wallet-verification", () => ({
  verifyWalletChallenge: jest.fn(),
}));

const mockPrimaryWallet = jest.fn();
const mockLockWallet = jest.fn();
const mockNotice = jest.fn();
jest.mock("@/lib/billing/bankr-withdraw", () => ({
  getSelfCustodyPrimaryWallet: (...args: unknown[]) => mockPrimaryWallet(...args),
}));
jest.mock("@/lib/billing/token-holdings", () => ({
  getHermesLockWallet: (...args: unknown[]) => mockLockWallet(...args),
}));
jest.mock("@/lib/billing/withdraw-destination-notice", () => ({
  noticeWithdrawDestinationChange: (...args: unknown[]) => mockNotice(...args),
}));

describe("POST /api/billing/wallet/verify", () => {
  const userId = "user_123";
  const validBody = {
    challengeId: "challenge_123",
    signature: "0xabcdef",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrimaryWallet.mockResolvedValue(null);
    mockLockWallet.mockResolvedValue(null);
    mockNotice.mockResolvedValue(undefined);
    (auth as unknown as jest.Mock).mockResolvedValue({ userId });
    (verifyWalletChallenge as jest.Mock).mockResolvedValue({
      status: "verified",
      challenge: {
        id: "challenge_123",
        status: "verified",
        verifiedAt: "2026-04-24T12:01:00.000Z",
      },
      wallet: {
        id: "wallet_123",
        address: "0x000000000000000000000000000000000000dead",
        normalizedAddress: "0x000000000000000000000000000000000000dead",
        chainId: 8453,
        verifiedAt: "2026-04-24T12:01:00.000Z",
      },
    });
  });

  function createRequest(body: Record<string, unknown> = validBody) {
    return new NextRequest("http://localhost/api/billing/wallet/verify", {
      method: "POST",
      body: JSON.stringify(body),
      headers: new Headers({ "content-type": "application/json" }),
    });
  }

  function createRawRequest(body: string) {
    return new NextRequest("http://localhost/api/billing/wallet/verify", {
      method: "POST",
      body,
      headers: new Headers({ "content-type": "application/json" }),
    });
  }

  it("returns 401 when unauthorized", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });

    const response = await POST(createRequest());

    expect(response.status).toBe(401);
    expect(verifyWalletChallenge).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const response = await POST(createRawRequest("{bad"));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid JSON body");
  });

  it("rejects missing challenge data", async () => {
    const response = await POST(createRequest({ challengeId: "", signature: "" }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid wallet verification request");
    expect(verifyWalletChallenge).not.toHaveBeenCalled();
  });

  it("verifies a signed challenge and returns the verified wallet", async () => {
    const response = await POST(createRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual({
      status: "verified",
      wallet: {
        id: "wallet_123",
        address: "0x000000000000000000000000000000000000dead",
        normalizedAddress: "0x000000000000000000000000000000000000dead",
        chainId: 8453,
        verifiedAt: "2026-04-24T12:01:00.000Z",
      },
      challenge: {
        id: "challenge_123",
        status: "verified",
        verifiedAt: "2026-04-24T12:01:00.000Z",
      },
      movedFromAnotherAccount: false,
    });
    expect(verifyWalletChallenge).toHaveBeenCalledWith({
      userId,
      challengeId: "challenge_123",
      signature: "0xabcdef",
    });
  });

  it("emails a lock-wallet holder when a different wallet becomes the one their tokens can move to", async () => {
    mockLockWallet.mockResolvedValue({ id: "lock", address: "0x00000000000000000000000000000000000010c4" });
    mockPrimaryWallet.mockResolvedValue({
      id: "old",
      address: "0x000000000000000000000000000000000000beef",
      normalizedAddress: "0x000000000000000000000000000000000000beef",
      verifiedAt: "2026-01-01T00:00:00.000Z",
    });

    const response = await POST(createRequest());

    expect(response.status).toBe(200);
    expect(mockNotice).toHaveBeenCalledWith({
      userId,
      kind: "verified_wallet",
      previousAddress: "0x000000000000000000000000000000000000beef",
      newAddress: "0x000000000000000000000000000000000000dead",
      changedAt: new Date("2026-04-24T12:01:00.000Z"),
      availableAt: new Date("2026-04-25T12:01:00.000Z"),
    });
  });

  it("sends no destination email to an account without a lock wallet, or when the same wallet is verified again", async () => {
    await POST(createRequest());
    expect(mockNotice).not.toHaveBeenCalled();

    mockLockWallet.mockResolvedValue({ id: "lock", address: "0x00000000000000000000000000000000000010c4" });
    mockPrimaryWallet.mockResolvedValue({
      id: "wallet_123",
      address: "0x000000000000000000000000000000000000dead",
      normalizedAddress: "0x000000000000000000000000000000000000dead",
      verifiedAt: "2026-01-01T00:00:00.000Z",
    });
    await POST(createRequest());
    expect(mockNotice).not.toHaveBeenCalled();
  });

  it("flags the takeover when the wallet moved from another account", async () => {
    (verifyWalletChallenge as jest.Mock).mockResolvedValueOnce({
      status: "verified",
      challenge: { id: "challenge_123", status: "verified" },
      wallet: { id: "wallet_123" },
      takeover: { displacedUserIds: ["user_other"] },
    });

    const response = await POST(createRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.movedFromAnotherAccount).toBe(true);
    // Displaced account ids stay server-side.
    expect(JSON.stringify(body)).not.toContain("user_other");
  });

  it("returns a clean response for invalid signatures", async () => {
    (verifyWalletChallenge as jest.Mock).mockResolvedValueOnce({ status: "invalid_signature" });

    const response = await POST(createRequest());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid wallet signature");
    expect(body.status).toBe("invalid_signature");
  });

  it("returns a clean response for expired challenges", async () => {
    (verifyWalletChallenge as jest.Mock).mockResolvedValueOnce({ status: "expired" });

    const response = await POST(createRequest());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Wallet verification challenge expired");
    expect(body.status).toBe("expired");
  });

  it("returns 404 when the challenge does not belong to the user", async () => {
    (verifyWalletChallenge as jest.Mock).mockResolvedValueOnce({ status: "not_found" });

    const response = await POST(createRequest());
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe("Wallet verification challenge not found");
    expect(body.status).toBe("not_found");
  });

  it("does not leak backend errors", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    (verifyWalletChallenge as jest.Mock).mockRejectedValueOnce(
      new Error("wallet-signature-secret-leak")
    );

    const response = await POST(createRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Failed to verify wallet");
    expect(JSON.stringify(body)).not.toContain("wallet-signature-secret-leak");
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain("wallet-signature-secret-leak");

    consoleErrorSpy.mockRestore();
  });
});
