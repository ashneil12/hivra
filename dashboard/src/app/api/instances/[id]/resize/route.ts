import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { apiError, apiSuccess } from "@/lib/api-response";
import { supabaseAdmin } from "@/lib/supabase";
import { applyTierChange } from "@/lib/services/tier-change-service";
import { resolveEffectiveTierSpec, type TierKey } from "@/lib/services/tier-specs";
import {
  getProxmoxHostRoutingConfigFromInfrastructure,
  getProxmoxInfrastructure,
  resizeProxmoxVm,
} from "@/lib/services/proxmox-instance-service";
import { priorityToCpuUnits } from "@/lib/proxmox/cpu-priority";
import { priorityForResourceTier } from "@/lib/subscription/agent-slots";
import { isVeniceBoostEligible } from "@/lib/billing/venice-compute-boost";

/**
 * PATCH /api/instances/[id]/resize
 *
 * Re-applies the user's current resource tier specs to a single VM. Mostly
 * a manual escape hatch — the Stripe webhook (handleSubscriptionChange)
 * applies tier changes to all of a user's instances automatically. This
 * route exists for:
 *   - admin-driven resize after a manual `resource_tier` DB edit
 *   - re-applying caps to a VM that was provisioned before its current
 *     tier (e.g. the user upgraded but the VM still has old caps)
 *   - debugging / poking after warden cache invalidation
 *
 * Body: empty (the VM's `resource_tier` from the DB drives the resize).
 *       To change tier, hit Stripe (live) or `applyTierChange()` directly.
 *
 * For Proxmox VMs only. Hetzner VMs return 501 — those need a container
 * recreate (handled separately by re-provisioning).
 */
export async function PATCH(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { userId } = await auth();
  if (!userId) return apiError("Unauthorized", 401);
  if (!supabaseAdmin) return apiError("Database not configured", 500);

  const { data: instance, error } = await supabaseAdmin
    .from("hermes_instances")
    .select("id, user_id, resource_tier, config, hetzner_server_id, host_id, status")
    .eq("id", id)
    .eq("user_id", userId)
    .neq("status", "deleted")
    .single();

  if (error || !instance) return apiError("Instance not found", 404);

  const tierKey = (instance.resource_tier || "credit_base") as TierKey;
  // Resolve caps identically to the owner-driven POST path (applyTierChange):
  // include the Venice compute boost for boost-eligible paid users, otherwise
  // an "admin" PATCH silently re-applies smaller UN-boosted caps. Best-effort:
  // a boost-table read hiccup degrades to "no boost" rather than failing the
  // resize.
  let veniceBoost = false;
  try {
    veniceBoost = await isVeniceBoostEligible(instance.user_id);
  } catch {
    veniceBoost = false;
  }
  const spec = resolveEffectiveTierSpec(tierKey, veniceBoost);

  const infrastructure = getProxmoxInfrastructure(instance.config);

  if (!infrastructure) {
    return apiError(
      "Live resize is only supported for Proxmox-backed instances. Hetzner instances will pick up new resource caps on next container recreate.",
      501
    );
  }

  const result = await resizeProxmoxVm({
    vmid: infrastructure.vmid,
    expectedInstanceId: instance.id,
    node: infrastructure.node,
    cpuLimit: spec.cpuLimit,
    memoryMb: spec.ramLimitMb,
    // Match the POST path's scheduling weight so PATCH and POST converge.
    cpuUnits: priorityToCpuUnits(priorityForResourceTier(tierKey)),
  }, {
    hostConfig: getProxmoxHostRoutingConfigFromInfrastructure(infrastructure, { host_id: instance.host_id ?? null }),
  });

  if (!result.ok) {
    return apiError(`Resize failed: ${result.error || result.stderr || "unknown"}`, 500);
  }

  return apiSuccess({
    instance_id: id,
    tier: tierKey,
    cpu_limit: spec.cpuLimit,
    ram_limit_mb: spec.ramLimitMb,
    output: result.stdout.split("\n").filter(Boolean).slice(-3),
  });
}

/**
 * POST /api/instances/[id]/resize
 *
 * Owner-driven "fix my caps" — re-applies tier from `applyTierChange` so
 * any drift between the user's tier and the VM's actual caps gets healed.
 * Idempotent.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { userId } = await auth();
  if (!userId) return apiError("Unauthorized", 401);
  if (!supabaseAdmin) return apiError("Database not configured", 500);

  const { data: instance, error } = await supabaseAdmin
    .from("hermes_instances")
    .select("user_id, resource_tier")
    .eq("id", id)
    .eq("user_id", userId)
    .neq("status", "deleted")
    .single();

  if (error || !instance) return apiError("Instance not found", 404);

  const outcome = await applyTierChange({
    userId,
    newTier: (instance.resource_tier || "credit_base") as TierKey,
    source: "manual",
    reason: `manual resize on instance ${id}`,
  });

  return apiSuccess(outcome);
}
