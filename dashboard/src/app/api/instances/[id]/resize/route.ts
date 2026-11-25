import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { apiError, apiSuccess } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import { readInstanceLiveMutationBlock } from "@/lib/services/instance-live-mutation";
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
    .select("id, user_id, resource_tier, seat_funding, cpu_limit, ram_limit, config, hetzner_server_id, host_id, status, lifecycle_state")
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
  const holder = instance.seat_funding === "holder";
  if (holder && (instance.status !== "running" || instance.lifecycle_state !== "active")) {
    return apiError("Start this holder-funded instance before repairing its live caps.", 409);
  }
  let veniceBoost = false;
  try {
    veniceBoost = !holder && await isVeniceBoostEligible(instance.user_id);
  } catch {
    veniceBoost = false;
  }
  const spec = holder
    ? { cpuLimit: instance.cpu_limit, ramLimitMb: instance.ram_limit }
    : resolveEffectiveTierSpec(tierKey, veniceBoost);
  if (holder) {
    // This repair re-applies exactly the allocation already charged to the
    // row. Only a validated DB allocation change may grant a larger size.
    const { data: valid, error: validationError } = await supabaseAdmin.rpc("holder_seat_funding_valid", {
      p_user_id: userId, p_cpu: spec.cpuLimit, p_ram_mb: spec.ramLimitMb,
      p_exclude_hermes_instance_id: id,
    });
    if (validationError) return apiError("Could not verify the token-holder reservation.", 503);
    if (valid !== true) return apiError("This allocation exceeds the available token-holder reservation.", 409);
  }

  const infrastructure = getProxmoxInfrastructure(instance.config);

  if (!infrastructure) {
    return apiError(
      "Live resize is only supported for Proxmox-backed instances. Hetzner instances will pick up new resource caps on next container recreate.",
      501
    );
  }

  const blocked = await readInstanceLiveMutationBlock(supabaseAdmin, id, instance,
    holder ? { cpu: spec.cpuLimit, ramMb: spec.ramLimitMb } : undefined);
  if (blocked) return apiError(blocked, 409);

  if (!holder) {
    const { data: allocationUpdated, error: allocationError } = await supabaseAdmin.rpc(
      "resize_hermes_instance_allocation",
      {
        p_instance_id: id,
        p_user_id: userId,
        p_cpu: spec.cpuLimit,
        p_ram_mb: spec.ramLimitMb,
      }
    );
    if (allocationError) {
      const conflict = allocationError.code === "P0058" || /capacity/i.test(allocationError.message);
      return apiError(
        conflict ? "The selected host does not have enough remaining capacity for this allocation." : "Could not reserve the resized allocation.",
        conflict ? 409 : 503,
      );
    }
    if (allocationUpdated !== true) return apiError("Instance not found", 404);
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
    if (!holder) {
      // The intended allocation was reserved before the host mutation so
      // concurrent placements could not consume the same headroom. Releasing
      // it after a failed mutation is capacity-reducing and therefore safe to
      // write directly; the next successful repair reserves it again.
      const { error: rollbackError } = await supabaseAdmin
        .from("hermes_instances")
        .update({ cpu_limit: instance.cpu_limit, ram_limit: instance.ram_limit })
        .eq("id", id)
        .eq("user_id", userId);
      if (rollbackError) {
        log.error("instance resize allocation rollback failed", rollbackError, {
          source: "instances",
          route: "/api/instances/[id]/resize",
          method: "PATCH",
          instanceId: id,
          userId,
          failureType: "instance_resize_allocation_rollback_failed",
        });
      }
    }
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
    .select("user_id, resource_tier, seat_funding")
    .eq("id", id)
    .eq("user_id", userId)
    .neq("status", "deleted")
    .single();

  if (error || !instance) return apiError("Instance not found", 404);

  const holderSeats = instance.seat_funding === "holder";
  let newTier = (instance.resource_tier || "credit_base") as TierKey;
  if (holderSeats) {
    const { data, error } = await supabaseAdmin.rpc("holder_admission_state", { p_user_id: userId });
    if (error) return apiError("Could not verify the token-holder reservation.", 503);
    if (data?.state !== "admitted" || !["power", "pro"].includes(data.tier)) {
      return apiError("An active holder reservation is required to reapply these caps.", 409);
    }
    newTier = data.tier === "power" ? "fleet" : "operator";
  }
  const outcome = await applyTierChange({
    userId,
    newTier,
    holderSeats,
    source: "manual",
    reason: `manual resize on instance ${id}`,
  });

  return apiSuccess(outcome);
}
