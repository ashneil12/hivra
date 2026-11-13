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

const mockReconcile = jest.fn();
jest.mock("../sleep-reconcile", () => ({ reconcileAgentSleep: (...a: unknown[]) => mockReconcile(...a) }));

const mockSsrfFetch = jest.fn();
jest.mock("@/lib/ssrf-safe-fetch", () => ({ ssrfSafeFetch: (...a: unknown[]) => mockSsrfFetch(...a) }));

const order: string[] = [];
const mockDisarm = jest.fn();
const mockRearm = jest.fn();
jest.mock("../telegram-wake/lifecycle", () => ({
  disarmTelegramForWake: (...a: unknown[]) => mockDisarm(...a),
  rearmTelegramAfterFailedWake: (...a: unknown[]) => mockRearm(...a),
}));

import { ensureHivraAgentAwake } from "../agent-wake";

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


const disarmed = { previous: "armed", called: true, ok: true, ms: 37 };

describe("ensureHivraAgentAwake with a Telegram wake webhook", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    jest.resetAllMocks();
    order.length = 0;
    mockLapsed.mockResolvedValue(false);
    mockClaim.mockResolvedValue("claimed");
    mockFinish.mockResolvedValue(true);
    mockLogEvent.mockResolvedValue(true);
    mockResolveTarget.mockResolvedValue({ ok: true, target });
    mockRunScript.mockImplementation(async () => { order.push("host_script"); return { ok: true, stdout: wakeReceipt(), stderr: "" }; });
    mockAcquire.mockImplementation(async () => { order.push("admission"); return { admitted: true, freeMb: 9000, activeWakes: 0 }; });
    mockRelease.mockResolvedValue(undefined);
    mockSsrfFetch.mockResolvedValue({ status: 200 });
    mockDisarm.mockImplementation(async () => {
      // The delete must have finished before the host script starts.
      await new Promise((r) => setTimeout(r, 20));
      order.push("disarm_done");
      return disarmed;
    });
    mockRearm.mockResolvedValue(undefined);
    mockReadRow.mockResolvedValue({ data: row(), error: null });
  });
  afterEach(() => { process.env = { ...saved }; });

  it("deletes the webhook after admission and before the host resumes the computer, and records the time", async () => {
    mockReadRow.mockResolvedValue({ data: row({ sleep_state: "hibernated" }), error: null });
    mockRunScript.mockImplementation(async () => {
      order.push("host_script");
      return { ok: true, stdout: wakeReceipt({ from: "hibernated", reason: "restored" }), stderr: "" };
    });
    const result = await ensureHivraAgentAwake(AGENT_ID, { trigger: "telegram", ...fast });
    expect(result.state).toBe("awake");
    expect(order).toEqual(["admission", "disarm_done", "host_script"]);
    expect(mockDisarm).toHaveBeenCalledWith(AGENT_ID);
    expect(mockRearm).not.toHaveBeenCalled();
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      trigger: "telegram",
      detail: expect.objectContaining({ tg_disarm_ms: 37, tg_disarm_ok: true }),
    }));
  });

  it("keeps the bot armed when admission refuses the wake", async () => {
    mockReadRow.mockResolvedValue({ data: row({ sleep_state: "hibernated" }), error: null });
    mockAcquire.mockResolvedValue({ admitted: false, reason: "host_ram", freeMb: 100, activeWakes: 1, cap: 2, retryAfterSeconds: 30 });
    const result = await ensureHivraAgentAwake(AGENT_ID, { trigger: "telegram", ...fast });
    expect(result).toEqual({ state: "failed", reason: "capacity_host_ram" });
    expect(mockDisarm).not.toHaveBeenCalled();
    expect(mockRunScript).not.toHaveBeenCalled();
    expect(mockRearm).not.toHaveBeenCalled();
  });

  it("keeps the bot armed when the host target cannot be resolved", async () => {
    mockResolveTarget.mockResolvedValue({ ok: false, code: "host_unknown" });
    const result = await ensureHivraAgentAwake(AGENT_ID, { trigger: "telegram", ...fast });
    expect(result.state).toBe("failed");
    expect(mockDisarm).not.toHaveBeenCalled();
  });

  it("puts the row back to waiting for the sweep when the wake fails after the delete", async () => {
    mockRunScript.mockResolvedValue({ ok: true, stdout: wakeReceipt({ ok: false, to: "napping", reason: "resume_failed" }), stderr: "" });
    const result = await ensureHivraAgentAwake(AGENT_ID, { trigger: "telegram", ...fast });
    expect(result).toEqual({ state: "failed", reason: "resume_failed" });
    expect(mockRearm).toHaveBeenCalledWith(AGENT_ID, disarmed);
  });

  it("goes on with the wake when the delete failed, and says so in the event", async () => {
    mockDisarm.mockResolvedValue({ previous: "armed", called: true, ok: false, ms: 5000 });
    const result = await ensureHivraAgentAwake(AGENT_ID, { trigger: "telegram", ...fast });
    expect(result.state).toBe("awake");
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.objectContaining({ tg_disarm_ok: false }) }));
  });

  it("adds nothing to the event when there was no webhook, and kills stale sockets only with the switch on", async () => {
    mockDisarm.mockResolvedValue(null);
    await ensureHivraAgentAwake(AGENT_ID, { trigger: "open", ...fast });
    const detail = mockLogEvent.mock.calls[0][0].detail;
    expect(detail).not.toHaveProperty("tg_disarm_ms");
    expect(String(mockRunScript.mock.calls[0][0])).not.toContain('fixup "$VMID" "$AGENT_WAIT" sockets');
    process.env.HIVRA_TELEGRAM_WAKE = "on";
    process.env.HIVRA_TELEGRAM_WAKE_SECRET = "x".repeat(40);
    process.env.HIVRA_TELEGRAM_WAKE_BASE_URL = "https://hooks.example.test/api/webhooks/telegram-wake";
    await ensureHivraAgentAwake(AGENT_ID, { trigger: "open", ...fast });
    expect(String(mockRunScript.mock.calls[1][0])).toContain('fixup "$VMID" "$AGENT_WAIT" sockets');
  });
});
