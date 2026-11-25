import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { recordCronHeartbeat } from "@/lib/cron-heartbeat";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { runInactivitySweep } from "@/lib/recovery/inactivity-sweep";

/**
 * Cron-triggered sweeper that pauses (qm shutdown) Proxmox-backed holder-funded
 * legacy Hermes seats after confirmed inactivity. Classic Hermes has no
 * intermediate nap tier, so the graceful power-off is the lane's capacity-freeing
 * sleep action. Newly provisioned holder seats use the Hivra sleep lifecycle.
 *
 * Schedule: every minute via vercel.json. New pauses start inside a 50-second
 * budget; the candidate query is cheap when no seat is due.
 */
export const dynamic = "force-dynamic";
// SSH fan-out across the fleet (one qm shutdown per idle candidate) can exceed
// the default Vercel function budget on a busy cycle, silently truncating the
// pause batch while still reporting success. Give the sweep a real ceiling.
export const maxDuration = 300;

// Wall-clock budget handed to the sweep so it stops starting new pauses inside
// the next minute's tick. A pause already in flight can still finish; candidate
// selection is unchanged and the deferred tail is re-selected on the next tick.
const SWEEP_TIME_BUDGET_MS = 50_000;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(
      "CRON_SECRET is not configured; refusing to run",
      new Error("CRON_SECRET missing"),
      {
        source: "holder-inactivity-sweep",
        route: "/api/cron/holder-inactivity-sweep",
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
    const summary = await runInactivitySweep({ timeBudgetMs: SWEEP_TIME_BUDGET_MS, holderOnly: true });

    if (summary.timedOut) {
      log.warn("holder inactivity sweep hit time budget; remaining candidates deferred to next tick", {
        source: "holder-inactivity-sweep",
        route: "/api/cron/holder-inactivity-sweep",
        method: "GET",
        failureType: "holder_inactivity_sweep_budget_exhausted",
        scanned: summary.scanned,
        swept: summary.swept,
      });
    }

    // Surface per-instance pause failures: a run where pauses failed still
    // returns HTTP 200, so a systemic SSH/key outage would look healthy. Emit a
    // warn event when any candidate failed to pause. Best-effort.
    if (summary.failed > 0) {
      await reportOpsEvent({
        source: "cron.holder_inactivity_sweep_failed",
        severity: "warn",
        title: `Holder inactivity sweep: ${summary.failed} of ${summary.scanned} failed to pause`,
        message:
          `holder-inactivity-sweep scanned ${summary.scanned} and swept ${summary.swept} but ${summary.failed} ` +
          `candidate(s) failed to pause (vmMissing=${summary.vmMissing}). A systemic failure (SSH/key ` +
          `outage, host down) may be leaving idle agents running — check the route logs and host health.`,
        route: "/api/cron/holder-inactivity-sweep",
        metadata: {
          scanned: summary.scanned,
          swept: summary.swept,
          failed: summary.failed,
          vm_missing: summary.vmMissing,
          enabled: summary.enabled,
        },
      });
    }

    // Dead-man heartbeat: stamp on the success path (the sweep ran to completion;
    // per-instance failures are in the summary, not a route-level failure).
    // Best-effort.
    await recordCronHeartbeat("holder-inactivity-sweep");

    return apiSuccess(summary);
  } catch (err) {
    log.error("holder inactivity sweep failed", err, {
      source: "holder-inactivity-sweep",
      route: "/api/cron/holder-inactivity-sweep",
      method: "GET",
      failureType: "holder_inactivity_sweep_failed",
    });
    const message = err instanceof Error ? err.message : "Holder inactivity sweep failed";
    return apiError(message, 500);
  }
}
