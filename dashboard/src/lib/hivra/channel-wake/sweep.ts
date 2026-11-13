import "server-only";

import { randomUUID } from "node:crypto";
import { log } from "@/lib/logger";
import { channelWakeCleanupEnabled, resolveChannelWakeConfig, type ChannelWakeConfig } from "./config";
import { CHANNEL_WAKE_ADAPTERS, CHANNEL_ARM_BOX_MS, CHANNEL_DISARM_BOX_MS } from "./lifecycle";
import {
  readChannelWakeAgentFacts,
  readChannelWakeWorkRows,
  updateChannelWakeRow,
  type ChannelWakeRow,
} from "./store";
import type { ChannelWakeAdapter, ChannelWakeAdapterContext } from "./types";

/**
 * The sleep sweep's step for every generic channel (Telegram keeps its own
 * step, telegram-wake/sweep.ts). Once a minute it:
 *
 * - runs deferred wakes that are due (a wake over the hourly cap waits here,
 *   it is never dropped);
 * - arms adapters that arm late, once the nap is ARM_AFTER_SLEEP_S old;
 * - takes down every arm that should not be there any more (the agent is
 *   awake, gone, opted out, or the feature was switched off);
 * - and, for an agent left asleep that no adapter can hear any more, wakes it.
 *
 * Fail toward awake: whenever the sweep cannot keep a sleeping agent covered,
 * it wakes the agent.
 */

const LOG_SOURCE = "channel-wake-sweep";

export const ARM_AFTER_SLEEP_S = 20;
export const ARM_MAX_FAILURES = 3;
export const BLOCK_MS = 24 * 60 * 60_000;
const RETRY_BASE_MS = 30_000;
const ROWS_PER_RUN = 50;
/** An arm in flight older than this is treated as abandoned. */
const STALE_ARM_MS = 2 * 60_000;
/** Time that must be left before another row is touched. */
const MIN_ROW_TIME_MS = CHANNEL_DISARM_BOX_MS;

export interface ChannelSweepCounts {
  rows: number;
  armed: number;
  retry: number;
  blocked: number;
  disarmed: number;
  disarm_failed: number;
  /** Deferred wakes that ran. */
  deferred_woke: number;
  /** Agents woken because nothing could hear them any more. */
  woke: number;
  /** Rows of a channel with no adapter, put back to idle. */
  orphaned: number;
}

export interface ChannelSweepOptions {
  env?: Record<string, string | undefined>;
  now?: () => number;
  timeLeft: () => number;
  /** Starts a wake (trigger "channel"). Must not throw. */
  wake: (agentId: string) => void;
  adapters?: readonly ChannelWakeAdapter[];
}

const ASLEEP = new Set(["napping", "hibernated"]);

function emptyCounts(): ChannelSweepCounts {
  return { rows: 0, armed: 0, retry: 0, blocked: 0, disarmed: 0, disarm_failed: 0, deferred_woke: 0, woke: 0, orphaned: 0 };
}

async function boxed<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.catch(() => null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function ctxOf(row: ChannelWakeRow, adapter: ChannelWakeAdapter, armId?: string): ChannelWakeAdapterContext {
  return {
    agentId: row.agent_id,
    channel: adapter.channel,
    armId: armId ?? row.arm_id ?? randomUUID(),
    armData: row.arm_data && typeof row.arm_data === "object" ? row.arm_data : {},
  };
}

function due(value: string | null, nowMs: number): boolean {
  if (!value) return true;
  const at = Date.parse(value);
  return !Number.isFinite(at) || at <= nowMs;
}

/** The sweep step. Null when the feature was never configured (no secret): it then does nothing at all. */
export async function runChannelWakeSweep(options: ChannelSweepOptions): Promise<ChannelSweepCounts | null> {
  const env = options.env ?? process.env;
  if (!channelWakeCleanupEnabled(env)) return null;
  const now = options.now ?? Date.now;
  const adapters = options.adapters ?? CHANNEL_WAKE_ADAPTERS;
  const config = resolveChannelWakeConfig(env);
  const counts = emptyCounts();

  let rows: ChannelWakeRow[];
  let agents: Awaited<ReturnType<typeof readChannelWakeAgentFacts>>;
  try {
    rows = await readChannelWakeWorkRows(ROWS_PER_RUN, now());
    agents = await readChannelWakeAgentFacts([...new Set(rows.map((r) => r.agent_id))]);
  } catch {
    log.warn("channel wake sweep could not read its rows", { source: LOG_SOURCE, failureType: "channel_wake_sweep_read_failed" });
    return counts;
  }
  const wokeThisRun = new Set<string>();
  const wake = (agentId: string) => {
    if (wokeThisRun.has(agentId)) return;
    wokeThisRun.add(agentId);
    options.wake(agentId);
  };

  for (const row of rows) {
    if (options.timeLeft() < MIN_ROW_TIME_MS) break;
    counts.rows += 1;
    try {
      await sweepRow(row, { adapters, config, now, counts, wake, agent: agents.get(row.agent_id) ?? null });
    } catch {
      log.warn("channel wake sweep row failed", { source: LOG_SOURCE, failureType: "channel_wake_sweep_row_failed", instanceId: row.agent_id });
    }
  }
  return counts;
}

interface RowContext {
  adapters: readonly ChannelWakeAdapter[];
  config: ChannelWakeConfig | null;
  now: () => number;
  counts: ChannelSweepCounts;
  wake: (agentId: string) => void;
  agent: { status: string | null; sleep_state: string | null; operation_id: string | null } | null;
}

async function sweepRow(row: ChannelWakeRow, rc: RowContext): Promise<void> {
  const { counts, now } = rc;
  const nowMs = now();
  const asleep = Boolean(rc.agent && ASLEEP.has(String(rc.agent.sleep_state)) && rc.agent.status !== "stopped");
  const awake = Boolean(rc.agent && rc.agent.sleep_state === "awake");

  // 1. A deferred wake that is due runs once, whatever else the row holds.
  if (row.deferred_wake_at && due(row.deferred_wake_at, nowMs)) {
    const cleared = await updateChannelWakeRow(row.agent_id, row.channel, [row.state], { deferred_wake_at: null }, { deferredWakeAt: row.deferred_wake_at });
    if (cleared && asleep) {
      counts.deferred_woke += 1;
      rc.wake(row.agent_id);
    }
  }

  const adapter = rc.adapters.find((a) => a.channel === row.channel) ?? null;
  if (!adapter) {
    if (row.state !== "idle" || row.pending_since) {
      // Nothing can take this arm down or hear it. Idle, and a sleeping agent is woken.
      await updateChannelWakeRow(row.agent_id, row.channel, [row.state], { state: "idle", pending_since: null, last_error: "no_adapter" });
      counts.orphaned += 1;
      if (asleep) rc.wake(row.agent_id);
    }
    return;
  }
  const acts = Boolean(rc.config && rc.config.channels.has(adapter.channel) && row.enabled === true);

  switch (row.state) {
    case "armed":
    case "arming":
    case "disarm_failed": {
      if (row.state === "armed" && asleep && acts) return;
      if (row.state === "arming" && row.updated_at && nowMs - Date.parse(row.updated_at) < STALE_ARM_MS) return;
      // A wake in flight takes its own arms down.
      if (rc.agent?.sleep_state === "waking") return;
      const done = await boxed(adapter.disarmForWake(ctxOf(row, adapter)), CHANNEL_DISARM_BOX_MS);
      if (done?.ok) {
        await updateChannelWakeRow(row.agent_id, adapter.channel, [row.state], {
          state: "idle", pending_since: null, next_attempt_at: null, last_error: null,
        }, { armId: row.arm_id });
        counts.disarmed += 1;
      } else {
        await updateChannelWakeRow(row.agent_id, adapter.channel, [row.state], { state: "disarm_failed", last_error: "disarm_failed" });
        counts.disarm_failed += 1;
      }
      // Asleep and no longer covered: nothing will hear it.
      if (asleep) rc.wake(row.agent_id);
      return;
    }
    case "pending_arm": {
      if (!asleep) {
        await updateChannelWakeRow(row.agent_id, adapter.channel, ["pending_arm"], { state: "idle", pending_since: null, next_attempt_at: null });
        return;
      }
      if (!acts || !adapter.armLater) {
        await updateChannelWakeRow(row.agent_id, adapter.channel, ["pending_arm"], { state: "idle", pending_since: null, next_attempt_at: null });
        rc.wake(row.agent_id);
        return;
      }
      const since = row.pending_since ? Date.parse(row.pending_since) : Number.NaN;
      if (Number.isFinite(since) && nowMs - since < ARM_AFTER_SLEEP_S * 1000) return;
      if (!due(row.next_attempt_at, nowMs)) return;
      await armLater(row, adapter, rc);
      return;
    }
    case "idle": {
      if (!row.pending_since) return;
      // A wake took this row back. Awake: the mark goes. Still asleep: arm again, or wake it.
      if (awake) {
        await updateChannelWakeRow(row.agent_id, adapter.channel, ["idle"], { pending_since: null });
        return;
      }
      if (!asleep) return;
      if (acts && adapter.armLater) {
        await updateChannelWakeRow(row.agent_id, adapter.channel, ["idle"], {
          state: "pending_arm", pending_since: new Date(nowMs).toISOString(), next_attempt_at: null,
        });
        return;
      }
      await updateChannelWakeRow(row.agent_id, adapter.channel, ["idle"], { pending_since: null });
      rc.wake(row.agent_id);
      return;
    }
    default:
      return;
  }
}

async function armLater(row: ChannelWakeRow, adapter: ChannelWakeAdapter, rc: RowContext): Promise<void> {
  const { counts, now } = rc;
  const armId = randomUUID();
  const claimed = await updateChannelWakeRow(row.agent_id, adapter.channel, ["pending_arm"], { state: "arming", arm_id: armId });
  if (!claimed) return;
  const result = await boxed(adapter.armLater!(ctxOf(row, adapter, armId)), CHANNEL_ARM_BOX_MS);
  if (result?.ok) {
    const kept = await updateChannelWakeRow(row.agent_id, adapter.channel, ["arming"], {
      state: "armed", arm_data: result.armData ?? {}, arm_failures: 0, next_attempt_at: null, last_error: null,
    }, { armId });
    if (kept) counts.armed += 1;
    else {
      // A wake took the row over meanwhile: take this arm back down.
      await boxed(adapter.disarmForWake(ctxOf(row, adapter, armId)), CHANNEL_DISARM_BOX_MS);
    }
    return;
  }
  const failures = (Number.isSafeInteger(row.arm_failures) ? row.arm_failures : 0) + 1;
  if (failures >= ARM_MAX_FAILURES) {
    await updateChannelWakeRow(row.agent_id, adapter.channel, ["arming"], {
      state: "idle", arm_failures: failures, pending_since: null, next_attempt_at: null,
      blocked_until: new Date(now() + BLOCK_MS).toISOString(), last_error: "arm_failed",
    }, { armId });
    counts.blocked += 1;
    rc.wake(row.agent_id);
    return;
  }
  const waitMs = result && !result.ok && typeof result.retryAfterMs === "number" && result.retryAfterMs > 0
    ? Math.min(result.retryAfterMs, 60 * 60_000)
    : RETRY_BASE_MS * failures;
  await updateChannelWakeRow(row.agent_id, adapter.channel, ["arming"], {
    state: "pending_arm", arm_failures: failures, next_attempt_at: new Date(now() + waitMs).toISOString(), last_error: "arm_failed",
  }, { armId });
  counts.retry += 1;
}
