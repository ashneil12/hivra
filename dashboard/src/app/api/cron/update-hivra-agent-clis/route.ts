import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { runAgentCliAutoUpdateSweep } from "@/lib/hivra/agent-cli-auto-update";

/**
 * Automatic Claude Code / Codex updates for Hivra agents (every 30 minutes,
 * vercel.json). Moves idle, opted-in agents to the version Hivra has tested,
 * through the same in-place update their owners run from Manage
 * (lib/hivra/agent-cli-auto-update.ts lists every condition).
 *
 * Ships dark: HIVRA_AGENT_CLI_AUTO_UPDATE unset (or off) makes this a no-op
 * that reads nothing; preview reads agents and reports what it would update;
 * on updates. ?dryRun=1 forces a report even when on.
 */
export const dynamic = "force-dynamic";

// Reads up to 40 computers, then runs at most 5 in-place updates of up to
// 240 s each, started early enough to finish inside this limit.
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("CRON_SECRET missing"), {
      source: "update-hivra-agent-clis",
      route: "/api/cron/update-hivra-agent-clis",
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
    const dryRun = dryRunParam === "1" || dryRunParam === "true";

    const summary = await runAgentCliAutoUpdateSweep({ dryRun });

    if (summary.updated > 0 || summary.failed > 0) {
      await reportOpsEvent({
        source: "cron.update_hivra_agent_clis",
        severity: summary.failed > 0 ? "warn" : "info",
        title: `update-hivra-agent-clis: updated ${summary.updated}, failed ${summary.failed}`,
        message:
          `update-hivra-agent-clis (${summary.mode}) read ${summary.observed} of ${summary.scanned} agent(s), ` +
          `started ${summary.updated} update(s) and could not update ${summary.failed}.`,
      });
    }

    return apiSuccess(summary);
  } catch (error) {
    log.error("update-hivra-agent-clis sweep failed", error instanceof Error ? error : new Error(String(error)), {
      source: "update-hivra-agent-clis",
      failureType: "agent_cli_sweep_failed",
    });
    return apiError("Agent software update sweep failed", 500);
  }
}
