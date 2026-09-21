import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { recreateMissingProxmoxInstanceById } from "@/lib/recreate-missing-proxmox-instance";

/**
 * Cron-triggered single-instance Proxmox recreate. Thin auth + map wrapper;
 * all the work (confirm-missing, provision, stale-conflict recovery, rollback)
 * lives in src/lib/recreate-missing-proxmox-instance.ts so the
 * recover-missing-vm-instances sweep can reuse it without an internal HTTP hop.
 *
 * Manual only (`?id=<uuid>`). The sweep is what runs it on a schedule.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const SOURCE = "recreate-missing-proxmox-instance";
const ROUTE = "/api/cron/recreate-missing-proxmox-instance";

function readInstanceId(req: NextRequest): string | null {
  const { searchParams } = new URL(req.url);
  return searchParams.get("id")?.trim() || null;
}

/**
 * GET is intentionally not a recreate trigger — this endpoint is manual-only
 * and destructive (it provisions a real VM). Previously a misconfigured GET
 * probe (e.g. a scheduler pointed at the wrong verb) fell through to a generic
 * 405/handler-missing response, which reads like a bug. Return a clear,
 * explicit "manual POST only" message instead. Auth-gated like POST so this
 * doesn't leak the route's existence to unauthenticated callers.
 */
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }
  return apiError(
    "recreate-missing-proxmox-instance is manual-only and destructive; call it with POST ?id=<uuid>",
    405,
    { failureType: "recreate_missing_proxmox_get_not_allowed" },
  );
}

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("CRON_SECRET missing"), {
      source: SOURCE,
      route: ROUTE,
      method: "POST",
      failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  const instanceId = readInstanceId(req);
  if (!instanceId) {
    return apiError("Missing instance id", 400, {
      failureType: "recreate_missing_proxmox_id_missing",
    });
  }

  const result = await recreateMissingProxmoxInstanceById(instanceId);

  if (result.ok) {
    return apiSuccess({
      instanceId: result.instanceId,
      status: result.status,
      proxmoxVmid: result.proxmoxVmid,
      proxmoxNode: result.proxmoxNode,
      gatewayUrl: result.gatewayUrl,
    });
  }

  const options =
    result.failureType || result.meta
      ? {
          ...(result.failureType ? { failureType: result.failureType } : {}),
          ...(result.meta ?? {}),
        }
      : undefined;
  return apiError(result.message, result.httpStatus, options);
}
