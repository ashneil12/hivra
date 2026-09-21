// GET /api/instances/[id]/desktop-connection
//
// Returns the connection details an instance owner needs to point the Nous
// Hermes Desktop app (https://hermes-agent.nousresearch.com/desktop) at their
// Hivra-hosted instance in "remote gateway" mode:
//
//   - gatewayUrl : the public base URL the Desktop app's "Remote URL" field
//                  takes. It targets the /desktop edge route, which proxies the
//                  instance's upstream hermes-dashboard backend
//                  (official-dashboard:9119). The app appends /api/status,
//                  /api/ws, etc. itself.
//   - token      : the per-instance bearer (the instance's api_server_key, also
//                  pinned as HERMES_DASHBOARD_SESSION_TOKEN on the dashboard
//                  web_server). The Desktop app sends it as
//                  HERMES_DESKTOP_REMOTE_TOKEN.
//
// Auth: Clerk session + instance ownership (getSecureUserInstance). The token
// is the owner's own instance credential — same one the dashboard already
// hands the official-dashboard browser handoff.
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { deriveWebUIBaseUrl } from "@/lib/instance-backend";
import { getSecureUserInstance } from "@/lib/services/instance-security";
import { isWebfreeBackend } from "@/lib/types/instance";

export const dynamic = "force-dynamic";

// Edge path prefix added by buildWebUICaddyfile that proxies the
// hermes-dashboard backend for the Desktop app. Keep in sync with the
// `/desktop` route in webui-instance-builder.ts.
const DESKTOP_EDGE_PREFIX = "/desktop";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { userId } = await auth();
  if (!userId) {
    return apiError("Unauthorized", 401);
  }

  const { id } = await params;
  const { instance, apiServerKey, error } = await getSecureUserInstance({
    id,
    userId,
    requireRunning: true,
  });

  if (!instance || !instance.gateway_url || !apiServerKey) {
    const status =
      error === "Instance not found or unauthorized"
        ? 404
        : error === "Instance is not currently running"
          ? 409
          : 400;
    return apiError(
      error || "Desktop connection is unavailable for this instance.",
      status
    );
  }

  // Webfree instances only: the /desktop edge route lives in the Caddyfile that
  // buildWebUICaddyfile emits. Post gateway≡webfree collapse BOTH backend values
  // ("webui" AND "gateway") build that Caddyfile, so both expose /desktop — the
  // gate rejects only a row whose backend is present but non-webfree (the retired
  // legacy gateway stack, which nothing provisions anymore).
  if (instance.backend && !isWebfreeBackend(instance.backend)) {
    return apiError(
      "Desktop connection is only available for WebUI-backed instances.",
      409
    );
  }

  const baseUrl = deriveWebUIBaseUrl(instance.gateway_url).replace(/\/+$/, "");
  const gatewayUrl = `${baseUrl}${DESKTOP_EDGE_PREFIX}`;

  // Readiness probe — mirror EXACTLY what the Desktop app does first: an
  // UNAUTHENTICATED GET of the gateway's public /api/status to discover the
  // auth method (apps/desktop settings/gateway-settings.tsx). We must probe
  // *without* a token, because that's the request that bites people:
  //   - no /desktop route at all (un-redeployed)        → 401  → not ready
  //   - old /desktop route that 401s unauthed probes     → 401  → not ready
  //   - fixed route (public /api/status passes through)  → 200  → ready
  // An AUTHENTICATED probe would wrongly report "ready" for the middle case
  // (authed 200 but the app's unauthed discovery probe still 401s → "Could
  // not reach this gateway"). Best-effort, short timeout.
  let ready = false;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 4000);
    const probe = await fetch(`${gatewayUrl}/api/status`, {
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(t);
    ready = probe.ok; // 200 = public discovery path live → app can connect
  } catch {
    ready = false; // unreachable / timeout → not ready
  }

  const response = apiSuccess({
    gatewayUrl,
    token: apiServerKey,
    instanceName: typeof instance.name === "string" ? instance.name : null,
    ready,
  });
  // This response contains the live per-instance bearer. Dynamic rendering
  // prevents framework caching, while explicit response directives keep it
  // out of browser and intermediary caches as well.
  response.headers.set("Cache-Control", "no-store, private");
  response.headers.set("Pragma", "no-cache");
  return response;
}
