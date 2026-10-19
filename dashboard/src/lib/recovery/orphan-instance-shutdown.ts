import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getServer, shutdownServer, waitForAction } from "@/lib/hetzner/client";
import { getProxmoxHostRoutingConfigFromInfrastructure, getProxmoxInfrastructure } from "@/lib/services/proxmox-infrastructure";
import type { InstanceShutdownFn, InstanceShutdownResult, OrphanedInstanceRow } from "@/lib/recovery/orphaned-instances";

async function shutdownHetznerServerVerified(serverId: number): Promise<void> {
  const before = await getServer(serverId);
  if (before.server.status === "off") return;
  const { action } = await shutdownServer(serverId);
  await waitForAction(action.id, 30_000);
  const after = await getServer(serverId);
  if (after.server.status !== "off") throw new Error("Hetzner server shutdown is not confirmed");
}

/**
 * Build a row-aware shutdown closure for the orphan sweep. Branches:
 *   1. Proxmox-backed (each instance is its own KVM) → shutdownProxmoxInstance
 *   2. Single-tenant legacy Hetzner (hetzner_server_id, no host_id) → shutdownServer
 *   3. Hetzner shared-host (host_id set):
 *      - if this orphan is the only live tenant → shutdown the shared host
 *      - else → skip (taking the host offline would knock other users out)
 */
export function buildShutdownInstance(
  supabase: SupabaseClient,
): InstanceShutdownFn {
  return async (row: OrphanedInstanceRow): Promise<InstanceShutdownResult> => {
    // Proxmox: per-VM, always isolated, safe to shut down.
    const configProxmox = getProxmoxInfrastructure(row.config);
    const storedProxmox =
      !configProxmox &&
      row.infrastructure_provider === "proxmox" &&
      typeof row.proxmox_vmid === "number" &&
      Number.isFinite(row.proxmox_vmid)
        ? {
            vmid: row.proxmox_vmid,
            ...(row.proxmox_node?.trim() ? { node: row.proxmox_node.trim() } : {}),
          }
        : null;
    const proxmox = configProxmox ?? storedProxmox;
    if (proxmox) {
      const { shutdownProxmoxInstance } = await import(
        "@/lib/services/proxmox-instance-service"
      );
      const result = await shutdownProxmoxInstance(proxmox, {
        expectedInstanceId: row.id,
        setOnboot: 0,
        verifyOnboot: true,
        shutdownTimeoutSeconds: 30,
        hostConfig: getProxmoxHostRoutingConfigFromInfrastructure(proxmox, { host_id: row.host_id ?? null }),
      });
      if (result.ok) return { ok: true };
      return {
        ok: false,
        detail: (result.error || result.stderr || "proxmox shutdown failed").slice(0, 240),
      };
    }

    // Hetzner shared host: only shut down if this orphan is the sole live tenant.
    if (row.host_id) {
      const { count, error } = await supabase
        .from("hermes_instances")
        .select("id", { count: "exact", head: true })
        .eq("host_id", row.host_id)
        .neq("status", "deleted")
        .neq("id", row.id);
      if (error) {
        return { ok: false, detail: `host tenant count failed: ${error.message}` };
      }
      if ((count ?? 0) > 0) {
        return {
          ok: false,
          skipped: true,
          detail: `shared host has ${count} other live instance(s); host_id=${row.host_id}`,
        };
      }
      const { data: host, error: hostError } = await supabase
        .from("hermes_hosts")
        .select("hetzner_server_id")
        .eq("id", row.host_id)
        .single<{ hetzner_server_id: number | null }>();
      if (hostError || !host?.hetzner_server_id) {
        return {
          ok: false,
          detail: hostError?.message ?? "no hetzner_server_id on host",
        };
      }
      try {
        await shutdownHetznerServerVerified(host.hetzner_server_id);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // Single-tenant legacy Hetzner row (no host_id but a direct server id).
    if (row.hetzner_server_id != null) {
      try {
        await shutdownHetznerServerVerified(row.hetzner_server_id);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }

    return { ok: false, detail: "no infrastructure reference on row" };
  };
}

