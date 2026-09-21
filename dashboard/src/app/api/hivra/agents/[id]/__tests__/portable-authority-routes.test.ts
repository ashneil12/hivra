import { POST as installTools } from "../tools/route";
import { DELETE as uninstallTool } from "../tools/[toolId]/route";
import { POST as installSkills } from "../skills/install/route";
import { POST as provisionBankrWallet } from "../bankr-wallet/route";

const mockAuth = jest.fn();
const mockSupabaseFrom = jest.fn();
const mockResolveExecutionContext = jest.fn();
const mockDescribeContextError = jest.fn();
const mockInstallToolsOnBox = jest.fn();
const mockUninstallToolFromBox = jest.fn();
const mockInstallCuratedSkillsOnBox = jest.fn();
const mockProvisionBankrWallet = jest.fn();
const mockBuildBankrConfig = jest.fn();
const mockSeedBankrWalletEnv = jest.fn();
const mockLogHivraAgentEvent = jest.fn();

const connectionId = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";
const portableEnv = {
  PROXMOX_NODE: "pve-home",
  HIVRA_USER_INFRA_CONNECTION: "true",
};

let agent: Record<string, unknown>;

jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: (...args: unknown[]) => mockSupabaseFrom(...args) },
}));

jest.mock("@/lib/hivra/hivra-flag", () => ({ isHivraApiAllowed: () => true }));

jest.mock("@/lib/authenticated-rate-limit", () => ({
  RATE_LIMIT_PRESETS: { settingsWrite: {} },
  enforceAuthenticatedRouteRateLimit: () => null,
}));

jest.mock("@/lib/hivra/agent-execution-context", () => ({
  resolveHivraAgentExecutionContext: (...args: unknown[]) => mockResolveExecutionContext(...args),
  describeHivraAgentExecutionContextError: (...args: unknown[]) => mockDescribeContextError(...args),
}));

jest.mock("@/lib/hivra/tool-mcp-seed", () => ({
  toolMcpKindForType: () => "codex",
}));

jest.mock("@/lib/hivra/tool-install", () => ({
  installToolsOnBox: (...args: unknown[]) => mockInstallToolsOnBox(...args),
  uninstallToolFromBox: (...args: unknown[]) => mockUninstallToolFromBox(...args),
  listInstallableToolMeta: () => [],
}));

jest.mock("@/data/curated-tools", () => ({
  getToolById: (id: string) => id === "github" ? { id } : null,
}));

jest.mock("@/lib/hivra/bankr-skills-seed", () => ({
  bankrSkillsDirForType: () => "/home/ubuntu/.codex/skills",
}));

jest.mock("@/lib/hivra/skill-install", () => ({
  installCuratedSkillsOnBox: (...args: unknown[]) => mockInstallCuratedSkillsOnBox(...args),
  listInstallableSkillMeta: () => [],
}));

jest.mock("@/lib/billing/bankr-instance-wallets", () => ({
  buildInstanceBankrAgentConfig: (...args: unknown[]) => mockBuildBankrConfig(...args),
  getBankrWalletForHivraAgent: jest.fn(),
  instanceBankrWalletPublicSummary: (record: unknown) => record,
  provisionBankrWalletForHivraAgent: (...args: unknown[]) => mockProvisionBankrWallet(...args),
  readInstanceBankrWalletBalances: jest.fn(),
}));

jest.mock("@/lib/hivra/bankr-wallet-env-seed", () => ({
  seedBankrWalletEnvOntoBox: (...args: unknown[]) => mockSeedBankrWalletEnv(...args),
}));

jest.mock("@/lib/hivra/agent-events", () => ({
  logHivraAgentEvent: (...args: unknown[]) => mockLogHivraAgentEvent(...args),
}));

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

function request(path: string, method: "POST" | "DELETE", body?: unknown): Request {
  return new Request(`https://hivra.cloud${path}`, {
    method,
    headers: { Host: "hivra.cloud", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function installSupabaseAgent(): void {
  mockSupabaseFrom.mockImplementation(() => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = jest.fn(self);
    chain.eq = jest.fn(self);
    chain.neq = jest.fn(self);
    chain.single = jest.fn(async () => ({ data: agent, error: null }));
    chain.maybeSingle = jest.fn(async () => ({ data: agent, error: null }));
    return chain;
  });
}

describe("portable Hivra guest-operation authority", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    agent = {
      id: "agent-1",
      user_id: "user-a",
      type: "codex",
      status: "running",
      ip: "10.251.20.61",
      proxmox_host: "legacy-host-must-not-authorize",
      infrastructure_connection_id: connectionId,
      deployment_target_id: targetId,
      infrastructure_connection_revision: 6,
    };
    mockAuth.mockResolvedValue({ userId: "user-a" });
    installSupabaseAgent();
    mockResolveExecutionContext.mockResolvedValue({
      kind: "self-managed",
      env: portableEnv,
    });
    mockDescribeContextError.mockReturnValue(null);
    mockInstallToolsOnBox.mockResolvedValue({ ok: true, installed: ["github"], skipped: [] });
    mockUninstallToolFromBox.mockResolvedValue({ ok: true });
    mockInstallCuratedSkillsOnBox.mockResolvedValue({ ok: true, installed: ["research"], skipped: [] });
    mockProvisionBankrWallet.mockResolvedValue({
      status: "provisioned",
      record: { status: "active", evmAddress: "0x123" },
    });
    mockBuildBankrConfig.mockResolvedValue({ BANKR_API_KEY: "secret" });
    mockSeedBankrWalletEnv.mockResolvedValue({ ok: true });
    mockLogHivraAgentEvent.mockResolvedValue(undefined);
  });

  it("installs tools with the exact persisted target environment", async () => {
    const response = await installTools(
      request("/api/hivra/agents/agent-1/tools", "POST", {
        tools: [{ id: "github", env: { GITHUB_TOKEN: "token" } }],
      }) as never,
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mockResolveExecutionContext).toHaveBeenCalledWith("user-a", agent);
    expect(mockInstallToolsOnBox).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-1", ip: "10.251.20.61" }),
      [{ id: "github", env: { GITHUB_TOKEN: "token" } }],
      portableEnv,
    );
  });

  it("uninstalls a tool with the exact persisted target environment", async () => {
    const response = await uninstallTool(
      request("/api/hivra/agents/agent-1/tools/github", "DELETE") as never,
      { params: Promise.resolve({ id: "agent-1", toolId: "github" }) },
    );

    expect(response.status).toBe(200);
    expect(mockUninstallToolFromBox).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-1", ip: "10.251.20.61" }),
      "github",
      portableEnv,
    );
  });

  it("installs skills with the exact persisted target environment", async () => {
    const response = await installSkills(
      request("/api/hivra/agents/agent-1/skills/install", "POST", {
        skillIds: ["research"],
      }) as never,
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mockInstallCuratedSkillsOnBox).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-1", ip: "10.251.20.61" }),
      ["research"],
      portableEnv,
    );
  });

  it("resolves target authority before provisioning and syncing a wallet", async () => {
    const response = await provisionBankrWallet(
      request("/api/hivra/agents/agent-1/bankr-wallet", "POST") as never,
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mockResolveExecutionContext.mock.invocationCallOrder[0]).toBeLessThan(
      mockProvisionBankrWallet.mock.invocationCallOrder[0],
    );
    expect(mockSeedBankrWalletEnv).toHaveBeenCalledWith(
      { id: "agent-1", type: "codex", ip: "10.251.20.61" },
      { BANKR_API_KEY: "secret" },
      portableEnv,
    );
  });

  it("returns a truthful conflict before any guest or wallet mutation when target evidence is stale", async () => {
    const stale = new Error("stale target");
    mockResolveExecutionContext.mockRejectedValueOnce(stale);
    mockDescribeContextError.mockReturnValueOnce({
      status: 409,
      message: "This agent's infrastructure connection changed. Check it again before controlling the agent.",
    });

    const toolResponse = await installTools(
      request("/api/hivra/agents/agent-1/tools", "POST", { tools: [{ id: "github" }] }) as never,
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(toolResponse.status).toBe(409);
    expect(mockInstallToolsOnBox).not.toHaveBeenCalled();

    mockResolveExecutionContext.mockRejectedValueOnce(stale);
    mockDescribeContextError.mockReturnValueOnce({
      status: 409,
      message: "This agent's infrastructure connection changed. Check it again before controlling the agent.",
    });
    const walletResponse = await provisionBankrWallet(
      request("/api/hivra/agents/agent-1/bankr-wallet", "POST") as never,
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(walletResponse.status).toBe(409);
    expect(mockProvisionBankrWallet).not.toHaveBeenCalled();
    expect(mockSeedBankrWalletEnv).not.toHaveBeenCalled();
  });
});
