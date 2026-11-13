import "server-only";

import { randomUUID } from "node:crypto";
import { log } from "@/lib/logger";
import {
  channelWakeActsFor,
  channelWakeCleanupEnabled,
  isChannelWakeChannel,
  resolveChannelWakeConfig,
  type ChannelWakeChannel,
} from "./config";
import { TELEGRAM_CHANNEL_SPEC, coverableProbeTags } from "./registry";
import {
  readChannelWakeRows,
  updateChannelWakeRow,
  type ChannelWakeRow,
  type ChannelWakeState,
} from "./store";
import type {
  ChannelWakeAdapter,
  ChannelWakeAdapterContext,
  ChannelWakeProbeView,
  ChannelWakeTargetRef,
} from "./types";
import { TELEGRAM_ADAPTER, type TelegramDisarm, type TelegramSleepContext } from "./adapters/telegram";
import { MATRIX_ADAPTER } from "./adapters/matrix-pusher";
import type { ChannelSleepCoverage } from "../agent-sleep-scripts";
import type { TelegramProbeFacts } from "../telegram-wake/coverage";

/**
 * Channel wake as seen from a sleep and from a wake: the one place the sleep
 * and wake paths call, for Telegram and every other adapter.
 *
 * Sleep: coverage is a union. Each live channel must be covered by its own
 * adapter; one uncovered live channel keeps the agent awake. Adapters that
 * must arm before the stop (anything but Telegram) arm here, before the lease;
 * a failed arm keeps the agent awake.
 *
 * Wake: every adapter's disarm runs in parallel, each time-boxed, after
 * admission and before the computer resumes. A disarm that fails or times out
 * never stops the wake.
 *
 * With every switch off this reads nothing, and Telegram goes through exactly
 * the calls it always did.
 */

const LOG_SOURCE = "channel-wake";

/** Each adapter's disarm on the wake path gets at most this long. Telegram's own limit (two tries of 2.5 s) fits inside it. */
export const CHANNEL_DISARM_BOX_MS = 8_000;
/** Each adapter's arm before a sleep gets at most this long. */
export const CHANNEL_ARM_BOX_MS = 15_000;
/** At most this many channel wakes per agent in any hour; more are deferred, never dropped. */
export const CHANNEL_WAKES_PER_HOUR = 6;
const HOUR_MS = 60 * 60_000;

/**
 * The generic adapters, by channel: Matrix today (email and Discord are later
 * packages); each one also adds its spec to registry.ts. None of them acts
 * unless the channel wake switches are configured.
 */
export const CHANNEL_WAKE_ADAPTERS: readonly ChannelWakeAdapter[] = [MATRIX_ADAPTER];

type Env = Record<string, string | undefined>;

export interface ChannelWakeDeps {
  env?: Env;
  now?: () => number;
  adapters?: readonly ChannelWakeAdapter[];
}

const TIMED_OUT = Symbol("timed_out");

/** Waits for a promise at most `ms`. A rejection counts as the fallback too. */
async function timeBox<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); });
  try {
    return await Promise.race<T | typeof TIMED_OUT>([promise.catch((): typeof TIMED_OUT => TIMED_OUT), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function adapterFor(adapters: readonly ChannelWakeAdapter[], channel: unknown): ChannelWakeAdapter | null {
  return adapters.find((adapter) => adapter.channel === channel) ?? null;
}

function contextOf(row: ChannelWakeRow, channel: ChannelWakeChannel, extra: Partial<ChannelWakeAdapterContext> = {}): ChannelWakeAdapterContext {
  return {
    agentId: row.agent_id,
    channel,
    armId: row.arm_id ?? randomUUID(),
    armData: row.arm_data && typeof row.arm_data === "object" ? row.arm_data : {},
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Sleep side
// ---------------------------------------------------------------------------

/** One generic channel an agent opted into, where the switches let it act. */
export interface GenericChannelContext {
  adapter: ChannelWakeAdapter;
  row: ChannelWakeRow;
}

/** What a sleep needs, for every adapter. */
export interface ChannelSleepContexts {
  telegram: TelegramSleepContext | null;
  generic: GenericChannelContext[];
}

/**
 * Reads the generic channels' rows, only when the switches are on and an
 * adapter exists. With the switches off (or no adapter) this reads nothing.
 */
export async function readGenericChannelSleepContexts(
  agentId: string,
  hostSleepMode: unknown,
  deps: ChannelWakeDeps = {},
): Promise<GenericChannelContext[]> {
  const adapters = deps.adapters ?? CHANNEL_WAKE_ADAPTERS;
  if (adapters.length === 0) return [];
  const config = resolveChannelWakeConfig(deps.env ?? process.env);
  if (!config) return [];
  const rows = await readChannelWakeRows(agentId);
  const out: GenericChannelContext[] = [];
  for (const row of rows) {
    const adapter = adapterFor(adapters, row.channel);
    if (!adapter || !channelWakeActsFor(row.channel, row, { sleep_mode: hostSleepMode }, config)) continue;
    out.push({ adapter, row });
  }
  return out;
}

export interface ChannelCoverage {
  /** Live probe tags that are covered. */
  covered: string[];
  telegram: boolean;
  generic: GenericChannelContext[];
}

/**
 * The union: each live channel covered by its own adapter. Only Telegram in
 * play: exactly the Telegram-only rule (telegramCoverageFor), so nothing
 * changes for it.
 */
export function channelCoverageFor(
  contexts: ChannelSleepContexts,
  probe: (ChannelWakeProbeView & { telegram?: TelegramProbeFacts | null }) | null,
  nowMs: number,
): ChannelCoverage {
  if (contexts.generic.length === 0) {
    const covered = TELEGRAM_ADAPTER.coverageFor(contexts.telegram, probe, nowMs);
    return { covered, telegram: covered.length > 0, generic: [] };
  }
  const covered: string[] = [];
  const telegram = TELEGRAM_ADAPTER.coversItself(contexts.telegram, probe, nowMs);
  if (telegram) covered.push(TELEGRAM_CHANNEL_SPEC.probeTag);
  const generic: GenericChannelContext[] = [];
  for (const context of contexts.generic) {
    const blockers = context.adapter.coverageBlockers({
      acts: true,
      row: { enabled: context.row.enabled, credFp: context.row.cred_fp, blockedUntil: context.row.blocked_until },
      probe,
      nowMs,
    });
    if (blockers.length > 0) continue;
    covered.push(context.adapter.probeTag);
    generic.push(context);
  }
  const allowed = coverableProbeTags(contexts.generic.map((c) => c.adapter));
  return { covered: covered.filter((tag) => allowed.includes(tag)), telegram, generic };
}

/** The host script's form of a coverage that includes a generic channel, or null when only Telegram (or nothing) is covered. */
export function channelSleepCoverage(coverage: ChannelCoverage, telegramFp: string | null): ChannelSleepCoverage | null {
  if (coverage.generic.length === 0) return null;
  const fingerprints: Partial<Record<ChannelWakeChannel, string>> = {};
  if (coverage.telegram) {
    if (!telegramFp) return null;
    fingerprints.telegram = telegramFp;
  }
  for (const { adapter, row } of coverage.generic) {
    if (!row.cred_fp) return null;
    fingerprints[adapter.channel] = row.cred_fp;
  }
  return { channels: [...coverage.covered], fingerprints };
}

/** An arm made before a sleep, so it can be recorded or undone. */
export interface PreSleepArm {
  adapter: ChannelWakeAdapter;
  row: ChannelWakeRow;
  armId: string;
  armData: Record<string, unknown>;
}

/**
 * Arms every covered generic adapter that must arm before the stop. Each one
 * first checks nothing is left over from an earlier arm. All or nothing: on
 * any failure the arms already made are undone and the agent stays awake.
 */
export async function armChannelsBeforeSleep(
  coverage: ChannelCoverage,
  target: ChannelWakeTargetRef,
): Promise<{ ok: true; arms: PreSleepArm[] } | { ok: false; reason: string }> {
  const arms: PreSleepArm[] = [];
  for (const { adapter, row } of coverage.generic) {
    const armId = randomUUID();
    const ctx = contextOf(row, adapter.channel, { armId, target });
    const clear = await timeBox(adapter.verifyClear(ctx), CHANNEL_ARM_BOX_MS);
    if (clear !== true) {
      await undoChannelArms(arms);
      return { ok: false, reason: `${adapter.channel}_not_clear` };
    }
    if (!adapter.armBeforeSleep) continue;
    const result = await timeBox(adapter.armBeforeSleep(ctx), CHANNEL_ARM_BOX_MS);
    if (result === TIMED_OUT || !result.ok) {
      await undoChannelArms(arms);
      return { ok: false, reason: `${adapter.channel}_arm_failed` };
    }
    arms.push({ adapter, row, armId, armData: result.armData ?? {} });
  }
  return { ok: true, arms };
}

/** Takes arms made before a sleep back down, because the agent did not sleep. Best effort, never throws. */
export async function undoChannelArms(arms: readonly PreSleepArm[]): Promise<void> {
  await Promise.all(arms.map(async ({ adapter, row, armId, armData }) => {
    const done = await timeBox(adapter.disarmForWake(contextOf(row, adapter.channel, { armId, armData })), CHANNEL_DISARM_BOX_MS);
    if (done === TIMED_OUT || !done.ok) {
      // Recorded as armed, so the sweep sees an armed row of an awake agent and takes it down.
      await updateChannelWakeRow(row.agent_id, adapter.channel, ["idle", "pending_arm", "armed", "disarm_failed"], {
        state: "armed", arm_id: armId, arm_data: armData, last_error: "undo_failed",
      }).catch(() => false);
    }
  }));
}

/**
 * After a covered sleep: arms made before the stop are recorded as armed, and
 * adapters that arm later are marked to be armed by the sweep. Called while
 * the sleep still holds the agent. False when any mark failed: the caller then
 * wakes the agent, so it is never asleep and deaf.
 */
export async function markChannelsAfterSleep(
  agentId: string,
  coverage: ChannelCoverage,
  arms: readonly PreSleepArm[],
  deps: { now?: () => number } = {},
): Promise<boolean> {
  const now = deps.now ?? Date.now;
  const results = await Promise.all(coverage.generic.map(({ adapter }) => {
    const arm = arms.find((a) => a.adapter.channel === adapter.channel);
    if (arm) {
      return updateChannelWakeRow(agentId, adapter.channel, ["idle", "pending_arm", "armed", "disarm_failed"], {
        state: "armed", arm_id: arm.armId, arm_data: arm.armData, pending_since: null, next_attempt_at: null, last_error: null,
      });
    }
    if (adapter.armLater) {
      return updateChannelWakeRow(agentId, adapter.channel, ["idle", "pending_arm", "armed", "disarm_failed"], {
        state: "pending_arm", pending_since: new Date(now()).toISOString(), next_attempt_at: null,
      });
    }
    // An adapter with no arm at all (a push registered once at opt-in) needs no mark.
    return Promise.resolve(true);
  }));
  return results.every(Boolean);
}

// ---------------------------------------------------------------------------
// Wake side
// ---------------------------------------------------------------------------

export interface GenericDisarm {
  channel: ChannelWakeChannel;
  previous: ChannelWakeState;
  called: boolean;
  ok: boolean;
  timedOut: boolean;
  ms: number;
}

export interface ChannelDisarms {
  telegram: TelegramDisarm | null;
  generic: GenericDisarm[];
  /**
   * The guest's dead long-lived sockets should be dropped on resume: any
   * socket-based channel was armed (Telegram's long poll, a chat gateway).
   */
  killStaleSockets: boolean;
  ms: number;
}

const ARMED_STATES: readonly ChannelWakeState[] = ["arming", "armed", "disarm_failed"];

async function disarmTelegramBoxed(agentId: string, now: () => number): Promise<TelegramDisarm | null> {
  const startedAt = now();
  const result = await timeBox(TELEGRAM_ADAPTER.disarmForWake(agentId), CHANNEL_DISARM_BOX_MS);
  if (result !== TIMED_OUT) return result;
  // Still running: it settles the row itself. Treat it as taken back but not confirmed.
  return { previous: "armed", called: true, ok: false, ms: now() - startedAt };
}

async function disarmGenericRow(
  row: ChannelWakeRow,
  adapter: ChannelWakeAdapter,
  now: () => number,
): Promise<GenericDisarm> {
  const startedAt = now();
  const takenBack = new Date(startedAt).toISOString();
  const previous = row.state;
  if (previous === "pending_arm") {
    await updateChannelWakeRow(row.agent_id, adapter.channel, ["pending_arm"], { state: "idle", pending_since: takenBack, next_attempt_at: null });
    return { channel: adapter.channel, previous, called: false, ok: true, timedOut: false, ms: now() - startedAt };
  }
  const done = await timeBox(adapter.disarmForWake(contextOf(row, adapter.channel)), CHANNEL_DISARM_BOX_MS);
  const timedOut = done === TIMED_OUT;
  const ok = !timedOut && done.ok;
  if (ok) {
    await updateChannelWakeRow(row.agent_id, adapter.channel, ARMED_STATES, {
      state: "idle", pending_since: takenBack, next_attempt_at: null, last_error: null,
    });
  } else {
    await updateChannelWakeRow(row.agent_id, adapter.channel, ARMED_STATES, {
      state: "disarm_failed", last_error: timedOut ? "disarm_timeout" : "disarm_failed",
    });
    log.warn("channel wake not disarmed before a wake; the sweep retries", {
      source: LOG_SOURCE,
      failureType: "channel_disarm_failed",
      instanceId: row.agent_id,
      channel: adapter.channel,
    });
  }
  return { channel: adapter.channel, previous, called: true, ok, timedOut, ms: now() - startedAt };
}

/**
 * Takes every channel's arm down for a wake, in parallel, each time-boxed.
 * Called after admission and before the host resumes the computer. Never
 * throws, and nothing here can stop the wake.
 */
export async function disarmChannelsForWake(agentId: string, deps: ChannelWakeDeps = {}): Promise<ChannelDisarms> {
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const adapters = deps.adapters ?? CHANNEL_WAKE_ADAPTERS;
  const startedAt = now();
  const genericWork = async (): Promise<GenericDisarm[]> => {
    if (adapters.length === 0 || !channelWakeCleanupEnabled(env)) return [];
    let rows: ChannelWakeRow[];
    try {
      rows = await readChannelWakeRows(agentId);
    } catch {
      return [];
    }
    const work = rows.flatMap((row) => {
      const adapter = adapterFor(adapters, row.channel);
      return adapter && row.state !== "idle" ? [disarmGenericRow(row, adapter, now)] : [];
    });
    return (await Promise.all(work.map((p) => p.catch(() => null)))).filter((d): d is GenericDisarm => d !== null);
  };
  const [telegram, generic] = await Promise.all([
    disarmTelegramBoxed(agentId, now).catch(() => null),
    genericWork(),
  ]);
  const socketArmed = generic.some((d) => d.called && adapterFor(adapters, d.channel)?.socketBased === true);
  return { telegram, generic, killStaleSockets: Boolean(telegram) || socketArmed, ms: now() - startedAt };
}

/**
 * A wake that failed after the arms came down: the computer may still be
 * asleep. Telegram goes back to waiting for its sweep, as before. A generic
 * adapter that arms later does the same; one that must arm before a stop
 * cannot be armed while asleep, so its mark stays and the sweep wakes the
 * agent instead (never asleep and deaf).
 */
export async function rearmChannelsAfterFailedWake(
  agentId: string,
  disarms: ChannelDisarms | null,
  deps: ChannelWakeDeps = {},
): Promise<void> {
  if (!disarms) return;
  const now = deps.now ?? Date.now;
  const adapters = deps.adapters ?? CHANNEL_WAKE_ADAPTERS;
  if (disarms.telegram) await TELEGRAM_ADAPTER.rearmAfterFailedWake(agentId, disarms.telegram).catch(() => undefined);
  await Promise.all(disarms.generic.map(async (d) => {
    if (!adapterFor(adapters, d.channel)?.armLater) return;
    await updateChannelWakeRow(agentId, d.channel, ["idle"], {
      state: "pending_arm", pending_since: new Date(now()).toISOString(), next_attempt_at: null,
    }).catch(() => false);
  }));
}

/** A wake that succeeded: the marks go. */
export async function settleChannelsAfterWake(agentId: string, disarms: ChannelDisarms | null): Promise<void> {
  if (!disarms) return;
  if (disarms.telegram) await TELEGRAM_ADAPTER.settleAfterWake(agentId, disarms.telegram).catch(() => undefined);
  await Promise.all(disarms.generic.map((d) =>
    updateChannelWakeRow(agentId, d.channel, ["idle"], { pending_since: null }).catch(() => false)));
}

/** A deleted agent: Telegram as before, and every generic adapter releases what it set up. Never throws. */
export async function releaseChannelWakeOnDelete(agentId: string, deps: ChannelWakeDeps = {}): Promise<void> {
  await TELEGRAM_ADAPTER.release(agentId).catch(() => undefined);
  const adapters = deps.adapters ?? CHANNEL_WAKE_ADAPTERS;
  if (adapters.length === 0 || !channelWakeCleanupEnabled(deps.env ?? process.env)) return;
  try {
    const rows = await readChannelWakeRows(agentId);
    await Promise.all(rows.map(async (row) => {
      const adapter = adapterFor(adapters, row.channel);
      if (!adapter) return;
      await timeBox(adapter.release(contextOf(row, adapter.channel)), CHANNEL_DISARM_BOX_MS);
      await updateChannelWakeRow(agentId, adapter.channel, [row.state], {
        enabled: false, state: "idle", arm_id: null, arm_data: {}, pending_since: null, next_attempt_at: null, deferred_wake_at: null,
      });
    }));
  } catch {
    // The rows go with the agent (on delete cascade).
  }
}

// ---------------------------------------------------------------------------
// Wake cap
// ---------------------------------------------------------------------------

export interface WakeCapDecision {
  admit: boolean;
  /** The window to store: wake times inside the last hour, newest last. */
  window: string[];
  /** When a capped wake will run instead. Null when admitted. */
  deferredWakeAt: string | null;
}

/**
 * At most CHANNEL_WAKES_PER_HOUR wakes in any hour. A wake over the cap is
 * deferred to when the oldest wake in the window leaves it (or an earlier
 * deferral that is already set), never dropped. Pure.
 */
export function channelWakeCapDecision(window: unknown, nowMs: number, deferredWakeAt: string | null): WakeCapDecision {
  const recent = (Array.isArray(window) ? window : [])
    .filter((v): v is string => typeof v === "string")
    .map((v) => Date.parse(v))
    .filter((t) => Number.isFinite(t) && t > nowMs - HOUR_MS && t <= nowMs)
    .sort((a, b) => a - b);
  if (recent.length < CHANNEL_WAKES_PER_HOUR) {
    return { admit: true, window: [...recent, nowMs].map((t) => new Date(t).toISOString()), deferredWakeAt: null };
  }
  const freeAt = recent[recent.length - CHANNEL_WAKES_PER_HOUR] + HOUR_MS;
  const existing = deferredWakeAt ? Date.parse(deferredWakeAt) : Number.NaN;
  const at = Number.isFinite(existing) && existing > nowMs && existing <= freeAt ? existing : freeAt;
  return { admit: false, window: recent.map((t) => new Date(t).toISOString()), deferredWakeAt: new Date(at).toISOString() };
}

export type ChannelWakeRequest = "woke" | "deferred" | "no_row" | "error";

/**
 * A message arrived on a channel of a sleeping agent: wake it, unless that
 * would pass the hourly cap, in which case the wake is deferred and the sweep
 * runs it later. `wake` starts the wake (trigger "channel") and must not throw.
 * When the cap cannot be read or written the agent is woken anyway.
 */
export async function requestChannelWake(
  agentId: string,
  channel: ChannelWakeChannel,
  wake: (agentId: string, channel: ChannelWakeChannel) => void,
  deps: { now?: () => number } = {},
): Promise<ChannelWakeRequest> {
  if (!isChannelWakeChannel(channel) || channel === "telegram") return "no_row";
  const now = deps.now ?? Date.now;
  let row: ChannelWakeRow | undefined;
  try {
    row = (await readChannelWakeRows(agentId)).find((r) => r.channel === channel);
  } catch {
    wake(agentId, channel);
    return "error";
  }
  if (!row) return "no_row";
  const decision = channelWakeCapDecision(row.wake_count_window, now(), row.deferred_wake_at);
  const saved = await updateChannelWakeRow(agentId, channel, [row.state], {
    wake_count_window: decision.window,
    ...(decision.admit ? {} : { deferred_wake_at: decision.deferredWakeAt }),
  }).catch(() => false);
  if (decision.admit || !saved) {
    wake(agentId, channel);
    return saved ? "woke" : "error";
  }
  return "deferred";
}
