import "server-only";

import { log } from "@/lib/logger";
import { decryptSecret } from "@/lib/crypto";
import {
  resolveTelegramWakeConfig,
  telegramWakeCleanupEnabled,
  telegramWakeHostAllowed,
  type TelegramWakeConfig,
} from "./config";
import { telegramDeleteWebhook, telegramGetWebhook, type TelegramFetch } from "./bot-api";
import { telegramWakeCoverage, type TelegramProbeFacts } from "./coverage";
import {
  tryReadTelegramWakeRow,
  updateTelegramWakeRow,
  type TelegramWakeRow,
  type TelegramWakeState,
} from "./store";

/**
 * Telegram wake-on-message, as seen from a sleep and from a wake.
 *
 * Sleep: before a covered agent sleeps, its bot must have no webhook. After
 * the sleep, the row waits for the sweep to arm it (sweep.ts).
 *
 * Wake: after admission and before the host resumes the computer, the webhook
 * is deleted, so Hermes finds plain polling and every queued message when it
 * comes back. The row is left idle with pending_since kept as a mark: "taken
 * back for a wake". A wake that succeeds clears the mark. If the wake fails,
 * or is cut off before it can say so, the sweep finds the mark and arms the
 * bot again while the agent is still asleep, so it is never left deaf.
 *
 * The bot token is decrypted only for a Telegram call and is never logged.
 */

const LOG_SOURCE = "telegram-wake";

/** deleteWebhook on the wake path: short, and one retry. */
export const DISARM_TIMEOUT_MS = 2_500;
const WEBHOOK_INFO_TIMEOUT_MS = 4_000;

export interface TelegramWakeDeps {
  fetchImpl?: TelegramFetch;
  now?: () => number;
  env?: Record<string, string | undefined>;
}

/** The token in plain text, or null when there is none or it cannot be decrypted. */
export function decryptTelegramToken(row: Pick<TelegramWakeRow, "token_enc"> | null): string | null {
  if (!row?.token_enc) return null;
  try {
    return decryptSecret(row.token_enc);
  } catch {
    return null;
  }
}

/** deleteWebhook with the wake path's limits. A revoked token has no webhook to keep, so it counts as done. */
export async function deleteWakeWebhook(token: string, deps: TelegramWakeDeps = {}): Promise<{ ok: boolean; reason: string }> {
  let last = "network";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await telegramDeleteWebhook(token, { fetchImpl: deps.fetchImpl, timeoutMs: DISARM_TIMEOUT_MS });
    if (result.ok || result.reason === "unauthorized") return { ok: true, reason: result.reason };
    last = result.reason;
    if (result.reason === "bad_token") break;
  }
  return { ok: false, reason: last };
}

// ---------------------------------------------------------------------------
// Sleep side
// ---------------------------------------------------------------------------

/** What a sleep needs to decide coverage. null means the feature does not apply to this agent. */
export interface TelegramSleepContext {
  config: TelegramWakeConfig;
  row: TelegramWakeRow;
  hostAllowed: boolean;
  /** The live channel covered, from the agent's wake profile (HIVRA_AGENT_PROFILES on). Absent: "hermes:telegram". */
  tag?: string;
}

/**
 * Reads what a sleep needs, only when the server switch is fully on and the
 * owner opted in. With the switch off this reads nothing at all.
 */
export async function readTelegramSleepContext(
  agentId: string,
  hostSleepMode: unknown,
  env: Record<string, string | undefined> = process.env,
): Promise<TelegramSleepContext | null> {
  const config = resolveTelegramWakeConfig(env);
  if (!config) return null;
  const row = await tryReadTelegramWakeRow(agentId);
  if (!row || row.enabled !== true) return null;
  return { config, row, hostAllowed: telegramWakeHostAllowed(config, hostSleepMode) };
}

/** The channels a wake covers for this probe. Empty without a context. */
export function telegramCoverageFor(
  context: TelegramSleepContext | null,
  probe: { liveChannels: readonly string[]; telegram?: TelegramProbeFacts | null } | null,
  nowMs: number,
): string[] {
  if (!context) return [];
  return telegramWakeCoverage({
    configured: true,
    hostAllowed: context.hostAllowed,
    row: {
      enabled: context.row.enabled,
      tokenFp: context.row.token_fp,
      hasToken: Boolean(context.row.token_enc),
      blockedUntil: context.row.blocked_until,
    },
    probe,
    nowMs,
    ...(context.tag === undefined ? {} : { tag: context.tag }),
  });
}

/** Whether the bot has no webhook right now. Anything but a clear "none" is false, so the agent stays awake. */
export async function telegramWebhookIsClear(context: TelegramSleepContext, deps: TelegramWakeDeps = {}): Promise<boolean> {
  const token = decryptTelegramToken(context.row);
  if (!token) return false;
  const info = await telegramGetWebhook(token, { fetchImpl: deps.fetchImpl, timeoutMs: WEBHOOK_INFO_TIMEOUT_MS });
  return info.ok && info.result?.url === "";
}

/**
 * After a covered sleep: the sweep arms the bot once the nap is old enough.
 * The sleep checked just before that the bot had no webhook, so any row state
 * but an arm in flight is safe to move. An arm cannot be in flight for an agent
 * that was awake, except one that went stale, which the sweep takes back.
 */
export async function markTelegramPendingArm(agentId: string, deps: TelegramWakeDeps = {}): Promise<boolean> {
  const now = deps.now ?? Date.now;
  return updateTelegramWakeRow(agentId, ["idle", "pending_arm", "armed", "disarm_failed"], {
    state: "pending_arm",
    pending_since: new Date(now()).toISOString(),
    next_attempt_at: null,
  });
}

// ---------------------------------------------------------------------------
// Wake side
// ---------------------------------------------------------------------------

export interface TelegramDisarm {
  /** The row's state before this wake touched it. */
  previous: TelegramWakeState;
  /** Whether deleteWebhook was called. */
  called: boolean;
  ok: boolean;
  ms: number;
}

const WEBHOOK_STATES: readonly TelegramWakeState[] = ["arming", "armed", "disarm_failed"];

/**
 * Takes the webhook down for a wake. Called after admission and before the
 * host resumes the computer. Never throws, and a failure never stops the
 * wake: Hermes heals the conflict by itself, more slowly, and the sweep retries
 * the delete. Null when there is nothing to do (feature never configured, no
 * row, or the row is idle).
 */
export async function disarmTelegramForWake(agentId: string, deps: TelegramWakeDeps = {}): Promise<TelegramDisarm | null> {
  if (!telegramWakeCleanupEnabled(deps.env ?? process.env)) return null;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  try {
    const row = await tryReadTelegramWakeRow(agentId);
    if (!row || row.state === "idle") return null;
    const previous = row.state;
    // The mark the sweep looks for if this wake never finishes.
    const takenBack = new Date(startedAt).toISOString();
    if (previous === "pending_arm") {
      await updateTelegramWakeRow(agentId, ["pending_arm"], { state: "idle", pending_since: takenBack, next_attempt_at: null });
      return { previous, called: false, ok: true, ms: now() - startedAt };
    }
    const token = decryptTelegramToken(row);
    const deleted = token ? await deleteWakeWebhook(token, deps) : { ok: false, reason: "token_unreadable" };
    if (deleted.ok) {
      // An arm still in flight finds the row changed and takes its own webhook down again.
      await updateTelegramWakeRow(agentId, WEBHOOK_STATES, { state: "idle", pending_since: takenBack, next_attempt_at: null, last_error: null });
    } else {
      await updateTelegramWakeRow(agentId, WEBHOOK_STATES, { state: "disarm_failed", last_error: `disarm_${deleted.reason}`.slice(0, 40) });
      log.warn("telegram webhook not deleted before a wake; the sweep retries", {
        source: LOG_SOURCE,
        failureType: "telegram_disarm_failed",
        instanceId: agentId,
        reason: deleted.reason,
      });
    }
    return { previous, called: Boolean(token), ok: deleted.ok, ms: now() - startedAt };
  } catch {
    return null;
  }
}

/**
 * A wake that failed after the webhook came down: the computer may still be
 * asleep, so the row waits for the sweep to arm the bot again. A failed delete
 * stays as it is: its webhook may still be set, and the sweep deletes it
 * first, then arms again if the agent is still asleep.
 */
export async function rearmTelegramAfterFailedWake(
  agentId: string,
  disarm: TelegramDisarm | null,
  deps: TelegramWakeDeps = {},
): Promise<void> {
  if (!disarm) return;
  const now = deps.now ?? Date.now;
  await updateTelegramWakeRow(agentId, ["idle"], {
    state: "pending_arm",
    pending_since: new Date(now()).toISOString(),
    next_attempt_at: null,
  });
}

/** A wake that succeeded after taking the row back: the agent is awake, so the mark goes. */
export async function settleTelegramAfterWake(agentId: string, disarm: TelegramDisarm | null): Promise<void> {
  if (!disarm) return;
  await updateTelegramWakeRow(agentId, ["idle"], { pending_since: null });
}

/**
 * A deleted agent: take any wake webhook down and forget the token, best
 * effort. A webhook that cannot be deleted now is left to the sweep, which
 * sees the agent gone. Never throws.
 */
export async function releaseTelegramWakeOnDelete(agentId: string, deps: TelegramWakeDeps = {}): Promise<void> {
  if (!telegramWakeCleanupEnabled(deps.env ?? process.env)) return;
  try {
    const row = await tryReadTelegramWakeRow(agentId);
    if (!row) return;
    await updateTelegramWakeRow(agentId, [row.state], { enabled: false });
    if (WEBHOOK_STATES.includes(row.state)) {
      const token = decryptTelegramToken(row);
      const deleted = token ? await deleteWakeWebhook(token, deps) : { ok: false, reason: "token_unreadable" };
      if (!deleted.ok) {
        await updateTelegramWakeRow(agentId, [row.state], { state: "disarm_failed", last_error: "disarm_on_delete" });
        return;
      }
    }
    await updateTelegramWakeRow(agentId, [row.state], {
      state: "idle", token_enc: null, token_fp: null, bot_id: null, pending_since: null, next_attempt_at: null,
    });
  } catch {
    // The sweep takes it from here.
  }
}
