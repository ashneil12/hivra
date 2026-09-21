import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { managedHivraProvisionerChannelForServerEnvironment } from "@/lib/hivra/managed-provisioner-channel";
import { log } from "@/lib/logger";
import {
  diagnoseRemoteDesktopGuestTransport,
  installRemoteDesktopOnHivraAgent,
  verifyRemoteDesktopRestartOnHivraAgent,
} from "@/lib/remote-computers/guest-installation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const SOURCE = "ops:hivra:remote-desktop-guest";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function controlOrigin(): string | null {
  const raw = process.env.NEXT_PUBLIC_APP_URL ?? "";
  try {
    const value = new URL(raw);
    return value.protocol === "https:" && value.origin === raw ? value.origin : null;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return apiError("CRON_SECRET is not configured", 500);
  if (!verifyBearerHeader(request, cronSecret)) return apiError("Unauthorized", 401);

  let body: { action?: unknown; agentId?: unknown };
  try { body = await request.json() as typeof body; }
  catch { return apiError("Invalid JSON body", 400); }
  const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
  const action = body.action === "install" || body.action === "restart" || body.action === "diagnose" ? body.action : null;
  if (!UUID_RE.test(agentId)) return apiError("agentId must be an explicit UUID", 400);
  if (!action) return apiError("action must be install, restart, or diagnose", 400);
  const origin = controlOrigin();
  if (!origin) return apiError("Remote desktop control origin is not configured", 500);

  // Keep operator installation under the same temporary Canary containment as
  // owner Prepare; diagnostics and the existing restart action are unchanged.
  let protectedCanary: boolean;
  try {
    protectedCanary = managedHivraProvisionerChannelForServerEnvironment(process.env) === "canary";
  } catch {
    return apiError("Remote desktop deployment configuration is unavailable", 503);
  }
  if (action === "install" && protectedCanary) {
    return apiError("Desktop preparation is temporarily paused on Canary while isolated delivery is completed. This request has not changed the computer.", 409);
  }

  try {
    const result = action === "install"
      ? await installRemoteDesktopOnHivraAgent(agentId, origin, {}, {
          controlBypassSecret: protectedCanary
            ? process.env.VERCEL_AUTOMATION_BYPASS_SECRET
            : undefined,
          controlBypassRequired: protectedCanary,
        })
      : action === "restart"
        ? await verifyRemoteDesktopRestartOnHivraAgent(agentId)
        : await diagnoseRemoteDesktopGuestTransport(agentId);
    log.info("remote desktop guest operation complete", {
      source: SOURCE,
      action,
      agentId,
      targetId: result.targetId,
      vmid: result.vmid,
      ok: result.ok,
    });
    if (!result.ok) {
      return apiError(
        result.error ?? "Remote desktop guest operation failed.",
        503,
        result,
        { data: result },
        { source: SOURCE, failureType: "remote_desktop_guest_operation_failed", logLevel: "warn" },
      );
    }
    return apiSuccess(result);
  } catch (error) {
    log.error("remote desktop guest operation failed", error, { source: SOURCE, action, agentId });
    return apiError("Remote desktop guest operation failed.", 500);
  }
}
