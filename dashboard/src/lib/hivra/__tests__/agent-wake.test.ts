/** @jest-environment node */

const mockReadRow = jest.fn();
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) q[m] = () => q;
      q.maybeSingle = () => mockReadRow();
      return q;
    },
  },
}));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

const mockClaim = jest.fn();
const mockFinish = jest.fn();
const mockLogEvent = jest.fn();
jest.mock("../agent-sleep-store", () => ({
  ...jest.requireActual("../agent-sleep-store"),
  claimAgentWake: (...a: unknown[]) => mockClaim(...a),
  finishAgentWake: (...a: unknown[]) => mockFinish(...a),
  logAgentSleepEvent: (...a: unknown[]) => mockLogEvent(...a),
}));

const mockResolveTarget = jest.fn();
jest.mock("../agent-lifecycle-host", () => ({
  resolveHivraLifecycleTarget: (...a: unknown[]) => mockResolveTarget(...a),
}));

const mockRunScript = jest.fn();
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  runProxmoxHostScript: (...a: unknown[]) => mockRunScript(...a),
}));

const mockAcquire = jest.fn();
const mockRelease = jest.fn();
jest.mock("@/lib/proxmox/wake-admission", () => ({
  ...jest.requireActual("@/lib/proxmox/wake-admission"),
  acquireHostWakeSlot: (...a: unknown[]) => mockAcquire(...a),
  releaseHostWakeSlot: (...a: unknown[]) => mockRelease(...a),
}));

const mockLapsed = jest.fn();
jest.mock("../lapse-gate", () => ({ isStartBlockedForLapse: (...a: unknown[]) => mockLapsed(...a) }));

const mockSsrfFetch = jest.fn();
jest.mock("@/lib/ssrf-safe-fetch", () => ({ ssrfSafeFetch: (...a: unknown[]) => mockSsrfFetch(...a) }));

import { ensureHivraAgentAwake, pollPublicHealthz } from "../agent-wake";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const VMID = 1234;

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    user_id: "user-1",
    status: "running",
    sleep_state: "napping",
    sleep_generation: 4,
    operation_id: null,
    cf_hostname: "agent-one.example.test",
    ram: 4,
    ...overrides,
  };
}

const target = {
  executionContext: {
    paths: { provisionerDirectory: "/opt/hivra/provisioner" },
    capacityPolicy: { mode: "observe", hostMemoryReserveMb: 2048, cpuCeilingDensity: 1, memoryCeilingDensity: 1 },
  },
  bindingTag: "hivra-tag-1",
  env: {},
  vmid: VMID,
};

function wakeReceipt(over: Record<string, unknown> = {}) {
  return `noise\nHIVRA_WAKE_RESULT ${JSON.stringify({
    ok: true, vmid: VMID, from: "napping", to: "awake", reason: "resumed", ms: 900, steps: { resume: 120, healthz: 300 }, ...over,
  })}\n`;
}

const fast = { pollIntervalMs: 1 };

describe("ensureHivraAgentAwake", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockLapsed.mockResolvedValue(false);
    mockClaim.mockResolvedValue("claimed");
    mockFinish.mockResolvedValue(true);
    mockLogEvent.mockResolvedValue(true);
    mockResolveTarget.mockResolvedValue({ ok: true, target });
    mockRunScript.mockResolvedValue({ ok: true, stdout: wakeReceipt(), stderr: "" });
    mockAcquire.mockResolvedValue({ admitted: true, freeMb: 9000, activeWakes: 0 });
    mockRelease.mockResolvedValue(undefined);
    mockSsrfFetch.mockResolvedValue({ status: 200 });
  });

  it("returns at once for an awake agent, with no claim", async () => {
    mockReadRow.mockResolvedValue({ data: row({ sleep_state: "awake" }), error: null });
    await expect(ensureHivraAgentAwake(AGENT_ID, { trigger: "open" })).resolves.toEqual({ state: "awake" });
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("treats a row without the sleep column as awake", async () => {
    mockReadRow.mockResolvedValue({ data: { id: AGENT_ID, user_id: "user-1" }, error: null });
    await expect(ensureHivraAgentAwake(AGENT_ID, { trigger: "open" })).resolves.toEqual({ state: "awake" });
  });

  it("fails when the agent is missing or the read fails", async () => {
    mockReadRow.mockResolvedValueOnce({ data: null, error: null });
    await expect(ensureHivraAgentAwake(AGENT_ID, { trigger: "open" })).resolves.toEqual({ state: "failed", reason: "not_found" });
    mockReadRow.mockResolvedValueOnce({ data: null, error: { code: "XX" } });
    await expect(ensureHivraAgentAwake(AGENT_ID, { trigger: "open" })).resolves.toEqual({ state: "failed", reason: "agent_unreadable" });
  });

  it("never wakes a lapsed owner", async () => {
    mockReadRow.mockResolvedValue({ data: row(), error: null });
    mockLapsed.mockResolvedValue(true);
    await expect(ensureHivraAgentAwake(AGENT_ID, { trigger: "open" })).resolves.toEqual({ state: "failed", reason: "lapsed" });
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockRunScript).not.toHaveBeenCalled();
  });

  it("wakes a napping agent: claim, script, public health check, finish awake, event", async () => {
    mockReadRow
      .mockResolvedValueOnce({ data: row(), error: null })
      .mockResolvedValue({ data: row({ sleep_state: "awake", sleep_generation: 6 }), error: null });
    const result = await ensureHivraAgentAwake(AGENT_ID, { trigger: "open", ...fast });
    expect(result.state).toBe("awake");
    expect(result.reason).toBe("resumed");
    expect(typeof result.wakeMs).toBe("number");
    expect(mockClaim).toHaveBeenCalledWith({ agentId: AGENT_ID, operationId: expect.any(String) });
    // A nap takes no wake slot.
    expect(mockAcquire).not.toHaveBeenCalled();
    const script = String(mockRunScript.mock.calls[0][0]);
    expect(script).toContain("HIVRA_WAKE_RESULT");
    expect(script).toContain("VMID=1234");
    expect(mockSsrfFetch).toHaveBeenCalledWith("https://agent-one.example.test/healthz", expect.objectContaining({ method: "GET" }));
    const claimedOp = mockClaim.mock.calls[0][0].operationId;
    expect(mockFinish).toHaveBeenCalledWith({ agentId: AGENT_ID, operationId: claimedOp, result: "awake" });
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      agentId: AGENT_ID, kind: "wake", trigger: "open", fromState: "napping", toState: "awake", generation: 6,
      detail: expect.objectContaining({ resume_ms: 120, from: "napping" }),
    }));
  });

  it("takes a host wake slot for a hibernated agent and releases it afterwards", async () => {
    mockReadRow.mockResolvedValue({ data: row({ sleep_state: "hibernated" }), error: null });
    mockRunScript.mockResolvedValue({ ok: true, stdout: wakeReceipt({ from: "hibernated", reason: "restored" }), stderr: "" });
    const result = await ensureHivraAgentAwake(AGENT_ID, { trigger: "action", ...fast });
    expect(result.state).toBe("awake");
    expect(mockAcquire).toHaveBeenCalledWith({ vmid: VMID }, expect.objectContaining({ instanceId: AGENT_ID, neededRamMb: 4096 }));
    expect(mockRelease).toHaveBeenCalledTimes(1);
    // The restore runs under the capacity policy the start action uses.
    expect(String(mockRunScript.mock.calls[0][0])).toContain("/opt/hivra/provisioner");
  });

  it("finishes as wake_failed when the host defers the wake, and runs no script", async () => {
    mockReadRow.mockResolvedValue({ data: row({ sleep_state: "hibernated" }), error: null });
    mockAcquire.mockResolvedValue({ admitted: false, reason: "host_ram", freeMb: 100, activeWakes: 1, cap: 2, retryAfterSeconds: 30 });
    const result = await ensureHivraAgentAwake(AGENT_ID, { trigger: "open", ...fast });
    expect(result).toEqual({ state: "failed", reason: "capacity_host_ram" });
    expect(mockRunScript).not.toHaveBeenCalled();
    expect(mockFinish).toHaveBeenCalledWith(expect.objectContaining({ result: "wake_failed" }));
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "fail", reason: "capacity_host_ram" }));
    expect(mockRelease).toHaveBeenCalled();
  });

  it("finishes as wake_failed when the receipt does not parse", async () => {
    mockReadRow.mockResolvedValue({ data: row(), error: null });
    mockRunScript.mockResolvedValue({ ok: true, stdout: "HIVRA_WAKE_RESULT {not json}\n", stderr: "" });
    const result = await ensureHivraAgentAwake(AGENT_ID, { trigger: "open", ...fast });
    expect(result).toEqual({ state: "failed", reason: "no_receipt" });
    expect(mockFinish).toHaveBeenCalledWith(expect.objectContaining({ result: "wake_failed" }));
  });

  it("finishes as wake_failed when the host script cannot run", async () => {
    mockReadRow.mockResolvedValue({ data: row(), error: null });
    mockRunScript.mockResolvedValue({ ok: false, stdout: "", stderr: "", error: "ssh down" });
    const result = await ensureHivraAgentAwake(AGENT_ID, { trigger: "open", ...fast });
    expect(result).toEqual({ state: "failed", reason: "host_script_failed" });
  });

  it("finishes as wake_failed when the script says the guest steps failed", async () => {
    mockReadRow.mockResolvedValue({ data: row(), error: null });
    mockRunScript.mockResolvedValue({ ok: true, stdout: wakeReceipt({ ok: false, reason: "tunnel_failed" }), stderr: "" });
    const result = await ensureHivraAgentAwake(AGENT_ID, { trigger: "open", ...fast });
    expect(result).toEqual({ state: "failed", reason: "tunnel_failed" });
    expect(mockSsrfFetch).not.toHaveBeenCalled();
  });

  it("finishes as wake_failed when the target cannot be resolved, or throws", async () => {
    mockReadRow.mockResolvedValue({ data: row(), error: null });
    mockResolveTarget.mockResolvedValueOnce({ ok: false, code: "host_not_ready", status: 503, message: "x" });
    await expect(ensureHivraAgentAwake(AGENT_ID, { trigger: "open", ...fast })).resolves.toEqual({ state: "failed", reason: "target_host_not_ready" });
    mockResolveTarget.mockRejectedValueOnce(new Error("boom"));
    await expect(ensureHivraAgentAwake(AGENT_ID, { trigger: "open", ...fast })).resolves.toEqual({ state: "failed", reason: "wake_error" });
    expect(mockFinish).toHaveBeenCalledTimes(2);
    for (const call of mockFinish.mock.calls) expect(call[0].result).toBe("wake_failed");
  });

  it("finishes as wake_failed when the public health check never answers", async () => {
    jest.useFakeTimers();
    try {
      mockReadRow.mockResolvedValue({ data: row(), error: null });
      mockSsrfFetch.mockResolvedValue({ status: 530 });
      const promise = ensureHivraAgentAwake(AGENT_ID, { trigger: "open", waitMs: 120_000, pollIntervalMs: 1 });
      await jest.advanceTimersByTimeAsync(40_000);
      await expect(promise).resolves.toEqual({ state: "failed", reason: "public_healthz_timeout" });
      expect(mockFinish).toHaveBeenCalledWith(expect.objectContaining({ result: "wake_failed" }));
    } finally {
      jest.useRealTimers();
    }
  });

  it("reports cold when nothing was saved, finishing as awake", async () => {
    mockReadRow.mockResolvedValue({ data: row(), error: null });
    mockRunScript.mockResolvedValue({ ok: true, stdout: wakeReceipt({ ok: false, from: "cold", to: "cold", reason: "cold" }), stderr: "" });
    const result = await ensureHivraAgentAwake(AGENT_ID, { trigger: "open", ...fast });
    expect(result).toEqual({ state: "cold", reason: "cold" });
    expect(mockFinish).toHaveBeenCalledWith(expect.objectContaining({ result: "awake" }));
    expect(mockSsrfFetch).not.toHaveBeenCalled();
  });

  it("refuses when the claim is refused, and returns awake when the claim says awake", async () => {
    mockReadRow.mockResolvedValue({ data: row(), error: null });
    mockClaim.mockResolvedValueOnce("refused");
    await expect(ensureHivraAgentAwake(AGENT_ID, { trigger: "open", ...fast })).resolves.toEqual({ state: "failed", reason: "wake_refused" });
    mockClaim.mockResolvedValueOnce("awake");
    await expect(ensureHivraAgentAwake(AGENT_ID, { trigger: "open", ...fast })).resolves.toEqual({ state: "awake" });
    expect(mockRunScript).not.toHaveBeenCalled();
  });

  it("waits while the agent is draining, hibernating or waking, then returns awake", async () => {
    mockReadRow
      .mockResolvedValueOnce({ data: row({ sleep_state: "draining" }), error: null })
      .mockResolvedValueOnce({ data: row({ sleep_state: "draining" }), error: null })
      .mockResolvedValueOnce({ data: row({ sleep_state: "waking" }), error: null })
      .mockResolvedValue({ data: row({ sleep_state: "awake" }), error: null });
    await expect(ensureHivraAgentAwake(AGENT_ID, { trigger: "open", waitMs: 5000, ...fast })).resolves.toEqual({ state: "awake" });
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("returns waking when the wait runs out on a transient state", async () => {
    mockReadRow.mockResolvedValue({ data: row({ sleep_state: "hibernating" }), error: null });
    await expect(ensureHivraAgentAwake(AGENT_ID, { trigger: "open", waitMs: 20, ...fast })).resolves.toEqual({ state: "waking", reason: "still_settling" });
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("waits out a busy claim, then claims once the agent settles", async () => {
    mockReadRow.mockResolvedValue({ data: row(), error: null });
    mockClaim.mockResolvedValueOnce("busy").mockResolvedValueOnce("claimed");
    const result = await ensureHivraAgentAwake(AGENT_ID, { trigger: "open", waitMs: 5000, ...fast });
    expect(result.state).toBe("awake");
    expect(mockClaim).toHaveBeenCalledTimes(2);
  });

  it("returns waking, and hands the work on, when the wake outlives the wait", async () => {
    mockReadRow.mockResolvedValue({ data: row(), error: null });
    let release: (value: unknown) => void = () => undefined;
    mockRunScript.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const background = jest.fn();
    const result = await ensureHivraAgentAwake(AGENT_ID, { trigger: "open", waitMs: 20, onBackground: background, ...fast });
    expect(result).toEqual({ state: "waking", reason: "in_progress" });
    expect(background).toHaveBeenCalledTimes(1);
    release({ ok: true, stdout: wakeReceipt(), stderr: "" });
    await expect(background.mock.calls[0][0]).resolves.toEqual(expect.objectContaining({ state: "awake" }));
    expect(mockFinish).toHaveBeenCalledWith(expect.objectContaining({ result: "awake" }));
  });

  it("reports what the row says when the lease could not be released", async () => {
    mockReadRow
      .mockResolvedValueOnce({ data: row(), error: null })
      .mockResolvedValue({ data: row({ sleep_state: "napping" }), error: null });
    mockFinish.mockResolvedValue(false);
    await expect(ensureHivraAgentAwake(AGENT_ID, { trigger: "open", ...fast })).resolves.toEqual({ state: "failed", reason: "finish_not_recorded" });
  });

  it("never touches hivra_agents.status", async () => {
    mockReadRow.mockResolvedValue({ data: row(), error: null });
    await ensureHivraAgentAwake(AGENT_ID, { trigger: "open", ...fast });
    // The only writes are the store's lease functions and the event log.
    expect(mockFinish.mock.calls.every((c) => !("status" in c[0]))).toBe(true);
  });
});

describe("pollPublicHealthz", () => {
  it("counts any code below 500 as up, and refuses a hostname that is not one", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ status: 401 });
    await expect(pollPublicHealthz("Agent.Example.test", { fetchImpl })).resolves.toEqual(expect.objectContaining({ up: true, attempts: 1 }));
    expect(fetchImpl.mock.calls[0][0]).toBe("https://agent.example.test/healthz");
    for (const bad of [null, "", "a b.example.test", "x.test/evil", "localhost", "evil.test:8080"]) {
      await expect(pollPublicHealthz(bad, { fetchImpl })).resolves.toEqual({ up: false, ms: 0, attempts: 0 });
    }
  });

  it("keeps trying through errors and 5xx, then gives up inside its budget", async () => {
    const fetchImpl = jest.fn()
      .mockRejectedValueOnce(new Error("refused"))
      .mockResolvedValueOnce({ status: 530 })
      .mockResolvedValue({ status: 200 });
    const up = await pollPublicHealthz("a.example.test", { fetchImpl, intervalMs: 1, budgetMs: 1000 });
    expect(up).toEqual(expect.objectContaining({ up: true, attempts: 3 }));
    const down = await pollPublicHealthz("a.example.test", { fetchImpl: jest.fn().mockResolvedValue({ status: 502 }), intervalMs: 5, budgetMs: 30 });
    expect(down.up).toBe(false);
    expect(down.attempts).toBeGreaterThan(1);
  });
});
