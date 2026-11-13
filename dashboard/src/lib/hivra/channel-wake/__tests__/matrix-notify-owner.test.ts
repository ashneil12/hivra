/** @jest-environment node */

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

const mockRows: Array<Record<string, unknown>> = [];
const mockUpdates: Array<{ agentId: string; channel: string; from: string[]; patch: Record<string, unknown> }> = [];
let mockUpdateResult = true;
jest.mock("../store", () => ({
  readChannelWakeRows: async (agentId: string) => mockRows.filter((r) => r.agent_id === agentId),
  updateChannelWakeRow: async (agentId: string, channel: string, from: string[], patch: Record<string, unknown>) => {
    mockUpdates.push({ agentId, channel, from, patch });
    return mockUpdateResult;
  },
}));

const mockUpserts: Array<{ row: Record<string, unknown>; options: unknown }> = [];
let mockUpsertError: unknown = null;
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => ({
      upsert: async (row: Record<string, unknown>, options: unknown) => {
        mockUpserts.push({ row, options });
        return { error: mockUpsertError };
      },
    }),
  },
}));

const mockHost = jest.fn();
jest.mock("../../agent-sleep", () => ({ readSleepHostRow: (...a: unknown[]) => mockHost(...a) }));
const mockTarget = jest.fn();
const mockReadAgent = jest.fn();
jest.mock("../../agent-wake", () => ({
  resolveSleepTarget: (...a: unknown[]) => mockTarget(...a),
  readHivraAgentRow: (...a: unknown[]) => mockReadAgent(...a),
}));
jest.mock("@/lib/services/proxmox-instance-service", () => ({ runProxmoxHostScriptWithStdin: jest.fn() }));

import { handleMatrixNotify } from "../adapters/matrix-notify";
import { MATRIX_PUSH_APP_ID, matrixPushkey } from "../adapters/matrix-pusher-program";
import { MATRIX_ADAPTER } from "../adapters/matrix-pusher";
import { CHANNEL_WAKE_ADAPTERS, CHANNEL_WAKES_PER_HOUR, disarmChannelsForWake, markChannelsAfterSleep } from "../lifecycle";
import { disableChannelWake, enableChannelWake, readChannelWakeView } from "../owner";

const SEED = "s".repeat(40);
const AGENT = "00000000-0000-4000-8000-0000000a0001";
const ARM = "00000000-0000-4000-8000-0000000b0001";
const OLD_ARM = "00000000-0000-4000-8000-0000000b0002";
const FP = "0123456789abcdef";
const ENV = {
  HIVRA_CHANNEL_WAKE: "on",
  HIVRA_CHANNEL_WAKE_CHANNELS: "matrix",
  HIVRA_CHANNEL_WAKE_SECRET: SEED,
  HIVRA_CHANNEL_WAKE_BASE_URL: "https://wake.example.test",
};

function matrixRow(extra: Record<string, unknown> = {}) {
  return {
    agent_id: AGENT, channel: "matrix", enabled: true, cred_fp: FP, state: "idle", arm_id: ARM, arm_data: {},
    pending_since: null, next_attempt_at: null, arm_failures: 0, blocked_until: null, deferred_wake_at: null,
    wake_count_window: [], last_error: null, ...extra,
  };
}

function push(pushkey: string, appId = MATRIX_PUSH_APP_ID) {
  return { notification: { event_id: "$e", room_id: "!r:example.test", counts: { unread: 1 }, devices: [{ app_id: appId, pushkey, pushkey_ts: 1, data: { format: "event_id_only" } }] } };
}

beforeEach(() => {
  mockRows.length = 0;
  mockUpdates.length = 0;
  mockUpserts.length = 0;
  mockUpdateResult = true;
  mockUpsertError = null;
  mockHost.mockReset();
  mockTarget.mockReset();
  mockReadAgent.mockReset();
});

describe("Matrix push gateway", () => {
  const key = matrixPushkey(SEED, AGENT, ARM);

  it("is dark without the secret", async () => {
    const wake = jest.fn();
    expect(await handleMatrixNotify(push(key), { env: {}, wake })).toEqual({ status: 404 });
    expect(wake).not.toHaveBeenCalled();
  });

  it("answers 401 to a forged pushkey without reading anything", async () => {
    const wake = jest.fn();
    const readRows = jest.fn();
    const forged = key.slice(0, -4) + "0000";
    expect(await handleMatrixNotify(push(forged), { env: ENV, wake, readRows })).toEqual({ status: 401 });
    expect(await handleMatrixNotify(push("junk"), { env: ENV, wake, readRows })).toEqual({ status: 401 });
    expect(await handleMatrixNotify(push(key, "other.app"), { env: ENV, wake, readRows })).toEqual({ status: 401 });
    expect(readRows).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
  });

  it("answers 400 to a body that is not a notification", async () => {
    expect(await handleMatrixNotify(null, { env: ENV, wake: jest.fn() })).toEqual({ status: 400 });
    expect(await handleMatrixNotify({ notification: {} }, { env: ENV, wake: jest.fn() })).toEqual({ status: 400 });
  });

  it("rejects a stale opt-in's pushkey so the homeserver deletes that pusher", async () => {
    mockRows.push(matrixRow());
    const stale = matrixPushkey(SEED, AGENT, OLD_ARM);
    const wake = jest.fn();
    const out = await handleMatrixNotify(push(stale), { env: ENV, wake });
    expect(out).toEqual({ status: 200, rejected: [stale], woke: [], deferred: [] });
    mockRows.length = 0;
    mockRows.push(matrixRow({ enabled: false }));
    expect(await handleMatrixNotify(push(key), { env: ENV, wake })).toMatchObject({ status: 200, rejected: [key] });
    mockRows.length = 0;
    expect(await handleMatrixNotify(push(key), { env: ENV, wake })).toMatchObject({ status: 200, rejected: [key] });
    expect(wake).not.toHaveBeenCalled();
  });

  it("does nothing for an awake or waking agent", async () => {
    mockRows.push(matrixRow());
    const wake = jest.fn();
    const request = jest.fn();
    for (const sleep_state of ["awake", "waking", null]) {
      mockReadAgent.mockResolvedValueOnce({ id: AGENT, status: "running", sleep_state });
      expect(await handleMatrixNotify(push(key), { env: ENV, wake, request })).toEqual({ status: 200, rejected: [], woke: [], deferred: [] });
    }
    expect(request).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
  });

  it("wakes a napping agent with the channel trigger path", async () => {
    mockRows.push(matrixRow());
    mockReadAgent.mockResolvedValue({ id: AGENT, status: "running", sleep_state: "napping" });
    const wake = jest.fn();
    const out = await handleMatrixNotify(push(key), { env: ENV, wake });
    expect(out).toEqual({ status: 200, rejected: [], woke: [AGENT], deferred: [] });
    expect(wake).toHaveBeenCalledWith(AGENT);
    // The hourly window was written.
    expect(mockUpdates[0].patch.wake_count_window).toHaveLength(1);
  });

  it("defers a wake over the hourly cap instead of dropping it", async () => {
    const now = Date.now();
    const window = Array.from({ length: CHANNEL_WAKES_PER_HOUR }, (_, i) => new Date(now - (i + 1) * 60_000).toISOString());
    mockRows.push(matrixRow({ wake_count_window: window }));
    mockReadAgent.mockResolvedValue({ id: AGENT, status: "running", sleep_state: "hibernated" });
    const wake = jest.fn();
    const out = await handleMatrixNotify(push(key), { env: ENV, wake });
    expect(out).toEqual({ status: 200, rejected: [], woke: [], deferred: [AGENT] });
    expect(wake).not.toHaveBeenCalled();
    expect(typeof mockUpdates[0].patch.deferred_wake_at).toBe("string");
  });

  it("wakes when the opt-in cannot be read (fail toward awake)", async () => {
    const wake = jest.fn();
    const readRows = jest.fn().mockRejectedValue(new Error("down"));
    expect(await handleMatrixNotify(push(key), { env: ENV, wake, readRows })).toMatchObject({ status: 200, woke: [AGENT] });
    expect(wake).toHaveBeenCalledWith(AGENT);
  });
});

describe("Matrix adapter in the framework", () => {
  it("is registered, arms nothing and disarms nothing", async () => {
    expect(CHANNEL_WAKE_ADAPTERS).toContain(MATRIX_ADAPTER);
    expect(MATRIX_ADAPTER.armBeforeSleep).toBeUndefined();
    expect(MATRIX_ADAPTER.armLater).toBeUndefined();
    const ctx = { agentId: AGENT, channel: "matrix" as const, armId: ARM, armData: {} };
    expect(await MATRIX_ADAPTER.verifyClear(ctx)).toBe(true);
    expect(await MATRIX_ADAPTER.disarmForWake(ctx)).toEqual({ ok: true });
    // After a covered sleep there is no row to mark.
    const row = matrixRow() as never;
    expect(await markChannelsAfterSleep(AGENT, { covered: ["hermes:matrix"], telegram: false, generic: [{ adapter: MATRIX_ADAPTER, row }] }, [])).toBe(true);
    expect(mockUpdates).toEqual([]);
  });

  it("never touches an idle Matrix row on a wake", async () => {
    mockRows.push(matrixRow());
    const disarms = await disarmChannelsForWake(AGENT, { env: ENV, adapters: [MATRIX_ADAPTER] });
    expect(disarms.generic).toEqual([]);
    expect(mockUpdates).toEqual([]);
  });
});

describe("owner switch", () => {
  const agent = {
    id: AGENT, user_id: "user_x", type: "hermes", deployment_mode: "hivra-managed", computer_substrate: "proxmox-kvm",
    status: "running", sleep_state: "awake",
  };
  const target = { ok: true, target: { vmid: 123, bindingTag: "hivra-x", env: {} } };

  it("is not available with the switches off, for another kind, or without a base address", async () => {
    expect((await readChannelWakeView(agent, "matrix", { env: {} })).available).toBe(false);
    expect((await readChannelWakeView({ ...agent, type: "openclaw" }, "matrix", { env: ENV })).available).toBe(false);
    expect((await readChannelWakeView(agent, "matrix", { env: { ...ENV, HIVRA_CHANNEL_WAKE_BASE_URL: "" } })).available).toBe(false);
    expect((await readChannelWakeView(agent, "matrix", { env: { ...ENV, HIVRA_CHANNEL_WAKE_CHANNELS: "email" } })).available).toBe(false);
    mockHost.mockResolvedValue({ status: "online", sleep_mode: "off" });
    expect((await readChannelWakeView(agent, "matrix", { env: { ...ENV, HIVRA_CHANNEL_WAKE: "canary" } })).available).toBe(false);
    mockHost.mockResolvedValue({ status: "online", sleep_mode: "canary" });
    expect((await readChannelWakeView(agent, "matrix", { env: { ...ENV, HIVRA_CHANNEL_WAKE: "canary" } })).available).toBe(true);
  });

  it("registers the pusher from the computer and stores only the fingerprint and the opt-in id", async () => {
    mockTarget.mockResolvedValue(target);
    const runPusher = jest.fn().mockResolvedValue({ ok: true, fp: FP, homeserverHost: "matrix.example.test", removed: 0 });
    const change = await enableChannelWake(agent, "matrix", { env: ENV, runPusher, newArmId: () => ARM, now: () => 0 });
    expect(change).toEqual({ ok: true, view: { channel: "matrix", available: true, enabled: true, armed: true }, wake: false });
    expect(runPusher).toHaveBeenCalledWith({ vmid: 123, bindingTag: "hivra-x", env: {} }, {
      op: "register", pushkey: matrixPushkey(SEED, AGENT, ARM), url: "https://wake.example.test/_matrix/push/v1/notify",
    });
    expect(mockUpserts).toHaveLength(1);
    const saved = mockUpserts[0].row;
    expect(saved).toMatchObject({ agent_id: AGENT, channel: "matrix", enabled: true, cred_fp: FP, arm_id: ARM, state: "idle" });
    expect(saved.arm_data).toEqual({ homeserverHost: "matrix.example.test", registeredAt: new Date(0).toISOString() });
    expect(JSON.stringify(saved)).not.toContain(matrixPushkey(SEED, AGENT, ARM));
  });

  it("switches an earlier opt-in off before replacing it", async () => {
    mockRows.push(matrixRow({ arm_id: OLD_ARM }));
    mockTarget.mockResolvedValue(target);
    const runPusher = jest.fn().mockResolvedValue({ ok: false, reason: "token_rejected" });
    const change = await enableChannelWake(agent, "matrix", { env: ENV, runPusher, newArmId: () => ARM });
    expect(change).toMatchObject({ ok: false, status: 409, code: "token_rejected" });
    expect(mockUpdates[0].patch).toEqual({ enabled: false });
    expect(mockUpserts).toHaveLength(0);
  });

  it("refuses while asleep and never runs anything", async () => {
    const runPusher = jest.fn();
    expect(await enableChannelWake({ ...agent, sleep_state: "napping" }, "matrix", { env: ENV, runPusher }))
      .toMatchObject({ ok: false, code: "not_awake" });
    expect(runPusher).not.toHaveBeenCalled();
  });

  it("forgets the opt-in first, then removes the pusher while awake", async () => {
    mockRows.push(matrixRow());
    mockTarget.mockResolvedValue(target);
    const runPusher = jest.fn().mockResolvedValue({ ok: true, fp: FP, homeserverHost: "m.example.test", removed: 1 });
    const change = await disableChannelWake(agent, "matrix", { env: ENV, runPusher });
    expect(change).toMatchObject({ ok: true, wake: false, view: { enabled: false } });
    expect(mockUpdates[0].patch).toMatchObject({ enabled: false, arm_id: null, cred_fp: null });
    expect(runPusher).toHaveBeenCalledWith(expect.anything(), { op: "remove" });
  });

  it("asks for a wake when the agent slept counting on it", async () => {
    mockRows.push(matrixRow());
    const runPusher = jest.fn();
    const change = await disableChannelWake({ ...agent, sleep_state: "napping" }, "matrix", { env: ENV, runPusher });
    expect(change).toMatchObject({ ok: true, wake: true });
    expect(runPusher).not.toHaveBeenCalled();
  });
});
