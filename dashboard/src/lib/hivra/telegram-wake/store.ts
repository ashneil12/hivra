import "server-only";

import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * Database side of Telegram wake-on-message: the per-agent row in
 * hivra_agent_telegram_wake and the arm lease from
 * 20261113100000_hivra_agent_telegram_wake.sql.
 *
 * The token column is only ever read here and handed on encrypted; nothing in
 * this file logs a row. A read that fails is reported as unknown (throws or
 * null), never as "not opted in" being certain, and every caller treats
 * unknown as "do not cover", which keeps the agent awake.
 */

const LOG_SOURCE = "telegram-wake-store";
const TABLE = "hivra_agent_telegram_wake";

export type TelegramWakeState = "idle" | "pending_arm" | "arming" | "armed" | "disarm_failed";

export interface TelegramWakeRow {
  agent_id: string;
  user_id: string;
  enabled: boolean;
  token_enc: string | null;
  token_fp: string | null;
  bot_id: number | null;
  state: TelegramWakeState;
  arm_id: string | null;
  arm_started_at: string | null;
  pending_since: string | null;
  next_attempt_at: string | null;
  arm_failures: number;
  blocked_until: string | null;
  last_error: string | null;
}

const COLUMNS =
  "agent_id, user_id, enabled, token_enc, token_fp, bot_id, state, arm_id, arm_started_at, pending_since, next_attempt_at, arm_failures, blocked_until, last_error";

function db() {
  if (!supabaseAdmin) throw new Error("database_unavailable");
  return supabaseAdmin;
}

function warn(message: string, agentId: string, failureType: string) {
  log.warn(message, { source: LOG_SOURCE, instanceId: agentId, failureType });
}

/** The row, or null when there is none. Throws when the read itself fails. */
export async function readTelegramWakeRow(agentId: string): Promise<TelegramWakeRow | null> {
  const { data, error } = await db().from(TABLE).select(COLUMNS).eq("agent_id", agentId).maybeSingle();
  if (error) throw new Error("telegram_wake_read_failed");
  return (data as TelegramWakeRow | null) ?? null;
}

/** The row, or null when there is none or it cannot be read. */
export async function tryReadTelegramWakeRow(agentId: string): Promise<TelegramWakeRow | null> {
  try {
    return await readTelegramWakeRow(agentId);
  } catch {
    warn("telegram wake row could not be read", agentId, "telegram_wake_read_failed");
    return null;
  }
}

/** Rows that are not idle, or that still hold a token after the owner opted out. For the sweep. */
export async function readTelegramWakeWorkRows(limit: number): Promise<TelegramWakeRow[]> {
  const { data, error } = await db()
    .from(TABLE)
    .select(COLUMNS)
    .or("state.neq.idle,and(enabled.eq.false,token_enc.not.is.null)")
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error("telegram_wake_read_failed");
  return (data ?? []) as TelegramWakeRow[];
}

/** Opt in (or refresh the token): enabled, idle, with no block or failures. */
export async function saveTelegramWakeOptIn(input: {
  agentId: string;
  userId: string;
  tokenEnc: string;
  tokenFp: string;
  botId: number;
}): Promise<boolean> {
  try {
    const { error } = await db().from(TABLE).upsert({
      agent_id: input.agentId,
      user_id: input.userId,
      enabled: true,
      token_enc: input.tokenEnc,
      token_fp: input.tokenFp,
      bot_id: input.botId,
      state: "idle",
      arm_id: null,
      arm_started_at: null,
      pending_since: null,
      next_attempt_at: null,
      arm_failures: 0,
      blocked_until: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "agent_id" });
    if (error) throw new Error("database_error");
    return true;
  } catch {
    warn("telegram wake opt-in not saved", input.agentId, "telegram_wake_opt_in_failed");
    return false;
  }
}

/**
 * One compare-and-set on the row: applies the patch only while the state is
 * one of `from` (and, when given, the arm id matches). True when a row changed.
 */
export async function updateTelegramWakeRow(
  agentId: string,
  from: readonly TelegramWakeState[],
  patch: Partial<Omit<TelegramWakeRow, "agent_id" | "user_id">>,
  options: { armId?: string | null } = {},
): Promise<boolean> {
  try {
    let query = db()
      .from(TABLE)
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("agent_id", agentId)
      .in("state", [...from]);
    if (options.armId !== undefined) query = options.armId === null ? query.is("arm_id", null) : query.eq("arm_id", options.armId);
    const { data, error } = await query.select("agent_id");
    if (error) throw new Error("database_error");
    return Array.isArray(data) && data.length > 0;
  } catch {
    warn("telegram wake row not updated", agentId, "telegram_wake_update_failed");
    return false;
  }
}

/** Takes a row for arming. The failure count so far, or null when refused or unanswerable. */
export async function claimTelegramArm(agentId: string, armId: string, minPendingS: number): Promise<number | null> {
  try {
    const { data, error } = await db().rpc("claim_hivra_agent_tg_arm", {
      p_agent_id: agentId,
      p_arm_id: armId,
      p_min_pending_s: minPendingS,
    });
    if (error) throw new Error("database_error");
    return typeof data === "number" && Number.isSafeInteger(data) && data >= 0 ? data : null;
  } catch {
    warn("telegram arm claim failed", agentId, "telegram_arm_claim_failed");
    return null;
  }
}

export type TelegramArmResult = "armed" | "pending_arm" | "blocked";

/** Releases an arm lease. False when this arm no longer holds the row. */
export async function finishTelegramArm(input: {
  agentId: string;
  armId: string;
  result: TelegramArmResult;
  failed?: boolean;
  retryAt?: string | null;
  error?: string | null;
}): Promise<boolean> {
  try {
    const { data, error } = await db().rpc("finish_hivra_agent_tg_arm", {
      p_agent_id: input.agentId,
      p_arm_id: input.armId,
      p_result: input.result,
      p_failed: input.failed === true,
      p_retry_at: input.retryAt ?? null,
      p_error: input.error ?? null,
    });
    if (error) throw new Error("database_error");
    return data === true;
  } catch {
    warn("telegram arm finish failed", input.agentId, "telegram_arm_finish_failed");
    return false;
  }
}
