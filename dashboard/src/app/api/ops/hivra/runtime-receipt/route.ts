import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { inspectHivraRuntimeReceipt } from "@/lib/hivra/runtime-receipt-inspection";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const SOURCE = "ops:hivra:runtime-receipt";

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing runtime receipt inspection", new Error("CRON_SECRET missing"), {
      source: SOURCE,
    });
    return apiError("CRON_SECRET is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) return apiError("Unauthorized", 401);

  let body: { agentId?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return apiError("Invalid JSON body", 400);
  }
  const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(agentId)) {
    return apiError("agentId must be an explicit UUID", 400);
  }

  try {
    const result = await inspectHivraRuntimeReceipt(agentId);
    log.info("runtime receipt inspection complete", {
      source: SOURCE,
      agentId,
      targetId: result.targetId,
      vmid: result.vmid,
      ok: result.ok,
      provisionerVersion: result.summary?.provisionerVersion ?? null,
      receiptSha256: result.summary?.receiptSha256 ?? null,
    });
    if (!result.ok) return apiError(result.error ?? "Runtime receipt inspection failed", 503);
    return apiSuccess(result);
  } catch (error) {
    log.error("runtime receipt inspection failed", error, { source: SOURCE, agentId });
    return apiError("Runtime receipt inspection failed", 500);
  }
}
