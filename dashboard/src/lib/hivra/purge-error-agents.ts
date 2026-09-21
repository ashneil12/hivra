/**
 * Purge sweep for hivra_agents rows in terminal `status='error'`.
 *
 * Why this exists: `error` is a dead-end state. No cron transitions it (the
 * stuck-provisioning sweep only handles `provisioning` rows), and the agents
 * list (GET /api/hivra/agents) hides error rows, so the user can't see or
 * delete them — they sit invisible forever. Worse, a failed provision can
 * strand real infrastructure behind the row: a VM that allocated before the
 * failure, and — for rows that errored before the 2026-06-10 teardown fix —
 * an orphaned Cloudflare named tunnel + CNAME (cf_tunnel_id / cf_hostname).
 *
 * Decision table per candidate (status=error, older than the grace window):
 *   - vmid set, host probe/destroy fails ... skip (transient or needs an
 *                                            operator; retried next sweep —
 *                                            NEVER flip to deleted while a VM
 *                                            may still exist, the row is the
 *                                            only pointer to it)
 *   - VM confirmed gone (or no vmid) ....... release tunnel (best-effort) →
 *                                            flip to deleted → log event
 *
 * The grace window leaves time for an operator to inspect or redrive a fresh
 * failure before its row is retired. The flip is guarded on status='error'
 * so a concurrent run (or operator action) is never clobbered; the "deleted"
 * event is only logged when this run actually flipped the row.
 */

import { logHivraAgentEvent } from "@/lib/hivra/agent-events";
import { resolveHivraProxmoxHost } from "@/lib/hivra/proxmox-target";
import { log } from "@/lib/logger";
import { deleteBoxTunnel } from "@/lib/services/cloudflare-tunnel";
import {
  resolveProxmoxTargetConfiguration,
  runProxmoxHostScript,
} from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";

const LOG_SOURCE = "hivra/purge-error-agents";

// Release fuse: destructive purge must not run until it claims the same durable
// delete lease and verifies the stable provider binding tag as the API route.
export const ERROR_PURGE_PROVIDER_MUTATION_ENABLED = false;

/** Error rows younger than this are left for operator inspection/redrive. */
const ERROR_PURGE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/** Per-run cap: each vmid-bearing candidate costs an SSH round-trip that may
 *  include a VM stop+destroy. */
const MAX_CANDIDATES_PER_RUN = 12;

/** Stop (--timeout 30) + destroy + storage verification can be slow on a
 *  loaded host; give the SSH session generous headroom. */
const SSH_TIMEOUT_MS = 120_000;

interface ErrorAgentRow {
  id: string;
  user_id: string;
  type: string | null;
  status: string;
  vmid: number | null;
  proxmox_host: string | null;
  cf_tunnel_id: string | null;
  cf_hostname: string | null;
  error: string | null;
  created_at: string;
}

type ErrorPurgeAction = "purged" | "skipped";

interface ErrorPurgeResult {
  agentId: string;
  vmid: number | null;
  action: ErrorPurgeAction;
  reason: string;
}

export interface PurgeErrorHivraAgentsSummary {
  scanned: number;
  purged: number;
  skipped: number;
  results: ErrorPurgeResult[];
}

export interface PurgeErrorHivraAgentsOptions {
  /** Limit the sweep to one agent (ops escape hatch: ?id= on the cron route). */
  agentId?: string | null;
  now?: Date;
}

// Same script as the user-facing DELETE route: idempotent destroy that exits
// non-zero unless the VM is verifiably gone (qm status AND local-lvm volumes),
// so result.ok === "nothing of this VM remains on the host".
function buildDestroyScript(vmid: number): string {
  return `set -euo pipefail
VMID='${vmid}'
if qm status "$VMID" >/dev/null 2>&1; then
  qm stop "$VMID" --timeout 30 2>/dev/null || true
  qm destroy "$VMID" --purge 1 --destroy-unreferenced-disks 1
fi
rm -f "/root/hivra-prov-$VMID.log" "/root/hivra-start-$VMID.log"
if qm status "$VMID" >/dev/null 2>&1; then
  echo "VMID $VMID still exists after destroy" >&2
  exit 1
fi
if pvesm list local-lvm 2>/dev/null | grep -E "vm-${vmid}-"; then
  echo "VMID $VMID still has local-lvm volumes after destroy" >&2
  exit 1
fi
echo "destroyed $VMID"`;
}

async function purgeOne(row: ErrorAgentRow): Promise<ErrorPurgeResult> {
  const base = { agentId: row.id, vmid: row.vmid };
  if (!supabaseAdmin) return { ...base, action: "skipped", reason: "no database client" };

  // A vmid means a VM may have allocated before the provision failed (the POST
  // persists identity before any post-allocation step can error). Confirm it's
  // gone — destroying it if still present — before the row is retired.
  if (row.vmid) {
    const env = resolveProxmoxTargetConfiguration(
      process.env,
      resolveHivraProxmoxHost(row.proxmox_host),
    ).env;
    const destroy = await runProxmoxHostScript(buildDestroyScript(row.vmid), env, {
      timeoutMs: SSH_TIMEOUT_MS,
    });
    if (!destroy.ok) {
      log.warn("error-row purge could not confirm VM gone; will retry next sweep", {
        source: LOG_SOURCE,
        failureType: "hivra_error_purge_vm_not_confirmed_gone",
        agentId: row.id,
        vmid: row.vmid,
        proxmoxHost: row.proxmox_host,
        errorMessage: destroy.error ?? null,
        stderr: destroy.stderr?.slice(0, 300) ?? null,
      });
      return { ...base, action: "skipped", reason: "VM destroy/verification failed (transient or needs operator)" };
    }
  }

  // Tunnel before the DB flip so a flip failure retries the (idempotent)
  // teardown next sweep instead of stranding it behind a deleted row.
  // Best-effort by contract — deleteBoxTunnel never throws.
  if (row.cf_tunnel_id || row.cf_hostname) {
    await deleteBoxTunnel({ tunnelId: row.cf_tunnel_id, hostname: row.cf_hostname });
  }

  const { data: flipped, error } = await supabaseAdmin
    .from("hivra_agents")
    .update({ status: "deleted" })
    .eq("id", row.id)
    .eq("status", "error")
    .select("id");
  if (error) throw new Error(`purge status flip failed: ${error.message}`);
  if (!flipped || flipped.length === 0) {
    // Concurrent run or operator got here first; nothing left to do.
    return { ...base, action: "skipped", reason: "row already transitioned out of error" };
  }

  await logHivraAgentEvent({
    userId: row.user_id,
    event: "deleted",
    agentId: row.id,
    agentType: row.type,
    detail: {
      purged: true,
      reason: "terminal_error_purge",
      vmid: row.vmid,
      hadTunnel: Boolean(row.cf_tunnel_id || row.cf_hostname),
      error: row.error?.slice(0, 200) ?? null,
    },
  });
  log.info("purged terminal error hivra agent row", {
    source: LOG_SOURCE,
    agentId: row.id,
    vmid: row.vmid,
    proxmoxHost: row.proxmox_host,
    hadTunnel: Boolean(row.cf_tunnel_id || row.cf_hostname),
  });
  return { ...base, action: "purged", reason: row.vmid ? "VM confirmed gone, tunnel released, row retired" : "no VM allocated, tunnel released, row retired" };
}

export async function runPurgeErrorHivraAgentsSweep(
  options: PurgeErrorHivraAgentsOptions = {},
): Promise<PurgeErrorHivraAgentsSummary> {
  const summary: PurgeErrorHivraAgentsSummary = {
    scanned: 0,
    purged: 0,
    skipped: 0,
    results: [],
  };
  if (!ERROR_PURGE_PROVIDER_MUTATION_ENABLED) {
    log.warn("terminal Hivra error purge is disabled until CAS authority migration", {
      source: LOG_SOURCE,
      failureType: "hivra_error_purge_authority_disabled",
    });
    return summary;
  }
  if (!supabaseAdmin) {
    log.error("supabase admin client unavailable; cannot sweep", new Error("supabaseAdmin missing"), {
      source: LOG_SOURCE,
      failureType: "hivra_error_purge_no_db",
    });
    return summary;
  }

  const now = options.now ?? new Date();
  const cutoffIso = new Date(now.getTime() - ERROR_PURGE_THRESHOLD_MS).toISOString();

  let query = supabaseAdmin
    .from("hivra_agents")
    .select("id, user_id, type, status, vmid, proxmox_host, cf_tunnel_id, cf_hostname, error, created_at")
    .eq("status", "error")
    // The managed purge uses managed credentials, paths and storage defaults.
    // Bound BYO rows require their owner-scoped target execution context.
    .is("deployment_target_id", null)
    .lt("created_at", cutoffIso)
    .order("created_at", { ascending: true })
    .limit(MAX_CANDIDATES_PER_RUN);
  if (options.agentId) query = query.eq("id", options.agentId);

  const { data, error } = await query;
  if (error) {
    throw new Error(`error-row purge candidate query failed: ${error.message}`);
  }

  const rows = (Array.isArray(data) ? data : []) as ErrorAgentRow[];
  summary.scanned = rows.length;

  // Sequential on purpose: each vmid candidate is an SSH session (potentially
  // a stop+destroy) against a prod Proxmox host.
  for (const row of rows) {
    try {
      const result = await purgeOne(row);
      summary.results.push(result);
      if (result.action === "purged") summary.purged += 1;
      else summary.skipped += 1;
    } catch (err) {
      summary.skipped += 1;
      summary.results.push({
        agentId: row.id,
        vmid: row.vmid,
        action: "skipped",
        reason: `sweep step threw: ${err instanceof Error ? err.message : String(err)}`,
      });
      log.error("error-row purge step failed", err, {
        source: LOG_SOURCE,
        failureType: "hivra_error_purge_step_failed",
        agentId: row.id,
        vmid: row.vmid,
        proxmoxHost: row.proxmox_host,
      });
    }
  }

  if (summary.scanned > 0) {
    log.info("terminal error hivra agent purge sweep finished", {
      source: LOG_SOURCE,
      scanned: summary.scanned,
      purged: summary.purged,
      skipped: summary.skipped,
    });
  }
  return summary;
}
