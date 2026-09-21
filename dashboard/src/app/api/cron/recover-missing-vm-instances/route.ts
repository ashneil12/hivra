import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { runRecoverMissingVmInstancesSweep } from "@/lib/recovery/recover-missing-vm-instances";

/**
 * Cron-triggered safety net for entitled instances whose VM was rolled back /
 * released and never recreated. See src/lib/recovery/recover-missing-vm-instances.ts.
 *
 * Drives the shared recreate (a real VM clone) so it auto-spends — guardrails
 * live in the sweep (entitlement gate, per-row attempt cap + cooldown, per-run
 * cap, ops alert on give-up).
 *
 * Schedule: every 10 minutes via vercel.json.
 */
export const dynamic = "force-dynamic";

// Each candidate runs provision Phase 1 synchronously; give the function room
// up to the Vercel cron ceiling so a small backlog can clear.
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(
      "CRON_SECRET is not configured; refusing to run",
      new Error("CRON_SECRET missing"),
      {
        source: "recover-missing-vm-instances",
        route: "/api/cron/recover-missing-vm-instances",
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
    const summary = await runRecoverMissingVmInstancesSweep();

    // Money path: this cron auto-spends (a real VM clone) every 10 min. The
    // destructive guardrails (entitlement gate, attempt cap, cooldown, per-run
    // cap) live in the sweep and are NOT touched here. But the route previously
    // emitted no route-level ops-event, so a partial-failure / give-up run
    // returned a clean 200. Surface a warn event when any candidate failed,
    // errored, or exhausted its attempt budget so a recurring recreate failure
    // (or a lib gate regression causing churn) is visible. Best-effort.
    if (summary.failed > 0 || summary.errors > 0 || summary.skippedExhausted > 0) {
      await reportOpsEvent({
        source: "cron.recover_missing_vm_failed",
        severity: "warn",
        title: `recover-missing-vm: ${summary.failed + summary.errors} failed, ${summary.skippedExhausted} exhausted`,
        message:
          `recover-missing-vm-instances recreated ${summary.recreated} of ${summary.candidates} candidate(s); ` +
          `failed=${summary.failed} errors=${summary.errors} skippedExhausted=${summary.skippedExhausted} ` +
          `skippedCooldown=${summary.skippedCooldown}. Entitled tenants may be missing their VM — check the ` +
          `per-row attempt caps and provision Phase 1 health.`,
        route: "/api/cron/recover-missing-vm-instances",
        metadata: {
          candidates: summary.candidates,
          recreated: summary.recreated,
          failed: summary.failed,
          errors: summary.errors,
          skipped_cooldown: summary.skippedCooldown,
          skipped_exhausted: summary.skippedExhausted,
        },
      });
    }

    return apiSuccess(summary);
  } catch (err) {
    log.error("recover-missing-vm-instances sweep failed", err, {
      source: "recover-missing-vm-instances",
      route: "/api/cron/recover-missing-vm-instances",
      method: "GET",
      failureType: "recover_missing_vm_sweep_failed",
    });
    const message = err instanceof Error ? err.message : "Recover missing-VM sweep failed";
    return apiError(message, 500);
  }
}
