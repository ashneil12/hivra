import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { fetchFirstReachableGatewayResponse } from "@/lib/agent-gateway";
import {
  enforceAuthenticatedRouteRateLimit,
  RATE_LIMIT_PRESETS,
} from "@/lib/authenticated-rate-limit";
import { deriveWebUIBaseUrl } from "@/lib/instance-backend";
import { log } from "@/lib/logger";
import { getSecureUserInstance } from "@/lib/services/instance-security";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// GET /api/instances/[id]/mobile-chat-credentials
//
// Mobile (iOS) WS-lane credential handoff — HIVRA_IOS_APP_PLAN.md Phase 2.
// Live pre-flight V3 confirmed a native client can connect
// `wss://<box-host>/api/ws?token=<apiServerKey>` directly (no cookies, no
// ticket): the token is the instance's apiServerKey — exactly the credential
// the browser SPA already holds client-side after the webui-login handoff, so
// this endpoint widens no trust boundary. It mirrors webui-login-url's
// ownership + readiness gating (202 + Retry-After while warming) and returns
// the connection material instead of a browser handoff URL.
const ROUTE = "/api/instances/[id]/mobile-chat-credentials";
const PENDING_RETRY_AFTER_MS = 4000;
const PENDING_STATUSES = new Set(["provisioning", "redeploying"]);
const CHAT_LANE_PROBE_TIMEOUT_MS = 3500;
// Webfree chat readiness is the CHAT lane, not /health: probe /api/sessions
// with the bearer (canary #518 / prod #548). This validates the exact
// credential + surface the mobile client is about to use.
const CHAT_SESSIONS_PATH = "/api/sessions";
const CHAT_WS_PATH = "/api/ws";

type InstanceReadinessRow = {
  status: string | null;
};

async function getOwnedInstanceReadiness(
  id: string,
  userId: string,
): Promise<{ ok: true; status: string | null } | { ok: false; error: string }> {
  if (!supabaseAdmin) {
    throw new Error("Database not configured");
  }

  const { data, error } = await supabaseAdmin
    .from("hermes_instances")
    .select("status")
    .eq("id", id)
    .eq("user_id", userId)
    .neq("status", "deleted")
    .single<InstanceReadinessRow>();

  if (error || !data) {
    return { ok: false, error: "Instance not found or unauthorized" };
  }

  return { ok: true, status: data.status ?? null };
}

function resolveErrorStatus(error: string | null): number {
  if (!error) return 500;
  if (error.includes("not found") || error.includes("unauthorized")) return 404;
  if (error.includes("not currently running") || error.includes("Gateway URL not configured")) return 400;
  return 500;
}

function pendingResponse(reason: string, instanceStatus: string | null) {
  return NextResponse.json(
    {
      kind: "pending",
      reason,
      instanceStatus,
      retryAfterMs: PENDING_RETRY_AFTER_MS,
      message:
        "Your agent is still getting ready. Retry shortly and the chat lane will be available.",
    },
    {
      status: 202,
      headers: {
        "Retry-After": String(Math.ceil(PENDING_RETRY_AFTER_MS / 1000)),
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    },
  );
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rateLimited = enforceAuthenticatedRouteRateLimit(request, {
    routeKey: "instances_mobile_chat_credentials_get",
    userId,
    ...RATE_LIMIT_PRESETS.secretWrite,
  });
  if (rateLimited) return rateLimited;

  const { id } = await params;
  const readiness = await getOwnedInstanceReadiness(id, userId);
  if (!readiness.ok) {
    return NextResponse.json({ error: readiness.error }, { status: 404 });
  }

  if (PENDING_STATUSES.has(readiness.status ?? "")) {
    log.info("mobile chat credentials pending while instance is not ready", {
      source: "mobile-chat-credentials",
      route: ROUTE,
      method: "GET",
      instanceId: id,
      userId,
      failureType: "mobile_chat_credentials_instance_not_ready",
      instanceStatus: readiness.status,
      retryAfterMs: PENDING_RETRY_AFTER_MS,
    });

    return pendingResponse("instance_not_ready", readiness.status);
  }

  if (readiness.status !== "running") {
    log.warn("mobile chat credentials requested for non-running instance", {
      source: "mobile-chat-credentials",
      route: ROUTE,
      method: "GET",
      instanceId: id,
      userId,
      failureType: "mobile_chat_credentials_instance_not_running",
      instanceStatus: readiness.status,
    });

    return NextResponse.json(
      { error: "Instance is not currently running", instanceStatus: readiness.status },
      { status: 400 },
    );
  }

  const { instance, apiServerKey, instanceIpv4, error } = await getSecureUserInstance({
    id,
    userId,
    requireRunning: true,
  });

  if (!instance || !instance.gateway_url || !apiServerKey) {
    // NOTE: never log apiServerKey — booleans only.
    log.warn("mobile chat credentials unavailable", {
      source: "mobile-chat-credentials",
      route: ROUTE,
      method: "GET",
      instanceId: id,
      userId,
      failureType: "mobile_chat_credentials_unavailable",
      reason: error || "missing_gateway_or_api_server_key",
      hasInstance: Boolean(instance),
      hasGatewayUrl: Boolean(instance?.gateway_url),
      hasApiServerKey: Boolean(apiServerKey),
    });
    return NextResponse.json(
      { error: error || "Chat credentials are unavailable for this instance" },
      { status: resolveErrorStatus(error) },
    );
  }

  // Same public origin the browser SPA uses: gateway_url minus any stale
  // port suffix / http→https normalization.
  const baseUrl = deriveWebUIBaseUrl(instance.gateway_url);
  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    host = baseUrl.replace(/^https?:\/\//, "").split("/")[0] || "";
  }

  if (!host) {
    log.warn("mobile chat credentials could not derive box host", {
      source: "mobile-chat-credentials",
      route: ROUTE,
      method: "GET",
      instanceId: id,
      userId,
      failureType: "mobile_chat_credentials_host_underivable",
    });
    return NextResponse.json(
      { error: "Chat credentials are unavailable for this instance" },
      { status: 500 },
    );
  }

  // Chat-ready gate: an authenticated GET on the sessions lane with the exact
  // bearer we are about to hand out. Anything but a 2xx/3xx (box still
  // booting, Caddy not up, bearer drift, TLS not issued yet) → 202 pending so
  // the client retries instead of dialing a WS that will be refused.
  try {
    const { response } = await fetchFirstReachableGatewayResponse({
      baseUrl,
      pathname: CHAT_SESSIONS_PATH,
      instanceIpv4,
      timeoutMs: CHAT_LANE_PROBE_TIMEOUT_MS,
      method: "GET",
      timeoutScope: "request",
      headers: {
        Authorization: `Bearer ${apiServerKey}`,
        Accept: "application/json",
      },
    });
    await response.body?.cancel().catch(() => undefined);

    if (response.status >= 400) {
      log.warn("mobile chat credentials chat-lane probe rejected", {
        source: "mobile-chat-credentials",
        route: ROUTE,
        method: "GET",
        instanceId: id,
        userId,
        failureType: "mobile_chat_credentials_chat_lane_not_ready",
        instanceStatus: readiness.status,
        probeStatus: response.status,
        probePath: CHAT_SESSIONS_PATH,
        retryAfterMs: PENDING_RETRY_AFTER_MS,
      });
      return pendingResponse("chat_lane_not_ready", readiness.status);
    }
  } catch (err) {
    log.warn("mobile chat credentials chat-lane probe unreachable", {
      source: "mobile-chat-credentials",
      route: ROUTE,
      method: "GET",
      instanceId: id,
      userId,
      failureType: "mobile_chat_credentials_chat_lane_unreachable",
      instanceStatus: readiness.status,
      probePath: CHAT_SESSIONS_PATH,
      probeReason: err instanceof Error ? err.message || err.name : String(err),
      retryAfterMs: PENDING_RETRY_AFTER_MS,
    });
    return pendingResponse("chat_lane_not_ready", readiness.status);
  }

  return NextResponse.json(
    {
      host,
      token: apiServerKey,
      wsPath: CHAT_WS_PATH,
      sessionsPath: CHAT_SESSIONS_PATH,
    },
    {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    },
  );
}
