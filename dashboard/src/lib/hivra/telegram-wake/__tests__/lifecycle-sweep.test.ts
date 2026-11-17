/** @jest-environment node */
// Disarm on wake, the sweep's arming and draining, and the owner switch, with
// the store and Telegram replaced by fakes. No token may reach a log line.

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock("@/lib/logger", () => ({ log: mockLog }));

type Row = Record<string, unknown> & { agent_id: string; state: string };
const rows = new Map<string, Row>();
const updates: Array<{ id: string; from: string[]; patch: Record<string, unknown>; options?: unknown }> = [];
const mockClaim = jest.fn();
const mockFinish = jest.fn();
jest.mock("../store", () => ({
  readTelegramWakeRow: async (id: string) => rows.get(id) ?? null,
  tryReadTelegramWakeRow: async (id: string) => rows.get(id) ?? null,
  readTelegramWakeWorkRows: async () => [...rows.values()].filter((r) => r.state !== "idle" || r.pending_since || (!r.enabled && r.token_enc)),
  updateTelegramWakeRow: async (id: string, from: string[], patch: Record<string, unknown>, options?: unknown) => {
    updates.push({ id, from, patch, options });
    const row = rows.get(id);
    if (!row || !from.includes(row.state)) return false;
    Object.assign(row, patch);
    return true;
  },
  claimTelegramArm: (...a: unknown[]) => mockClaim(...a),
  finishTelegramArm: (...a: unknown[]) => mockFinish(...a),
  saveTelegramWakeOptIn: jest.fn(async () => true),
}));

const agents = new Map<string, Record<string, unknown>>();
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.in = async () => ({
        data: table === "hivra_agents" ? [...agents.entries()].map(([id, a]) => ({ id, ...a })) : [{ id: "local", sleep_mode: "canary" }],
        error: null,
      });
      return q;
    },
  },
}));

import { encryptSecret } from "@/lib/crypto";
import { disarmTelegramForWake, rearmTelegramAfterFailedWake, settleTelegramAfterWake } from "../lifecycle";
import { runTelegramWakeSweep } from "../sweep";
import { telegramWakeSecretToken } from "../config";

const FINGERPRINT = ["0123", "4567", "89ab", "cdef"].join("");
const AGENT = "11111111-1111-4111-8111-111111111111";
const sample = [String(7_000_000_000 + 4321), "Ab_-".repeat(9)].join(":");
const material = "x".repeat(40);
const base = "https://hooks.example.test/api/webhooks/telegram-wake";
const env = { HIVRA_TELEGRAM_WAKE: "on", HIVRA_TELEGRAM_WAKE_SECRET: material, HIVRA_TELEGRAM_WAKE_BASE_URL: base };
const NOW = Date.parse("2026-11-13T10:00:00Z");

interface Call { method: string; body: Record<string, unknown> }
function telegram(answers: Record<string, Array<{ status: number; body: unknown }>>) {
  const calls: Call[] = [];
  const fetchImpl = jest.fn(async (url: string, init: RequestInit) => {
    const method = url.split("/").pop()!;
    calls.push({ method, body: JSON.parse(String(init.body)) });
    const next = answers[method]?.shift() ?? { status: 200, body: { ok: true, result: true } };
    return new Response(JSON.stringify(next.body), { status: next.status });
  });
  return { calls, fetchImpl };
}

function row(over: Partial<Row> = {}): Row {
  return {
    agent_id: AGENT, user_id: "user-1", enabled: true, token_enc: encryptSecret(sample), token_fp: FINGERPRINT,
    bot_id: 1, state: "armed", arm_id: "22222222-2222-4222-8222-222222222222", arm_started_at: null,
    pending_since: new Date(NOW - 60_000).toISOString(), next_attempt_at: null, arm_failures: 0, blocked_until: null, last_error: null,
    ...over,
  };
}

function noTokenLogged() {
  const text = JSON.stringify([mockLog.info.mock.calls, mockLog.warn.mock.calls, mockLog.error.mock.calls, mockLog.debug.mock.calls]);
  expect(text).not.toContain(sample);
  expect(text).not.toContain(sample.split(":")[1]);
}

beforeAll(() => { process.env.ENCRYPTION_KEY = "ab".repeat(32); });
beforeEach(() => {
  rows.clear();
  agents.clear();
  updates.length = 0;
  jest.clearAllMocks();
  agents.set(AGENT, { status: "running", desired_state: "running", sleep_state: "napping", operation_id: null, proxmox_host: "local" });
});
afterEach(noTokenLogged);

describe("disarm on wake", () => {
  it("does nothing at all when the feature was never configured", async () => {
    rows.set(AGENT, row());
    const tg = telegram({});
    await expect(disarmTelegramForWake(AGENT, { env: {}, fetchImpl: tg.fetchImpl })).resolves.toBeNull();
    expect(tg.calls).toEqual([]);
  });

  it("deletes the webhook, keeping queued updates, and sets the row idle", async () => {
    rows.set(AGENT, row());
    const tg = telegram({});
    const result = await disarmTelegramForWake(AGENT, { env, fetchImpl: tg.fetchImpl });
    expect(result).toMatchObject({ previous: "armed", called: true, ok: true });
    expect(tg.calls).toEqual([{ method: "deleteWebhook", body: { drop_pending_updates: false } }]);
    expect(rows.get(AGENT)!.state).toBe("idle");
  });

  it("retries once, then marks it for the sweep and lets the wake go on", async () => {
    rows.set(AGENT, row());
    const tg = telegram({ deleteWebhook: [{ status: 500, body: { ok: false } }, { status: 500, body: { ok: false } }] });
    const result = await disarmTelegramForWake(AGENT, { env, fetchImpl: tg.fetchImpl });
    expect(result).toMatchObject({ ok: false });
    expect(tg.calls).toHaveLength(2);
    expect(rows.get(AGENT)!.state).toBe("disarm_failed");
  });

  it("only clears a row that was waiting, with no Telegram call", async () => {
    rows.set(AGENT, row({ state: "pending_arm" }));
    const tg = telegram({});
    await expect(disarmTelegramForWake(AGENT, { env, fetchImpl: tg.fetchImpl })).resolves.toMatchObject({ previous: "pending_arm", called: false });
    expect(tg.calls).toEqual([]);
    expect(rows.get(AGENT)!.state).toBe("idle");
  });

  it("goes back to waiting for the sweep after a failed wake", async () => {
    rows.set(AGENT, row());
    const disarm = await disarmTelegramForWake(AGENT, { env, fetchImpl: telegram({}).fetchImpl });
    await rearmTelegramAfterFailedWake(AGENT, disarm, { now: () => NOW });
    expect(rows.get(AGENT)).toMatchObject({ state: "pending_arm", pending_since: new Date(NOW).toISOString() });
  });

  it("leaves an idle row marked as taken back, and a wake that succeeds clears the mark", async () => {
    rows.set(AGENT, row());
    const disarm = await disarmTelegramForWake(AGENT, { env, fetchImpl: telegram({}).fetchImpl, now: () => NOW });
    expect(rows.get(AGENT)).toMatchObject({ state: "idle", pending_since: new Date(NOW).toISOString() });
    await settleTelegramAfterWake(AGENT, disarm);
    expect(rows.get(AGENT)).toMatchObject({ state: "idle", pending_since: null });
  });

  it("marks a waiting row too when a wake clears it", async () => {
    rows.set(AGENT, row({ state: "pending_arm" }));
    await disarmTelegramForWake(AGENT, { env, fetchImpl: telegram({}).fetchImpl, now: () => NOW });
    expect(rows.get(AGENT)).toMatchObject({ state: "idle", pending_since: new Date(NOW).toISOString() });
  });

  it("leaves a failed delete for the sweep after a failed wake, since its webhook may still be set", async () => {
    rows.set(AGENT, row());
    const tg = telegram({ deleteWebhook: [{ status: 500, body: { ok: false } }, { status: 500, body: { ok: false } }] });
    const disarm = await disarmTelegramForWake(AGENT, { env, fetchImpl: tg.fetchImpl });
    await rearmTelegramAfterFailedWake(AGENT, disarm, { now: () => NOW });
    expect(rows.get(AGENT)!.state).toBe("disarm_failed");
  });
});

describe("sweep arming", () => {
  const wake = jest.fn();
  const sweep = (fetchImpl: unknown, extra: Record<string, string> = {}) =>
    runTelegramWakeSweep({ env: { ...env, ...extra }, now: () => NOW, timeLeft: () => 60_000, wake, fetchImpl: fetchImpl as never });

  beforeEach(() => {
    mockFinish.mockResolvedValue(true);
    mockClaim.mockResolvedValue(0);
  });

  it("claims with the 20 s nap rule, checks getWebhookInfo, then sets our webhook with a per-arm secret", async () => {
    rows.set(AGENT, row({ state: "pending_arm" }));
    const tg = telegram({ getWebhookInfo: [{ status: 200, body: { ok: true, result: { url: "" } } }] });
    const counts = await sweep(tg.fetchImpl);
    expect(mockClaim).toHaveBeenCalledWith(AGENT, expect.any(String), 20);
    const armId = mockClaim.mock.calls[0][1] as string;
    expect(tg.calls.map((c) => c.method)).toEqual(["getWebhookInfo", "setWebhook"]);
    expect(tg.calls[1].body).toEqual({ url: `${base}/${AGENT}`, secret_token: telegramWakeSecretToken(material, AGENT, armId), max_connections: 1 });
    expect(mockFinish).toHaveBeenCalledWith({ agentId: AGENT, armId, result: "armed" });
    expect(counts.armed).toBe(1);
    expect(wake).not.toHaveBeenCalled();
  });

  it("does nothing when the claim is refused (nap too young, agent waking)", async () => {
    rows.set(AGENT, row({ state: "pending_arm" }));
    mockClaim.mockResolvedValue(null);
    const tg = telegram({});
    await sweep(tg.fetchImpl);
    expect(tg.calls).toEqual([]);
  });

  it("never overwrites someone else's webhook: blocks for a day and wakes the agent", async () => {
    rows.set(AGENT, row({ state: "pending_arm" }));
    const tg = telegram({ getWebhookInfo: [{ status: 200, body: { ok: true, result: { url: "https://elsewhere.example.test/hook" } } }] });
    const counts = await sweep(tg.fetchImpl);
    expect(tg.calls.map((c) => c.method)).toEqual(["getWebhookInfo"]);
    expect(mockFinish).toHaveBeenCalledWith(expect.objectContaining({
      result: "blocked", error: "foreign_webhook", retryAt: new Date(NOW + 24 * 60 * 60_000).toISOString(),
    }));
    expect(wake).toHaveBeenCalledWith(AGENT);
    expect(counts).toMatchObject({ blocked: 1, woke: 1 });
  });

  it("sets our own address again (an arm that lost its answer)", async () => {
    rows.set(AGENT, row({ state: "pending_arm" }));
    const tg = telegram({ getWebhookInfo: [{ status: 200, body: { ok: true, result: { url: `${base}/${AGENT}` } } }] });
    await sweep(tg.fetchImpl);
    expect(tg.calls.map((c) => c.method)).toEqual(["getWebhookInfo", "setWebhook"]);
  });

  it("honours a 429 retry_after without counting a failure", async () => {
    rows.set(AGENT, row({ state: "pending_arm" }));
    const tg = telegram({
      getWebhookInfo: [{ status: 200, body: { ok: true, result: { url: "" } } }],
      setWebhook: [{ status: 429, body: { ok: false, parameters: { retry_after: 42 } } }],
    });
    await sweep(tg.fetchImpl);
    expect(mockFinish).toHaveBeenCalledWith(expect.objectContaining({
      result: "pending_arm", retryAt: new Date(NOW + 42_000).toISOString(), error: "rate_limited",
    }));
    expect(mockFinish.mock.calls[0][0].failed).toBeUndefined();
  });

  it("climbs the failure ladder and blocks on the third failure", async () => {
    rows.set(AGENT, row({ state: "pending_arm" }));
    const failing = () => telegram({ getWebhookInfo: [{ status: 500, body: { ok: false } }] }).fetchImpl;
    mockClaim.mockResolvedValueOnce(0);
    await sweep(failing());
    expect(mockFinish).toHaveBeenLastCalledWith(expect.objectContaining({ result: "pending_arm", failed: true, retryAt: new Date(NOW + 30_000).toISOString() }));
    mockClaim.mockResolvedValueOnce(2);
    await sweep(failing());
    expect(mockFinish).toHaveBeenLastCalledWith(expect.objectContaining({ result: "blocked", error: "webhook_info_failed" }));
    expect(wake).toHaveBeenCalledWith(AGENT);
  });

  it("takes its webhook down again when a wake took the row meanwhile", async () => {
    rows.set(AGENT, row({ state: "pending_arm" }));
    mockFinish.mockResolvedValueOnce(false);
    const tg = telegram({ getWebhookInfo: [{ status: 200, body: { ok: true, result: { url: "" } } }] });
    const counts = await sweep(tg.fetchImpl);
    expect(tg.calls.map((c) => c.method)).toEqual(["getWebhookInfo", "setWebhook", "deleteWebhook"]);
    expect(counts.undone).toBe(1);
  });

  it("takes down a webhook whose agent is awake, and does not wake it", async () => {
    rows.set(AGENT, row({ state: "armed" }));
    agents.set(AGENT, { status: "running", desired_state: "running", sleep_state: "awake", operation_id: null, proxmox_host: "local" });
    const tg = telegram({});
    const counts = await sweep(tg.fetchImpl);
    expect(tg.calls.map((c) => c.method)).toEqual(["deleteWebhook"]);
    expect(rows.get(AGENT)!.state).toBe("idle");
    expect(counts.disarmed).toBe(1);
    expect(wake).not.toHaveBeenCalled();
  });

  it("leaves a row alone while a wake or sleep holds the agent", async () => {
    rows.set(AGENT, row({ state: "armed" }));
    agents.set(AGENT, { status: "running", desired_state: "running", sleep_state: "waking", operation_id: "op", proxmox_host: "local" });
    const tg = telegram({});
    await sweep(tg.fetchImpl);
    expect(tg.calls).toEqual([]);
  });

  it("drains every row when the mode is switched off, waking the agents that were asleep", async () => {
    rows.set(AGENT, row({ state: "armed" }));
    const tg = telegram({});
    await sweep(tg.fetchImpl, { HIVRA_TELEGRAM_WAKE: "off" });
    expect(tg.calls.map((c) => c.method)).toEqual(["deleteWebhook"]);
    expect(rows.get(AGENT)!.state).toBe("idle");
    expect(wake).toHaveBeenCalledWith(AGENT);
  });

  it("forgets the token once an opted-out row is idle", async () => {
    rows.set(AGENT, row({ state: "idle", enabled: false }));
    const counts = await sweep(telegram({}).fetchImpl);
    expect(rows.get(AGENT)!.token_enc).toBeNull();
    expect(counts.wiped).toBe(1);
  });

  it("arms the bot of an agent whose wake failed, since its computer may still be asleep", async () => {
    rows.set(AGENT, row({ state: "pending_arm" }));
    agents.set(AGENT, { status: "running", desired_state: "running", sleep_state: "wake_failed", operation_id: null, proxmox_host: "local" });
    const tg = telegram({ getWebhookInfo: [{ status: 200, body: { ok: true, result: { url: "" } } }] });
    const counts = await sweep(tg.fetchImpl);
    expect(mockClaim).toHaveBeenCalled();
    expect(counts.armed).toBe(1);
  });

  it("puts a row a failed or cut-off wake took back to waiting while the agent is still asleep", async () => {
    for (const sleepState of ["wake_failed", "napping", "hibernated"]) {
      rows.set(AGENT, row({ state: "idle", pending_since: new Date(NOW - 300_000).toISOString() }));
      agents.set(AGENT, { status: "running", desired_state: "running", sleep_state: sleepState, operation_id: null, proxmox_host: "local" });
      const tg = telegram({});
      const counts = await sweep(tg.fetchImpl);
      expect(tg.calls).toEqual([]);
      expect(rows.get(AGENT)).toMatchObject({ state: "pending_arm", pending_since: new Date(NOW).toISOString(), next_attempt_at: null });
      expect(counts.rearmed).toBe(1);
      expect(wake).not.toHaveBeenCalled();
    }
  });

  it("leaves a taken-back row alone while the wake still holds the agent", async () => {
    rows.set(AGENT, row({ state: "idle" }));
    agents.set(AGENT, { status: "running", desired_state: "running", sleep_state: "waking", operation_id: "op", proxmox_host: "local" });
    await sweep(telegram({}).fetchImpl);
    expect(rows.get(AGENT)).toMatchObject({ state: "idle", pending_since: expect.any(String) });
  });

  it("clears the mark when the agent is awake, without waking anything", async () => {
    rows.set(AGENT, row({ state: "idle" }));
    agents.set(AGENT, { status: "running", desired_state: "running", sleep_state: "awake", operation_id: null, proxmox_host: "local" });
    const counts = await sweep(telegram({}).fetchImpl);
    expect(rows.get(AGENT)).toMatchObject({ state: "idle", pending_since: null });
    expect(counts.rearmed).toBe(0);
    expect(wake).not.toHaveBeenCalled();
  });

  it("wakes an agent left asleep whose bot may not be armed again (blocked)", async () => {
    rows.set(AGENT, row({ state: "idle", blocked_until: new Date(NOW + 60_000).toISOString() }));
    const counts = await sweep(telegram({}).fetchImpl);
    expect(rows.get(AGENT)).toMatchObject({ state: "idle", pending_since: null });
    expect(wake).toHaveBeenCalledWith(AGENT);
    expect(counts).toMatchObject({ rearmed: 0, woke: 1 });
  });

  it("touches an armed row it leaves in place, so other armed rows get their turn", async () => {
    rows.set(AGENT, row({ state: "armed" }));
    const tg = telegram({});
    await sweep(tg.fetchImpl);
    expect(tg.calls).toEqual([]);
    expect(updates).toEqual([{ id: AGENT, from: ["armed"], patch: {}, options: { armId: row().arm_id } }]);
  });

  it("stops when the budget is nearly gone", async () => {
    rows.set(AGENT, row({ state: "pending_arm" }));
    const tg = telegram({});
    await runTelegramWakeSweep({ env, now: () => NOW, timeLeft: () => 1_000, wake, fetchImpl: tg.fetchImpl });
    expect(mockClaim).not.toHaveBeenCalled();
  });
});
