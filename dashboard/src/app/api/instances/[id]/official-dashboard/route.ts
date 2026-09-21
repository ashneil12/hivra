import crypto from "node:crypto";

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";

import {
  fetchFirstReachableGatewayResponse,
  getGatewayRequestDiagnostics,
} from "@/lib/agent-gateway";
import { deriveWebUIBaseUrl } from "@/lib/instance-backend";
import {
  createOfficialDashboardLoginUrl,
  resolveOfficialDashboardGatewayUrl,
} from "@/lib/official-dashboard-handoff";
import {
  ensureManagedSidecarScript,
  getSecureUserInstance,
  recoverAndPersistApiServerKeyFromManagedHost,
} from "@/lib/services/instance-security";
import { log } from "@/lib/logger";
import { isWebfreeBackend } from "@/lib/types/instance";

export const dynamic = "force-dynamic";

const DASHBOARD_SIDECAR_AUTH_CHECK_PATH = "/_sidecar/dashboard-session-check";
const DASHBOARD_UPSTREAM_STATUS_CHECK_PATH = "/_sidecar/api/status";
const DASHBOARD_SIDECAR_AUTH_CHECK_TIMEOUT_MS = 8_000;
const DASHBOARD_UPSTREAM_STATUS_CHECK_TIMEOUT_MS = 20_000;
const DASHBOARD_AUTH_VERIFICATION_ERROR = "Official dashboard authentication could not be verified";
const DASHBOARD_UPSTREAM_VERIFICATION_ERROR = "Official dashboard is still starting. Please try again in a moment.";
const WEBUI_OFFICIAL_DASHBOARD_ENTRY_PATH = "/dash";

type SecureInstance = NonNullable<Awaited<ReturnType<typeof getSecureUserInstance>>["instance"]>;
type OfficialDashboardAuthResolution = {
  apiServerKey: string;
  instanceIpv4: string;
  verified: boolean;
  shouldRefreshSidecar: boolean;
};

function resolveErrorStatus(error: string | null): number {
  if (!error) return 500;
  if (error.includes("not found") || error.includes("unauthorized")) return 404;
  if (error.includes("not currently running") || error.includes("Gateway URL not configured")) return 400;
  return 500;
}

function shouldReturnJsonHandoff(request: Request): boolean {
  try {
    const url = new URL(request.url);
    return url.searchParams.get("format") === "json";
  } catch {
    return false;
  }
}

function respondWithDashboardLoginUrl(request: Request, loginUrl: string): NextResponse {
  if (shouldReturnJsonHandoff(request)) {
    return NextResponse.json(
      { url: loginUrl },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
        },
      },
    );
  }

  return NextResponse.redirect(loginUrl);
}

function buildSignedSidecarHeaders(apiServerKey: string): Headers {
  const timestamp = Date.now().toString();
  const signature = crypto
    .createHmac("sha256", apiServerKey)
    .update(timestamp)
    .digest("hex");

  return new Headers({
    Accept: "application/json",
    Connection: "close",
    "X-Hermes-Timestamp": timestamp,
    "X-Hermes-Signature": signature,
  });
}

async function probeDashboardSidecarAuth(params: {
  gatewayUrl: string;
  apiServerKey: string;
  instanceIpv4: string;
}): Promise<{ ok: boolean; status: number | null }> {
  const { response } = await fetchFirstReachableGatewayResponse({
    baseUrl: params.gatewayUrl,
    pathname: DASHBOARD_SIDECAR_AUTH_CHECK_PATH,
    instanceIpv4: params.instanceIpv4,
    method: "GET",
    headers: buildSignedSidecarHeaders(params.apiServerKey),
    timeoutMs: DASHBOARD_SIDECAR_AUTH_CHECK_TIMEOUT_MS,
  });

  return {
    ok: response.ok,
    status: response.status,
  };
}

async function probeOfficialDashboardUpstream(params: {
  instance: SecureInstance;
  gatewayUrl: string;
  apiServerKey: string;
  instanceIpv4: string;
  userId: string;
}): Promise<boolean> {
  try {
    const { response } = await fetchFirstReachableGatewayResponse({
      baseUrl: params.gatewayUrl,
      pathname: DASHBOARD_UPSTREAM_STATUS_CHECK_PATH,
      instanceIpv4: params.instanceIpv4,
      method: "GET",
      headers: buildSignedSidecarHeaders(params.apiServerKey),
      timeoutMs: DASHBOARD_UPSTREAM_STATUS_CHECK_TIMEOUT_MS,
    });

    if (response.ok) {
      return true;
    }

    log.warn("official dashboard upstream status check did not return ready", {
      source: "official-dashboard",
      route: "/api/instances/[id]/official-dashboard",
      method: "GET",
      instanceId: params.instance.id,
      userId: params.userId,
      status: response.status,
      failureType: "official_dashboard_upstream_status_not_ready",
    });
    return false;
  } catch (err) {
    log.warn("official dashboard upstream status check failed before handoff", {
      source: "official-dashboard",
      route: "/api/instances/[id]/official-dashboard",
      method: "GET",
      instanceId: params.instance.id,
      userId: params.userId,
      failureType: "official_dashboard_upstream_status_check_failed",
      ...getGatewayRequestDiagnostics(err),
    }, err);
    return false;
  }
}

async function resolveOfficialDashboardApiServerKey(params: {
  instance: SecureInstance;
  gatewayUrl: string;
  apiServerKey: string;
  instanceIpv4: string;
  userId: string;
}): Promise<OfficialDashboardAuthResolution> {
  try {
    const initialProbe = await probeDashboardSidecarAuth({
      gatewayUrl: params.gatewayUrl,
      apiServerKey: params.apiServerKey,
      instanceIpv4: params.instanceIpv4,
    });

    if (initialProbe.ok) {
      return {
        apiServerKey: params.apiServerKey,
        instanceIpv4: params.instanceIpv4,
        verified: true,
        shouldRefreshSidecar: false,
      };
    }

    if (initialProbe.status !== 401 && initialProbe.status !== 403) {
      log.warn("official dashboard sidecar auth check did not return ready", {
        source: "official-dashboard",
        route: "/api/instances/[id]/official-dashboard",
        method: "GET",
        instanceId: params.instance.id,
        userId: params.userId,
        status: initialProbe.status ?? undefined,
        failureType: "official_dashboard_sidecar_auth_check_not_ready",
      });
      return {
        apiServerKey: params.apiServerKey,
        instanceIpv4: params.instanceIpv4,
        verified: false,
        shouldRefreshSidecar: true,
      };
    }

    const recovered = await recoverAndPersistApiServerKeyFromManagedHost({
      id: params.instance.id,
      gateway_url: params.instance.gateway_url,
      host_id: params.instance.host_id ?? null,
      hetzner_server_id: params.instance.hetzner_server_id ?? null,
      ipv4_address: params.instance.ipv4_address ?? (params.instanceIpv4 || null),
      config: params.instance.config ?? null,
    }, {
      ignoreApiServerKey: params.apiServerKey,
    });

    if (!recovered || recovered.apiServerKey === params.apiServerKey) {
      log.warn("official dashboard sidecar rejected stored bearer and recovery was unavailable", {
        source: "official-dashboard",
        route: "/api/instances/[id]/official-dashboard",
        method: "GET",
        instanceId: params.instance.id,
        userId: params.userId,
        status: initialProbe.status ?? undefined,
        failureType: "official_dashboard_stale_bearer_recovery_unavailable",
      });
      return {
        apiServerKey: params.apiServerKey,
        instanceIpv4: params.instanceIpv4,
        verified: false,
        shouldRefreshSidecar: false,
      };
    }

    const recoveredProbe = await probeDashboardSidecarAuth({
      gatewayUrl: params.gatewayUrl,
      apiServerKey: recovered.apiServerKey,
      instanceIpv4: recovered.instanceIpv4 || params.instanceIpv4,
    });

    if (!recoveredProbe.ok) {
      log.warn("official dashboard recovered bearer but sidecar still rejected auth check", {
        source: "official-dashboard",
        route: "/api/instances/[id]/official-dashboard",
        method: "GET",
        instanceId: params.instance.id,
        userId: params.userId,
        status: recoveredProbe.status ?? undefined,
        initialStatus: initialProbe.status ?? undefined,
        failureType: "official_dashboard_recovered_bearer_rejected",
      });
      return {
        apiServerKey: recovered.apiServerKey,
        instanceIpv4: recovered.instanceIpv4 || params.instanceIpv4,
        verified: false,
        shouldRefreshSidecar: recoveredProbe.status !== 401 && recoveredProbe.status !== 403,
      };
    }

    log.warn("official dashboard recovered stale sidecar bearer before handoff", {
      source: "official-dashboard",
      route: "/api/instances/[id]/official-dashboard",
      method: "GET",
      instanceId: params.instance.id,
      userId: params.userId,
      status: initialProbe.status ?? undefined,
      failureType: "official_dashboard_stale_bearer_recovered",
    });

    return {
      apiServerKey: recovered.apiServerKey,
      instanceIpv4: recovered.instanceIpv4 || params.instanceIpv4,
      verified: true,
      shouldRefreshSidecar: false,
    };
  } catch (err) {
    log.warn("official dashboard sidecar auth check failed before handoff", {
      source: "official-dashboard",
      route: "/api/instances/[id]/official-dashboard",
      method: "GET",
      instanceId: params.instance.id,
      userId: params.userId,
      failureType: "official_dashboard_sidecar_auth_check_failed",
      ...getGatewayRequestDiagnostics(err),
    }, err);
    return {
      apiServerKey: params.apiServerKey,
      instanceIpv4: params.instanceIpv4,
      verified: false,
      shouldRefreshSidecar: true,
    };
  }
}

async function refreshOfficialDashboardSidecarBeforeHandoff(params: {
  instance: SecureInstance;
  instanceIpv4: string;
  userId: string;
  composeService?: "dashboard-sidecar";
}): Promise<void> {
  const isWebUIDashboard = params.composeService === "dashboard-sidecar";

  try {
    const refreshed = await ensureManagedSidecarScript({
      id: params.instance.id,
      instanceIpv4: params.instanceIpv4,
      ...(params.composeService ? { composeService: params.composeService } : {}),
      config: params.instance.config,
      hostId: params.instance.host_id ?? null,
    });
    if (!refreshed) {
      log.warn(
        isWebUIDashboard
          ? "WebUI dashboard sidecar refresh did not report ready before launch"
          : "managed sidecar refresh did not report ready before launch",
        {
          source: "official-dashboard",
          route: "/api/instances/[id]/official-dashboard",
          method: "GET",
          instanceId: params.instance.id,
          userId: params.userId,
          failureType: isWebUIDashboard
            ? "webui_dashboard_sidecar_refresh_not_ready"
            : "managed_sidecar_refresh_not_ready",
          hasInstanceIpv4: Boolean(params.instanceIpv4),
        },
      );
    }
  } catch (err) {
    log.warn(
      isWebUIDashboard
        ? "failed to refresh WebUI dashboard sidecar before launch"
        : "failed to refresh managed sidecar before launch",
      {
        source: "official-dashboard",
        route: "/api/instances/[id]/official-dashboard",
        method: "GET",
        instanceId: params.instance.id,
        userId: params.userId,
        failureType: isWebUIDashboard
          ? "webui_dashboard_sidecar_refresh_failed"
          : "managed_sidecar_refresh_failed",
      },
      err,
    );
  }
}

async function resolveOfficialDashboardAuthWithSidecarRepair(params: {
  instance: SecureInstance;
  gatewayUrl: string;
  apiServerKey: string;
  instanceIpv4: string;
  userId: string;
  composeService?: "dashboard-sidecar";
}): Promise<OfficialDashboardAuthResolution> {
  const initialAuth = await resolveOfficialDashboardApiServerKey(params);
  if (initialAuth.verified || !initialAuth.shouldRefreshSidecar || !initialAuth.instanceIpv4) {
    return initialAuth;
  }

  log.warn("official dashboard sidecar auth was not ready; refreshing sidecar before retry", {
    source: "official-dashboard",
    route: "/api/instances/[id]/official-dashboard",
    method: "GET",
    instanceId: params.instance.id,
    userId: params.userId,
    backend: params.instance.backend ?? "agent",
    failureType: "official_dashboard_sidecar_refresh_before_retry",
    hasInstanceIpv4: Boolean(initialAuth.instanceIpv4),
  });

  await refreshOfficialDashboardSidecarBeforeHandoff({
    instance: params.instance,
    instanceIpv4: initialAuth.instanceIpv4,
    userId: params.userId,
    composeService: params.composeService,
  });

  return resolveOfficialDashboardApiServerKey({
    ...params,
    apiServerKey: initialAuth.apiServerKey,
    instanceIpv4: initialAuth.instanceIpv4,
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const { instance, apiServerKey, error, instanceIpv4 } = await getSecureUserInstance({
    id,
    userId,
    requireRunning: true,
  });

  if (!instance || !instance.gateway_url || !apiServerKey) {
    log.warn("official dashboard unavailable before handoff", {
      source: "official-dashboard",
      route: "/api/instances/[id]/official-dashboard",
      method: "GET",
      instanceId: id,
      userId,
      failureType: "official_dashboard_unavailable",
      reason: error || "missing_gateway_or_api_server_key",
      hasInstance: Boolean(instance),
      hasGatewayUrl: Boolean(instance?.gateway_url),
      hasApiServerKey: Boolean(apiServerKey),
    });
    return NextResponse.json(
      { error: error || "Official dashboard is unavailable for this instance" },
      { status: resolveErrorStatus(error) }
    );
  }

  if (isWebfreeBackend(instance.backend)) {
    const gatewayUrl = resolveOfficialDashboardGatewayUrl({
      gatewayUrl: deriveWebUIBaseUrl(instance.gateway_url),
      instanceIpv4,
    });
    const handoffAuth = await resolveOfficialDashboardAuthWithSidecarRepair({
      instance,
      gatewayUrl,
      apiServerKey,
      instanceIpv4,
      userId,
      composeService: "dashboard-sidecar",
    });
    if (!handoffAuth.verified) {
      return NextResponse.json({ error: DASHBOARD_AUTH_VERIFICATION_ERROR }, { status: 502 });
    }
    const upstreamReady = await probeOfficialDashboardUpstream({
      instance,
      gatewayUrl,
      apiServerKey: handoffAuth.apiServerKey,
      instanceIpv4: handoffAuth.instanceIpv4,
      userId,
    });
    if (!upstreamReady) {
      return NextResponse.json({ error: DASHBOARD_UPSTREAM_VERIFICATION_ERROR }, { status: 502 });
    }
    const loginUrl = createOfficialDashboardLoginUrl({
      gatewayUrl,
      apiServerKey: handoffAuth.apiServerKey,
      nextPath: WEBUI_OFFICIAL_DASHBOARD_ENTRY_PATH,
      instanceIpv4: handoffAuth.instanceIpv4,
    });
    return respondWithDashboardLoginUrl(request, loginUrl);
  }

  const gatewayUrl = resolveOfficialDashboardGatewayUrl({
    gatewayUrl: instance.gateway_url,
    instanceIpv4,
  });
  const handoffAuth = await resolveOfficialDashboardAuthWithSidecarRepair({
    instance,
    gatewayUrl,
    apiServerKey,
    instanceIpv4,
    userId,
  });
  if (!handoffAuth.verified) {
    return NextResponse.json({ error: DASHBOARD_AUTH_VERIFICATION_ERROR }, { status: 502 });
  }
  const loginUrl = createOfficialDashboardLoginUrl({
    gatewayUrl,
    apiServerKey: handoffAuth.apiServerKey,
    nextPath: "/",
    instanceIpv4: handoffAuth.instanceIpv4,
  });

  return respondWithDashboardLoginUrl(request, loginUrl);
}
