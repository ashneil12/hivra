/** @jest-environment node */
import { NextRequest } from "next/server";
import { POST } from "../route";


const mockAuth = jest.fn();
const mockRpc = jest.fn();
const mockRun = jest.fn();
const mockReadiness = jest.fn();
const mockRateLimit = jest.fn();
const mockRevoke = jest.fn();
const mockLogEvent = jest.fn();
const mockMatchPrepared = jest.fn();
let mockRow: Record<string, unknown>;

jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));
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
jest.mock("@/lib/hivra/agent-events", () => ({ logHivraAgentEvent: (...args: unknown[]) => mockLogEvent(...args) }));
jest.mock("@/lib/proxmox/wake-admission", () => ({ checkHostWakeCapacity: async () => ({ ok: true, freeMb: 32_768 }) }));
jest.mock("@/lib/hivra/resource-gate", () => ({ validateAgentResources: async () => ({ ok: true }) }));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("@/lib/remote-computers/session-broker", () => ({ revokeRemoteDesktopCapability: (...args: unknown[]) => mockRevoke(...args) }));
jest.mock("@/lib/hivra/provider-agent-power", () => ({ advanceProviderAgentPower: jest.fn() }));
jest.mock("@/lib/hivra/provider-agent-power-store", () => ({ claimProviderAgentPowerOperation: jest.fn(async () => true) }));
jest.mock("@/lib/authenticated-rate-limit", () => ({ enforceAuthenticatedRouteRateLimit: (...args: unknown[]) => mockRateLimit(...args) }));
jest.mock("@/lib/hivra/prepared-canary-computers", () => ({
  ...jest.requireActual("@/lib/hivra/prepared-canary-computers"),
  matchPreparedCanaryComputer: (...args: unknown[]) => mockMatchPrepared(...args),
}));

const managed = {
  id: "agent-1", user_id: "owner", name: "Desk", type: "linux-desktop", computer_profile: "ubuntu-desktop",
  status: "running", desired_state: "running", cpu: 2, ram: 4, vmid: 1113, ip: "10.250.21.63", proxmox_host: "fixturenode11",
  deployment_mode: "hivra-managed", computer_substrate: "proxmox-kvm", managed_provisioner_channel: "default",
  infrastructure_binding_token_hash: "b".repeat(64), infrastructure_binding_token_enforced: true,
  operation_id: null, operation_kind: null, chat_url: "https://box-agent-1.example.test", api_token: "fixture-bearer",
};
const FORCE_RECEIPT = "HIVRA_FORCE_STOPPED vmid=1113";

function send(body: Record<string, unknown>, sameOrigin = true) {
  const headers: Record<string, string> = { Host: "hivra.cloud", "Content-Type": "application/json" };
  if (sameOrigin) Object.assign(headers, { Origin: "https://hivra.cloud", "Sec-Fetch-Site": "same-origin" });
  return POST(new NextRequest("https://hivra.cloud/api/hivra/agents/agent-1/action", { method: "POST", headers, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: "agent-1" }) });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRow = { ...managed };
  mockAuth.mockResolvedValue({ userId: "owner" });
  mockReadiness.mockResolvedValue({ ok: true });
  mockRateLimit.mockReturnValue(null);
  mockRevoke.mockResolvedValue({ ok: true, revoked: true });
  mockMatchPrepared.mockReturnValue(null);
  mockRpc.mockResolvedValue({ data: true, error: null });
  mockRun.mockResolvedValue({ ok: true, stdout: `${FORCE_RECEIPT}\n`, stderr: "" });
});

describe("lifecycle failure and busy reasons", () => {
  it.each(["stop", "start", "restart"])("%s failure returns a sanitized reason and code, never host output", async (action) => {
    mockRun.mockResolvedValue({
      ok: false, stdout: "",
      stderr: "ssh: connect to host fixturenode11 (203.0.113.9) failed; /root/.ssh/id_rsa token=sk-secret",
      error: "Remote bash exited with code 255",
    });
    const response = await send({ action });
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.code).toBe("host_unreachable");
    expect(body.error).toContain("could not reach the server");
    expect(body.error.toLowerCase()).toContain(`${action} failed`);
    const text = JSON.stringify(body);
    for (const leak of ["fixturenode11", "203.0.113.9", "id_rsa", "sk-secret", "Remote bash"]) expect(text).not.toContain(leak);
  });

  it("falls back to a generic host reason for unrecognised output", async () => {
    mockRun.mockResolvedValue({ ok: false, stdout: "", stderr: "weird /opt/hivra/x.sh: line 4", error: "" });
    const body = await (await send({ action: "stop" })).json();
    expect(body.code).toBe("host_error");
    expect(JSON.stringify(body)).not.toContain("/opt/hivra");
  });

  it("says setup is still running when a request arrives during provisioning", async () => {
    mockRow = { ...managed, status: "provisioning", operation_kind: "provision", operation_id: "op-1" };
    mockRpc.mockResolvedValue({ data: false, error: null });
    const response = await send({ action: "stop" });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe("busy");
    expect(body.error).toBe("Setup is still running on this computer. Try again in a minute.");
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("names the retained operation kind when another operation holds the lease", async () => {
    mockRow = { ...managed, operation_kind: "restart", operation_id: "op-2" };
    mockRpc.mockResolvedValue({ data: false, error: null });
    const body = await (await send({ action: "stop" })).json();
    expect(body.error).toBe("This computer is still restarting. Try again in a minute.");
  });
});
