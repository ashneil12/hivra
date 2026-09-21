import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { removeInstanceDnsBestEffort } from "@/lib/services/cloudflare-dns";
import { deleteHetznerServer } from "@/lib/services/hetzner-instance-service";
import {
  getProxmoxHostRoutingConfigFromInfrastructure,
  getProxmoxInfrastructure,
} from "@/lib/services/proxmox-infrastructure";

type HostDeleteRow = {
  id: string;
  name: string | null;
  status: string | null;
  hetzner_server_id?: number | null;
};

type LinkedInstanceDeleteRow = {
  id: string;
  hetzner_server_id?: number | null;
  host_id?: string | null;
  config?: unknown;
  subdomain?: string | null;
};

type ProviderTeardownResult = {
  proxmoxDeleted: number;
  hetznerDeleted: number;
  // Instance ids whose provider teardown FULLY succeeded — only these are safe
  // to soft-delete (hide) since their real VM/server is confirmed gone.
  deletableInstanceIds: string[];
  // Per-resource teardown failures collected best-effort (never thrown).
  errors: Array<{
    instanceId?: string;
    hetznerServerId?: number;
    reason: string;
  }>;
};

async function deleteLinkedProviderResources(params: {
  host: HostDeleteRow;
  instances: LinkedInstanceDeleteRow[];
  userId: string;
}): Promise<ProviderTeardownResult> {
  const { host, instances, userId } = params;
  // Map each Hetzner server id back to the instance(s) that depend on it so a
  // server-destroy failure only blocks soft-deleting the affected instance(s),
  // not the whole batch.
  const hetznerServerToInstances = new Map<number, string[]>();
  const deletableInstanceIds = new Set<string>();
  const errors: ProviderTeardownResult["errors"] = [];
  let proxmoxDeleted = 0;

  // Phase 1: tear down each instance's provider resource best-effort. A single
  // stuck VM must NOT abort teardown of its siblings (the partial-teardown /
  // manual-cleanup failure class), so we collect errors and keep going.
  for (const instance of instances) {
    const proxmoxInfra = getProxmoxInfrastructure(instance.config);
    if (proxmoxInfra) {
      const { deleteProxmoxInstance } = await import(
        "@/lib/services/proxmox-instance-service"
      );
      let result: Awaited<ReturnType<typeof deleteProxmoxInstance>>;
      try {
        result = await deleteProxmoxInstance(proxmoxInfra, {
          hostConfig: getProxmoxHostRoutingConfigFromInfrastructure(proxmoxInfra, {
            host_id: instance.host_id ?? host.id,
          }),
          expectedInstanceId: instance.id,
        });
      } catch (err) {
        result = {
          ok: false,
          stdout: "",
          stderr: "",
          error: err instanceof Error ? err.message : String(err),
        };
      }
      if (!result.ok) {
        log.error("failed to delete proxmox vm for host deletion", new Error("proxmox_delete_failed"), {
          source: "hosts-by-id",
          route: "/api/hosts/[id]",
          method: "DELETE",
          failureType: "host_delete_proxmox_vm_failed",
          hostId: host.id,
          instanceId: instance.id,
          userId,
          proxmoxVmid: proxmoxInfra.vmid,
        });
        errors.push({ instanceId: instance.id, reason: "proxmox_delete_failed" });
        continue;
      }
      proxmoxDeleted += 1;
      deletableInstanceIds.add(instance.id);

      await removeInstanceDnsBestEffort(instance.subdomain, {
        source: "hosts-by-id",
        route: "/api/hosts/[id]",
        hostId: host.id,
        instanceId: instance.id,
        userId,
      });
      continue;
    }

    if (typeof instance.hetzner_server_id === "number") {
      const existing = hetznerServerToInstances.get(instance.hetzner_server_id) ?? [];
      existing.push(instance.id);
      hetznerServerToInstances.set(instance.hetzner_server_id, existing);
      // Hetzner-backed tenant: drop the per-tenant A record now. The server
      // gets destroyed in the loop below; even if that fails, the DB row is
      // about to flip to deleted and the next attempt will be idempotent.
      await removeInstanceDnsBestEffort(instance.subdomain, {
        source: "hosts-by-id",
        route: "/api/hosts/[id]",
        hostId: host.id,
        instanceId: instance.id,
        userId,
      });
    } else {
      // No provider resource on this instance (already released / never
      // provisioned) — safe to soft-delete.
      deletableInstanceIds.add(instance.id);
    }
  }

  // The host's own Hetzner server (if any) is not tied to a specific instance.
  const hostServerId =
    typeof host.hetzner_server_id === "number" ? host.hetzner_server_id : null;
  const allServerIds = new Set<number>(hetznerServerToInstances.keys());
  if (hostServerId !== null) allServerIds.add(hostServerId);

  // Phase 2: destroy each Hetzner server best-effort. A transient blip on one
  // server only blocks the instance(s) that depend on it, not the whole delete.
  let hetznerDeleted = 0;
  for (const serverId of allServerIds) {
    const dependentInstanceIds = hetznerServerToInstances.get(serverId) ?? [];
    try {
      await deleteHetznerServer(serverId);
      hetznerDeleted += 1;
      for (const instanceId of dependentInstanceIds) deletableInstanceIds.add(instanceId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("404")) {
        log.warn("hetzner server already deleted during host deletion", {
          source: "hosts-by-id",
          route: "/api/hosts/[id]",
          method: "DELETE",
          failureType: "host_delete_hetzner_already_deleted",
          hostId: host.id,
          userId,
          hetznerServerId: serverId,
        });
        // 404 = already gone, so dependents are safe to soft-delete.
        for (const instanceId of dependentInstanceIds) deletableInstanceIds.add(instanceId);
        continue;
      }
      log.error("failed to delete hetzner server for host deletion", new Error("hetzner_delete_failed"), {
        source: "hosts-by-id",
        route: "/api/hosts/[id]",
        method: "DELETE",
        failureType: "host_delete_hetzner_server_failed",
        hostId: host.id,
        userId,
        hetznerServerId: serverId,
      });
      errors.push({ hetznerServerId: serverId, reason: "hetzner_delete_failed" });
      // Do NOT mark dependent instances deletable — their server may still be
      // running and billing; leaving the row visible avoids the hide-a-live-VM
      // failure class.
    }
  }

  return {
    proxmoxDeleted,
    hetznerDeleted,
    deletableInstanceIds: Array.from(deletableInstanceIds),
    errors,
  };
}

/**
 * DELETE /api/hosts/[id]
 *
 * Deletes provider resources for a user's host, then soft-deletes the DB
 * host record and its linked instances. Provider teardown must happen first:
 * otherwise the UI hides the host while the real server/VM keeps running.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const { id } = await params;
    if (!id) return apiError("Host ID is required", 400);

    // Verify ownership before touching anything
    const { data: host, error: fetchError } = await supabaseAdmin
      .from("hermes_hosts")
      .select("id, name, status, hetzner_server_id")
      .eq("id", id)
      .eq("user_id", userId)
      .single<HostDeleteRow>();

    if (fetchError || !host) {
      return apiError("Host not found", 404);
    }

    if (host.status === "deleted") {
      // Already deleted — idempotent response
      return apiSuccess({ id, message: "Host already deleted" });
    }

    const { data: linkedInstances, error: linkedInstancesError } = await supabaseAdmin
      .from("hermes_instances")
      .select("id, hetzner_server_id, host_id, config, subdomain")
      .eq("host_id", id)
      .eq("user_id", userId)
      .neq("status", "deleted");

    if (linkedInstancesError) {
      return apiError("Failed to load linked instances", 500, {
        errorType: "host_instances_fetch_failed",
      });
    }

    let deletedResources: ProviderTeardownResult;
    try {
      deletedResources = await deleteLinkedProviderResources({
        host,
        instances: linkedInstances ?? [],
        userId,
      });
    } catch (err) {
      // Defensive: teardown is best-effort and collects its own errors, but an
      // unexpected throw (e.g. a dynamic import failure) must still 502 without
      // soft-deleting anything (never hide a host whose VMs may still run).
      log.error("unexpected host teardown failure", err, {
        source: "hosts-by-id",
        route: "/api/hosts/[id]",
        method: "DELETE",
        failureType: "host_provider_delete_unexpected",
        hostId: id,
        userId,
      });
      return apiError("Failed to delete linked server resources", 502, {
        errorType: "host_provider_delete_failed",
      });
    }

    const deletedAt = new Date().toISOString();

    // Only soft-delete instances whose provider resource was confirmed torn
    // down. Hiding a row whose real VM/server may still be running is the
    // failure class this guards against.
    if (deletedResources.deletableInstanceIds.length > 0) {
      const { error: instancesError } = await supabaseAdmin
        .from("hermes_instances")
        .update({
          status: "deleted",
          lifecycle_state: "deleted",
          proxmox_vmid: null,
          deleted_at: deletedAt,
          last_lifecycle_transition_at: deletedAt,
          updated_at: deletedAt,
        })
        .in("id", deletedResources.deletableInstanceIds)
        .eq("user_id", userId)
        .neq("status", "deleted");

      if (instancesError) {
        return apiError("Failed to clean up linked instances", 500, {
          errorType: "host_instances_cleanup_failed",
        });
      }
    }

    // Partial teardown: at least one provider resource failed to delete. Leave
    // the host (and any still-running instances) visible so the UI never hides
    // a live, billing resource, and surface the failure on the ops feed for
    // follow-up + manual cleanup. Best-effort audit — never block the response.
    if (deletedResources.errors.length > 0) {
      try {
        await reportOpsEvent({
          source: "hosts.delete_partial",
          severity: "error",
          title: "Host delete: partial provider teardown",
          message: `Host ${id} teardown left ${deletedResources.errors.length} resource(s) un-deleted; host not soft-deleted`,
          route: "/api/hosts/[id]",
          userId,
          metadata: {
            host_id: id,
            host_name: host.name,
            proxmox_deleted: deletedResources.proxmoxDeleted,
            hetzner_deleted: deletedResources.hetznerDeleted,
            soft_deleted_instance_ids: deletedResources.deletableInstanceIds,
            teardown_errors: deletedResources.errors,
          },
        });
      } catch {
        // swallow — partial teardown is already being reported via the 502.
      }

      return apiError("Failed to delete linked server resources", 502, {
        errorType: "host_provider_delete_failed",
      });
    }

    // Soft-delete the host itself (only reached when teardown was fully clean)
    const { error: deleteError } = await supabaseAdmin
      .from("hermes_hosts")
      .update({ status: "deleted", updated_at: deletedAt })
      .eq("id", id)
      .eq("user_id", userId);

    if (deleteError) {
      return apiError("Failed to delete host", 500, {
        errorType: "host_delete_failed",
      });
    }

    log.info("host soft-deleted", {
      source: "hosts-by-id",
      route: "/api/hosts/[id]",
      method: "DELETE",
      hostId: id,
      hostName: host.name,
      userId,
      proxmoxDeleted: deletedResources.proxmoxDeleted,
      hetznerDeleted: deletedResources.hetznerDeleted,
    });
    return apiSuccess({
      id,
      message: "Host deleted successfully",
      deletedResources: {
        proxmoxDeleted: deletedResources.proxmoxDeleted,
        hetznerDeleted: deletedResources.hetznerDeleted,
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
