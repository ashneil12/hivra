/** @jest-environment node */

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

const mockRows: Array<Record<string, unknown>> = [];
const mockUpdates: Array<{ agentId: string; channel: string; from: string[]; patch: Record<string, unknown>; options: Record<string, unknown> }> = [];
let mockUpdateResult = true;
let mockReadFails = false;
const mockAgents = new Map<string, { status: string | null; sleep_state: string | null; operation_id: string | null }>();

jest.mock("../store", () => ({
  readChannelWakeRows: async (agentId: string) => {
    if (mockReadFails) throw new Error("read failed");
    return mockRows.filter((r) => r.agent_id === agentId);
  },
  readChannelWakeWorkRows: async () => [...mockRows],
  readChannelWakeAgentFacts: async () => mockAgents,
  updateChannelWakeRow: async (agentId: string, channel: string, from: string[], patch: Record<string, unknown>, options = {}) => {
    mockUpdates.push({ agentId, channel, from, patch, options });
    return mockUpdateResult;
  },
}));

const mockTgDisarm = jest.fn();
const mockTgRearm = jest.fn();
const mockTgSettle = jest.fn();
const mockTgCoverage = jest.fn();
const mockTgCoversItself = jest.fn();
jest.mock("../adapters/telegram", () => ({
  TELEGRAM_ADAPTER: {
    disarmForWake: (...a: unknown[]) => mockTgDisarm(...a),
    rearmAfterFailedWake: (...a: unknown[]) => mockTgRearm(...a),
    settleAfterWake: (...a: unknown[]) => mockTgSettle(...a),
    coverageFor: (...a: unknown[]) => mockTgCoverage(...a),
    coversItself: (...a: unknown[]) => mockTgCoversItself(...a),
    release: async () => undefined,
  },
}));

import {
  CHANNEL_DISARM_BOX_MS,
  CHANNEL_WAKES_PER_HOUR,
  armChannelsBeforeSleep,
  channelCoverageFor,
  channelSleepCoverage,
  channelWakeCapDecision,
  disarmChannelsForWake,
  markChannelsAfterSleep,
  rearmChannelsAfterFailedWake,
  requestChannelWake,
} from "../lifecycle";
import { ARM_MAX_FAILURES, runChannelWakeSweep } from "../sweep";
import { standardChannelBlockers } from "../registry";
import type { ChannelWakeAdapter } from "../types";

const AGENT = "11111111-2222-4333-8444-555555555555";
const FP = "fedcba9876543210";
const SEED = "s".repeat(40);
const ENV_ON = { HIVRA_CHANNEL_WAKE: "on", HIVRA_CHANNEL_WAKE_CHANNELS: "email,matrix", HIVRA_CHANNEL_WAKE_SECRET: SEED };

function adapter(channel: "email" | "matrix", overrides: Partial<ChannelWakeAdapter> = {}): ChannelWakeAdapter {
  const spec: ChannelWakeAdapter = {
    channel,
    probeTag: `hermes:${channel}`,
    detector: "host-doorbell",
    catchUp: "native",
    needsServerDisarm: false,
    socketBased: false,
    credKeys: ["X_KEY"],
    hostFactsPerl: "1",
    coverageBlockers: (input) => standardChannelBlockers(spec, input),
    verifyClear: jest.fn(async () => true),
    disarmForWake: jest.fn(async () => ({ ok: true })),
    release: jest.fn(async () => undefined),
    ...overrides,
  };
  return spec;
}

function row(channel: string, extra: Record<string, unknown> = {}) {
  return {
    agent_id: AGENT, channel, enabled: true, cred_fp: FP, state: "idle", arm_id: null, arm_data: {}, pending_since: null,
    next_attempt_at: null, arm_failures: 0, blocked_until: null, deferred_wake_at: null, wake_count_window: [], last_error: null,
    updated_at: "2026-11-13T00:00:00Z", ...extra,
  };
}

beforeEach(() => {
  mockRows.length = 0;
  mockUpdates.length = 0;
  mockUpdateResult = true;
  mockReadFails = false;
  mockAgents.clear();
  jest.clearAllMocks();
  mockTgDisarm.mockResolvedValue(null);
  mockTgRearm.mockResolvedValue(undefined);
  mockTgSettle.mockResolvedValue(undefined);
});

describe("coverage is a union", () => {
  const probe = { liveChannels: ["hermes:email", "hermes:matrix"], channelFps: { email: FP, matrix: FP } };

  it("only Telegram in play: exactly the Telegram-only rule", () => {
    mockTgCoverage.mockReturnValue(["hermes:telegram"]);
    const out = channelCoverageFor({ telegram: null, generic: [] }, { liveChannels: ["hermes:telegram"] }, 0);
    expect(out).toEqual({ covered: ["hermes:telegram"], telegram: true, generic: [] });
    expect(mockTgCoversItself).not.toHaveBeenCalled();
  });

  it("covers each live channel by its own adapter; one uncovered stays out", () => {
    mockTgCoversItself.mockReturnValue(false);
    const email = adapter("email");
    const matrix = adapter("matrix");
    const out = channelCoverageFor({
      telegram: null,
      generic: [{ adapter: email, row: row("email") as never }, { adapter: matrix, row: row("matrix", { cred_fp: "0000000000000000" }) as never }],
    }, probe, 0);
    expect(out.covered).toEqual(["hermes:email"]);
    expect(out.generic.map((g) => g.adapter.channel)).toEqual(["email"]);
    const script = channelSleepCoverage(out, null);
    expect(script).toEqual({ channels: ["hermes:email"], fingerprints: { email: FP } });
  });

  it("needs Telegram's fingerprint when Telegram is covered with a generic channel", () => {
    mockTgCoversItself.mockReturnValue(true);
    const email = adapter("email");
    const out = channelCoverageFor({ telegram: {} as never, generic: [{ adapter: email, row: row("email") as never }] },
      { ...probe, liveChannels: ["hermes:email", "hermes:telegram"] }, 0);
    expect(out.covered).toEqual(["hermes:telegram", "hermes:email"]);
    expect(channelSleepCoverage(out, null)).toBeNull();
    expect(channelSleepCoverage(out, "0123456789abcdef")?.fingerprints).toEqual({ telegram: "0123456789abcdef", email: FP });
  });
});

describe("arming before a sleep", () => {
  const target = { vmid: 123, bindingTag: "hivra-x", env: null };

  it("arms each covered adapter and records it after the sleep", async () => {
    const email = adapter("email", { armBeforeSleep: jest.fn(async () => ({ ok: true as const, armData: { uidnext: 7 } })) });
    const coverage = { covered: ["hermes:email"], telegram: false, generic: [{ adapter: email, row: row("email") as never }] };
    const armed = await armChannelsBeforeSleep(coverage, target);
    expect(armed.ok).toBe(true);
    if (!armed.ok) return;
    expect(await markChannelsAfterSleep(AGENT, coverage, armed.arms)).toBe(true);
    expect(mockUpdates[0].patch).toMatchObject({ state: "armed", arm_data: { uidnext: 7 } });
  });

  it("a failed arm undoes the ones before it and keeps the agent awake", async () => {
    const email = adapter("email", { armBeforeSleep: jest.fn(async () => ({ ok: true as const })) });
    const matrix = adapter("matrix", { armBeforeSleep: jest.fn(async () => ({ ok: false as const, reason: "down" })) });
    const coverage = {
      covered: ["hermes:email", "hermes:matrix"], telegram: false,
      generic: [{ adapter: email, row: row("email") as never }, { adapter: matrix, row: row("matrix") as never }],
    };
    expect(await armChannelsBeforeSleep(coverage, target)).toEqual({ ok: false, reason: "matrix_arm_failed" });
    expect(email.disarmForWake).toHaveBeenCalledTimes(1);
  });

  it("a leftover arm keeps the agent awake", async () => {
    const email = adapter("email", { verifyClear: jest.fn(async () => false), armBeforeSleep: jest.fn() });
    const coverage = { covered: ["hermes:email"], telegram: false, generic: [{ adapter: email, row: row("email") as never }] };
    expect(await armChannelsBeforeSleep(coverage, target)).toEqual({ ok: false, reason: "email_not_clear" });
    expect(email.armBeforeSleep).not.toHaveBeenCalled();
  });
});

describe("disarm for a wake", () => {
  it("with channel wake off reads nothing and only Telegram runs, as before", async () => {
    const disarm = { previous: "armed", called: true, ok: true, ms: 3 };
    mockTgDisarm.mockResolvedValue(disarm);
    const email = adapter("email");
    mockRows.push(row("email", { state: "armed" }));
    const out = await disarmChannelsForWake(AGENT, { env: {}, adapters: [email] });
    expect(mockTgDisarm).toHaveBeenCalledWith(AGENT);
    expect(out.telegram).toBe(disarm);
    expect(out.generic).toEqual([]);
    expect(out.killStaleSockets).toBe(true);
    expect(email.disarmForWake).not.toHaveBeenCalled();
  });

  it("no Telegram row and no adapters: nothing to kill", async () => {
    const out = await disarmChannelsForWake(AGENT, { env: {} });
    expect(out).toMatchObject({ telegram: null, generic: [], killStaleSockets: false });
  });

  it("runs every adapter in parallel; a timed-out disarm still lets the wake go ahead", async () => {
    jest.useFakeTimers();
    try {
      const hang = adapter("email", { disarmForWake: jest.fn(() => new Promise<{ ok: boolean }>(() => undefined)), socketBased: true });
      const quick = adapter("matrix");
      mockRows.push(row("email", { state: "armed" }), row("matrix", { state: "armed" }));
      const pending = disarmChannelsForWake(AGENT, { env: ENV_ON, adapters: [hang, quick] });
      await jest.advanceTimersByTimeAsync(CHANNEL_DISARM_BOX_MS + 10);
      const out = await pending;
      expect(quick.disarmForWake).toHaveBeenCalled();
      const byChannel = Object.fromEntries(out.generic.map((d) => [d.channel, d]));
      expect(byChannel.email).toMatchObject({ ok: false, timedOut: true });
      expect(byChannel.matrix).toMatchObject({ ok: true, timedOut: false });
      // The socket-based channel was armed: the guest's dead sockets get dropped.
      expect(out.killStaleSockets).toBe(true);
      expect(mockUpdates.find((u) => u.channel === "email")?.patch).toMatchObject({ state: "disarm_failed", last_error: "disarm_timeout" });
    } finally {
      jest.useRealTimers();
    }
  });

  it("a failed wake re-marks only adapters that arm late; Telegram as before", async () => {
    const late = adapter("matrix", { armLater: jest.fn() });
    const early = adapter("email");
    const tg = { previous: "armed", called: true, ok: true, ms: 1 };
    await rearmChannelsAfterFailedWake(AGENT, {
      telegram: tg as never,
      generic: [
        { channel: "matrix", previous: "armed", called: true, ok: true, timedOut: false, ms: 1 },
        { channel: "email", previous: "armed", called: true, ok: true, timedOut: false, ms: 1 },
      ],
      killStaleSockets: true,
      ms: 1,
    }, { adapters: [late, early] });
    expect(mockTgRearm).toHaveBeenCalledWith(AGENT, tg);
    expect(mockUpdates.map((u) => u.channel)).toEqual(["matrix"]);
  });
});

describe("the hourly cap defers, never drops", () => {
  const t0 = Date.parse("2026-11-13T12:00:00Z");

  it("admits up to the cap, then defers to when the oldest leaves the hour", () => {
    let window: string[] = [];
    for (let i = 0; i < CHANNEL_WAKES_PER_HOUR; i += 1) {
      const d = channelWakeCapDecision(window, t0 + i * 60_000, null);
      expect(d.admit).toBe(true);
      window = d.window;
    }
    const capped = channelWakeCapDecision(window, t0 + 10 * 60_000, null);
    expect(capped.admit).toBe(false);
    expect(capped.deferredWakeAt).toBe(new Date(t0 + 60 * 60_000).toISOString());
    // Later wakes keep the deferral; an hour on, the window is free again.
    expect(channelWakeCapDecision(capped.window, t0 + 20 * 60_000, capped.deferredWakeAt).deferredWakeAt).toBe(capped.deferredWakeAt);
    expect(channelWakeCapDecision(window, t0 + 61 * 60_000, null).admit).toBe(true);
  });

  it("requestChannelWake defers a capped wake, and wakes when it cannot tell", async () => {
    const wake = jest.fn();
    const full = Array.from({ length: 6 }, (_, i) => new Date(Date.now() - (i + 1) * 60_000).toISOString());
    mockRows.push(row("email", { wake_count_window: full }));
    expect(await requestChannelWake(AGENT, "email", wake)).toBe("deferred");
    expect(wake).not.toHaveBeenCalled();
    expect(mockUpdates[0].patch.deferred_wake_at).toEqual(expect.any(String));

    mockRows.length = 0;
    mockRows.push(row("email"));
    expect(await requestChannelWake(AGENT, "email", wake)).toBe("woke");
    expect(wake).toHaveBeenCalledTimes(1);

    mockReadFails = true;
    expect(await requestChannelWake(AGENT, "email", wake)).toBe("error");
    expect(wake).toHaveBeenCalledTimes(2);
  });
});

describe("the sweep", () => {
  const now = () => Date.parse("2026-11-13T12:00:00Z");
  const run = (adapters: ChannelWakeAdapter[], env: Record<string, string> = ENV_ON) => {
    const wake = jest.fn();
    return { wake, result: runChannelWakeSweep({ env, now, timeLeft: () => 60_000, wake, adapters }) };
  };

  it("does nothing at all when never configured", async () => {
    const { result } = run([adapter("email")], {});
    expect(await result).toBeNull();
  });

  it("runs a due deferred wake once, for a sleeping agent", async () => {
    mockAgents.set(AGENT, { status: "running", sleep_state: "napping", operation_id: null });
    mockRows.push(row("email", { deferred_wake_at: "2026-11-13T11:59:00Z" }));
    const { wake, result } = run([adapter("email")]);
    expect((await result)?.deferred_woke).toBe(1);
    expect(wake).toHaveBeenCalledWith(AGENT);
    expect(mockUpdates[0].options).toEqual({ deferredWakeAt: "2026-11-13T11:59:00Z" });
  });

  it("takes down an arm left on an awake agent", async () => {
    mockAgents.set(AGENT, { status: "running", sleep_state: "awake", operation_id: null });
    const email = adapter("email");
    mockRows.push(row("email", { state: "armed", arm_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }));
    const { wake, result } = run([email]);
    expect((await result)?.disarmed).toBe(1);
    expect(email.disarmForWake).toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
  });

  it("disarms and wakes a sleeping agent whose owner opted out", async () => {
    mockAgents.set(AGENT, { status: "running", sleep_state: "napping", operation_id: null });
    mockRows.push(row("email", { state: "armed", enabled: false }));
    const { wake, result } = run([adapter("email")]);
    await result;
    expect(wake).toHaveBeenCalledWith(AGENT);
  });

  it("leaves a covered sleeping agent's arm alone", async () => {
    mockAgents.set(AGENT, { status: "running", sleep_state: "napping", operation_id: null });
    const email = adapter("email");
    mockRows.push(row("email", { state: "armed" }));
    const { wake, result } = run([email]);
    await result;
    expect(email.disarmForWake).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
  });

  it("disarms and wakes a sleeping agent whose adapter can no longer hear it (a doorbell whose rings cannot reach Hivra)", async () => {
    mockAgents.set(AGENT, { status: "running", sleep_state: "napping", operation_id: null });
    const email = adapter("email", { canHear: () => false });
    mockRows.push(row("email", { state: "armed" }));
    const { wake, result } = run([email]);
    await result;
    expect(email.disarmForWake).toHaveBeenCalled();
    expect(wake).toHaveBeenCalledWith(AGENT);
  });

  it("arms late adapters, and blocks and wakes after repeated failures", async () => {
    mockAgents.set(AGENT, { status: "running", sleep_state: "napping", operation_id: null });
    const late = adapter("matrix", { armLater: jest.fn(async () => ({ ok: false as const, reason: "down" })) });
    mockRows.push(row("matrix", { state: "pending_arm", pending_since: "2026-11-13T11:00:00Z", arm_failures: ARM_MAX_FAILURES - 2 }));
    let out = run([late]);
    expect((await out.result)?.retry).toBe(1);
    expect(out.wake).not.toHaveBeenCalled();

    mockRows.length = 0;
    mockUpdates.length = 0;
    mockRows.push(row("matrix", { state: "pending_arm", pending_since: "2026-11-13T11:00:00Z", arm_failures: ARM_MAX_FAILURES - 1 }));
    out = run([late]);
    expect((await out.result)?.blocked).toBe(1);
    expect(out.wake).toHaveBeenCalledWith(AGENT);
    expect(mockUpdates.at(-1)?.patch).toMatchObject({ state: "idle", blocked_until: expect.any(String) });
  });

  it("wakes a sleeping agent that a failed wake left un-armable", async () => {
    mockAgents.set(AGENT, { status: "running", sleep_state: "napping", operation_id: null });
    mockRows.push(row("email", { state: "idle", pending_since: "2026-11-13T11:00:00Z" }));
    const { wake, result } = run([adapter("email")]);
    await result;
    expect(wake).toHaveBeenCalledWith(AGENT);
  });

  it("puts a row with no adapter back to idle and wakes a sleeping agent", async () => {
    mockAgents.set(AGENT, { status: "running", sleep_state: "napping", operation_id: null });
    mockRows.push(row("discord", { state: "armed" }));
    const { wake, result } = run([adapter("email")]);
    expect((await result)?.orphaned).toBe(1);
    expect(wake).toHaveBeenCalledWith(AGENT);
  });
});
