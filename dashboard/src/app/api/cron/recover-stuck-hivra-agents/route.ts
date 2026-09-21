import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { runRecoverStuckHivraProvisioningSweep } from "@/lib/hivra/recover-stuck-provisioning";

/**
 * Cron-triggered sweeper for hivra_agents rows stuck in `provisioning` whose
 * status flip never landed (the flip is client-poll-driven; a closed tab
 * strands the row even though the VM + tunnel converged). See
 * src/lib/hivra/recover-stuck-provisioning.ts for the decision table.
 *
 * Schedule: every 5 minutes via vercel.json. Targeted run: ?id=<agent uuid>.
 */
export const dynamic = "force-dynamic";

// Each candidate costs an SSH probe against its Proxmox host (plus an HTTPS
// healthz probe); give the function headroom so a backlog can clear.
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(
      "CRON_SECRET is not configured; refusing to run",
      new Error("CRON_SECRET missing"),
      {
        source: "recover-stuck-hivra-agents",
        route: "/api/cron/recover-stuck-hivra-agents",
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
    const { searchParams } = new URL(req.url);
    const summary = await runRecoverStuckHivraProvisioningSweep({
      agentId: searchParams.get("id")?.trim() || null,
    });

    // Backlog observability: when stuck Hivra agents are transitioned to the
    // terminal `error` state (the sweep gave up on them), surface it so a
    // recurring provisioning failure in the Hivra lane is visible rather than
    // only living in the per-result array. The grace-window / decision-table
    // thresholds are by-design in the lib and untouched. Best-effort.
    if (summary.markedError > 0) {
      await reportOpsEvent({
        source: "cron.recover_stuck_hivra_marked_error",
        severity: "warn",
        title: `recover-stuck-hivra-agents: ${summary.markedError} agent(s) marked error`,
        message:
          `recover-stuck-hivra-agents scanned ${summary.scanned}, recovered ${summary.recovered}, and ` +
          `marked ${summary.markedError} stuck agent(s) as error after the grace window. A spike here ` +
          `signals Hivra-lane provisioning trouble — check the PVE host + tunnel for the affected agents.`,
        route: "/api/cron/recover-stuck-hivra-agents",
        metadata: {
          scanned: summary.scanned,
          recovered: summary.recovered,
          marked_error: summary.markedError,
          skipped: summary.skipped,
        },
      });
    }

    return apiSuccess(summary);
  } catch (err) {
    log.error("recover-stuck-hivra-agents sweep failed", err, {
      source: "recover-stuck-hivra-agents",
      route: "/api/cron/recover-stuck-hivra-agents",
      method: "GET",
      failureType: "hivra_stuck_sweep_failed",
    });
    const message = err instanceof Error ? err.message : "Stuck Hivra provisioning sweep failed";
    return apiError(message, 500);
  }
}
