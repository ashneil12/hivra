/** @jest-environment node */

// sleepHivraAgent for an agent whose public connector runs on the host:
// refused unless ingress may act, unless the host connector is the only one at
// the edge, and unless the proxy's own view of the computer is idle; and the
// sleep and recovery scripts get the host-ingress variants.


const mockReadRow = jest.fn();
const mockHostRow = jest.fn();
const mockListRows = jest.fn();
const mockUpdate = jest.fn();
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "limit"]) q[m] = () => q;
      q.update = (patch: unknown) => { mockUpdate(table, patch); return q; };
      q.maybeSingle = () => (table === "hivra_agents" ? mockReadRow() : mockHostRow());
      q.then = (resolve: (value: unknown) => unknown) => Promise.resolve(mockListRows(table)).then(resolve);
      return q;
    },
  },
}));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

const mockClaim = jest.fn();
const mockFinish = jest.fn();
const mockLogEvent = jest.fn();
jest.mock("../../agent-sleep-store", () => ({
  ...jest.requireActual("../../agent-sleep-store"),
  claimAgentSleep: (...a: unknown[]) => mockClaim(...a),
  finishAgentSleep: (...a: unknown[]) => mockFinish(...a),
  logAgentSleepEvent: (...a: unknown[]) => mockLogEvent(...a),
}));

const mockResolveTarget = jest.fn();
jest.mock("../../agent-lifecycle-host", () => ({
  resolveHivraLifecycleTarget: (...a: unknown[]) => mockResolveTarget(...a),
}));
const mockRunScript = jest.fn();
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  runProxmoxHostScript: (...a: unknown[]) => mockRunScript(...a),
}));
const mockLapsed = jest.fn();
jest.mock("../../lapse-gate", () => ({ isStartBlockedForLapse: (...a: unknown[]) => mockLapsed(...a) }));
jest.mock("@/lib/ssrf-safe-fetch", () => ({ ssrfSafeFetch: jest.fn() }));
jest.mock("@/lib/proxmox/wake-admission", () => ({}));

const mockConnectors = jest.fn();
jest.mock("@/lib/services/cloudflare-tunnel", () => ({ listTunnelConnections: (...a: unknown[]) => mockConnectors(...a) }));
const mockLoadIngress = jest.fn();
jest.mock("../wake-client", () => ({
  ...jest.requireActual("../wake-client"),
  loadAgentIngressState: (...a: unknown[]) => mockLoadIngress(...a),
}));

import { ingressIdleBlocker, sleepHivraAgent } from "../../agent-sleep";
import { probeLine } from "../../__tests__/sleep-stub-host.fixtures";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const VMID = 1234;
const NOW = Date.parse("2026-11-12T12:00:00Z");
const now = () => NOW;

function eligibleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    user_id: "user-1",
    type: "claude-code",
    status: "running",
    desired_state: "running",
    operation_id: null,
    deployment_mode: "hivra-managed",
    computer_substrate: "proxmox-kvm",
    deployment_target_id: null,
    cf_hostname: "agent-one.example.test",
    vmid: VMID,
    proxmox_host: "host-a",
    infrastructure_binding_token_enforced: true,
    always_on: false,
    bootstrapped_at: "2026-11-01T00:00:00Z",
    bankr_skills_seeded_at: "2026-11-01T00:00:00Z",
    template_skills_seeded_at: "2026-11-01T00:00:00Z",
    template_skills: [],
    sleep_state: "awake",
    sleep_generation: 3,
    sleep_policy: "full",
    next_wake_at: null,
    cpu: 2,
    ram: 4,
    ...overrides,
  };
}
const host = { status: "active", sleep_mode: "canary" };

const target = {
  executionContext: {
    paths: { provisionerDirectory: "/opt/hivra/provisioner" },
    capacityPolicy: { mode: "observe", hostMemoryReserveMb: 2048, cpuCeilingDensity: 1, memoryCeilingDensity: 1 },
  },
  bindingTag: "hivra-tag-1",
  env: {},
  vmid: VMID,
};

function probeObject(overrides: Record<string, unknown> = {}) {
  return JSON.parse(probeLine(overrides).slice("HIVRA_IDLE ".length));
}
function sleepReceipt(over: Record<string, unknown> = {}) {
  return `HIVRA_SLEEP_RESULT ${JSON.stringify({
    ok: true, vmid: VMID, tier: "nap", from: "awake", to: "napping", reason: "napped", ms: 1200,
    steps: { suspend: 300 }, probe: probeObject(), ...over,
  })}\n`;
}
function wakeReceipt(over: Record<string, unknown> = {}) {
  return `HIVRA_WAKE_RESULT ${JSON.stringify({
    ok: true, vmid: VMID, from: "napping", to: "awake", reason: "resumed", ms: 900, steps: { resume: 100 }, ...over,
  })}\n`;
}

interface Scripts { probe?: string; sleep?: string; wake?: string }
function stubScripts(scripts: Scripts) {
  mockRunScript.mockImplementation(async (script: string) => {
    let stdout: string | undefined;
    if (script.includes("HIVRA_SLEEP_RESULT")) stdout = scripts.sleep;
    else if (script.includes("HIVRA_WAKE_RESULT")) stdout = scripts.wake;
    else stdout = scripts.probe;
    return { ok: stdout !== undefined, stdout: stdout ?? "", stderr: "" };
  });
}

const canary = { HIVRA_SLEEP_MODE: "canary" };
const run = (options: Parameters<typeof sleepHivraAgent>[1]) => sleepHivraAgent(AGENT_ID, { now, env: canary, ...options });


const statsLine = (over: Record<string, unknown> = {}) => `HIVRA_INGRESS_STATS ${JSON.stringify({
  ok: true, forwarder: true, vms: { [String(VMID)]: { route: true, inflight: 0, streams: 0, draining: false, last_any_at: null, last_authed_at: null, wakes: [], ...over } },
})}\n`;
const ingress = (over: Record<string, unknown> = {}) => ({
  kind: "row",
  state: { row: { generation: 2 }, hostIngress: true, acts: true, needsAwake: false, leaseHeld: false, ...over },
});
const oneConnector = [{ clientId: "c1", version: null, runAt: null, connections: 4 }];
const scriptsRun = () => mockRunScript.mock.calls.map((c) => String(c[0]));

describe("sleepHivraAgent with host ingress", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockReadRow.mockResolvedValue({ data: eligibleRow({ cf_tunnel_id: "22222222-2222-4222-8222-222222222222" }), error: null });
    mockHostRow.mockResolvedValue({ data: host, error: null });
    mockListRows.mockReturnValue({ data: [], error: null });
    mockUpdate.mockReturnValue(undefined);
    mockLapsed.mockResolvedValue(false);
    mockResolveTarget.mockResolvedValue({ ok: true, target });
    mockClaim.mockResolvedValue(4);
    mockFinish.mockResolvedValue(true);
    mockLogEvent.mockResolvedValue(true);
    mockConnectors.mockResolvedValue(oneConnector);
    mockLoadIngress.mockResolvedValue(ingress());
    stubScripts({ probe: probeLine() + statsLine(), sleep: sleepReceipt(), wake: wakeReceipt() });
  });

  it("naps with the host-ingress script and the proxy stats in the probe call", async () => {
    await expect(run({ tier: "nap", trigger: "sweep" })).resolves.toMatchObject({ outcome: "slept", state: "napping" });
    const [probe, sleep] = scriptsRun();
    expect(probe).toContain("ctl stats");
    expect(sleep).toContain("ingress_drain");
    expect(sleep).toContain("ingress_mark");
  });

  it("refuses a nap while a second connector is at the edge, and skips when the edge cannot be read", async () => {
    mockConnectors.mockResolvedValue([...oneConnector, { clientId: "c2", version: null, runAt: null, connections: 1 }]);
    await expect(run({ tier: "nap", trigger: "sweep" })).resolves.toMatchObject({ outcome: "not_idle", reason: "ingress_connectors" });
    mockConnectors.mockRejectedValue(new Error("edge"));
    await expect(run({ tier: "nap", trigger: "sweep" })).resolves.toMatchObject({ outcome: "skipped", reason: "ingress_connectors_unknown" });
    expect(mockRunScript).not.toHaveBeenCalled();
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("counts only connectors that hold connections", async () => {
    mockConnectors.mockResolvedValue([...oneConnector, { clientId: "c2", version: null, runAt: null, connections: 0 }]);
    await expect(run({ tier: "nap", trigger: "sweep" })).resolves.toMatchObject({ outcome: "slept" });
  });

  it("the kill switch: never naps a host-served agent ingress may not act on", async () => {
    mockLoadIngress.mockResolvedValue(ingress({ acts: false, needsAwake: true }));
    await expect(run({ tier: "nap", trigger: "sweep" })).resolves.toMatchObject({ outcome: "ineligible", reason: "ingress_needs_awake" });
    await expect(run({ tier: "hibernate", trigger: "sweep" })).resolves.toMatchObject({ outcome: "ineligible", reason: "ingress_needs_awake" });
    expect(mockRunScript).not.toHaveBeenCalled();
  });

  it("leaves the agent alone while an enable or rollback holds it, or when the row cannot be read", async () => {
    mockLoadIngress.mockResolvedValue(ingress({ leaseHeld: true, acts: false }));
    await expect(run({ tier: "nap", trigger: "sweep" })).resolves.toMatchObject({ outcome: "skipped", reason: "ingress_operation" });
    mockLoadIngress.mockResolvedValue({ kind: "error" });
    await expect(run({ tier: "nap", trigger: "sweep" })).resolves.toMatchObject({ outcome: "skipped", reason: "ingress_unreadable" });
    expect(mockRunScript).not.toHaveBeenCalled();
  });

  it("keeps the agent awake on proxy traffic or missing stats", async () => {
    stubScripts({ probe: probeLine() + statsLine({ streams: 1 }), sleep: sleepReceipt(), wake: wakeReceipt() });
    await expect(run({ tier: "nap", trigger: "sweep" })).resolves.toMatchObject({ outcome: "not_idle", reason: "ingress_active" });
    stubScripts({ probe: probeLine() + statsLine({ last_authed_at: (NOW - 60_000) / 1000 }), sleep: sleepReceipt(), wake: wakeReceipt() });
    await expect(run({ tier: "nap", trigger: "sweep" })).resolves.toMatchObject({ outcome: "not_idle", reason: "ingress_recent_use" });
    stubScripts({ probe: probeLine(), sleep: sleepReceipt(), wake: wakeReceipt() });
    await expect(run({ tier: "nap", trigger: "sweep" })).resolves.toMatchObject({ outcome: "skipped", reason: "ingress_stats_unavailable" });
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("aborts after its claim when an enable took the agent in the meantime, leaving the computer as it is", async () => {
    mockLoadIngress.mockResolvedValueOnce(ingress()).mockResolvedValueOnce(ingress({ leaseHeld: true, acts: false }));
    await expect(run({ tier: "nap", trigger: "sweep" })).resolves.toMatchObject({ outcome: "aborted", reason: "ingress_operation", state: "awake" });
    expect(mockFinish).toHaveBeenCalledWith(expect.objectContaining({ result: "awake" }));
    expect(scriptsRun().some((s) => s.includes("HIVRA_SLEEP_RESULT"))).toBe(false);
    // Also for an agent with no row before (the enable made it), and a row that can no longer be read.
    for (const again of [ingress({ leaseHeld: true, acts: false, hostIngress: false }), { kind: "error" }]) {
      mockRunScript.mockClear();
      mockLoadIngress.mockResolvedValueOnce({ kind: "none" }).mockResolvedValueOnce(again);
      stubScripts({ probe: probeLine(), sleep: sleepReceipt(), wake: wakeReceipt() });
      await expect(run({ tier: "nap", trigger: "sweep" })).resolves.toMatchObject({ outcome: "aborted" });
      expect(scriptsRun().some((s) => s.includes("HIVRA_SLEEP_RESULT"))).toBe(false);
    }
  });

  it("asks the proxy before it hibernates a napping computer, which its proxy may have resumed for a client", async () => {
    mockReadRow.mockResolvedValue({ data: eligibleRow({ sleep_state: "napping", cf_tunnel_id: "22222222-2222-4222-8222-222222222222" }), error: null });
    stubScripts({ probe: statsLine({ inflight: 1 }), sleep: sleepReceipt(), wake: wakeReceipt() });
    await expect(run({ tier: "hibernate", trigger: "sweep" })).resolves.toMatchObject({ outcome: "not_idle", reason: "ingress_active" });
    stubScripts({ probe: "", sleep: sleepReceipt(), wake: wakeReceipt() });
    await expect(run({ tier: "hibernate", trigger: "sweep" })).resolves.toMatchObject({ outcome: "skipped", reason: "ingress_stats_unavailable" });
    expect(mockClaim).not.toHaveBeenCalled();
    stubScripts({ probe: statsLine(), sleep: sleepReceipt({ tier: "hibernate", from: "napping", to: "hibernated", reason: "hibernated" }), wake: wakeReceipt() });
    await run({ tier: "hibernate", trigger: "sweep" });
    expect(scriptsRun()[0]).toContain("ctl stats");
    expect(mockClaim).toHaveBeenCalled();
  });

  it("recovers a lost receipt with the host-ingress wake script", async () => {
    stubScripts({ probe: probeLine() + statsLine(), sleep: "garbage", wake: wakeReceipt() });
    await run({ tier: "nap", trigger: "sweep" });
    const wake = scriptsRun().find((s) => s.includes("HIVRA_WAKE_RESULT"));
    expect(wake).toContain("ingress_unmark");
    expect(wake).not.toContain("hivra-cf-tunnel");
  });

  it("an agent with no ingress row sleeps exactly as before", async () => {
    mockLoadIngress.mockResolvedValue({ kind: "none" });
    stubScripts({ probe: probeLine(), sleep: sleepReceipt(), wake: wakeReceipt() });
    await expect(run({ tier: "nap", trigger: "sweep" })).resolves.toMatchObject({ outcome: "slept" });
    expect(mockConnectors).not.toHaveBeenCalled();
    expect(scriptsRun().some((s) => s.includes("ingress_"))).toBe(false);
  });
});

describe("ingressIdleBlocker", () => {
  const vm = { route: true, inflight: 0, streams: 0, draining: false, lastAnyAtMs: NOW, lastAuthedAtMs: null, wakes: [] };
  const opts = { manual: false, nowMs: NOW, idleWindowMs: 300_000 };
  it("ignores unauthenticated traffic and blocks on in-flight work or a recent verified use", () => {
    expect(ingressIdleBlocker(vm, opts)).toBeNull();
    expect(ingressIdleBlocker(null, opts)).toBe("ingress_stats_unavailable");
    expect(ingressIdleBlocker({ ...vm, inflight: 1 }, opts)).toBe("ingress_active");
    expect(ingressIdleBlocker({ ...vm, lastAuthedAtMs: NOW - 1000 }, opts)).toBe("ingress_recent_use");
    expect(ingressIdleBlocker({ ...vm, lastAuthedAtMs: NOW - 1000 }, { ...opts, manual: true })).toBeNull();
    expect(ingressIdleBlocker({ ...vm, lastAuthedAtMs: NOW - 400_000 }, opts)).toBeNull();
  });
});
