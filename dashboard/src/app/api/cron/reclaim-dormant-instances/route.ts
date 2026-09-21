import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { runDormantReclaimSweep } from "@/lib/recovery/dormant-reclaim";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";

/**
 * Cron-triggered dormant reclaim pass.
 *
 * This is intentionally inert unless HERMES_DORMANT_RECLAIM_ENABLED=true.
 * Even then it dry-runs unless HERMES_DORMANT_RECLAIM_COMMIT=true and
 * HERMES_DORMANT_ARCHIVE_DIR is configured. The destructive path archives
 * the Proxmox VM first, records the archive manifest, then releases the VM.
 */
export const dynamic = "force-dynamic";
// The commit path archives + releases one Proxmox VM per due row over SSH; a
// backlog could exceed the default function budget and silently truncate the
// sweep. Give it a real ceiling.
export const maxDuration = 800;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(
      "CRON_SECRET is not configured; refusing to run",
      new Error("CRON_SECRET missing"),
      {
        source: "dormant-reclaim",
        route: "/api/cron/reclaim-dormant-instances",
        method: "GET",
        failureType: "cron_secret_missing",
      }
    );
    return apiError("Cron secret is not configured", 500);
  }

  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  try {
    const summary = await runDormantReclaimSweep();

    // Surface per-instance reclaim failures: a commit run where archives/destroys
    // failed still returns HTTP 200, so a systemic failure (archive dir missing,
    // SSH outage) would look healthy. Emit a warn event when any candidate failed.
    // Best-effort.
    if (summary.failed > 0) {
      await reportOpsEvent({
        source: "cron.dormant_reclaim_failed",
        severity: "warn",
        title: `Dormant reclaim: ${summary.failed} of ${summary.scanned} failed`,
        message:
          `reclaim-dormant-instances (commit=${summary.commit}) scanned ${summary.scanned}, ` +
          `archived ${summary.archived}, reclaimed ${summary.reclaimed} but ${summary.failed} failed. ` +
          `Check the archive directory config + PVE host health.`,
        route: "/api/cron/reclaim-dormant-instances",
        metadata: {
          enabled: summary.enabled,
          commit: summary.commit,
          scanned: summary.scanned,
          archived: summary.archived,
          reclaimed: summary.reclaimed,
          failed: summary.failed,
        },
      });
    }

    return apiSuccess(summary);
  } catch (err) {
    log.error("dormant reclaim sweep failed", err, {
      source: "dormant-reclaim",
      route: "/api/cron/reclaim-dormant-instances",
      method: "GET",
      failureType: "dormant_reclaim_sweep_failed",
    });
    const message = err instanceof Error ? err.message : "Dormant reclaim sweep failed";
    return apiError(message, 500);
  }
}
