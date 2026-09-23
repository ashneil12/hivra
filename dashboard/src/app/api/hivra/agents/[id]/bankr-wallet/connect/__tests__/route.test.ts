import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { DELETE, POST } from "../route";
import {
  loadOwnedHivraWalletAgent,
  syncBankrEnvToRunningHivraAgent,
} from "@/lib/agent-wallets/hivra-lane";
import {
  connectUserBankrWalletForOwner,
  disconnectUserBankrWalletForOwner,
} from "@/lib/billing/bankr-instance-wallets";
import { resolveHivraAgentExecutionContext } from "@/lib/hivra/agent-execution-context";

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
jest.mock("@/lib/hivra/hivra-flag", () => ({ isHivraApiAllowed: () => true }));
jest.mock("@/lib/hivra/bankr-skills-seed", () => ({
  bankrSkillsDirForType: (type: string) => (type === "codex" || type === "claude-code" ? "/home/bux/.codex/skills" : null),
}));

jest.mock("@/lib/agent-wallets/hivra-lane", () => ({
  loadOwnedHivraWalletAgent: jest.fn(),
  syncBankrEnvToRunningHivraAgent: jest.fn(),
}));

jest.mock("@/lib/hivra/agent-execution-context", () => ({
  resolveHivraAgentExecutionContext: jest.fn(),
  describeHivraAgentExecutionContextError: jest.fn(() => null),
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

const USER_KEY = "bk_usr_abcd1234_usersecretvalue000";
const USER_WALLET = "0x00000000000000000000000000000000000c0ffe";
const agent = {
  id: "agent_1",
  user_id: "user_123",
  type: "codex",
  status: "running",
  ip: "10.250.20.42",
  proxmox_host: "test-proxmox-host",
  infrastructure_connection_id: null,
  deployment_target_id: null,
  infrastructure_connection_revision: null,
};

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: "wallet_row_1",
    instanceId: null,
    hivraAgentId: "agent_1",
    userId: "user_123",
    bankrWalletId: `user:${USER_WALLET}`,
    evmAddress: USER_WALLET,
    normalizedEvmAddress: USER_WALLET,
    apiKeyPreview: "bk_usr_ab...e000",
    apiKeyStatus: "active" as const,
    withdrawalDestinationEvm: null,
    withdrawalDestinationSetAt: null,
    status: "active" as const,
    metadata: { custodyModel: "user_owned_bankr_account" },
    createdAt: "2026-09-23T12:00:00.000Z",
    updatedAt: "2026-09-23T12:00:00.000Z",
    ...overrides,
  };
}

function request(method: "POST" | "DELETE", body?: unknown) {
  return new NextRequest("http://localhost/api/hivra/agents/agent_1/bankr-wallet/connect", {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const params = { params: Promise.resolve({ id: "agent_1" }) };

describe("/api/hivra/agents/[id]/bankr-wallet/connect", () => {
  const mockedAuth = auth as jest.MockedFunction<typeof auth>;
  const mockedLoad = loadOwnedHivraWalletAgent as jest.MockedFunction<typeof loadOwnedHivraWalletAgent>;
  const mockedSync = syncBankrEnvToRunningHivraAgent as jest.MockedFunction<typeof syncBankrEnvToRunningHivraAgent>;
  const mockedContext = resolveHivraAgentExecutionContext as jest.MockedFunction<typeof resolveHivraAgentExecutionContext>;
  const mockedConnect = connectUserBankrWalletForOwner as jest.MockedFunction<typeof connectUserBankrWalletForOwner>;
  const mockedDisconnect = disconnectUserBankrWalletForOwner as jest.MockedFunction<typeof disconnectUserBankrWalletForOwner>;
  const executionContext = { env: { PROXMOX_HOST: "test-proxmox-host" } } as unknown as Awaited<ReturnType<typeof resolveHivraAgentExecutionContext>>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedAuth.mockResolvedValue({ userId: "user_123" } as Awaited<ReturnType<typeof auth>>);
    mockedLoad.mockResolvedValue(agent);
    mockedContext.mockResolvedValue(executionContext);
    mockedSync.mockResolvedValue({ status: "synced" });
    mockedConnect.mockResolvedValue({ record: record(), replacedProvisionedWallet: false });
    mockedDisconnect.mockResolvedValue(record({ status: "revoked", apiKeyStatus: "revoked", apiKeyPreview: null }));
  });

  it("connects the user's key and writes it to the running box", async () => {
    const response = await POST(request("POST", { apiKey: USER_KEY, consent: true }), params);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockedConnect).toHaveBeenCalledWith(
      expect.objectContaining({ owner: { hivraAgentId: "agent_1" }, userId: "user_123", apiKey: USER_KEY })
    );
    expect(mockedSync).toHaveBeenCalledWith({
      agent,
      record: expect.objectContaining({ status: "active" }),
      executionContext,
    });
    expect(body.data).toMatchObject({ envSync: "synced", wallet: { custody: "user_connected", evmAddress: USER_WALLET } });
    expect(JSON.stringify(body)).not.toContain(USER_KEY);
  });

  it("refuses agent types that don't take a wallet", async () => {
    mockedLoad.mockResolvedValueOnce({ ...agent, type: "aeon" });
    const response = await POST(request("POST", { apiKey: USER_KEY, consent: true }), params);
    expect(response.status).toBe(400);
    expect(mockedConnect).not.toHaveBeenCalled();
  });

  it("disconnects and removes the key file from the box", async () => {
    const response = await DELETE(request("DELETE"), params);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockedDisconnect).toHaveBeenCalledWith({ owner: { hivraAgentId: "agent_1" }, userId: "user_123" });
    expect(mockedSync).toHaveBeenCalledWith({
      agent,
      record: expect.objectContaining({ status: "revoked" }),
      executionContext,
    });
    expect(body.data.envSync).toBe("synced");
  });
});
