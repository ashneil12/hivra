/** @jest-environment node */

// Reconcile: the sleep record is brought back in line with what the host shows.
// The host state script itself is covered with stub binaries in
// sleep-idle-sweep.test.ts; here the script's answer is canned and every
// decision after it is checked: which leases and records are settled, to what,
// and that nothing is ever guessed, forced or written to status.

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

const mockRunScript = jest.fn();
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  runProxmoxHostScript: (...args: unknown[]) => mockRunScript(...args),
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
const mockReconcileState = jest.fn();
jest.mock("../agent-sleep-store", () => ({
  finishAgentSleep: (...args: unknown[]) => mockFinishSleep(...args),
  finishAgentWake: (...args: unknown[]) => mockFinishWake(...args),
  logAgentSleepEvent: (...args: unknown[]) => mockLogEvent(...args),
  reconcileAgentSleepState: (...args: unknown[]) => mockReconcileState(...args),
  parseSleepGeneration: (value: unknown) => (typeof value === "number" ? value : null),
}));

import {
  STALE_LEASE_MS,
  leaselessReconcileTarget,
  reconcileAgentSleep,
  sleepLeaseAgeMs,
  sleepLeaseKind,
} from "../sleep-reconcile";

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);
const MIN = 60_000;
const VMID = 1100;
const id = "00000000-0000-4000-8000-000000000001";

const row = (over: Record<string, unknown> = {}) => ({
  id,
  user_id: "user-1",
  status: "running",
  desired_state: "running",
  vmid: VMID,
  cf_hostname: "agent-one.example.test",
  sleep_state: "awake",
  sleep_generation: 5,
  operation_id: null,
  operation_kind: null,
  operation_started_at: null,
  ...over,
});
const lease = (kind: "sleep" | "wake", state: string, over: Record<string, unknown> = {}) =>
  row({
    sleep_state: state,
    operation_id: "op-1",
    operation_kind: kind,
    operation_started_at: new Date(NOW - 15 * MIN).toISOString(),
    ...over,
  });

const stateLine = (observed: string, extra: Record<string, unknown> = {}) => ({
  ok: true,
  stdout: `HIVRA_SLEEP_STATE ${JSON.stringify({
    ok: observed !== "unknown", vmid: VMID, observed, reason: observed === "unknown" ? "unexpected_state" : "observed",
    unit_active: false, ...extra,
  })}\n`,
});

const reconcile = (r: Record<string, unknown>) => reconcileAgentSleep(r as never, { now: () => NOW });

beforeEach(() => {
  jest.clearAllMocks();
  mockTarget.mockResolvedValue({ ok: true, target: { vmid: VMID, bindingTag: "tag-1", env: { host: "h" } } });
  mockRunScript.mockResolvedValue(stateLine("awake"));
  mockHealthz.mockResolvedValue({ up: true, ms: 10, attempts: 1 });
  mockFinishSleep.mockResolvedValue(true);
  mockFinishWake.mockResolvedValue(true);
  mockLogEvent.mockResolvedValue(true);
  mockReconcileState.mockResolvedValue(true);
  mockEnsure.mockResolvedValue({ state: "awake", wakeMs: 900 });
});

describe("sleepLeaseKind and sleepLeaseAgeMs", () => {
  it("name a sleep or wake lease and how old it is, and nothing else", () => {
    expect(sleepLeaseKind(lease("sleep", "draining") as never)).toBe("sleep");
    expect(sleepLeaseKind(lease("wake", "waking") as never)).toBe("wake");
    expect(sleepLeaseKind(row() as never)).toBeNull();
    expect(sleepLeaseKind(row({ operation_id: "op", operation_kind: "restart" }) as never)).toBeNull();
    expect(sleepLeaseAgeMs(lease("sleep", "draining") as never, NOW)).toBe(15 * MIN);
    expect(sleepLeaseAgeMs(row() as never, NOW)).toBeNull();
    expect(sleepLeaseAgeMs(lease("sleep", "draining", { operation_started_at: "garbage" }) as never, NOW)).toBeNull();
    expect(STALE_LEASE_MS).toBe(6 * MIN);
  });
});

describe("leaselessReconcileTarget", () => {
  it.each([
    // [record, host, healthz up, result]
    ["awake", "napping", true, null],
    ["napping", "napping", true, null],
    ["napping", "hibernated", true, "hibernated"],
    ["hibernated", "napping", true, "napping"],
    ["hibernated", "hibernated", true, null],
    ["napping", "awake", true, "awake"],
    ["hibernated", "awake", true, "awake"],
    ["napping", "awake", false, "wake_failed"],
    ["wake_failed", "awake", false, null],
    ["wake_failed", "awake", true, "awake"],
    ["wake_failed", "napping", true, null],
    ["wake_failed", "hibernated", true, null],
    ["draining", "napping", true, "napping"],
    ["hibernating", "hibernated", true, "hibernated"],
    ["hibernating", "awake", true, "awake"],
    ["waking", "awake", false, "wake_failed"],
    ["waking", "napping", true, "napping"],
    ["napping", "cold", false, "awake"],
    ["draining", "cold", false, "awake"],
    ["napping", "unknown", true, null],
    ["waking", "unknown", true, null],
  ])("a %s record on a %s host (check up: %s) becomes %s", (record, host, up, result) => {
    expect(leaselessReconcileTarget(record, host as never, up)).toBe(result);
  });
});

describe("reconcileAgentSleep: a stale lease", () => {
  it.each([
    ["sleep", "draining", "napping", "napping"],
    ["sleep", "hibernating", "hibernated", "hibernated"],
    ["sleep", "draining", "awake", "awake"],
    ["sleep", "draining", "cold", "awake"],
  ])("finishes a %s lease on a %s record to the observed tier (%s host gives %s)", async (kind, state, observed, result) => {
    mockRunScript.mockResolvedValue(stateLine(observed));
    const outcome = await reconcile(lease(kind as "sleep", state));
    expect(outcome).toMatchObject({ outcome: "settled", to: result, why: "stale_lease", hostState: observed });
    expect(mockFinishSleep).toHaveBeenCalledWith({ agentId: id, operationId: "op-1", result });
    expect(mockFinishWake).not.toHaveBeenCalled();
    expect(mockReconcileState).not.toHaveBeenCalled();
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: "reconcile", trigger: "reconcile", fromState: state, toState: result, reason: "stale_sleep_lease",
      detail: expect.objectContaining({ host_state: observed, age_s: 900 }),
    }));
  });

  it("finishes a stale wake lease as awake only when the public check answers, else wake_failed", async () => {
    mockRunScript.mockResolvedValue(stateLine("awake"));
    await reconcile(lease("wake", "waking"));
    expect(mockFinishWake).toHaveBeenLastCalledWith({ agentId: id, operationId: "op-1", result: "awake" });
    mockHealthz.mockResolvedValue({ up: false, ms: 6000, attempts: 6 });
    await reconcile(lease("wake", "waking"));
    expect(mockFinishWake).toHaveBeenLastCalledWith({ agentId: id, operationId: "op-1", result: "wake_failed" });
  });

  it("finishes a stale wake lease as wake_failed when the computer is still asleep, so the next wake can run", async () => {
    for (const observed of ["napping", "hibernated"]) {
      mockRunScript.mockResolvedValue(stateLine(observed));
      await reconcile(lease("wake", "waking"));
      expect(mockFinishWake).toHaveBeenLastCalledWith({ agentId: id, operationId: "op-1", result: "wake_failed" });
    }
  });

  it("settles a lease on an agent that is no longer running, so the lease does not outlive it", async () => {
    mockRunScript.mockResolvedValue(stateLine("napping"));
    await expect(reconcile(lease("sleep", "draining", { status: "stopped" }))).resolves.toMatchObject({ outcome: "settled" });
  });

  it("leaves the lease alone when the host is unreadable, unknown, or still working on it", async () => {
    mockRunScript.mockResolvedValue({ ok: false, stdout: "" });
    await expect(reconcile(lease("sleep", "draining"))).resolves.toEqual({ outcome: "left", reason: "state_unreadable" });
    mockRunScript.mockResolvedValue(stateLine("unknown"));
    await expect(reconcile(lease("sleep", "draining"))).resolves.toMatchObject({ outcome: "left" });
    mockRunScript.mockResolvedValue(stateLine("napping", { unit_active: true }));
    await expect(reconcile(lease("sleep", "hibernating"))).resolves.toEqual({ outcome: "left", reason: "unit_active" });
    mockRunScript.mockRejectedValue(new Error("ssh down"));
    await expect(reconcile(lease("sleep", "draining"))).resolves.toEqual({ outcome: "left", reason: "reconcile_error" });
    expect(mockFinishSleep).not.toHaveBeenCalled();
    expect(mockFinishWake).not.toHaveBeenCalled();
  });

  it("leaves the lease when it cannot be resolved to a computer with a binding tag, or the finish is not recorded", async () => {
    mockTarget.mockResolvedValueOnce({ ok: false, code: "no_host" });
    await expect(reconcile(lease("sleep", "draining"))).resolves.toEqual({ outcome: "left", reason: "target_no_host" });
    mockTarget.mockResolvedValueOnce({ ok: true, target: { vmid: VMID, bindingTag: null, env: {} } });
    await expect(reconcile(lease("sleep", "draining"))).resolves.toEqual({ outcome: "left", reason: "binding_not_enforced" });
    mockRunScript.mockResolvedValue(stateLine("napping"));
    mockFinishSleep.mockResolvedValueOnce(false);
    await expect(reconcile(lease("sleep", "draining"))).resolves.toEqual({ outcome: "left", reason: "finish_not_recorded" });
    expect(mockLogEvent).not.toHaveBeenCalled();
  });
});

describe("reconcileAgentSleep: a record with no lease", () => {
  it("corrects a napping record whose computer is running and answering, to awake", async () => {
    mockRunScript.mockResolvedValue(stateLine("awake"));
    const outcome = await reconcile(row({ sleep_state: "napping" }));
    expect(outcome).toMatchObject({ outcome: "settled", to: "awake", why: "record_drift" });
    expect(mockReconcileState).toHaveBeenCalledWith({ agentId: id, expectedGeneration: 5, to: "awake" });
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: "reconcile", trigger: "reconcile", fromState: "napping", toState: "awake", reason: "record_differs_from_host",
    }));
  });

  it("marks a napping record whose running computer does not answer as wake_failed, so the next wake reruns the fixups", async () => {
    mockRunScript.mockResolvedValue(stateLine("awake"));
    mockHealthz.mockResolvedValue({ up: false, ms: 6000, attempts: 6 });
    await expect(reconcile(row({ sleep_state: "napping" }))).resolves.toMatchObject({ to: "wake_failed" });
    expect(mockReconcileState).toHaveBeenCalledWith({ agentId: id, expectedGeneration: 5, to: "wake_failed" });
  });

  it("corrects a hibernated record whose computer is only paused, to napping", async () => {
    mockRunScript.mockResolvedValue(stateLine("napping"));
    await expect(reconcile(row({ sleep_state: "hibernated" }))).resolves.toMatchObject({ outcome: "settled", to: "napping" });
  });

  it("settles a transient record that nobody holds a lease for, from the host", async () => {
    mockRunScript.mockResolvedValue(stateLine("hibernated"));
    await expect(reconcile(row({ sleep_state: "hibernating" }))).resolves.toMatchObject({ outcome: "settled", to: "hibernated" });
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ reason: "leaseless_transient_state" }));
  });

  it("changes nothing when the record already says what the host shows", async () => {
    mockRunScript.mockResolvedValue(stateLine("napping"));
    await expect(reconcile(row({ sleep_state: "napping" }))).resolves.toEqual({ outcome: "consistent", hostState: "napping" });
    expect(mockReconcileState).not.toHaveBeenCalled();
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it("leaves the record alone when something else moved the agent meanwhile (the compare and set loses)", async () => {
    mockRunScript.mockResolvedValue(stateLine("napping"));
    mockReconcileState.mockResolvedValue(false);
    await expect(reconcile(row({ sleep_state: "hibernated" }))).resolves.toEqual({ outcome: "left", reason: "changed_meanwhile" });
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it("never touches an agent holding another kind of operation, or one that is not running", async () => {
    await expect(reconcile(row({ sleep_state: "napping", operation_id: "op", operation_kind: "restart" })))
      .resolves.toEqual({ outcome: "left", reason: "other_operation" });
    await expect(reconcile(row({ sleep_state: "napping", status: "stopped" }))).resolves.toEqual({ outcome: "left", reason: "not_running" });
    await expect(reconcile(row({ sleep_state: "napping", desired_state: "deleted" })))
      .resolves.toEqual({ outcome: "left", reason: "not_desired_running" });
    expect(mockRunScript).not.toHaveBeenCalled();
    expect(mockReconcileState).not.toHaveBeenCalled();
  });

  it("does not guess when the generation is unusable", async () => {
    mockRunScript.mockResolvedValue(stateLine("napping"));
    await expect(reconcile(row({ sleep_state: "hibernated", sleep_generation: "7" }))).resolves.toEqual({ outcome: "left", reason: "generation_unknown" });
    expect(mockReconcileState).not.toHaveBeenCalled();
  });
});

describe("reconcileAgentSleep: an awake record on a computer that is paused or saved to disk", () => {
  it.each([
    ["napping", "napping"],
    ["hibernated", "hibernated"],
  ])("records the %s host truth, then wakes the agent (fail toward awake)", async (observed, recorded) => {
    mockRunScript.mockResolvedValue(stateLine(observed));
    const outcome = await reconcile(row());
    expect(outcome).toEqual({ outcome: "settled", to: recorded, hostState: observed, why: "awake_but_asleep", woke: true });
    expect(mockReconcileState).toHaveBeenCalledWith({ agentId: id, expectedGeneration: 5, to: recorded });
    // The record is made truthful first, so the normal wake path can take its lease.
    expect(mockReconcileState.mock.invocationCallOrder[0]).toBeLessThan(mockEnsure.mock.invocationCallOrder[0]);
    expect(mockEnsure).toHaveBeenCalledWith(id, expect.objectContaining({ trigger: "reconcile" }));
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: "reconcile", fromState: "awake", toState: recorded, reason: "awake_record_on_sleeping_computer",
    }));
    expect(mockFinishSleep).not.toHaveBeenCalled();
    expect(mockFinishWake).not.toHaveBeenCalled();
  });

  it("reports a wake that did not finish, and keeps the corrected record", async () => {
    mockRunScript.mockResolvedValue(stateLine("napping"));
    mockEnsure.mockResolvedValue({ state: "waking", reason: "in_progress" });
    await expect(reconcile(row())).resolves.toMatchObject({ outcome: "settled", woke: false });
    mockEnsure.mockRejectedValue(new Error("boom"));
    await expect(reconcile(row())).resolves.toMatchObject({ outcome: "settled", woke: false });
  });

  it("does not wake, or touch the record, when the compare and set loses", async () => {
    mockRunScript.mockResolvedValue(stateLine("napping"));
    mockReconcileState.mockResolvedValue(false);
    await expect(reconcile(row())).resolves.toEqual({ outcome: "left", reason: "changed_meanwhile" });
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it("is consistent when the awake record's computer is running, or off (the start path owns that)", async () => {
    for (const observed of ["awake", "cold"]) {
      mockRunScript.mockResolvedValue(stateLine(observed));
      await expect(reconcile(row())).resolves.toEqual({ outcome: "consistent", hostState: observed });
    }
    expect(mockReconcileState).not.toHaveBeenCalled();
    expect(mockEnsure).not.toHaveBeenCalled();
    // A running computer's public check is not needed to call it consistent.
    expect(mockHealthz).not.toHaveBeenCalled();
  });

  it("does not wake a computer that a script is still moving", async () => {
    mockRunScript.mockResolvedValue(stateLine("napping", { unit_active: true }));
    await expect(reconcile(row())).resolves.toEqual({ outcome: "left", reason: "unit_active" });
    expect(mockReconcileState).not.toHaveBeenCalled();
    expect(mockEnsure).not.toHaveBeenCalled();
  });
});

describe("reconcile never writes agent status", () => {
  it("uses only the lease finishers, the compare and set, and the event log", async () => {
    // The module has no database client of its own, so status cannot be written from it.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expect(require("node:fs").readFileSync(require.resolve("../sleep-reconcile"), "utf8")).not.toMatch(/supabaseAdmin|\.update\(|\bstatus: "(error|stopped|running)"/);
    for (const [state, observed] of [["napping", "awake"], ["awake", "napping"], ["hibernating", "hibernated"]]) {
      mockRunScript.mockResolvedValue(stateLine(observed));
      await reconcile(row({ sleep_state: state }));
    }
    for (const call of mockReconcileState.mock.calls) expect(Object.keys(call[0] as object).sort()).toEqual(["agentId", "expectedGeneration", "to"]);
  });
});
