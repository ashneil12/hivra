import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { DELETE, POST } from "../route";
import {
  loadOwnedHermesInstance,
  syncBankrConfigToRunningHermesInstance,
} from "@/lib/agent-wallets/hermes-lane";
import {
  AgentWalletConnectError,
  connectUserBankrWalletForOwner,
  disconnectUserBankrWalletForOwner,
} from "@/lib/billing/bankr-instance-wallets";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { preinstallBankrSuiteForInstance } from "@/lib/services/instance-service";
import { log } from "@/lib/logger";

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

jest.mock("@/lib/agent-wallets/hermes-lane", () => ({
  loadOwnedHermesInstance: jest.fn(),
  syncBankrConfigToRunningHermesInstance: jest.fn(),
}));

jest.mock("@/lib/billing/bankr-instance-wallets", () => {
  const actual = jest.requireActual("@/lib/billing/bankr-instance-wallets");
  return {
    AgentWalletConnectError: actual.AgentWalletConnectError,
    instanceBankrWalletPublicSummary: actual.instanceBankrWalletPublicSummary,
    connectUserBankrWalletForOwner: jest.fn(),
    disconnectUserBankrWalletForOwner: jest.fn(),
  };
});

jest.mock("@/lib/authenticated-rate-limit", () => ({
  RATE_LIMIT_PRESETS: { secretWrite: { limit: 20, windowMs: 60_000 } },
  enforceAuthenticatedRouteRateLimit: jest.fn(() => null),
}));

jest.mock("@/lib/services/instance-service", () => ({
  preinstallBankrSuiteForInstance: jest.fn(),
}));

const USER_KEY = "bk_usr_abcd1234_usersecretvalue000";
const USER_WALLET = "0x00000000000000000000000000000000000c0ffe";

function connectedRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "wallet_row_1",
    instanceId: "inst_123",
    hivraAgentId: null,
    userId: "user_123",
    bankrWalletId: `user:${USER_WALLET}`,
    evmAddress: USER_WALLET,
    normalizedEvmAddress: USER_WALLET,
    apiKeyPreview: "bk_usr_ab...e000",
    apiKeyStatus: "active" as const,
    withdrawalDestinationEvm: null,
    withdrawalDestinationSetAt: null,
    status: "active" as const,
    metadata: { custodyModel: "user_owned_bankr_account", connectedAt: "2026-09-23T12:00:00.000Z" },
    createdAt: "2026-09-23T12:00:00.000Z",
    updatedAt: "2026-09-23T12:00:00.000Z",
    ...overrides,
  };
}

function request(method: "POST" | "DELETE", body?: unknown) {
  return new NextRequest("http://localhost/api/instances/inst_123/bankr-wallet/connect", {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const params = { params: Promise.resolve({ id: "inst_123" }) };

describe("/api/instances/[id]/bankr-wallet/connect", () => {
  const mockedAuth = auth as jest.MockedFunction<typeof auth>;
  const mockedLoad = loadOwnedHermesInstance as jest.MockedFunction<typeof loadOwnedHermesInstance>;
  const mockedSync = syncBankrConfigToRunningHermesInstance as jest.MockedFunction<typeof syncBankrConfigToRunningHermesInstance>;
  const mockedConnect = connectUserBankrWalletForOwner as jest.MockedFunction<typeof connectUserBankrWalletForOwner>;
  const mockedDisconnect = disconnectUserBankrWalletForOwner as jest.MockedFunction<typeof disconnectUserBankrWalletForOwner>;
  const mockedRateLimit = enforceAuthenticatedRouteRateLimit as jest.MockedFunction<typeof enforceAuthenticatedRouteRateLimit>;
  const mockedPreinstall = preinstallBankrSuiteForInstance as jest.MockedFunction<typeof preinstallBankrSuiteForInstance>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedAuth.mockResolvedValue({ userId: "user_123" } as Awaited<ReturnType<typeof auth>>);
    mockedLoad.mockResolvedValue({ id: "inst_123", status: "running" } as unknown as Awaited<ReturnType<typeof loadOwnedHermesInstance>>);
    mockedSync.mockResolvedValue("synced");
    mockedConnect.mockResolvedValue({ record: connectedRecord(), replacedProvisionedWallet: false, oldKeysRevoked: null });
    mockedDisconnect.mockResolvedValue(
      connectedRecord({ status: "revoked", apiKeyStatus: "revoked", apiKeyPreview: null })
    );
    mockedPreinstall.mockResolvedValue({ seeded: true, count: 3 });
  });

  it("returns 401 when unauthenticated", async () => {
    mockedAuth.mockResolvedValueOnce({ userId: null } as Awaited<ReturnType<typeof auth>>);
    const response = await POST(request("POST", { apiKey: USER_KEY, consent: true }), params);
    expect(response.status).toBe(401);
    expect(mockedConnect).not.toHaveBeenCalled();
  });

  it("returns 404 for an instance the user doesn't own", async () => {
    mockedLoad.mockResolvedValueOnce(null);
    const response = await POST(request("POST", { apiKey: USER_KEY, consent: true }), params);
    expect(response.status).toBe(404);
    expect(mockedConnect).not.toHaveBeenCalled();
  });

  it("requires explicit consent before touching the key", async () => {
    const response = await POST(request("POST", { apiKey: USER_KEY }), params);
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error).toMatch(/Confirm that this agent may use your Bankr API key/);
    expect(mockedConnect).not.toHaveBeenCalled();
  });

  it("applies the secret-write rate limit", async () => {
    mockedRateLimit.mockReturnValueOnce(new Response(null, { status: 429 }) as never);
    const response = await POST(request("POST", { apiKey: USER_KEY, consent: true }), params);
    expect(response.status).toBe(429);
    expect(mockedConnect).not.toHaveBeenCalled();
  });

  it("connects, syncs the agent config and never echoes the key", async () => {
    const response = await POST(request("POST", { apiKey: `  ${USER_KEY}  `, consent: true }), params);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockedConnect).toHaveBeenCalledWith({
      owner: { instanceId: "inst_123" },
      userId: "user_123",
      apiKey: USER_KEY,
      replaceProvisionedWallet: undefined,
    });
    expect(mockedSync).toHaveBeenCalledTimes(1);
    expect(body.data.wallet).toMatchObject({ evmAddress: USER_WALLET, custody: "user_connected" });
    expect(body.data.configSync).toBe("synced");
    expect(JSON.stringify(body)).not.toContain(USER_KEY);
    expect(JSON.stringify((log.info as jest.Mock).mock.calls)).not.toContain(USER_KEY);
  });

  it("returns a connect refusal with its code", async () => {
    mockedConnect.mockRejectedValueOnce(
      new AgentWalletConnectError("balance_not_empty", "Withdraw everything from the current wallet first (3 USDC).", 409)
    );
    const response = await POST(
      request("POST", { apiKey: USER_KEY, consent: true, replaceProvisionedWallet: true }),
      params
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({ success: false, code: "balance_not_empty" });
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it("reports and logs a switch whose old Hivra keys weren't revoked at Bankr", async () => {
    mockedConnect.mockResolvedValueOnce({ record: connectedRecord(), replacedProvisionedWallet: true, oldKeysRevoked: false });
    const response = await POST(
      request("POST", { apiKey: USER_KEY, consent: true, replaceProvisionedWallet: true }),
      params
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({ replacedProvisionedWallet: true, oldKeysRevoked: false });
    expect(log.error).toHaveBeenCalledWith(
      "replaced agent wallet keys were not revoked at Bankr",
      expect.any(Error),
      expect.objectContaining({ instanceId: "inst_123", failureType: "agent_wallet_connect_old_keys_not_revoked" })
    );
  });

  it("disconnects and rewrites the agent config without the key", async () => {
    const response = await DELETE(request("DELETE"), params);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockedDisconnect).toHaveBeenCalledWith({ owner: { instanceId: "inst_123" }, userId: "user_123" });
    expect(mockedSync).toHaveBeenCalledTimes(1);
    expect(body.data.wallet).toMatchObject({ status: "revoked", evmAddress: null, custody: "user_connected" });
  });

  it("refuses to disconnect a wallet that isn't a connected Bankr account", async () => {
    mockedDisconnect.mockRejectedValueOnce(
      new AgentWalletConnectError("not_connected", "This agent isn't connected to your Bankr account.", 409)
    );
    const response = await DELETE(request("DELETE"), params);
    expect(response.status).toBe(409);
    expect(mockedSync).not.toHaveBeenCalled();
  });
});
