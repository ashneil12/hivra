import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { POST } from "../route";
import { supabaseAdmin } from "@/lib/supabase";
import {
  withdrawBaseEthForInstance,
  withdrawBaseTokenForInstance,
  withdrawHermesTokensForInstance,
} from "@/lib/billing/bankr-instance-withdraw";
import { isUserConnectedBankrWallet } from "@/lib/billing/bankr-instance-wallets";
import { log } from "@/lib/logger";

// Public Base token contracts, named so the secret scan reads them as addresses.
const USDC_CONTRACT = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/billing/bankr-instance-withdraw", () => ({
  withdrawBaseEthForInstance: jest.fn(),
  withdrawBaseTokenForInstance: jest.fn(),
  withdrawHermesTokensForInstance: jest.fn(),
}));

jest.mock("@/lib/billing/bankr-instance-wallets", () => ({
  isUserConnectedBankrWallet: jest.fn(),
}));

jest.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: jest.fn(() => ({ success: true })),
  getIP: jest.fn(() => "127.0.0.1"),
}));

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

function makeReq(body: unknown = {}) {
  return new NextRequest("http://localhost/api/instances/inst_123/bankr-wallet/withdraw", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/instances/[id]/bankr-wallet/withdraw", () => {
  const mockedAuth = auth as jest.MockedFunction<typeof auth>;
  const mockedFrom = supabaseAdmin!.from as jest.Mock;
  const mockedWithdrawEth = withdrawBaseEthForInstance as jest.MockedFunction<typeof withdrawBaseEthForInstance>;
  const mockedWithdrawBaseToken = withdrawBaseTokenForInstance as jest.MockedFunction<typeof withdrawBaseTokenForInstance>;
  const mockedWithdraw = withdrawHermesTokensForInstance as jest.MockedFunction<typeof withdrawHermesTokensForInstance>;
  const mockedLogError = log.error as jest.MockedFunction<typeof log.error>;
  const mockedIsUserConnected = isUserConnectedBankrWallet as jest.MockedFunction<typeof isUserConnectedBankrWallet>;

  function mockOwnedInstance(owner: boolean) {
    mockedFrom.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: owner ? { id: "inst_123" } : null,
        error: null,
      }),
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockedAuth.mockResolvedValue({ userId: "user_123" } as Awaited<ReturnType<typeof auth>>);
    mockOwnedInstance(true);
    mockedIsUserConnected.mockResolvedValue(false);
    mockedWithdraw.mockResolvedValue({
      status: "submitted",
      txHash: "0xwithdraw",
      amountRaw: "100000000000000000000",
      amountDisplay: "100",
      recipientAddress: "0x1111111111111111111111111111111111111111",
      wallet: {
        evmAddress: "0x000000000000000000000000000000000000ba5e",
        bankrWalletId: "wlt_instance",
        status: "active",
        withdrawalDestinationEvm: "0x1111111111111111111111111111111111111111",
        withdrawalDestinationAvailableAt: null,
        apiKeyStatus: "active",
        custody: "hivra_provisioned" as const,
        apiKeyPreview: null,
        connectedAt: null,
      },
    });
    mockedWithdrawEth.mockResolvedValue({
      status: "submitted",
      txHash: "0xethwithdraw",
      amountRaw: "5000000000000000",
      amountDisplay: "0.005",
      recipientAddress: "0x1111111111111111111111111111111111111111",
      wallet: {
        evmAddress: "0x000000000000000000000000000000000000ba5e",
        bankrWalletId: "wlt_instance",
        status: "active",
        withdrawalDestinationEvm: "0x1111111111111111111111111111111111111111",
        withdrawalDestinationAvailableAt: null,
        apiKeyStatus: "active",
        custody: "hivra_provisioned" as const,
        apiKeyPreview: null,
        connectedAt: null,
      },
    });
    mockedWithdrawBaseToken.mockResolvedValue({
      status: "submitted",
      txHash: "0xusdcwithdraw",
      amountRaw: "2500000",
      amountDisplay: "2.5",
      recipientAddress: "0x2222222222222222222222222222222222222222",
      wallet: {
        evmAddress: "0x000000000000000000000000000000000000ba5e",
        bankrWalletId: "wlt_instance",
        status: "active",
        withdrawalDestinationEvm: "0x2222222222222222222222222222222222222222",
        withdrawalDestinationAvailableAt: null,
        apiKeyStatus: "active",
        custody: "hivra_provisioned" as const,
        apiKeyPreview: null,
        connectedAt: null,
      },
    });
  });

  it("returns 401 when unauthenticated", async () => {
    mockedAuth.mockResolvedValueOnce({ userId: null } as Awaited<ReturnType<typeof auth>>);

    const response = await POST(makeReq(), { params: Promise.resolve({ id: "inst_123" }) });

    expect(response.status).toBe(401);
    expect(mockedWithdraw).not.toHaveBeenCalled();
  });

  it("returns 404 for a non-owned instance", async () => {
    mockOwnedInstance(false);

    const response = await POST(makeReq(), { params: Promise.resolve({ id: "inst_123" }) });

    expect(response.status).toBe(404);
    expect(mockedWithdraw).not.toHaveBeenCalled();
  });

  it("refuses to move funds from a user's own connected Bankr account", async () => {
    mockedIsUserConnected.mockResolvedValueOnce(true);

    const response = await POST(makeReq({ expectedRecipient: "0x1111111111111111111111111111111111111111", amount: "1" }), {
      params: Promise.resolve({ id: "inst_123" }),
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toMatch(/your own Bankr account/i);
    expect(mockedIsUserConnected).toHaveBeenCalledWith({ owner: { instanceId: "inst_123" } });
    expect(mockedWithdraw).not.toHaveBeenCalled();
    expect(mockedWithdrawEth).not.toHaveBeenCalled();
    expect(mockedWithdrawBaseToken).not.toHaveBeenCalled();
  });

  it("submits a withdrawal for the owned agent wallet without exposing API keys", async () => {
    const expectedRecipient = "0x1111111111111111111111111111111111111111";
    const amount = "25.5";

    const response = await POST(makeReq({ expectedRecipient, amount }), {
      params: Promise.resolve({ id: "inst_123" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockedWithdraw).toHaveBeenCalledWith({
      instanceId: "inst_123",
      userId: "user_123",
      expectedRecipient,
      amountDisplay: amount,
    });
    expect(mockedWithdrawEth).not.toHaveBeenCalled();
    expect(body.data).toMatchObject({
      status: "submitted",
      txHash: "0xwithdraw",
      amountDisplay: "100",
      recipientAddress: expectedRecipient,
      wallet: {
        evmAddress: "0x000000000000000000000000000000000000ba5e",
        bankrWalletId: "wlt_instance",
      },
    });
    expect(JSON.stringify(body)).not.toContain("api_key_encrypted");
    expect(JSON.stringify(body)).not.toContain("bk_agent_secret");
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("submits a Base ETH withdrawal through the native asset helper", async () => {
    const expectedRecipient = "0x1111111111111111111111111111111111111111";

    const response = await POST(makeReq({ expectedRecipient, amount: "0.005", asset: "ETH" }), {
      params: Promise.resolve({ id: "inst_123" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockedWithdrawEth).toHaveBeenCalledWith({
      instanceId: "inst_123",
      userId: "user_123",
      expectedRecipient,
      amountDisplay: "0.005",
    });
    expect(mockedWithdraw).not.toHaveBeenCalled();
    expect(body.data).toMatchObject({
      status: "submitted",
      txHash: "0xethwithdraw",
      asset: "ETH",
      amountDisplay: "0.005",
      recipientAddress: expectedRecipient,
    });
  });

  it("submits any Base token withdrawal with explicit token, amount, and recipient", async () => {
    const recipientAddress = "0x2222222222222222222222222222222222222222";
    const token = {
      symbol: "USDC",
      tokenAddress: USDC_CONTRACT,
      decimals: 6,
      chain: "Base",
    };

    // An older client may still send setPrimaryRecipient: it is ignored, a
    // withdrawal never changes the saved destination.
    const response = await POST(makeReq({
      recipientAddress,
      amount: "2.5",
      token,
      setPrimaryRecipient: true,
    }), {
      params: Promise.resolve({ id: "inst_123" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockedWithdrawBaseToken).toHaveBeenCalledWith({
      instanceId: "inst_123",
      userId: "user_123",
      recipientAddress,
      amountDisplay: "2.5",
      token: {
        symbol: "USDC",
        tokenAddress: USDC_CONTRACT,
        decimals: 6,
      },
    });
    expect(mockedWithdraw).not.toHaveBeenCalled();
    expect(mockedWithdrawEth).not.toHaveBeenCalled();
    expect(body.data).toMatchObject({
      status: "submitted",
      txHash: "0xusdcwithdraw",
      asset: "USDC",
      amountDisplay: "2.5",
      recipientAddress,
    });
  });

  it("returns 422 when no withdrawal destination has been saved", async () => {
    mockedWithdraw.mockResolvedValueOnce({ status: "no_withdrawal_destination" });

    const response = await POST(makeReq({ amount: "25" }), { params: Promise.resolve({ id: "inst_123" }) });
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error).toMatch(/withdrawal destination/i);
  });

  it("returns 423 with the unlock time while the saved destination is in its cooldown", async () => {
    const availableAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    mockedWithdraw.mockResolvedValueOnce({
      status: "destination_cooling_down",
      availableAt,
      errorMessage: "This withdrawal destination was saved less than 24 hours ago.",
    } as never);

    const response = await POST(makeReq({ amount: "25" }), { params: Promise.resolve({ id: "inst_123" }) });
    const body = await response.json();

    expect(response.status).toBe(423);
    expect(body.error).toMatch(/less than 24 hours ago/);
    expect(body).toMatchObject({
      failureType: "agent_wallet_withdraw_destination_cooling_down",
      availableAt,
    });
  });

  it("returns 422 when a token withdrawal names a recipient other than the saved destination", async () => {
    mockedWithdrawBaseToken.mockResolvedValueOnce({
      status: "recipient_not_destination",
      errorMessage: "Withdrawals go only to this wallet's saved withdrawal destination.",
    } as never);

    const response = await POST(makeReq({
      recipientAddress: "0x3333333333333333333333333333333333333333",
      amount: "2.5",
      token: { symbol: "USDC", tokenAddress: USDC_CONTRACT, decimals: 6, chain: "Base" },
    }), { params: Promise.resolve({ id: "inst_123" }) });
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error).toMatch(/saved withdrawal destination/);
    expect(body).toMatchObject({ failureType: "agent_wallet_withdraw_recipient_not_destination" });
  });

  it("requires an amount before dispatching to the withdraw helper", async () => {
    const expectedRecipient = "0x1111111111111111111111111111111111111111";

    const response = await POST(makeReq({ expectedRecipient }), {
      params: Promise.resolve({ id: "inst_123" }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toMatch(/validation/i);
    expect(mockedWithdraw).not.toHaveBeenCalled();
  });

  it("returns 422 when the requested amount exceeds the live balance", async () => {
    mockedWithdraw.mockResolvedValueOnce({
      status: "insufficient_balance",
      errorMessage: "Requested amount exceeds the live HERMESOS balance.",
    });

    const response = await POST(makeReq({ amount: "10000001" }), {
      params: Promise.resolve({ id: "inst_123" }),
    });
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error).toMatch(/exceeds/i);
  });

  it("returns 422 when the helper rejects an invalid amount", async () => {
    mockedWithdraw.mockResolvedValueOnce({
      status: "invalid_amount",
      errorMessage: "Withdrawal amount must be greater than zero.",
    });

    const response = await POST(makeReq({ amount: "0" }), {
      params: Promise.resolve({ id: "inst_123" }),
    });
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error).toMatch(/greater than zero/i);
  });

  it("logs safe diagnostic context when Bankr transfer fails", async () => {
    mockedWithdraw.mockResolvedValueOnce({
      status: "transfer_failed",
      errorMessage: "bankr_internal_secret_should_not_leak",
    });

    const response = await POST(makeReq({ amount: "25" }), { params: Promise.resolve({ id: "inst_123" }) });
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(JSON.stringify(body)).not.toContain("bankr_internal_secret_should_not_leak");
    expect(mockedLogError).toHaveBeenCalledWith(
      "agent wallet withdraw transfer failed",
      expect.any(Error),
      expect.objectContaining({
        source: "agent-wallet-withdraw",
        route: "/api/instances/[id]/bankr-wallet/withdraw",
        instanceId: "inst_123",
        userId: "user_123",
        failureType: "agent_wallet_withdraw_transfer_failed",
      })
    );
  });
});
