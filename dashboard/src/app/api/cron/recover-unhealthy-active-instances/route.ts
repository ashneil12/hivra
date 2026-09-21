import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { recordCronHeartbeat } from "@/lib/cron-heartbeat";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { runRecoverUnhealthyActiveInstancesSweep } from "@/lib/recovery/recover-unhealthy-active-instances";

/**
 * Cron-triggered sweeper that redeploys WebUI instances which are still
 * flagged active/running in the DB but whose gateway has been unhealthy
 * for hours. See src/lib/recovery/recover-unhealthy-active-instances.ts for the
 * why and the rate-limit semantics.
 *
 * Schedule: every 15 minutes via vercel.json.
 */
export const dynamic = "force-dynamic";

// Each repair calls applyLiveUpdate, which holds an SSH session for
// 30-90s. With MAX_REPAIRS_PER_RUN=5 the worst-case run is ~7-8 min
// (5 repairs x up to 90s + slow ghcr pulls). The previous 300s (5min)
// budget SIGTERM'd a worst-case run mid-redeploy, leaving a half-applied
// compose update on a customer VM. Raise the ceiling above the real
// worst-case so a redeploy completes; the lib's MAX_REPAIRS_PER_RUN cap is
// the actual throttle, not this wall.
export const maxDuration = 800;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(
      "CRON_SECRET is not configured; refusing to run",
      new Error("CRON_SECRET missing"),
      {
        source: "recover-unhealthy-active-instances",
        route: "/api/cron/recover-unhealthy-active-instances",
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
    const summary = await runRecoverUnhealthyActiveInstancesSweep();

    // Surface redeploy failures: a run where repairs failed still returns 200,
    // so a systemic redeploy outage (ghcr down, SSH/key churn) would look
    // healthy. Emit a warn event when any repair failed/errored. Best-effort.
    if (summary.redeployFailed > 0 || summary.errors > 0) {
      await reportOpsEvent({
        source: "cron.recover_unhealthy_active_failed",
        severity: "warn",
        title: `recover-unhealthy-active: ${summary.redeployFailed + summary.errors} repair(s) failed`,
        message:
          `recover-unhealthy-active-instances attempted ${summary.redeployAttempted} repair(s) of ` +
          `${summary.candidates} candidate(s); redeployFailed=${summary.redeployFailed} errors=${summary.errors} ` +
          `exhausted=${summary.exhausted}. Unhealthy customer gateways may not be recovering — check ghcr.io ` +
          `+ SSH host health.`,
        route: "/api/cron/recover-unhealthy-active-instances",
        metadata: {
          candidates: summary.candidates,
          redeploy_attempted: summary.redeployAttempted,
          redeploy_failed: summary.redeployFailed,
          errors: summary.errors,
          exhausted: summary.exhausted,
        },
      });
    }

    // Dead-man heartbeat: recover-unhealthy-active-instances is registered in
    // CRON_REGISTRY but previously never stamped one, so the watchdog gave it
    // false coverage. Stamp on the success path (per-instance failures are in
    // the summary, not a route-level failure). Best-effort.
    await recordCronHeartbeat("recover-unhealthy-active-instances");

    return apiSuccess(summary);
  } catch (err) {
    log.error("recover-unhealthy-active sweep failed", err, {
      source: "recover-unhealthy-active-instances",
      route: "/api/cron/recover-unhealthy-active-instances",
      method: "GET",
      failureType: "recover_unhealthy_sweep_failed",
    });
    const message = err instanceof Error ? err.message : "Recovery sweep failed";
    return apiError(message, 500);
  }
}
