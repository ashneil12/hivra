import "server-only";

import { randomUUID } from "node:crypto";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import { resolveHivraProxmoxHost } from "../proxmox-target";
import {
  resolveTelegramWakeConfig,
  telegramWakeHostAllowed,
  telegramWakeSecretToken,
  telegramWakeWebhookUrl,
  type TelegramWakeConfig,
} from "./config";
import { telegramGetWebhook, telegramSetWakeWebhook } from "./bot-api";
import { decryptTelegramToken, deleteWakeWebhook, type TelegramWakeDeps } from "./lifecycle";
import {
  claimTelegramArm,
  finishTelegramArm,
  readTelegramWakeWorkRows,
  updateTelegramWakeRow,
  type TelegramWakeRow,
} from "./store";

/**
 * The sleep sweep's Telegram step: set the wake webhook on bots whose agent has
 * been asleep long enough, and take down every webhook that should not be
 * there any more (the agent is awake, stopped or gone, the owner opted out, or
 * the feature was switched off).
 *
 * Arming waits until the nap is ARM_AFTER_NAP_S old: Hermes' last long poll
 * (about 10 s) must have ended, or setWebhook would race it. It never replaces
 * a webhook someone else set: that blocks the bot for a day and wakes the
 * agent so it keeps working. Three failed arms do the same. A 429 waits as
 * long as Telegram says.
 */

const LOG_SOURCE = "telegram-wake-sweep";

export const ARM_AFTER_NAP_S = 20;
export const ARM_MAX_FAILURES = 3;
export const BLOCK_MS = 24 * 60 * 60_000;
const RETRY_BASE_MS = 30_000;
const DEFAULT_RATE_LIMIT_S = 30;
const ROWS_PER_RUN = 50;
/** An arm older than this is treated as abandoned. Matches the claim function. */
const STALE_ARM_MS = 2 * 60_000;
const TELEGRAM_TIMEOUT_MS = 5_000;
/** Time that must be left before another row is touched. */
const MIN_ROW_TIME_MS = 6_000;

export interface TelegramSweepCounts {
  rows: number;
  armed: number;
  /** Arms that found the row taken over by a wake and took their webhook down again. */
  undone: number;
  retry: number;
  blocked: number;
  disarmed: number;
  disarm_failed: number;
  wiped: number;
  woke: number;
}

export interface TelegramSweepOptions extends TelegramWakeDeps {
  /** Milliseconds left in the sweep's budget. */
  timeLeft: () => number;
  /** Starts a wake of an agent that would otherwise be left asleep and deaf. Must not throw. */
  wake: (agentId: string) => void;
}

interface AgentFacts {
  status: string | null;
  desired_state: string | null;
  sleep_state: string | null;
  operation_id: string | null;
  proxmox_host: string | null;
}

function emptyCounts(): TelegramSweepCounts {
  return { rows: 0, armed: 0, undone: 0, retry: 0, blocked: 0, disarmed: 0, disarm_failed: 0, wiped: 0, woke: 0 };
}

async function readAgents(ids: string[]): Promise<Map<string, AgentFacts>> {
  const out = new Map<string, AgentFacts>();
  if (!supabaseAdmin || ids.length === 0) return out;
  const { data, error } = await supabaseAdmin
    .from("hivra_agents")
    .select("id, status, desired_state, sleep_state, operation_id, proxmox_host")
    .in("id", ids);
  if (error) throw new Error("agents_read_failed");
  for (const row of (data ?? []) as Array<AgentFacts & { id: string }>) out.set(String(row.id), row);
  return out;
}

async function readHostModes(agents: Iterable<AgentFacts>): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (!supabaseAdmin) return out;
  const ids = [...new Set([...agents].map((a) => resolveHivraProxmoxHost(a.proxmox_host)))];
  if (ids.length === 0) return out;
  const { data, error } = await supabaseAdmin.from("proxmox_hosts").select("id, sleep_mode").in("id", ids);
  if (error) throw new Error("hosts_read_failed");
  for (const row of (data ?? []) as Array<{ id: string; sleep_mode: string | null }>) out.set(String(row.id), row.sleep_mode);
  return out;
}

const isAsleep = (agent: AgentFacts | undefined): boolean =>
  !!agent && agent.status === "running" && agent.desired_state === "running" && agent.operation_id == null
  && (agent.sleep_state === "napping" || agent.sleep_state === "hibernated");

function blocked(row: TelegramWakeRow, nowMs: number): boolean {
  if (!row.blocked_until) return false;
  const until = Date.parse(row.blocked_until);
  return !Number.isFinite(until) || until > nowMs;
}

/** Arms one row under the claim. */
async function armOne(
  row: TelegramWakeRow,
  config: TelegramWakeConfig,
  options: TelegramSweepOptions,
  counts: TelegramSweepCounts,
): Promise<void> {
  const now = options.now ?? Date.now;
  const agentId = row.agent_id;
  const armId = randomUUID();
  const failures = await claimTelegramArm(agentId, armId, ARM_AFTER_NAP_S);
  if (failures === null) return;
  const iso = (ms: number) => new Date(now() + ms).toISOString();

  const block = async (error: string) => {
    await finishTelegramArm({ agentId, armId, result: "blocked", retryAt: iso(BLOCK_MS), error });
    counts.blocked += 1;
    log.warn("telegram wake blocked for a day; the agent is woken so it keeps working", {
      source: LOG_SOURCE,
      failureType: "telegram_wake_blocked",
      instanceId: agentId,
      reason: error,
    });
    options.wake(agentId);
    counts.woke += 1;
  };
  const later = async (retryAfterS: number | undefined) => {
    await finishTelegramArm({
      agentId, armId, result: "pending_arm", retryAt: iso((retryAfterS ?? DEFAULT_RATE_LIMIT_S) * 1000), error: "rate_limited",
    });
    counts.retry += 1;
  };
  const failed = async (error: string) => {
    if (failures + 1 >= ARM_MAX_FAILURES) return block(error);
    await finishTelegramArm({ agentId, armId, result: "pending_arm", failed: true, retryAt: iso(RETRY_BASE_MS * (failures + 1)), error });
    counts.retry += 1;
  };

  const token = decryptTelegramToken(row);
  if (!token) return block("token_unreadable");
  const url = telegramWakeWebhookUrl(config, agentId);
  const call = { fetchImpl: options.fetchImpl, timeoutMs: TELEGRAM_TIMEOUT_MS };

  const info = await telegramGetWebhook(token, call);
  if (info.reason === "rate_limited") return later(info.retryAfterS);
  if (info.reason === "unauthorized") return block("token_revoked");
  if (!info.ok || !info.result) return failed("webhook_info_failed");
  // Someone else's webhook is never replaced. Our own address (an arm that
  // lost its answer) is set again with this arm's secret.
  if (info.result.url !== "" && info.result.url !== url) return block("foreign_webhook");

  const set = await telegramSetWakeWebhook(token, { url, secretToken: telegramWakeSecretToken(config.secret, agentId, armId) }, call);
  if (set.reason === "rate_limited") return later(set.retryAfterS);
  if (set.reason === "unauthorized") return block("token_revoked");
  if (!set.ok) return failed("set_webhook_failed");

  if (await finishTelegramArm({ agentId, armId, result: "armed" })) {
    counts.armed += 1;
    return;
  }
  // A wake took the row while this arm ran: the webhook just set must not stay.
  const undone = await deleteWakeWebhook(token, options);
  counts.undone += 1;
  if (!undone.ok) {
    await updateTelegramWakeRow(agentId, ["idle"], { state: "disarm_failed", last_error: "undo_failed" });
    counts.disarm_failed += 1;
  }
}

/** Takes a webhook down and settles the row at `to`. */
async function disarmRow(row: TelegramWakeRow, to: "idle" | "pending_arm", options: TelegramSweepOptions, counts: TelegramSweepCounts) {
  const now = options.now ?? Date.now;
  const token = decryptTelegramToken(row);
  const deleted = token ? await deleteWakeWebhook(token, options) : { ok: false, reason: "token_unreadable" };
  if (deleted.ok) {
    await updateTelegramWakeRow(row.agent_id, [row.state], {
      state: to,
      pending_since: to === "pending_arm" ? new Date(now()).toISOString() : null,
      next_attempt_at: null,
      last_error: null,
    });
    counts.disarmed += 1;
  } else {
    await updateTelegramWakeRow(row.agent_id, [row.state], { state: "disarm_failed", last_error: `disarm_${deleted.reason}`.slice(0, 40) });
    counts.disarm_failed += 1;
  }
  return deleted.ok;
}

async function settleRow(
  row: TelegramWakeRow,
  agent: AgentFacts | undefined,
  hostMode: string | null | undefined,
  config: TelegramWakeConfig | null,
  options: TelegramSweepOptions,
  counts: TelegramSweepCounts,
): Promise<void> {
  const nowMs = (options.now ?? Date.now)();
  // A wake or sleep in flight owns the row's next step.
  if (agent?.operation_id != null) return;
  const asleep = isAsleep(agent);
  const wanted = !!config && row.enabled && !!row.token_enc && asleep && !blocked(row, nowMs)
    && telegramWakeHostAllowed(config, hostMode);
  // An asleep agent losing its wake would sit deaf until someone opens it.
  const wakeIfAsleep = () => {
    if (!asleep) return;
    options.wake(row.agent_id);
    counts.woke += 1;
  };

  switch (row.state) {
    case "pending_arm":
      if (wanted) return armOne(row, config!, options, counts);
      if (await updateTelegramWakeRow(row.agent_id, ["pending_arm"], { state: "idle", pending_since: null, next_attempt_at: null })) {
        wakeIfAsleep();
      }
      return;
    case "arming": {
      const startedAt = row.arm_started_at ? Date.parse(row.arm_started_at) : Number.NaN;
      if (Number.isFinite(startedAt) && nowMs - startedAt < STALE_ARM_MS) return;
      if (wanted) return armOne(row, config!, options, counts);
      if (await disarmRow(row, "idle", options, counts)) wakeIfAsleep();
      return;
    }
    case "armed":
      if (wanted) return;
      if (await disarmRow(row, "idle", options, counts)) wakeIfAsleep();
      return;
    case "disarm_failed":
      await disarmRow(row, wanted ? "pending_arm" : "idle", options, counts);
      if (!wanted) wakeIfAsleep();
      return;
    case "idle":
      // The owner opted out and every webhook is down: forget the token.
      if (!row.enabled && row.token_enc) {
        if (await updateTelegramWakeRow(row.agent_id, ["idle"], { token_enc: null, token_fp: null, bot_id: null })) counts.wiped += 1;
      }
      return;
  }
}

/** One pass over the rows that have work. Never throws. */
export async function runTelegramWakeSweep(options: TelegramSweepOptions): Promise<TelegramSweepCounts> {
  const counts = emptyCounts();
  const config = resolveTelegramWakeConfig(options.env ?? process.env);
  try {
    const rows = await readTelegramWakeWorkRows(ROWS_PER_RUN);
    counts.rows = rows.length;
    if (rows.length === 0) return counts;
    const agents = await readAgents(rows.map((row) => row.agent_id));
    const hosts = config?.mode === "canary" ? await readHostModes(agents.values()) : new Map<string, string | null>();
    for (const row of rows) {
      if (options.timeLeft() < MIN_ROW_TIME_MS) break;
      const agent = agents.get(row.agent_id);
      const hostMode = agent ? hosts.get(resolveHivraProxmoxHost(agent.proxmox_host)) : undefined;
      try {
        await settleRow(row, agent, hostMode, config, options, counts);
      } catch {
        log.warn("telegram wake row could not be settled", {
          source: LOG_SOURCE,
          failureType: "telegram_wake_row_failed",
          instanceId: row.agent_id,
        });
      }
    }
  } catch {
    log.warn("telegram wake sweep could not read its rows", { source: LOG_SOURCE, failureType: "telegram_wake_sweep_read_failed" });
  }
  return counts;
}
