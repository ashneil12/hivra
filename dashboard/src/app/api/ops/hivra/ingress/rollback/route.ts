import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { rollbackHostIngress } from "@/lib/hivra/ingress/rollback";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const SOURCE = "ops:hivra:ingress:rollback";
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

/** Hand one agent's public connector back to its computer. Operator only; needs no flag, because it is the way back. */
export async function POST(req: NextRequest) {
  const denied = authorized(req);
  if (denied) return denied;
  let body: { agent_id?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return apiError("Invalid JSON body", 400);
  }
  const agentId = typeof body.agent_id === "string" ? body.agent_id.trim().toLowerCase() : "";
  if (!UUID.test(agentId)) return apiError("agent_id must be an agent UUID", 400);
  try {
    const result = await rollbackHostIngress(agentId);
    if (!result.ok) return apiError(result.reason ?? "Host ingress rollback failed", result.httpStatus ?? 503, result);
    return apiSuccess(result);
  } catch (error) {
    log.error("host ingress rollback threw", error, { source: SOURCE, agentId });
    return apiError("Host ingress rollback failed", 500);
  }
}
