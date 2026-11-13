/** @jest-environment node */

// The sleep sweep's host-ingress step: the kill switch wakes host-served
// agents that ingress may not act on, and a proxy wake is reconciled to awake
// within one sweep, from one SSH call per host.

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

type Result = { data?: unknown; error?: unknown };
interface Call {
  table: string;
  ops: Array<[string, unknown[]]>;
}
const mockCalls: Call[] = [];
const mockTables: { fn: (call: Call) => Result } = { fn: () => ({ data: [], error: null }) };
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from(table: string) {
      const call: Call = { table, ops: [] };
      mockCalls.push(call);
      const builder: Record<string, unknown> = {
        then(resolve: (value: Result) => unknown, reject: (reason: unknown) => unknown) {
          return Promise.resolve(mockTables.fn(call)).then(resolve, reject);
        },
      };
      for (const op of ["select", "eq", "neq", "in", "not", "is", "or", "lt", "lte", "gte", "order", "limit"]) {
        builder[op] = (...args: unknown[]) => {
          call.ops.push([op, args]);
          return builder;
        };
      }
      return builder;
    },
  },
}));

const mockRunScript = jest.fn();
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  runProxmoxHostScript: (...args: unknown[]) => mockRunScript(...args),
}));
jest.mock("../../agent-sleep", () => ({
  SCHEDULED_WAKE_LEAD_SECONDS: 120,
  resolveSleepTimings: () => ({ napAfterSeconds: 300, hibernateAfterSeconds: 900, horizonSeconds: 1200 }),
  sleepHivraAgent: jest.fn(),
}));
jest.mock("../../sleep-aware", () => ({ markAgentAwake: jest.fn() }));

const mockEnsure = jest.fn();
const mockTarget = jest.fn();
jest.mock("../../agent-wake", () => ({
  ensureHivraAgentAwake: (...args: unknown[]) => mockEnsure(...args),
  pollPublicHealthz: jest.fn(),
  resolveSleepTarget: (...args: unknown[]) => mockTarget(...args),
}));

const mockLogEvent = jest.fn();
const mockReconcileState = jest.fn();
jest.mock("../../agent-sleep-store", () => ({
  reconcileAgentSleepState: (...args: unknown[]) => mockReconcileState(...args),
  parseSleepGeneration: (value: unknown) => (typeof value === "number" ? value : null),
  finishAgentSleep: jest.fn(),
  finishAgentWake: jest.fn(),
  logAgentSleepEvent: (...args: unknown[]) => mockLogEvent(...args),
}));

const mockDisarm = jest.fn();
const mockSettle = jest.fn();
jest.mock("../../channel-wake/lifecycle", () => ({
  disarmChannelsForWake: (...args: unknown[]) => mockDisarm(...args),
  settleChannelsAfterWake: (...args: unknown[]) => mockSettle(...args),
}));

import { resetSleepSweepCooldowns, runSleepIdleSweep } from "../../sleep-idle-sweep";

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const MIN = 60_000;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const ingressRow = (n: number, over: Record<string, unknown> = {}) => ({
  agent_id: id(n), vmid: 1100 + n, host_id: "host_a", mode: "host", phase: "cutover", metrics_port: 21000 + n,
  generation: 2, last_error: null, lease_id: null, lease_expires_at: null, updated_at: null, ...over,
});
const agent = (n: number, over: Record<string, unknown> = {}) => ({
  id: id(n), vmid: 1100 + n, proxmox_host: "host_a", status: "running", desired_state: "running", operation_id: null,
  sleep_state: "napping", sleep_generation: 7, sleep_tier_changed_at: iso(10 * MIN), ...over,
});

function tables(input: { ingress: unknown[]; agents: unknown[]; hostMode?: string }) {
  mockTables.fn = (call) => {
    if (call.table === "hivra_agent_ingress") return { data: input.ingress, error: null };
    if (call.table === "proxmox_hosts") return { data: [{ id: "host_a", ingress_mode: input.hostMode ?? "canary", status: "active", sleep_mode: "off" }], error: null };
    if (call.table === "hivra_agents" && call.ops.some(([op, args]) => op === "in" && args[0] === "id")) {
      return { data: input.agents, error: null };
    }
    return { data: [], error: null };
  };
}

const proxyOutput = (vms: Record<string, unknown>, markers: Record<number, 0 | 1>) =>
  `\nHIVRA_INGRESS_STATS ${JSON.stringify({ ok: true, forwarder: true, vms })}\n${Object.entries(markers)
    .map(([vmid, m]) => `HIVRA_INGRESS_MARKER ${vmid} ${m}`).join("\n")}\n`;
const vmStats = (wakes: unknown[]) => ({ route: true, inflight: 0, streams: 0, draining: false, last_any_at: null, last_authed_at: null, wakes });

const sweep = (env: Record<string, string>) =>
  runSleepIdleSweep({ env: { HIVRA_SLEEP_MODE: "off", ...env }, now: () => NOW, budgetMs: 50_000 });

beforeEach(() => {
  jest.clearAllMocks();
  mockCalls.length = 0;
  resetSleepSweepCooldowns();
  mockEnsure.mockResolvedValue({ state: "awake" });
  mockTarget.mockResolvedValue({ ok: true, target: { env: { host: "x" }, vmid: 1101, bindingTag: "t" } });
  mockReconcileState.mockResolvedValue(true);
  mockLogEvent.mockResolvedValue(true);
  mockDisarm.mockResolvedValue({ telegram: null, generic: [], killStaleSockets: false, ms: 1 });
  mockSettle.mockResolvedValue(undefined);
});

describe("host ingress sweep step", () => {
  it("does nothing and reads nothing when host ingress was never configured", async () => {
    tables({ ingress: [ingressRow(1)], agents: [agent(1)] });
    const summary = await sweep({});
    expect(summary.ingress).toBeUndefined();
    expect(mockCalls.some((c) => c.table === "hivra_agent_ingress")).toBe(false);
  });

  it("reconciles a proxy wake to awake within one sweep, with one SSH call for the host", async () => {
    tables({ ingress: [ingressRow(1), ingressRow(2)], agents: [agent(1), agent(2)] });
    mockRunScript.mockResolvedValue({
      ok: true,
      stdout: proxyOutput({
        "1101": vmStats([{ at: (NOW - 2 * MIN) / 1000, from: "ticket", woke: "nap", ms: 12 }]),
        // A wake from before the nap does not count.
        "1102": vmStats([{ at: (NOW - 20 * MIN) / 1000, from: "ticket", woke: "nap", ms: 12 }]),
      }, { 1101: 0, 1102: 0 }),
      stderr: "",
    });
    const summary = await sweep({ HIVRA_HOST_INGRESS: "canary" });
    expect(mockRunScript).toHaveBeenCalledTimes(1);
    expect(String(mockRunScript.mock.calls[0][0])).toContain("for VMID in 1101 1102; do");
    expect(mockReconcileState).toHaveBeenCalledTimes(1);
    expect(mockReconcileState).toHaveBeenCalledWith({ agentId: id(1), expectedGeneration: 7, to: "awake" });
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ agentId: id(1), kind: "wake", trigger: "ingress", toState: "awake" }));
    expect(mockDisarm).toHaveBeenCalledWith(id(1));
    expect(summary.ingress).toMatchObject({ hostsRead: 1, reconciled: 1, killSwitchWakes: 0 });
  });

  it("leaves a record alone while its marker is still there or the proxy did not answer", async () => {
    tables({ ingress: [ingressRow(1)], agents: [agent(1)] });
    const wake = [{ at: (NOW - MIN) / 1000, from: "ticket", woke: "nap", ms: 5 }];
    mockRunScript.mockResolvedValueOnce({ ok: true, stdout: proxyOutput({ "1101": vmStats(wake) }, { 1101: 1 }), stderr: "" });
    await sweep({ HIVRA_HOST_INGRESS: "canary" });
    mockRunScript.mockResolvedValueOnce({ ok: false, stdout: "", stderr: "x" });
    await sweep({ HIVRA_HOST_INGRESS: "canary" });
    expect(mockReconcileState).not.toHaveBeenCalled();
  });

  it("the kill switch wakes host-served sleepers and never reads the proxy for them", async () => {
    tables({ ingress: [ingressRow(1), ingressRow(2, { phase: "failed" })], agents: [agent(1), agent(2, { sleep_state: "hibernated" })] });
    const summary = await sweep({ HIVRA_HOST_INGRESS: "off" });
    expect(mockEnsure).toHaveBeenCalledWith(id(1), expect.objectContaining({ trigger: "ingress" }));
    expect(mockEnsure).toHaveBeenCalledWith(id(2), expect.objectContaining({ trigger: "ingress" }));
    expect(mockRunScript).not.toHaveBeenCalled();
    expect(summary.ingress).toMatchObject({ killSwitchWakes: 2 });
    // Not again on the next run while the first wake may still be settling.
    mockEnsure.mockClear();
    await sweep({ HIVRA_HOST_INGRESS: "off" });
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it("the host's own switch off works the same as the server's", async () => {
    tables({ ingress: [ingressRow(1)], agents: [agent(1)], hostMode: "off" });
    await sweep({ HIVRA_HOST_INGRESS: "on" });
    expect(mockEnsure).toHaveBeenCalledWith(id(1), expect.objectContaining({ trigger: "ingress" }));
  });

  it("asks only for host-mode rows", async () => {
    tables({ ingress: [], agents: [] });
    await sweep({ HIVRA_HOST_INGRESS: "canary" });
    const call = mockCalls.find((c) => c.table === "hivra_agent_ingress");
    expect(call?.ops).toEqual(expect.arrayContaining([["neq", ["mode", "guest"]]]));
  });
});
