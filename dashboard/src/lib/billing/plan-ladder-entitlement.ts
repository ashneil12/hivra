/**
 * What a plan bought on the plan ladder allows, read from the owner's
 * subscription row. Only consulted where the ladder is configured, so
 * deployments without the ladder never read its columns.
 */

import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { hasPlanAccessStatus } from "@/lib/billing/subscription-status";
import {
  PLAN_LADDER_ID,
  asLadderPlanKey,
  ladderPlanLimits,
  readPlanLadderConfig,
} from "@/lib/subscription/plan-ladder";

export interface LadderEntitlement {
  planKey: string;
  name: string;
  maxCpuPerAgent: number;
  maxRamPerAgentMb: number;
  /** Agents the owner may keep awake. */
  alwaysOnLimit: number;
}

/**
 * The owner's ladder entitlement, or null when the ladder is not configured
 * here, the owner's plan is from before the ladder, or the plan has ended.
 */
export async function loadLadderEntitlement(userId: string): Promise<LadderEntitlement | null> {
  const config = readPlanLadderConfig();
  if (!config || !supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin
    .from("hermes_subscriptions")
    .select("plan, status, plan_ladder, always_on_limit")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    log.warn("plan ladder entitlement read failed", {
      source: "plan-ladder-entitlement",
      failureType: "plan_ladder_entitlement_read_failed",
      userId,
      errorMessage: error.message,
    });
    return null;
  }
  const row = data as { plan?: string; status?: string; plan_ladder?: string | null; always_on_limit?: number | null } | null;
  if (!row || row.plan_ladder !== PLAN_LADDER_ID || !hasPlanAccessStatus(row.status)) return null;
  const planKey = asLadderPlanKey(String(row.plan));
  if (!planKey) return null;
  const limits = ladderPlanLimits(config, planKey);
  const stored = Number(row.always_on_limit);
  return {
    planKey,
    name: limits.name,
    maxCpuPerAgent: limits.maxCpuPerAgent,
    maxRamPerAgentMb: limits.maxRamPerAgent,
    alwaysOnLimit: Number.isInteger(stored) && stored >= 0 ? stored : limits.alwaysOn,
  };
}

/** How many of the owner's agents are kept awake right now. */
export async function countAlwaysOnAgents(userId: string, excludeAgentId?: string): Promise<number> {
  if (!supabaseAdmin) return 0;
  let query = supabaseAdmin
    .from("hivra_agents")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("always_on", true)
    .neq("status", "deleted");
  if (excludeAgentId) query = query.neq("id", excludeAgentId);
  const { count, error } = await query;
  if (error) throw new Error(error.message || "Could not count always-on agents");
  return count ?? 0;
}

export function alwaysOnLimitMessage(planName: string, limit: number): string {
  if (limit <= 0) {
    return `Agents on ${planName} sleep when idle and wake when you need them. Keeping one awake needs a bigger plan or the always-on extra.`;
  }
  return `Your ${planName} plan keeps ${limit} agent${limit === 1 ? "" : "s"} awake. Turn Keep awake off on another agent, or add the always-on extra.`;
}

/**
 * The owner's `plan_ladder` tag, read on its own so callers with a typed
 * column list do not depend on the column where the ladder is not set up.
 * Null when the ladder is not configured here or the row has no tag.
 */
export async function loadPlanLadderTag(userId: string): Promise<string | null> {
  if (!readPlanLadderConfig() || !supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin
    .from("hermes_subscriptions")
    .select("plan_ladder")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return null;
  const tag = (data as { plan_ladder?: unknown }).plan_ladder;
  return typeof tag === "string" ? tag : null;
}
