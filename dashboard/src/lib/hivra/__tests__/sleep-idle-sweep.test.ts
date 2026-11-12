/** @jest-environment node */

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

type Result = { data?: unknown; error?: unknown };
interface Call {
  table: string;
  ops: Array<[string, unknown[]]>;
}
const mockCalls: Call[] = [];
const mockResolve: { fn: (call: Call) => Result } = { fn: () => ({ data: [], error: null }) };
const mockDb: { value: unknown } = {
  value: {
    from(table: string) {
      const call: Call = { table, ops: [] };
      mockCalls.push(call);
      const builder: Record<string, unknown> = {
        then(resolve: (value: Result) => unknown, reject: (reason: unknown) => unknown) {
          return Promise.resolve(mockResolve.fn(call)).then(resolve, reject);
        },
      };
      for (const op of ["select", "eq", "in", "not", "is", "or", "lt", "lte", "gte", "order", "limit"]) {
        builder[op] = (...args: unknown[]) => {
          call.ops.push([op, args]);
          return builder;
        };
      }
      return builder;
    },
  },
};
jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockDb.value;
  },
}));

const mockRunScript = jest.fn();
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  runProxmoxHostScript: (...args: unknown[]) => mockRunScript(...args),
}));

const mockSleep = jest.fn();
jest.mock("../agent-sleep", () => ({
  SCHEDULED_WAKE_LEAD_SECONDS: 120,
  resolveSleepTimings: () => ({ napAfterSeconds: 300, hibernateAfterSeconds: 900, horizonSeconds: 1200 }),
  sleepHivraAgent: (...args: unknown[]) => mockSleep(...args),
}));

const mockEnsure = jest.fn();
const mockHealthz = jest.fn();
const mockTarget = jest.fn();
jest.mock("../agent-wake", () => ({
  ensureHivraAgentAwake: (...args: unknown[]) => mockEnsure(...args),
  pollPublicHealthz: (...args: unknown[]) => mockHealthz(...args),
  resolveSleepTarget: (...args: unknown[]) => mockTarget(...args),
}));

const mockFinishSleep = jest.fn();
const mockFinishWake = jest.fn();
const mockLogEvent = jest.fn();
jest.mock("../agent-sleep-store", () => ({
  finishAgentSleep: (...args: unknown[]) => mockFinishSleep(...args),
  finishAgentWake: (...args: unknown[]) => mockFinishWake(...args),
  logAgentSleepEvent: (...args: unknown[]) => mockLogEvent(...args),
}));

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildSleepStateHostScript,
  parseSleepStateReceipt,
  resetSleepSweepCooldowns,
  runSleepIdleSweep,
  staleLeaseResult,
  HOST_WORK_CAP,
  NOT_IDLE_COOLDOWN_MS,
} from "../sleep-idle-sweep";
import { AWAKE, COLD, HIBERNATED, NAPPING, TAG, VMID, makeHostHarness, type HostHarness, type HostState } from "./sleep-stub-host.fixtures";

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);
const now = () => NOW;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const hostsTable = (rows: Array<Record<string, unknown>>) => rows.map((r) => ({ status: "active", ...r }));
const opsOf = (call: Call, name: string) => call.ops.filter(([op]) => op === name).map(([, args]) => args);
const hasOp = (call: Call, name: string, ...args: unknown[]) =>
  opsOf(call, name).some((a) => JSON.stringify(a) === JSON.stringify(args));
const callsFor = (table: string) => mockCalls.filter((c) => c.table === table);

type Tables = Partial<{
  wakes: Result;
  leases: Result;
  hosts: Result;
  hibernate: Result;
  nap: Result;
  events: Result;
  activity: Result;
}>;

/** Routes each query to a canned result by what it asks for. */
function setTables(tables: Tables) {
  mockResolve.fn = (call) => {
    const empty: Result = { data: [], error: null };
    if (call.table === "proxmox_hosts") return tables.hosts ?? empty;
    if (call.table === "hivra_agent_events") return tables.events ?? empty;
    if (call.table === "hivra_agent_activity") return tables.activity ?? empty;
    if (call.table === "hivra_agents") {
      if (hasOp(call, "in", "operation_kind", ["sleep", "wake"])) return tables.leases ?? empty;
      if (opsOf(call, "lte").some((a) => a[0] === "next_wake_at")) return tables.wakes ?? empty;
      if (hasOp(call, "eq", "sleep_state", "napping")) return tables.hibernate ?? empty;
      if (hasOp(call, "eq", "sleep_state", "awake")) return tables.nap ?? empty;
    }
    return empty;
  };
}

const run = (env: Record<string, string | undefined> = { HIVRA_SLEEP_MODE: "canary" }, extra = {}) =>
  runSleepIdleSweep({ env, now, ...extra });

const outcome = (over: Record<string, unknown> = {}) => ({ outcome: "slept", state: "napping", ...over });

beforeEach(() => {
  jest.clearAllMocks();
  mockCalls.length = 0;
  resetSleepSweepCooldowns();
  setTables({});
  mockSleep.mockResolvedValue(outcome());
  mockEnsure.mockResolvedValue({ state: "awake" });
  mockHealthz.mockResolvedValue({ up: true, ms: 10, attempts: 1 });
  mockFinishSleep.mockResolvedValue(true);
  mockFinishWake.mockResolvedValue(true);
  mockLogEvent.mockResolvedValue(true);
  mockRunScript.mockResolvedValue({ ok: true, stdout: "" });
  mockTarget.mockResolvedValue({ ok: true, target: { vmid: VMID, bindingTag: TAG, env: { host: "h" } } });
});

describe("runSleepIdleSweep: switches", () => {
  it.each([undefined, "", "off", "nonsense"])("never sleeps anything, and reads only sleepers, when HIVRA_SLEEP_MODE is %p", async (mode) => {
    const summary = await run({ HIVRA_SLEEP_MODE: mode });
    expect(summary).toMatchObject({ skipped: true, reason: "sleep_mode_off", errors: 0 });
    // Only the two recovery reads: agents due a wake, and stale leases. Never hosts or candidates.
    expect(mockCalls.every((c) => c.table === "hivra_agents")).toBe(true);
    expect(callsFor("proxmox_hosts")).toHaveLength(0);
    expect(mockSleep).not.toHaveBeenCalled();
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it("only logs in observe mode: no sleeps", async () => {
    const summary = await run({ HIVRA_SLEEP_MODE: "observe" });
    expect(summary).toMatchObject({ skipped: true, reason: "observe_mode_only" });
    expect(callsFor("proxmox_hosts")).toHaveLength(0);
    expect(mockSleep).not.toHaveBeenCalled();
  });

  it.each(["off", "observe"])("still wakes a due agent and settles a stale lease in %s mode, so switching it off strands nothing", async (mode) => {
    setTables({
      wakes: { data: [{ id: id(1), sleep_state: "napping", sleep_tier_changed_at: iso(10 * MIN), next_wake_at: iso(0) }] },
      leases: { data: [{ id: id(2), user_id: "u", vmid: VMID, cf_hostname: "agent-one.example.test", operation_id: "op-9",
        operation_kind: "sleep", operation_started_at: iso(15 * MIN), sleep_state: "draining" }] },
    });
    mockRunScript.mockResolvedValue({ ok: true, stdout: `HIVRA_SLEEP_STATE ${JSON.stringify({ ok: true, vmid: VMID, observed: "napping", reason: "observed", unit_active: false })}\n` });
    const summary = await run({ HIVRA_SLEEP_MODE: mode });
    expect(mockEnsure).toHaveBeenCalledWith(id(1), expect.objectContaining({ trigger: "schedule" }));
    expect(mockFinishSleep).toHaveBeenCalledWith({ agentId: id(2), operationId: "op-9", result: "napping" });
    expect(summary).toMatchObject({ skipped: true, wakes: { due: 1 }, leases: { settled: 1 } });
    expect(mockSleep).not.toHaveBeenCalled();
  });

  it("reports an unavailable database as a skipped run with an error", async () => {
    const saved = mockDb.value;
    mockDb.value = null;
    try {
      expect(await run()).toMatchObject({ skipped: true, reason: "supabase_unavailable", errors: 1 });
    } finally {
      mockDb.value = saved;
    }
  });

  it("does nothing at all on a canary run with no hosts that act", async () => {
    setTables({ hosts: { data: hostsTable([{ id: "a", sleep_mode: "off" }]) } });
    const summary = await run();
    expect(summary.nap.candidates).toBe(0);
    expect(callsFor("hivra_agents").some((c) => hasOp(c, "eq", "sleep_state", "awake"))).toBe(false);
    expect(mockSleep).not.toHaveBeenCalled();
  });
});

describe("step 1: scheduled wakes", () => {
  it("wakes agents due within two minutes, with trigger schedule", async () => {
    setTables({
      wakes: {
        data: [
          { id: id(1), sleep_state: "napping", sleep_tier_changed_at: iso(10 * MIN), next_wake_at: iso(-MIN) },
          { id: id(2), sleep_state: "hibernated", sleep_tier_changed_at: iso(30 * MIN), next_wake_at: iso(0) },
        ],
      },
    });
    mockEnsure.mockResolvedValueOnce({ state: "awake" }).mockResolvedValueOnce({ state: "waking" });
    const summary = await run();
    const query = callsFor("hivra_agents")[0];
    expect(hasOp(query, "eq", "status", "running")).toBe(true);
    // The back-off for failed wakes is part of the query, so those rows cannot crowd out newer ones.
    expect(opsOf(query, "or").some((a) => String(a[0]).startsWith("sleep_state.neq.wake_failed,sleep_tier_changed_at.lte."))).toBe(true);
    expect(hasOp(query, "lte", "next_wake_at", new Date(NOW + 2 * MIN).toISOString())).toBe(true);
    expect(mockEnsure).toHaveBeenCalledTimes(2);
    expect(mockEnsure).toHaveBeenCalledWith(id(1), expect.objectContaining({ trigger: "schedule" }));
    expect(summary.wakes).toEqual({ due: 2, awake: 1, waking: 1, failed: 0, cold: 0 });
  });

  it("counts failed and cold wakes, and a wake that throws", async () => {
    setTables({
      wakes: {
        data: [1, 2, 3].map((n) => ({ id: id(n), sleep_state: "napping", sleep_tier_changed_at: null, next_wake_at: iso(0) })),
      },
    });
    mockEnsure
      .mockResolvedValueOnce({ state: "failed", reason: "lapsed" })
      .mockResolvedValueOnce({ state: "cold" })
      .mockRejectedValueOnce(new Error("boom"));
    const summary = await run();
    expect(summary.wakes).toMatchObject({ due: 3, failed: 2, cold: 1 });
    expect(summary.errors).toBe(1);
  });

  it("retries a failed wake only after the back-off", async () => {
    setTables({
      wakes: {
        data: [
          { id: id(1), sleep_state: "wake_failed", sleep_tier_changed_at: iso(2 * MIN), next_wake_at: iso(0) },
          { id: id(2), sleep_state: "wake_failed", sleep_tier_changed_at: iso(6 * MIN), next_wake_at: iso(0) },
          { id: id(3), sleep_state: "wake_failed", sleep_tier_changed_at: null, next_wake_at: iso(0) },
        ],
      },
    });
    await run();
    expect(mockEnsure.mock.calls.map((c) => c[0])).toEqual([id(2)]);
  });

  it("carries on to the later steps when the wake query fails", async () => {
    setTables({ wakes: { error: { message: "down" } }, hosts: { data: hostsTable([{ id: "local", sleep_mode: "canary" }]) } });
    const summary = await run();
    expect(summary.errors).toBe(1);
    expect(callsFor("proxmox_hosts")).toHaveLength(1);
  });
});

describe("staleLeaseResult", () => {
  it.each([
    ["sleep", "napping", true, "napping"],
    ["sleep", "hibernated", true, "hibernated"],
    ["sleep", "awake", true, "awake"],
    ["sleep", "cold", true, "awake"],
    ["sleep", "unknown", true, null],
    ["wake", "awake", true, "awake"],
    ["wake", "awake", false, "wake_failed"],
    ["wake", "napping", true, "wake_failed"],
    ["wake", "hibernated", true, "wake_failed"],
    ["wake", "cold", false, "awake"],
    ["wake", "unknown", true, null],
  ] as const)("%s lease, host %s, healthz %s gives %s", (kind, observed, up, expected) => {
    expect(staleLeaseResult(kind, observed, up)).toBe(expected);
  });
});

describe("step 2: stale lease recovery", () => {
  const lease = (over: Record<string, unknown> = {}) => ({
    id: id(1),
    user_id: "user-1",
    vmid: VMID,
    cf_hostname: "agent-one.example.test",
    operation_id: "op-1",
    operation_kind: "sleep",
    operation_started_at: iso(15 * MIN),
    sleep_state: "draining",
    ...over,
  });
  const stateLine = (observed: string, extra: Record<string, unknown> = {}) => ({
    ok: observed !== "unknown",
    stdout: `HIVRA_SLEEP_STATE ${JSON.stringify({ ok: observed !== "unknown", vmid: VMID, observed, reason: "observed", unit_active: false, ...extra })}\n`,
  });

  it("asks only for sleep and wake leases older than six minutes", async () => {
    setTables({ leases: { data: [] } });
    await run();
    const query = callsFor("hivra_agents").find((c) => hasOp(c, "in", "operation_kind", ["sleep", "wake"]))!;
    expect(hasOp(query, "lt", "operation_started_at", iso(6 * MIN))).toBe(true);
  });

  it("steps past a lease it had to leave, so the ones behind it still get settled", async () => {
    const stuck = lease({ id: id(1), operation_id: "op-stuck" });
    const next = lease({ id: id(2), operation_id: "op-next" });
    setTables({ leases: { data: [stuck, next] } });
    mockRunScript.mockImplementation(async (script: string) =>
      String(script).includes("VMID=") ? { ok: true, stdout: `HIVRA_SLEEP_STATE ${JSON.stringify({ ok: true, vmid: VMID, observed: "napping", reason: "observed", unit_active: true })}\n` } : { ok: true, stdout: "" });
    const first = await run();
    expect(first.leases).toMatchObject({ stale: 2, settled: 0, left: 2 });
    mockRunScript.mockClear();
    const second = await run();
    // Both are cooling down, so nothing is read again this soon.
    expect(second.leases).toMatchObject({ stale: 0 });
    expect(mockRunScript).not.toHaveBeenCalled();
  });

  it("finishes a stale sleep lease to the observed tier and logs a reconcile event", async () => {
    setTables({ leases: { data: [lease()] } });
    mockRunScript.mockResolvedValue(stateLine("napping"));
    const summary = await run();
    expect(mockFinishSleep).toHaveBeenCalledWith({ agentId: id(1), operationId: "op-1", result: "napping" });
    expect(mockFinishWake).not.toHaveBeenCalled();
    expect(summary.leases).toEqual({ stale: 1, settled: 1, left: 0 });
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: id(1),
        kind: "reconcile",
        trigger: "reconcile",
        toState: "napping",
        reason: "stale_sleep_lease",
        detail: expect.objectContaining({ host_state: "napping", age_s: 900 }),
      }),
    );
  });

  it.each([
    ["hibernated", "hibernated"],
    ["awake", "awake"],
  ])("settles a stale sleep lease on a %s host as %s", async (observed, result) => {
    setTables({ leases: { data: [lease()] } });
    mockRunScript.mockResolvedValue(stateLine(observed));
    await run();
    expect(mockFinishSleep).toHaveBeenCalledWith(expect.objectContaining({ result }));
  });

  it("finishes a stale wake lease as awake only when the public check answers", async () => {
    setTables({ leases: { data: [lease({ operation_kind: "wake", sleep_state: "waking" })] } });
    mockRunScript.mockResolvedValue(stateLine("awake"));
    await run();
    expect(mockFinishWake).toHaveBeenCalledWith({ agentId: id(1), operationId: "op-1", result: "awake" });

    mockFinishWake.mockClear();
    mockHealthz.mockResolvedValue({ up: false, ms: 5000, attempts: 5 });
    await run();
    expect(mockFinishWake).toHaveBeenCalledWith({ agentId: id(1), operationId: "op-1", result: "wake_failed" });
  });

  it("leaves a lease whose hibernate unit is still active", async () => {
    setTables({ leases: { data: [lease()] } });
    mockRunScript.mockResolvedValue(stateLine("hibernated", { unit_active: true }));
    const summary = await run();
    expect(mockFinishSleep).not.toHaveBeenCalled();
    expect(summary.leases).toEqual({ stale: 1, settled: 0, left: 1 });
  });

  it.each([
    ["garbage output", { ok: true, stdout: "nothing useful" }],
    ["an unreadable state", stateLine("unknown", { reason: "unexpected_state" })],
    ["a vmid that is not the agent's", { ok: true, stdout: `HIVRA_SLEEP_STATE {"ok":true,"vmid":999,"observed":"awake","reason":"observed","unit_active":false}\n` }],
  ])("leaves the lease for %s", async (_name, result) => {
    setTables({ leases: { data: [lease()] } });
    mockRunScript.mockResolvedValue(result);
    const summary = await run();
    expect(mockFinishSleep).not.toHaveBeenCalled();
    expect(mockFinishWake).not.toHaveBeenCalled();
    expect(summary.leases.left).toBe(1);
  });

  it("leaves the lease when the host script throws or the target cannot be resolved or has no tag", async () => {
    setTables({ leases: { data: [lease()] } });
    mockRunScript.mockRejectedValue(new Error("ssh down"));
    expect((await run()).leases.left).toBe(1);

    resetSleepSweepCooldowns();
    mockTarget.mockResolvedValue({ ok: false, code: "no_computer" });
    expect((await run()).leases.left).toBe(1);

    resetSleepSweepCooldowns();
    mockTarget.mockResolvedValue({ ok: true, target: { vmid: VMID, bindingTag: null, env: {} } });
    mockRunScript.mockClear();
    expect((await run()).leases.left).toBe(1);
    expect(mockRunScript).not.toHaveBeenCalled();
    expect(mockFinishSleep).not.toHaveBeenCalled();
  });

  it("does not log a reconcile event when the finish was not recorded", async () => {
    setTables({ leases: { data: [lease()] } });
    mockRunScript.mockResolvedValue(stateLine("napping"));
    mockFinishSleep.mockResolvedValue(false);
    const summary = await run();
    expect(summary.leases).toEqual({ stale: 1, settled: 0, left: 1 });
    expect(mockLogEvent).not.toHaveBeenCalled();
  });
});

describe("steps 3 and 4: hibernate and nap", () => {
  const hosts = (over: Array<Record<string, unknown>> = [{ id: "local", sleep_mode: "canary" }]) => ({ data: hostsTable(over) });
  const rows = (ids: number[], host: string | null = null) => ids.map((n) => ({ id: id(n), proxmox_host: host }));

  it("hibernates agents that have napped past the window, with trigger sweep", async () => {
    setTables({ hosts: hosts(), hibernate: { data: rows([1]) } });
    mockSleep.mockResolvedValue(outcome({ state: "hibernated" }));
    const summary = await run();
    const query = callsFor("hivra_agents").find((c) => hasOp(c, "eq", "sleep_state", "napping"))!;
    expect(hasOp(query, "lte", "sleep_tier_changed_at", iso(900_000))).toBe(true);
    expect(hasOp(query, "is", "operation_id", null)).toBe(true);
    expect(hasOp(query, "eq", "always_on", false)).toBe(true);
    expect(mockSleep).toHaveBeenCalledWith(id(1), expect.objectContaining({ tier: "hibernate", trigger: "sweep" }));
    expect(summary.hibernate).toMatchObject({ candidates: 1, attempted: 1, slept: 1 });
  });

  it("uses the hibernate window from the timings", async () => {
    setTables({ hosts: hosts(), hibernate: { data: [] } });
    await run();
    const query = callsFor("hivra_agents").find((c) => hasOp(c, "eq", "sleep_state", "napping"))!;
    expect(opsOf(query, "lte")[0][0]).toBe("sleep_tier_changed_at");
  });

  it("filters by policy in canary mode and not in on mode", async () => {
    setTables({ hosts: hosts() });
    await run({ HIVRA_SLEEP_MODE: "canary" });
    const canaryNap = callsFor("hivra_agents").find((c) => hasOp(c, "eq", "sleep_state", "awake"))!;
    const canaryHib = callsFor("hivra_agents").find((c) => hasOp(c, "eq", "sleep_state", "napping"))!;
    expect(hasOp(canaryNap, "in", "sleep_policy", ["t1", "full"])).toBe(true);
    expect(hasOp(canaryHib, "in", "sleep_policy", ["t3", "full"])).toBe(true);

    mockCalls.length = 0;
    await run({ HIVRA_SLEEP_MODE: "on" });
    const onNap = callsFor("hivra_agents").find((c) => hasOp(c, "eq", "sleep_state", "awake"))!;
    const onHib = callsFor("hivra_agents").find((c) => hasOp(c, "eq", "sleep_state", "napping"))!;
    expect(opsOf(onNap, "in").some((a) => a[0] === "sleep_policy")).toBe(false);
    expect(opsOf(onHib, "in").some((a) => a[0] === "sleep_policy")).toBe(false);
    // Always-on agents are never candidates, in either mode.
    expect(hasOp(onNap, "eq", "always_on", false)).toBe(true);
  });

  it("builds the cheap nap prefilter from the database columns", async () => {
    setTables({ hosts: hosts() });
    await run();
    const query = callsFor("hivra_agents").find((c) => hasOp(c, "eq", "sleep_state", "awake"))!;
    for (const [op, ...args] of [
      ["eq", "status", "running"],
      ["eq", "desired_state", "running"],
      ["is", "operation_id", null],
      ["eq", "deployment_mode", "hivra-managed"],
      ["eq", "computer_substrate", "proxmox-kvm"],
      ["is", "deployment_target_id", null],
      ["not", "cf_hostname", "is", null],
      ["not", "vmid", "is", null],
      ["not", "bootstrapped_at", "is", null],
      ["not", "type", "in", "(aeon,linux-desktop)"],
    ] as const) {
      expect(hasOp(query, op, ...args)).toBe(true);
    }
    // No wake or other change inside the nap window.
    expect(hasOp(query, "or", `sleep_tier_changed_at.is.null,sleep_tier_changed_at.lte.${iso(300_000)}`)).toBe(true);
  });

  it("drops agents with an event or a reported use inside the nap window", async () => {
    setTables({
      hosts: hosts(),
      nap: { data: rows([1, 2, 3, 4]) },
      events: { data: [{ agent_id: id(1) }] },
      activity: {
        data: [
          { agent_id: id(2), last_used_at: iso(MIN) },
          { agent_id: id(3), last_used_at: iso(2 * 3600_000) },
        ],
      },
    });
    const summary = await run();
    const slept = mockSleep.mock.calls.map((c) => c[0]).sort();
    expect(slept).toEqual([id(3), id(4)]);
    expect(summary.nap.candidates).toBe(2);
    const events = callsFor("hivra_agent_events")[0];
    expect(hasOp(events, "gte", "created_at", iso(300_000))).toBe(true);
  });

  it("treats a failed events or activity read as busy, never as idle", async () => {
    setTables({ hosts: hosts(), nap: { data: rows([1, 2]) }, events: { error: { message: "down" } } });
    let summary = await run();
    expect(mockSleep).not.toHaveBeenCalled();
    expect(summary.errors).toBeGreaterThan(0);

    setTables({ hosts: hosts(), nap: { data: rows([1, 2]) }, activity: { error: { message: "down" } } });
    summary = await run();
    expect(mockSleep).not.toHaveBeenCalled();
    expect(summary.errors).toBeGreaterThan(0);
  });

  it("only works on hosts that act, and skips a host in maintenance", async () => {
    setTables({
      hosts: hosts([
        { id: "on-host", sleep_mode: "on" },
        { id: "canary-host", sleep_mode: "canary" },
        { id: "off-host", sleep_mode: "off" },
        { id: "observe-host", sleep_mode: "observe" },
        { id: "maint-host", sleep_mode: "on", status: "maintenance" },
        { id: "null-host", sleep_mode: null },
      ]),
      nap: {
        data: [
          { id: id(1), proxmox_host: "on-host" },
          { id: id(2), proxmox_host: "canary-host" },
          { id: id(3), proxmox_host: "off-host" },
          { id: id(4), proxmox_host: "observe-host" },
          { id: id(5), proxmox_host: "maint-host" },
          { id: id(6), proxmox_host: "null-host" },
          { id: id(7), proxmox_host: "unknown-host" },
        ],
      },
    });
    await run();
    expect(mockSleep.mock.calls.map((c) => c[0]).sort()).toEqual([id(1), id(2)]);
  });

  it("sends an agent with no host of its own to the default host", async () => {
    setTables({ hosts: hosts([{ id: "local", sleep_mode: "canary" }]), nap: { data: rows([1], null) } });
    await run({ HIVRA_SLEEP_MODE: "canary", HIVRA_PROXMOX_HOST: undefined });
    expect(mockSleep).toHaveBeenCalledTimes(1);
  });

  it("caps work per host at three and runs hosts in parallel", async () => {
    expect(HOST_WORK_CAP).toBe(3);
    const a = [1, 2, 3, 4, 5].map((n) => ({ id: id(n), proxmox_host: "host-a" }));
    const b = [6, 7, 8, 9, 10].map((n) => ({ id: id(n), proxmox_host: "host-b" }));
    setTables({
      hosts: hosts([{ id: "host-a", sleep_mode: "canary" }, { id: "host-b", sleep_mode: "on" }]),
      nap: { data: [...a, ...b] },
    });
    let running = 0;
    let peak = 0;
    mockSleep.mockImplementation(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return outcome();
    });
    const summary = await run();
    expect(mockSleep).toHaveBeenCalledTimes(6);
    expect(summary.nap).toMatchObject({ attempted: 6, slept: 6 });
    // One at a time within a host, both hosts at once.
    expect(peak).toBe(2);
  });

  it("does not spend the work cap on agents that turn out ineligible or are refused before the host", async () => {
    setTables({
      hosts: hosts(),
      nap: { data: rows([1, 2, 3, 4, 5, 6]) },
    });
    const results = [
      { outcome: "ineligible", reason: "always_on" },
      { outcome: "skipped", reason: "claim_refused" },
      { outcome: "ineligible", reason: "kind_aeon" },
      outcome(),
      outcome(),
      outcome(),
    ];
    mockSleep.mockImplementation(async () => results.shift());
    const summary = await run();
    expect(mockSleep).toHaveBeenCalledTimes(6);
    expect(summary.nap).toMatchObject({ ineligible: 2, skipped: 1, slept: 3 });
  });

  it("counts a probe that could not run as host work", async () => {
    setTables({ hosts: hosts(), nap: { data: rows([1, 2, 3, 4, 5]) } });
    mockSleep.mockResolvedValue({ outcome: "skipped", reason: "probe_unavailable" });
    const summary = await run();
    expect(mockSleep).toHaveBeenCalledTimes(3);
    expect(summary.nap.skipped).toBe(3);
  });

  it("does hibernates first, and they share the host cap with naps", async () => {
    setTables({
      hosts: hosts(),
      hibernate: { data: rows([1, 2]) },
      nap: { data: rows([3, 4, 5]) },
    });
    const order: string[] = [];
    mockSleep.mockImplementation(async (agent: string, options: { tier: string }) => {
      order.push(`${options.tier}:${agent}`);
      return outcome();
    });
    const summary = await run();
    expect(order.slice(0, 2)).toEqual([`hibernate:${id(1)}`, `hibernate:${id(2)}`]);
    expect(order).toHaveLength(3);
    expect(order[2].startsWith("nap:")).toBe(true);
    expect(summary.hibernate.attempted).toBe(2);
    expect(summary.nap.attempted).toBe(1);
  });

  it("counts a busy agent as kept awake and does not probe it again inside the cool-down", async () => {
    setTables({ hosts: hosts(), nap: { data: rows([1]) } });
    mockSleep.mockResolvedValue({ outcome: "not_idle", reason: "open_connections" });
    expect((await run()).nap.kept_awake).toBe(1);
    expect(mockSleep).toHaveBeenCalledTimes(1);

    mockSleep.mockClear();
    const again = await run();
    expect(mockSleep).not.toHaveBeenCalled();
    expect(again.nap.attempted).toBe(0);

    const later = await runSleepIdleSweep({ env: { HIVRA_SLEEP_MODE: "canary" }, now: () => NOW + NOT_IDLE_COOLDOWN_MS + 1 });
    expect(later.nap.attempted).toBe(1);
  });

  it("counts aborts, failures and thrown errors without stopping the host's other agents", async () => {
    setTables({ hosts: hosts(), nap: { data: rows([1, 2, 3]) } });
    mockSleep
      .mockResolvedValueOnce({ outcome: "aborted", reason: "busy" })
      .mockResolvedValueOnce({ outcome: "failed", reason: "no_receipt" })
      .mockRejectedValueOnce(new Error("boom"));
    const summary = await run();
    expect(summary.nap).toMatchObject({ attempted: 3, kept_awake: 1, failed: 2 });
    expect(summary.errors).toBe(1);
  });

  it("never writes agent status", async () => {
    setTables({ hosts: hosts(), nap: { data: rows([1]) }, hibernate: { data: rows([2]) } });
    await run();
    const text = JSON.stringify(mockCalls);
    expect(text).not.toContain("update");
    expect(text).not.toContain("insert");
  });
});

describe("time budget", () => {
  afterEach(() => jest.useRealTimers());

  it("starts no sleep when too little of the budget is left", async () => {
    setTables({
      hosts: { data: hostsTable([{ id: "local", sleep_mode: "canary" }]) },
      nap: { data: [{ id: id(1), proxmox_host: null }] },
    });
    const summary = await run({ HIVRA_SLEEP_MODE: "canary" }, { budgetMs: 10_000 });
    expect(mockSleep).not.toHaveBeenCalled();
    expect(summary.nap.attempted).toBe(0);
  });

  it("lets a hibernate run past the budget, and cuts it off only at its own hard limit", async () => {
    jest.useFakeTimers();
    setTables({
      hosts: { data: hostsTable([{ id: "local", sleep_mode: "canary" }]) },
      hibernate: { data: [{ id: id(1), proxmox_host: null }] },
    });
    let finish: (v: unknown) => void = () => undefined;
    mockSleep.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = run({ HIVRA_SLEEP_MODE: "canary" });
    await jest.advanceTimersByTimeAsync(120_000);
    // Past the 50 second budget and still waiting for the hibernate.
    let settled = false;
    void pending.then(() => { settled = true; });
    await jest.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    finish({ outcome: "slept", state: "hibernated" });
    const summary = await pending;
    expect(summary.timedOut).toBe(false);
    expect(summary.hibernate).toMatchObject({ attempted: 1, slept: 1 });

    resetSleepSweepCooldowns();
    mockSleep.mockImplementation(() => new Promise(() => undefined));
    const stuck = run({ HIVRA_SLEEP_MODE: "canary" });
    await jest.advanceTimersByTimeAsync(286_000);
    const cut = await stuck;
    expect(cut.timedOut).toBe(true);
    expect(cut.hibernate).toMatchObject({ attempted: 1, failed: 1 });
  });

  it("stops at the deadline when a sleep is still running, and says so", async () => {
    jest.useFakeTimers();
    setTables({
      hosts: { data: hostsTable([{ id: "local", sleep_mode: "canary" }]) },
      nap: { data: [1, 2].map((n) => ({ id: id(n), proxmox_host: null })) },
    });
    mockSleep.mockImplementation(() => new Promise(() => undefined));
    const pending = run({ HIVRA_SLEEP_MODE: "canary" }, { budgetMs: 20_100 });
    await jest.advanceTimersByTimeAsync(21_000);
    const summary = await pending;
    expect(summary.timedOut).toBe(true);
    expect(summary.nap).toMatchObject({ attempted: 1, failed: 1 });
    // The second agent is left for the next run.
    expect(mockSleep).toHaveBeenCalledTimes(1);
  });
});

describe("parseSleepStateReceipt", () => {
  const line = (over: Record<string, unknown> = {}) =>
    `HIVRA_SLEEP_STATE ${JSON.stringify({ ok: true, vmid: VMID, observed: "napping", reason: "observed", unit_active: false, ...over })}\n`;

  it("reads a good line", () => {
    expect(parseSleepStateReceipt(line(), VMID)).toEqual({
      ok: true,
      vmid: VMID,
      observed: "napping",
      reason: "observed",
      unitActive: false,
    });
  });

  it.each([
    ["no line", ""],
    ["two lines", line() + line()],
    ["not json", "HIVRA_SLEEP_STATE {oops\n"],
    ["an array", "HIVRA_SLEEP_STATE []\n"],
    ["another vmid", line({ vmid: 999 })],
    ["an unknown state name", line({ observed: "dozing" })],
    ["a string flag", line({ unit_active: "false" })],
    ["a bad reason", line({ reason: "Has Spaces" })],
    ["ok with an unknown state", line({ observed: "unknown" })],
    ["not ok with a known state", line({ ok: false })],
  ])("rejects %s", (_name, text) => {
    expect(parseSleepStateReceipt(text, VMID)).toBeNull();
  });
});

describe("buildSleepStateHostScript", () => {
  it("refuses a missing or odd binding tag and an odd vmid", () => {
    expect(() => buildSleepStateHostScript({ vmid: VMID, bindingTag: null })).toThrow();
    expect(() => buildSleepStateHostScript({ vmid: VMID, bindingTag: "bad tag; rm -rf /" })).toThrow();
    expect(() => buildSleepStateHostScript({ vmid: 5, bindingTag: TAG })).toThrow();
    expect(() => buildSleepStateHostScript({ vmid: 1.5, bindingTag: TAG })).toThrow();
  });

  it("is read only, strict, and wraps qm in timeout", () => {
    const script = buildSleepStateHostScript({ vmid: VMID, bindingTag: TAG });
    expect(script.startsWith("set -euo pipefail")).toBe(true);
    expect(script).toContain(`EXPECTED_BINDING_TAG='${TAG}'`);
    expect(script).toContain("command timeout -k 5 25 qm");
    expect(script).toContain("hivra-sleep-$VMID");
    for (const verb of ["suspend", "resume", "start", "stop", "set ", "destroy", "unlock"]) {
      expect(script).not.toMatch(new RegExp(`qm ${verb}|\\bqm "\\$@"\\s+${verb}`));
    }
  });

  describe("run against stub binaries", () => {
    let h: HostHarness;
    let extraBin: string;
    beforeAll(() => {
      h = makeHostHarness();
      extraBin = mkdtempSync(path.join(tmpdir(), "hivra-sweep-bin-"));
    });
    afterAll(() => {
      h.cleanup();
      rmSync(extraBin, { recursive: true, force: true });
    });

    const stubSystemctl = (active: boolean) => {
      const file = path.join(extraBin, "systemctl");
      writeFileSync(file, `#!/usr/bin/env bash\necho "systemctl $*" >> "$STUB_DIR/calls.log"\nexit ${active ? 0 : 3}\n`);
      chmodSync(file, 0o755);
    };
    const exec = (state: HostState, active = false, script = buildSleepStateHostScript({ vmid: VMID, bindingTag: TAG })) => {
      stubSystemctl(active);
      const result = h.run(script, state, { PATH: `${extraBin}:${h.dir}/bin:/usr/bin:/bin` });
      return { ...result, receipt: parseSleepStateReceipt(result.stdout, VMID) };
    };

    it.each([
      ["awake", AWAKE, "awake"],
      ["napping", NAPPING, "napping"],
      ["hibernated", HIBERNATED, "hibernated"],
      ["cold", COLD, "cold"],
    ] as const)("reads a %s computer", (_name, state, observed) => {
      const run = exec(state);
      expect(run.status).toBe(0);
      expect(run.receipt).toMatchObject({ ok: true, observed, unitActive: false });
    });

    it("never changes the computer", () => {
      for (const state of [AWAKE, NAPPING, HIBERNATED, COLD]) {
        const run = exec(state);
        expect(run.state).toEqual(state);
        expect(run.calls.filter((c) => /^qm (suspend|resume|start|stop|set|unlock|destroy)/.test(c))).toEqual([]);
      }
    });

    it("reports a hibernate unit that is still running", () => {
      expect(exec(HIBERNATED, true).receipt).toMatchObject({ ok: true, observed: "hibernated", unitActive: true });
      expect(exec(AWAKE, true).calls).toContain(`systemctl is-active --quiet hivra-sleep-${VMID}`);
    });

    it("refuses a computer with another binding tag", () => {
      expect(exec({ ...AWAKE, tags: "other-tag" }).receipt).toMatchObject({ ok: false, observed: "unknown", reason: "binding_mismatch" });
    });

    it("reads an unexpected qmpstatus or lock as unknown", () => {
      expect(exec({ ...AWAKE, qmp: "internal-error" }).receipt).toMatchObject({ ok: false, observed: "unknown", reason: "unexpected_state" });
      expect(exec({ ...AWAKE, lock: "backup" }).receipt).toMatchObject({ ok: false, observed: "unknown", reason: "unexpected_state" });
      expect(exec({ ...HIBERNATED, lock: "migrate" }).receipt).toMatchObject({ ok: false, observed: "unknown" });
    });

    it("quotes the tag so it cannot run anything", () => {
      const run = spawnSync("bash", ["-n"], {
        input: buildSleepStateHostScript({ vmid: VMID, bindingTag: TAG }),
        encoding: "utf8",
      });
      expect(run.status).toBe(0);
    });
  });
});
