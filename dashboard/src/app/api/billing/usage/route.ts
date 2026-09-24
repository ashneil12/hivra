import { auth } from "@clerk/nextjs/server";
import { apiSuccess, apiError } from "@/lib/api-response";
import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { getPlan } from "@/lib/subscription";
import {
  CREDIT_UNIT_LABEL,
  getCreditSummary,
  getPlanMonthlyCreditGrant,
} from "@/lib/billing/credits";
import { isBillingV2ServerEnabled } from "@/lib/billing/billing-v2-availability";
import { resolveEffectiveSubscription } from "@/lib/billing/instance-entitlement";
import { isPaidTier, VENICE_BOOST_CPU, VENICE_BOOST_RAM_MB } from "@/lib/services/tier-boost";
import { isVeniceBoostEligible } from "@/lib/billing/venice-compute-boost";
import { isActiveComputeStatus } from "@/lib/hivra/resource-gate";
import { SLOT_FREEING_LIFECYCLE_IN_LIST } from "@/lib/instance-lifecycle";

import { calculateUsage, resolveBackupAddon } from "./helpers";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function usageSuccess<T>(data: T) {
  const response = apiSuccess(data);
  response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
  return response;
}

/**
 * GET /api/billing/usage
 *
 * Returns the user's current plan info and resource usage so the frontend
 * can display budget bars, agent counts, upgrade CTAs, and backup addon
 * status. Treats both Stripe subscribers and $HERMESOS-held tier qualifiers
 * as `subscribed: true`; consumers can branch on `plan.source` when copy
 * needs to differ ("Renews on …" vs "Eligible while holding …").
 */
export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    // Effective subscription accepts either Stripe or token-holding
    // entitlement. instance-service uses the same resolver so the budget
    // bars displayed here match exactly what the provisioning gate
    // enforces.
    const sub = await resolveEffectiveSubscription(userId);

    const credits = isBillingV2ServerEnabled()
      ? await getCreditSummary(userId, sub?.plan ?? null)
      : {
          balance: 0,
          monthlyGrant: getPlanMonthlyCreditGrant(sub?.plan ?? null),
          unit: CREDIT_UNIT_LABEL,
        };

    if (!sub) {
      return usageSuccess({
        subscribed: false,
        plan: null,
        usage: null,
        credits,
      });
    }

    const plan = getPlan(sub.plan);

    // Venice compute boost is "active" when the user holds ≥ $199 of VVV AND
    // is on a paid tier (the boost only stacks on paid). Best-effort: a
    // boost-table read hiccup degrades to "no boost", never fails the page.
    let veniceBoostActive = false;
    if (isPaidTier(sub.plan)) {
      try {
        veniceBoostActive = await isVeniceBoostEligible(userId);
      } catch (boostErr) {
        // Degrade to "no boost" so the page never fails, but emit a breadcrumb:
        // a silent false here means an eligible user sees no boost and operators
        // get no signal that the boost-eligibility read is failing.
        veniceBoostActive = false;
        log.warn("venice boost eligibility check failed; degrading to no-boost", {
          source: "billing-usage",
          route: "/api/billing/usage",
          method: "GET",
          userId,
          failureType: "venice_boost_eligibility_check_failed",
        }, boostErr);
      }
    }

    const { data: instances, error: instancesError } = await supabaseAdmin
      .from("hermes_instances")
      .select(
        "id, name, status, cpu_limit, ram_limit, disk_size_gb, disk_upgraded, backups_enabled, hetzner_server_id, proxmox_node, proxmox_vmid, resource_tier"
      )
      .eq("user_id", userId)
      .not("status", "in", '("deleted")')
      // Exclude gone/cold-archived instances: they're routinely left at
      // status='stopped', so a status-only filter would inflate the agent count
      // and CPU/RAM meters shown here — telling a user they're maxed out when a
      // slot is actually free. Mirrors the provisioning gate's exclusion.
      .not("lifecycle_state", "in", SLOT_FREEING_LIFECYCLE_IN_LIST);
    if (instancesError) {
      log.warn("billing usage could not verify Hermes capacity", {
        source: "billing.usage", route: "/api/billing/usage", userId,
        failureType: "billing_usage_hermes_instances_query_failed",
      });
      const response = apiError("Current compute usage is unavailable. Refresh before choosing a size.", 503);
      response.headers.set("Cache-Control", "no-store");
      return response;
    }

    // Only rows the launch gate counts (provisioning|running|stopped) may feed
    // the budget meters — same predicate as resource-gate so the bars shown
    // here can never drift from what provisioning actually enforces. Terminal
    // `error` rows (failed provisions nothing sweeps) hold no compute, and the
    // agents list already hides them; counting them here showed users maxed-out
    // meters for boxes that don't exist. They're dropped from the instances
    // list too: it drives the backup-addon panel, which must not offer backups
    // on a dead row.
    const activeInstances = (instances || []).filter((i) => isActiveComputeStatus(i.status));
    const { data: hivraAgents, error: hivraAgentsError } = await supabaseAdmin
      .from("hivra_agents")
      .select("id, name, status, cpu, ram, type")
      .eq("user_id", userId)
      .neq("status", "deleted")
      // This endpoint describes the Hivra-managed compute pool. Portable
      // agents consume their owner's infrastructure and must never appear as
      // managed usage. Null preserves pre-portability rows, which were always
      // Hivra-managed before deployment_mode existed.
      .or("deployment_mode.eq.hivra-managed,deployment_mode.is.null");
    if (hivraAgentsError) {
      log.warn("billing usage could not verify Hivra capacity", {
        source: "billing.usage",
        route: "/api/billing/usage",
        userId,
        failureType: "billing_usage_hivra_agents_query_failed",
      });
      const response = apiError("Current compute usage is unavailable. Refresh before choosing a size.", 503);
      response.headers.set("Cache-Control", "no-store");
      return response;
    }
    const activeHivraAgents = (hivraAgents || []).filter((a) =>
      isActiveComputeStatus(a.status)
    );
    // The agent count is the database's own slot count, the one launch and
    // attach enforce under the owner's slot lock. It also counts agents added
    // to the owner's Hivra Cloud computers, which have no row above and use
    // none of the pool's CPU or memory.
    const { data: slotCount, error: slotError } = await supabaseAdmin
      .rpc("hivra_owner_agent_slot_count", { p_owner: userId });
    if (slotError || !Number.isSafeInteger(slotCount) || (slotCount as number) < 0) {
      log.warn("billing usage could not verify the agent count", {
        source: "billing.usage",
        route: "/api/billing/usage",
        userId,
        failureType: "billing_usage_agent_slot_count_failed",
      });
      const response = apiError("Current compute usage is unavailable. Refresh before choosing a size.", 503);
      response.headers.set("Cache-Control", "no-store");
      return response;
    }
    const { usedCpu, usedRam, instances: mappedInstances } = calculateUsage(activeInstances, activeHivraAgents);
    const maxAgents = sub.instance_limit;
    const totalCpu = sub.total_cpu_budget;
    const totalRam = sub.total_ram_budget;

    return usageSuccess({
      subscribed: true,
      plan: {
        key: sub.plan,
        name: plan.name,
        price: plan.price,
        maxAgents,
        maxCpuPerAgent: plan.maxCpuPerAgent,
        maxRamPerAgent: plan.maxRamPerAgent,
        totalCpu,
        totalRam,
        status: sub.status,
        currentPeriodEnd: sub.currentPeriodEnd ?? null,
        source: sub.source,
        tokenTier: sub.tokenTier,
        canChangePlanInPlace: sub.canChangePlanInPlace,
        veniceBoost: {
          active: veniceBoostActive,
          cpuBonus: VENICE_BOOST_CPU,
          ramBonusMb: VENICE_BOOST_RAM_MB,
        },
      },
      usage: {
        agentCount: slotCount as number,
        maxAgents,
        usedCpu,
        totalCpu,
        usedRam,
        totalRam,
        instances: mappedInstances,
        // Whether the daily-backup add-on can be sold, by the same checks the
        // backup-addon route makes, so the page never offers one it rejects.
        backupAddon: resolveBackupAddon(sub, activeInstances),
      },
      credits,
    });
  } catch (error) {
    return apiError("Failed to fetch usage", 500, {
      failureType: "billing_usage_unexpected_error",
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
