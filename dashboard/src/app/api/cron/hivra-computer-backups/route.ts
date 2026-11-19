import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { runComputerBackupSweep, startComputerRestore } from "@/lib/hivra/computer-backups/sweep";

/**
 * Off-host backups of Hivra computers. See src/lib/hivra/computer-backups/sweep.ts.
 *
 * GET (cron, every ten minutes): polls running jobs, purges deleted computers'
 * copies, starts the next backup or drill on each idle host. Does nothing
 * unless HIVRA_COMPUTER_BACKUPS is `dry` or `on`.
 *
 * POST ?action=restore&agentId=&backupId=&confirm=overwrite (operator only,
 * same bearer): writes one backup over the stopped computer's disks.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ROUTE = "/api/cron/hivra-computer-backups";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function authorized(req: NextRequest): Response | null {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("CRON_SECRET missing"), {
      source: "hivra-computer-backups", route: ROUTE, method: req.method, failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) return apiError("Unauthorized", 401);
  return null;
}

export async function GET(req: NextRequest) {
  const refused = authorized(req);
  if (refused) return refused;
  try {
    return apiSuccess(await runComputerBackupSweep());
  } catch (error) {
    log.error("hivra-computer-backups sweep failed", error instanceof Error ? error : new Error(String(error)), {
      source: "hivra-computer-backups", route: ROUTE, method: "GET", failureType: "hivra_computer_backups_failed",
    });
    return apiError("Computer backups failed", 500);
  }
}

export async function POST(req: NextRequest) {
  const refused = authorized(req);
  if (refused) return refused;
  const params = req.nextUrl.searchParams;
  if (params.get("action") !== "restore") return apiError("Unknown action", 400);
  const agentId = params.get("agentId") ?? "";
  const backupId = params.get("backupId") ?? "";
  if (!UUID.test(agentId) || !UUID.test(backupId)) return apiError("agentId and backupId are required", 400);
  if (params.get("confirm") !== "overwrite") return apiError("A restore overwrites the computer's disks: pass confirm=overwrite", 400);
  const result = await startComputerRestore({ agentId: agentId.toLowerCase(), backupId: backupId.toLowerCase() });
  if (!result.ok) return apiError(`Restore not started: ${result.reason}`, 409);
  return apiSuccess(result);
}
