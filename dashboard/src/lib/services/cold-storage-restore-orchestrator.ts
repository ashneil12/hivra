/**
 * Cold-storage restore orchestrator.
 *
 * Wraps `restoreInstance()` from cold-storage-service with the work of
 * picking a destination PVE host + free VMID + IP. Called from the
 * `POST /api/instances/[id]` action=start handler when the row is in a
 * cold lifecycle state (cold_archived / pending_deletion).
 *
 * Inputs: supabase admin client + an instance row already loaded by the
 * caller. Output: a ColdRestoreResult-shaped object the route can map to
 * an HTTP response.
 *
 * See docs/cold-storage-orchestration.md §4 for the spec this implements.
 */

import { supabaseAdmin } from "@/lib/supabase";

import {
  getProxmoxVmidAvailability,
  type ProxmoxHostRoutingConfig,
} from "./proxmox-instance-service";
import {
  restoreInstance,
  type ColdRestoreResult,
} from "./cold-storage-service";
import { selectAvailableProxmoxProvisionTarget } from "./instance-service";
import { applyRestoreRouting } from "./cold-storage-restore-routing";
import { log } from "@/lib/logger";

type SupabaseAdminClient = NonNullable<typeof supabaseAdmin>;

export type ColdRestoreOrchestratorResult =
  | ColdRestoreResult
  | {
      ok: false;
      reason: "no_capacity" | "no_free_vmid" | "env_misconfigured" | "exception";
      message: string;
      instanceId: string;
      retryable: boolean;
    };

export type ColdRestoreOrchestratorInput = {
  instance: {
    id: string;
    user_id: string;
    resource_tier: string | null;
    cpu_limit: number | null;
    ram_limit: number | null;
    disk_size_gb: number | null;
    /** Pre-archive host slug. Passed so the post-restore routing pass can
     *  clean up the stale Caddy site file on the previous host. Optional —
     *  cleanup is best-effort and a missing value just skips it. */
    proxmox_node?: string | null;
    /** Public hostname the dashboard hands users (e.g. `<id>.agents.hermesos.cloud`).
     *  Needed by the routing pass to write the right Caddy site + upsert
     *  the right Cloudflare A record. When missing the routing pass skips
     *  itself; the user's existing gateway URL would 502 until ops fixes
     *  it manually. */
    gateway_host?: string | null;
  };
};

function envInt(env: NodeJS.ProcessEnv | Record<string, string | undefined>, key: string, fallback: number): number {
  const v = env[key]?.trim();
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envVal(env: NodeJS.ProcessEnv | Record<string, string | undefined>, key: string): string | null {
  const v = env[key]?.trim();
  return v && v.length > 0 ? v : null;
}

/**
 * The main entrypoint. Picks a destination then calls restoreInstance.
 *
 * - Allocator (selectAvailableProxmoxProvisionTarget) picks the host based
 *   on capacity for the row's tier.
 * - getProxmoxVmidAvailability picks the next free VMID on that host.
 * - IP is derived from PROXMOX_IP_LAST_OCTET_START + (VMID - VMID_START),
 *   matching the same arithmetic the existing provision script uses
 *   (proxmox-instance-service.ts: IP_LAST = IP_LAST_OCTET_START + VMID - VMID_START).
 */
export async function orchestrateColdRestore(
  supabase: SupabaseAdminClient,
  input: ColdRestoreOrchestratorInput
): Promise<ColdRestoreOrchestratorResult> {
  const instance = input.instance;
  const cpu = instance.cpu_limit ?? 1;
  const ramMb = instance.ram_limit ?? 1024;
  const diskGb = instance.disk_size_gb ?? 30;

  // Build hostConfig: caller may have preferred the original node, but for
  // restore the source host VM was destroyed so we must pick any host with
  // capacity. Pass null hostConfig and let the allocator scan all targets.
  const hostConfig: ProxmoxHostRoutingConfig | null = null;

  let selection;
  try {
    selection = await selectAvailableProxmoxProvisionTarget({
      supabase,
      env: process.env,
      hostConfig,
      userId: instance.user_id,
      neededCpu: cpu,
      neededRamMb: ramMb,
      neededDiskGb: diskGb,
    });
  } catch (err) {
    return {
      ok: false,
      reason: "exception",
      message: `host selection threw: ${err instanceof Error ? err.message : String(err)}`,
      instanceId: instance.id,
      retryable: true,
    };
  }

  if (!selection.ok) {
    return {
      ok: false,
      reason: "no_capacity",
      message: selection.message,
      instanceId: instance.id,
      retryable: selection.status === 503,
    };
  }

  const targetEnv = selection.env;
  const targetSlug = (envVal(targetEnv, "PROXMOX_HOST_SLUG") ??
    envVal(targetEnv, "PROXMOX_NODE") ??
    selection.targetId) as string;

  // Pick a free VMID on the selected host.
  const vmidAvailability = await getProxmoxVmidAvailability({
    env: targetEnv,
    hostConfig,
  });
  if (!vmidAvailability.ok) {
    return {
      ok: false,
      reason: "env_misconfigured",
      message: `vmid availability check failed: ${vmidAvailability.error}`,
      instanceId: instance.id,
      retryable: true,
    };
  }
  if (vmidAvailability.freeVmids.length === 0) {
    return {
      ok: false,
      reason: "no_free_vmid",
      message: `host ${targetSlug} has no free VMIDs in range ${vmidAvailability.vmidStart}-${vmidAvailability.vmidEnd}`,
      instanceId: instance.id,
      retryable: true,
    };
  }
  // Pick a VMID at random from the top N free VMIDs on this host. Always
  // taking freeVmids[0] makes N concurrent restores all target the same
  // VMID — first one wins the `qm clone`, the other N-1 fail with "VMID
  // already exists" and revert. Randomization spreads concurrent restores
  // across the available range so the typical handful-of-users-clicking-
  // Start-at-once case lands cleanly. Collision risk under K concurrent
  // calls into a pool of M VMIDs is K(K-1)/(2M) — with M=20, K=5 that's
  // ~50%; with K=2 that's 2.5% — acceptable.
  // A truly atomic reserve-then-clone would need a UNIQUE constraint on
  // (proxmox_node, proxmox_vmid) + a retry loop; deferred until we see a
  // production collision after this band-aid.
  const VMID_PICK_POOL = 20;
  const pickFrom = vmidAvailability.freeVmids.slice(0, VMID_PICK_POOL);
  const destinationVmid = pickFrom[Math.floor(Math.random() * pickFrom.length)]!;

  // Derive IP from the host's allocation env, matching the existing
  // provisioning arithmetic.
  const ipLastOctetStart = envInt(targetEnv, "PROXMOX_IP_LAST_OCTET_START", 50);
  const subnetPrefix = envVal(targetEnv, "PROXMOX_PRIVATE_SUBNET_PREFIX");
  const gateway = envVal(targetEnv, "PROXMOX_PRIVATE_GATEWAY");
  const templateVmid = envInt(targetEnv, "PROXMOX_TEMPLATE_ID", 0);

  if (!subnetPrefix || !gateway || !templateVmid) {
    return {
      ok: false,
      reason: "env_misconfigured",
      message: `host ${targetSlug} missing PROXMOX_PRIVATE_SUBNET_PREFIX, PROXMOX_PRIVATE_GATEWAY, or PROXMOX_TEMPLATE_ID`,
      instanceId: instance.id,
      retryable: false,
    };
  }

  const ipLastOctet = ipLastOctetStart + (destinationVmid - vmidAvailability.vmidStart);
  const destinationIp = `${subnetPrefix}.${ipLastOctet}`;

  // restoreInstance calls resolveProxmoxHostEnv internally using process.env
  // and the destinationHostSlug. Passing a pre-resolved env here would cause
  // a double-resolve (the second call wouldn't find PROXMOX_<HOST>_* keys
  // since they got flattened to PROXMOX_* in the first pass) and throw
  // "no matching environment overrides". So just let restoreInstance handle
  // env resolution natively.
  const restoreResult = await restoreInstance(supabase, instance.id, {
    destinationHostSlug: targetSlug,
    destinationVmid,
    destinationIp,
    destinationGateway: gateway,
    templateVmid,
    targetDiskGb: diskGb,
    cpuLimit: cpu,
  });

  // health_pending is NOT a failure: the data restored and the VM is live, the
  // gateway just hadn't gone healthy inside the script window. The row is parked
  // (lifecycle_substate='restore_health_pending') for the recover-stuck-restoring
  // sweep to promote. We STILL apply routing below using the new VM's
  // coordinates (carried on the result) so the gateway becomes reachable and the
  // probe can succeed. Any other non-ok result is a genuine failure: the row was
  // already reverted to cold by restoreInstance, so return early.
  const isHealthPending = !restoreResult.ok && restoreResult.reason === "health_pending";
  if (!restoreResult.ok && !isHealthPending) return restoreResult;

  // newVmid/newPveHost/newIpv4 are present on a successful restore and are also
  // populated on the health_pending result.
  const newIpv4 = restoreResult.ok ? restoreResult.newIpv4 : restoreResult.newIpv4;
  const newPveHost = restoreResult.ok ? restoreResult.newPveHost : restoreResult.newPveHost;

  // Post-restore routing pass: write host Caddy site on the new host,
  // upsert a specific Cloudflare A record (overriding the wildcard that
  // still points at the old host), best-effort clean up the old host's
  // Caddy site. Failures here don't roll back the restore — data is on
  // disk and the row is `active` (or parked health_pending), but the user's
  // URL may 502 until ops reruns. We log every leg so the failure mode is
  // observable.
  if (instance.gateway_host && newIpv4 && newPveHost) {
    const routing = await applyRestoreRouting({
      instanceId: instance.id,
      gatewayHost: instance.gateway_host,
      newPrivateIp: newIpv4,
      newHostSlug: newPveHost,
      oldHostSlug: instance.proxmox_node ?? null,
    });
    log.info("post-restore routing applied", {
      source: "cold-storage-restore-orchestrator",
      instanceId: instance.id,
      gatewayHost: instance.gateway_host,
      newHostSlug: newPveHost,
      oldHostSlug: instance.proxmox_node ?? null,
      healthPending: isHealthPending,
      hostCaddyOk: routing.hostCaddy.ok,
      cloudflareOk: routing.cloudflareDns.ok,
      cloudflareOutcome: routing.cloudflareDns.outcome,
      oldHostCleanupOk: routing.oldHostCaddyCleanup.ok,
    });
  } else if (!instance.gateway_host) {
    log.warn("post-restore routing skipped: gateway_host missing from input", {
      source: "cold-storage-restore-orchestrator",
      instanceId: instance.id,
      failureType: "post_restore_routing_skipped_no_gateway_host",
    });
  }

  return restoreResult;
}
