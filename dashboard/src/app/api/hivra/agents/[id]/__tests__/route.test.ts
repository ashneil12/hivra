import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

import { DELETE, GET } from "../route";
import { REMOTE_DESKTOP_BUNDLE_REVISION } from "@/lib/remote-computers/capability-inspection";

const mockAuth = jest.fn();
const mockSupabaseFrom = jest.fn();
const mockSupabaseRpc = jest.fn();
const mockRunProxmoxHostScript = jest.fn();
const mockResolveProxmoxTargetConfiguration = jest.fn();
const mockResolveSelfManagedProxmoxExecutionContext = jest.fn();
const mockDeleteBoxTunnel = jest.fn();
const mockVerifiedTunnelCleanup = jest.fn();
const mockLogHivraAgentEvent = jest.fn();
const mockSeedAgentBox = jest.fn();
const mockLogWarn = jest.fn();
const mockCaptureHivraAgentComputerReady = jest.fn();
const mockProviderDelete = jest.fn();
const mockDeleteRateLimit = jest.fn();
const mockProviderReadiness = jest.fn();
const mockProviderNativeReadiness = jest.fn();
const mockProviderDesktopReadiness = jest.fn();
const mockProviderPower = jest.fn();
const mockProviderResize = jest.fn();
const mockRevokeRemoteDesktopCapability = jest.fn();
const mockPrepareHivraTailscaleForDelete = jest.fn();
const mockMutateGvisorComputer = jest.fn();
let mockPrivateAccessRow: Record<string, unknown> | null;
jest.mock("@/lib/hivra/provider-agent-power", () => ({ advanceProviderAgentPower: (...args: unknown[]) => mockProviderPower(...args) }));
jest.mock("@/lib/hivra/provider-agent-resize", () => ({ advanceProviderResize: (...args: unknown[]) => mockProviderResize(...args) }));
jest.mock("@/lib/hivra/tailscale-private-access", () => ({
  ...jest.requireActual("@/lib/hivra/tailscale-private-access"),
  prepareHivraTailscaleForDelete: (...args: unknown[]) => mockPrepareHivraTailscaleForDelete(...args),
}));
jest.mock("@/lib/hivra/gvisor-computer-service", () => ({
  ...jest.requireActual("@/lib/hivra/gvisor-computer-service"),
  mutateGvisorComputer: (...args: unknown[]) => mockMutateGvisorComputer(...args),
}));

jest.mock("@/lib/remote-computers/session-broker", () => ({
  revokeRemoteDesktopCapability: (...args: unknown[]) => mockRevokeRemoteDesktopCapability(...args),
}));

jest.mock("@/lib/hivra/provider-agent-readiness", () => ({
  advanceProviderAgentReadiness: (...args: unknown[]) => mockProviderReadiness(...args),
}));
jest.mock("@/lib/hivra/provider-native-readiness", () => ({
  advanceProviderNativeReadiness: (...args: unknown[]) => mockProviderNativeReadiness(...args),
}));
jest.mock("@/lib/hivra/provider-desktop-readiness", () => ({
  advanceProviderDesktopReadiness: (...args: unknown[]) => mockProviderDesktopReadiness(...args),
}));

jest.mock("@/lib/hivra/provider-agent-delete", () => ({
  ...jest.requireActual("@/lib/hivra/provider-agent-delete"),
  advanceProviderAgentDelete: (...args: unknown[]) => mockProviderDelete(...args),
}));
jest.mock("@/lib/authenticated-rate-limit", () => ({
  enforceAuthenticatedRouteRateLimit: (...args: unknown[]) => mockDeleteRateLimit(...args),
}));

const updates: Array<Record<string, unknown>> = [];
let mockAgentRow: Record<string, unknown>;
let mockCompleteRunningResult = true;

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

jest.mock("@/lib/services/cloudflare-tunnel", () => ({
  deleteBoxTunnel: (...args: unknown[]) => mockDeleteBoxTunnel(...args),
}));
jest.mock("@/lib/services/cloudflare-tunnel-cleanup", () => ({
  deleteBoxTunnelVerified: (...args: unknown[]) => mockVerifiedTunnelCleanup(...args),
}));

jest.mock("@/lib/hivra/agent-events", () => ({
  logHivraAgentEvent: (...args: unknown[]) => mockLogHivraAgentEvent(...args),
}));

jest.mock("@/lib/hivra/agent-ready-telemetry", () => ({
  captureHivraAgentComputerReady: (...args: unknown[]) =>
    mockCaptureHivraAgentComputerReady(...args),
}));

jest.mock("@/lib/hivra/agent-bootstrap", () => ({
  seedAgentBox: (...args: unknown[]) => mockSeedAgentBox(...args),
}));

jest.mock("@/lib/hivra/proxmox-target", () => ({
  resolveHivraProxmoxHost: (host?: string | null) => host || "fixturenode10",
  shellQuote: (value: string) => `'${String(value).replace(/'/g, `'\\''`)}'`,
}));

function selfManagedContext() {
  return {
    kind: "self-managed" as const,
    connectionId: "11111111-1111-4111-8111-111111111111",
    targetId: "22222222-2222-4222-8222-222222222222",
    connectionRevision: 3,
    target: {
      capacity: {
        cpu: { totalCores: 16 },
        memoryBytes: { total: 64 * 1024 ** 3 },
      },
    },
    env: { PROXMOX_NODE: "pve-home", HIVRA_USER_INFRA_CONNECTION: "true" },
    runtime: {
      node: "pve-home",
      storage: "fast-zfs",
      provisionerDirectory: "/opt/hivra/provisioner",
      vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
      logDirectory: "/var/log/hivra",
    },
  };
}

jest.mock("@/lib/logger", () => ({
  log: {
    warn: (...args: unknown[]) => mockLogWarn(...args),
    error: jest.fn(),
  },
}));

function makeRequest() {
  return new Request("https://hivra.cloud/api/hivra/agents/agent-1", {
    method: "DELETE",
    headers: { Host: "hivra.cloud" },
  });
}

function makeGetRequest() {
  return new Request("https://hivra.cloud/api/hivra/agents/agent-1", {
    method: "GET",
    headers: { Host: "hivra.cloud" },
  });
}

describe("DELETE /api/hivra/agents/[id]", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockProviderDelete.mockReset().mockResolvedValue({ ok: false, pending: true, stage: "provider_cleanup" });
    mockDeleteRateLimit.mockReset().mockReturnValue(null);
    mockProviderReadiness.mockReset().mockResolvedValue("runtime_pending");
    mockProviderNativeReadiness.mockReset().mockResolvedValue("public_access_pending");
    mockProviderDesktopReadiness.mockReset().mockResolvedValue("public_access_pending");
    mockProviderPower.mockReset().mockResolvedValue("reboot_pending");
    mockProviderResize.mockReset().mockResolvedValue({ stage: "provider_pending" });
    mockRevokeRemoteDesktopCapability.mockReset().mockResolvedValue({ ok: true, revoked: false });
    mockPrepareHivraTailscaleForDelete.mockReset().mockResolvedValue({ ok: true, disposition: "guest_logged_out" });
    mockMutateGvisorComputer.mockReset();
    mockPrivateAccessRow = null;
    updates.length = 0;
    mockCompleteRunningResult = true;
    mockAuth.mockResolvedValue({ userId: "user-free" });
    mockResolveProxmoxTargetConfiguration.mockReturnValue({ env: { PROXMOX_NODE: "fixturenode10" } });
    mockResolveSelfManagedProxmoxExecutionContext.mockResolvedValue(selfManagedContext());
    mockRunProxmoxHostScript.mockResolvedValue({ ok: true, stdout: "destroyed 1090\n", stderr: "" });
    mockDeleteBoxTunnel.mockResolvedValue(undefined);
    mockVerifiedTunnelCleanup.mockReset().mockResolvedValue(undefined);
    mockLogHivraAgentEvent.mockResolvedValue(undefined);
    mockSeedAgentBox.mockResolvedValue({ ok: true });
    mockSupabaseRpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === "request_hivra_agent_delete") {
        mockAgentRow = {
          ...mockAgentRow,
          desired_state: "deleted",
          operation_id: args.p_operation_id,
          operation_kind: "delete",
        };
        return { data: "claimed", error: null };
      }
      if (name === "complete_hivra_agent_delete") {
        mockAgentRow = { ...mockAgentRow, status: "deleted", desired_state: "deleted" };
        updates.push({ status: "deleted" });
        return { data: true, error: null };
      }
      if (name === "release_hivra_agent_operation") {
        if (args.p_mark_error) {
          const update = { status: "error", error: args.p_error };
          updates.push(update);
          mockAgentRow = { ...mockAgentRow, ...update };
        }
        return { data: true, error: null };
      }
      return { data: true, error: null };
    });
    mockAgentRow = {
      id: "agent-1",
      user_id: "user-free",
      type: "claude-code",
      status: "running",
      vmid: 1090,
      proxmox_host: "fixturenode10",
      deployment_mode: "hivra-managed",
      desired_state: "running",
      operation_id: null,
      operation_kind: null,
      operation_started_at: null,
      infrastructure_binding_token_hash: "b".repeat(64),
      infrastructure_binding_token_enforced: false,
      cf_tunnel_id: "tun_123",
      cf_hostname: "box.example.com",
    };

    mockSupabaseFrom.mockImplementation((table: string) => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      in: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn(async () => ({ data: table === "hivra_private_access_connections" ? mockPrivateAccessRow : mockAgentRow, error: null })),
      single: jest.fn(async () => ({
        data: mockAgentRow,
        error: null,
      })),
      update: jest.fn((payload: Record<string, unknown>) => {
        updates.push(payload);
        const updated = { ...mockAgentRow, ...payload };
        return {
          eq: jest.fn(() => ({
            select: jest.fn(() => ({
              single: jest.fn(async () => ({ data: updated, error: null })),
            })),
            then: (resolve: (value: { data: Record<string, unknown>; error: null }) => void) =>
              resolve({ data: updated, error: null }),
          })),
        };
      }),
    }));
  });

  it("deletes a gVisor computer through its exact lifecycle service", async () => {
    mockAgentRow = { ...mockAgentRow, computer_substrate: "gvisor", type: "linux-terminal", computer_profile: "linux-terminal", vmid: null };
    mockMutateGvisorComputer.mockResolvedValue({ ...mockAgentRow, status: "deleted", desired_state: "deleted" });
    const request = new NextRequest("https://hivra.cloud/api/hivra/agents/agent-1", {
      method: "DELETE",
      headers: { host: "hivra.cloud", origin: "https://hivra.cloud", "sec-fetch-site": "same-origin" },
    });

    const response = await DELETE(request, { params: Promise.resolve({ id: "agent-1" }) });

    expect(response.status).toBe(200);
    expect(mockMutateGvisorComputer).toHaveBeenCalledWith("user-free", "agent-1", { action: "delete" });
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
    expect(mockSupabaseRpc).not.toHaveBeenCalled();
  });

  describe("dedicated provider computers", () => {
    const request = (headers: Record<string, string> = {}) => new NextRequest("https://hivra.cloud/api/hivra/agents/agent-1", {
      method: "DELETE", headers: { host: "hivra.cloud", origin: "https://hivra.cloud", "sec-fetch-site": "same-origin", ...headers },
    });
    const params = { params: Promise.resolve({ id: "agent-1" }) };
    beforeEach(() => {
      mockAgentRow = { ...mockAgentRow, computer_substrate: "provider-vm", deployment_mode: "self-managed", vmid: null };
    });
    afterEach(() => {
      expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
      expect(mockResolveProxmoxTargetConfiguration).not.toHaveBeenCalled();
      expect(mockResolveSelfManagedProxmoxExecutionContext).not.toHaveBeenCalled();
      expect(mockVerifiedTunnelCleanup).not.toHaveBeenCalled();
      expect(mockSupabaseRpc).not.toHaveBeenCalled();
      expect(updates).toEqual([]);
    });
    it("returns acknowledged progress without invoking the null-VMID legacy deletion path", async () => {
      const response = await DELETE(request(), params);
      expect(response.status).toBe(202);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ success: true, data: {
        ok: false, pending: true, stage: "provider_cleanup", agentId: "agent-1",
      } });
      expect(mockProviderDelete).toHaveBeenCalledWith({ userId: "user-free", agentId: "agent-1" });
      expect(mockDeleteRateLimit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: "user-free", limit: 120 }));
    });
    it("checks provider readiness without using the Proxmox poll or seed lanes", async () => {
      mockAgentRow = { ...mockAgentRow, status: "provisioning", operation_kind: "provision", operation_id: "provider-operation" };
      const response = await GET(makeGetRequest() as never, params);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ data: { agent: { status: "provisioning", readiness_stage: "runtime_pending" } } });
      expect(mockProviderReadiness).toHaveBeenCalledWith({ userId: "user-free", agentId: "agent-1", operationId: "provider-operation" });
      expect(mockSeedAgentBox).not.toHaveBeenCalled();
    });
    it("routes a privately staged DeepSeek operation through native readiness only", async () => {
      mockAgentRow = { ...mockAgentRow, type: "deepseek-harness", status: "provisioning", operation_kind: "provision", operation_id: "native-operation" };
      const response = await GET(makeGetRequest() as never, params);
      expect(await response.json()).toMatchObject({ data: { agent: { status: "provisioning", readiness_stage: "public_access_pending" } } });
      expect(mockProviderNativeReadiness).toHaveBeenCalledWith({ userId: "user-free", agentId: "agent-1", operationId: "native-operation" });
      expect(mockProviderReadiness).not.toHaveBeenCalled(); expect(mockSeedAgentBox).not.toHaveBeenCalled();
    });
    it("observes a reserved Ubuntu provider desktop with its own readiness contract", async () => {
      mockAgentRow = { ...mockAgentRow, type: "linux-desktop", computer_profile: "ubuntu-desktop", status: "provisioning",
        operation_kind: "provision", operation_id: "desktop-operation" };
      const response = await GET(makeGetRequest() as never, params);
      expect(await response.json()).toMatchObject({ data: { agent: { status: "provisioning", readiness_stage: "public_access_pending" } } });
      expect(mockProviderDesktopReadiness).toHaveBeenCalledWith({ userId: "user-free", agentId: "agent-1", operationId: "desktop-operation" });
      expect(mockProviderNativeReadiness).not.toHaveBeenCalled(); expect(mockProviderReadiness).not.toHaveBeenCalled();
      expect(mockRunProxmoxHostScript).not.toHaveBeenCalled(); expect(mockSeedAgentBox).not.toHaveBeenCalled();
    });
    it.each(["omarchy", "windows", null])("does not reinterpret %s as Ubuntu readiness", async profile => {
      mockAgentRow = { ...mockAgentRow, type: "linux-desktop", computer_profile: profile, status: "provisioning",
        operation_kind: "provision", operation_id: "desktop-operation" };
      const response = await GET(makeGetRequest() as never, params);
      expect(await response.json()).toMatchObject({ data: { agent: { status: "provisioning", readiness_stage: "verification_unavailable" } } });
      expect(mockProviderDesktopReadiness).not.toHaveBeenCalled(); expect(mockProviderReadiness).not.toHaveBeenCalled();
    });
    it.each(["start", "stop", "restart"])("observes %s without ever dispatching from GET", async kind => {
      mockAgentRow = { ...mockAgentRow, status: "provisioning", operation_kind: kind, operation_id: "provider-power-operation" };
      const response = await GET(makeGetRequest() as never, params);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ data: { agent: { status: "provisioning", power_stage: "reboot_pending" } } });
      expect(mockProviderPower).toHaveBeenCalledWith({ userId: "user-free", agentId: "agent-1", operationId: "provider-power-operation" }, "observe");
      expect(mockProviderReadiness).not.toHaveBeenCalled(); expect(mockSeedAgentBox).not.toHaveBeenCalled();
    });
    it("observes an allocated-provider resize without using managed-host routing or redispatching", async () => {
      mockAgentRow = { ...mockAgentRow, status: "provisioning", operation_kind: "resize", operation_id: "provider-resize-operation" };
      const response = await GET(makeGetRequest() as never, params);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ data: { agent: {
        status: "provisioning", resize_stage: "provider_pending",
      } } });
      expect(mockProviderResize).toHaveBeenCalledWith({
        userId: "user-free", agentId: "agent-1", operationId: "provider-resize-operation",
      }, "observe");
      expect(mockProviderPower).not.toHaveBeenCalled();
      expect(mockProviderReadiness).not.toHaveBeenCalled();
      expect(mockProviderNativeReadiness).not.toHaveBeenCalled();
      expect(mockSeedAgentBox).not.toHaveBeenCalled();
    });
    it("returns failed power observation as unverified without discarding the operation", async () => {
      mockAgentRow = { ...mockAgentRow, status: "provisioning", operation_kind: "stop", operation_id: "provider-power-operation" };
      mockProviderPower.mockRejectedValue(new Error("PRIVATE_PROVIDER_KEY"));
      const body = await (await GET(makeGetRequest() as never, params)).json();
      expect(body.data.agent.power_stage).toBe("verification_unavailable");
      expect(JSON.stringify(body)).not.toContain("PRIVATE_PROVIDER_KEY"); expect(mockSupabaseRpc).not.toHaveBeenCalled();
    });
    it("reloads the authoritative completed record rather than synthesizing running from a helper return", async () => {
      mockAgentRow = { ...mockAgentRow, status: "provisioning", operation_kind: "provision", operation_id: "provider-operation" };
      mockProviderReadiness.mockImplementation(async () => { mockAgentRow.status = "running"; return "running"; });
      const response = await GET(makeGetRequest() as never, params);
      const body = await response.json();
      expect(body.data.agent.status).toBe("running");
      expect(body.data.agent).not.toHaveProperty("readiness_stage");
      expect(mockSeedAgentBox).not.toHaveBeenCalled();
    });
    it("shows a failed readiness observation without releasing, relaunching or exposing private errors", async () => {
      mockAgentRow = { ...mockAgentRow, status: "provisioning", operation_kind: "provision", operation_id: "provider-operation" };
      mockProviderReadiness.mockRejectedValue(new Error("PRIVATE_SSH_TOKEN"));
      const body = await (await GET(makeGetRequest() as never, params)).json();
      expect(body.data.agent).toMatchObject({ status: "provisioning", readiness_stage: "verification_unavailable" });
      expect(JSON.stringify(body)).not.toContain("PRIVATE_SSH_TOKEN");
      expect(JSON.stringify(mockLogWarn.mock.calls)).not.toContain("PRIVATE_SSH_TOKEN");
    });
    it.each(["running", "stopped", "error", "deleted"])("does not run provision recovery or ambient seeds for a %s provider agent", async status => {
      mockAgentRow.status = status;
      const response = await GET(makeGetRequest() as never, params);
      expect(response.status).toBe(200);
      expect(mockProviderReadiness).not.toHaveBeenCalled(); expect(mockSeedAgentBox).not.toHaveBeenCalled();
    });
    it("returns success only after the provider adapter confirms terminal deletion", async () => {
      mockProviderDelete.mockResolvedValue({ ok: true });
      const response = await DELETE(request(), params);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true, data: { ok: true, agentId: "agent-1" } });
    });
    it.each<Record<string, string>>([{ origin: "https://other.example" }, { origin: "" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "" }])(
      "rejects a missing or cross-origin mutation boundary %j", async headers => {
        expect((await DELETE(request(headers), params)).status).toBe(403);
        expect(mockProviderDelete).not.toHaveBeenCalled();
      },
    );
    it("requires a signed-in owner and an existing owner-scoped agent", async () => {
      mockAuth.mockResolvedValueOnce({ userId: null });
      expect((await DELETE(request(), params)).status).toBe(401);
      expect(mockSupabaseFrom).not.toHaveBeenCalled();
      mockSupabaseFrom.mockReturnValueOnce({ select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), single: async () => ({ data: null }) });
      expect((await DELETE(request(), params)).status).toBe(404);
      expect(mockProviderDelete).not.toHaveBeenCalled();
    });
    it("stops before provider work when rate limited", async () => {
      mockDeleteRateLimit.mockReturnValue(new Response("Rate limited", { status: 429 }));
      expect((await DELETE(request(), params)).status).toBe(429);
      expect(mockProviderDelete).not.toHaveBeenCalled();
    });
    it("keeps an incomplete operation visible without leaking private provider errors", async () => {
      mockProviderDelete.mockRejectedValue(new Error("PRIVATE_PROVIDER_TOKEN"));
      const response = await DELETE(request(), params);
      expect(response.status).toBe(409);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const text = JSON.stringify(await response.json());
      expect(text).toContain("Provider billing may continue");
      expect(text).not.toContain("PRIVATE_PROVIDER_TOKEN");
      expect(JSON.stringify(mockLogWarn.mock.calls)).not.toContain("PRIVATE_PROVIDER_TOKEN");
    });
  });

  it("does not dispatch deletion when the database returns a coerced claim", async () => {
    mockSupabaseRpc.mockResolvedValueOnce({ data: ["claimed"], error: null });
    const response = await DELETE(makeRequest() as never, { params: Promise.resolve({ id: "agent-1" }) });
    expect(response.status).toBe(500);
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
    expect(mockVerifiedTunnelCleanup).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it("destroys the stored-host VM before marking the agent deleted", async () => {
    const response = await DELETE(makeRequest() as never, {
      params: Promise.resolve({ id: "agent-1" }),
    });

    expect(response.status).toBe(200);
    expect(mockResolveProxmoxTargetConfiguration).toHaveBeenCalledWith(
      expect.anything(),
      "fixturenode10",
    );
    expect(mockRunProxmoxHostScript).toHaveBeenCalledWith(
      expect.stringContaining("qm destroy \"$VMID\" --purge 1 --destroy-unreferenced-disks 1"),
      expect.objectContaining({ PROXMOX_NODE: "fixturenode10" }),
    );
    expect(mockRunProxmoxHostScript.mock.calls[0][0]).toContain('if qm status "$VMID" >/dev/null 2>&1; then');
    expect(mockRunProxmoxHostScript.mock.calls[0][0]).toContain("VMID $VMID still exists after destroy");
    expect(mockRunProxmoxHostScript.mock.calls[0][0]).toContain("still has volumes on $STORAGE after destroy");
    expect(mockVerifiedTunnelCleanup).toHaveBeenCalledWith({
      tunnelId: "tun_123",
      hostname: "box.example.com",
    });
    expect(updates).toContainEqual({ status: "deleted" });
    expect(mockLogHivraAgentEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "deleted",
      agentId: "agent-1",
    }));
  });

  it("retains the computer and offers a delete retry when access cleanup is unverified", async () => {
    mockVerifiedTunnelCleanup.mockRejectedValue(new Error("private provider failure"));
    const response = await DELETE(makeRequest() as never, { params: Promise.resolve({ id: "agent-1" }) });
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(JSON.stringify(body)).toContain("retry Delete");
    expect(JSON.stringify(body)).not.toContain("private provider failure");
    expect(mockRunProxmoxHostScript).toHaveBeenCalledTimes(1);
    expect(updates).not.toContainEqual({ status: "deleted" });
    expect(mockAgentRow.cf_tunnel_id).toBe("tun_123");
    expect(mockAgentRow.cf_hostname).toBe("box.example.com");
    expect(mockSupabaseRpc).toHaveBeenCalledWith("record_hivra_agent_operation_failure", expect.anything());
    expect(mockSupabaseRpc).toHaveBeenCalledWith("release_hivra_agent_operation", expect.objectContaining({ p_mark_error: true }));
    expect(mockLogHivraAgentEvent).not.toHaveBeenCalledWith(expect.objectContaining({ event: "deleted" }));
  });

  it("does not mark deleted when Proxmox destroy fails", async () => {
    mockRunProxmoxHostScript.mockResolvedValueOnce({
      ok: false,
      stdout: "",
      stderr: "VMID 1090 still exists after destroy",
      error: "destroy failed",
    });

    const response = await DELETE(makeRequest() as never, {
      params: Promise.resolve({ id: "agent-1" }),
    });

    expect(response.status).toBe(502);
    expect(updates).toContainEqual(expect.objectContaining({
      status: "error",
      error: expect.stringContaining("destroy failed"),
    }));
    expect(updates).not.toContainEqual({ status: "deleted" });
    expect(mockDeleteBoxTunnel).not.toHaveBeenCalled();
    expect(mockLogHivraAgentEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "failed",
      detail: expect.objectContaining({
        reason: "delete_destroy_failed",
        proxmox_host: "fixturenode10",
        vmid: 1090,
      }),
    }));
  });

  it("logs out an exact owner-bound private connection before destroying its running VM", async () => {
    mockAgentRow = {
      ...mockAgentRow,
      type: "linux-desktop",
      computer_profile: "ubuntu-desktop",
      computer_substrate: "proxmox-kvm",
      ip: "10.253.0.90",
      infrastructure_binding_token_enforced: true,
    };
    mockPrivateAccessRow = {
      authority: {
        id: "agent-1", user_id: "user-free", type: "linux-desktop", computer_profile: "ubuntu-desktop",
        computer_substrate: "proxmox-kvm", deployment_mode: "hivra-managed", proxmox_host: "fixturenode10",
        infrastructure_connection_id: null, deployment_target_id: null, infrastructure_connection_revision: null,
        infrastructure_binding_token_hash: "b".repeat(64), infrastructure_binding_token_enforced: true,
        vmid: 1090, ip: "10.253.0.90", managed_provisioner_channel: "default",
      },
      login_server: "https://headscale.example.test:8443",
    };

    const response = await DELETE(makeRequest() as never, { params: Promise.resolve({ id: "agent-1" }) });

    expect(response.status).toBe(200);
    expect(mockPrepareHivraTailscaleForDelete).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-1", operation_kind: "delete", desired_state: "deleted" }),
      expect.objectContaining({ host: "fixturenode10", infrastructureBindingTagEnforced: true }),
    );
    expect(mockPrepareHivraTailscaleForDelete.mock.invocationCallOrder[0])
      .toBeLessThan(mockRunProxmoxHostScript.mock.invocationCallOrder[0]);
  });

  it("retains the VM when an owned running guest logout cannot be confirmed", async () => {
    mockAgentRow = {
      ...mockAgentRow,
      type: "linux-desktop", computer_profile: "ubuntu-desktop", computer_substrate: "proxmox-kvm",
      ip: "10.253.0.90", infrastructure_binding_token_enforced: true,
    };
    mockPrivateAccessRow = {
      authority: {
        id: "agent-1", user_id: "user-free", type: "linux-desktop", computer_profile: "ubuntu-desktop",
        computer_substrate: "proxmox-kvm", deployment_mode: "hivra-managed", proxmox_host: "fixturenode10",
        infrastructure_connection_id: null, deployment_target_id: null, infrastructure_connection_revision: null,
        infrastructure_binding_token_hash: "b".repeat(64), infrastructure_binding_token_enforced: true,
        vmid: 1090, ip: "10.253.0.90", managed_provisioner_channel: "default",
      },
    };
    mockPrepareHivraTailscaleForDelete.mockResolvedValue({ ok: false, disposition: "unconfirmed", failureCode: "host_timeout" });

    const response = await DELETE(makeRequest() as never, { params: Promise.resolve({ id: "agent-1" }) });

    expect(response.status).toBe(502);
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
    expect(updates).toContainEqual(expect.objectContaining({ status: "error",
      error: expect.stringContaining("guest logout was not confirmed") }));
  });

  it("destroys an error-state VM before marking the failed agent deleted", async () => {
    mockAgentRow = {
      ...mockAgentRow,
      status: "error",
      error: "cpu limit apply failed",
      vmid: 1090,
      proxmox_host: "fixturenode10",
    };

    const response = await DELETE(makeRequest() as never, {
      params: Promise.resolve({ id: "agent-1" }),
    });

    expect(response.status).toBe(200);
    expect(mockRunProxmoxHostScript).toHaveBeenCalledWith(
      expect.stringContaining("qm destroy \"$VMID\" --purge 1 --destroy-unreferenced-disks 1"),
      expect.objectContaining({ PROXMOX_NODE: "fixturenode10" }),
    );
    expect(updates).toContainEqual({ status: "deleted" });
  });

  it("destroys a bound VM with its owner-scoped target and portable paths", async () => {
    mockAgentRow = {
      ...mockAgentRow,
      infrastructure_connection_id: "11111111-1111-4111-8111-111111111111",
      deployment_target_id: "22222222-2222-4222-8222-222222222222",
      infrastructure_connection_revision: 3,
      deployment_mode: "self-managed",
      proxmox_host: "__hivra_self_managed_no_ambient_authority__",
      allocation_operation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      infrastructure_binding_token_enforced: true,
    };

    const response = await DELETE(makeRequest() as never, {
      params: Promise.resolve({ id: "agent-1" }),
    });

    expect(response.status).toBe(200);
    expect(mockResolveSelfManagedProxmoxExecutionContext).toHaveBeenCalledWith(
      "user-free",
      {
        connectionId: "11111111-1111-4111-8111-111111111111",
        targetId: "22222222-2222-4222-8222-222222222222",
        expectedConnectionRevision: 3,
        purpose: "teardown",
      },
    );
    expect(mockResolveProxmoxTargetConfiguration).not.toHaveBeenCalled();
    expect(mockRunProxmoxHostScript).toHaveBeenCalledWith(
      expect.stringContaining("rm -f -- '/var/log/hivra/provision-1090.log' '/var/log/hivra/start-1090.log'"),
      expect.objectContaining({
        PROXMOX_NODE: "pve-home",
        HIVRA_USER_INFRA_CONNECTION: "true",
      }),
    );
    expect(mockRunProxmoxHostScript.mock.calls[0][0]).toContain("STORAGE='fast-zfs'");
  });
});

describe("GET /api/hivra/agents/[id]", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    updates.length = 0;
    mockCompleteRunningResult = true;
    mockAuth.mockResolvedValue({ userId: "user-free" });
    mockResolveProxmoxTargetConfiguration.mockReturnValue({ env: { PROXMOX_NODE: "fixturenode10" } });
    mockResolveSelfManagedProxmoxExecutionContext.mockResolvedValue(selfManagedContext());
    mockRunProxmoxHostScript.mockResolvedValue({ ok: true, stdout: "", stderr: "" });
    mockDeleteBoxTunnel.mockResolvedValue(undefined);
    mockLogHivraAgentEvent.mockResolvedValue(undefined);
    mockSeedAgentBox.mockResolvedValue({ ok: true });
    mockSupabaseRpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === "checkpoint_hivra_agent_operation") {
        return {
          data: mockAgentRow.desired_state === args.p_expected_desired_state,
          error: null,
        };
      }
      if (name === "complete_hivra_agent_running") {
        if (!mockCompleteRunningResult) return { data: false, error: null };
        const update = {
          status: "running",
          chat_url: args.p_chat_url,
          ip: args.p_ip,
          api_token: args.p_api_token ?? mockAgentRow.api_token,
          provisioned_at: mockAgentRow.provisioned_at ?? args.p_provisioned_at,
        };
        updates.push(update);
        mockAgentRow = { ...mockAgentRow, ...update, operation_id: null, operation_kind: null };
        return { data: true, error: null };
      }
      if (name === "release_hivra_agent_operation") {
        const update = args.p_mark_error
          ? { status: "error", error: args.p_error }
          : {};
        if (Object.keys(update).length) updates.push(update);
        mockAgentRow = { ...mockAgentRow, ...update, operation_id: null, operation_kind: null };
        return { data: true, error: null };
      }
      return { data: true, error: null };
    });
    mockAgentRow = {
      id: "agent-1",
      user_id: "user-free",
      type: "claude-code",
      status: "provisioning",
      vmid: 1090,
      proxmox_host: "fixturenode10",
      ip: "10.253.0.90",
      api_token: "a".repeat(64),
      cf_tunnel_id: "tun_123",
      cf_hostname: "box.example.com",
      provisioned_at: "2026-06-05T12:00:00.000Z",
      deployment_mode: "hivra-managed",
      desired_state: "running",
      operation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      operation_kind: "provision",
      operation_started_at: "2026-06-05T12:00:00.000Z",
      operation_payload: { compatibility: "n_minus_one" },
      allocation_operation_id: null,
      infrastructure_binding_token_hash: "b".repeat(64),
      infrastructure_binding_token_enforced: false,
    };

    mockSupabaseFrom.mockImplementation(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn(async () => ({
        data: mockAgentRow,
        error: null,
      })),
      maybeSingle: jest.fn(async () => ({
        data: mockAgentRow,
        error: null,
      })),
      update: jest.fn((payload: Record<string, unknown>) => {
        updates.push(payload);
        const updated = { ...mockAgentRow, ...payload };
        return {
          eq: jest.fn(() => ({
            select: jest.fn(() => ({
              single: jest.fn(async () => ({ data: updated, error: null })),
            })),
          })),
        };
      }),
    }));
  });

  it("preserves the first provision timestamp when a restarted agent becomes ready again", async () => {
    mockRunProxmoxHostScript.mockResolvedValueOnce({
      ok: true,
      stdout: `{\"vmid\":1090,\"ready\":true,\"chat_url\":\"https://box.example.com\",\"ip\":\"10.253.0.90\",\"api_token\":\"${"b".repeat(64)}\"}\n`,
      stderr: "",
    });

    const response = await GET(makeGetRequest() as never, {
      params: Promise.resolve({ id: "agent-1" }),
    });

    expect(response.status).toBe(200);
    expect(updates).toContainEqual(expect.objectContaining({
      status: "running",
      provisioned_at: "2026-06-05T12:00:00.000Z",
      chat_url: "https://box.example.com",
    }));
    expect(mockCaptureHivraAgentComputerReady).not.toHaveBeenCalled();
  });

  it("captures first readiness only after the atomic provisioning completion wins", async () => {
    mockAgentRow = { ...mockAgentRow, provisioned_at: null };
    mockRunProxmoxHostScript.mockResolvedValueOnce({
      ok: true,
      stdout: `{"vmid":1090,"ready":true,"chat_url":"https://box.example.com","ip":"10.253.0.90","api_token":"${"b".repeat(64)}"}\n`,
      stderr: "",
    });

    const response = await GET(makeGetRequest() as never, {
      params: Promise.resolve({ id: "agent-1" }),
    });

    expect(response.status).toBe(200);
    expect(mockCaptureHivraAgentComputerReady).toHaveBeenCalledTimes(1);
    expect(mockCaptureHivraAgentComputerReady).toHaveBeenCalledWith({
      userId: "user-free",
      agentId: "agent-1",
      agentType: "claude-code",
      deploymentMode: "hivra-managed",
      operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      vmid: 1090,
      evidence: "host_ready_result",
    });
  });

  it("marks Ubuntu Desktop ready only after an exact remote-desktop capability receipt", async () => {
    const computerId = "00000000-0000-4000-8000-000000001041";
    mockAgentRow = {
      ...mockAgentRow,
      id: computerId,
      type: "linux-desktop",
      provisioned_at: null,
      allocation_operation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      infrastructure_binding_token_enforced: true,
    };
    const capability = {
      protocol: "hivra-remote-desktop-capability-v1",
      computerKind: "hivra-agent",
      computerId,
      capabilityGeneration: "00000000-0000-4000-8000-000000001044",
      observedRevision: REMOTE_DESKTOP_BUNDLE_REVISION,
      compositor: "x11",
      installedTransports: ["selkies-websocket"],
      privateNetworkReachable: false,
      supportsInputTakeover: true,
      brokerOrigin: "https://box.example.com",
      // The readiness route deliberately requires the boot identity: the guest
      // script publishes it, and only the desktop-runtime path opts into
      // allowMissingBootIdentity.
      bootIdentitySha256: "d".repeat(64),
      observedAt: new Date().toISOString(),
    };
    mockRunProxmoxHostScript
      .mockResolvedValueOnce({
        ok: true,
        stdout: `{"vmid":1090,"ready":true,"agent_kind":"linux-desktop","chat_url":"https://box.example.com","ip":"10.253.0.90","api_token":"${"b".repeat(64)}"}\nHIVRA_PROVIDER_OWNERSHIP aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n`,
        stderr: "",
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: `HIVRA_REMOTE_DESKTOP_CAPABILITY_V1 ${JSON.stringify(capability)}\n`,
        stderr: "",
      });

    const response = await GET(makeGetRequest() as never, {
      params: Promise.resolve({ id: computerId }),
    });

    expect(response.status).toBe(200);
    expect(mockRunProxmoxHostScript).toHaveBeenCalledTimes(2);
    expect(mockRunProxmoxHostScript).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("run_vmid_bound_guest_exec /bin/bash -c"),
      expect.objectContaining({ PROXMOX_NODE: "fixturenode10" }),
      { timeoutMs: 45_000, maxOutputBytes: 16 * 1024, earlyFinishMarker: "HIVRA_REMOTE_DESKTOP_CAPABILITY_V1 " },
    );
    expect(mockSupabaseRpc).toHaveBeenCalledWith(
      "complete_hivra_agent_running",
      expect.objectContaining({ p_agent_id: computerId }),
    );
    expect(mockCaptureHivraAgentComputerReady).toHaveBeenCalledWith(expect.objectContaining({
      agentId: computerId,
      agentType: "linux-desktop",
      evidence: "remote_desktop_capability_receipt",
    }));
    expect(mockSeedAgentBox).not.toHaveBeenCalled();
  });

  it("returns an already-bound Ubuntu computer to running after restart without requiring provision-only kind evidence", async () => {
    const computerId = "00000000-0000-4000-8000-000000001041";
    const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    mockAgentRow = {
      ...mockAgentRow,
      id: computerId,
      type: "linux-desktop",
      operation_id: operationId,
      operation_kind: "restart",
      operation_payload: null,
      infrastructure_binding_token_enforced: true,
    };
    const capability = {
      protocol: "hivra-remote-desktop-capability-v1",
      computerKind: "hivra-agent",
      computerId,
      capabilityGeneration: "00000000-0000-4000-8000-000000001044",
      observedRevision: REMOTE_DESKTOP_BUNDLE_REVISION,
      compositor: "x11",
      installedTransports: ["selkies-websocket"],
      privateNetworkReachable: false,
      supportsInputTakeover: true,
      brokerOrigin: "https://box.example.com",
      // The readiness route deliberately requires the boot identity: the guest
      // script publishes it, and only the desktop-runtime path opts into
      // allowMissingBootIdentity.
      bootIdentitySha256: "d".repeat(64),
      observedAt: new Date().toISOString(),
    };
    mockRunProxmoxHostScript
      .mockResolvedValueOnce({
        ok: true,
        stdout: `{"vmid":1090,"ready":true,"chat_url":"https://box.example.com","ip":"10.253.0.90","api_token":"${"b".repeat(64)}"}\nHIVRA_OPERATION_RECEIPT ${operationId}\n`,
        stderr: "",
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: `HIVRA_REMOTE_DESKTOP_CAPABILITY_V1 ${JSON.stringify(capability)}\n`,
        stderr: "",
      });

    const response = await GET(makeGetRequest() as never, {
      params: Promise.resolve({ id: computerId }),
    });

    expect(response.status).toBe(200);
    expect(mockSupabaseRpc).toHaveBeenCalledWith(
      "complete_hivra_agent_running",
      expect.objectContaining({ p_agent_id: computerId, p_operation_id: operationId }),
    );
    expect(mockSupabaseRpc.mock.calls.some(([name]) => name === "release_hivra_agent_operation")).toBe(false);
  });

  it("fails Ubuntu Desktop provisioning when capability evidence is absent", async () => {
    const computerId = "00000000-0000-4000-8000-000000001041";
    mockAgentRow = {
      ...mockAgentRow,
      id: computerId,
      type: "linux-desktop",
      allocation_operation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      infrastructure_binding_token_enforced: true,
    };
    mockRunProxmoxHostScript
      .mockResolvedValueOnce({
        ok: true,
        stdout: `{"vmid":1090,"ready":true,"agent_kind":"linux-desktop","chat_url":"https://box.example.com","ip":"10.253.0.90","api_token":"${"b".repeat(64)}"}\nHIVRA_PROVIDER_OWNERSHIP aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n`,
        stderr: "",
      })
      .mockResolvedValueOnce({ ok: true, stdout: "", stderr: "" });

    const response = await GET(makeGetRequest() as never, {
      params: Promise.resolve({ id: computerId }),
    });

    expect(response.status).toBe(200);
    expect(mockSupabaseRpc.mock.calls.some(([name]) => name === "complete_hivra_agent_running")).toBe(false);
    expect(mockSupabaseRpc).toHaveBeenCalledWith(
      "release_hivra_agent_operation",
      expect.objectContaining({
        p_agent_id: computerId,
        p_mark_error: true,
        p_error: "Ubuntu Desktop did not publish its exact remote-desktop capability receipt.",
      }),
    );
    expect(mockCaptureHivraAgentComputerReady).not.toHaveBeenCalled();
    expect(mockSeedAgentBox).not.toHaveBeenCalled();
  });

  it("reads the current managed bundle's one-shot bearer before completing ready JSON without api_token", async () => {
    const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const oneShotToken = "c".repeat(64);
    mockAgentRow = {
      ...mockAgentRow,
      api_token: null,
      provisioned_at: null,
      operation_payload: null,
      allocation_operation_id: operationId,
      infrastructure_binding_token_enforced: true,
    };
    mockRunProxmoxHostScript.mockResolvedValueOnce({
      ok: true,
      stdout: [
        '{"vmid":1090,"ready":true,"chat_url":"https://box.example.com","ip":"10.253.0.90"}',
        `HIVRA_PROVIDER_OWNERSHIP ${operationId}`,
        `HIVRA_PROVISION_SECRET ${oneShotToken}`,
        "",
      ].join("\n"),
      stderr: "",
    });

    const response = await GET(makeGetRequest() as never, {
      params: Promise.resolve({ id: "agent-1" }),
    });

    expect(response.status).toBe(200);
    const pollScript = String(mockRunProxmoxHostScript.mock.calls[0][0]);
    expect(pollScript).toContain("/var/lib/hivra/provision-results/1090.secret");
    expect(mockSupabaseRpc).toHaveBeenCalledWith(
      "complete_hivra_agent_running",
      expect.objectContaining({
        p_operation_id: operationId,
        p_api_token: oneShotToken,
      }),
    );
    expect(updates).toContainEqual(expect.objectContaining({
      status: "running",
      api_token: oneShotToken,
    }));
    expect(mockRunProxmoxHostScript).toHaveBeenCalledWith(
      expect.stringContaining("rm -f -- '/var/lib/hivra/provision-results/1090.secret'"),
      expect.objectContaining({ PROXMOX_NODE: "fixturenode10" }),
    );
  });

  it("does not capture readiness when another poll wins the atomic completion", async () => {
    mockAgentRow = { ...mockAgentRow, provisioned_at: null };
    mockCompleteRunningResult = false;
    mockRunProxmoxHostScript.mockResolvedValueOnce({
      ok: true,
      stdout: `{"vmid":1090,"ready":true,"chat_url":"https://box.example.com","ip":"10.253.0.90","api_token":"${"b".repeat(64)}"}\n`,
      stderr: "",
    });

    const response = await GET(makeGetRequest() as never, {
      params: Promise.resolve({ id: "agent-1" }),
    });

    expect(response.status).toBe(200);
    expect(mockCaptureHivraAgentComputerReady).not.toHaveBeenCalled();
  });

  it("converges a host-reported provisioning failure instead of polling forever", async () => {
    mockRunProxmoxHostScript.mockResolvedValueOnce({
      ok: true,
      stdout: '{"vmid":1090,"ready":false,"error":"provisioning failed; inspect the host log"}\n',
      stderr: "",
    });

    const response = await GET(makeGetRequest() as never, {
      params: Promise.resolve({ id: "agent-1" }),
    });

    expect(response.status).toBe(200);
    expect(updates).toContainEqual({
      status: "error",
      error: "provisioning failed; inspect the host log",
    });
    expect(mockLogHivraAgentEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "failed",
      agentId: "agent-1",
      detail: expect.objectContaining({
        reason: "provisioner_reported_failure",
        vmid: 1090,
      }),
    }));
    expect(mockDeleteBoxTunnel).toHaveBeenCalledWith({
      tunnelId: "tun_123",
      hostname: "box.example.com",
    });
    const body = await response.json();
    expect(body.data.agent).toEqual(expect.objectContaining({
      status: "error",
      error: "provisioning failed; inspect the host log",
    }));

    const pollScript = String(mockRunProxmoxHostScript.mock.calls[0][0]);
    const fixture = mkdtempSync(path.join(tmpdir(), "hivra-failure-marker-"));
    try {
      const logPath = path.join(fixture, "provision.log");
      const failureMarker =
        '{"vmid":1090,"ip":"10.253.0.90","agent_kind":"codex","ready":false,"error":"provisioning failed; cleanup verified; inspect the host log"}';
      writeFileSync(logPath, `${failureMarker}\n`);
      const markerProbe = pollScript
        .split("\n")
        .slice(0, 2)
        .join("\n")
        .replace("'/root/hivra-prov-1090.log'", `'${logPath}'`);
      expect(spawnSync("bash", [], { input: markerProbe, encoding: "utf8" })).toMatchObject({
        status: 0,
        stdout: `${failureMarker}\n`,
        stderr: "",
      });
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("does not delete routing when another poll wins failure convergence", async () => {
    mockRunProxmoxHostScript.mockResolvedValueOnce({
      ok: true,
      stdout: '{"vmid":1090,"ready":false,"error":"provisioning failed"}\n',
      stderr: "",
    });
    mockSupabaseRpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === "checkpoint_hivra_agent_operation") {
        return {
          data: mockAgentRow.desired_state === args.p_expected_desired_state,
          error: null,
        };
      }
      if (name === "release_hivra_agent_operation") {
        return { data: false, error: null };
      }
      return { data: true, error: null };
    });

    const response = await GET(makeGetRequest() as never, {
      params: Promise.resolve({ id: "agent-1" }),
    });

    expect(response.status).toBe(200);
    expect(mockDeleteBoxTunnel).not.toHaveBeenCalled();
    expect(mockLogHivraAgentEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      event: "failed",
    }));
  });

  it("logs host polling failures with enough context to diagnose missed provisioning counts", async () => {
    mockRunProxmoxHostScript.mockResolvedValueOnce({
      ok: false,
      stdout: "",
      stderr: "permission denied",
      error: "ssh failed",
    });

    const response = await GET(makeGetRequest() as never, {
      params: Promise.resolve({ id: "agent-1" }),
    });

    expect(response.status).toBe(200);
    expect(updates).toEqual([]);
    expect(mockLogWarn).toHaveBeenCalledWith(
      "hivra agent provision status poll failed",
      expect.objectContaining({
        source: "hivra/agents/[id]",
        failureType: "hivra_agent_provision_poll_failed",
        userId: "user-free",
        agentId: "agent-1",
        vmid: 1090,
        proxmoxHost: "fixturenode10",
        errorMessage: "ssh failed",
        stderr: "permission denied",
      }),
    );
  });

  it("does not interpret a malformed checkpoint as permission for cancellation cleanup", async () => {
    mockAgentRow = { ...mockAgentRow, desired_state: "deleted", allocation_operation_id: mockAgentRow.operation_id };
    const original = { ...mockAgentRow };
    mockSupabaseRpc.mockResolvedValueOnce({ data: null, error: null });
    const response = await GET(makeGetRequest() as never, { params: Promise.resolve({ id: "agent-1" }) });
    expect(response.status).toBe(500);
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
    expect(mockVerifiedTunnelCleanup).not.toHaveBeenCalled();
    expect(mockDeleteBoxTunnel).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(mockAgentRow).toEqual(original);
    expect(mockSupabaseRpc).toHaveBeenCalledTimes(1);
  });

  it("retains a delete-superseded lifecycle lease until recovery proves provider quiescence", async () => {
    mockAgentRow = {
      ...mockAgentRow,
      operation_kind: "restart",
      desired_state: "deleted",
      operation_payload: null,
    };

    const response = await GET(makeGetRequest() as never, {
      params: Promise.resolve({ id: "agent-1" }),
    });

    expect(response.status).toBe(200);
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
    expect(mockSupabaseRpc.mock.calls.some(([rpc]) => rpc === "release_hivra_agent_operation")).toBe(false);
  });

  it("polls a bound agent through its exact target and portable provision log", async () => {
    mockAgentRow = {
      ...mockAgentRow,
      infrastructure_connection_id: "11111111-1111-4111-8111-111111111111",
      deployment_target_id: "22222222-2222-4222-8222-222222222222",
      infrastructure_connection_revision: 3,
      deployment_mode: "self-managed",
      proxmox_host: "__hivra_self_managed_no_ambient_authority__",
      infrastructure_binding_token_enforced: true,
    };

    const response = await GET(makeGetRequest() as never, {
      params: Promise.resolve({ id: "agent-1" }),
    });

    expect(response.status).toBe(200);
    expect(mockResolveProxmoxTargetConfiguration).not.toHaveBeenCalled();
    expect(mockRunProxmoxHostScript).toHaveBeenCalledWith(
      expect.stringContaining("'/var/log/hivra/provision-1090.log'"),
      expect.objectContaining({
        PROXMOX_NODE: "pve-home",
        HIVRA_USER_INFRA_CONNECTION: "true",
      }),
    );
  });

  it("seeds a running bound agent through the same owner-scoped environment", async () => {
    mockAgentRow = {
      ...mockAgentRow,
      status: "running",
      bootstrapped_at: null,
      infrastructure_connection_id: "11111111-1111-4111-8111-111111111111",
      deployment_target_id: "22222222-2222-4222-8222-222222222222",
      infrastructure_connection_revision: 3,
      deployment_mode: "self-managed",
      proxmox_host: "__hivra_self_managed_no_ambient_authority__",
      infrastructure_binding_token_enforced: true,
    };

    const response = await GET(makeGetRequest() as never, {
      params: Promise.resolve({ id: "agent-1" }),
    });

    expect(response.status).toBe(200);
    expect(mockSeedAgentBox).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-1", ip: "10.253.0.90" }),
      expect.objectContaining({
        PROXMOX_NODE: "pve-home",
        HIVRA_USER_INFRA_CONNECTION: "true",
      }),
    );
    expect(mockResolveProxmoxTargetConfiguration).not.toHaveBeenCalled();
  });

  it("does not run agent bootstrap for an already-running Ubuntu Desktop", async () => {
    mockAgentRow = {
      ...mockAgentRow,
      type: "linux-desktop",
      status: "running",
      bootstrapped_at: null,
      infrastructure_binding_token_enforced: true,
    };

    const response = await GET(makeGetRequest() as never, {
      params: Promise.resolve({ id: "agent-1" }),
    });

    expect(response.status).toBe(200);
    expect(mockSeedAgentBox).not.toHaveBeenCalled();
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
  });

  describe("agent-run reporter install result", () => {
    const OPERATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const READY = `{"vmid":1090,"ready":true,"chat_url":"https://box.example.com","ip":"10.253.0.90","api_token":"${"b".repeat(64)}"}`;
    let collectorUpsert: jest.Mock;

    beforeEach(() => {
      collectorUpsert = jest.fn(async () => ({ error: null }));
      const agentTable = mockSupabaseFrom.getMockImplementation() as (table: string) => Record<string, unknown>;
      mockSupabaseFrom.mockImplementation((table: string) => (table === "hivra_activity_collectors"
        ? { upsert: collectorUpsert }
        : agentTable(table)));
    });

    const poll = () => GET(makeGetRequest() as never, { params: Promise.resolve({ id: "agent-1" }) });

    it("records a failed launch install from the provision log, separately from issuance", async () => {
      mockRunProxmoxHostScript.mockResolvedValueOnce({
        ok: true, stdout: `${READY}\nHIVRA_ACTIVITY_COLLECTOR status=failed reason=install_failed\n`, stderr: "",
      });

      expect((await poll()).status).toBe(200);
      const script = String(mockRunProxmoxHostScript.mock.calls[0][0]);
      expect(script).toContain("grep -E '^HIVRA_ACTIVITY_COLLECTOR status=(installed|failed reason=[a-z_]{1,40})$' '/root/hivra-prov-1090.log'");
      expect(collectorUpsert).toHaveBeenCalledTimes(1);
      expect(collectorUpsert).toHaveBeenCalledWith({
        agent_id: "agent-1", user_id: "user-free", last_install_status: "failed", last_install_reason: "install_failed",
        last_install_at: expect.any(String), updated_at: expect.any(String),
      }, { onConflict: "agent_id" });
    });

    it.each(["start", "restart", "resize"])("records the %s helper's install result from the start log", async (kind) => {
      mockAgentRow = { ...mockAgentRow, operation_kind: kind, operation_payload: null };
      mockRunProxmoxHostScript.mockResolvedValueOnce({
        ok: true, stdout: `${READY}\nHIVRA_ACTIVITY_COLLECTOR status=installed\nHIVRA_OPERATION_RECEIPT ${OPERATION_ID}\n`, stderr: "",
      });

      expect((await poll()).status).toBe(200);
      expect(String(mockRunProxmoxHostScript.mock.calls[0][0])).toContain("[a-z_]{1,40})$' '/root/hivra-start-1090.log'");
      expect(collectorUpsert).toHaveBeenCalledWith(expect.objectContaining({
        agent_id: "agent-1", last_install_status: "installed", last_install_reason: null,
      }), { onConflict: "agent_id" });
    });

    it("records nothing when no marker was written, the completion was lost, or the line is not the closed enum", async () => {
      for (const [stdout, wins] of [
        [`${READY}\n`, true],
        [`${READY}\nHIVRA_ACTIVITY_COLLECTOR status=installed\n`, false],
        [`${READY}\nHIVRA_ACTIVITY_COLLECTOR status=failed reason=Install failed: hvra_otlp_v1.a.b\n`, true],
        [`${READY}\nHIVRA_ACTIVITY_COLLECTOR status=failed\n`, true],
      ] as const) {
        mockAgentRow = { ...mockAgentRow, status: "provisioning", operation_id: OPERATION_ID, operation_kind: "provision" };
        mockCompleteRunningResult = wins;
        mockRunProxmoxHostScript.mockReset().mockResolvedValue({ ok: true, stdout: "", stderr: "" })
          .mockResolvedValueOnce({ ok: true, stdout, stderr: "" });
        expect((await poll()).status).toBe(200);
      }
      expect(collectorUpsert).not.toHaveBeenCalled();
    });

    it("never probes or records for an agent type without a native producer", async () => {
      mockAgentRow = { ...mockAgentRow, type: "aeon" };
      mockRunProxmoxHostScript.mockResolvedValueOnce({
        ok: true, stdout: `${READY}\nHIVRA_ACTIVITY_COLLECTOR status=installed\n`, stderr: "",
      });

      expect((await poll()).status).toBe(200);
      expect(String(mockRunProxmoxHostScript.mock.calls[0][0])).not.toContain("HIVRA_ACTIVITY_COLLECTOR");
      expect(collectorUpsert).not.toHaveBeenCalled();
    });

    it("converges even when the install result cannot be recorded", async () => {
      collectorUpsert.mockResolvedValueOnce({ error: { message: "fixture outage" } });
      mockRunProxmoxHostScript.mockResolvedValueOnce({
        ok: true, stdout: `${READY}\nHIVRA_ACTIVITY_COLLECTOR status=installed\n`, stderr: "",
      });

      expect((await poll()).status).toBe(200);
      expect(updates).toContainEqual(expect.objectContaining({ status: "running" }));
      expect(mockLogWarn).toHaveBeenCalledWith(
        "hivra agent-run reporter install result could not be recorded",
        expect.objectContaining({ failureType: "hivra_activity_collector_install_record_failed" }),
      );
    });

    it("reads the marker from a real host log with the poll's own grep, ignoring look-alike lines", async () => {
      await poll();
      const script = String(mockRunProxmoxHostScript.mock.calls[0][0]);
      const probe = script.split("\n").filter(line => line.includes("COLLECTOR")).join("\n");
      expect(probe).toContain('COLLECTOR="$(grep -E');
      const work = mkdtempSync(path.join(tmpdir(), "hivra-poll-collector-"));
      try {
        const log = path.join(work, "hivra-prov-1090.log");
        const run = (content: string) => {
          writeFileSync(log, content);
          return spawnSync("bash", ["-c", `set -euo pipefail\n${probe.split("'/root/hivra-prov-1090.log'").join(`'${log}'`)}`], { encoding: "utf8" });
        };
        // The guest installer prints its marker after a blank line, amid bootstrap output.
        expect(run("[hivra-prov] copying provisioner\nbootstrap progress 42%\nHivra agent-run reporter: hivra-agent-trace: install failed: systemctl restart failed\n\nHIVRA_ACTIVITY_COLLECTOR status=failed reason=install_failed\n[hivra-prov] checking CloudFlare NAMED tunnel\n{\"vmid\":1090,\"ready\":true}\n"))
          .toMatchObject({ status: 0, stdout: "HIVRA_ACTIVITY_COLLECTOR status=failed reason=install_failed\n" });
        expect(run("echo HIVRA_ACTIVITY_COLLECTOR status=installed\nHIVRA_ACTIVITY_COLLECTOR status=failed reason=Bad\nHIVRA_ACTIVITY_COLLECTOR status=installed trailing\n"))
          .toMatchObject({ status: 0, stdout: "" });
        expect(run("")).toMatchObject({ status: 0, stdout: "" });
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    });
  });
});
