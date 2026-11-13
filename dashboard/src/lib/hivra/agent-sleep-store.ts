import "server-only";

import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * Database side of agent sleep and wake: the four lease functions from
 * 20261113060000_hivra_agent_sleep_wake.sql, the event log, and the awake test.
 *
 * Fail toward awake. A claim that cannot be answered (the database is down, or
 * it answers something unexpected) is reported as refused, so nothing sleeps on
 * a doubt. A finish that cannot be recorded returns false and logs; the lease
 * stays and the sweep settles it from the observed host state. None of these
 * calls touches hivra_agents.status.
 */

const LOG_SOURCE = "agent-sleep-store";

export type AgentSleepState =
  | "awake"
  | "draining"
  | "napping"
  | "hibernating"
  | "hibernated"
  | "waking"
  | "wake_failed";

export type AgentSleepTier = "nap" | "hibernate";
export type AgentSleepFinishResult = "napping" | "hibernated" | "awake";
export type AgentWakeClaim = "claimed" | "awake" | "busy" | "refused";
export type AgentWakeFinishResult = "awake" | "wake_failed";

export type AgentSleepEventKind = "nap" | "hibernate" | "wake" | "abort" | "fail" | "reconcile";
export type AgentSleepEventTrigger = "sweep" | "manual" | "open" | "action" | "schedule" | "reconcile" | "telegram";

export interface AgentSleepEvent {
  agentId: string;
  kind: AgentSleepEventKind;
  trigger: AgentSleepEventTrigger;
  fromState?: string | null;
  toState?: string | null;
  generation?: number | null;
  durationMs?: number | null;
  reason?: string | null;
  /** Counts and timings only. Never secrets or content. */
  detail?: Record<string, number | string | boolean | null> | null;
}

const WAKE_CLAIMS: readonly string[] = ["claimed", "awake", "busy", "refused"];

/**
 * True when the agent is awake and its computer can be reached. A row that does
 * not carry the column at all (read before the column existed, or selected
 * without it) counts as awake, because every agent was awake before sleep
 * existed. Any other value, including one this code does not know, is not awake.
 */
export function isAgentAwake(row: { sleep_state?: unknown } | null | undefined): boolean {
  if (!row) return false;
  return row.sleep_state == null || row.sleep_state === "awake";
}

/** Sleep generations are bigint; the API may hand one back as a number or a string. */
export function parseSleepGeneration(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value === "string" && /^\d{1,15}$/.test(value)) return Number(value);
  return null;
}

async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!supabaseAdmin) throw new Error("database_unavailable");
  const response = await supabaseAdmin.rpc(name, args);
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("database_error");
  }
  if (response.error) throw new Error("database_error");
  return response.data;
}

function warn(message: string, agentId: string, failureType: string) {
  log.warn(message, { source: LOG_SOURCE, instanceId: agentId, failureType });
}

/** The new sleep generation, or null when the claim was refused or could not be made. */
export async function claimAgentSleep(input: {
  agentId: string;
  operationId: string;
  tier: AgentSleepTier;
  expectedGeneration: number;
}): Promise<number | null> {
  try {
    const data = await rpc("claim_hivra_agent_sleep", {
      p_agent_id: input.agentId,
      p_operation_id: input.operationId,
      p_tier: input.tier,
      p_expected_generation: input.expectedGeneration,
    });
    return parseSleepGeneration(data);
  } catch {
    warn("sleep claim failed", input.agentId, "sleep_claim_failed");
    return null;
  }
}

export async function finishAgentSleep(input: {
  agentId: string;
  operationId: string;
  result: AgentSleepFinishResult;
}): Promise<boolean> {
  try {
    const data = await rpc("finish_hivra_agent_sleep", {
      p_agent_id: input.agentId,
      p_operation_id: input.operationId,
      p_result: input.result,
    });
    return data === true;
  } catch {
    warn("sleep finish failed", input.agentId, "sleep_finish_failed");
    return false;
  }
}

export async function claimAgentWake(input: {
  agentId: string;
  operationId: string;
}): Promise<AgentWakeClaim> {
  try {
    const data = await rpc("claim_hivra_agent_wake", {
      p_agent_id: input.agentId,
      p_operation_id: input.operationId,
    });
    if (typeof data === "string" && WAKE_CLAIMS.includes(data)) return data as AgentWakeClaim;
    return "refused";
  } catch {
    warn("wake claim failed", input.agentId, "wake_claim_failed");
    return "refused";
  }
}

export async function finishAgentWake(input: {
  agentId: string;
  operationId: string;
  result: AgentWakeFinishResult;
}): Promise<boolean> {
  try {
    const data = await rpc("finish_hivra_agent_wake", {
      p_agent_id: input.agentId,
      p_operation_id: input.operationId,
      p_result: input.result,
    });
    return data === true;
  } catch {
    warn("wake finish failed", input.agentId, "wake_finish_failed");
    return false;
  }
}

export type AgentSleepReconcileTarget = "awake" | "napping" | "hibernated" | "wake_failed";

/**
 * Records what the host shows for an agent that holds no sleep or wake lease:
 * one UPDATE that applies only while the agent is still as the caller read it
 * (same generation, no operation, running and not being deleted). It bumps the
 * generation, so a sleep or wake that started meanwhile wins. Returns true when
 * the row changed. Never touches status.
 */
export async function reconcileAgentSleepState(input: {
  agentId: string;
  expectedGeneration: number;
  to: AgentSleepReconcileTarget;
}): Promise<boolean> {
  if (!supabaseAdmin) return false;
  if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0) return false;
  try {
    const patch: Record<string, unknown> = {
      sleep_state: input.to,
      sleep_generation: input.expectedGeneration + 1,
      sleep_tier_changed_at: new Date().toISOString(),
    };
    if (input.to === "awake") patch.next_wake_at = null;
    const { data, error } = await supabaseAdmin
      .from("hivra_agents")
      .update(patch)
      .eq("id", input.agentId)
      .eq("sleep_generation", input.expectedGeneration)
      .eq("status", "running")
      .eq("desired_state", "running")
      .is("operation_id", null)
      .select("id");
    if (error) throw new Error("database_error");
    return Array.isArray(data) && data.length > 0;
  } catch {
    warn("sleep record could not be reconciled", input.agentId, "sleep_reconcile_failed");
    return false;
  }
}

function safeInteger(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(2_147_483_647, Math.round(value)));
}

/** Writes one row to hivra_agent_sleep_events. Never throws: a lost log line must not undo a sleep or a wake. */
export async function logAgentSleepEvent(event: AgentSleepEvent): Promise<boolean> {
  if (!supabaseAdmin) return false;
  try {
    const { error } = await supabaseAdmin.from("hivra_agent_sleep_events").insert({
      agent_id: event.agentId,
      kind: event.kind,
      trigger: event.trigger,
      from_state: event.fromState ?? null,
      to_state: event.toState ?? null,
      generation: parseSleepGeneration(event.generation ?? null),
      duration_ms: safeInteger(event.durationMs),
      reason: event.reason ? event.reason.slice(0, 200) : null,
      detail: event.detail ?? null,
    });
    if (error) {
      warn("sleep event not recorded", event.agentId, "sleep_event_insert_failed");
      return false;
    }
    return true;
  } catch {
    warn("sleep event not recorded", event.agentId, "sleep_event_insert_failed");
    return false;
  }
}
