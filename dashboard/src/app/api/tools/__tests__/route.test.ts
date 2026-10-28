/** @jest-environment node */

import { ProxmoxExecutionContextError } from "@/lib/infrastructure/proxmox-execution-context";
import { applyToolsToHermesInstance } from "@/lib/hivra/hermes-tool-apply";
import { resolveToolMcpSpec } from "@/lib/hivra/tool-install";
import { POST as fanOut } from "../route";

const mockAuth = jest.fn();
const mockResolveExecutionContext = jest.fn();
const mockAmbientTargetConfiguration = jest.fn();
const mockAmbientHost = jest.fn();
const mockInstallToolsOnBox = jest.fn();
const mockUninstallToolFromBox = jest.fn();
const mockLogWarn = jest.fn();

const mockRows: Record<string, Record<string, unknown>[]> = {};

jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));

// One fake table per name: `order()` answers the target listing, `single()`
// answers the per-target row load the fan-out does before touching a host.
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {};
      const rows = () => (mockRows[table] ?? []).filter((row) => {
        if (filters.user_id !== undefined && row.user_id !== filters.user_id) return false;
        const inIds = filters["in:id"] as unknown[] | undefined;
        if (inIds && !inIds.includes(row.id)) return false;
        return true;
      });
      chain.select = jest.fn(() => chain);
      chain.eq = jest.fn((column: string, value: unknown) => { filters[column] = value; return chain; });
      chain.in = jest.fn((column: string, values: unknown[]) => { filters[`in:${column}`] = values; return chain; });
      chain.neq = jest.fn(() => chain);
      chain.order = jest.fn(async () => ({ data: rows(), error: null }));
      chain.single = jest.fn(async () => ({ data: rows().find((row) => row.id === filters.id) ?? null, error: null }));
      // Awaiting the builder itself (no terminal call) resolves the row set,
      // same as the real PostgrestBuilder thenable.
      chain.then = (resolve: (v: { data: unknown[]; error: null }) => void) =>
        resolve({ data: rows(), error: null });
      return chain;
    },
  },
}));

jest.mock("@/lib/authenticated-rate-limit", () => ({
  RATE_LIMIT_PRESETS: { settingsWrite: {} },
  enforceAuthenticatedRouteRateLimit: () => null,
}));

jest.mock("@/lib/hivra/agent-execution-context", () => ({
  ...jest.requireActual("@/lib/hivra/agent-execution-context"),
  resolveHivraAgentExecutionContext: (...args: unknown[]) => mockResolveExecutionContext(...args),
}));

// The ambient managed-fleet resolvers the fan-out used to call. They must never
// run for a tool install: every host comes from the agent's own binding.
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  ...jest.requireActual("@/lib/services/proxmox-instance-service"),
  resolveProxmoxTargetConfiguration: (...args: unknown[]) => mockAmbientTargetConfiguration(...args),
}));
jest.mock("@/lib/hivra/proxmox-target", () => ({
  ...jest.requireActual("@/lib/hivra/proxmox-target"),
  resolveHivraProxmoxHost: (...args: unknown[]) => mockAmbientHost(...args),
}));

jest.mock("@/lib/hivra/tool-install", () => ({
  installToolsOnBox: (...args: unknown[]) => mockInstallToolsOnBox(...args),
  uninstallToolFromBox: (...args: unknown[]) => mockUninstallToolFromBox(...args),
  listInstallableToolMeta: () => [],
  resolveToolMcpSpec: jest.fn(),
}));

jest.mock("@/lib/hivra/hermes-tool-apply", () => ({ applyToolsToHermesInstance: jest.fn() }));

jest.mock("@/data/curated-tools", () => ({
  getToolById: (id: string) => id === "github" ? { id, mcp: { name: "github" }, skillIds: [] } : null,
}));

jest.mock("@/lib/hivra/agent-events", () => ({ logHivraAgentEvent: jest.fn() }));

jest.mock("@/lib/logger", () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: (...args: unknown[]) => mockLogWarn(...args), error: jest.fn() },
}));

const selfManagedEnv = { PROXMOX_NODE: "pve-home", HIVRA_USER_INFRA_CONNECTION: "true" };

function agentRow(overrides: Record<string, unknown>) {
  return {
    user_id: "user-a",
    name: "Agent",
    type: "codex",
    status: "running",
    ip: "10.251.20.61",
    computer_substrate: "proxmox-kvm",
    proxmox_host: "legacy-host-must-not-authorize",
    ...overrides,
  };
}

function request(body: unknown): Request {
  return new Request("https://hivra.cloud/api/tools", {
    method: "POST",
    headers: { Host: "hivra.cloud", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function results(body: unknown) {
  const response = await fanOut(request(body) as never);
  expect(response.status).toBe(200);
  const json = await response.json();
  return json.data.results as { uid: string; ok: boolean; error?: string }[];
}

describe("POST /api/tools CLI fan-out", () => {
  beforeEach(() => {
    mockRows.hivra_agents = [
      agentRow({
        id: "self",
        deployment_mode: "self-managed",
        proxmox_host: "__hivra_self_managed_no_ambient_authority__",
        infrastructure_connection_id: "11111111-1111-4111-8111-111111111111",
        deployment_target_id: "22222222-2222-4222-8222-222222222222",
        infrastructure_connection_revision: 6,
      }),
      agentRow({ id: "provider", computer_substrate: "provider-vm", deployment_mode: "self-managed" }),
    ];
    mockRows.hermes_instances = [];
    mockAuth.mockResolvedValue({ userId: "user-a" });
    mockResolveExecutionContext.mockResolvedValue({ kind: "self-managed", env: selfManagedEnv });
    mockInstallToolsOnBox.mockResolvedValue({ ok: true, installed: ["github"], skipped: [] });
    mockUninstallToolFromBox.mockResolvedValue({ ok: true });
  });

  it("installs on a self-managed box through its owner-bound context, never the ambient host routing", async () => {
    expect(await results({ toolId: "github", targets: ["cli-self"] })).toEqual([{ uid: "cli-self", ok: true, error: undefined }]);
    expect(mockResolveExecutionContext).toHaveBeenCalledWith("user-a", expect.objectContaining({ id: "self", deployment_mode: "self-managed" }));
    expect(mockInstallToolsOnBox).toHaveBeenCalledWith(
      expect.objectContaining({ id: "self", ip: "10.251.20.61" }),
      [{ id: "github", env: {} }],
      selfManagedEnv,
    );
    expect(mockAmbientTargetConfiguration).not.toHaveBeenCalled();
    expect(mockAmbientHost).not.toHaveBeenCalled();
  });

  it("uninstalls through the same owner-bound context", async () => {
    expect(await results({ toolId: "github", targets: ["cli-self"], op: "uninstall" })).toEqual([{ uid: "cli-self", ok: true, error: undefined }]);
    expect(mockUninstallToolFromBox).toHaveBeenCalledWith(expect.objectContaining({ id: "self" }), "github", selfManagedEnv);
    expect(mockAmbientTargetConfiguration).not.toHaveBeenCalled();
  });

  it("skips a provider computer with a plain reason and never resolves a host for it", async () => {
    expect(await results({ toolId: "github", targets: ["cli-provider"] })).toEqual([{
      uid: "cli-provider",
      ok: false,
      error: "Catalog tools aren't available on computers in your own cloud yet. Use Advanced MCP.",
    }]);
    expect(mockResolveExecutionContext).not.toHaveBeenCalled();
    expect(mockInstallToolsOnBox).not.toHaveBeenCalled();
    expect(mockAmbientTargetConfiguration).not.toHaveBeenCalled();
    expect(mockAmbientHost).not.toHaveBeenCalled();
  });

  it("reports a stale infrastructure binding in readable copy without touching the box", async () => {
    mockResolveExecutionContext.mockRejectedValueOnce(new ProxmoxExecutionContextError("connection_stale"));
    expect(await results({ toolId: "github", targets: ["cli-self"] })).toEqual([{
      uid: "cli-self",
      ok: false,
      error: "This agent's infrastructure connection changed. Check it again before controlling the agent.",
    }]);
    expect(mockInstallToolsOnBox).not.toHaveBeenCalled();
  });

  it("keeps raw host errors in the log and shows plain copy", async () => {
    const raw = "Proxmox target pve-home is missing target-specific values for PROXMOX_SSH_HOST; refusing to inherit ambient host routing";
    mockInstallToolsOnBox.mockResolvedValueOnce({ ok: false, installed: [], skipped: [], error: raw });
    const [result] = await results({ toolId: "github", targets: ["cli-self"] });
    expect(result).toEqual({
      uid: "cli-self",
      ok: false,
      error: "Couldn't install the tool on this agent. Check that it's running, then try again.",
    });
    expect(mockLogWarn).toHaveBeenCalledWith("tools fan-out host operation failed", expect.objectContaining({
      agentId: "self",
      op: "install",
      errorMessage: raw,
    }));
  });
});

describe("POST /api/tools Hermes reconcile", () => {
  const applyTools = applyToolsToHermesInstance as jest.Mock;
  const resolveSpec = resolveToolMcpSpec as jest.Mock;

  function hermesRow(config: Record<string, unknown>) {
    return {
      id: "h1",
      user_id: "user-a",
      name: "Hermes",
      status: "running",
      lifecycle_state: "active",
      config,
    };
  }

  const storedSearxng = {
    command: "npx",
    args: ["-y", "mcp-searxng"],
    env: { SEARXNG_URL: "https://searx.example" },
  };
  const expectedSearxngEntry = { name: "searxng", ...storedSearxng };

  function appliedEntries(): { name: string; env?: Record<string, string> }[] {
    return applyTools.mock.calls[0][0].entries;
  }

  beforeEach(() => {
    mockRows.hivra_agents = [];
    mockAuth.mockResolvedValue({ userId: "user-a" });
    applyTools.mockReset().mockResolvedValue({ applied: true });
    resolveSpec.mockReset().mockReturnValue({
      spec: {
        name: "github",
        command: "npx",
        args: ["-y", "github-mcp"],
        env: { GITHUB_TOKEN: "tok" },
      },
    });
  });

  it("installing a tool keeps every other managed tool, verbatim including resolved env", async () => {
    mockRows.hermes_instances = [
      hermesRow({
        mcp_servers: {
          hivra_searxng: storedSearxng,
          composio: { url: "https://composio.example" },
          mine: { command: "my-server" },
        },
      }),
    ];
    expect(await results({ toolId: "github", targets: ["hermes-h1"], env: { GITHUB_TOKEN: "tok" } }))
      .toEqual([{ uid: "hermes-h1", ok: true, error: undefined }]);
    const entries = appliedEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual(expectedSearxngEntry);
    expect(entries[1]).toEqual(
      expect.objectContaining({ name: "github", command: "npx", env: { GITHUB_TOKEN: "tok" } }),
    );
  });

  it("uninstalling one tool keeps the remaining managed tools", async () => {
    mockRows.hermes_instances = [
      hermesRow({
        mcp_servers: {
          hivra_github: { command: "npx", args: ["-y", "github-mcp"] },
          hivra_searxng: storedSearxng,
        },
      }),
    ];
    expect(await results({ toolId: "github", targets: ["hermes-h1"], op: "uninstall" }))
      .toEqual([{ uid: "hermes-h1", ok: true, error: undefined }]);
    expect(appliedEntries()).toEqual([expectedSearxngEntry]);
    expect(resolveSpec).not.toHaveBeenCalled();
  });

  it("uninstalling the last managed tool sends an empty desired set", async () => {
    mockRows.hermes_instances = [
      hermesRow({ mcp_servers: { hivra_github: { command: "npx" }, mine: { command: "x" } } }),
    ];
    await results({ toolId: "github", targets: ["hermes-h1"], op: "uninstall" });
    expect(appliedEntries()).toEqual([]);
  });

  it("reconciles a target listed twice once, and answers both request entries", async () => {
    mockRows.hermes_instances = [hermesRow({ mcp_servers: { mine: { command: "x" } } })];
    expect(await results({ toolId: "github", targets: ["hermes-h1", "hermes-h1"] })).toEqual([
      { uid: "hermes-h1", ok: true, error: undefined },
      { uid: "hermes-h1", ok: true, error: undefined },
    ]);
    expect(applyTools).toHaveBeenCalledTimes(1);
  });

  it("installing the first tool on an agent with no managed tools sends just that entry", async () => {
    mockRows.hermes_instances = [hermesRow({ mcp_servers: { mine: { command: "x" } } })];
    await results({ toolId: "github", targets: ["hermes-h1"] });
    expect(appliedEntries().map((e) => e.name)).toEqual(["github"]);
  });
});
