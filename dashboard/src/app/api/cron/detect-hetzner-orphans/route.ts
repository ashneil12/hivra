import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { runHetznerOrphanSweep } from "@/lib/recovery/hetzner-orphan-detection";

/**
 * Cron-triggered detect-only sweep for hermes-deploy Hetzner servers that no live
 * row points at (F090). See src/lib/recovery/hetzner-orphan-detection.ts.
 *
 * This route never deletes a server or a row. It reports each orphan to the ops
 * feed so a person can check it in the Hetzner console and remove it.
 *
 * Schedule: daily via vercel.json. A leaked server bills until someone acts, and
 * the two-hour age floor means a daily look is enough.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ROUTE = "/api/cron/detect-hetzner-orphans";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(
      "CRON_SECRET is not configured; refusing to run",
      new Error("CRON_SECRET missing"),
      {
        source: "detect-hetzner-orphans",
        route: ROUTE,
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
    const summary = await runHetznerOrphanSweep();

    if (summary.orphans.length > 0) {
      const count = summary.orphans.length;
      await reportOpsEvent({
        source: "synthetic.hetzner-orphan-server",
        severity: "warn",
        title: `Hetzner hermes-deploy servers with no live row: ${count}`,
        message:
          `detect-hetzner-orphans found ${count} hermes-deploy server(s) that no live instance or host ` +
          `row points at. Nothing was deleted. Each one bills until it is removed: check it in the ` +
          `Hetzner console and delete it by hand if it is not an intended server.`,
        route: ROUTE,
        metadata: {
          orphan_count: count,
          servers_scanned: summary.serversScanned,
          orphans: summary.orphans.map((orphan) => ({
            server_id: orphan.serverId,
            age_hours: orphan.ageHours,
            reason: orphan.reason,
            instance_id: orphan.instanceId,
          })),
        },
      });
    }

    return apiSuccess(summary);
  } catch (err) {
    log.error("hetzner orphan sweep failed", err, {
      source: "detect-hetzner-orphans",
      route: ROUTE,
      method: "GET",
      failureType: "hetzner_orphan_sweep_failed",
    });
    const message = err instanceof Error ? err.message : "Hetzner orphan sweep failed";
    return apiError(message, 500);
  }
}
