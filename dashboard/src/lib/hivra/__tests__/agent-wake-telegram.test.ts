/** @jest-environment node */

import { NextRequest } from "next/server";
import { encryptSecret } from "@/lib/crypto";
import { createSupabaseMemoryDb, type SupabaseMemoryDb } from "@/test-utils/supabase-memory-db";
import { POST } from "@/app/api/webhooks/telegram-wake/[agentId]/route";
import { telegramWakeSecretToken } from "../telegram-wake/config";

const mockReadRow = jest.fn();
let mockChannelDb: SupabaseMemoryDb;
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table !== "hivra_agents") return mockChannelDb.db.from(table);
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) q[m] = () => q;
      q.maybeSingle = () => mockReadRow();
      return q;
    },
  },
}));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
const mockAfter = jest.fn();
jest.mock("next/server", () => ({ ...jest.requireActual("next/server"), after: (task: () => unknown) => mockAfter(task) }));

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
const mockSettle = jest.fn();
jest.mock("../telegram-wake/lifecycle", () => ({
  ...jest.requireActual("../telegram-wake/lifecycle"),
  disarmTelegramForWake: (...a: unknown[]) => mockDisarm(...a),
  rearmTelegramAfterFailedWake: (...a: unknown[]) => mockRearm(...a),
  settleTelegramAfterWake: (...a: unknown[]) => mockSettle(...a),
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
    mockChannelDb = createSupabaseMemoryDb({ tables: ["hivra_agent_telegram_wake", "hivra_agent_channel_wake"] });
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
    mockSettle.mockResolvedValue(undefined);
    mockReadRow.mockResolvedValue({ data: row(), error: null });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...saved };
  });

  it("authenticates the current Telegram arm, then leaves one failed wake ready to re-arm", async () => {
    const armId = "22222222-2222-4222-8222-222222222222";
    const staleArmId = "33333333-3333-4333-8333-333333333333";
    const signingSeed = "x".repeat(40);
    const botToken = `123456789:${"Ab_-".repeat(9)}`;
    process.env.HIVRA_TELEGRAM_WAKE_SECRET = signingSeed;
    process.env.ENCRYPTION_KEY = "ef".repeat(32);
    mockChannelDb.insertRow("hivra_agent_telegram_wake", {
      agent_id: AGENT_ID, user_id: "user-1", enabled: true, arm_id: armId, state: "armed",
      token_enc: encryptSecret(botToken), pending_since: null, next_attempt_at: null,
    });
    const lifecycle = jest.requireActual<typeof import("../telegram-wake/lifecycle")>("../telegram-wake/lifecycle");
    mockDisarm.mockImplementation(lifecycle.disarmTelegramForWake);
    mockRearm.mockImplementation(lifecycle.rearmTelegramAfterFailedWake);
    const fetchStub = jest.spyOn(globalThis, "fetch").mockImplementation(async () => {
      order.push("delete_webhook");
      return Response.json({ ok: true, result: true });
    });
    mockRunScript.mockImplementation(async () => {
      order.push("host_script");
      return { ok: true, stdout: wakeReceipt({ ok: false, to: "napping", reason: "resume_failed" }), stderr: "" };
    });
    const call = (arm: string) => POST(new NextRequest(
      `https://hooks.example.test/api/webhooks/telegram-wake/${AGENT_ID}`,
      {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": telegramWakeSecretToken(signingSeed, AGENT_ID, arm) },
        body: JSON.stringify({ update_id: 1 }),
      },
    ), { params: Promise.resolve({ agentId: AGENT_ID }) });

    expect((await call(staleArmId)).status).toBe(401);
    expect(mockAfter).not.toHaveBeenCalled();
    const answer = await call(armId);
    expect(answer.status).toBe(503);
    expect(answer.headers.get("Retry-After")).toBe("5");
    expect(mockAfter).toHaveBeenCalledTimes(1);
    expect(mockClaim).not.toHaveBeenCalled();
    await mockAfter.mock.calls[0][0]();

    expect(mockLapsed).toHaveBeenCalledWith(expect.objectContaining({ user_id: "user-1" }), "start");
    expect(mockClaim).toHaveBeenCalledTimes(1);
    expect(mockClaim).toHaveBeenCalledWith({ agentId: AGENT_ID, operationId: expect.any(String) });
    expect(mockFinish).toHaveBeenCalledWith({ ...mockClaim.mock.calls[0][0], result: "wake_failed" });
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ agentId: AGENT_ID, trigger: "telegram" }));
    expect(order).toEqual(["delete_webhook", "host_script"]);
    expect(fetchStub).toHaveBeenCalledWith(
      `https://api.telegram.org/bot${botToken}/deleteWebhook`,
      expect.objectContaining({ method: "POST", body: '{"drop_pending_updates":false}' }),
    );
    expect(mockChannelDb.tables.hivra_agent_telegram_wake[0]).toMatchObject({
      state: "pending_arm", pending_since: expect.any(String), next_attempt_at: null,
    });
  });

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
    // The wake succeeded, so the "taken back" mark on the row is cleared.
    expect(mockSettle).toHaveBeenCalledWith(AGENT_ID, expect.objectContaining({ previous: "armed" }));
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
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it("goes on with the wake when the delete failed, and says so in the event", async () => {
    mockDisarm.mockResolvedValue({ previous: "armed", called: true, ok: false, ms: 5000 });
    const result = await ensureHivraAgentAwake(AGENT_ID, { trigger: "telegram", ...fast });
    expect(result.state).toBe("awake");
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.objectContaining({ tg_disarm_ok: false }) }));
  });

  it("adds nothing to the event when there was no webhook, and kills stale sockets only for a wake that took a row back", async () => {
    process.env.HIVRA_TELEGRAM_WAKE = "on";
    process.env.HIVRA_TELEGRAM_WAKE_SECRET = "x".repeat(40);
    process.env.HIVRA_TELEGRAM_WAKE_BASE_URL = "https://hooks.example.test/api/webhooks/telegram-wake";
    // Configured, but this agent never opted in: its guest is left alone.
    mockDisarm.mockResolvedValue(null);
    await ensureHivraAgentAwake(AGENT_ID, { trigger: "open", ...fast });
    const detail = mockLogEvent.mock.calls[0][0].detail;
    expect(detail).not.toHaveProperty("tg_disarm_ms");
    expect(String(mockRunScript.mock.calls[0][0])).not.toContain("ss -K state established");
    mockDisarm.mockResolvedValue(disarmed);
    await ensureHivraAgentAwake(AGENT_ID, { trigger: "open", ...fast });
    expect(String(mockRunScript.mock.calls[1][0])).toContain("ss -K state established");
  });
});
