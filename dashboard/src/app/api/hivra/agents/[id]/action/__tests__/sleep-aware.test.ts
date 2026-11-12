/** @jest-environment node */
import { NextRequest } from "next/server";
import { POST } from "../route";

// A sleeping computer is woken before any lifecycle action touches it (every
// action except rename). The wake service itself is covered in agent-wake.test.ts;
// this is the route half: when it asks, what it does with each answer, and that
// nothing reaches the lease or the host while the computer is still asleep.

const mockAuth = jest.fn();
const mockRpc = jest.fn();
const mockRun = jest.fn();
const mockRateLimit = jest.fn();
const mockWake = jest.fn();
const mockMarkAwake = jest.fn();
const mockSingle = jest.fn();
let mockRow: Record<string, unknown>;

jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => ({
      select: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: (...args: unknown[]) => mockSingle(...args),
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
jest.mock("@/lib/hivra/managed-provisioner-readiness", () => ({ checkManagedHivraHostReadiness: async () => ({ ok: true }) }));
jest.mock("@/lib/hivra/agent-events", () => ({ logHivraAgentEvent: jest.fn() }));
jest.mock("@/lib/proxmox/wake-admission", () => ({ checkHostWakeCapacity: async () => ({ ok: true, freeMb: 32_768 }) }));
jest.mock("@/lib/hivra/resource-gate", () => ({ validateAgentResources: async () => ({ ok: true }) }));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("@/lib/remote-computers/session-broker", () => ({ revokeRemoteDesktopCapability: async () => ({ ok: true, revoked: true }) }));
jest.mock("@/lib/hivra/provider-agent-power", () => ({ advanceProviderAgentPower: jest.fn() }));
jest.mock("@/lib/hivra/provider-agent-power-store", () => ({ claimProviderAgentPowerOperation: jest.fn(async () => true) }));
jest.mock("@/lib/authenticated-rate-limit", () => ({ enforceAuthenticatedRouteRateLimit: (...args: unknown[]) => mockRateLimit(...args) }));
jest.mock("@/lib/hivra/prepared-canary-computers", () => ({
  ...jest.requireActual("@/lib/hivra/prepared-canary-computers"),
  matchPreparedCanaryComputer: () => null,
}));
jest.mock("@/lib/billing/instance-entitlement", () => ({ resolveEffectiveSubscription: async () => null, hasTokenTierInGrace: () => Promise.resolve(false) }));
jest.mock("@/lib/hivra/sleep-aware", () => ({
  wakeForUserAction: (...args: unknown[]) => mockWake(...args),
  markAgentAwake: (...args: unknown[]) => mockMarkAwake(...args),
}));
const mockUpdateRuntime = jest.fn();
jest.mock("@/lib/hivra/agent-runtime-update", () => ({ runHivraAgentRuntimeUpdate: (...args: unknown[]) => mockUpdateRuntime(...args) }));

const asleep = {
  id: "agent-1", user_id: "owner", name: "Desk", type: "claude-code", computer_profile: null,
  status: "running", desired_state: "running", cpu: 2, ram: 4, vmid: 1113, ip: "10.250.21.63", proxmox_host: "fixturenode11",
  deployment_mode: "hivra-managed", computer_substrate: "proxmox-kvm", managed_provisioner_channel: "default",
  infrastructure_binding_token_hash: "b".repeat(64), infrastructure_binding_token_enforced: true,
  operation_id: null, operation_kind: null, chat_url: "https://box-agent-1.example.test", api_token: "fixture-bearer",
  sleep_state: "napping", sleep_generation: 4,
};

function send(body: Record<string, unknown>) {
  const headers = { Host: "hivra.cloud", "Content-Type": "application/json", Origin: "https://hivra.cloud", "Sec-Fetch-Site": "same-origin" };
  return POST(new NextRequest("https://hivra.cloud/api/hivra/agents/agent-1/action", { method: "POST", headers, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: "agent-1" }) });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRow = { ...asleep };
  mockSingle.mockImplementation(async () => ({ data: mockRow, error: null }));
  mockAuth.mockResolvedValue({ userId: "owner" });
  mockRateLimit.mockReturnValue(null);
  mockRpc.mockResolvedValue({ data: true, error: null });
  mockRun.mockResolvedValue({ ok: true, stdout: "stopped 1113\nHIVRA_STOP_MODE already\nHIVRA_FORCE_STOPPED vmid=1113\nkicked\n", stderr: "" });
  mockWake.mockResolvedValue({ ok: true, woke: false, cold: false });
  mockMarkAwake.mockResolvedValue(true);
  mockUpdateRuntime.mockResolvedValue({ ok: true, agentCli: null, agentApp: null });
});

describe("waking a sleeping computer before an action", () => {
  it("never wakes for a rename", async () => {
    expect((await send({ action: "rename", name: "New name" })).status).toBe(200);
    expect(mockWake).not.toHaveBeenCalled();
  });

  it.each(["start", "restart", "force_restart", "resize", "snapshot", "restore", "update_runtime"])(
    "%s asks for the wake, and does nothing else while the computer is still waking", async (action) => {
      mockWake.mockResolvedValue({ ok: false, reason: "waking", status: 503, code: "computer_asleep",
        message: "Your computer is still waking up. Try again in a few seconds." });
      const response = await send({ action, cpu: 2, ram: 4, snapshotId: "snap-1" });
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.code).toBe("computer_asleep");
      expect(body.error).toMatch(/still waking up/);
      expect(mockWake).toHaveBeenCalledWith(expect.objectContaining({ id: "agent-1", sleep_state: "napping" }));
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockRun).not.toHaveBeenCalled();
      expect(mockUpdateRuntime).not.toHaveBeenCalled();
    });

  it.each(["stop", "force_stop"])("%s never asks for a wake, so a stuck or refused wake cannot block it", async (action) => {
    mockWake.mockResolvedValue({ ok: false, reason: "failed", status: 503, code: "computer_asleep",
      message: "Your computer could not wake up just now. Try again in a moment." });
    mockRow = { ...asleep, sleep_state: "hibernated" };
    const response = await send({ action });
    expect(response.status).toBe(200);
    expect(mockWake).not.toHaveBeenCalled();
    expect(mockRun).toHaveBeenCalled();
    expect(String(mockRun.mock.calls[0][0])).toContain("qm unlock");
    expect(mockMarkAwake).toHaveBeenCalledWith("agent-1");
  });

  it("still wakes for every other action, with no lapse exemption", async () => {
    await send({ action: "restart" });
    const allowLapsed = mockWake.mock.calls.map(([, options]) => (options as { allowLapsed?: boolean } | undefined)?.allowLapsed);
    expect(allowLapsed).toEqual([undefined]);
  });

  it("works from a fresh copy of the row after a wake", async () => {
    mockWake.mockImplementation(async () => { mockRow = { ...mockRow, sleep_state: "awake" }; return { ok: true, woke: true, cold: false }; });
    const callsBefore = mockSingle.mock.calls.length;
    expect((await send({ action: "restart" })).status).toBe(200);
    // The first read loads the agent; the second is the reload after the wake.
    expect(mockSingle.mock.calls.length - callsBefore).toBeGreaterThanOrEqual(2);
  });

  it("does not reload the row when nothing was woken", async () => {
    mockRow = { ...asleep, sleep_state: "awake" };
    mockSingle.mockClear();
    expect((await send({ action: "restart" })).status).toBe(200);
    const readsOfTheAgent = mockSingle.mock.calls.length;
    mockSingle.mockClear();
    mockWake.mockImplementation(async () => { mockRow = { ...mockRow, sleep_state: "awake" }; return { ok: true, woke: true, cold: false }; });
    expect((await send({ action: "restart" })).status).toBe(200);
    expect(mockSingle.mock.calls.length).toBeGreaterThan(readsOfTheAgent);
  });

  it("puts the sleep record back to awake once a computer is switched off", async () => {
    expect((await send({ action: "stop" })).status).toBe(200);
    expect(mockMarkAwake).toHaveBeenCalledWith("agent-1");
    mockMarkAwake.mockClear();
    expect((await send({ action: "force_stop" })).status).toBe(200);
    expect(mockMarkAwake).toHaveBeenCalledWith("agent-1");
  });

  it("does not run an update on a computer that was switched off with nothing saved", async () => {
    mockWake.mockResolvedValue({ ok: true, woke: true, cold: true });
    const response = await send({ action: "update_runtime" });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("not_running");
    expect(mockUpdateRuntime).not.toHaveBeenCalled();
  });

  it("starts a stopped computer whose sleep record was left napping, and resets the record", async () => {
    // A stop that could not reset the record left status stopped with a napping sleep state.
    mockRow = { ...asleep, status: "stopped", desired_state: "stopped", sleep_state: "napping" };
    const response = await send({ action: "start" });
    expect(response.status).toBe(200);
    expect(mockMarkAwake).toHaveBeenCalledWith("agent-1");
    expect(mockRun).toHaveBeenCalled();
  });

  it("goes ahead with Start for a computer that was off with nothing saved", async () => {
    // A cold wake finishes the sleep record as awake.
    mockWake.mockImplementation(async () => { mockRow = { ...mockRow, sleep_state: "awake" }; return { ok: true, woke: true, cold: true }; });
    expect((await send({ action: "start" })).status).toBe(200);
    expect(mockRun).toHaveBeenCalled();
  });

  it("the Stop and Force off scripts switch off a napping computer and discard a hibernation", async () => {
    await send({ action: "stop" });
    const stop = String(mockRun.mock.calls[0][0]);
    expect(stop).toContain("qmpstatus:");
    expect(stop).toContain("qm unlock");
    await send({ action: "force_stop" });
    const forced = String(mockRun.mock.calls[1][0]);
    expect(forced).toContain("qm unlock");
    expect(forced).toContain("--delete vmstate,runningmachine,runningcpu");
  });
});

describe("a computer that falls asleep between the wake check and the lease", () => {
  /** The first read (the route's own) sees an awake computer; every later read sees it napping. */
  function fallAsleepAfterFirstRead() {
    let reads = 0;
    mockSingle.mockImplementation(async () => {
      reads += 1;
      return { data: { ...asleep, sleep_state: reads === 1 ? "awake" : "napping" }, error: null };
    });
  }
  const released = () => mockRpc.mock.calls.filter(([name]) => name === "release_hivra_agent_operation");

  it.each(["start", "restart", "resize"])("%s gives the lease back untouched and asks to try again", async (action) => {
    fallAsleepAfterFirstRead();
    const response = await send({ action, cpu: 2, ram: 4 });
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("computer_asleep");
    expect(released()).toHaveLength(1);
    expect(released()[0][1]).toMatchObject({ p_mark_error: false });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("does not refuse Start of a stopped computer over a leftover sleep record", async () => {
    mockSingle.mockImplementation(async () => ({ data: { ...asleep, status: "stopped", desired_state: "stopped", sleep_state: "hibernated" }, error: null }));
    const response = await send({ action: "start" });
    expect(response.status).toBe(200);
    expect(released()).toHaveLength(0);
    expect(mockRun).toHaveBeenCalled();
  });

  it("lets Stop go ahead, because its script handles a napping or hibernated computer itself", async () => {
    fallAsleepAfterFirstRead();
    const response = await send({ action: "stop" });
    expect(response.status).toBe(200);
    expect(released()).toHaveLength(0);
    expect(mockRun).toHaveBeenCalled();
  });
});
