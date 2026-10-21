/** @jest-environment node */
import { NextRequest } from "next/server";
import { POST } from "../route";

// A Hivra Cloud computer whose owner has no paid plan cannot be started. This
// is the route half of the lapse policy: Start, Restart and Force restart are
// refused (402, plan needed) before the host capacity check, the lease or any
// host call, while Stop and Force off stay open. It only applies once
// HIVRA_LAPSE_ENFORCE_LIVE is "true".

const mockAuth = jest.fn();
const mockRpc = jest.fn();
const mockRun = jest.fn();
const mockReadiness = jest.fn();
const mockRateLimit = jest.fn();
const mockRevoke = jest.fn();
const mockCapacity = jest.fn();
const mockResolve = jest.fn();
let mockRow: Record<string, unknown>;

jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));
jest.mock("@/lib/hivra/hivra-flag", () => ({ isHivraApiAllowed: () => true }));
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn(async () => ({ data: mockRow, error: null })),
      maybeSingle: jest.fn(async () => ({ data: { priority: 0 }, error: null })),
    }),
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}));
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  resolveProxmoxTargetConfiguration: () => ({ env: { PROXMOX_PRIVATE_SUBNET_PREFIX: "10.250.21", PROXMOX_VMID_START: "1090", PROXMOX_IP_LAST_OCTET_START: "90" } }),
  runProxmoxHostScript: (...args: unknown[]) => mockRun(...args),
  buildAgentContainerCgroupScript: () => "",
}));
jest.mock("@/lib/infrastructure/proxmox-execution-context", () => {
  class ProxmoxExecutionContextError extends Error {
    constructor(public readonly code: string) { super(code); }
  }
  return { ProxmoxExecutionContextError, resolveSelfManagedProxmoxExecutionContext: jest.fn() };
});
jest.mock("@/lib/hivra/managed-provisioner-readiness", () => ({ checkManagedHivraHostReadiness: (...args: unknown[]) => mockReadiness(...args) }));
jest.mock("@/lib/hivra/agent-events", () => ({ logHivraAgentEvent: jest.fn() }));
jest.mock("@/lib/proxmox/wake-admission", () => ({ checkHostWakeCapacity: (...args: unknown[]) => mockCapacity(...args) }));
jest.mock("@/lib/hivra/resource-gate", () => ({ validateAgentResources: async () => ({ ok: true }) }));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("@/lib/remote-computers/session-broker", () => ({ revokeRemoteDesktopCapability: (...args: unknown[]) => mockRevoke(...args) }));
jest.mock("@/lib/hivra/provider-agent-power", () => ({ advanceProviderAgentPower: jest.fn() }));
jest.mock("@/lib/hivra/provider-agent-power-store", () => ({ claimProviderAgentPowerOperation: jest.fn(async () => true) }));
jest.mock("@/lib/authenticated-rate-limit", () => ({ enforceAuthenticatedRouteRateLimit: (...args: unknown[]) => mockRateLimit(...args) }));
jest.mock("@/lib/hivra/prepared-canary-computers", () => ({
  ...jest.requireActual("@/lib/hivra/prepared-canary-computers"),
  matchPreparedCanaryComputer: () => null,
}));
jest.mock("@/lib/billing/instance-entitlement", () => ({ resolveEffectiveSubscription: (...args: unknown[]) => mockResolve(...args), hasTokenTierInGrace: () => Promise.resolve(false) }));

const managed = {
  id: "agent-1", user_id: "owner", name: "Desk", type: "linux-desktop", computer_profile: "ubuntu-desktop",
  status: "stopped", desired_state: "stopped", cpu: 2, ram: 4, vmid: 1113, ip: "10.250.21.63", proxmox_host: "fixturenode11",
  deployment_mode: "hivra-managed", computer_substrate: "proxmox-kvm", managed_provisioner_channel: "default",
  infrastructure_binding_token_hash: "b".repeat(64), infrastructure_binding_token_enforced: true,
  operation_id: null, operation_kind: null, chat_url: "https://box-agent-1.example.test", api_token: "fixture-bearer",
};
const paid = { plan: "operator", source: "stripe", status: "active" };
const free = { plan: "free", source: "free", status: "active" };

function send(body: Record<string, unknown>) {
  const headers = { Host: "hivra.cloud", "Content-Type": "application/json", Origin: "https://hivra.cloud", "Sec-Fetch-Site": "same-origin" };
  return POST(new NextRequest("https://hivra.cloud/api/hivra/agents/agent-1/action", { method: "POST", headers, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: "agent-1" }) });
}

const originalLive = process.env.HIVRA_LAPSE_ENFORCE_LIVE;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.HIVRA_LAPSE_ENFORCE_LIVE = "true";
  mockRow = { ...managed };
  mockAuth.mockResolvedValue({ userId: "owner" });
  mockReadiness.mockResolvedValue({ ok: true });
  mockRateLimit.mockReturnValue(null);
  mockRevoke.mockResolvedValue({ ok: true, revoked: true });
  mockCapacity.mockResolvedValue({ ok: true, freeMb: 32_768 });
  mockRpc.mockResolvedValue({ data: true, error: null });
  mockRun.mockResolvedValue({ ok: true, stdout: "HIVRA_STOPPED\nHIVRA_FORCE_STOPPED vmid=1113\nkicked\n", stderr: "" });
  mockResolve.mockResolvedValue(null);
});
afterAll(() => {
  if (originalLive === undefined) delete process.env.HIVRA_LAPSE_ENFORCE_LIVE;
  else process.env.HIVRA_LAPSE_ENFORCE_LIVE = originalLive;
});

describe("Start, Restart, Force restart and Resize for an owner with no paid plan", () => {
  it.each(["start", "restart", "force_restart", "resize"])("%s answers 402 before the capacity check, the lease or any host call", async (action) => {
    for (const entitlement of [null, free]) {
      mockResolve.mockResolvedValue(entitlement);
      const response = await send({ action, cpu: 2, ram: 4 });
      expect(response.status).toBe(402);
      const body = await response.json();
      expect(body.code).toBe("instance_entitlement_suspended");
      expect(body.error).toMatch(/paid plan/i);
      expect(mockCapacity).not.toHaveBeenCalled();
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockRun).not.toHaveBeenCalled();
    }
    expect(mockResolve).toHaveBeenCalledWith("owner", { throwOnQueryError: true });
  });

  it.each(["start", "restart", "force_restart"])("%s works for an owner with a paid plan", async (action) => {
    mockResolve.mockResolvedValue(paid);
    expect((await send({ action })).status).toBe(200);
    expect(mockRun).toHaveBeenCalled();
    // Autostart is turned back on, because a billing stop turns it off.
    expect(String(mockRun.mock.calls[0][0])).toContain("--onboot 1");
  });

  it("fails open when the entitlement check throws", async () => {
    mockResolve.mockRejectedValue(new Error("database unavailable"));
    expect((await send({ action: "start" })).status).toBe(200);
  });

  it.each([undefined, "false", "TRUE", "1", " true"])("lets everything through, and asks nothing, while the switch is %p", async (value) => {
    if (value === undefined) delete process.env.HIVRA_LAPSE_ENFORCE_LIVE;
    else process.env.HIVRA_LAPSE_ENFORCE_LIVE = value;
    expect((await send({ action: "start" })).status).toBe(200);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("keeps Stop and Force off open so data is never held hostage", async () => {
    mockRow = { ...managed, status: "running", desired_state: "running" };
    expect((await send({ action: "stop" })).status).toBe(200);
    expect((await send({ action: "force_stop" })).status).toBe(200);
    expect(mockResolve).not.toHaveBeenCalled();
  });
});
