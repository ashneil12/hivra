import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { inspectRemoteDesktopCapability } from "@/lib/remote-computers/capability-inspection";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const SOURCE = "ops:hivra:remote-desktop-capability";

export async function POST(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return apiError("CRON_SECRET is not configured", 500);
  if (!verifyBearerHeader(request, cronSecret)) return apiError("Unauthorized", 401);
  let body: { agentId?: unknown };
  try { body = await request.json() as { agentId?: unknown }; }
  catch { return apiError("Invalid JSON body", 400); }
  const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
  if (!UUID_RE.test(agentId)) return apiError("agentId must be an explicit UUID", 400);
  try {
    const result = await inspectRemoteDesktopCapability(agentId);
    log.info("remote desktop capability inspection complete", {
      source: SOURCE,
      agentId,
      targetId: result.targetId,
      vmid: result.vmid,
      ok: result.ok,
      observedRevision: result.receipt?.observedRevision ?? null,
    });
    if (!result.ok) return apiError(result.error ?? "Remote desktop capability inspection failed", 503);
    return apiSuccess(result);
  } catch (error) {
    log.error("remote desktop capability inspection failed", error, { source: SOURCE, agentId });
    return apiError("Remote desktop capability inspection failed", 500);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
