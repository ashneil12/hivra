import "server-only";

import { log } from "@/lib/logger";
import { encryptSecret } from "@/lib/crypto";
import { supabaseAdmin } from "@/lib/supabase";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { buildTelegramTokenReadHostScript, parseTelegramTokenRead } from "../agent-sleep-scripts";
import { isAgentAwake } from "../agent-sleep-store";
import { readSleepHostRow } from "../agent-sleep";
import { resolveSleepTarget, type AgentRow } from "../agent-wake";
import { resolveTelegramWakeConfig, telegramWakeHostAllowed } from "./config";
import { telegramGetBot, telegramTokenFingerprint, type TelegramFetch } from "./bot-api";
import { decryptTelegramToken, deleteWakeWebhook } from "./lifecycle";
import { readTelegramWakeRow, saveTelegramWakeOptIn, updateTelegramWakeRow, type TelegramWakeState } from "./store";

/**
 * The owner's switch for Telegram wake-on-message on one agent.
 *
 * Turning it on reads TELEGRAM_BOT_TOKEN from ~/.hermes/.env once, through the
 * guest agent of the agent's own computer, checks it with getMe and keeps it
 * encrypted. The token never leaves this file except encrypted, and is never
 * logged or returned. Turning it off takes any webhook down first and only
 * then forgets the token; if Telegram cannot be reached the token stays until
 * the sweep has taken the webhook down.
 */

const LOG_SOURCE = "telegram-wake-owner";
const TOKEN_READ_TIMEOUT_MS = 45_000;

/** Agent kinds phase 1 covers. */
const COVERED_KINDS: readonly string[] = ["hermes"];

export interface TelegramWakeView {
  /** The switch can be shown for this agent. */
  available: boolean;
  enabled: boolean;
  /** Armed right now: a message wakes the agent. */
  armed: boolean;
}

export type TelegramWakeChange =
  | { ok: true; view: TelegramWakeView; wake: boolean }
  | { ok: false; status: number; code: string; message: string };

export interface OwnerDeps {
  env?: Record<string, string | undefined>;
  fetchImpl?: TelegramFetch;
}

/** Whether the owner connected a Telegram bot to this agent through the dashboard. A failed read is no. */
async function hasTelegramConnection(agentId: string, userId: string): Promise<boolean> {
  if (!supabaseAdmin) return false;
  try {
    const { data, error } = await supabaseAdmin
      .from("channel_connections")
      .select("target_id")
      .eq("user_id", userId)
      .eq("channel", "telegram")
      .eq("target_id", agentId)
      .limit(1);
    return !error && Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

/** Whether the switch applies to this agent at all: the server switch, its host, its kind, and a Telegram bot. */
async function availability(agent: AgentRow, userId: string, env: Record<string, string | undefined>): Promise<boolean> {
  const config = resolveTelegramWakeConfig(env);
  if (!config) return false;
  if (!COVERED_KINDS.includes(String(agent.type ?? ""))) return false;
  if (agent.deployment_mode !== "hivra-managed" || agent.computer_substrate !== "proxmox-kvm") return false;
  if (config.mode === "canary") {
    const host = await readSleepHostRow(agent);
    if (!host || !telegramWakeHostAllowed(config, host.sleep_mode)) return false;
  }
  return hasTelegramConnection(String(agent.id), userId);
}

function viewOf(available: boolean, row: { enabled: boolean; state: TelegramWakeState } | null): TelegramWakeView {
  return { available, enabled: row?.enabled === true, armed: row?.state === "armed" };
}

export async function readTelegramWakeView(agent: AgentRow, userId: string, deps: OwnerDeps = {}): Promise<TelegramWakeView> {
  const env = deps.env ?? process.env;
  const available = await availability(agent, userId, env);
  if (!available) return viewOf(false, null);
  const row = await readTelegramWakeRow(String(agent.id)).catch(() => null);
  return viewOf(true, row);
}

const refuse = (status: number, code: string, message: string): TelegramWakeChange => ({ ok: false, status, code, message });

const TOKEN_READ_MESSAGES: Record<string, string> = {
  no_env: "Your agent has no Telegram bot set up yet. Connect Telegram first.",
  no_token: "Your agent has no Telegram bot set up yet. Connect Telegram first.",
  webhook_mode: "Your agent's Telegram bot already uses its own webhook, so it does not need this.",
  bad_shape: "Your agent's Telegram bot token does not look right. Connect Telegram again.",
};

/** Reads the token from the agent's own computer. The token comes back only inside the result. */
async function readTokenFromComputer(agent: AgentRow): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
  try {
    const resolved = await resolveSleepTarget(agent, LOG_SOURCE);
    if (!resolved.ok) return { ok: false, reason: `target_${resolved.code}` };
    const run = await runProxmoxHostScript(
      buildTelegramTokenReadHostScript({ vmid: resolved.target.vmid, bindingTag: resolved.target.bindingTag }),
      resolved.target.env,
      { timeoutMs: TOKEN_READ_TIMEOUT_MS },
    );
    return parseTelegramTokenRead(run?.stdout ?? "");
  } catch {
    return { ok: false, reason: "read_failed" };
  }
}

const WEBHOOK_STATES: readonly TelegramWakeState[] = ["arming", "armed", "disarm_failed"];

export async function enableTelegramWake(agent: AgentRow, userId: string, deps: OwnerDeps = {}): Promise<TelegramWakeChange> {
  const env = deps.env ?? process.env;
  if (!(await availability(agent, userId, env))) {
    return refuse(409, "not_available", "Waking on Telegram messages is not available for this agent.");
  }
  if (agent.status !== "running" || !isAgentAwake(agent)) {
    return refuse(409, "not_awake", "Your agent needs to be awake to turn this on. Open it and try again.");
  }
  // A webhook that may still be set is taken down by the sweep with the token it
  // was set with. Saving now would replace that token and leave the webhook behind.
  const current = await readTelegramWakeRow(String(agent.id)).catch(() => null);
  if (current && WEBHOOK_STATES.includes(current.state)) {
    return refuse(409, "settling", "This setting is still settling. Try again in a minute.");
  }
  const read = await readTokenFromComputer(agent);
  if (!read.ok) {
    log.warn("telegram wake opt-in could not read the bot token", {
      source: LOG_SOURCE,
      failureType: "telegram_wake_token_read_failed",
      instanceId: String(agent.id),
      reason: read.reason,
    });
    return refuse(409, read.reason.slice(0, 40), TOKEN_READ_MESSAGES[read.reason] ?? "Could not read your agent's Telegram setup. Try again in a moment.");
  }
  const bot = await telegramGetBot(read.token, { fetchImpl: deps.fetchImpl });
  if (!bot.ok || !bot.result) {
    if (bot.reason === "unauthorized") return refuse(409, "token_rejected", "Telegram did not accept your agent's bot token. Connect Telegram again.");
    return refuse(503, "telegram_unreachable", "Could not reach Telegram. Try again in a moment.");
  }
  let tokenEnc: string;
  try {
    tokenEnc = encryptSecret(read.token);
  } catch {
    return refuse(503, "not_saved", "Could not save this setting.");
  }
  const saved = await saveTelegramWakeOptIn({
    agentId: String(agent.id),
    userId,
    tokenEnc,
    tokenFp: telegramTokenFingerprint(read.token),
    botId: bot.result.id,
  });
  if (!saved) return refuse(503, "not_saved", "Could not save this setting.");
  return { ok: true, view: { available: true, enabled: true, armed: false }, wake: false };
}

/**
 * Turns it off: any webhook comes down first, then the token is forgotten. An
 * agent that was asleep with its bot armed is woken by the caller, or it would
 * stay deaf.
 */
export async function disableTelegramWake(agent: AgentRow, deps: OwnerDeps = {}): Promise<TelegramWakeChange> {
  const agentId = String(agent.id);
  let row;
  try {
    row = await readTelegramWakeRow(agentId);
  } catch {
    return refuse(503, "not_saved", "Could not save this setting.");
  }
  const available = await availability(agent, String(agent.user_id), deps.env ?? process.env).catch(() => false);
  if (!row || (!row.enabled && !row.token_enc)) return { ok: true, view: viewOf(available, null), wake: false };

  const hadWebhook = row.state === "arming" || row.state === "armed" || row.state === "disarm_failed";
  const wasWaiting = hadWebhook || row.state === "pending_arm";
  // Stop new arms first, so nothing sets a webhook while this one comes down.
  if (!(await updateTelegramWakeRow(agentId, [row.state], { enabled: false }))) {
    return refuse(409, "changed", "This setting just changed. Try again.");
  }
  if (hadWebhook) {
    const token = decryptTelegramToken(row);
    const deleted = token ? await deleteWakeWebhook(token, { fetchImpl: deps.fetchImpl }) : { ok: false, reason: "token_unreadable" };
    if (!deleted.ok) {
      // The token stays so the sweep can still take the webhook down; it is forgotten after.
      await updateTelegramWakeRow(agentId, [row.state], { state: "disarm_failed", last_error: "disarm_on_opt_out" });
      return { ok: true, view: viewOf(available, { enabled: false, state: "disarm_failed" }), wake: wasWaiting };
    }
  }
  await updateTelegramWakeRow(agentId, ["idle", "pending_arm", "arming", "armed", "disarm_failed"], {
    state: "idle",
    token_enc: null,
    token_fp: null,
    bot_id: null,
    arm_id: null,
    pending_since: null,
    next_attempt_at: null,
    last_error: null,
  });
  return { ok: true, view: viewOf(available, { enabled: false, state: "idle" }), wake: wasWaiting };
}
