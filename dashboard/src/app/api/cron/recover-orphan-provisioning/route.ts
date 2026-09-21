import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { runRecoverOrphanProvisioningSweep } from "@/lib/recovery/recover-orphan-provisioning";

/**
 * Cron-triggered sweeper that reconciles orphan `provisioning` rows whose
 * post-provision UPDATE never landed (Vercel function timeout, unique-key
 * race, etc). See src/lib/recovery/recover-orphan-provisioning.ts.
 *
 * Schedule: every 5 minutes via vercel.json.
 */
export const dynamic = "force-dynamic";

// Each candidate fans out across known Proxmox hosts via SSH; give the
// function near the Vercel cron ceiling so a backlog can clear.
export const maxDuration = 300;

function readInstanceId(req: NextRequest): string | null {
  const { searchParams } = new URL(req.url);
  return searchParams.get("id")?.trim() || null;
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(
      "CRON_SECRET is not configured; refusing to run",
      new Error("CRON_SECRET missing"),
      {
        source: "recover-orphan-provisioning",
        route: "/api/cron/recover-orphan-provisioning",
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
    const summary = await runRecoverOrphanProvisioningSweep({
      instanceId: readInstanceId(req),
    });

    // Surface per-candidate reconciliation errors: a run where some candidates
    // errored still returns HTTP 200, so a partial systemic failure (SSH/key
    // outage leaving the tail unreconciled) would look healthy. Emit a warn
    // event when any candidate errored. Best-effort.
    if (summary.errors > 0) {
      await reportOpsEvent({
        source: "cron.recover_orphan_provisioning_errors",
        severity: "warn",
        title: `recover-orphan-provisioning: ${summary.errors} of ${summary.candidates} errored`,
        message:
          `recover-orphan-provisioning reconciled ${summary.recovered} and errored on ${summary.errors} ` +
          `of ${summary.candidates} candidate(s) (notFound=${summary.notFound}). Orphan provisioning ` +
          `rows may remain unreconciled — check SSH/host health.`,
        route: "/api/cron/recover-orphan-provisioning",
        metadata: {
          candidates: summary.candidates,
          recovered: summary.recovered,
          not_found: summary.notFound,
          errors: summary.errors,
        },
      });
    }

    return apiSuccess(summary);
  } catch (err) {
    log.error("recover-orphan-provisioning sweep failed", err, {
      source: "recover-orphan-provisioning",
      route: "/api/cron/recover-orphan-provisioning",
      method: "GET",
      failureType: "recover_orphan_sweep_failed",
    });
    const message = err instanceof Error ? err.message : "Orphan recovery sweep failed";
    return apiError(message, 500);
  }
}
