// Hivra agent resource gate — the single server-side authority for "does this
// CPU/RAM fit the user's plan + pool?". Shared by BOTH the launch path
// (POST /api/hivra/agents) and the resize path (POST /api/hivra/agents/[id]/action),
// so the per-agent cap and the shared compute pool can never drift between the
// two. The deploy form and the Manage resize selector mirror these same limits
// client-side, but this is the gate that actually decides.

import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { resolveEffectiveSubscription } from "@/lib/billing/instance-entitlement";
import { getPlan } from "@/lib/subscription";
import { BASE_FLOOR, BROWSER_ADD, isPoolExempt } from "@/lib/hivra/agent-catalog";
import { SLOT_FREEING_LIFECYCLE_IN_LIST } from "@/lib/instance-lifecycle";

export function isActiveComputeStatus(status: unknown): boolean {
  return status === "provisioning" || status === "running" || status === "stopped";
}

function formatGb(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export interface ComputeUsage {
  usedCpu: number;
  usedRamGb: number;
  activeCount: number;
}

// Sums the user's live compute across Hivra agents + legacy hermes_instances.
// `excludeHivraAgentId` drops one agent from the tally so a RESIZE measures the
// pool as "everything except the box being resized" (otherwise the box would be
// double-counted against its own new size).
export async function loadCurrentComputeUsage(
  userId: string,
  opts?: { excludeHivraAgentId?: string },
): Promise<ComputeUsage> {
  if (!supabaseAdmin) return { usedCpu: 0, usedRamGb: 0, activeCount: 0 };

  const [{ data: hivraAgents, error: hivraAgentsError }, { data: legacyInstances, error: legacyError }] =
    await Promise.all([
      supabaseAdmin
        .from("hivra_agents")
        .select("id, cpu, ram, status, type")
        .eq("user_id", userId)
        .eq("deployment_mode", "hivra-managed")
        .neq("status", "deleted"),
      supabaseAdmin
        .from("hermes_instances")
        .select("id, cpu_limit, ram_limit, status")
        .eq("user_id", userId)
        .not("status", "in", '("deleted")')
        // Exclude gone/cold-archived base instances: their VM is destroyed but
        // the row is routinely left at status='stopped', so a status-only filter
        // would count phantom compute against the user's pool and slot count and
        // wrongly deny a launch they're entitled to.
        .not("lifecycle_state", "in", SLOT_FREEING_LIFECYCLE_IN_LIST),
    ]);

  if (hivraAgentsError || legacyError) {
    log.error("hivra resource usage query failed", hivraAgentsError ?? legacyError ?? new Error("usage query failed"), {
      source: "hivra/resource-gate",
      failureType: "hivra_agent_usage_query_failed",
      userId,
      hivraError: hivraAgentsError ? String(hivraAgentsError.message ?? hivraAgentsError) : null,
      legacyError: legacyError ? String(legacyError.message ?? legacyError) : null,
      verboseErrors: true,
    });
    throw new Error("Could not verify remaining compute");
  }

  const excludeId = opts?.excludeHivraAgentId;
  const hivra = (Array.isArray(hivraAgents) ? hivraAgents : []).filter(
    (row) => isActiveComputeStatus((row as { status?: unknown }).status) && (row as { id?: unknown }).id !== excludeId,
  );
  const legacy = (Array.isArray(legacyInstances) ? legacyInstances : []).filter((row) =>
    isActiveComputeStatus((row as { status?: unknown }).status),
  );
  // Pool-exempt agents (e.g. Aeon) consume a slot but not the CPU/RAM pool, so
  // their reserved compute is excluded from the budget other agents draw from.
  const usedHivraCpu = hivra.reduce((sum, row) => sum + (isPoolExempt(String(row.type)) ? 0 : (Number(row.cpu) || 0)), 0);
  const usedHivraRamGb = hivra.reduce((sum, row) => sum + (isPoolExempt(String(row.type)) ? 0 : (Number(row.ram) || 0)), 0);
  const usedLegacyCpu = legacy.reduce((sum, row) => sum + (Number(row.cpu_limit) || 0), 0);
  const usedLegacyRamGb = legacy.reduce((sum, row) => sum + ((Number(row.ram_limit) || 0) / 1024), 0);

  return {
    usedCpu: usedHivraCpu + usedLegacyCpu,
    usedRamGb: usedHivraRamGb + usedLegacyRamGb,
    activeCount: hivra.length + legacy.length,
  };
}

export interface ValidateResourcesInput {
  userId: string;
  type: string;
  /** Requested vCPU (already half-step clamped by the caller). */
  cpu: number;
  /** Requested RAM in GB (already integer clamped by the caller). */
  ram: number;
  /** Hard ceilings. Missing values preserve the legacy pinned allocation. */
  maximumCpu?: number;
  maximumRam?: number;
  browser: boolean;
  /**
   * "launch" enforces the agent-slot count (you're adding a box); "resize" skips
   * the slot check (the box already exists) and excludes the box from pool usage.
   */
  mode: "launch" | "resize";
  /** Hivra agent id to exclude from pool usage (required for "resize"). */
  excludeAgentId?: string;
  /** Slot-only agents (Aeon): skip the pool + per-agent-cap checks. */
  poolExempt?: boolean;
  /** Per-agent launch/resize floor (CPU cores / GB). Defaults to BASE_FLOOR + browser surcharge. */
  floor?: { cpu: number; ram: number };
  /** Agent display name for user-facing denial messages (e.g. "Codex", "Aeon"). */
  agentLabel?: string;
}

export type ValidateResourcesResult = { ok: true } | { ok: false; status: number; message: string };

// The authoritative gate. Order mirrors the historical launch gate so launch
// behavior is byte-for-byte identical when mode === "launch": plan access →
// browser-on-free → slot count → floor → pool budget → per-agent cap.
export async function validateAgentResources(params: ValidateResourcesInput): Promise<ValidateResourcesResult> {
  const agentLabel = params.agentLabel || "this agent";
  const sub = await resolveEffectiveSubscription(params.userId);
  if (!sub) {
    return { ok: false, status: 403, message: `Plan access is required before launching ${agentLabel}.` };
  }

  const plan = getPlan(sub.plan);
  const isFreePlan = sub.plan === "free" || sub.source === "free";
  const usage = await loadCurrentComputeUsage(
    params.userId,
    params.mode === "resize" ? { excludeHivraAgentId: params.excludeAgentId } : undefined,
  );
  const totalCpu = Number(sub.total_cpu_budget) || plan.totalCpu;
  const totalRamGb = (Number(sub.total_ram_budget) || plan.totalRam) / 1024;
  const remainingCpu = Math.max(0, totalCpu - usage.usedCpu);
  const remainingRamGb = Math.max(0, totalRamGb - usage.usedRamGb);
  const maxAgents = Number(sub.instance_limit) || plan.maxAgents;
  const maxCpuPerAgent = plan.maxCpuPerAgent;
  const maxRamPerAgentGb = plan.maxRamPerAgent / 1024;
  const maximumCpu = params.maximumCpu ?? params.cpu;
  const maximumRam = params.maximumRam ?? params.ram;
  const floorCpu = params.floor?.cpu ?? (BASE_FLOOR.cpu + (params.browser ? BROWSER_ADD.cpu : 0));
  const floorRam = params.floor?.ram ?? (BASE_FLOOR.ram + (params.browser ? BROWSER_ADD.ram : 0));

  const denialDetail = {
    source: "hivra/resource-gate",
    failureType: "hivra_agent_resource_gate_denied",
    userId: params.userId,
    mode: params.mode,
    agentType: params.type,
    requestedCpu: params.cpu,
    requestedRam: params.ram,
    browser: params.browser,
    plan: sub.plan,
    planSource: sub.source,
    usedCpu: usage.usedCpu,
    usedRamGb: usage.usedRamGb,
    remainingCpu,
    remainingRamGb,
    totalCpu,
    totalRamGb,
    activeCount: usage.activeCount,
    maxAgents,
  };

  if (params.browser && isFreePlan) {
    log.warn("hivra resource gate: browser automation is not available on Free", denialDetail);
    return { ok: false, status: 403, message: "Browser automation requires a paid plan." };
  }

  if (params.mode === "launch" && usage.activeCount >= maxAgents) {
    log.warn("hivra resource gate: agent slot limit reached", denialDetail);
    return { ok: false, status: 403, message: `Your ${plan.name} plan allows ${maxAgents} active agent${maxAgents === 1 ? "" : "s"}.` };
  }

  if (params.cpu < floorCpu || params.ram < floorRam) {
    log.warn("hivra resource gate: request is below required floor", denialDetail);
    return { ok: false, status: 403, message: `${agentLabel} needs at least ${formatGb(floorCpu)} CPU / ${formatGb(floorRam)} GB.` };
  }

  // Exemption is for a fixed small dashboard, not unlimited unmetered compute.
  // Enforce here for every caller, including resize (launch already pins size).
  if (params.poolExempt && (params.cpu !== floorCpu || params.ram !== floorRam)) {
    return { ok: false, status: 403, message: `${agentLabel} uses a fixed managed size of ${formatGb(floorCpu)} CPU / ${formatGb(floorRam)} GB.` };
  }

  // Pool-exempt agents (Aeon) host on near-zero, fixed compute and never draw
  // from the shared pool, so the remaining-pool and per-agent-cap gates don't
  // apply — only plan access, browser-on-free, and the slot limit do.
  if (!params.poolExempt) {
    if (params.cpu > remainingCpu || params.ram > remainingRamGb) {
      log.warn("hivra resource gate: request exceeds remaining pool", denialDetail);
      return {
        ok: false,
        status: 403,
        message: `Your ${plan.name} pool only has ${formatGb(remainingCpu)} CPU / ${formatGb(remainingRamGb)} GB free.`,
      };
    }

    if (maximumCpu < params.cpu || maximumRam < params.ram) {
      return { ok: false, status: 400, message: "A computer's maximum cannot be lower than its guaranteed allocation." };
    }

    if (maximumCpu > maxCpuPerAgent || maximumRam > maxRamPerAgentGb) {
      log.warn("hivra resource gate: request exceeds per-agent cap", denialDetail);
      return { ok: false, status: 403, message: `Your ${plan.name} plan allows up to ${formatGb(maxCpuPerAgent)} CPU / ${formatGb(maxRamPerAgentGb)} GB per agent.` };
    }
  }

  return { ok: true };
}
