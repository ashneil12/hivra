import { NextRequest } from "next/server";
import { POST } from "../route";
import { manageCapabilitiesFor } from "@/lib/hivra/manage-capabilities";
import type { ManageCap } from "@/lib/hivra/manage-sections";

// Parity between what Manage offers and what the lifecycle route does. For
// each kind of computer and action: when the capability map says a control is
// unavailable, the route refuses it before any lease or host call; when the map
// says it is available, the route gets past its support checks (into its lease
// claim or its adapter's rate limit, each stubbed here).

const mockAuth = jest.fn();
const mockRpc = jest.fn();
const mockRunHostScript = jest.fn();
const mockReadiness = jest.fn();
const mockRateLimit = jest.fn();
const mockMutateGvisor = jest.fn();
const mockManagedSessionAction = jest.fn();
const mockMatchPrepared = jest.fn();
let mockRow: Record<string, unknown>;

jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));
jest.mock("@/lib/hivra/hivra-flag", () => ({ isHivraApiAllowed: () => true }));
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn(async () => ({ data: mockRow, error: null })),
      maybeSingle: jest.fn(async () => ({ data: null, error: null })),
    }),
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}));
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  resolveProxmoxTargetConfiguration: () => ({ env: { PROXMOX_PRIVATE_SUBNET_PREFIX: "10.250.21", PROXMOX_VMID_START: "1090", PROXMOX_IP_LAST_OCTET_START: "90" } }),
  runProxmoxHostScript: (...args: unknown[]) => mockRunHostScript(...args),
  buildAgentContainerCgroupScript: () => "",
}));
jest.mock("@/lib/infrastructure/proxmox-execution-context", () => {
  class ProxmoxExecutionContextError extends Error {
    constructor(public readonly code: string) { super(code); }
  }
  return {
    ProxmoxExecutionContextError,
    resolveSelfManagedProxmoxExecutionContext: async () => ({
      kind: "self-managed", connectionId: "11111111-1111-4111-8111-111111111111", targetId: "22222222-2222-4222-8222-222222222222",
      connectionRevision: 3, target: { capacity: { cpu: { totalCores: 16 }, memoryBytes: { total: 64 * 1024 ** 3 } } },
      env: { PROXMOX_NODE: "pve-home", PROXMOX_PRIVATE_SUBNET_PREFIX: "10.251.20", PROXMOX_VMID_START: "400", PROXMOX_IP_LAST_OCTET_START: "50" },
      runtime: { node: "pve-home", storage: "fast-zfs", provisionerDirectory: "/opt/hivra/provisioner", vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator", logDirectory: "/var/log/hivra" },
    }),
  };
});
jest.mock("@/lib/hivra/managed-provisioner-readiness", () => ({
  checkManagedHivraHostReadiness: (...args: unknown[]) => mockReadiness(...args),
}));
jest.mock("@/lib/hivra/agent-events", () => ({ logHivraAgentEvent: jest.fn(async () => undefined) }));
jest.mock("@/lib/proxmox/wake-admission", () => ({ checkHostWakeCapacity: async () => ({ ok: true, freeMb: 32_768 }) }));
jest.mock("@/lib/hivra/resource-gate", () => ({ validateAgentResources: async () => ({ ok: true }) }));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("@/lib/remote-computers/session-broker", () => ({ revokeRemoteDesktopCapability: async () => ({ ok: true, revoked: true }) }));
jest.mock("@/lib/hivra/provider-agent-power", () => ({ advanceProviderAgentPower: jest.fn() }));
jest.mock("@/lib/hivra/provider-agent-power-store", () => ({ claimProviderAgentPowerOperation: async () => false }));
jest.mock("@/lib/authenticated-rate-limit", () => ({ enforceAuthenticatedRouteRateLimit: (...args: unknown[]) => mockRateLimit(...args) }));
jest.mock("@/lib/hivra/gvisor-computer-service", () => ({
  ...jest.requireActual("@/lib/hivra/gvisor-computer-service"),
  mutateGvisorComputer: (...args: unknown[]) => mockMutateGvisor(...args),
}));
jest.mock("@/lib/hivra/do-managed-sessions", () => ({ managedSessionAction: (...args: unknown[]) => mockManagedSessionAction(...args) }));
jest.mock("@/lib/hivra/prepared-canary-computers", () => ({
  matchPreparedCanaryComputer: (...args: unknown[]) => mockMatchPrepared(...args),
  preparedCanaryLifecycleScript: () => "prepared-lifecycle",
}));

const SENTINEL = 418;
const base = {
  id: "agent-1", user_id: "owner", name: "Fixture", status: "running", desired_state: "running", cpu: 2, ram: 4,
  vmid: 1113, ip: "10.250.21.63", proxmox_host: "fixturenode11", deployment_mode: "hivra-managed", computer_substrate: "proxmox-kvm",
  infrastructure_binding_token_hash: "b".repeat(64), infrastructure_binding_token_enforced: true,
  operation_id: null, operation_kind: null, chat_url: "https://box-agent-1.example.test", api_token: "fixture-bearer",
};
const rows: Record<string, Record<string, unknown>> = {
  ubuntu: { ...base, type: "linux-desktop", computer_profile: "ubuntu-desktop" },
  codex: { ...base, type: "codex" },
  codexUnbound: { ...base, type: "codex", infrastructure_binding_token_enforced: false },
  deepseek: { ...base, type: "deepseek-harness" },
  preparedWindows: { ...base, type: "linux-desktop", computer_profile: "windows", managed_provisioner_channel: "canary", cpu: 4, ram: 8 },
  preparedStale: { ...base, type: "linux-desktop", computer_profile: "omarchy", managed_provisioner_channel: "canary", cpu: 4, ram: 8 },
  windowsMyServer: { ...base, type: "linux-desktop", computer_profile: "windows", deployment_mode: "self-managed" },
  hetzner: { ...base, type: "linux-desktop", computer_profile: "ubuntu-desktop", computer_substrate: "provider-vm", deployment_mode: "self-managed", vmid: null },
  gvisor: { ...base, type: "linux-desktop", computer_profile: "linux-terminal", computer_substrate: "gvisor", deployment_mode: "self-managed", vmid: null },
  digitalocean: { ...base, type: "codex", computer_substrate: "do-managed-session", deployment_mode: "self-managed", vmid: null },
};
const preparedSlotMatches = (name: string) => name === "preparedWindows";

type Action = "start" | "stop" | "restart" | "resize" | "snapshot" | "update_runtime";

function capFor(name: string, action: Action): ManageCap | null {
  const row = action === "start" ? { ...rows[name], status: "stopped", desired_state: "stopped" } : rows[name];
  const manage = manageCapabilitiesFor(row, { preparedMatch: preparedSlotMatches(name) });
  switch (action) {
    case "start": return manage.power.start;
    case "stop": return manage.power.stop;
    case "restart": return manage.power.restart;
    case "resize":
      return manage.resize.kind === "fixed" ? manage.resize.cap
        : manage.resize.kind === "hetzner-server-type" ? { state: "unavailable", code: "provider_resize_flow", reason: "" }
          : manage.resize.cap;
    case "snapshot": return manage.restorePoints;
    case "update_runtime": return manage.connectionServiceUpdate;
  }
}

async function send(name: string, action: Action) {
  mockRow = action === "start" ? { ...rows[name], status: "stopped", desired_state: "stopped" } : { ...rows[name] };
  mockMatchPrepared.mockImplementation(() => preparedSlotMatches(name)
    ? { profile: "windows", slot: { host: "fixturenode11", node: "fixturenode11", vmid: 1113, ip: "10.250.21.63", claim: "33333333-3333-4333-8333-333333333333" } }
    : null);
  const body = action === "resize" ? { action, cpu: 2, ram: 4, maximumCpu: 2, maximumRam: 4 } : { action };
  const request = new NextRequest("https://hivra.cloud/api/hivra/agents/agent-1/action", {
    method: "POST",
    headers: { Host: "hivra.cloud", Origin: "https://hivra.cloud", "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(request, { params: Promise.resolve({ id: "agent-1" }) });
}

/** Past the support checks: a stubbed adapter rate limit, a lease claim, or the adapter call. */
function passedSupportChecks(response: Response): boolean {
  return response.status === SENTINEL
    || mockRpc.mock.calls.some(([name]) => /^(claim|begin)_hivra_agent/.test(String(name)))
    || mockMutateGvisor.mock.calls.length > 0
    || mockManagedSessionAction.mock.calls.length > 0;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.mockResolvedValue({ userId: "owner" });
  mockRpc.mockResolvedValue({ data: false, error: null });
  mockRunHostScript.mockResolvedValue({ ok: false, stdout: "", stderr: "not reached" });
  // The host is ready; the lease claim below is where an accepted action stops.
  mockReadiness.mockResolvedValue({ ok: true });
  // The resize floor asks the computer about its browser; it answers "off".
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ enabled: false }) })) as unknown as typeof fetch;
  // Only the adapters' own rate limits answer; they come right after the support checks.
  mockRateLimit.mockImplementation((_request: unknown, options: { routeKey: string }) =>
    ["prepared_computer_lifecycle", "provider_agent_power"].includes(options.routeKey)
      ? new Response(JSON.stringify({ success: false }), { status: SENTINEL })
      : null);
  mockMutateGvisor.mockResolvedValue({ ...rows.gvisor });
  mockManagedSessionAction.mockResolvedValue({ status: "ready" });
});

const cases: Array<[string, Action]> = [];
for (const name of Object.keys(rows)) {
  for (const action of ["start", "stop", "restart", "resize", "snapshot", "update_runtime"] as Action[]) cases.push([name, action]);
}

describe("Manage capability map ↔ lifecycle route", () => {
  it.each(cases)("%s %s: the route does what the map offers", async (name, action) => {
    const cap = capFor(name, action);
    const response = await send(name, action);
    if (cap?.state === "available") {
      expect(passedSupportChecks(response)).toBe(true);
    } else if (cap === null || cap.state === "unavailable") {
      expect([400, 409]).toContain(response.status);
      expect(passedSupportChecks(response)).toBe(false);
      expect(mockRunHostScript).not.toHaveBeenCalled();
    }
  });

  it("refuses the specific cases Manage used to offer", async () => {
    // Restore points on an older, unbound computer (Manage offered Create).
    expect((await send("codexUnbound", "snapshot")).status).toBe(409);
    // A Windows computer on My server (Manage offered Start/Stop/Restart).
    const windows = await send("windowsMyServer", "stop");
    expect(windows.status).toBe(409);
    expect(await windows.json()).toMatchObject({ error: expect.not.stringMatching(/canary/i) });
    // DeepSeek's in-place update.
    expect((await send("deepseek", "update_runtime")).status).toBe(409);
  });
});
