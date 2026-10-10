/** @jest-environment node */

import { GET as listTools, POST as installTools } from "../route";
import { DELETE as uninstallTool } from "../[toolId]/route";

const mockAuth = jest.fn();
const mockResolveExecutionContext = jest.fn();
const mockInstallToolsOnBox = jest.fn();
const mockUninstallToolFromBox = jest.fn();

let agent: Record<string, unknown>;

jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = jest.fn(self);
      chain.eq = jest.fn(self);
      chain.neq = jest.fn(self);
      chain.single = jest.fn(async () => ({ data: agent, error: null }));
      return chain;
    },
  },
}));

jest.mock("@/lib/hivra/hivra-flag", () => ({ isHivraApiAllowed: () => true }));

jest.mock("@/lib/authenticated-rate-limit", () => ({
  RATE_LIMIT_PRESETS: { settingsWrite: {} },
  enforceAuthenticatedRouteRateLimit: () => null,
}));

jest.mock("@/lib/hivra/agent-execution-context", () => ({
  ...jest.requireActual("@/lib/hivra/agent-execution-context"),
  resolveHivraAgentExecutionContext: (...args: unknown[]) => mockResolveExecutionContext(...args),
}));

jest.mock("@/lib/hivra/tool-install", () => ({
  installToolsOnBox: (...args: unknown[]) => mockInstallToolsOnBox(...args),
  uninstallToolFromBox: (...args: unknown[]) => mockUninstallToolFromBox(...args),
  listInstallableToolMeta: (kind: string) => [{ id: "github", kind }],
}));

jest.mock("@/data/curated-tools", () => ({
  getToolById: (id: string) => id === "github" ? { id } : null,
}));

jest.mock("@/lib/hivra/agent-events", () => ({ logHivraAgentEvent: jest.fn() }));

jest.mock("@/lib/logger", () => ({ log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const OWN_CLOUD = "Catalog tools aren't available on computers in your own cloud yet. Use Advanced MCP.";

function request(path: string, method: "GET" | "POST" | "DELETE", body?: unknown): Request {
  return new Request(`https://hivra.cloud${path}`, {
    method,
    headers: { Host: "hivra.cloud", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ id: "agent-1" }) };

describe("per-agent catalog tool routes", () => {
  beforeEach(() => {
    agent = {
      id: "agent-1",
      user_id: "user-a",
      type: "codex",
      status: "running",
      ip: "10.251.20.61",
      computer_substrate: "proxmox-kvm",
    };
    mockAuth.mockResolvedValue({ userId: "user-a" });
    mockResolveExecutionContext.mockResolvedValue({ kind: "managed", env: { PROXMOX_NODE: "pve-a" } });
    mockInstallToolsOnBox.mockResolvedValue({ ok: true, installed: ["github"], skipped: [] });
    mockUninstallToolFromBox.mockResolvedValue({ ok: true });
  });

  it("lists the catalog for a Proxmox box", async () => {
    const response = await listTools(request("/api/hivra/agents/agent-1/tools", "GET") as never, params);
    const body = await response.json();
    expect(body.data).toEqual({ supported: true, tools: [{ id: "github", kind: "codex" }] });
  });

  it.each([
    ["provider-vm", OWN_CLOUD],
    ["gvisor", OWN_CLOUD],
    ["do-managed-session", "Catalog tools aren't available on DigitalOcean agents yet."],
  ])("reports %s as unsupported with a plain reason instead of listing tools", async (substrate, reason) => {
    agent.computer_substrate = substrate;
    const response = await listTools(request("/api/hivra/agents/agent-1/tools", "GET") as never, params);
    const body = await response.json();
    expect(body.data).toEqual({ supported: false, reason, tools: [] });
  });

  it("refuses an install on a provider computer plainly, before any host resolution", async () => {
    agent.computer_substrate = "provider-vm";
    const response = await installTools(
      request("/api/hivra/agents/agent-1/tools", "POST", { tools: [{ id: "github" }] }) as never,
      params,
    );
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error).toBe(OWN_CLOUD);
    expect(body.error).not.toMatch(/infrastructure binding/);
    expect(mockResolveExecutionContext).not.toHaveBeenCalled();
    expect(mockInstallToolsOnBox).not.toHaveBeenCalled();
  });

  it("refuses an uninstall on a provider computer plainly, before any host resolution", async () => {
    agent.computer_substrate = "provider-vm";
    const response = await uninstallTool(
      request("/api/hivra/agents/agent-1/tools/github", "DELETE") as never,
      { params: Promise.resolve({ id: "agent-1", toolId: "github" }) },
    );
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error).toBe(OWN_CLOUD);
    expect(mockResolveExecutionContext).not.toHaveBeenCalled();
    expect(mockUninstallToolFromBox).not.toHaveBeenCalled();
  });

  it("still installs on a Proxmox box through its owner-bound context", async () => {
    const response = await installTools(
      request("/api/hivra/agents/agent-1/tools", "POST", { tools: [{ id: "github" }] }) as never,
      params,
    );
    expect(response.status).toBe(200);
    expect(mockResolveExecutionContext).toHaveBeenCalledWith("user-a", agent);
    expect(mockInstallToolsOnBox).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-1" }),
      [{ id: "github", env: {} }],
      { PROXMOX_NODE: "pve-a" },
    );
  });
});
