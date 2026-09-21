import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { runPurgeErrorHivraAgentsSweep } from "@/lib/hivra/purge-error-agents";

/**
 * Cron-triggered purge for hivra_agents rows in terminal `status='error'`.
 * Error rows are invisible to users (the agents list hides them) and no other
 * cron transitions them; this sweep destroys any leftover VM, releases any
 * leftover Cloudflare tunnel, and retires the row to `deleted`. See
 * src/lib/hivra/purge-error-agents.ts for the decision table + grace window.
 *
 * Schedule: daily via vercel.json. Targeted run: ?id=<agent uuid>.
 */
export const dynamic = "force-dynamic";

// Each vmid-bearing candidate costs an SSH session that may include a VM
// stop (--timeout 30) + destroy; give a backlog room to clear.
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(
      "CRON_SECRET is not configured; refusing to run",
      new Error("CRON_SECRET missing"),
      {
        source: "purge-error-hivra-agents",
        route: "/api/cron/purge-error-hivra-agents",
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
    const summary = await runPurgeErrorHivraAgentsSweep({
      agentId: searchParams.get("id")?.trim() || null,
    });

    // Destructive audit trail: this sweep destroys VMs + releases Cloudflare
    // tunnels for Hivra-lane error rows. Mirror purge-expired's
    // `instance.purge_destroyed` so support can answer "when was this Hivra
    // agent actually destroyed?" without grepping logs. Best-effort. The
    // grace-window / "don't destroy a paying agent" guards are by-design in the
    // lib and untouched.
    if (summary.purged > 0) {
      await reportOpsEvent({
        source: "hivra.agent_error_purged",
        severity: "warn",
        title: `Purged ${summary.purged} terminal-error Hivra agent(s)`,
        message:
          `purge-error-hivra-agents destroyed ${summary.purged} of ${summary.scanned} scanned ` +
          `error-state agent(s) (skipped=${summary.skipped}), releasing any VM + Cloudflare tunnel ` +
          `and retiring the row to deleted.`,
        route: "/api/cron/purge-error-hivra-agents",
        metadata: {
          scanned: summary.scanned,
          purged: summary.purged,
          skipped: summary.skipped,
          purged_agents: summary.results
            .filter((r) => r.action === "purged")
            .map((r) => ({ agent_id: r.agentId, vmid: r.vmid, reason: r.reason })),
        },
      });
    }

    return apiSuccess(summary);
  } catch (err) {
    log.error("purge-error-hivra-agents sweep failed", err, {
      source: "purge-error-hivra-agents",
      route: "/api/cron/purge-error-hivra-agents",
      method: "GET",
      failureType: "hivra_error_purge_sweep_failed",
    });
    const message = err instanceof Error ? err.message : "Terminal error Hivra agent purge failed";
    return apiError(message, 500);
  }
}
