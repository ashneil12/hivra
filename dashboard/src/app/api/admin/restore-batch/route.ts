/**
 * Admin: restore multiple cold-archived instances in parallel.
 *
 * Auth: Bearer CRON_SECRET. Single-tenant operator-only endpoint — there
 * is no per-user authorization; callers with CRON_SECRET can restore any
 * instance. Used for smoke-testing parallel restore concurrency before a
 * real user clicks "Start" on multiple cold rows simultaneously.
 *
 * Request:
 *   POST /api/admin/restore-batch
 *   { instanceIds: ["uuid", "uuid", ...] }
 *
 * Response:
 *   { ok: true, results: [{ instanceId, ok, ... }] }
 *
 * Each restore goes through orchestrateColdRestore which (1) picks a
 * destination host via the allocator, (2) calls restoreInstance which
 * holds the cold_archived → restoring CAS lock, runs restore-vm-cold.sh,
 * and atomically flips the row to active. Per-instance CAS means parallel
 * calls for the same id are mutually exclusive.
 */

import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { reportOpsEvent } from "@/lib/ops-events";
import {
  orchestrateColdRestore,
  type ColdRestoreOrchestratorResult,
} from "@/lib/services/cold-storage-restore-orchestrator";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

const LOG_SOURCE = "admin:restore-batch";

type InstanceRow = {
  id: string;
  user_id: string;
  resource_tier: string | null;
  cpu_limit: number | null;
  ram_limit: number | null;
  disk_size_gb: number | null;
  proxmox_node: string | null;
  lifecycle_state: string | null;
  gateway_url: string | null;
};

type RestoreOutcome = {
  instanceId: string;
  ok: boolean;
  reason?: string;
  message?: string;
  newVmid?: number;
  newPveHost?: string;
  newIpv4?: string;
  elapsedMs?: number;
};

async function handle(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return apiError("CRON_SECRET not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }
  if (!supabaseAdmin) {
    return apiError("Database not configured", 500);
  }

  let body: { instanceIds?: unknown };
  try {
    body = (await req.json()) as { instanceIds?: unknown };
  } catch {
    return apiError("Invalid JSON body", 400);
  }

  const instanceIds = Array.isArray(body.instanceIds) ? body.instanceIds : null;
  if (!instanceIds || instanceIds.length === 0) {
    return apiError("Body must include non-empty instanceIds array", 400);
  }
  if (instanceIds.length > 20) {
    return apiError("Refuse > 20 ids per request (concurrency safety cap)", 400);
  }
  if (!instanceIds.every((x): x is string => typeof x === "string" && x.length > 0)) {
    return apiError("instanceIds must be non-empty strings", 400);
  }

  // Fetch all rows in one query so we know each one exists + is restorable.
  const { data: rows, error: rowError } = await supabaseAdmin
    .from("hermes_instances")
    .select(
      "id, user_id, resource_tier, cpu_limit, ram_limit, disk_size_gb, proxmox_node, lifecycle_state, gateway_url"
    )
    .in("id", instanceIds);
  if (rowError) {
    log.error("row fetch failed", rowError, {
      source: LOG_SOURCE,
      failureType: "row_fetch_failed",
    });
    return apiError(`row fetch failed: ${rowError.message}`, 500);
  }

  const rowMap = new Map<string, InstanceRow>();
  for (const r of (rows ?? []) as InstanceRow[]) rowMap.set(r.id, r);

  // Pre-flight: collect any not-found / not-restorable IDs so we can
  // short-circuit them before kicking off the parallel orchestrator call.
  const preflightResults: RestoreOutcome[] = [];
  const restorable: InstanceRow[] = [];
  for (const id of instanceIds) {
    const row = rowMap.get(id);
    if (!row) {
      preflightResults.push({
        instanceId: id,
        ok: false,
        reason: "not_found",
        message: "instance not found",
      });
      continue;
    }
    // Mirror the route-level isColdLifecycleRow check: `failed` rows that
    // still carry archive metadata are restorable. cold-storage-service's
    // restoreInstance() does the same check and will refuse anything else,
    // but mirroring here lets the admin endpoint short-circuit cleanly
    // with a reason instead of going through the full CAS attempt.
    if (
      row.lifecycle_state !== "cold_archived" &&
      row.lifecycle_state !== "pending_deletion" &&
      row.lifecycle_state !== "failed"
    ) {
      preflightResults.push({
        instanceId: id,
        ok: false,
        reason: "not_restorable",
        message: `lifecycle_state=${row.lifecycle_state} (must be cold_archived, pending_deletion, or failed-with-archive)`,
      });
      continue;
    }
    restorable.push(row);
  }

  log.info("dispatching parallel restore", {
    source: LOG_SOURCE,
    requested: instanceIds.length,
    preflight_rejected: preflightResults.length,
    will_restore: restorable.length,
  });

  // Run all restorable IDs in parallel. Each orchestrateColdRestore call
  // (a) picks a destination host via the allocator, (b) holds the
  // cold_archived → restoring CAS lock, (c) runs restore-vm-cold.sh,
  // (d) flips DB to active on success. Concurrent calls touching the same
  // id are safe via CAS; concurrent calls touching different ids are the
  // whole point of this endpoint.
  const runResults = await Promise.all(
    restorable.map(async (row): Promise<RestoreOutcome> => {
      const startedAt = Date.now();
      let result: ColdRestoreOrchestratorResult;
      try {
        result = await orchestrateColdRestore(supabaseAdmin!, {
          instance: {
            id: row.id,
            user_id: row.user_id,
            resource_tier: row.resource_tier,
            cpu_limit: row.cpu_limit,
            ram_limit: row.ram_limit,
            disk_size_gb: row.disk_size_gb,
            proxmox_node: row.proxmox_node,
            gateway_host: (() => {
              try {
                return row.gateway_url ? new URL(row.gateway_url).hostname : null;
              } catch {
                return null;
              }
            })(),
          },
        });
      } catch (err) {
        return {
          instanceId: row.id,
          ok: false,
          reason: "exception",
          message: err instanceof Error ? err.message : String(err),
          elapsedMs: Date.now() - startedAt,
        };
      }

      if (result.ok) {
        return {
          instanceId: row.id,
          ok: true,
          newVmid: result.newVmid,
          newPveHost: result.newPveHost,
          newIpv4: result.newIpv4,
          elapsedMs: Date.now() - startedAt,
        };
      }
      return {
        instanceId: row.id,
        ok: false,
        reason: result.reason,
        message: result.message,
        elapsedMs: Date.now() - startedAt,
      };
    })
  );

  const allResults = [...preflightResults, ...runResults];
  const summary = {
    requested: instanceIds.length,
    restored: runResults.filter((r) => r.ok).length,
    failed: runResults.filter((r) => !r.ok).length,
    preflight_rejected: preflightResults.length,
  };

  log.info("restore-batch complete", {
    source: LOG_SOURCE,
    ...summary,
  });

  // Audit trail: this endpoint is gated by CRON_SECRET alone (no per-user
  // ownership check), so it can wake ANY tenant's VM. Emit an ops event
  // recording exactly which instances were restored / failed / rejected so the
  // privileged wake is visible on the ops feed instead of buried in app logs.
  // Best-effort — the restores already ran, so an audit hiccup must not surface
  // as a failure to the caller.
  try {
    await reportOpsEvent({
      source: "admin.restore_batch",
      severity: "warn",
      title: "Admin parallel cold-restore batch",
      message: `Operator restore-batch woke ${summary.restored}/${summary.requested} instance(s)`,
      route: "/api/admin/restore-batch",
      metadata: {
        requested: summary.requested,
        restored: summary.restored,
        failed: summary.failed,
        preflight_rejected: summary.preflight_rejected,
        requested_instance_ids: instanceIds,
        restored_instance_ids: runResults
          .filter((r) => r.ok)
          .map((r) => r.instanceId),
        failed_instance_ids: runResults
          .filter((r) => !r.ok)
          .map((r) => r.instanceId),
        rejected_instance_ids: preflightResults.map((r) => r.instanceId),
      },
    });
  } catch {
    // swallow — restores already committed; do not turn an audit failure into
    // a non-2xx for the caller.
  }

  return apiSuccess({
    ok: true,
    ...summary,
    results: allResults,
  });
}

export async function POST(req: NextRequest) {
  return handle(req);
}
