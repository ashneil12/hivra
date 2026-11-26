import { randomUUID } from "crypto";
import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { apiError, apiSuccess } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import { readInstanceLiveMutationBlock, type InstanceLiveMutationCoordinates } from "@/lib/services/instance-live-mutation";
import { applyTierChange } from "@/lib/services/tier-change-service";
import { resolveEffectiveTierSpec, type TierKey } from "@/lib/services/tier-specs";
import {
  getProxmoxHostRoutingConfigFromInfrastructure,
  getProxmoxInfrastructure,
  normalizeProxmoxTargetId,
  PROXMOX_RESIZE_VM_CONFIG_APPLIED_MARKER,
  isProxmoxResizePreflightRefusal,
  resizeProxmoxVm,
} from "@/lib/services/proxmox-instance-service";
import { priorityToCpuUnits } from "@/lib/proxmox/cpu-priority";
import { priorityForResourceTier } from "@/lib/subscription/agent-slots";
import { isVeniceBoostEligible } from "@/lib/billing/venice-compute-boost";
import { BRIDGE_UNAVAILABLE_MESSAGE, readManagedLaunchBridgeEpoch } from "@/lib/hivra/managed-launch-bridge";
import { proxmoxPlacementRpcPolicy } from "@/lib/proxmox/placement-policy";

type ResizeRow = InstanceLiveMutationCoordinates & {
  id: string;
  user_id: string;
  resource_tier?: string | null;
  seat_funding?: string | null;
  status?: string | null;
  lifecycle_state?: string | null;
  cpu_limit?: number | null;
  ram_limit?: number | null;
  resize_operation_id?: string | null;
  resize_target_cpu?: number | null;
  resize_target_ram_mb?: number | null;
};

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
  const epoch = await readManagedLaunchBridgeEpoch().catch(() => "unverified" as const);
  if (epoch === "unverified") return apiError(BRIDGE_UNAVAILABLE_MESSAGE, 503);
  const placement = epoch === "placement";
  const funded = placement || epoch === "funding";


  const { data: instance, error } = await supabaseAdmin
    .from("hermes_instances")
    .select("id, user_id, resource_tier, config, hetzner_server_id, host_id, status"
      + (funded ? ", seat_funding" : "")
      + (placement ? ", cpu_limit, ram_limit, lifecycle_state, proxmox_node, proxmox_vmid, resize_operation_id, resize_target_cpu, resize_target_ram_mb" : ""))
    .eq("id", id)
    .eq("user_id", userId)
    .neq("status", "deleted")
    .single<ResizeRow>();

  if (error || !instance) return apiError("Instance not found", 404);

  const tierKey = (instance.resource_tier || "credit_base") as TierKey;
  // Resolve caps identically to the owner-driven POST path (applyTierChange):
  // include the Venice compute boost for boost-eligible paid users, otherwise
  // an "admin" PATCH silently re-applies smaller UN-boosted caps. Best-effort:
  // a boost-table read hiccup degrades to "no boost" rather than failing the
  // resize.
  const holder = funded && instance.seat_funding === "holder";
  if (holder && !placement) return apiError("Holder allocations cannot be resized in this phase.", 409);
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
    ? { cpuLimit: Number(instance.cpu_limit), ramLimitMb: Number(instance.ram_limit) }
    : resolveEffectiveTierSpec(tierKey, veniceBoost);
  if (holder) {
    if (!Number.isFinite(spec.cpuLimit) || spec.cpuLimit <= 0 || !Number.isFinite(spec.ramLimitMb) || spec.ramLimitMb <= 0) {
      return apiError("Could not verify the stored holder allocation.", 409);
    }
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

  if (placement && (instance.status !== "running" || instance.lifecycle_state !== "active"
    || !instance.proxmox_node || instance.proxmox_vmid !== infrastructure.vmid
    || normalizeProxmoxTargetId(infrastructure.hostSlug ?? infrastructure.node) !== normalizeProxmoxTargetId(instance.proxmox_node))) {
    return apiError("This computer does not have a verified placement.", 409);
  }
  const storedResizeOperationId = typeof instance.resize_operation_id === "string" ? instance.resize_operation_id : null;
  const storedTargetMatches = storedResizeOperationId !== null
    && instance.resize_target_cpu != null
    && instance.resize_target_ram_mb != null
    && Number(instance.resize_target_cpu) === Number(spec.cpuLimit)
    && Number(instance.resize_target_ram_mb) === Number(spec.ramLimitMb);
  if (storedResizeOperationId && !storedTargetMatches) {
    return apiError("Another resize operation is already in progress for this instance.", 409);
  }
  const resizeOperationId = storedResizeOperationId ?? randomUUID();

  const blocked = placement ? await readInstanceLiveMutationBlock(supabaseAdmin, id, instance, undefined, undefined, userId) : null;
  if (blocked) return apiError(blocked, 409);

  let hostConfigAlreadyApplied = false;
  let newlyClaimed = false;
  if (placement) {
    const { data: allocationUpdated, error: allocationError } = await supabaseAdmin.rpc(
      "resize_hermes_instance_allocation",
      {
        p_instance_id: id,
        p_user_id: userId,
        p_cpu: spec.cpuLimit,
        p_ram_mb: spec.ramLimitMb,
        p_operation_id: resizeOperationId,
        ...proxmoxPlacementRpcPolicy(process.env),
      }
    );
    if (allocationError) {
      const conflict = allocationError.code === "P0058" || /capacity|already in progress/i.test(allocationError.message);
      return apiError(
        conflict ? "The selected host does not have enough remaining capacity for this allocation." : "Could not reserve the resized allocation.",
        conflict ? 409 : 503,
      );
    }
    const allocation = allocationUpdated as { status?: unknown; hostConfigApplied?: unknown } | null;
    const allocationStatus = allocation?.status;
    if (allocationStatus === "not_found") return apiError("Instance not found", 404);
    if (allocationStatus !== "claimed" && allocationStatus !== "reused") {
      return apiError("Could not reserve the resized allocation.", 503);
    }
    hostConfigAlreadyApplied = allocationStatus === "reused" && allocation?.hostConfigApplied === true;
    newlyClaimed = allocationStatus === "claimed";
    if (!newlyClaimed && !hostConfigAlreadyApplied) {
      return apiError("This resize is awaiting confirmation on the host.", 409);
    }
  }

  const preDispatchBlock = placement ? await readInstanceLiveMutationBlock(
    supabaseAdmin,
    id,
    instance,
    holder ? { cpu: spec.cpuLimit, ramMb: spec.ramLimitMb } : undefined,
    { operationId: resizeOperationId, cpu: spec.cpuLimit, ramMb: spec.ramLimitMb },
    userId,
  ) : null;
  if (preDispatchBlock) {
    if (newlyClaimed) {
      await supabaseAdmin.rpc("rollback_hermes_instance_resize_allocation", {
        p_instance_id: id, p_user_id: userId, p_operation_id: resizeOperationId,
      });
    }
    return apiError(preDispatchBlock, 409);
  }

  const result = hostConfigAlreadyApplied ? null : await resizeProxmoxVm({
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

  const vmConfigApplied = hostConfigAlreadyApplied
    || (result !== null && (result.ok || result.stdout.includes(PROXMOX_RESIZE_VM_CONFIG_APPLIED_MARKER)));
  if (placement) {
    if (vmConfigApplied) {
      if (!hostConfigAlreadyApplied) {
        const { data: hostApplicationRecorded, error: hostApplicationError } = await supabaseAdmin.rpc(
          "mark_hermes_instance_resize_host_config_applied",
          { p_instance_id: id, p_user_id: userId, p_operation_id: resizeOperationId }
        );
        if (hostApplicationError || hostApplicationRecorded !== true) {
          log.error("instance resize host application record failed", hostApplicationError ?? new Error("resize operation fence mismatch"), {
            source: "instances",
            route: "/api/instances/[id]/resize",
            method: "PATCH",
            instanceId: id,
            userId,
            failureType: "instance_resize_host_application_record_failed",
          });
        }
      }
      const { data: completed, error: completionError } = await supabaseAdmin.rpc(
        "complete_hermes_instance_resize_allocation",
        { p_instance_id: id, p_user_id: userId, p_operation_id: resizeOperationId }
      );
      if (completionError || completed !== true) {
        log.error("instance resize allocation completion failed", completionError ?? new Error("resize operation fence mismatch"), {
          source: "instances",
          route: "/api/instances/[id]/resize",
          method: "PATCH",
          instanceId: id,
          userId,
          failureType: "instance_resize_allocation_completion_failed",
        });
        return apiError("Resize completed on the host, but its allocation could not be finalized. Retry the repair before launching more agents.", 500);
      }
    } else if (result !== null && isProxmoxResizePreflightRefusal(result)) {
      const { data: rolledBack, error: rollbackError } = await supabaseAdmin.rpc(
        "rollback_hermes_instance_resize_allocation",
        { p_instance_id: id, p_user_id: userId, p_operation_id: resizeOperationId }
      );
      if (rollbackError || rolledBack !== true) {
        log.error("instance resize allocation rollback failed", rollbackError ?? new Error("resize operation fence mismatch"), {
          source: "instances",
          route: "/api/instances/[id]/resize",
          method: "PATCH",
          instanceId: id,
          userId,
          failureType: "instance_resize_allocation_rollback_failed",
        });
      }
    } else if (result !== null) {
      log.error("instance resize outcome is indeterminate; allocation remains reserved", new Error(String(result.error || result.stderr || "resize outcome unavailable")), {
        source: "instances",
        route: "/api/instances/[id]/resize",
        method: "PATCH",
        instanceId: id,
        userId,
        failureType: "instance_resize_outcome_indeterminate",
      });
    }
  }

  if (result !== null && !result.ok) {
    return apiError(`Resize failed: ${result.error || result.stderr || "unknown"}`, 500);
  }

  if (!placement) {
    // The VM now runs at the spec caps. Record them on the row: the capacity
    // checks, usage and memory-pressure routes read the stored columns, so a
    // stale row would keep reporting the old size.
    const { error: sizeUpdateError } = await supabaseAdmin
      .from("hermes_instances")
      .update({
        cpu_limit: spec.cpuLimit,
        ram_limit: spec.ramLimitMb,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("user_id", userId);
    if (sizeUpdateError) {
      log.error("instance resize database update failed after VM resize", sizeUpdateError, {
        source: "instances",
        route: "/api/instances/[id]/resize",
        method: "PATCH",
        instanceId: id,
        userId,
        failureType: "instance_resize_row_update_failed",
      });
      return apiError(
        "The VM was resized, but its saved allocation could not be updated. Retry the resize.",
        500,
      );
    }

  }

  return apiSuccess({
    instance_id: id,
    tier: tierKey,
    cpu_limit: spec.cpuLimit,
    ram_limit_mb: spec.ramLimitMb,
    output: (result?.stdout ?? "").split("\n").filter(Boolean).slice(-3),
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
  const epoch = await readManagedLaunchBridgeEpoch().catch(() => "unverified" as const);
  if (epoch === "unverified") return apiError(BRIDGE_UNAVAILABLE_MESSAGE, 503);
  const placement = epoch === "placement";
  const funded = placement || epoch === "funding";


  const { data: instance, error } = await supabaseAdmin
    .from("hermes_instances")
    .select(funded ? "user_id, resource_tier, seat_funding" : "user_id, resource_tier")
    .eq("id", id)
    .eq("user_id", userId)
    .neq("status", "deleted")
    .single<Pick<ResizeRow, "resource_tier" | "seat_funding">>();

  if (error || !instance) return apiError("Instance not found", 404);

  const holderSeats = funded && instance.seat_funding === "holder";
  if (holderSeats && !placement) return apiError("Holder allocations cannot be resized in this phase.", 409);
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
    ...(placement ? { holderSeats } : {}),
    source: "manual",
    reason: `manual resize on instance ${id}`,
  });

  return apiSuccess(outcome);
}
