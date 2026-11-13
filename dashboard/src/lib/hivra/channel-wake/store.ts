import "server-only";

import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * Database side of channel wake: rows in hivra_agent_channel_wake
 * (20261113102000_hivra_wake_foundation.sql). Telegram keeps its own table
 * (telegram-wake/store.ts) and never has a row here.
 *
 * No credential is ever stored here, only a fingerprint. A read that fails is
 * reported as unknown (throws or empty), and every caller treats unknown as
 * "do not cover", which keeps the agent awake.
 */

const LOG_SOURCE = "channel-wake-store";
const TABLE = "hivra_agent_channel_wake";

export type ChannelWakeState = "idle" | "pending_arm" | "arming" | "armed" | "disarm_failed";

export interface ChannelWakeRow {
  agent_id: string;
  channel: string;
  enabled: boolean;
  cred_fp: string | null;
  state: ChannelWakeState;
  arm_id: string | null;
  arm_data: Record<string, unknown> | null;
  pending_since: string | null;
  next_attempt_at: string | null;
  arm_failures: number;
  blocked_until: string | null;
  deferred_wake_at: string | null;
  wake_count_window: unknown;
  last_error: string | null;
  updated_at?: string | null;
}

const COLUMNS =
  "agent_id, channel, enabled, cred_fp, state, arm_id, arm_data, pending_since, next_attempt_at, arm_failures, blocked_until, deferred_wake_at, wake_count_window, last_error, updated_at";

function db() {
  if (!supabaseAdmin) throw new Error("database_unavailable");
  return supabaseAdmin;
}

function warn(message: string, agentId: string, failureType: string) {
  log.warn(message, { source: LOG_SOURCE, instanceId: agentId, failureType });
}

/** Every row of one agent. Throws when the read fails. */
export async function readChannelWakeRows(agentId: string): Promise<ChannelWakeRow[]> {
  const { data, error } = await db().from(TABLE).select(COLUMNS).eq("agent_id", agentId);
  if (error) throw new Error("channel_wake_read_failed");
  return (data ?? []) as ChannelWakeRow[];
}

/**
 * The rows the sweep looks at, up to `limit`, oldest change first: anything
 * not idle, an idle row a wake took back (pending_since kept as the mark), and
 * a deferred wake that is due.
 */
export async function readChannelWakeWorkRows(limit: number, nowMs: number = Date.now()): Promise<ChannelWakeRow[]> {
  const now = new Date(nowMs).toISOString();
  const { data, error } = await db()
    .from(TABLE)
    .select(COLUMNS)
    .or([
      "state.neq.idle",
      "and(state.eq.idle,pending_since.not.is.null)",
      `deferred_wake_at.lte."${now}"`,
    ].join(","))
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error("channel_wake_read_failed");
  return (data ?? []) as ChannelWakeRow[];
}

/**
 * One compare-and-set on a row: applies the patch only while the state is one
 * of `from` (and, when given, the arm id matches). True when a row changed.
 */
export async function updateChannelWakeRow(
  agentId: string,
  channel: string,
  from: readonly ChannelWakeState[],
  patch: Partial<Omit<ChannelWakeRow, "agent_id" | "channel" | "updated_at">>,
  options: { armId?: string | null; deferredWakeAt?: string | null } = {},
): Promise<boolean> {
  try {
    let query = db()
      .from(TABLE)
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("agent_id", agentId)
      .eq("channel", channel)
      .in("state", [...from]);
    if (options.armId !== undefined) query = options.armId === null ? query.is("arm_id", null) : query.eq("arm_id", options.armId);
    if (options.deferredWakeAt !== undefined) {
      query = options.deferredWakeAt === null ? query.is("deferred_wake_at", null) : query.eq("deferred_wake_at", options.deferredWakeAt);
    }
    const { data, error } = await query.select("agent_id");
    if (error) throw new Error("database_error");
    return Array.isArray(data) && data.length > 0;
  } catch {
    warn("channel wake row not updated", agentId, "channel_wake_update_failed");
    return false;
  }
}

/** The sleep facts of some agents, by id. Throws when the read fails. */
export async function readChannelWakeAgentFacts(
  agentIds: readonly string[],
): Promise<Map<string, { status: string | null; sleep_state: string | null; operation_id: string | null }>> {
  const out = new Map<string, { status: string | null; sleep_state: string | null; operation_id: string | null }>();
  if (agentIds.length === 0) return out;
  const { data, error } = await db().from("hivra_agents").select("id, status, sleep_state, operation_id").in("id", [...agentIds]);
  if (error) throw new Error("channel_wake_agents_read_failed");
  for (const row of (data ?? []) as Array<{ id: string; status: string | null; sleep_state: string | null; operation_id: string | null }>) {
    out.set(row.id, { status: row.status ?? null, sleep_state: row.sleep_state ?? null, operation_id: row.operation_id ?? null });
  }
  return out;
}
