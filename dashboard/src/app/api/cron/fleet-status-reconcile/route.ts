import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { recordCronHeartbeat } from "@/lib/cron-heartbeat";
import { runFleetStatusReconcile } from "@/lib/recovery/fleet-status-reconcile";
import { log } from "@/lib/logger";

/**
 * Cron-triggered fleet status reconciler. See src/lib/recovery/fleet-status-reconcile.ts
 * for the full why.
 *
 * The inactivity-sweep pauses idle free-tier agents (qm shutdown + row marked
 * stopped/inactivity), but every VM is created onboot:1, so a Proxmox HOST
 * reboot auto-starts the paused VMs and nothing flips the DB back — leaving
 * "paused-but-running" rows the placement scheduler can't see (hidden
 * overcommit). This sweep SSHes each active host, lists running VMs, and for any
 * parked row whose VM is in fact running, corrects the DB row back to
 * running/active.
 *
 * SAFE BY CONSTRUCTION: only upgrades stopped→running for qm-CONFIRMED-running
 * VMs (never the inverse), touches no billing/subscription/VM-power state, is
 * batch-limited, and is DEFAULT DRY-RUN — it writes nothing unless
 * FLEET_STATUS_RECONCILE_LIVE=true. In dry-run it logs every intended change and
 * returns them in the summary.
 *
 * Schedule: every 30 min via vercel.json. The drift only appears on host
 * reboots, so a tight cadence buys nothing; 30 min closes the window fast
 * enough while keeping SSH-per-host budget modest.
 */
export const dynamic = "force-dynamic";
// SSH fan-out across the fleet (one qm list per active host) plus the batch of
// status writes can run long on a busy cycle. Give it a real ceiling so a
// truncated run never silently reports success.
export const maxDuration = 800;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(
      "CRON_SECRET is not configured; refusing to run",
      new Error("CRON_SECRET missing"),
      {
        source: "fleet-status-reconcile",
        route: "/api/cron/fleet-status-reconcile",
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
    const summary = await runFleetStatusReconcile();

    // Dead-man heartbeat: stamp on the success path (the sweep ran to
    // completion; per-host skips/errors are in the summary, not a route-level
    // failure). Best-effort — a heartbeat write must never fail the cron.
    await recordCronHeartbeat("fleet-status-reconcile");

    return apiSuccess(summary);
  } catch (err) {
    log.error("fleet status reconcile failed", err, {
      source: "fleet-status-reconcile",
      route: "/api/cron/fleet-status-reconcile",
      method: "GET",
      failureType: "fleet_status_reconcile_failed",
    });
    const message =
      err instanceof Error ? err.message : "Fleet status reconcile failed";
    return apiError(message, 500);
  }
}
