import { GET, POST } from "../route";
import { auth } from "@clerk/nextjs/server";
import {
  BankrPartnerResponseError,
  getBankrWalletForUser,
} from "@/lib/billing/bankr-wallets";
import {
  bankrDepositWalletPublicSummary,
  ensureBankrDepositWalletForUser,
  getBankrDepositWalletCredentialForUser,
} from "@/lib/billing/bankr-deposit-wallets";
import { getLatestHermesTokenHoldingSnapshotForWallet } from "@/lib/billing/token-holdings";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {},
}));

jest.mock("@/lib/billing/bankr-wallets", () => {
  const actual = jest.requireActual("@/lib/billing/bankr-wallets");
  return {
    ...actual,
    getBankrWalletForUser: jest.fn(),
  };
});

jest.mock("@/lib/billing/bankr-deposit-wallets", () => ({
  bankrDepositWalletPublicSummary: jest.fn(),
  ensureBankrDepositWalletForUser: jest.fn(),
  getBankrDepositWalletCredentialForUser: jest.fn(),
}));

jest.mock("@/lib/billing/token-holdings", () => ({
  getLatestHermesTokenHoldingSnapshotForWallet: jest.fn(),
}));

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

import { log as mockedLog } from "@/lib/logger";

describe("/api/billing/bankr/wallet", () => {
  const userId = "user_123";
  const originalNodeEnv = process.env.NODE_ENV;
  const wallet = {
    id: "wallet_1",
    userId,
    address: "0x000000000000000000000000000000000000dead",
    normalizedAddress: "0x000000000000000000000000000000000000dead",
    chainId: 8453,
    isPrimary: false,
    verifiedAt: "2026-04-24T12:00:00.000Z",
    bankrWalletId: "wlt_A1b2C3d4",
  };
  const depositCredential = {
    id: "deposit_credential_1",
    userId,
    walletId: "wallet_1",
    bankrWalletId: "wlt_A1b2C3d4",
    evmAddress: "0x000000000000000000000000000000000000dead",
    normalizedEvmAddress: "0x000000000000000000000000000000000000dead",
    apiKeyEncrypted: "encrypted",
    apiKeyPreview: "bk_usr_***",
    apiKeyStatus: "active",
    allowedRecipientEvm: "0x000000000000000000000000000000000000feed",
    allowedIps: [],
    permissions: {},
  };
  const depositWalletSummary = {
    custodyModel: "platform_deposit_address",
    address: "0x000000000000000000000000000000000000dead",
    normalizedAddress: "0x000000000000000000000000000000000000dead",
    bankrWalletId: "wlt_A1b2C3d4",
    sweepReady: true,
    allowedRecipientEvm: "0x000000000000000000000000000000000000feed",
  };

  function setNodeEnv(value: string | undefined) {
    (process.env as unknown as Record<string, string | undefined>).NODE_ENV = value;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.BILLING_V2_ENABLED;
    delete process.env.NEXT_PUBLIC_BILLING_V2_ENABLED;
    delete process.env.CRYPTO_BILLING_ENABLED;
    delete process.env.NEXT_PUBLIC_CRYPTO_BILLING_ENABLED;
    (auth as unknown as jest.Mock).mockResolvedValue({ userId });
    (getBankrWalletForUser as jest.Mock).mockResolvedValue(wallet);
    (getBankrDepositWalletCredentialForUser as jest.Mock).mockResolvedValue(depositCredential);
    (getLatestHermesTokenHoldingSnapshotForWallet as jest.Mock).mockResolvedValue({
      balanceRaw: "1000000000000000000",
    });
    (bankrDepositWalletPublicSummary as jest.Mock).mockImplementation((credential) =>
      credential ? depositWalletSummary : null
    );
    (ensureBankrDepositWalletForUser as jest.Mock).mockResolvedValue({
      status: "provisioned",
      wallet,
      bankrWallet: {
        id: "wlt_A1b2C3d4",
        evmAddress: "0x000000000000000000000000000000000000dead",
        solAddress: null,
        status: "active",
        createdAt: "2026-04-24T11:59:00.000Z",
      },
      credential: depositCredential,
    });
  });

  afterEach(() => {
    setNodeEnv(originalNodeEnv);
    delete process.env.BILLING_V2_ENABLED;
    delete process.env.NEXT_PUBLIC_BILLING_V2_ENABLED;
    delete process.env.CRYPTO_BILLING_ENABLED;
    delete process.env.NEXT_PUBLIC_CRYPTO_BILLING_ENABLED;
  });

  it("returns 401 when unauthorized", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });

    const response = await POST();

    expect(response.status).toBe(401);
    expect(ensureBankrDepositWalletForUser).not.toHaveBeenCalled();
  });

  it("loads the current Bankr wallet for the authenticated user", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: {
        status: "existing",
        custodyMode: "legacy_custody",
        wallet,
        depositWallet: depositWalletSummary,
        creditDepositWallet: depositWalletSummary,
        tokenLockWallet: depositWalletSummary,
      },
    });
    expect(getBankrWalletForUser).toHaveBeenCalledWith({ userId, purpose: "credit_deposit" });
    expect(getBankrDepositWalletCredentialForUser).toHaveBeenCalledWith({ userId, purpose: "credit_deposit" });
    expect(getBankrDepositWalletCredentialForUser).toHaveBeenCalledWith({ userId, purpose: "hermesos_lock" });
    expect(getLatestHermesTokenHoldingSnapshotForWallet).toHaveBeenCalledWith({
      userId,
      walletAddress: depositCredential.normalizedEvmAddress,
    });
    expect(bankrDepositWalletPublicSummary).toHaveBeenCalledWith(depositCredential);
    expect(ensureBankrDepositWalletForUser).not.toHaveBeenCalled();
  });

  it("treats an empty pre-provisioned Hivra lock wallet as self-custody", async () => {
    (getLatestHermesTokenHoldingSnapshotForWallet as jest.Mock).mockResolvedValueOnce({
      balanceRaw: "0",
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      status: "self_custody_required",
      custodyMode: "self_custody",
      tokenLockWallet: null,
      creditDepositWallet: depositWalletSummary,
    });
    expect(body.data.depositWallet).toEqual(depositWalletSummary);
  });

  it("returns 404 in production until billing v2 is enabled", async () => {
    setNodeEnv("production");

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe("Billing v2 is currently unavailable.");
    expect(auth).not.toHaveBeenCalled();
    expect(ensureBankrDepositWalletForUser).not.toHaveBeenCalled();
    expect(getBankrWalletForUser).not.toHaveBeenCalled();
  });

  it("provisions only the credit deposit wallet in production once billing v2 is enabled", async () => {
    setNodeEnv("production");
    process.env.BILLING_V2_ENABLED = "true";
    process.env.NEXT_PUBLIC_BILLING_V2_ENABLED = "true";

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("existing");
    expect(body.data.custodyMode).toBe("legacy_custody");
    expect(ensureBankrDepositWalletForUser).toHaveBeenCalledTimes(1);
    expect(ensureBankrDepositWalletForUser).toHaveBeenCalledWith({
      userId,
      purpose: "credit_deposit",
      makePrimary: true,
    });
    expect(ensureBankrDepositWalletForUser).not.toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "hermesos_lock" })
    );
  });

  it("provisions credit deposit while preserving existing legacy custody wallets for the authenticated user", async () => {
    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("existing");
    expect(body.data.custodyMode).toBe("legacy_custody");
    expect(body.data.depositWallet).toEqual(depositWalletSummary);
    expect(body.data.creditDepositWallet).toEqual(depositWalletSummary);
    expect(body.data.tokenLockWallet).toEqual(depositWalletSummary);
    expect(JSON.stringify(body)).not.toContain("bk_usr");
    expect(ensureBankrDepositWalletForUser).toHaveBeenCalledTimes(1);
    expect(ensureBankrDepositWalletForUser).toHaveBeenCalledWith({
      userId,
      purpose: "credit_deposit",
      makePrimary: true,
    });
    expect(ensureBankrDepositWalletForUser).not.toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "hermesos_lock" })
    );
  });

  it("keeps new users self-custody but still provisions the credit deposit wallet", async () => {
    (getBankrWalletForUser as jest.Mock).mockResolvedValue(null);
    (getBankrDepositWalletCredentialForUser as jest.Mock).mockResolvedValue(null);

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      status: "self_custody_required",
      custodyMode: "self_custody",
      wallet,
      depositWallet: depositWalletSummary,
      creditDepositWallet: depositWalletSummary,
      tokenLockWallet: null,
    });
    expect(ensureBankrDepositWalletForUser).toHaveBeenCalledTimes(1);
    expect(ensureBankrDepositWalletForUser).toHaveBeenCalledWith({
      userId,
      purpose: "credit_deposit",
      makePrimary: true,
    });
    expect(ensureBankrDepositWalletForUser).not.toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "hermesos_lock" })
    );
  });

  it("returns a clean setup error when credit deposit provisioning is not configured", async () => {
    (ensureBankrDepositWalletForUser as jest.Mock).mockResolvedValueOnce({
      status: "not_configured",
    });

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toBe("Bankr credit wallet provisioning is not configured");
  });

  it("returns 503 when Bankr rejects credit deposit provisioning", async () => {
    (ensureBankrDepositWalletForUser as jest.Mock).mockRejectedValueOnce(
      new BankrPartnerResponseError({
        operation: "Bankr wallet provisioning",
        status: 429,
        responseBody: '{"error":"rate limited"}',
      })
    );

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toBe("Bankr credit wallet provisioning is temporarily unavailable");
    expect(JSON.stringify(body)).not.toContain("rate limited");

    const warnCall = (mockedLog.warn as jest.Mock).mock.calls.find(
      ([msg]) => typeof msg === "string" && msg.includes("Bankr credit wallet provisioning is temporarily unavailable")
    );
    expect(warnCall).toBeDefined();
  });

  it("does not leak backend errors", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    (getBankrDepositWalletCredentialForUser as jest.Mock).mockRejectedValueOnce(
      new Error("bk_ptr_secret should stay private")
    );

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Failed to load Bankr wallet status");
    expect(body.details?.errorMessage).toBeUndefined();
    expect(body.details?.errorStack).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("bk_ptr_secret");
    // The route gates the diagnostic console.error on NODE_ENV !== 'test',
    // so jest never sees the underlying error in console.error mock calls.
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain("bk_ptr_secret");

    consoleErrorSpy.mockRestore();
  });

  it("GET also withholds error message from response body", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    (getBankrWalletForUser as jest.Mock).mockRejectedValueOnce(
      new Error("internal_db_error_signature")
    );
    process.env.BILLING_V2_ENABLED = "true";

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Failed to load Bankr wallet");
    expect(body.details?.errorMessage).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("internal_db_error_signature");
    // Same NODE_ENV gate as the POST handler.
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain("internal_db_error_signature");

    consoleErrorSpy.mockRestore();
  });
});
