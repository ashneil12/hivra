import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { runCapacityPressureSweep } from "@/lib/recovery/capacity-pressure-sweep";

/**
 * Cron-triggered sweeper that parks (qm shutdown + lifecycle_state='paused',
 * paused_reason='capacity_pressure') the lowest-priority idle agents on
 * Proxmox hosts running at/over their tenant cap. See
 * src/lib/recovery/capacity-pressure-sweep.ts for the trigger math, candidate
 * ranking, and safety rails.
 *
 * Schedule: hourly via vercel.json. Parked rows flow into the existing
 * downstream: archive-stopped-vms cold-archives them after 48h, and users
 * one-click resume via POST /api/instances/[id] action=start.
 *
 * ?dryRun=1 forces a dry run regardless of CAPACITY_PRESSURE_DRY_RUN.
 */
export const dynamic = "force-dynamic";
// A fleet-wide park pass (qm shutdown per candidate, multiple hot hosts) can
// take real wall-time; give it a ceiling above the default so a slow sweep
// isn't truncated mid-park leaving partial state.
export const maxDuration = 800;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(
      "CRON_SECRET is not configured; refusing to run",
      new Error("CRON_SECRET missing"),
      {
        source: "capacity-pressure-sweep",
        route: "/api/cron/capacity-pressure-sweep",
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
    const dryRunParam = req.nextUrl.searchParams.get("dryRun");
    const summary = await runCapacityPressureSweep(
      dryRunParam === "1" || dryRunParam === "true" ? { dryRun: true } : {}
    );

    // Destructive audit + failure visibility: this sweep pauses real customer
    // VMs. Surface a real (non-dry-run) park pass and any park failures on the
    // ops feed so an over-aggressive sweep — or a stalled one on a genuinely
    // over-capacity fleet — is visible (the cron is not in CRON_REGISTRY, so the
    // dead-man watchdog won't catch its silence). The trigger math + safety
    // rails are by-design in the lib and untouched. Best-effort.
    if ((!summary.dryRun && summary.parked > 0) || summary.failed > 0) {
      await reportOpsEvent({
        source: "cron.capacity_pressure_parked",
        severity: "warn",
        title: `capacity-pressure-sweep parked ${summary.parked} VM(s), ${summary.failed} failed`,
        message:
          `capacity-pressure-sweep (dryRun=${summary.dryRun}) scanned ${summary.hostsScanned} host(s), ` +
          `found ${summary.hotHosts} over-capacity, and parked ${summary.parked} idle agent(s) ` +
          `(failed=${summary.failed}, vmMissing=${summary.vmMissing}). Parked rows cold-archive after 48h; ` +
          `users one-click resume. If this is parking too aggressively, set CAPACITY_PRESSURE_DRY_RUN.`,
        route: "/api/cron/capacity-pressure-sweep",
        metadata: {
          dry_run: summary.dryRun,
          hosts_scanned: summary.hostsScanned,
          hot_hosts: summary.hotHosts,
          parked: summary.parked,
          failed: summary.failed,
          vm_missing: summary.vmMissing,
        },
      });
    }

    return apiSuccess(summary);
  } catch (err) {
    log.error("capacity pressure sweep failed", err, {
      source: "capacity-pressure-sweep",
      route: "/api/cron/capacity-pressure-sweep",
      method: "GET",
      failureType: "capacity_pressure_sweep_failed",
    });
    const message =
      err instanceof Error ? err.message : "Capacity pressure sweep failed";
    return apiError(message, 500);
  }
}
