import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { recordCronHeartbeat } from "@/lib/cron-heartbeat";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { runInactivitySweep } from "@/lib/recovery/inactivity-sweep";

/**
 * Cron-triggered sweeper that pauses (qm shutdown) Proxmox-backed
 * agents that have gone untouched past their per-tier idle window.
 * See src/lib/recovery/inactivity-sweep.ts for the why and the thresholds.
 *
 * Schedule: hourly via vercel.json. The 4d/7d windows make this
 * effectively idempotent — the same row will only be returned by
 * the candidate query once per cycle.
 */
export const dynamic = "force-dynamic";
// SSH fan-out across the fleet (one qm shutdown per idle candidate) can exceed
// the default Vercel function budget on a busy cycle, silently truncating the
// pause batch while still reporting success. Give the sweep a real ceiling.
export const maxDuration = 800;

// Wall-clock budget handed to the sweep so it stops starting new pauses a safe
// margin under maxDuration (800s) and returns cleanly instead of being
// SIGKILLed mid-pause (which can leave a VM half-shut-down + the DB row not yet
// flipped — exactly the paused-but-running drift the fleet-status-reconcile
// cron exists to mop up). 100s of headroom covers the in-flight graceful
// qm shutdown after the last budget check. Candidate SELECTION is unchanged;
// the deferred tail is re-selected next hourly tick.
const SWEEP_TIME_BUDGET_MS = 700_000;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(
      "CRON_SECRET is not configured; refusing to run",
      new Error("CRON_SECRET missing"),
      {
        source: "inactivity-sweep",
        route: "/api/cron/inactivity-sweep",
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
    const summary = await runInactivitySweep({ timeBudgetMs: SWEEP_TIME_BUDGET_MS });

    if (summary.timedOut) {
      log.warn("inactivity sweep hit time budget; remaining candidates deferred to next tick", {
        source: "inactivity-sweep",
        route: "/api/cron/inactivity-sweep",
        method: "GET",
        failureType: "inactivity_sweep_budget_exhausted",
        scanned: summary.scanned,
        swept: summary.swept,
      });
    }

    // Surface per-instance pause failures: a run where pauses failed still
    // returns HTTP 200, so a systemic SSH/key outage would look healthy. Emit a
    // warn event when any candidate failed to pause. Best-effort.
    if (summary.failed > 0) {
      await reportOpsEvent({
        source: "cron.inactivity_sweep_failed",
        severity: "warn",
        title: `Inactivity sweep: ${summary.failed} of ${summary.scanned} failed to pause`,
        message:
          `inactivity-sweep scanned ${summary.scanned} and swept ${summary.swept} but ${summary.failed} ` +
          `candidate(s) failed to pause (vmMissing=${summary.vmMissing}). A systemic failure (SSH/key ` +
          `outage, host down) may be leaving idle agents running — check the route logs and host health.`,
        route: "/api/cron/inactivity-sweep",
        metadata: {
          scanned: summary.scanned,
          swept: summary.swept,
          failed: summary.failed,
          vm_missing: summary.vmMissing,
          enabled: summary.enabled,
        },
      });
    }

    // Dead-man heartbeat: inactivity-sweep is registered in CRON_REGISTRY but
    // previously never stamped one, so the watchdog gave it false coverage.
    // Stamp on the success path (the sweep ran to completion; per-instance
    // failures are in the summary, not a route-level failure). Best-effort.
    await recordCronHeartbeat("inactivity-sweep");

    return apiSuccess(summary);
  } catch (err) {
    log.error("inactivity sweep failed", err, {
      source: "inactivity-sweep",
      route: "/api/cron/inactivity-sweep",
      method: "GET",
      failureType: "inactivity_sweep_failed",
    });
    const message = err instanceof Error ? err.message : "Inactivity sweep failed";
    return apiError(message, 500);
  }
}
