import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { GET, POST } from "../route";
import { supabaseAdmin } from "@/lib/supabase";
import {
  getBankrWalletForInstance,
  instanceBankrWalletPublicSummary,
  listWithdrawalRecipientsForInstance,
  provisionBankrWalletForInstance,
  readInstanceBankrWalletBalances,
} from "@/lib/billing/bankr-instance-wallets";
import { agentWebApi } from "@/lib/agent-web-api";
import { putHermesConfigWithBindMountFallback } from "@/lib/hermes-config-write";
import { resolveInstanceIpv4 } from "@/lib/instance-resolvers";
import { preinstallBankrSuiteForInstance } from "@/lib/services/instance-service";
import { log } from "@/lib/logger";

// Public Base token contracts, named so the secret scan reads them as addresses.
const USDC_CONTRACT = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/billing/bankr-instance-wallets", () => ({
  getBankrWalletForInstance: jest.fn(),
  instanceBankrWalletPublicSummary: jest.fn(),
  listWithdrawalRecipientsForInstance: jest.fn(),
  provisionBankrWalletForInstance: jest.fn(),
  readInstanceBankrWalletBalances: jest.fn(),
}));

jest.mock("@/lib/agent-web-api", () => ({
  agentWebApi: jest.fn(),
}));

jest.mock("@/lib/hermes-config-write", () => ({
  putHermesConfigWithBindMountFallback: jest.fn(),
}));

jest.mock("@/lib/instance-resolvers", () => ({
  resolveInstanceIpv4: jest.fn(),
}));

jest.mock("@/lib/services/instance-service", () => ({
  preinstallBankrSuiteForInstance: jest.fn(),
}));

jest.mock("@/lib/services/profile-service", () => ({
  sanitizeDockerName: (value: string) => value,
}));

describe("/api/instances/[id]/bankr-wallet", () => {
  const mockedAuth = auth as jest.MockedFunction<typeof auth>;
  const mockedFrom = supabaseAdmin!.from as jest.Mock;
  const mockedGetWallet = getBankrWalletForInstance as jest.MockedFunction<typeof getBankrWalletForInstance>;
  const mockedSummary = instanceBankrWalletPublicSummary as jest.MockedFunction<typeof instanceBankrWalletPublicSummary>;
  const mockedRecipients = listWithdrawalRecipientsForInstance as jest.MockedFunction<typeof listWithdrawalRecipientsForInstance>;
  const mockedProvision = provisionBankrWalletForInstance as jest.MockedFunction<typeof provisionBankrWalletForInstance>;
  const mockedBalances = readInstanceBankrWalletBalances as jest.MockedFunction<typeof readInstanceBankrWalletBalances>;
  const mockedAgentWebApi = agentWebApi as jest.MockedFunction<typeof agentWebApi>;
  const mockedConfigWrite = putHermesConfigWithBindMountFallback as jest.MockedFunction<typeof putHermesConfigWithBindMountFallback>;
  const mockedResolveIpv4 = resolveInstanceIpv4 as jest.MockedFunction<typeof resolveInstanceIpv4>;
  const mockedPreinstall = preinstallBankrSuiteForInstance as jest.MockedFunction<typeof preinstallBankrSuiteForInstance>;
  const mockedWarn = log.warn as jest.MockedFunction<typeof log.warn>;

  const record = {
    id: "row_1",
    instanceId: "inst_123",
    hivraAgentId: null,
    userId: "user_123",
    bankrWalletId: "wlt_123",
    evmAddress: "0x000000000000000000000000000000000000ba5e",
    normalizedEvmAddress: "0x000000000000000000000000000000000000ba5e",
    apiKeyEncrypted: "encrypted-bk_agent_secret",
    apiKeyPreview: "bk_agent_...cret",
    apiKeyStatus: "active" as const,
    withdrawalDestinationEvm: null,
    withdrawalDestinationSetAt: null,
    status: "active" as const,
    metadata: {},
    createdAt: "2026-05-02T12:00:00.000Z",
    updatedAt: "2026-05-02T12:00:00.000Z",
  };

  function mockOwnedInstance(owner: boolean) {
    mockedFrom.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: owner
          ? {
              id: "inst_123",
              user_id: "user_123",
              name: "Test agent",
              status: "running",
              backend: "gateway",
              provider: "openai",
              subdomain: "test-agent",
              hetzner_server_id: null,
              gateway_url: "https://test-agent.example.com",
              api_key_encrypted: "enc",
              api_server_key_encrypted: "server-enc",
              config: { model: "gpt-5" },
              host_id: null,
              ipv4_address: "203.0.113.10",
              created_at: "2026-05-02T12:00:00.000Z",
            }
          : null,
        error: null,
      }),
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockedAuth.mockResolvedValue({ userId: "user_123" } as Awaited<ReturnType<typeof auth>>);
    mockOwnedInstance(true);
    mockedGetWallet.mockResolvedValue(record);
    mockedSummary.mockReturnValue({
      evmAddress: record.evmAddress,
      bankrWalletId: record.bankrWalletId,
      status: "active",
      withdrawalDestinationEvm: null,
      withdrawalDestinationAvailableAt: null,
      apiKeyStatus: "active",
      custody: "hivra_provisioned" as const,
      apiKeyPreview: null,
      connectedAt: null,
    });
    mockedProvision.mockResolvedValue({ status: "existing", record });
    mockedBalances.mockResolvedValue([
      { chain: "Base", tokenSymbol: "ETH", tokenAddress: null, tokenDecimals: 18, balanceDisplay: "0.0250" },
      {
        chain: "Base",
        tokenSymbol: "USDC",
        tokenAddress: USDC_CONTRACT,
        tokenDecimals: 6,
        balanceDisplay: "12.5",
      },
    ]);
    mockedRecipients.mockResolvedValue([]);
    mockedAgentWebApi.mockResolvedValue({ put: jest.fn() } as unknown as Awaited<ReturnType<typeof agentWebApi>>);
    mockedConfigWrite.mockResolvedValue({ ok: true });
    mockedResolveIpv4.mockResolvedValue("203.0.113.10");
    mockedPreinstall.mockResolvedValue({ seeded: true, count: 1 });
  });

  it("returns 401 when unauthenticated", async () => {
    mockedAuth.mockResolvedValue({ userId: null } as Awaited<ReturnType<typeof auth>>);

    const response = await GET(new NextRequest("http://localhost/api/instances/inst_123/bankr-wallet"), {
      params: Promise.resolve({ id: "inst_123" }),
    });

    expect(response.status).toBe(401);
  });

  it("returns 404 for a non-owned instance", async () => {
    mockOwnedInstance(false);

    const response = await GET(new NextRequest("http://localhost/api/instances/inst_123/bankr-wallet"), {
      params: Promise.resolve({ id: "inst_123" }),
    });

    expect(response.status).toBe(404);
    expect(mockedGetWallet).not.toHaveBeenCalled();
  });

  it("returns wallet summary and live balance without exposing API key material", async () => {
    const response = await GET(new NextRequest("http://localhost/api/instances/inst_123/bankr-wallet"), {
      params: Promise.resolve({ id: "inst_123" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: {
        wallet: {
          evmAddress: record.evmAddress,
          bankrWalletId: record.bankrWalletId,
          status: "active",
          withdrawalDestinationEvm: null,
          withdrawalDestinationAvailableAt: null,
          apiKeyStatus: "active",
          custody: "hivra_provisioned" as const,
          apiKeyPreview: null,
          connectedAt: null,
        },
        balance: { chain: "Base", tokenSymbol: "ETH", tokenAddress: null, tokenDecimals: 18, balanceDisplay: "0.0250" },
        balances: [
          { chain: "Base", tokenSymbol: "ETH", tokenAddress: null, tokenDecimals: 18, balanceDisplay: "0.0250" },
          {
            chain: "Base",
            tokenSymbol: "USDC",
            tokenAddress: USDC_CONTRACT,
            tokenDecimals: 6,
            balanceDisplay: "12.5",
          },
        ],
        balanceError: null,
        withdrawalRecipients: [],
      },
    });
    expect(JSON.stringify(body)).not.toContain("api_key_encrypted");
    expect(JSON.stringify(body)).not.toContain("encrypted-bk_agent_secret");
    expect(JSON.stringify(body)).not.toContain("bk_agent_secret");
  });

  it("fails soft and logs a request-correlated wallet balance RPC error", async () => {
    mockedBalances.mockRejectedValueOnce(new Error("RpcResponse.InternalError"));

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst_123/bankr-wallet", {
        headers: { "x-request-id": "req_wallet_rpc_123" },
      }),
      {
        params: Promise.resolve({ id: "inst_123" }),
      }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("req_wallet_rpc_123");
    expect(body.data).toMatchObject({
      wallet: {
        evmAddress: record.evmAddress,
        bankrWalletId: record.bankrWalletId,
        status: "active",
      },
      balance: null,
      balances: null,
      balanceError: {
        failureType: "bankr_instance_wallet_balance_rpc_failed",
        retryable: true,
        requestId: "req_wallet_rpc_123",
        message: "Balance temporarily unavailable. Your wallet address is still usable; retry the balance check shortly.",
      },
    });
    expect(mockedWarn).toHaveBeenCalledWith(
      "bankr instance wallet balance RPC failed",
      expect.objectContaining({
        source: "bankr-instance-wallet-route",
        requestId: "req_wallet_rpc_123",
        route: "/api/instances/[id]/bankr-wallet",
        method: "GET",
        instanceId: "inst_123",
        userId: "user_123",
        failureType: "bankr_instance_wallet_balance_rpc_failed",
        errorName: "Error",
        errorClass: "rpc_internal_error",
      })
    );
  });

  it("retries provisioning idempotently for an owned instance and skips the running-agent config sync on a webfree (gateway) box", async () => {
    const response = await POST(new NextRequest("http://localhost/api/instances/inst_123/bankr-wallet", {
      method: "POST",
    }), {
      params: Promise.resolve({ id: "inst_123" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockedProvision).toHaveBeenCalledWith({ instanceId: "inst_123", userId: "user_123" });
    // gateway≡webfree collapse: a "gateway" box is now treated as webfree, so the
    // legacy running-agent config sync is skipped (isWebfreeBackend short-circuits
    // syncBankrConfigToRunningAgent) — identically to a "webui" box.
    expect(mockedConfigWrite).not.toHaveBeenCalled();
    expect(body.data.configSync).toBe("skipped");
    expect(body.data.bankrSuite).toEqual({ seeded: true, count: 1 });
    expect(JSON.stringify(body)).not.toContain("bk_agent_secret");
  });

  it("refuses to create a Hivra wallet for an agent without one and points at the connect flow", async () => {
    mockedProvision.mockResolvedValueOnce({ status: "connect_required", record: null });

    const response = await POST(new NextRequest("http://localhost/api/instances/inst_123/bankr-wallet", {
      method: "POST",
    }), {
      params: Promise.resolve({ id: "inst_123" }),
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toMatch(/connect to your own Bankr account/i);
    expect(mockedConfigWrite).not.toHaveBeenCalled();
    expect(mockedPreinstall).not.toHaveBeenCalled();
  });

  it("reports Bankr skill seeding failure so the dashboard can retry later", async () => {
    mockedPreinstall.mockRejectedValueOnce(new Error("agent offline"));

    const response = await POST(new NextRequest("http://localhost/api/instances/inst_123/bankr-wallet", {
      method: "POST",
    }), {
      params: Promise.resolve({ id: "inst_123" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.bankrSuite).toEqual({ seeded: false, count: 0 });
    expect(mockedWarn).toHaveBeenCalledWith(
      "bankr suite preinstall failed after wallet provisioning",
      expect.objectContaining({
        source: "bankr-instance-wallet-route",
        instanceId: "inst_123",
        failureType: "bankr_instance_wallet_suite_seed_failed",
        errorName: "Error",
        errorMessage: "agent offline",
      })
    );
  });

  it("logs pending provisioning details so stuck wallet cards have a server-side trail", async () => {
    const pendingRecord = {
      ...record,
      bankrWalletId: "pending:inst_123",
      evmAddress: "0x0000000000000000000000000000000000000000",
      normalizedEvmAddress: "0x0000000000000000000000000000000000000000",
      apiKeyEncrypted: null,
      apiKeyPreview: null,
      apiKeyStatus: "missing" as const,
      status: "pending" as const,
      metadata: {
        lastProvisionReason: "bankr_unreachable",
        lastProvisionAttemptAt: "2026-05-02T12:00:00.000Z",
        lastProvisionError: "Bankr wallet provisioning failed with status 503",
      },
    };
    mockedProvision.mockResolvedValueOnce({ status: "pending", record: pendingRecord });
    mockedSummary.mockReturnValueOnce({
      evmAddress: null,
      bankrWalletId: null,
      status: "pending",
      withdrawalDestinationEvm: null,
      withdrawalDestinationAvailableAt: null,
      apiKeyStatus: "missing",
      custody: "hivra_provisioned" as const,
      apiKeyPreview: null,
      connectedAt: null,
    });

    const response = await POST(new NextRequest("http://localhost/api/instances/inst_123/bankr-wallet", {
      method: "POST",
    }), {
      params: Promise.resolve({ id: "inst_123" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.status).toBe("pending");
    expect(mockedWarn).toHaveBeenCalledWith(
      "bankr instance wallet provisioning still pending after dashboard retry",
      expect.objectContaining({
        source: "bankr-instance-wallet-route",
        instanceId: "inst_123",
        walletStatus: "pending",
        apiKeyStatus: "missing",
        provisionStatus: "pending",
        lastProvisionReason: "bankr_unreachable",
        lastProvisionAttemptAt: "2026-05-02T12:00:00.000Z",
        lastProvisionError: "Bankr wallet provisioning failed with status 503",
        failureType: "bankr_instance_wallet_provision_pending",
      })
    );
  });
});
