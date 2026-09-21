import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { runParkIdleHivraAgentsSweep } from "@/lib/hivra/park-idle-agents";

/**
 * Cron-triggered idle-park sweep for the Hivra lane. Parks never-opened
 * interactive boxes (claude-code/codex) past an age floor so abandoned signups
 * stop holding a host's RAM hostage (the fixturenodea saturation that stranded new
 * provisions). The Hermes capacity-pressure sweep does NOT cover hivra_agents.
 *
 * Reversible: a parked box is `status='stopped'`; the owner clicks Start in
 * HivraManage to wake it. Opt-in via HIVRA_IDLE_PARK_ENABLED — until that is
 * 'true' the sweep is a no-op preview (reports candidates, parks nothing).
 *
 * Schedule: daily via vercel.json. Force a preview with ?dryRun=1.
 */
export const dynamic = "force-dynamic";

// Each parked box costs an SSH `qm shutdown` against its Proxmox host; give the
// function headroom so a backlog of abandoned boxes can clear over a few runs.
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("CRON_SECRET missing"), {
      source: "park-idle-hivra-agents",
      route: "/api/cron/park-idle-hivra-agents",
      method: "GET",
      failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  try {
    const { searchParams } = new URL(req.url);
    const dryRunParam = searchParams.get("dryRun");
    const dryRun = dryRunParam === "1" || dryRunParam === "true" ? true : undefined;

    const summary = await runParkIdleHivraAgentsSweep({ dryRun });

    if (summary.parked > 0) {
      await reportOpsEvent({
        source: "cron.park_idle_hivra",
        severity: "info",
        title: `park-idle-hivra-agents: parked ${summary.parked} idle box(es)`,
        message:
          `park-idle-hivra-agents scanned ${summary.scanned} never-opened interactive box(es) and ` +
          `parked ${summary.parked} (failed ${summary.failed}). Owners can Start them to wake.`,
      });
    }

    return apiSuccess(summary);
  } catch (error) {
    log.error("park-idle-hivra-agents sweep failed", error instanceof Error ? error : new Error(String(error)), {
      source: "park-idle-hivra-agents",
      failureType: "park_sweep_failed",
    });
    return apiError("Park sweep failed", 500);
  }
}
