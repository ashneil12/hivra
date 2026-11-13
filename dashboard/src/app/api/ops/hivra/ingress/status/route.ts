import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { readHostIngressStatus } from "@/lib/hivra/ingress/rollback";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const SOURCE = "ops:hivra:ingress:status";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function authorized(req: NextRequest): Response | null {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing host ingress operation", new Error("CRON_SECRET missing"), { source: SOURCE });
    return apiError("CRON_SECRET is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) return apiError("Unauthorized", 401);
  return null;
}

/** Read-only: the agent's ingress row, host files and units, and edge connector count. Operator only. */
export async function GET(req: NextRequest) {
  const denied = authorized(req);
  if (denied) return denied;
  const agentId = (req.nextUrl.searchParams.get("agent_id") ?? "").trim().toLowerCase();
  if (!UUID.test(agentId)) return apiError("agent_id must be an agent UUID", 400);
  try {
    const status = await readHostIngressStatus(agentId);
    if ("error" in status) return apiError(status.error, status.httpStatus);
    return apiSuccess(status);
  } catch (error) {
    log.error("host ingress status threw", error, { source: SOURCE, agentId });
    return apiError("Host ingress status failed", 500);
  }
}
