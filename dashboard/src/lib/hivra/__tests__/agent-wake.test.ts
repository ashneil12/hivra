/** @jest-environment node */

const mockReadRow = jest.fn();
const mockMemoryGrant = jest.fn();
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: (...args: unknown[]) => mockMemoryGrant(...args),
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

const mockMakeRoom = jest.fn();
const mockRoomEnabled = jest.fn();
jest.mock("../sleep/wake-make-room", () => ({
  isWakeMakesRoomEnabled: () => mockRoomEnabled(),
  makeRoomForWake: (...a: unknown[]) => mockMakeRoom(...a),
}));

const mockLapsed = jest.fn();
jest.mock("../lapse-gate", () => ({ isStartBlockedForLapse: (...a: unknown[]) => mockLapsed(...a) }));

const mockReconcile = jest.fn();
jest.mock("../sleep-reconcile", () => ({ reconcileAgentSleep: (...a: unknown[]) => mockReconcile(...a) }));

const mockSsrfFetch = jest.fn();
jest.mock("@/lib/ssrf-safe-fetch", () => ({ ssrfSafeFetch: (...a: unknown[]) => mockSsrfFetch(...a) }));

const mockAfter = jest.fn();
jest.mock("../after-response", () => ({ runAfterResponse: (...a: unknown[]) => mockAfter(...a) }));
const mockRunStorage = jest.fn();
jest.mock("../sleep-storage", () => ({ runSleepStorage: (...a: unknown[]) => mockRunStorage(...a) }));

import { ensureHivraAgentAwake, isStuckTransient, MANAGED_WAKE_WORK_BUDGET_MS, pollPublicHealthz, resetStorageKicks, runWakeHostScript, wakesAtOncePerHost, WAKE_TURN_WAIT_SECONDS } from "../agent-wake";
import type { HivraLifecycleTarget } from "../agent-lifecycle-host";

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
    ok: true, vmid: VMID, from: "napping", to: "awake", reason: "resumed", ms: 900, steps: { resume: 120, fixup: 300 },
    via: "socket", tries: 1, ...over,
  })}\n`;
}

const fast = { pollIntervalMs: 1 };

/** A sleep or wake that is moving the agent right now: a fresh lease. */
const live = (state: string, kind: "sleep" | "wake" = "sleep") =>
  row({ sleep_state: state, operation_id: "op-live", operation_kind: kind, operation_started_at: new Date().toISOString() });
/** A sleep or wake whose holder is long gone. */
const abandoned = (state: string, kind: "sleep" | "wake" = "sleep") =>
  row({ sleep_state: state, operation_id: "op-old", operation_kind: kind, operation_started_at: new Date(Date.now() - 10 * 60_000).toISOString() });

describe("ensureHivraAgentAwake", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockLapsed.mockResolvedValue(false);
    mockClaim.mockResolvedValue("claimed");
    mockFinish.mockResolvedValue(true);
    mockLogEvent.mockResolvedValue(true);
    mockResolveTarget.mockResolvedValue({ ok: true, target });
    mockRunScript.mockReset();
    mockRunScript.mockResolvedValue({ ok: true, stdout: wakeReceipt(), stderr: "" });
    mockAcquire.mockReset();
    mockMakeRoom.mockReset();
    mockRoomEnabled.mockReset();
    mockRoomEnabled.mockReturnValue(false);
    mockAcquire.mockResolvedValue({ admitted: true, freeMb: 9000, activeWakes: 0 });
    mockRelease.mockResolvedValue(undefined);
    mockSsrfFetch.mockResolvedValue({ status: 200 });
  });

  it("reads the grant afresh on restore, but never for a nap, another host or VM 9302", async () => {
    const replace = jest.replaceProperty(process, "env", {
      ...process.env,
      VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "canary.hermesos.cloud",
      VERCEL_GIT_COMMIT_REF: "canary", VERCEL_GIT_REPO_OWNER: "ashneil12", VERCEL_GIT_REPO_SLUG: "hivra",
    });
    const candidate = row({ user_id: "user_fixture", type: "hermes", computer_substrate: "proxmox-kvm", seat_funding: "paid" });
    const managed = (host: string, vmid = VMID) => ({
      ...target, vmid,
      executionContext: { ...target.executionContext, kind: "managed", host, provisionerChannel: "canary" },
    }) as HivraLifecycleTarget;
    try {
      const grant = {
        ratio_milli: 1100, valid_until_epoch: Math.floor(Date.now() / 1000) + 60, measured_guests: [],
        pressure_baseline: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:0:3344:0:32",
      };
      mockMemoryGrant.mockResolvedValueOnce({ data: grant, error: null })
        .mockResolvedValueOnce({ data: grant, error: { code: "PGRST205" } });
      for (const [host, vmid, restore] of [
        ["pve11", VMID, true], ["pve11", VMID, true], ["pve11", VMID, false],
        ["pve19", VMID, true], ["pve11", 9302, true],
      ] as const) {
        await runWakeHostScript(candidate, managed(host, vmid), { restore });
      }
      expect(mockMemoryGrant.mock.calls).toEqual(Array(2).fill([
        "get_hivra_canary_memory_overcommit", { p_host_id: "pve11", p_owner_id: "user_fixture" },
      ]));
      const scripts = mockRunScript.mock.calls.map(([script]) => String(script));
      expect(scripts[0]).toContain("HIVRA_CAPACITY_CANARY_OVERCOMMIT_MILLI=1100");
      expect(scripts.slice(1).every((script) => !script.includes("HIVRA_CAPACITY_CANARY_OVERCOMMIT_MILLI="))).toBe(true);
    } finally {
      replace.restore();
    }
  });

  it("returns at once for an awake agent, with no claim", async () => {
    mockReadRow.mockResolvedValue({ data: row({ sleep_state: "awake" }), error: null });
    await expect(ensureHivraAgentAwake(AGENT_ID, { trigger: "open" })).resolves.toEqual({ state: "awake" });
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("checks the marked QA seat before reporting it awake or claiming a wake", async () => {
    for (const sleep_state of ["awake", "hibernated"]) {
      const marked = row({ sleep_state, canary_qa_holder_expires_at: "2026-01-01T10:00:00.000Z" });
      mockReadRow.mockResolvedValue({ data: marked, error: null });
      mockLapsed.mockResolvedValue(true);
      await expect(ensureHivraAgentAwake(AGENT_ID, { trigger: "open" }))
        .resolves.toEqual({ state: "failed", reason: "lapsed" });
      expect(mockLapsed).toHaveBeenCalledWith(marked, "start");
      expect(mockClaim).not.toHaveBeenCalled();
      expect(mockRunScript).not.toHaveBeenCalled();
    }
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

  it("asks for a stored agent back and starts that work right after the response, without packing anything", async () => {
    resetStorageKicks();
    mockReadRow.mockResolvedValue({ data: row({ sleep_state: "hibernated", sleep_stored_at: "2026-11-01T00:00:00Z" }), error: null });
    mockRunStorage.mockResolvedValue({ counts: {}, errors: 0, returning: 1 });
    await expect(ensureHivraAgentAwake(AGENT_ID, { trigger: "open" }))
      .resolves.toEqual({ state: "waking", reason: "restoring_from_storage" });
    // It never claims the computer or runs the wake script: its disks are not there yet.
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockRunScript).not.toHaveBeenCalled();
    expect(mockAfter).toHaveBeenCalledTimes(1);
    await (mockAfter.mock.calls[0][0] as () => Promise<void>)();
    expect(mockRunStorage).toHaveBeenCalledTimes(1);
    const input = mockRunStorage.mock.calls[0][0] as { env: Record<string, unknown>; hostActs: (h: string) => Promise<boolean>; deadline: number; startBy: number };
    expect(input.env.HIVRA_SLEEP_STORE_AFTER_DAYS).toBeUndefined();
    await expect(input.hostActs("any")).resolves.toBe(false);
    expect(input.deadline - input.startBy).toBeGreaterThanOrEqual(65_000);
    // A page that asks again every few seconds does not start the work every time.
    await ensureHivraAgentAwake(AGENT_ID, { trigger: "open" });
    expect(mockAfter).toHaveBeenCalledTimes(1);
    // Outside a request there is nothing to run after: the answer is the same and the sweep does the work.
    resetStorageKicks();
    mockAfter.mockImplementation(() => { throw new Error("outside a request"); });
    await expect(ensureHivraAgentAwake(AGENT_ID, { trigger: "schedule" }))
      .resolves.toEqual({ state: "waking", reason: "restoring_from_storage" });
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
      detail: expect.objectContaining({ resume_ms: 120, fixup_ms: 300, fixup_via: "socket", fixup_tries: 1, from: "napping" }),
    }));
  });

  it("takes a host wake slot for a hibernated agent and releases it afterwards", async () => {
    mockReadRow.mockResolvedValue({ data: row({ sleep_state: "hibernated" }), error: null });
    const steps = {
      binding: 10, read_state: 40, allocation_lock: 60, locked_recheck: 90, hard_admission: 130, start_running: 240, guest_fixup: 300,
      admission: 130, start: 140, resume: 550, fixup: 310, lock: 5, agent: 20, exec: 180,
    };
    mockRunScript.mockResolvedValue({ ok: true, stdout: wakeReceipt({ from: "hibernated", reason: "restored", steps }), stderr: "" });
    const result = await ensureHivraAgentAwake(AGENT_ID, { trigger: "action", ...fast });
    expect(result.state).toBe("awake");
    expect(mockAcquire).toHaveBeenCalledWith({ vmid: VMID }, expect.objectContaining({ instanceId: AGENT_ID, neededRamMb: 4096 }));
    expect(mockRelease).toHaveBeenCalledTimes(1);
    // The restore runs under the capacity policy the start action uses.
    expect(String(mockRunScript.mock.calls[0][0])).toContain("/opt/hivra/provisioner");
    expect(mockRunScript).toHaveBeenCalledTimes(1);
    expect(mockSsrfFetch).toHaveBeenCalledTimes(1);
    expect(mockRunScript.mock.invocationCallOrder[0]).toBeLessThan(mockSsrfFetch.mock.invocationCallOrder[0]);
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: "wake",
      detail: expect.objectContaining({
        binding_ms: 10, read_state_ms: 40, allocation_lock_ms: 60, locked_recheck_ms: 90, hard_admission_ms: 130,
        start_running_ms: 240, guest_fixup_ms: 300, healthz_ms: expect.any(Number), healthz_attempts: 1,
        admission_ms: 130, start_ms: 140, resume_ms: 550, fixup_ms: 310, lock_ms: 5, agent_ms: 20, exec_ms: 180,
      }),
    }));
  });

  it("records the hard admission refusal without starting public readiness", async () => {
    mockReadRow.mockResolvedValue({ data: row({ sleep_state: "hibernated" }), error: null });
    mockRunScript.mockResolvedValue({ ok: true, stdout: wakeReceipt({
      ok: false, from: "hibernated", to: "hibernated", reason: "capacity",
      steps: { binding: 10, read_state: 40, allocation_lock: 60, locked_recheck: 90, hard_admission: 130 },
    }), stderr: "" });
    await expect(ensureHivraAgentAwake(AGENT_ID, { trigger: "action", ...fast })).resolves.toEqual({ state: "failed", reason: "capacity" });
    expect(mockRunScript).toHaveBeenCalledTimes(1);
    expect(mockSsrfFetch).not.toHaveBeenCalled();
    expect(mockFinish).toHaveBeenCalledWith(expect.objectContaining({ result: "wake_failed" }));
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: "fail", reason: "capacity",
      detail: expect.objectContaining({ allocation_lock_ms: 60, locked_recheck_ms: 90, hard_admission_ms: 130 }),
    }));
    expect(mockLogEvent.mock.calls[0][0].detail).not.toHaveProperty("healthz_ms");
  });

  it("treats a retry after a failed wake as a restore: a host slot and the longer script limit", async () => {
    mockReadRow.mockResolvedValue({ data: row({ sleep_state: "wake_failed" }), error: null });
    mockRunScript.mockResolvedValue({ ok: true, stdout: wakeReceipt({ from: "hibernated", reason: "restored" }), stderr: "" });
    const result = await ensureHivraAgentAwake(AGENT_ID, { trigger: "action", ...fast });
    expect(result.state).toBe("awake");
    expect(mockAcquire).toHaveBeenCalledTimes(1);
    expect(mockRunScript.mock.calls[0][2]).toEqual({ timeoutMs: 120_000 });
    mockRunScript.mockClear();
    mockAcquire.mockClear();
    mockReadRow.mockResolvedValue({ data: row({ sleep_state: "napping" }), error: null });
    mockRunScript.mockResolvedValue({ ok: true, stdout: wakeReceipt(), stderr: "" });
    await ensureHivraAgentAwake(AGENT_ID, { trigger: "action", ...fast });
    expect(mockAcquire).not.toHaveBeenCalled();
    expect(mockRunScript.mock.calls[0][2]).toEqual({ timeoutMs: 60_000 });
  });

  it("finishes as wake_failed with reason busy when a sleep still holds the computer, and does not call it awake", async () => {
    mockReadRow.mockResolvedValue({ data: row(), error: null });
    mockRunScript.mockResolvedValue({ ok: true, stdout: wakeReceipt({ ok: false, to: "awake", reason: "busy" }), stderr: "" });
    const result = await ensureHivraAgentAwake(AGENT_ID, { trigger: "open", ...fast });
    expect(result).toEqual({ state: "failed", reason: "busy" });
    expect(mockFinish).toHaveBeenCalledWith(expect.objectContaining({ result: "wake_failed" }));
  });

  it("keeps the same wake lease and leaves it running after the interactive wait", async () => {
    jest.useFakeTimers();
    try {
      const onBackground = jest.fn();
      mockReadRow.mockResolvedValue({ data: row({ sleep_state: "hibernated" }), error: null });
      mockAcquire.mockImplementation(() => new Promise((resolve) => setTimeout(() =>
        resolve({ admitted: true, freeMb: 9000, activeWakes: 3, waitedForConcurrency: true }), 75_000)));
      mockRunScript.mockImplementation(() => new Promise((resolve) => setTimeout(() =>
        resolve({ ok: true, stdout: wakeReceipt({ from: "hibernated", reason: "restored" }), stderr: "" }), 120_000)));
      for (let i = 0; i < 5; i++) {
        mockSsrfFetch.mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve({ status: 503 }), 4_000)));
      }
      mockSsrfFetch.mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve({ status: 200 }), 4_000)));
      const pending = ensureHivraAgentAwake(AGENT_ID, {
        trigger: "open", onBackground, workDeadlineMs: Date.now() + MANAGED_WAKE_WORK_BUDGET_MS, ...fast,
      });
      await jest.advanceTimersByTimeAsync(45_000);
      expect(await pending).toEqual({ state: "waking", reason: "in_progress" });
      expect(mockRunScript).not.toHaveBeenCalled();
      expect(mockFinish).not.toHaveBeenCalled();
      expect(onBackground).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(75_000 + 120_000 + 29_000 - 45_000);
      await expect(onBackground.mock.calls[0][0]).resolves.toMatchObject({ state: "awake" });
      expect(mockClaim).toHaveBeenCalledTimes(1);
      expect(mockAcquire).toHaveBeenCalledTimes(1);
      expect(mockAcquire).toHaveBeenCalledWith({ vmid: VMID }, expect.objectContaining({ waitForConcurrencySeconds: WAKE_TURN_WAIT_SECONDS }));
      expect(mockFinish).toHaveBeenCalledWith({ ...mockClaim.mock.calls[0][0], result: "awake" });
      expect(mockRunScript.mock.calls[0][2]).toEqual({ timeoutMs: 120_000 });
      expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
        durationMs: 224_000, detail: expect.objectContaining({ slot_admission_ms: 75_000 }),
      }));
    } finally {
      jest.useRealTimers();
    }
  });

  it("releases the host slot before waiting for public readiness, but keeps the wake lease", async () => {
    mockReadRow.mockResolvedValue({ data: row({ sleep_state: "hibernated" }), error: null });
    mockRunScript.mockResolvedValue({ ok: true, stdout: wakeReceipt({ from: "hibernated", reason: "restored" }), stderr: "" });
    let resolveHealth!: (response: { status: number }) => void;
    let healthStarted!: () => void;
    const waitingForHealth = new Promise<void>((resolve) => { healthStarted = resolve; });
    mockSsrfFetch.mockImplementation(() => new Promise((resolve) => { resolveHealth = resolve; healthStarted(); }));
    const pending = ensureHivraAgentAwake(AGENT_ID, { trigger: "open", ...fast });
    await waitingForHealth;
    expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(mockFinish).not.toHaveBeenCalled();
    resolveHealth({ status: 200 });
    await expect(pending).resolves.toMatchObject({ state: "awake" });
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("asks the server again when the connection for the wake was refused, and wakes", async () => {
    // Seen on Canary: twelve wakes at once, the server dropped one login, and that wake failed in under a second.
    mockReadRow.mockResolvedValue({ data: row(), error: null });
    mockRunScript
      .mockResolvedValueOnce({ ok: false, stdout: "", stderr: "", error: "SSH connection failed: Connection lost before handshake" })
      .mockResolvedValue({ ok: true, stdout: wakeReceipt(), stderr: "" });
    const result = await ensureHivraAgentAwake(AGENT_ID, { trigger: "open", waitMs: 20_000, ...fast });
    expect(result.state).toBe("awake");
    expect(mockRunScript).toHaveBeenCalledTimes(2);
  });

  it("does not repeat a host call that ran and failed", async () => {
    mockReadRow.mockResolvedValue({ data: row(), error: null });
    mockRunScript.mockResolvedValue({ ok: false, stdout: "partial output", stderr: "", error: "SSH connection failed: read ECONNRESET" });
    const result = await ensureHivraAgentAwake(AGENT_ID, { trigger: "open", waitMs: 20_000, ...fast });
    expect(result.state).toBe("failed");
    expect(mockRunScript).toHaveBeenCalledTimes(1);
  });

  it("starts four deep-sleep wakes at once per server unless a setting says otherwise", () => {
    expect(wakesAtOncePerHost({})).toBe("4");
    expect(wakesAtOncePerHost({ HERMES_WAKE_MAX_CONCURRENT_PER_HOST: "2" })).toBe("2");
    expect(wakesAtOncePerHost({ HIVRA_WAKE_MAX_CONCURRENT_PER_HOST: "6", HERMES_WAKE_MAX_CONCURRENT_PER_HOST: "2" })).toBe("6");
    expect(wakesAtOncePerHost({ HIVRA_WAKE_MAX_CONCURRENT_PER_HOST: "many" })).toBe("4");
    expect(wakesAtOncePerHost({ HIVRA_WAKE_MAX_CONCURRENT_PER_HOST: "0" })).toBe("4");
  });

  it("gives up as wake_failed when no turn comes within the wait", async () => {
    jest.useFakeTimers();
    try {
      mockReadRow.mockResolvedValue({ data: row({ sleep_state: "hibernated" }), error: null });
      mockAcquire.mockImplementation(() => new Promise((resolve) => setTimeout(() =>
        resolve({ admitted: false, reason: "concurrency", freeMb: 9000, activeWakes: 4, cap: 4, retryAfterSeconds: 30 }),
      WAKE_TURN_WAIT_SECONDS * 1000)));
      const pending = ensureHivraAgentAwake(AGENT_ID, {
        trigger: "open", waitMs: 120_000, workDeadlineMs: Date.now() + MANAGED_WAKE_WORK_BUDGET_MS, ...fast,
      });
      await jest.advanceTimersByTimeAsync(WAKE_TURN_WAIT_SECONDS * 1000);
      expect(await pending).toEqual({ state: "failed", reason: "capacity_concurrency" });
      expect(mockRunScript).not.toHaveBeenCalled();
      expect(mockAcquire).toHaveBeenCalledTimes(1);
      expect(mockFinish).toHaveBeenCalledWith({ ...mockClaim.mock.calls[0][0], result: "wake_failed" });
      expect(mockMakeRoom).not.toHaveBeenCalled();
      expect(mockRelease).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not wait for a slot when the caller cannot retain a full restore", async () => {
    mockReadRow.mockResolvedValue({ data: row({ sleep_state: "hibernated" }), error: null });
    mockAcquire.mockResolvedValue({ admitted: false, reason: "concurrency", freeMb: 9000, activeWakes: 4, cap: 4, retryAfterSeconds: 30 });
    await expect(ensureHivraAgentAwake(AGENT_ID, { trigger: "action", ...fast }))
      .resolves.toEqual({ state: "failed", reason: "capacity_concurrency" });
    expect(mockAcquire).toHaveBeenCalledTimes(1);
    expect(mockAcquire).toHaveBeenCalledWith({ vmid: VMID }, expect.objectContaining({ waitForConcurrencySeconds: 0 }));
    expect(mockRunScript).not.toHaveBeenCalled();
  });

  it("reserves the disk boot budgets instead of granting the full hibernate wait", async () => {
    const env = jest.replaceProperty(process, "env", { ...process.env, HIVRA_SLEEP_DROP_MEMORY_AFTER_DAYS: "7" });
    jest.useFakeTimers();
    try {
      mockReadRow.mockResolvedValue({ data: row({ sleep_state: "hibernated" }), error: null });
      mockRunScript.mockResolvedValue({ ok: true, stdout: wakeReceipt({ from: "hibernated", reason: "cold_started" }), stderr: "" });
      const pending = ensureHivraAgentAwake(AGENT_ID, {
        trigger: "open", workDeadlineMs: Date.now() + MANAGED_WAKE_WORK_BUDGET_MS, ...fast,
      });
      await jest.advanceTimersByTimeAsync(0);
      await expect(pending).resolves.toMatchObject({ state: "awake" });
      expect(mockAcquire).toHaveBeenCalledWith({ vmid: VMID }, expect.objectContaining({ waitForConcurrencySeconds: 20 }));
      expect(mockRunScript.mock.calls[0][2]).toEqual({ timeoutMs: 170_000 });
    } finally {
      jest.useRealTimers();
      env.restore();
    }
  });

  it("does not start a restore when strict slot admission is unavailable", async () => {
    mockReadRow.mockResolvedValue({ data: row({ sleep_state: "hibernated" }), error: null });
    mockAcquire.mockResolvedValue({ admitted: false, reason: "unavailable", freeMb: null, activeWakes: null, cap: 4, retryAfterSeconds: 30 });
    await expect(ensureHivraAgentAwake(AGENT_ID, {
      trigger: "open", workDeadlineMs: Date.now() + MANAGED_WAKE_WORK_BUDGET_MS, ...fast,
    })).resolves.toEqual({ state: "failed", reason: "capacity_unavailable" });
    expect(mockRunScript).not.toHaveBeenCalled();
    expect(mockFinish).toHaveBeenCalledWith(expect.objectContaining({ result: "wake_failed" }));
  });

  it("finishes as wake_failed when the host defers the wake, and runs no script", async () => {
    mockReadRow.mockResolvedValue({ data: row({ sleep_state: "hibernated" }), error: null });
    mockAcquire.mockResolvedValue({ admitted: false, reason: "host_ram", freeMb: 100, activeWakes: 1, cap: 2, retryAfterSeconds: 30 });
    const result = await ensureHivraAgentAwake(AGENT_ID, { trigger: "open", ...fast });
    expect(result).toEqual({ state: "failed", reason: "capacity_host_ram" });
    expect(mockRunScript).not.toHaveBeenCalled();
    expect(mockAcquire).toHaveBeenCalledTimes(1);
    expect(mockFinish).toHaveBeenCalledWith(expect.objectContaining({ result: "wake_failed" }));
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "fail", reason: "capacity_host_ram" }));
    expect(mockRelease).toHaveBeenCalled();
  });

  it("with making room on, a wake short of memory deepens nappers and then wakes", async () => {
    mockRoomEnabled.mockReturnValue(true);
    mockReadRow.mockResolvedValue({ data: row({ sleep_state: "hibernated" }), error: null });
    mockAcquire
      .mockResolvedValueOnce({ admitted: false, reason: "host_ram", freeMb: 100, activeWakes: 0, cap: 4, retryAfterSeconds: 30 })
      .mockResolvedValue({ admitted: true, freeMb: 6000, activeWakes: 0 });
    mockMakeRoom.mockImplementation(async (input: { fits: () => Promise<boolean> }) => {
      expect(await input.fits()).toBe(true);
      return { fits: true, deepened: 1, tried: 1, ms: 10_000 };
    });
    mockRunScript.mockResolvedValue({ ok: true, stdout: wakeReceipt({ from: "hibernated", reason: "restored" }), stderr: "" });
    const result = await ensureHivraAgentAwake(AGENT_ID, { trigger: "open", ...fast });
    expect(result.state).toBe("awake");
    expect(mockMakeRoom).toHaveBeenCalledTimes(1);
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "wake", detail: expect.objectContaining({ room_deepened: 1 }) }));
  });

  it("with making room on and no napper to deepen, the wake is still refused", async () => {
    mockRoomEnabled.mockReturnValue(true);
    mockReadRow.mockResolvedValue({ data: row({ sleep_state: "hibernated" }), error: null });
    mockAcquire.mockResolvedValue({ admitted: false, reason: "host_ram", freeMb: 100, activeWakes: 0, cap: 4, retryAfterSeconds: 30 });
    mockMakeRoom.mockResolvedValue({ fits: false, deepened: 0, tried: 0, ms: 5 });
    const result = await ensureHivraAgentAwake(AGENT_ID, { trigger: "open", ...fast });
    expect(result).toEqual({ state: "failed", reason: "capacity_host_ram" });
    expect(mockRunScript).not.toHaveBeenCalled();
  });

  it("with making room on, a start the server's capacity check refused is tried again after making room", async () => {
    mockRoomEnabled.mockReturnValue(true);
    mockReadRow.mockResolvedValue({ data: row({ sleep_state: "hibernated" }), error: null });
    mockRunScript
      .mockResolvedValueOnce({ ok: true, stdout: wakeReceipt({ ok: false, from: "hibernated", to: "hibernated", reason: "capacity" }), stderr: "" })
      .mockResolvedValue({ ok: true, stdout: wakeReceipt({ from: "hibernated", reason: "restored" }), stderr: "" });
    mockMakeRoom.mockImplementation(async (input: { fits: () => Promise<boolean> }) => {
      expect(await input.fits()).toBe(true);
      return { fits: true, deepened: 2, tried: 2, ms: 20_000 };
    });
    const result = await ensureHivraAgentAwake(AGENT_ID, { trigger: "open", ...fast });
    expect(result.state).toBe("awake");
    expect(mockRunScript).toHaveBeenCalledTimes(2);
  });

  it("with making room off, a capacity refusal fails the wake and no napper is touched", async () => {
    mockReadRow.mockResolvedValue({ data: row({ sleep_state: "hibernated" }), error: null });
    mockRunScript.mockResolvedValue({ ok: true, stdout: wakeReceipt({ ok: false, from: "hibernated", to: "hibernated", reason: "capacity" }), stderr: "" });
    const result = await ensureHivraAgentAwake(AGENT_ID, { trigger: "open", ...fast });
    expect(result).toEqual({ state: "failed", reason: "capacity" });
    expect(mockMakeRoom).not.toHaveBeenCalled();
  });

  it.each(["capacity_pilot", "pilot_start_unconfirmed"])("never turns %s into an ordinary cold start or makes room", async (reason) => {
    mockRoomEnabled.mockReturnValue(true);
    mockReadRow.mockResolvedValue({ data: row({ sleep_state: "hibernated" }), error: null });
    mockRunScript.mockResolvedValue({ ok: true, stdout: wakeReceipt({ ok: false, from: "hibernated", to: "cold", reason }), stderr: "" });
    await expect(ensureHivraAgentAwake(AGENT_ID, { trigger: "open", ...fast }))
      .resolves.toEqual({ state: "failed", reason });
    expect(mockMakeRoom).not.toHaveBeenCalled();
    expect(mockRunScript).toHaveBeenCalledTimes(1);
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
      .mockResolvedValueOnce({ data: live("draining"), error: null })
      .mockResolvedValueOnce({ data: live("draining"), error: null })
      .mockResolvedValueOnce({ data: live("waking", "wake"), error: null })
      .mockResolvedValue({ data: row({ sleep_state: "awake" }), error: null });
    await expect(ensureHivraAgentAwake(AGENT_ID, { trigger: "open", waitMs: 5000, ...fast })).resolves.toEqual({ state: "awake" });
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("returns waking when the wait runs out on a transient state", async () => {
    mockReadRow.mockResolvedValue({ data: live("hibernating"), error: null });
    await expect(ensureHivraAgentAwake(AGENT_ID, { trigger: "open", waitMs: 20, ...fast })).resolves.toEqual({ state: "waking", reason: "still_settling" });
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it("settles a transient state nobody is working on from the host, instead of waiting for the sweep", async () => {
    for (const stuck of [abandoned("hibernating"), abandoned("waking", "wake"), row({ sleep_state: "draining", operation_id: null })]) {
      mockReconcile.mockReset();
      mockReadRow
        .mockResolvedValueOnce({ data: stuck, error: null })
        .mockResolvedValueOnce({ data: stuck, error: null })
        .mockResolvedValue({ data: row({ sleep_state: "awake" }), error: null });
      mockReconcile.mockResolvedValue({ outcome: "settled", to: "awake", hostState: "awake", why: "stale_lease" });
      await expect(ensureHivraAgentAwake(AGENT_ID, { trigger: "open", waitMs: 5000, ...fast })).resolves.toEqual({ state: "awake" });
      expect(mockReconcile).toHaveBeenCalledTimes(1);
      expect(mockReconcile.mock.calls[0][0]).toMatchObject({ id: AGENT_ID });
    }
  });

  it("settles a stuck row only once per call, then falls back to waiting, and survives a reconcile that throws", async () => {
    mockReadRow.mockResolvedValue({ data: abandoned("hibernating"), error: null });
    mockReconcile.mockRejectedValue(new Error("boom"));
    await expect(ensureHivraAgentAwake(AGENT_ID, { trigger: "open", waitMs: 30, ...fast })).resolves.toEqual({ state: "waking", reason: "still_settling" });
    expect(mockReconcile).toHaveBeenCalledTimes(1);
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("claims a wake once the stuck row has been settled to napping", async () => {
    mockReadRow
      .mockResolvedValueOnce({ data: abandoned("draining"), error: null })
      .mockResolvedValue({ data: row({ sleep_state: "napping" }), error: null });
    mockReconcile.mockResolvedValue({ outcome: "settled", to: "napping", hostState: "napping", why: "stale_lease" });
    await expect(ensureHivraAgentAwake(AGENT_ID, { trigger: "open", waitMs: 5000, ...fast })).resolves.toMatchObject({ state: "awake" });
    expect(mockClaim).toHaveBeenCalledTimes(1);
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

describe("ensureHivraAgentAwake with the fast wake switches", () => {
  const previous = process.env.HIVRA_FAST_WAKE;
  beforeEach(() => {
    jest.resetAllMocks();
    mockLapsed.mockResolvedValue(false);
    mockClaim.mockResolvedValue("claimed");
    mockFinish.mockResolvedValue(true);
    mockLogEvent.mockResolvedValue(true);
    mockResolveTarget.mockResolvedValue({ ok: true, target });
    mockRunScript.mockResolvedValue({ ok: true, stdout: wakeReceipt(), stderr: "" });
    mockSsrfFetch.mockResolvedValue({ status: 200 });
    mockReadRow
      .mockResolvedValueOnce({ data: row(), error: null })
      .mockResolvedValue({ data: row({ sleep_state: "awake", sleep_generation: 6 }), error: null });
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.HIVRA_FAST_WAKE;
    else process.env.HIVRA_FAST_WAKE = previous;
  });

  it("with every switch off, runs the script and records the event exactly as before", async () => {
    delete process.env.HIVRA_FAST_WAKE;
    const background = jest.fn();
    await ensureHivraAgentAwake(AGENT_ID, { trigger: "open", onBackground: background, ...fast });
    expect(mockRunScript.mock.calls[0][2]).toEqual({ timeoutMs: 60_000 });
    const script = String(mockRunScript.mock.calls[0][0]);
    expect(script).toContain('CONFIG="$(qm config "$VMID" 2>/dev/null)" || finish false unreachable');
    expect(script).not.toContain('CONFIG="$(hivra_fast_qm config');
    expect(background).not.toHaveBeenCalled();
    const detail = mockLogEvent.mock.calls[0][0].detail;
    expect(detail).not.toHaveProperty("host_ms");
    expect(detail).not.toHaveProperty("ssh_ready_ms");
  });

  it("timing: records the host's own time and when SSH was ready", async () => {
    process.env.HIVRA_FAST_WAKE = "timing";
    mockRunScript.mockResolvedValue({ ok: true, stdout: wakeReceipt(), stderr: "", sshReadyMs: 310 });
    await ensureHivraAgentAwake(AGENT_ID, { trigger: "open", ...fast });
    expect(mockRunScript.mock.calls[0][2]).toEqual({ timeoutMs: 60_000, reportTimings: true });
    expect(mockLogEvent.mock.calls[0][0].detail).toEqual(expect.objectContaining({ host_ms: 900, ssh_ready_ms: 310 }));
  });

  it("early_finish: asks for the answer once the whole receipt line is in", async () => {
    process.env.HIVRA_FAST_WAKE = "early_finish";
    await ensureHivraAgentAwake(AGENT_ID, { trigger: "open", ...fast });
    expect(mockRunScript.mock.calls[0][2]).toEqual({
      timeoutMs: 60_000, earlyFinishMarker: "HIVRA_WAKE_RESULT", earlyFinishOnLine: true,
    });
  });

  it("fast_qm: the binding check reads the config file", async () => {
    process.env.HIVRA_FAST_WAKE = "fast_qm";
    await ensureHivraAgentAwake(AGENT_ID, { trigger: "open", ...fast });
    expect(String(mockRunScript.mock.calls[0][0])).toContain('CONFIG="$(hivra_fast_qm config "$VMID" 2>/dev/null)" || finish false unreachable');
  });

  it("deferred_log: answers before the event is written, and hands the write to after()", async () => {
    process.env.HIVRA_FAST_WAKE = "deferred_log";
    let release: (value: unknown) => void = () => undefined;
    mockLogEvent.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const background = jest.fn();
    const result = await ensureHivraAgentAwake(AGENT_ID, { trigger: "open", onBackground: background, ...fast });
    expect(result).toEqual(expect.objectContaining({ state: "awake", reason: "resumed" }));
    // The lease was given back before the answer.
    expect(mockFinish).toHaveBeenCalledWith(expect.objectContaining({ result: "awake" }));
    expect(background).toHaveBeenCalledTimes(1);
    release(true);
    await background.mock.calls[0][0];
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "wake", generation: 6 }));
  });

  it("deferred_log: still awaits the event when there is no after() to hand it to", async () => {
    process.env.HIVRA_FAST_WAKE = "deferred_log";
    await ensureHivraAgentAwake(AGENT_ID, { trigger: "open", ...fast });
    expect(mockLogEvent).toHaveBeenCalledTimes(1);
  });

  it("deferred_log: a write that fails after the answer does not throw", async () => {
    process.env.HIVRA_FAST_WAKE = "deferred_log";
    mockLogEvent.mockRejectedValue(new Error("log down"));
    const background = jest.fn();
    await expect(ensureHivraAgentAwake(AGENT_ID, { trigger: "open", onBackground: background, ...fast }))
      .resolves.toEqual(expect.objectContaining({ state: "awake" }));
    await expect(background.mock.calls[0][0]).resolves.toBeUndefined();
  });

  it("deferred_log: reads the row at once when the lease could not be given back", async () => {
    process.env.HIVRA_FAST_WAKE = "deferred_log";
    mockFinish.mockResolvedValue(false);
    const background = jest.fn();
    await expect(ensureHivraAgentAwake(AGENT_ID, { trigger: "open", onBackground: background, ...fast }))
      .resolves.toEqual(expect.objectContaining({ state: "awake" }));
    expect(background).not.toHaveBeenCalled();
    expect(mockLogEvent).toHaveBeenCalledTimes(1);
  });

  it("deferred_log: a wake that outlives the wait awaits its own event inside the background work", async () => {
    process.env.HIVRA_FAST_WAKE = "deferred_log";
    let release: (value: unknown) => void = () => undefined;
    mockRunScript.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const background = jest.fn();
    const result = await ensureHivraAgentAwake(AGENT_ID, { trigger: "open", waitMs: 20, onBackground: background, ...fast });
    expect(result).toEqual({ state: "waking", reason: "in_progress" });
    release({ ok: true, stdout: wakeReceipt(), stderr: "" });
    await background.mock.calls[0][0];
    // Only the wake itself was handed on; its event was written inside it.
    expect(background).toHaveBeenCalledTimes(1);
    expect(mockLogEvent).toHaveBeenCalledTimes(1);
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

  it("polls every 150 ms for the first seconds when asked, and at the normal interval otherwise", async () => {
    const slow = await pollPublicHealthz("a.example.test", { fetchImpl: jest.fn().mockRejectedValue(new Error("down")), budgetMs: 1000 });
    expect(slow.attempts).toBe(1);
    const quick = await pollPublicHealthz("a.example.test", {
      fetchImpl: jest.fn().mockRejectedValue(new Error("down")), budgetMs: 1000, fastStart: true,
    });
    expect(quick.up).toBe(false);
    expect(quick.attempts).toBeGreaterThanOrEqual(4);
    expect(quick.ms).toBeLessThan(1000);
  });
});

describe("isStuckTransient", () => {
  const now = Date.UTC(2026, 10, 12, 12, 0, 0);
  const lease = (state: string, ageMs: number, kind = "sleep") => ({
    sleep_state: state, operation_id: "op", operation_kind: kind, operation_started_at: new Date(now - ageMs).toISOString(),
  });
  it("is true for a transient state with no lease, or a sleep or wake lease past the stale age", () => {
    expect(isStuckTransient({ sleep_state: "draining", operation_id: null }, now)).toBe(true);
    expect(isStuckTransient(lease("hibernating", 6 * 60_000), now)).toBe(true);
    expect(isStuckTransient(lease("waking", 20 * 60_000, "wake"), now)).toBe(true);
  });
  it("is false for a fresh lease, another operation's lease, a settled state, or a row whose lease is not known", () => {
    expect(isStuckTransient(lease("hibernating", 60_000), now)).toBe(false);
    expect(isStuckTransient(lease("hibernating", 60 * 60_000, "restart"), now)).toBe(false);
    expect(isStuckTransient({ sleep_state: "napping", operation_id: null }, now)).toBe(false);
    expect(isStuckTransient({ sleep_state: "awake", operation_id: null }, now)).toBe(false);
    expect(isStuckTransient({ sleep_state: "draining" }, now)).toBe(false);
    expect(isStuckTransient(lease("draining", 0, "sleep"), now)).toBe(false);
  });
});
