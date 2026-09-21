import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import {
  runRecoverStuckInstancesSweep,
  runRecoverStuckRestoringSweep,
} from "@/lib/recovery/recover-stuck-instances";
import { runColdRestoreOrphanAdoptionSweep } from "@/lib/recovery/cold-restore-orphan-adoption";

/**
 * Cron-triggered sweeper that promotes stuck provisioning/failed rows
 * back to running once their gateway answers /health, plus a second pass
 * that finalizes cold-restore rows stranded in lifecycle_state='restoring'
 * (function killed mid-restore, or restore-vm-cold.sh reported
 * health_pending), plus a third pass that adopts orphaned cold-restores: rows
 * stranded at lifecycle_substate='restoring_starting' with a null vmid whose
 * `restore-vm-cold.sh` outlived the function — it finds the live hermes-<id>
 * clone(s) on the fleet, adopts the healthy one (routes + promotes), reaps the
 * duplicates, or resets the row to cold_archived when no clone exists. See
 * src/lib/recovery/cold-restore-orphan-adoption.ts for the why.
 *
 * Schedule: every 2 minutes via vercel.json.
 */
export const dynamic = "force-dynamic";
// Both passes probe gateways over the network; a slow/unreachable batch could
// approach the default function budget. Give it a real ceiling.
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(
      "CRON_SECRET is not configured; refusing to run",
      new Error("CRON_SECRET missing"),
      {
        source: "recover-stuck-instances",
        route: "/api/cron/recover-stuck-instances",
        method: "GET",
        failureType: "cron_secret_missing",
      },
    );
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  try {
    // Run independently so a failure in one pass never starves the other.
    const [stuck, restoring, orphanAdoption] = await Promise.allSettled([
      runRecoverStuckInstancesSweep(),
      runRecoverStuckRestoringSweep(),
      runColdRestoreOrphanAdoptionSweep(),
    ]);

    if (stuck.status === "rejected") {
      throw stuck.reason instanceof Error
        ? stuck.reason
        : new Error(String(stuck.reason));
    }

    if (restoring.status === "rejected") {
      // The restoring pass is the newer, lower-traffic backstop; log and
      // continue rather than failing the whole cron (which would also lose
      // the successful provisioning/failed recovery above).
      log.error("recover-stuck-restoring sweep failed", restoring.reason, {
        source: "recover-stuck-instances",
        route: "/api/cron/recover-stuck-instances",
        method: "GET",
        failureType: "recover_restoring_sweep_failed",
      });
      // The restoring pass error is intentionally swallowed to a logged
      // {error:true} 200 so it never starves the provisioning recovery above.
      // But a persistently-broken restore-finalization pass would then go
      // unnoticed at the HTTP level (cold-restored tenants stranded in
      // 'restoring'). Surface it on the ops feed so it can be paged on.
      // Best-effort; fingerprint-deduped so a long-broken pass pages once.
      await reportOpsEvent({
        source: "cron.recover_stuck_restoring_failed",
        severity: "warn",
        title: "recover-stuck-instances: restoring-finalization pass failed",
        message:
          "The cold-restore finalization pass (runRecoverStuckRestoringSweep) threw. " +
          "Instances stranded in lifecycle_state='restoring' will not be finalized until " +
          "this recovers — check the route logs and restore-vm-cold path.",
        route: "/api/cron/recover-stuck-instances",
        metadata: {
          failureType: "recover_restoring_sweep_failed",
          errorMessage:
            restoring.reason instanceof Error
              ? restoring.reason.message
              : String(restoring.reason),
        },
      });
    }

    if (orphanAdoption.status === "rejected") {
      // Newest backstop: same treatment as the restoring pass — log + page on
      // the ops feed, but never fail the whole cron over it.
      log.error(
        "cold-restore orphan-adoption sweep failed",
        orphanAdoption.reason,
        {
          source: "recover-stuck-instances",
          route: "/api/cron/recover-stuck-instances",
          method: "GET",
          failureType: "cold_restore_orphan_adoption_sweep_failed",
        },
      );
      await reportOpsEvent({
        source: "cron.cold_restore_orphan_adoption_failed",
        severity: "warn",
        title: "recover-stuck-instances: cold-restore orphan-adoption pass failed",
        message:
          "The cold-restore orphan-adoption pass (runColdRestoreOrphanAdoptionSweep) threw. " +
          "Restores stranded at restoring_starting (function died mid-restore) will not self-heal " +
          "until this recovers — check the route logs and the fleet host-discovery path.",
        route: "/api/cron/recover-stuck-instances",
        metadata: {
          failureType: "cold_restore_orphan_adoption_sweep_failed",
          errorMessage:
            orphanAdoption.reason instanceof Error
              ? orphanAdoption.reason.message
              : String(orphanAdoption.reason),
        },
      });
    }

    return apiSuccess({
      ...stuck.value,
      restoring:
        restoring.status === "fulfilled"
          ? restoring.value
          : { error: true },
      orphanAdoption:
        orphanAdoption.status === "fulfilled"
          ? orphanAdoption.value
          : { error: true },
    });
  } catch (err) {
    log.error("recover-stuck-instances sweep failed", err, {
      source: "recover-stuck-instances",
      route: "/api/cron/recover-stuck-instances",
      method: "GET",
      failureType: "recover_sweep_failed",
    });
    const message = err instanceof Error ? err.message : "Recovery sweep failed";
    return apiError(message, 500);
  }
}
