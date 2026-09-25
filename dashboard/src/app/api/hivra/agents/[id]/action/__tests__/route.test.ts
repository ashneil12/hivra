import { POST } from "../route";
import { NextRequest } from "next/server";
import { ProxmoxExecutionContextError } from "@/lib/infrastructure/proxmox-execution-context";
import { PORTABLE_HIVRA_PROVISIONER_VERSION } from "@/lib/infrastructure/portable-provisioner-contract";
import { verifyActivityCollectorToken } from "@/lib/activity-observability/auth";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const mockAuth = jest.fn();
const mockSupabaseFrom = jest.fn();
const mockSupabaseRpc = jest.fn();
const mockRunProxmoxHostScript = jest.fn();
const mockRevokeRemoteDesktopCapability = jest.fn();
jest.mock("@/lib/remote-computers/session-broker", () => ({
  revokeRemoteDesktopCapability: (...args: unknown[]) => mockRevokeRemoteDesktopCapability(...args),
}));
const mockResolveProxmoxTargetConfiguration = jest.fn();
const mockResolveSelfManagedProxmoxExecutionContext = jest.fn();
const mockLogInfo = jest.fn();
const mockCheckManagedHivraHostReadiness = jest.fn();
// The pool/plan gate has its own coverage via the launch-route test; here we
// stub it so the resize lifecycle tests don't need a full subscription fixture.
const mockValidateAgentResources = jest.fn();
const mockCheckHostWakeCapacity = jest.fn();
const mockProviderPower = jest.fn(), mockClaimProviderPower = jest.fn(), mockProviderRateLimit = jest.fn();
const mockMutateGvisorComputer = jest.fn();
jest.mock("@/lib/hivra/provider-agent-power", () => ({ advanceProviderAgentPower: (...args: unknown[]) => mockProviderPower(...args) }));
jest.mock("@/lib/hivra/provider-agent-power-store", () => ({ claimProviderAgentPowerOperation: (...args: unknown[]) => mockClaimProviderPower(...args) }));
jest.mock("@/lib/authenticated-rate-limit", () => ({ enforceAuthenticatedRouteRateLimit: (...args: unknown[]) => mockProviderRateLimit(...args) }));
jest.mock("@/lib/hivra/gvisor-computer-service", () => ({
  ...jest.requireActual("@/lib/hivra/gvisor-computer-service"),
  mutateGvisorComputer: (...args: unknown[]) => mockMutateGvisorComputer(...args),
}));
// claude-code/codex ship a browser, so the resize path probes the box's live
// /api/browser/status to decide the floor. Stub global fetch so these tests
// control that live state instead of hitting (and failing-safe on) a real box.
const mockFetch = jest.fn();
let mockAgent: Record<string, unknown>;
let mockSnapshot: Record<string, unknown>;
let mockLifecycleUpdateError: unknown;
let mockContinueOperationResult: boolean;

jest.mock("@clerk/nextjs/server", () => ({
  auth: () => mockAuth(),
}));

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockSupabaseFrom(...args),
    rpc: (...args: unknown[]) => mockSupabaseRpc(...args),
  },
}));

jest.mock("@/lib/hivra/hivra-flag", () => ({
  isHivraApiAllowed: () => true,
}));

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  resolveProxmoxTargetConfiguration: (...args: unknown[]) => mockResolveProxmoxTargetConfiguration(...args),
  runProxmoxHostScript: (...args: unknown[]) => mockRunProxmoxHostScript(...args),
  buildAgentContainerCgroupScript: ({ memoryMb, cpus, strict }: { memoryMb: number; cpus: number; strict?: boolean }) =>
    `CGROUP memory=${memoryMb} cpus=${cpus} strict=${strict === true}`,
}));

jest.mock("@/lib/infrastructure/proxmox-execution-context", () => {
  class ProxmoxExecutionContextError extends Error {
    constructor(public readonly code: string) {
      super(code);
    }
  }
  return {
    ProxmoxExecutionContextError,
    resolveSelfManagedProxmoxExecutionContext: (...args: unknown[]) =>
      mockResolveSelfManagedProxmoxExecutionContext(...args),
  };
});

jest.mock("@/lib/hivra/managed-provisioner-readiness", () => ({
  MANAGED_HIVRA_RUNTIME_PATHS: {
    provisionerDirectory: "/root/hivra-provisioner",
    storage: "local-lvm",
    bridge: "vmbr1",
    ubuntuImage: "/root/jammy-server-cloudimg-amd64.img",
    vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
    logDirectory: "/root",
  },
  checkManagedHivraHostReadiness: (...args: unknown[]) =>
    mockCheckManagedHivraHostReadiness(...args),
}));

jest.mock("@/lib/hivra/agent-events", () => ({
  logHivraAgentEvent: jest.fn(async () => undefined),
}));

jest.mock("@/lib/proxmox/wake-admission", () => ({
  checkHostWakeCapacity: (...args: unknown[]) => mockCheckHostWakeCapacity(...args),
}));

jest.mock("@/lib/hivra/resource-gate", () => ({
  validateAgentResources: (...args: unknown[]) => mockValidateAgentResources(...args),
}));

jest.mock("@/lib/logger", () => ({
  log: {
    info: (...args: unknown[]) => mockLogInfo(...args),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

function makeRequest(body: Record<string, unknown>) {
  return new Request("https://hivra.cloud/api/hivra/agents/agent-1/action", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "hivra.cloud" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/hivra/agents/[id]/action", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRevokeRemoteDesktopCapability.mockReset().mockResolvedValue({ ok: true, revoked: true });
    mockLifecycleUpdateError = null;
    mockContinueOperationResult = true;
    mockProviderRateLimit.mockReset().mockReturnValue(null);
    mockMutateGvisorComputer.mockReset();
    mockProviderPower.mockReset().mockResolvedValue("action_pending");
    mockClaimProviderPower.mockReset().mockImplementation(async (operation, kind) => {
      mockAgent = { ...mockAgent, operation_id: operation.operationId, operation_kind: kind, status: "provisioning" }; return true;
    });
    mockAuth.mockResolvedValue({ userId: "user-free" });
    mockValidateAgentResources.mockResolvedValue({ ok: true });
    mockCheckHostWakeCapacity.mockResolvedValue({ ok: true, freeMb: 32_768 });
    mockCheckManagedHivraHostReadiness.mockResolvedValue({ ok: true });
    mockSupabaseRpc.mockImplementation(async (name: string) => ({
      data:
        name === "continue_hivra_agent_operation" || name === "continue_hivra_agent_resize_operation"
          ? mockContinueOperationResult
          : name === "complete_hivra_agent_operation" && mockLifecycleUpdateError
            ? false
            : true,
      error: null,
    }));
    mockResolveProxmoxTargetConfiguration.mockReturnValue({
      env: {
        PROXMOX_PRIVATE_SUBNET_PREFIX: "10.250.21",
        PROXMOX_VMID_START: "1090",
        PROXMOX_IP_LAST_OCTET_START: "90",
      },
    });
    mockResolveSelfManagedProxmoxExecutionContext.mockResolvedValue({
      kind: "self-managed",
      connectionId: "11111111-1111-4111-8111-111111111111",
      targetId: "22222222-2222-4222-8222-222222222222",
      connectionRevision: 3,
      target: {
        capacity: {
          cpu: { totalCores: 16 },
          memoryBytes: { total: 64 * 1024 ** 3 },
        },
      },
      env: {
        PROXMOX_NODE: "pve-home",
        HIVRA_USER_INFRA_CONNECTION: "true",
        PROXMOX_PRIVATE_SUBNET_PREFIX: "10.251.20",
        PROXMOX_VMID_START: "400",
        PROXMOX_IP_LAST_OCTET_START: "50",
      },
      runtime: {
        node: "pve-home",
        storage: "fast-zfs",
        provisionerDirectory: "/opt/hivra/provisioner",
        vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
        logDirectory: "/var/log/hivra",
      },
    });
    mockRunProxmoxHostScript.mockResolvedValue({ ok: true, stdout: "kicked\n" });
    // Default: box reports browser OFF, so the floor stays at the 0.5 CPU / 1 GB
    // base. Tests that need browser-ON override this per-call.
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ enabled: false }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;
    mockAgent = {
      id: "agent-1",
      user_id: "user-free",
      type: "claude-code",
      name: "CLAUDE_CODE_AGENT",
      status: "running",
      chat_url: "https://box-agent-1.hivra.cloud",
      api_token: "box-token",
      vmid: 1090,
      proxmox_host: "fixturenode21",
      deployment_mode: "hivra-managed",
      desired_state: "running",
      operation_id: null,
      operation_kind: null,
      operation_started_at: null,
      infrastructure_binding_token_hash: "b".repeat(64),
      infrastructure_binding_token_enforced: false,
      cpu: 1,
      ram: 2,
      pool_id: "pool-free",
    };
    mockSnapshot = {
      id: "11111111-1111-4111-8111-111111111111",
      provider_snapshot_id: "hivra_11111111111141118111111111111111",
      status: "ready",
      snapshot_config_sha256: "c".repeat(64),
    };

    mockSupabaseFrom.mockImplementation((table: string) => {
      if (table === "pools") {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn(async () => ({ data: { priority: 0 }, error: null })),
        };
      }

      if (table === "hivra_agent_snapshots") {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn(async () => ({ data: mockSnapshot, error: null })),
        };
      }

      return {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn(async () => ({
          data: mockAgent,
          error: null,
        })),
        update: jest.fn((payload: Record<string, unknown>) => {
          const updated = { ...mockAgent, ...payload };
          type UpdateChain = {
            eq: () => UpdateChain;
            select: () => UpdateChain;
            single: () => Promise<{ data: typeof updated; error: null }>;
            then: (resolve: (value: { data: typeof updated; error: unknown }) => void) => void;
          };
          const chain: UpdateChain = {
            eq: jest.fn(() => chain),
            select: jest.fn(() => chain),
            single: jest.fn(async () => ({ data: updated, error: null })),
            then: (resolve: (value: { data: Record<string, unknown>; error: unknown }) => void) =>
              resolve({
                data: updated,
                error: "status" in payload ? mockLifecycleUpdateError : null,
              }),
          };
          return chain;
        }),
      };
    });
  });

  it("dispatches a matching reserved=max resize to the gVisor lifecycle service", async () => {
    mockAgent = { ...mockAgent, computer_substrate: "gvisor", vmid: null, type: "linux-terminal", computer_profile: "linux-terminal" };
    mockMutateGvisorComputer.mockResolvedValue({ ...mockAgent, cpu: 2, ram: 4, cpu_max: 2, ram_max: 4 });
    const request = new NextRequest("https://hivra.cloud/api/hivra/agents/agent-1/action", {
      method: "POST",
      headers: { Host: "hivra.cloud", Origin: "https://hivra.cloud", "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resize", cpu: 2, ram: 4, maximumCpu: 2, maximumRam: 4 }),
    });

    const response = await POST(request, { params: Promise.resolve({ id: "agent-1" }) });

    expect(response.status).toBe(200);
    expect(mockMutateGvisorComputer).toHaveBeenCalledWith("user-free", "agent-1", { action: "resize", cpu: 2, ramGb: 4 });
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
  });

  it("rejects a gVisor resize whose maximum differs from its reservation", async () => {
    mockAgent = { ...mockAgent, computer_substrate: "gvisor", vmid: null, type: "linux-terminal", computer_profile: "linux-terminal" };
    const request = new NextRequest("https://hivra.cloud/api/hivra/agents/agent-1/action", {
      method: "POST",
      headers: { Host: "hivra.cloud", Origin: "https://hivra.cloud", "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resize", cpu: 2, ram: 4, maximumCpu: 4, maximumRam: 4 }),
    });
    const response = await POST(request, { params: Promise.resolve({ id: "agent-1" }) });
    expect(response.status).toBe(400);
    expect(mockMutateGvisorComputer).not.toHaveBeenCalled();
  });

  it("creates a durable restore point only from exact provider evidence", async () => {
    mockAgent = {
      ...mockAgent,
      computer_substrate: "proxmox-kvm",
      infrastructure_binding_token_enforced: true,
    };
    mockRunProxmoxHostScript.mockImplementation(async (script: string) => {
      const providerSnapshotId = script.match(/SNAPSHOT='(hivra_[0-9a-f]{32})'/)?.[1];
      return {
        ok: true,
        stdout: `HIVRA_SNAPSHOT_READY ${providerSnapshotId} running ${"d".repeat(64)}\n`,
      };
    });
    const request = new NextRequest("https://hivra.cloud/api/hivra/agents/agent-1/action", {
      method: "POST",
      headers: { Host: "hivra.cloud", Origin: "https://hivra.cloud", "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "snapshot" }),
    });
    const response = await POST(request, { params: Promise.resolve({ id: "agent-1" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { snapshotId: expect.any(String), status: "ready" } });
    expect(mockSupabaseRpc.mock.calls.map((call) => call[0])).toEqual([
      "begin_hivra_agent_snapshot",
      "complete_hivra_agent_snapshot",
    ]);
    const script = mockRunProxmoxHostScript.mock.calls[0][0] as string;
    expect(script).toContain("flock -w 60 8");
    expect(script).toContain("refusing snapshot operation without the exact Hivra binding tag");
    expect(script).toContain('qm snapshot "$VMID" "$SNAPSHOT"');
  });

  it("restores only an owner-scoped ready point and leaves the VM stopped", async () => {
    mockAgent = {
      ...mockAgent,
      computer_substrate: "proxmox-kvm",
      infrastructure_binding_token_enforced: true,
    };
    mockRunProxmoxHostScript.mockResolvedValue({
      ok: true,
      stdout: `HIVRA_RESTORE_COMPLETE ${mockSnapshot.provider_snapshot_id} stopped ${mockSnapshot.snapshot_config_sha256}\n`,
    });
    const request = new NextRequest("https://hivra.cloud/api/hivra/agents/agent-1/action", {
      method: "POST",
      headers: { Host: "hivra.cloud", Origin: "https://hivra.cloud", "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "restore", snapshotId: mockSnapshot.id }),
    });
    const response = await POST(request, { params: Promise.resolve({ id: "agent-1" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { snapshotId: mockSnapshot.id, status: "stopped" } });
    expect(mockSupabaseRpc.mock.calls.map((call) => call[0])).toEqual([
      "begin_hivra_agent_snapshot_restore",
      "complete_hivra_agent_snapshot_restore",
    ]);
    const script = mockRunProxmoxHostScript.mock.calls[0][0] as string;
    expect(script).toContain('qm rollback "$VMID" "$SNAPSHOT"');
    expect(script).not.toContain("qm start");
  });

  it("keeps the specific provider restore error for reconciliation", async () => {
    mockAgent = {
      ...mockAgent,
      computer_substrate: "proxmox-kvm",
      infrastructure_binding_token_enforced: true,
    };
    mockRunProxmoxHostScript.mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "restored VM configuration does not match the selected restore point\n",
      error: "Remote bash exited with code 1",
    });
    const request = new NextRequest("https://hivra.cloud/api/hivra/agents/agent-1/action", {
      method: "POST",
      headers: { Host: "hivra.cloud", Origin: "https://hivra.cloud", "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "restore", snapshotId: mockSnapshot.id }),
    });

    const response = await POST(request, { params: Promise.resolve({ id: "agent-1" }) });

    expect(response.status).toBe(502);
    expect(mockSupabaseRpc).toHaveBeenCalledWith(
      "record_hivra_agent_operation_failure",
      expect.objectContaining({
        p_error: "restored VM configuration does not match the selected restore point",
      }),
    );
  });

  it.each(["snapshot", "restore"])("requires same-origin authority for %s", async action => {
    mockAgent = { ...mockAgent, computer_substrate: "proxmox-kvm", infrastructure_binding_token_enforced: true };
    const request = new NextRequest("https://hivra.cloud/api/hivra/agents/agent-1/action", {
      method: "POST",
      headers: { Host: "hivra.cloud", Origin: "https://foreign.example", "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json" },
      body: JSON.stringify({ action, snapshotId: mockSnapshot.id }),
    });
    expect((await POST(request, { params: Promise.resolve({ id: "agent-1" }) })).status).toBe(403);
    expect(mockSupabaseRpc).not.toHaveBeenCalled();
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
  });

  describe("owner provider computers", () => {
    const params = { params: Promise.resolve({ id: "agent-1" }) };
    function request(action = "restart", headers: Record<string, string> = {}) {
      return new NextRequest("https://hivra.cloud/api/hivra/agents/agent-1/action", { method: "POST",
        headers: { Host: "hivra.cloud", "Content-Type": "application/json", Origin: "https://hivra.cloud", "Sec-Fetch-Site": "same-origin", ...headers },
        body: JSON.stringify({ action, providerServerId: "untrusted", connectionId: "untrusted" }) }) as never;
    }
    beforeEach(() => { mockAgent = { ...mockAgent, computer_substrate: "provider-vm", deployment_mode: "self-managed", vmid: null }; });
    afterEach(() => {
      expect(mockRunProxmoxHostScript).not.toHaveBeenCalled(); expect(mockCheckManagedHivraHostReadiness).not.toHaveBeenCalled();
      expect(mockResolveSelfManagedProxmoxExecutionContext).not.toHaveBeenCalled();
    });
    it.each(["start", "stop", "restart"])("claims %s against the original owner row and returns observed progress", async action => {
      const response = await POST(request(action), params);
      expect(response.status).toBe(202); expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ success: true, data: { agent: { status: "provisioning", power_stage: "action_pending" } } });
      const operation = mockClaimProviderPower.mock.calls[0][0];
      expect(operation).toEqual({ userId: "user-free", agentId: "agent-1", operationId: expect.any(String) });
      expect(mockClaimProviderPower).toHaveBeenCalledWith(operation, action);
      expect(mockProviderPower).toHaveBeenCalledWith(operation, "dispatch");
      expect(mockSupabaseRpc).not.toHaveBeenCalled();
    });
    it.each<Record<string, string>>([{ Origin: "" }, { Origin: "https://other.example" }, { "Sec-Fetch-Site": "cross-site" }])("refuses a foreign mutation boundary %j", async headers => {
      expect((await POST(request("restart", headers), params)).status).toBe(403);
      expect(mockClaimProviderPower).not.toHaveBeenCalled(); expect(mockProviderPower).not.toHaveBeenCalled();
    });
    it("does not send a new power request when a claim conflicts", async () => {
      mockClaimProviderPower.mockResolvedValue(false);
      expect((await POST(request(), params)).status).toBe(409); expect(mockProviderPower).not.toHaveBeenCalled();
    });
    it("does not route provider resize to the managed host", async () => {
      expect((await POST(request("resize"), params)).status).toBe(400); expect(mockClaimProviderPower).not.toHaveBeenCalled();
    });
    it("keeps provider runtime updates fail-closed until their update transport exists", async () => {
      const response = await POST(request("update_runtime"), params);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ success: false, error: expect.stringMatching(/not supported yet/i) });
      expect(mockClaimProviderPower).not.toHaveBeenCalled();
    });
    it("rate limits before taking lifecycle authority", async () => {
      mockProviderRateLimit.mockReturnValue(new Response("Slow down", { status: 429 }));
      expect((await POST(request(), params)).status).toBe(429); expect(mockClaimProviderPower).not.toHaveBeenCalled();
    });
    it("requires authentication and an owner-scoped row", async () => {
      mockAuth.mockResolvedValueOnce({ userId: null });
      expect((await POST(request(), params)).status).toBe(401); expect(mockSupabaseFrom).not.toHaveBeenCalled();
      mockSupabaseFrom.mockReturnValueOnce({ select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), single: async () => ({ data: null }) });
      expect((await POST(request(), params)).status).toBe(404); expect(mockClaimProviderPower).not.toHaveBeenCalled();
    });
    it("reloads real state rather than inferring completion from the engine result", async () => {
      mockProviderPower.mockResolvedValue("running");
      const response = await POST(request(), params);
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ data: { agent: { status: "provisioning" } } });
    });
    it("retains an uncertain operation and does not leak its private transport error", async () => {
      mockProviderPower.mockRejectedValue(new Error("PRIVATE_PROVIDER_KEY"));
      const response = await POST(request(), params), body = await response.json();
      expect(response.status).toBe(202); expect(body.data.agent.power_stage).toBe("verification_unavailable");
      expect(JSON.stringify(body)).not.toContain("PRIVATE_PROVIDER_KEY");
    });
  });

  it("saves onboarding answers and clears bootstrapped_at so the running box is reseeded", async () => {
    const response = await POST(
      makeRequest({
        action: "onboarding",
        goal: "build",
        context: "## Context from launch setup\nI run a React app.",
        personality: "direct and pragmatic",
        emoji: "hammer",
      }) as never,
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(response.status).toBe(200);
    const updateCall = mockSupabaseFrom.mock.results
      .map((result) => result.value?.update?.mock?.calls?.[0]?.[0])
      .find(Boolean);
    expect(updateCall).toEqual(expect.objectContaining({
      goal: "build",
      context: "## Context from launch setup\nI run a React app.",
      personality: "direct and pragmatic",
      emoji: "hammer",
      bootstrapped_at: null,
    }));
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
    expect(mockLogInfo).toHaveBeenCalledWith(
      "hivra agent onboarding answers saved",
      expect.objectContaining({
        failureType: "hivra_agent_onboarding_saved",
        agentId: "agent-1",
        goal: "build",
        hasContext: true,
      }),
    );
  });

  it("preserves existing persona fields when a partial onboarding save omits them", async () => {
    mockAgent = {
      ...mockAgent,
      personality: "curious and rigorous",
      emoji: "🔭",
    };

    const response = await POST(
      makeRequest({
        action: "onboarding",
        goal: "research",
        context: "Compare the available approaches.",
        firstTask: "Write a short recommendation.",
      }) as never,
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(response.status).toBe(200);
    const updateCall = mockSupabaseFrom.mock.results
      .map((result) => result.value?.update?.mock?.calls?.[0]?.[0])
      .find(Boolean);
    expect(updateCall).toEqual(expect.objectContaining({
      goal: "research",
      context: "Compare the available approaches.",
      first_task: "Write a short recommendation.",
      bootstrapped_at: null,
    }));
    expect(updateCall).not.toHaveProperty("personality");
    expect(updateCall).not.toHaveProperty("emoji");
  });

  it("clears persona fields only when onboarding explicitly supplies empty values", async () => {
    mockAgent = {
      ...mockAgent,
      personality: "curious and rigorous",
      emoji: "🔭",
    };

    const response = await POST(
      makeRequest({
        action: "onboarding",
        goal: "research",
        context: "Compare the available approaches.",
        personality: "  ",
        emoji: "",
      }) as never,
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(response.status).toBe(200);
    const updateCall = mockSupabaseFrom.mock.results
      .map((result) => result.value?.update?.mock?.calls?.[0]?.[0])
      .find(Boolean);
    expect(updateCall).toEqual(expect.objectContaining({
      personality: null,
      emoji: null,
    }));
  });

  it("passes the same catalog exemption and floor as launch when resizing Aeon", async () => {
    mockAgent.type = "aeon";
    const response = await POST(makeRequest({ action: "resize", cpu: 0.5, ram: 1 }) as never, { params: Promise.resolve({ id: "agent-1" }) });
    expect(response.status).toBe(200);
    expect(mockValidateAgentResources).toHaveBeenCalledWith(expect.objectContaining({
      type: "aeon", mode: "resize", excludeAgentId: "agent-1", poolExempt: true,
      floor: { cpu: 0.5, ram: 1 }, agentLabel: "Aeon",
    }));
  });

  it("resizes free Claude to 0.5 CPU by using one core plus a half-core scheduler cap", async () => {
    const response = await POST(
      makeRequest({ action: "resize", cpu: 0.5, ram: 1 }) as never,
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mockResolveProxmoxTargetConfiguration).toHaveBeenCalledWith(
      expect.anything(),
      "fixturenode21",
    );
    expect(mockRunProxmoxHostScript).toHaveBeenCalledWith(
      expect.stringContaining("qm set 1090 --cores 1 --cpulimit 0.5 --memory 1024 --balloon 1024 --cpuunits 50;"),
      expect.objectContaining({
        PROXMOX_PRIVATE_SUBNET_PREFIX: "10.250.21",
      }),
    );
    expect(mockRunProxmoxHostScript.mock.calls[0][0]).toContain("HIVRA_SUBNET_PREFIX='10.250.21'");
    expect(mockRunProxmoxHostScript.mock.calls[0][0]).toContain("hivra-start-on-host.sh' 1090 90");
    expect(mockRunProxmoxHostScript.mock.calls[0][0]).not.toContain("qm set 1090 --cores 1 --cpulimit 0.5 --memory 1024 --cpuunits 50 >/dev/null 2>&1 || true");
    // The floor came from the box's LIVE browser state, not a hardcoded OFF.
    expect(mockFetch).toHaveBeenCalledWith(
      "https://box-agent-1.hivra.cloud/api/browser/status",
      expect.objectContaining({ headers: { Authorization: "Bearer box-token" } }),
    );
  });

  it("resizes an explicit envelope with the maximum as quota and guarantee as balloon floor", async () => {
    const response = await POST(
      makeRequest({ action: "resize", cpu: 0.5, ram: 1, maximumCpu: 2, maximumRam: 4 }) as never,
      { params: Promise.resolve({ id: "agent-1" }) },
    );
    expect(response.status).toBe(200);
    expect(mockValidateAgentResources).toHaveBeenCalledWith(expect.objectContaining({
      cpu: 0.5, ram: 1, maximumCpu: 2, maximumRam: 4,
    }));
    expect(mockRunProxmoxHostScript).toHaveBeenCalledWith(
      expect.stringContaining("qm set 1090 --cores 2 --cpulimit 2 --memory 4096 --balloon 1024 --cpuunits 50;"),
      expect.any(Object),
    );
    const script = mockRunProxmoxHostScript.mock.calls[0][0] as string;
    expect(script).toContain("agent container ceiling could not be enforced");
    expect(Buffer.from(script.match(/CGROUP_SCRIPT_B64='([^']+)'/)?.[1] ?? "", "base64").toString("utf8"))
      .toBe("CGROUP memory=4096 cpus=2 strict=true");
    expect(mockSupabaseRpc).toHaveBeenCalledWith("continue_hivra_agent_resize_operation", expect.objectContaining({
      p_cpu: 0.5, p_ram: 1, p_cpu_max: 2, p_ram_max: 4,
    }));
  });

  it("rejects an explicit resize maximum below the reserved allocation before mutation", async () => {
    const response = await POST(
      makeRequest({ action: "resize", cpu: 2, ram: 4, maximumCpu: 1, maximumRam: 2 }) as never,
      { params: Promise.resolve({ id: "agent-1" }) },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ success: false, error: expect.stringMatching(/maximum.*reserved/i) });
    expect(mockValidateAgentResources).not.toHaveBeenCalled();
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
  });

  it("rejects a resize maximum above the selected host's physical totals before changing the VM", async () => {
    mockRunProxmoxHostScript.mockResolvedValueOnce({
      ok: false,
      stdout: "HIVRA_RESOURCE_MAXIMUM_REJECTED\n",
      stderr: "",
    });
    const response = await POST(
      makeRequest({ action: "resize", cpu: 0.5, ram: 1, maximumCpu: 4, maximumRam: 8 }) as never,
      { params: Promise.resolve({ id: "agent-1" }) },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ success: false, error: expect.stringMatching(/selected host.*maximum/i) });
    const script = mockRunProxmoxHostScript.mock.calls[0][0] as string;
    expect(script.indexOf("HIVRA_RESOURCE_MAXIMUM_REJECTED")).toBeLessThan(script.indexOf("OLD_CONFIG="));
    expect(mockSupabaseRpc).toHaveBeenCalledWith("release_hivra_agent_operation", expect.objectContaining({ p_mark_error: false }));
    expect(mockSupabaseRpc.mock.calls.some(([rpc]) => rpc === "continue_hivra_agent_resize_operation")).toBe(false);
  });

  it("reapplies the container ceiling when omitted maxima rise to the new guarantee", async () => {
    mockAgent.cpu_max = 1;
    mockAgent.ram_max = 2;
    const response = await POST(
      makeRequest({ action: "resize", cpu: 2, ram: 4 }) as never,
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(response.status).toBe(200);
    const script = mockRunProxmoxHostScript.mock.calls[0][0] as string;
    expect(Buffer.from(script.match(/CGROUP_SCRIPT_B64='([^']+)'/)?.[1] ?? "", "base64").toString("utf8"))
      .toBe("CGROUP memory=4096 cpus=2 strict=true");
    expect(mockSupabaseRpc).toHaveBeenCalledWith("continue_hivra_agent_resize_operation", expect.objectContaining({
      p_cpu: 2, p_ram: 4, p_cpu_max: 2, p_ram_max: 4,
    }));
  });

  it("restores the full prior VM and container envelope when guest cgroup enforcement fails", async () => {
    mockAgent.cpu_max = 1;
    mockAgent.ram_max = 2;
    mockRunProxmoxHostScript.mockResolvedValueOnce({
      ok: false,
      stdout: "HIVRA_RESIZE_ROLLED_BACK\n",
      stderr: "agent container ceiling could not be enforced",
    });

    const response = await POST(
      makeRequest({ action: "resize", cpu: 2, ram: 4, maximumCpu: 4, maximumRam: 8 }) as never,
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(response.status).toBe(502);
    const script = mockRunProxmoxHostScript.mock.calls[0][0] as string;
    expect(script).toContain('qm set 1090 --cores "$OLD_CORES" --cpulimit "$OLD_CPULIMIT" --memory "$OLD_MEMORY" --balloon "$OLD_BALLOON" --cpuunits "$OLD_CPUUNITS"');
    expect(script).toContain("restore_previous_size_and_restart 1");
    expect(Buffer.from(script.match(/PREVIOUS_CGROUP_SCRIPT_B64='([^']+)'/)?.[1] ?? "", "base64").toString("utf8"))
      .toBe("CGROUP memory=2048 cpus=1 strict=true");
    expect(mockSupabaseRpc).toHaveBeenCalledWith("release_hivra_agent_operation", expect.objectContaining({ p_mark_error: false }));
    expect(mockSupabaseRpc.mock.calls.some(([rpc]) => rpc === "record_hivra_agent_operation_failure")).toBe(false);
    expect(mockSupabaseRpc.mock.calls.some(([rpc]) => rpc === "continue_hivra_agent_resize_operation")).toBe(false);
  });

  it("keeps Linux desktop resize free of agent-container cgroup commands", async () => {
    mockAgent.type = "linux-desktop";
    const response = await POST(
      makeRequest({ action: "resize", cpu: 2, ram: 4, maximumCpu: 4, maximumRam: 8 }) as never,
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mockRunProxmoxHostScript.mock.calls[0][0]).not.toContain("CGROUP_SCRIPT_B64");
  });

  it.each([
    ["start", { action: "start" }],
    ["restart", { action: "restart" }],
    ["resize", { action: "resize", cpu: 2, ram: 4 }],
  ])(
    "fails closed before claiming or mutating when the exact managed host cannot prove the current helper for %s",
    async (_name, body) => {
      mockCheckManagedHivraHostReadiness.mockResolvedValueOnce({
        ok: false,
        status: 503,
        message:
          "Deployment target is temporarily unavailable while the Hivra provisioner is being prepared. Please try again shortly.",
        error: {
          code: "HIVRA_HOST_READINESS_FAILED",
          targetId: "fixturenode21",
          reason: "Hivra provisioner version mismatch",
        },
      });

      const response = await POST(
        makeRequest(body) as never,
        { params: Promise.resolve({ id: "agent-1" }) },
      );

      expect(response.status).toBe(503);
      expect(mockCheckManagedHivraHostReadiness).toHaveBeenCalledWith({
        targetId: "fixturenode21",
        env: expect.objectContaining({
          PROXMOX_PRIVATE_SUBNET_PREFIX: "10.250.21",
        }),
        channel: "default",
        purpose: "lifecycle",
      });
      expect(mockSupabaseRpc).not.toHaveBeenCalled();
      expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    },
  );

  it("refuses to resize a browser-ON box below its 2 CPU / 4 GB browser floor", async () => {
    // Box reports browser ENABLED -> claude-code floor is base (0.5/1) + browser
    // surcharge (1/2) = 1.5 CPU / 3 GB. A request to drop to 0.5 CPU / 1 GB must
    // clamp UP to that floor so the Chrome/Xvfb/VNC stack can't be bricked.
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ enabled: true }),
    });

    const response = await POST(
      makeRequest({ action: "resize", cpu: 0.5, ram: 1 }) as never,
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(response.status).toBe(200);
    // Floor enforced: cores=ceil(1.5)=2, cpulimit=1.5, memory=3*1024=3072.
    expect(mockRunProxmoxHostScript).toHaveBeenCalledWith(
      expect.stringContaining("qm set 1090 --cores 2 --cpulimit 1.5 --memory 3072 --balloon 3072 --cpuunits 50;"),
      expect.objectContaining({ PROXMOX_PRIVATE_SUBNET_PREFIX: "10.250.21" }),
    );
    // The resize must never land below the browser floor.
    expect(mockRunProxmoxHostScript.mock.calls[0][0]).not.toContain("--cpulimit 0.5");
    expect(mockRunProxmoxHostScript.mock.calls[0][0]).not.toContain("--memory 1024");
    // And the gate saw the live browser-ON state, not browser:false.
    expect(mockValidateAgentResources).toHaveBeenCalledWith(
      expect.objectContaining({ browser: true, cpu: 1.5, ram: 3 }),
    );
  });

  it("starts using the selected host's VMID-to-IP range instead of the old 1000-based test range", async () => {
    mockAgent = {
      ...mockAgent,
      vmid: 320,
      proxmox_host: "fixturenode3",
      ram: 2,
    };
    mockResolveProxmoxTargetConfiguration.mockReturnValueOnce({
      env: {
        PROXMOX_PRIVATE_SUBNET_PREFIX: "10.250.20",
        PROXMOX_VMID_START: "300",
        PROXMOX_IP_LAST_OCTET_START: "80",
      },
    });

    const response = await POST(
      makeRequest({ action: "start" }) as never,
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mockResolveProxmoxTargetConfiguration).toHaveBeenCalledWith(
      expect.anything(),
      "fixturenode3",
    );
    expect(mockRunProxmoxHostScript).toHaveBeenCalledWith(
      expect.stringContaining("hivra-start-on-host.sh' 320 100"),
      expect.objectContaining({
        PROXMOX_PRIVATE_SUBNET_PREFIX: "10.250.20",
        PROXMOX_VMID_START: "300",
        PROXMOX_IP_LAST_OCTET_START: "80",
      }),
    );
  });

  it.each(["start", "restart"] as const)(
    "passes the reviewed managed SSH and exact %s result-log contract to the current helper",
    async (action) => {
      const response = await POST(
        makeRequest({ action }) as never,
        { params: Promise.resolve({ id: "agent-1" }) },
      );

      expect(response.status).toBe(200);
      const script = String(mockRunProxmoxHostScript.mock.calls[0][0]);
      expect(script).toContain("HIVRA_LOG_DIR='/root'");
      expect(script).toContain("HIVRA_RESULT_LOG_PATH='/root/hivra-start-1090.log'");
      expect(script).toContain("HIVRA_VM_SSH_KEY_PATH='/etc/hivra/keys/vm-orchestrator'");
      expect(script).toContain("bash '/root/hivra-provisioner/hivra-start-on-host.sh' 1090 90");
    },
  );

  it("uses the persisted Canary channel for ordinary lifecycle without consulting the deployment environment", async () => {
    mockAgent = {
      ...mockAgent,
      computer_substrate: "proxmox-kvm",
      managed_provisioner_channel: "canary",
    };

    const response = await POST(
      makeRequest({ action: "start" }) as never,
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mockCheckManagedHivraHostReadiness).toHaveBeenCalledWith(expect.objectContaining({
      channel: "canary",
      purpose: "lifecycle",
    }));
    expect(String(mockRunProxmoxHostScript.mock.calls[0][0])).toContain(
      "bash '/root/hivra-provisioner-canary/hivra-start-on-host.sh' 1090 90",
    );
  });

  it.each((["windows", "omarchy"] as const).flatMap(profile =>
    (["start", "stop", "restart"] as const).map(action => [profile, action] as const)))(
    "routes a prepared %s %s through its exact lifecycle after capability invalidation",
    async (profile, action) => {
      const priorChannel = process.env.HIVRA_MANAGED_PROVISIONER_CHANNEL;
      const priorSlots = process.env.HIVRA_CANARY_PREPARED_COMPUTERS_JSON;
      process.env.HIVRA_MANAGED_PROVISIONER_CHANNEL = "canary";
      process.env.HIVRA_CANARY_PREPARED_COMPUTERS_JSON = JSON.stringify({
        omarchy: { host: "node-b", node: "node-b", vmid: 2099, ip: "10.240.20.99", claim: "019d13b0-4f19-7f55-9a22-83e72232d8c1" },
        windows: { host: "node-b", node: "node-b", vmid: 2098, ip: "10.240.20.98", claim: "00000000-0000-4000-8000-000000001005" },
      });
      try {
        mockAgent = {
          ...mockAgent,
          type: "linux-desktop",
          computer_profile: profile,
          managed_provisioner_channel: "canary",
          proxmox_host: "node-b",
          vmid: profile === "windows" ? 2098 : 2099,
          ip: profile === "windows" ? "10.240.20.98" : "10.240.20.99",
          ram: 8,
        };
        const finalState = action === "stop" ? "stopped" : "running";
        mockRunProxmoxHostScript.mockResolvedValueOnce({
          ok: true,
          stdout: `HIVRA_PREPARED_LIFECYCLE ${profile} ${action} ${finalState}\n`,
          stderr: "",
        });
        const response = await POST(new NextRequest("https://hivra.cloud/api/hivra/agents/agent-1/action", {
          method: "POST",
          headers: { Host: "hivra.cloud", Origin: "https://hivra.cloud", "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        }) as never, { params: Promise.resolve({ id: "agent-1" }) });

        expect(response.status).toBe(200);
        expect(mockRevokeRemoteDesktopCapability).toHaveBeenCalledWith({ userId: "user-free", computerKind: "hivra-agent", computerId: "agent-1" });
        const claimCall = mockSupabaseRpc.mock.calls.findIndex(([name]) => name === "claim_hivra_agent_operation");
        expect(mockSupabaseRpc.mock.invocationCallOrder[claimCall]).toBeLessThan(mockRevokeRemoteDesktopCapability.mock.invocationCallOrder[0]);
        expect(mockRevokeRemoteDesktopCapability.mock.invocationCallOrder[0]).toBeLessThan(mockRunProxmoxHostScript.mock.invocationCallOrder[0]);
        expect(mockSupabaseRpc).toHaveBeenCalledWith("claim_hivra_agent_operation", expect.objectContaining({
          p_operation_kind: action,
          p_desired_state: finalState,
        }));
        const script = String(mockRunProxmoxHostScript.mock.calls[0][0]);
        expect(script).toContain(profile === "windows"
          ? "hivra-windows-operation%3A00000000-0000-4000-8000-000000001005"
          : "hivra-omarchy-operation%3A019d13b0-4f19-7f55-9a22-83e72232d8c1");
        expect(script).toContain(`--onboot ${action === "stop" ? 0 : 1}`);
        expect(script).not.toContain("hivra-start-on-host.sh");
        expect(mockCheckManagedHivraHostReadiness).not.toHaveBeenCalled();
        mockRunProxmoxHostScript.mockClear();
        mockRevokeRemoteDesktopCapability.mockResolvedValueOnce({ ok: false, status: 503 });
        const failure = await POST(new NextRequest("https://hivra.cloud/api/hivra/agents/agent-1/action", {
          method: "POST",
          headers: { Host: "hivra.cloud", Origin: "https://hivra.cloud", "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        }) as never, { params: Promise.resolve({ id: "agent-1" }) });
        expect(failure.status).toBe(503);
        expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
        expect(mockSupabaseRpc).toHaveBeenCalledWith("release_hivra_agent_operation", expect.objectContaining({
          p_user_id: "user-free", p_agent_id: "agent-1", p_mark_error: false,
        }));
      } finally {
        if (priorChannel === undefined) delete process.env.HIVRA_MANAGED_PROVISIONER_CHANNEL;
        else process.env.HIVRA_MANAGED_PROVISIONER_CHANNEL = priorChannel;
        if (priorSlots === undefined) delete process.env.HIVRA_CANARY_PREPARED_COMPUTERS_JSON;
        else process.env.HIVRA_CANARY_PREPARED_COMPUTERS_JSON = priorSlots;
      }
    },
  );

  it("fails closed when a prepared profile no longer matches the admitted slot", async () => {
    mockAgent = {
      ...mockAgent,
      type: "linux-desktop",
      computer_profile: "omarchy",
      managed_provisioner_channel: "canary",
      proxmox_host: "node-b",
      vmid: 2098,
      ip: "10.240.20.99",
    };
    const response = await POST(
      makeRequest({ action: "start" }) as never,
      { params: Promise.resolve({ id: "agent-1" }) },
    );
    expect(response.status).toBe(409);
    expect(mockSupabaseRpc).not.toHaveBeenCalledWith("claim_hivra_agent_operation", expect.anything());
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
  });

  describe("in-place runtime update", () => {
    const RECEIPT = "HIVRA_GUEST_RUNTIME_UPDATED vmid=1090\n";
    const params = () => ({ params: Promise.resolve({ id: "agent-1" }) });
    function updateRequest() {
      return new NextRequest("https://hivra.cloud/api/hivra/agents/agent-1/action", {
        method: "POST",
        headers: {
          Host: "hivra.cloud",
          Origin: "https://hivra.cloud",
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "update_runtime" }),
      }) as never;
    }
    const rpcNames = () => mockSupabaseRpc.mock.calls.map((call) => call[0]);

    it.each([
      ["HIVRA_AGENT_CLI name=codex version=0.149.1 target=0.156.1 state=scheduled", { name: "codex", version: "0.149.1", target: "0.156.1", state: "scheduled" }],
      ["HIVRA_AGENT_CLI name=claude-code version=unknown target=2.1.246 state=failed", { name: "claude-code", version: null, target: "2.1.246", state: "failed" }],
    ])("returns the agent CLI state the updater reported: %s", async (line, agentCli) => {
      mockRunProxmoxHostScript.mockResolvedValue({ ok: true, stdout: `${line}\n${RECEIPT}`, stderr: "" });
      const response = await POST(updateRequest(), params());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true, data: { status: "running", agentCli } });
    });

    it("ignores an agent CLI line in any other shape", async () => {
      mockRunProxmoxHostScript.mockResolvedValue({ ok: true, stdout: `HIVRA_AGENT_CLI name=codex version=0.149.1 target=latest state=scheduled\n${RECEIPT}`, stderr: "" });
      const response = await POST(updateRequest(), params());
      expect(await response.json()).toEqual({ success: true, data: { status: "running" } });
    });

    it("updates the bound guest runtime without powering the computer off and completes it as running", async () => {
      mockRunProxmoxHostScript.mockResolvedValue({ ok: true, stdout: RECEIPT, stderr: "" });
      const response = await POST(updateRequest(), params());

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true, data: { status: "running" } });
      expect(mockCheckManagedHivraHostReadiness).toHaveBeenCalledWith({
        targetId: "fixturenode21",
        env: expect.objectContaining({ PROXMOX_PRIVATE_SUBNET_PREFIX: "10.250.21" }),
        channel: "default",
        purpose: "runtime-update",
      });
      // Fenced exactly as before: the same lease kind and desired state.
      expect(mockSupabaseRpc).toHaveBeenCalledWith("claim_hivra_agent_operation", expect.objectContaining({
        p_operation_kind: "restart",
        p_desired_state: "running",
      }));
      expect(mockRunProxmoxHostScript).toHaveBeenCalledTimes(1);
      const [script, , options] = mockRunProxmoxHostScript.mock.calls[0];
      expect(script).toContain("flock -w 60 8");
      expect(script).toContain("HIVRA_VM_SSH_KEY_PATH='/etc/hivra/keys/vm-orchestrator'");
      expect(script).toContain("bash '/root/hivra-provisioner/hivra-update-guest-runtime.sh' 1090 '10.250.21.90'");
      expect(script.indexOf("flock -w 60 8")).toBeLessThan(script.indexOf("hivra-update-guest-runtime.sh"));
      // The helper inherits FD8 and releases it before its guest steps, and gets
      // a host-side deadline started before the lock wait, inside the request.
      expect(script).toContain("HIVRA_LIFECYCLE_LOCK_FD=8 HIVRA_RUNTIME_UPDATE_DEADLINE=\"$HIVRA_RUNTIME_UPDATE_DEADLINE\" bash '/root/hivra-provisioner/hivra-update-guest-runtime.sh'");
      expect(script.startsWith("HIVRA_RUNTIME_UPDATE_DEADLINE=\"$(( $(date +%s) + 220 ))\"\n")).toBe(true);
      expect(script.indexOf("HIVRA_RUNTIME_UPDATE_DEADLINE=")).toBeLessThan(script.indexOf("flock -w 60 8"));
      expect(spawnSync("bash", ["-n"], { input: script, encoding: "utf8" })).toMatchObject({ status: 0, stderr: "" });
      // No reboot: nothing may stop, shut down, start or re-run the start helper.
      expect(script).not.toMatch(/qm (shutdown|stop|start|reboot|reset)\b/);
      expect(script).not.toContain("hivra-start-on-host.sh");
      expect(script).not.toContain("nohup");
      expect(options).toEqual({ timeoutMs: expect.any(Number) });
      expect(options.timeoutMs).toBeLessThan(300_000);
      // A real completed operation: running, lease released; never "provisioning".
      expect(mockSupabaseRpc).toHaveBeenCalledWith("complete_hivra_agent_operation", expect.objectContaining({
        p_agent_id: "agent-1",
        p_expected_desired_state: "running",
        p_status: "running",
      }));
      expect(rpcNames()).not.toContain("continue_hivra_agent_operation");
      expect(rpcNames()).not.toContain("record_hivra_agent_operation_failure");
      const { logHivraAgentEvent } = jest.requireMock("@/lib/hivra/agent-events") as { logHivraAgentEvent: jest.Mock };
      expect(logHivraAgentEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "runtime_updated", detail: { inPlace: true } }));
      expect(logHivraAgentEvent).not.toHaveBeenCalledWith(expect.objectContaining({ event: "restarted" }));
    });

    it.each([
      ["the host script fails", { ok: false, stdout: "", stderr: "guest runtime update ended without its commit receipt\n", error: "Remote bash exited with code 1" }],
      ["the host times out after the receipt", { ok: false, stdout: RECEIPT, stderr: "", error: "Proxmox SSH operation timed out" }],
      ["the host exits cleanly without a receipt", { ok: true, stdout: "", stderr: "" }],
      ["only the guest's own line is present", { ok: true, stdout: "HIVRA_GUEST_RUNTIME_UPDATED\n", stderr: "" }],
      ["the receipt names another VM", { ok: true, stdout: "HIVRA_GUEST_RUNTIME_UPDATED vmid=1091\n", stderr: "" }],
    ])("keeps the operation for reconciliation when %s", async (_case, result) => {
      mockRunProxmoxHostScript.mockResolvedValue(result);
      const response = await POST(updateRequest(), params());

      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ success: false, error: expect.stringMatching(/could not be verified/i) });
      expect(rpcNames()).toContain("record_hivra_agent_operation_failure");
      expect(rpcNames()).not.toContain("complete_hivra_agent_operation");
      expect(rpcNames()).not.toContain("continue_hivra_agent_operation");
      expect(rpcNames()).not.toContain("release_hivra_agent_operation");
    });

    it("releases a verified update whose completion was superseded instead of claiming it", async () => {
      mockRunProxmoxHostScript.mockResolvedValue({ ok: true, stdout: RECEIPT, stderr: "" });
      mockLifecycleUpdateError = new Error("superseded");
      const response = await POST(updateRequest(), params());

      expect(response.status).toBe(409);
      expect(mockSupabaseRpc).toHaveBeenCalledWith("release_hivra_agent_operation", expect.objectContaining({
        p_mark_error: false,
      }));
    });

    it("refuses a computer that is not running before taking the lease", async () => {
      mockAgent = { ...mockAgent, status: "stopped" };
      const response = await POST(updateRequest(), params());

      expect(response.status).toBe(409);
      expect(mockSupabaseRpc).not.toHaveBeenCalled();
      expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
    });

    it("refuses a DeepSeek computer before any host call or lease, so nothing is locked", async () => {
      mockAgent = { ...mockAgent, type: "deepseek-harness" };
      const response = await POST(updateRequest(), params());

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ success: false, error: expect.stringMatching(/DeepSeek computers can’t update their connection service/) });
      expect(mockCheckManagedHivraHostReadiness).not.toHaveBeenCalled();
      expect(mockSupabaseRpc).not.toHaveBeenCalled();
      expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
    });
  });

  it("fails a self-managed runtime update before claiming authority when its exact bundle is not ready", async () => {
    mockAgent = {
      ...mockAgent,
      deployment_mode: "self-managed",
      infrastructure_binding_token_enforced: true,
      vmid: 420,
      ip: "10.251.20.70",
      infrastructure_connection_id: "11111111-1111-4111-8111-111111111111",
      deployment_target_id: "22222222-2222-4222-8222-222222222222",
      infrastructure_connection_revision: 3,
      proxmox_host: "__hivra_self_managed_no_ambient_authority__",
    };
    mockRunProxmoxHostScript.mockResolvedValueOnce({ ok: false, stderr: "fixture mismatch" });
    const response = await POST(new NextRequest("https://hivra.cloud/api/hivra/agents/agent-1/action", {
      method: "POST",
      headers: { Host: "hivra.cloud", Origin: "https://hivra.cloud", "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update_runtime" }),
    }) as never, { params: Promise.resolve({ id: "agent-1" }) });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ success: false, error: expect.stringMatching(/prepare this infrastructure target/i) });
    const [preflight, environment, options] = mockRunProxmoxHostScript.mock.calls[0];
    expect(preflight).toContain(`= '${PORTABLE_HIVRA_PROVISIONER_VERSION}'`);
    expect(preflight).toContain("sha256sum -c --status BUNDLE.sha256");
    expect(preflight).toContain("test -x \"$PROVISIONER_DIR/hivra-update-guest-runtime.sh\"");
    expect(environment).toMatchObject({ PROXMOX_NODE: "pve-home", HIVRA_USER_INFRA_CONNECTION: "true" });
    expect(options).toEqual({ timeoutMs: 20_000 });
    expect(mockSupabaseRpc).not.toHaveBeenCalledWith("claim_hivra_agent_operation", expect.anything());
  });

  it("uses the prepared self-managed target's own paths for the verified in-place update", async () => {
    mockAgent = {
      ...mockAgent,
      deployment_mode: "self-managed",
      infrastructure_binding_token_enforced: true,
      vmid: 420,
      ip: "10.251.20.70",
      infrastructure_connection_id: "11111111-1111-4111-8111-111111111111",
      deployment_target_id: "22222222-2222-4222-8222-222222222222",
      infrastructure_connection_revision: 3,
      proxmox_host: "__hivra_self_managed_no_ambient_authority__",
    };
    mockRunProxmoxHostScript
      .mockResolvedValueOnce({ ok: true, stdout: "HIVRA_RUNTIME_UPDATE_READY\n" })
      .mockResolvedValueOnce({ ok: true, stdout: "HIVRA_GUEST_RUNTIME_UPDATED vmid=420\n" });
    const response = await POST(new NextRequest("https://hivra.cloud/api/hivra/agents/agent-1/action", {
      method: "POST",
      headers: { Host: "hivra.cloud", Origin: "https://hivra.cloud", "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update_runtime" }),
    }) as never, { params: Promise.resolve({ id: "agent-1" }) });

    expect(response.status).toBe(200);
    expect(mockRunProxmoxHostScript).toHaveBeenCalledTimes(2);
    const mutation = String(mockRunProxmoxHostScript.mock.calls[1][0]);
    expect(mutation).toContain("HIVRA_VM_SSH_KEY_PATH='/etc/hivra/keys/vm-orchestrator'");
    expect(mutation).toContain("bash '/opt/hivra/provisioner/hivra-update-guest-runtime.sh' 420 '10.251.20.70'");
    expect(mutation).not.toContain("hivra-start-on-host.sh");
    expect(mutation).not.toMatch(/qm (shutdown|stop|start)\b/);
    expect(mockSupabaseRpc).toHaveBeenCalledWith("complete_hivra_agent_operation", expect.objectContaining({ p_status: "running" }));
  });

  it("serializes managed cold restore under FD8 and re-verifies the stable VM binding", async () => {
    mockAgent = {
      ...mockAgent,
      id: "00000000-0000-4000-8000-000000001028",
      status: "stopped",
      infrastructure_binding_token_enforced: true,
    };

    const response = await POST(
      makeRequest({ action: "start" }) as never,
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(response.status).toBe(200);
    const script = String(mockRunProxmoxHostScript.mock.calls[0][0]);
    const lockAt = script.indexOf("flock -w 60 8");
    const restoreAt = script.indexOf("qmrestore");
    const postRestoreBindingAt = script.lastIndexOf("grep -Fxq \"$EXPECTED_BINDING_TAG\"");
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(restoreAt).toBeGreaterThan(lockAt);
    expect(postRestoreBindingAt).toBeGreaterThan(restoreAt);
    expect(script).toContain(`hivra-bind-${"b".repeat(32)}`);
  });

  it("targets the STORED ip (not a vmid-derived octet) so a collision-relocated box restarts the right guest", async () => {
    // The allocator now skips in-use IPs, so a box's octet may not equal
    // ipLastOctetStart + (vmid - vmidStart). Lifecycle ops must read the stored IP
    // or they ssh to whatever guest the vmid-derived octet happens to land on.
    mockAgent = { ...mockAgent, vmid: 2140, ip: "10.250.20.67", proxmox_host: "fixturenode21" };
    mockResolveProxmoxTargetConfiguration.mockReturnValueOnce({
      env: {
        PROXMOX_PRIVATE_SUBNET_PREFIX: "10.250.20",
        PROXMOX_VMID_START: "2100",
        PROXMOX_IP_LAST_OCTET_START: "50",
      },
    });

    const response = await POST(
      makeRequest({ action: "start" }) as never,
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(response.status).toBe(200);
    // vmid-derived would be 50 + (2140 - 2100) = 90 (the colliding octet); the
    // stored IP wins → 67, and we must never target the colliding .90.
    expect(mockRunProxmoxHostScript).toHaveBeenCalledWith(
      expect.stringContaining("hivra-start-on-host.sh' 2140 67"),
      expect.anything(),
    );
    expect(
      mockRunProxmoxHostScript.mock.calls.some((c) => String(c[0]).includes("hivra-start-on-host.sh' 2140 90")),
    ).toBe(false);
  });

  it("starts a bound agent with its exact target, portable helper and portable logs", async () => {
    mockAgent = {
      ...mockAgent,
      vmid: 405,
      ip: "10.251.20.61",
      infrastructure_connection_id: "11111111-1111-4111-8111-111111111111",
      deployment_target_id: "22222222-2222-4222-8222-222222222222",
      infrastructure_connection_revision: 3,
      deployment_mode: "self-managed",
      proxmox_host: "__hivra_self_managed_no_ambient_authority__",
      infrastructure_binding_token_enforced: true,
    };

    const response = await POST(
      makeRequest({ action: "start" }) as never,
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mockResolveProxmoxTargetConfiguration).not.toHaveBeenCalled();
    expect(mockResolveSelfManagedProxmoxExecutionContext).toHaveBeenCalledWith(
      "user-free",
      {
        connectionId: "11111111-1111-4111-8111-111111111111",
        targetId: "22222222-2222-4222-8222-222222222222",
        expectedConnectionRevision: 3,
        purpose: "lifecycle",
      },
    );
    expect(mockRunProxmoxHostScript).toHaveBeenCalledWith(
      expect.stringContaining("bash '/opt/hivra/provisioner/hivra-start-on-host.sh' 405 61"),
      expect.objectContaining({
        PROXMOX_NODE: "pve-home",
        HIVRA_USER_INFRA_CONNECTION: "true",
      }),
    );
    const script = String(mockRunProxmoxHostScript.mock.calls[0][0]);
    expect(script).toContain("umask 077");
    expect(script).toContain("install -m 0600 /dev/null '/var/log/hivra/provision-405.log'");
    expect(script).toContain("install -m 0600 /dev/null '/var/log/hivra/start-405.log'");
    expect(script).toContain("HIVRA_LOG_DIR='/var/log/hivra'");
    expect(script).toContain("HIVRA_RESULT_LOG_PATH='/var/log/hivra/start-405.log'");
    expect(script).toContain("HIVRA_VM_SSH_KEY_PATH='/etc/hivra/keys/vm-orchestrator'");
    expect(script).toContain(">'/var/log/hivra/start-405.log'");
    expect(script).not.toContain("buildHivraRestoreIfMissingScript");
  });

  it("uses target capacity instead of the managed subscription gate for a bound resize", async () => {
    mockAgent = {
      ...mockAgent,
      vmid: 405,
      ip: "10.251.20.61",
      infrastructure_connection_id: "11111111-1111-4111-8111-111111111111",
      deployment_target_id: "22222222-2222-4222-8222-222222222222",
      infrastructure_connection_revision: 3,
      deployment_mode: "self-managed",
      proxmox_host: "__hivra_self_managed_no_ambient_authority__",
      infrastructure_binding_token_enforced: true,
    };

    const response = await POST(
      makeRequest({ action: "resize", cpu: 4, ram: 8 }) as never,
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mockValidateAgentResources).not.toHaveBeenCalled();
    expect(mockRunProxmoxHostScript).toHaveBeenCalledWith(
      expect.stringContaining("qm set 405 --cores 4 --cpulimit 4 --memory 8192"),
      expect.objectContaining({ PROXMOX_NODE: "pve-home" }),
    );
    expect(mockCheckHostWakeCapacity).not.toHaveBeenCalled();
    const resizeScript = String(mockRunProxmoxHostScript.mock.calls[0][0]);
    expect(resizeScript).toContain("hivra-host-capacity-admission");
    expect(resizeScript.indexOf("hivra-host-capacity-admission")).toBeLessThan(
      resizeScript.indexOf("qm shutdown"),
    );
  });

  it("does not report a stop when the host cannot prove the VM stopped", async () => {
    mockRunProxmoxHostScript.mockResolvedValueOnce({
      ok: false,
      error: "VMID 1090 did not stop",
      stdout: "",
      stderr: "status=running",
    });

    const response = await POST(
      makeRequest({ action: "stop" }) as never,
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(response.status).toBe(502);
    const script = String(mockRunProxmoxHostScript.mock.calls[0][0]);
    expect(script).toContain('FINAL_STATUS="$(qm status "$VMID" | awk');
    expect(script).toContain('if [ "$FINAL_STATUS" != "stopped" ]');
    expect(script).not.toContain("|| true");
  });

  it.each(["start", "stop", "restart"] as const)("invalidates the exact Ubuntu desktop before %s dispatch and blocks invalidation failure", async action => {
    const response = await POST(makeRequest({ action }) as never, { params: Promise.resolve({ id: "agent-1" }) });
    expect(response.status).toBe(200);
    expect(mockRevokeRemoteDesktopCapability).toHaveBeenCalledWith({ userId: "user-free", computerKind: "hivra-agent", computerId: "agent-1" });
    const claimCall = mockSupabaseRpc.mock.calls.findIndex(([name]) => name === "claim_hivra_agent_operation");
    expect(mockSupabaseRpc.mock.invocationCallOrder[claimCall]).toBeLessThan(mockRevokeRemoteDesktopCapability.mock.invocationCallOrder[0]);
    expect(mockRevokeRemoteDesktopCapability.mock.invocationCallOrder[0]).toBeLessThan(mockRunProxmoxHostScript.mock.invocationCallOrder[0]);

    mockRunProxmoxHostScript.mockClear();
    mockRevokeRemoteDesktopCapability.mockResolvedValueOnce({ ok: false, status: 503 });
    const failure = await POST(makeRequest({ action }) as never, { params: Promise.resolve({ id: "agent-1" }) });
    expect(failure.status).toBe(503);
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
    expect(mockSupabaseRpc).toHaveBeenCalledWith("release_hivra_agent_operation", expect.objectContaining({
      p_user_id: "user-free", p_agent_id: "agent-1", p_mark_error: false,
    }));
  });

  it.each([
    ["stop", { action: "stop" }],
    ["start", { action: "start" }],
    ["restart", { action: "restart" }],
    ["resize", { action: "resize", cpu: 2, ram: 4 }],
  ])("retains the %s lease when the provider command outcome is ambiguous", async (_name, body) => {
    mockRunProxmoxHostScript.mockResolvedValueOnce({
      ok: false,
      error: "Proxmox SSH operation timed out after 60000ms",
      stdout: "",
      stderr: "",
    });

    const response = await POST(
      makeRequest(body) as never,
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(response.status).toBe(502);
    expect(mockSupabaseRpc.mock.calls.some(([rpc]) => rpc === "record_hivra_agent_operation_failure")).toBe(true);
    expect(mockSupabaseRpc.mock.calls.some(([rpc]) => rpc === "release_hivra_agent_operation")).toBe(false);
  });

  it.each([
    ["start", { action: "start" }],
    ["restart", { action: "restart" }],
    ["resize", { action: "resize", cpu: 2, ram: 4 }],
  ])("retains the %s lease when delete supersedes async convergence", async (_name, body) => {
    mockContinueOperationResult = false;

    const response = await POST(
      makeRequest(body) as never,
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(response.status).toBe(409);
    expect(mockSupabaseRpc.mock.calls.some(([rpc]) => rpc === "record_hivra_agent_operation_failure")).toBe(true);
    expect(mockSupabaseRpc.mock.calls.some(([rpc]) => rpc === "release_hivra_agent_operation")).toBe(false);
  });

  it("does not report success when the VM stopped but the lifecycle status could not be saved", async () => {
    mockLifecycleUpdateError = { code: "database_error" };

    const response = await POST(
      makeRequest({ action: "stop" }) as never,
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(expect.objectContaining({
      error: expect.stringContaining("newer lifecycle request"),
    }));
  });

  it("fails closed before starting a bound VM when live memory cannot be measured", async () => {
    mockAgent = {
      ...mockAgent,
      vmid: 405,
      ip: "10.251.20.61",
      infrastructure_connection_id: "11111111-1111-4111-8111-111111111111",
      deployment_target_id: "22222222-2222-4222-8222-222222222222",
      infrastructure_connection_revision: 3,
      deployment_mode: "self-managed",
      proxmox_host: "__hivra_self_managed_no_ambient_authority__",
      infrastructure_binding_token_enforced: true,
    };
    mockCheckHostWakeCapacity.mockResolvedValueOnce({ ok: true, freeMb: null });

    const response = await POST(
      makeRequest({ action: "start" }) as never,
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(response.status).toBe(503);
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
  });

  it("fails closed without a host call when a bound agent's target evidence is stale", async () => {
    mockAgent = {
      ...mockAgent,
      infrastructure_connection_id: "11111111-1111-4111-8111-111111111111",
      deployment_target_id: "22222222-2222-4222-8222-222222222222",
      infrastructure_connection_revision: 3,
      deployment_mode: "self-managed",
      proxmox_host: "__hivra_self_managed_no_ambient_authority__",
      infrastructure_binding_token_enforced: true,
    };
    mockResolveSelfManagedProxmoxExecutionContext.mockRejectedValueOnce(
      new ProxmoxExecutionContextError("connection_stale"),
    );

    const response = await POST(
      makeRequest({ action: "stop" }) as never,
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(expect.objectContaining({
      error: expect.stringContaining("connection changed"),
    }));
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
  });

  it("fails closed without ambient fallback for a partial infrastructure binding", async () => {
    mockAgent = {
      ...mockAgent,
      infrastructure_connection_id: "11111111-1111-4111-8111-111111111111",
    };

    const response = await POST(
      makeRequest({ action: "restart" }) as never,
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(response.status).toBe(409);
    expect(mockResolveProxmoxTargetConfiguration).not.toHaveBeenCalled();
    expect(mockResolveSelfManagedProxmoxExecutionContext).not.toHaveBeenCalled();
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
  });

  describe("agent-run reporter credential on every start-helper run", () => {
    const AGENT_ID = "00000000-0000-4000-8000-000a00000002";
    const ORIGIN = "https://canary.hivra.cloud";
    const SIGNING_SECRET = randomBytes(32).toString("hex");
    const ACTIVITY_FILE = "/run/hivra-lifecycle/1090.activity.env";
    const START_HELPER = "/root/hivra-provisioner/hivra-start-on-host.sh";
    const HELPER_SOURCE = path.join(process.cwd(), "provisioner/hivra-start-on-host.sh");
    const mockCollectorUpsert = jest.fn();
    let priorOrigin: string | undefined;
    let priorSecret: string | undefined;

    const routeParams = () => ({ params: Promise.resolve({ id: AGENT_ID }) });
    function lifecycleRequest(body: Record<string, unknown>) {
      return new NextRequest(`https://hivra.cloud/api/hivra/agents/${AGENT_ID}/action`, {
        method: "POST",
        headers: { Host: "hivra.cloud", Origin: "https://hivra.cloud", "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }) as never;
    }
    function lastHostScript(): string {
      const calls = mockRunProxmoxHostScript.mock.calls;
      return String(calls[calls.length - 1][0]);
    }
    function stagedCredential(script: string): Record<string, string> {
      const encoded = script.match(/'HIVRA_ACTIVITY_TELEMETRY_B64=([A-Za-z0-9+/]+={0,2})'/)?.[1];
      expect(encoded).toBeDefined();
      return JSON.parse(Buffer.from(encoded as string, "base64").toString("utf8"));
    }

    beforeEach(() => {
      priorOrigin = process.env.NEXT_PUBLIC_APP_URL;
      priorSecret = process.env.ACTIVITY_COLLECTOR_SIGNING_SECRET;
      process.env.NEXT_PUBLIC_APP_URL = ORIGIN;
      process.env.ACTIVITY_COLLECTOR_SIGNING_SECRET = SIGNING_SECRET;
      mockAgent = { ...mockAgent, id: AGENT_ID, computer_substrate: "proxmox-kvm" };
      mockCollectorUpsert.mockReset().mockResolvedValue({ error: null });
      const baseFrom = mockSupabaseFrom.getMockImplementation() as (table: string) => unknown;
      mockSupabaseFrom.mockImplementation((table: string) =>
        table === "hivra_activity_collectors" ? { upsert: mockCollectorUpsert } : baseFrom(table));
      // A current helper passes the kickoff probe, so the host prints the
      // staging receipt exactly when the script carried a credential.
      mockRunProxmoxHostScript.mockImplementation(async (script: string) => ({
        ok: true,
        stdout: `${script.includes("HIVRA_ACTIVITY_TELEMETRY_B64=") ? "HIVRA_ACTIVITY_CREDENTIAL_STAGED\n" : ""}kicked\n`,
        stderr: "",
      }));
    });
    afterEach(() => {
      if (priorOrigin === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = priorOrigin;
      if (priorSecret === undefined) delete process.env.ACTIVITY_COLLECTOR_SIGNING_SECRET;
      else process.env.ACTIVITY_COLLECTOR_SIGNING_SECRET = priorSecret;
    });

    it.each([
      ["start", "claude-code", { action: "start" }],
      ["restart", "codex", { action: "restart" }],
      ["resize", "codex", { action: "resize", cpu: 2, ram: 4 }],
    ] as const)("stages a fresh credential scoped to exactly this computer on %s of a %s computer", async (_action, type, body) => {
      mockAgent = { ...mockAgent, type };
      const issuedNoEarlierThan = Math.floor(Date.now() / 1000);

      const response = await POST(lifecycleRequest(body), routeParams());

      expect(response.status).toBe(200);
      const script = lastHostScript();
      const credential = stagedCredential(script);
      expect(Object.keys(credential)).toEqual(["endpoint", "resourceId", "token", "expiresAt"]);
      expect(credential).toMatchObject({ endpoint: `${ORIGIN}/api/activity/ingest`, resourceId: AGENT_ID });
      const claims = verifyActivityCollectorToken(`Bearer ${credential.token}`);
      expect(claims).toMatchObject({ userId: "user-free", resourceIds: [AGENT_ID] });
      expect(claims!.iat).toBeGreaterThanOrEqual(issuedNoEarlierThan);
      expect(claims!.exp - claims!.iat).toBe(7 * 24 * 60 * 60);
      expect(credential.expiresAt).toBe(new Date(claims!.exp * 1000).toISOString());
      // The token exists only base64-encoded inside the root-only file write:
      // never as a command argument or environment value of the start helper.
      expect(script).not.toContain(credential.token);
      const probeAt = script.indexOf(`grep -Fq HIVRA_ACTIVITY_TELEMETRY_FILE '${START_HELPER}'`);
      const fileAt = script.indexOf(`install -m 0600 /dev/null '${ACTIVITY_FILE}'`);
      const writeAt = script.indexOf(`'HIVRA_ACTIVITY_TELEMETRY_B64=`);
      const helperAt = script.indexOf(`bash '${START_HELPER}' 1090 90`);
      expect(probeAt).toBeGreaterThan(-1);
      expect(probeAt).toBeLessThan(fileAt);
      expect(fileAt).toBeLessThan(writeAt);
      expect(writeAt).toBeLessThan(helperAt);
      expect(script).toContain(`then HIVRA_ACTIVITY_FILE='${ACTIVITY_FILE}'; echo HIVRA_ACTIVITY_CREDENTIAL_STAGED;`);
      expect(script).toContain(`HIVRA_ACTIVITY_TELEMETRY_FILE="$HIVRA_ACTIVITY_FILE" bash '${START_HELPER}' 1090 90`);
      expect(mockCollectorUpsert).toHaveBeenCalledTimes(1);
      expect(mockCollectorUpsert).toHaveBeenCalledWith(expect.objectContaining({
        agent_id: AGENT_ID,
        user_id: "user-free",
        credential_expires_at: credential.expiresAt,
        issue_reason: "start",
      }), { onConflict: "agent_id" });
    });

    describe("on an in-place runtime update", () => {
      const UPDATE_HELPER = "/root/hivra-provisioner/hivra-update-guest-runtime.sh";
      function hostResult(stdout: string) {
        mockRunProxmoxHostScript.mockImplementation(async (script: string) => ({
          ok: true,
          stdout: `${script.includes("HIVRA_ACTIVITY_TELEMETRY_B64=") ? "HIVRA_ACTIVITY_CREDENTIAL_STAGED\n" : ""}${stdout}`,
          stderr: "",
        }));
      }

      it.each(["claude-code", "codex"])("re-issues a %s credential to the update helper and records its install outcome", async (type) => {
        mockAgent = { ...mockAgent, type };
        hostResult("HIVRA_ACTIVITY_COLLECTOR status=installed\nHIVRA_GUEST_RUNTIME_UPDATED vmid=1090\n");
        const issuedNoEarlierThan = Math.floor(Date.now() / 1000);

        const response = await POST(lifecycleRequest({ action: "update_runtime" }), routeParams());

        expect(response.status).toBe(200);
        const script = lastHostScript();
        const credential = stagedCredential(script);
        expect(credential).toMatchObject({ endpoint: `${ORIGIN}/api/activity/ingest`, resourceId: AGENT_ID });
        const claims = verifyActivityCollectorToken(`Bearer ${credential.token}`);
        expect(claims).toMatchObject({ userId: "user-free", resourceIds: [AGENT_ID] });
        expect(claims!.iat).toBeGreaterThanOrEqual(issuedNoEarlierThan);
        expect(script).not.toContain(credential.token);
        // The probe and the consumer are the update helper that actually runs.
        const probeAt = script.indexOf(`grep -Fq HIVRA_ACTIVITY_TELEMETRY_FILE '${UPDATE_HELPER}'`);
        const writeAt = script.indexOf(`'HIVRA_ACTIVITY_TELEMETRY_B64=`);
        const helperAt = script.indexOf(`bash '${UPDATE_HELPER}' 1090 '10.250.21.90'`);
        expect(probeAt).toBeGreaterThan(-1);
        expect(probeAt).toBeLessThan(writeAt);
        expect(writeAt).toBeLessThan(helperAt);
        expect(script).toContain(`HIVRA_ACTIVITY_TELEMETRY_FILE="$HIVRA_ACTIVITY_FILE" bash '${UPDATE_HELPER}' 1090 '10.250.21.90'`);
        expect(script).not.toContain(START_HELPER);
        // A file staged for a helper that never ran is removed on exit.
        const trapAt = script.search(/^trap '.*\/run\/hivra-lifecycle\/1090\.activity\.env.*' EXIT$/m);
        expect(trapAt).toBeGreaterThan(-1);
        expect(trapAt).toBeLessThan(writeAt);
        const upserts = mockCollectorUpsert.mock.calls.map((call) => call[0]);
        expect(upserts).toEqual([
          expect.objectContaining({ agent_id: AGENT_ID, user_id: "user-free", credential_expires_at: credential.expiresAt, issue_reason: "start" }),
          expect.objectContaining({ agent_id: AGENT_ID, user_id: "user-free", last_install_status: "installed", last_install_reason: null }),
        ]);
      });

      it("records a failed reporter install without failing the update", async () => {
        hostResult("HIVRA_ACTIVITY_COLLECTOR status=failed reason=timeout\nHIVRA_GUEST_RUNTIME_UPDATED vmid=1090\n");
        const response = await POST(lifecycleRequest({ action: "update_runtime" }), routeParams());

        expect(response.status).toBe(200);
        expect(mockCollectorUpsert).toHaveBeenCalledWith(
          expect.objectContaining({ last_install_status: "failed", last_install_reason: "timeout" }),
          { onConflict: "agent_id" },
        );
        expect(mockSupabaseRpc).toHaveBeenCalledWith("complete_hivra_agent_operation", expect.objectContaining({ p_status: "running" }));
      });

      it("records neither issuance nor an install result when the update is not verified", async () => {
        mockRunProxmoxHostScript.mockImplementation(async () => ({
          ok: false,
          stdout: "HIVRA_ACTIVITY_CREDENTIAL_STAGED\nHIVRA_ACTIVITY_COLLECTOR status=installed\n",
          stderr: "",
          error: "Remote bash exited with code 1",
        }));
        const response = await POST(lifecycleRequest({ action: "update_runtime" }), routeParams());

        expect(response.status).toBe(502);
        expect(mockCollectorUpsert).not.toHaveBeenCalled();
      });

      it.each(["openclaw", "agent-zero", "linux-desktop"])("updates a %s computer without staging any credential", async (type) => {
        mockAgent = { ...mockAgent, type };
        hostResult("HIVRA_GUEST_RUNTIME_UPDATED vmid=1090\n");
        const response = await POST(lifecycleRequest({ action: "update_runtime" }), routeParams());

        expect(response.status).toBe(200);
        const script = lastHostScript();
        expect(script).toContain(`bash '${UPDATE_HELPER}' 1090 '10.250.21.90'`);
        expect(script).not.toContain("HIVRA_ACTIVITY");
        expect(script).not.toContain("/run/hivra-lifecycle");
        expect(script).not.toContain("trap ");
        expect(mockCollectorUpsert).not.toHaveBeenCalled();
      });

      it("writes the file only for an update helper that consumes it", async () => {
        hostResult("HIVRA_GUEST_RUNTIME_UPDATED vmid=1090\n");
        expect((await POST(lifecycleRequest({ action: "update_runtime" }), routeParams())).status).toBe(200);
        const script = lastHostScript();
        const stage = script.slice(script.indexOf("HIVRA_ACTIVITY_FILE='';"), script.indexOf("HIVRA_VM_SSH_KEY_PATH="));
        expect(stage.length).toBeGreaterThan(0);
        const work = mkdtempSync(path.join(tmpdir(), "hivra-activity-update-stage-"));
        try {
          const runtimeDirectory = path.join(work, "run", "hivra-lifecycle");
          const helper = path.join(work, "hivra-update-guest-runtime.sh");
          const stagedFile = path.join(runtimeDirectory, "1090.activity.env");
          const localStage = stage
            .replaceAll("/run/hivra-lifecycle", runtimeDirectory)
            .replaceAll(UPDATE_HELPER, helper);
          const kickoff = () => spawnSync("bash", [
            "-c",
            `set -euo pipefail; umask 077; ${localStage}printf 'FILE=%s\\n' "$HIVRA_ACTIVITY_FILE"`,
          ], { encoding: "utf8" });

          // An update helper from an older bundle never receives a file.
          writeFileSync(helper, "#!/usr/bin/env bash\necho legacy update helper\n");
          const legacy = kickoff();
          expect({ status: legacy.status, stdout: legacy.stdout }).toEqual({ status: 0, stdout: "FILE=\n" });
          expect(() => statSync(stagedFile)).toThrow();

          writeFileSync(helper, readFileSync(path.join(process.cwd(), "provisioner/hivra-update-guest-runtime.sh"), "utf8"));
          const current = kickoff();
          expect({ status: current.status, stdout: current.stdout }).toEqual({
            status: 0,
            stdout: `HIVRA_ACTIVITY_CREDENTIAL_STAGED\nFILE=${stagedFile}\n`,
          });
          expect(statSync(stagedFile).mode & 0o777).toBe(0o600);
        } finally {
          rmSync(work, { recursive: true, force: true });
        }
      });
    });

    it("writes the file only for a helper that consumes it, in exactly the format that helper reads", async () => {
      const response = await POST(lifecycleRequest({ action: "start" }), routeParams());
      expect(response.status).toBe(200);
      const script = lastHostScript();
      const stage = script.slice(script.indexOf("HIVRA_ACTIVITY_FILE='';"), script.indexOf("nohup env"));
      expect(stage.length).toBeGreaterThan(0);
      const work = mkdtempSync(path.join(tmpdir(), "hivra-activity-stage-"));
      try {
        const runtimeDirectory = path.join(work, "run", "hivra-lifecycle");
        const helper = path.join(work, "hivra-start-on-host.sh");
        const stagedFile = path.join(runtimeDirectory, "1090.activity.env");
        const localStage = stage
          .replaceAll("/run/hivra-lifecycle", runtimeDirectory)
          .replaceAll(START_HELPER, helper);
        const kickoff = () => spawnSync("bash", [
          "-c",
          `set -euo pipefail; umask 077; ${localStage}printf 'FILE=%s\\n' "$HIVRA_ACTIVITY_FILE"`,
        ], { encoding: "utf8" });

        // A host still on an older bundle: nothing is written and the helper
        // receives an empty path, so the start proceeds exactly as before.
        writeFileSync(helper, "#!/usr/bin/env bash\necho legacy start helper\n");
        const legacy = kickoff();
        expect({ status: legacy.status, stdout: legacy.stdout }).toEqual({ status: 0, stdout: "FILE=\n" });
        expect(() => statSync(stagedFile)).toThrow();

        writeFileSync(helper, readFileSync(HELPER_SOURCE, "utf8"));
        const current = kickoff();
        expect({ status: current.status, stdout: current.stdout }).toEqual({
          status: 0,
          stdout: `HIVRA_ACTIVITY_CREDENTIAL_STAGED\nFILE=${stagedFile}\n`,
        });
        expect(statSync(stagedFile).mode & 0o777).toBe(0o600);

        // The start helper's own reader (GNU stat stubbed for portability)
        // decodes and accepts exactly the credential the control plane minted.
        const reader = readFileSync(HELPER_SOURCE, "utf8").match(/^read_activity_credential\(\) \{[\s\S]*?\n\}\n/m)?.[0];
        expect(reader).toBeDefined();
        const read = spawnSync("bash", [
          "-c",
          `set -euo pipefail
stat() { if [ "$2" = "%s" ]; then wc -c < "$3" | tr -d " "; else echo 600:root:root; fi; }
${reader}
read_activity_credential "$1"`,
          "reader",
          stagedFile,
        ], { encoding: "utf8" });
        expect(read.status).toBe(0);
        expect(JSON.parse(read.stdout)).toEqual(stagedCredential(script));
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    });

    it.each(["openclaw", "aeon", "agent-zero", "deepseek-harness", "linux-desktop"])(
      "neither issues nor stages a credential for unsupported type %s",
      async (type) => {
        mockAgent = { ...mockAgent, type };
        const response = await POST(lifecycleRequest({ action: "start" }), routeParams());
        expect(response.status).toBe(200);
        const script = lastHostScript();
        expect(script).toContain(`bash '${START_HELPER}' 1090 90`);
        expect(script).not.toContain("HIVRA_ACTIVITY");
        expect(script).not.toContain("/run/hivra-lifecycle");
        expect(mockCollectorUpsert).not.toHaveBeenCalled();
      },
    );

    it("does not issue a credential for a Claude Code computer outside Proxmox", async () => {
      mockAgent = { ...mockAgent, computer_substrate: "provider-vm", deployment_mode: "self-managed", vmid: null };
      const response = await POST(lifecycleRequest({ action: "start" }), routeParams());
      expect(response.status).toBe(202);
      expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
      expect(mockCollectorUpsert).not.toHaveBeenCalled();
    });

    it.each([
      ["signing secret", () => { delete process.env.ACTIVITY_COLLECTOR_SIGNING_SECRET; }],
      ["public https origin", () => { process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000"; }],
    ])("still starts without a %s and leaves coverage to show missing", async (_missing, unset) => {
      unset();
      const response = await POST(lifecycleRequest({ action: "start" }), routeParams());
      expect(response.status).toBe(200);
      const script = lastHostScript();
      expect(script).toContain(`bash '${START_HELPER}' 1090 90`);
      expect(script).not.toContain("HIVRA_ACTIVITY");
      expect(mockCollectorUpsert).not.toHaveBeenCalled();
      expect(mockSupabaseRpc).toHaveBeenCalledWith("continue_hivra_agent_operation", expect.anything());
    });

    it("records issuance only after the host confirms the credential file was staged", async () => {
      mockRunProxmoxHostScript.mockImplementation(async () => ({ ok: true, stdout: "kicked\n", stderr: "" }));
      expect((await POST(lifecycleRequest({ action: "start" }), routeParams())).status).toBe(200);
      expect(mockCollectorUpsert).not.toHaveBeenCalled();

      mockRunProxmoxHostScript.mockImplementation(async () => ({
        ok: false, stdout: "HIVRA_ACTIVITY_CREDENTIAL_STAGED\n", stderr: "", error: "Proxmox SSH operation timed out",
      }));
      expect((await POST(lifecycleRequest({ action: "start" }), routeParams())).status).toBe(502);
      expect(mockCollectorUpsert).not.toHaveBeenCalled();
    });

    it("keeps the start successful when the issuance record cannot be written", async () => {
      mockCollectorUpsert.mockResolvedValue({ error: { message: "collector table unavailable" } });
      const response = await POST(lifecycleRequest({ action: "start" }), routeParams());
      expect(response.status).toBe(200);
      expect(mockCollectorUpsert).toHaveBeenCalledTimes(1);
      expect(mockSupabaseRpc).toHaveBeenCalledWith("continue_hivra_agent_operation", expect.anything());
    });
  });
});
