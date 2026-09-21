import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { fetchFirstReachableGatewayResponse } from "@/lib/agent-gateway";
import { redactSensitiveCommandOutput } from "@/lib/command-output-redaction";
import { deriveWebUIBaseUrl } from "@/lib/instance-backend";
import { recordInstanceUserActivity } from "@/lib/instance-activity";
import { getRuntimeAgentSettings } from "@/lib/instance-settings";
import { sshExec } from "@/lib/hetzner/ssh";
import { log } from "@/lib/logger";
import { buildHostCaddyReloadScript } from "@/lib/services/hetzner-instance-builders";
import { getSecureUserInstance } from "@/lib/services/instance-security";
import { detectAndRepairApiServerKeyDrift } from "@/lib/webui-handoff-key-resync";
import {
  getProxmoxHostRoutingConfigFromInfrastructure,
  getProxmoxInfrastructure,
} from "@/lib/services/proxmox-infrastructure";
import { buildWebUICaddyfile } from "@/lib/services/webui-instance-builder";
import { supabaseAdmin } from "@/lib/supabase";
import { isWebfreeBackend } from "@/lib/types/instance";
import {
  createCookieBackedWebuiIframeUrl,
  createDashboardLoginIframeUrl,
} from "@/lib/webui-handoff";
import { DEFAULT_LOCALE, normalizeLocale } from "@/lib/i18n";
import {
  normalizeWebUIAppearanceSkin,
  normalizeWebUIAppearanceTheme,
  type WebUIAppearance,
} from "@/lib/webui-appearance";

export const dynamic = "force-dynamic";

const ROUTE = "/api/instances/[id]/webui-login-url";
const PENDING_HANDOFF_RETRY_AFTER_MS = 4000;
const PENDING_HANDOFF_STATUSES = new Set(["provisioning", "redeploying"]);
const WEBUI_GATEWAY_PROBE_TIMEOUT_MS = 3500;
const WEBUI_CADDY_REPAIR_TIMEOUT_MS = 30_000;
const WEBUI_ROOT_PROBE_PATH = "/";
const WEBUI_SPA_SHELL_PROBE_PATH = "/webchat";
const WEBUI_ADMIN_DOCUMENT_PROBE_PATH = "/dash/sessions";
// Gateway-backend instances serve the workspace SPA from the official-dashboard
// (`hermes dashboard`) container, fronted by the dashboard sidecar, reached via the
// signed cookie handoff this route mints below. The agent gateway itself
// (`gateway run`, the bearer-auth API server) does NOT serve the SPA: a cookieless
// `GET /` is routed to it and returns 404 BY DESIGN — it only owns `/health` + `/v1`.
// So the WebUI root/SPA probes ("/" + "/webchat") that work for webui-backend mark
// every healthy gateway-backend instance "unreachable" forever. Instead we probe the
// sidecar's auth-check endpoint: an auth-gated 401/403 confirms the sidecar is alive
// and ready to accept the handoff (see isHandoffProbeReachable + the official-dashboard
// route, which uses the same 401/403-means-ready contract).
const GATEWAY_SIDECAR_READINESS_PROBE_PATH = "/_sidecar/dashboard-session-check";

type InstanceReadinessRow = {
  status: string | null;
};

type SecureInstance = NonNullable<Awaited<ReturnType<typeof getSecureUserInstance>>["instance"]>;

type WebuiGatewayProbeResult =
  | { ok: true; probeUrl?: string; probePath?: string }
  | {
      ok: false;
      probeReason: string;
      probeErrorName: string;
      probeErrorCode?: string;
      probeStatus?: number;
      probeUrl?: string;
      probePath?: string;
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

function getGatewayHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl.replace(/^https?:\/\//, "").split("/")[0] || "unknown";
  }
}

function extractProbeErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;

  const direct = (err as { code?: unknown }).code;
  if (typeof direct === "string") return direct;

  const cause = (err as { cause?: unknown }).cause;
  const causeCode = extractProbeErrorCode(cause);
  if (causeCode) return causeCode;

  const errors = (err as { errors?: unknown }).errors;
  if (Array.isArray(errors)) {
    for (const inner of errors) {
      const innerCode = extractProbeErrorCode(inner);
      if (innerCode) return innerCode;
    }
  }

  return undefined;
}

function describeProbeError(err: unknown): {
  probeReason: string;
  probeErrorName: string;
  probeErrorCode?: string;
} {
  if (err instanceof Error) {
    return {
      probeReason: err.message || err.name,
      probeErrorName: err.name,
      probeErrorCode: extractProbeErrorCode(err),
    };
  }

  return {
    probeReason: String(err),
    probeErrorName: typeof err,
  };
}

async function probeWebuiGateway(params: {
  baseUrl: string;
  instanceIpv4?: string;
  pathname?: string;
}): Promise<WebuiGatewayProbeResult> {
  const pathname = params.pathname ?? WEBUI_ROOT_PROBE_PATH;
  try {
    const { response, url } = await fetchFirstReachableGatewayResponse({
      baseUrl: params.baseUrl,
      pathname,
      instanceIpv4: params.instanceIpv4,
      timeoutMs: WEBUI_GATEWAY_PROBE_TIMEOUT_MS,
      method: "GET",
      timeoutScope: "request",
      headers: {
        Accept: "text/html,application/xhtml+xml",
      },
    });
    await response.body?.cancel().catch(() => undefined);

    if (response.status >= 400) {
      return {
        ok: false,
        probeReason: `gateway returned HTTP ${response.status}`,
        probeErrorName: "HTTPError",
        probeStatus: response.status,
        probeUrl: url,
        probePath: pathname,
      };
    }

    return { ok: true, probeUrl: url, probePath: pathname };
  } catch (err) {
    return {
      ok: false,
      ...describeProbeError(err),
      probePath: pathname,
    };
  }
}

// A handoff probe is "reachable" when it returned <400 (the WebUI-backend SPA case),
// or — for gateway-backend, where the probe targets the auth-gated dashboard sidecar —
// when it returned 401/403 (the sidecar is alive and correctly requiring a session,
// so it can service the signed login URL minted below). Anything else (5xx, 404,
// connection error) means the workspace surface is not ready yet.
function isHandoffProbeReachable(
  probe: WebuiGatewayProbeResult,
  isWebuiBackend: boolean,
): boolean {
  if (probe.ok) return true;
  return !isWebuiBackend && (probe.probeStatus === 401 || probe.probeStatus === 403);
}

function getPlainConfig(config: unknown): Record<string, unknown> | undefined {
  return typeof config === "object" && config && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resolveWebuiCaddySiteLabel(params: {
  baseUrl: string;
  instance: SecureInstance;
}): string {
  if (getProxmoxInfrastructure(params.instance.config)) {
    return "localhost";
  }

  try {
    const parsed = new URL(params.baseUrl);
    return parsed.protocol === "http:" ? `http://${parsed.host}` : parsed.host;
  } catch {
    return params.baseUrl.replace(/^https?:\/\//, "").split("/")[0] || "localhost";
  }
}

// Rewrites the per-instance inner Caddyfile to match what buildWebUICaddyfile
// emits today. The on-disk file is compared by SHA256 against the expected
// payload first — if they already match, the script exits without touching
// the file or reloading Caddy. Any divergence (stale @publicHtml shape, a
// missing `rewrite * /` directive, or any future template change) is healed
// by writing the expected payload and reloading Caddy. The previous
// pattern-grep variant only caught the specific shape it knew about and
// stranded instances whenever the template advanced past it.
function buildWebuiCaddyPublicShellRepairScript(params: {
  instanceId: string;
  caddyfile: string;
}): string {
  const caddyfileBase64 = Buffer.from(params.caddyfile, "utf8").toString("base64");

  return [
    "set -euo pipefail",
    `INSTANCE_DIR=/opt/hermes/instances/${shellQuote(params.instanceId)}`,
    'CADDY="$INSTANCE_DIR/Caddyfile"',
    'mkdir -p "$INSTANCE_DIR"',
    `expected_b64=${shellQuote(caddyfileBase64)}`,
    'expected_sha=$(printf \'%s\' "$expected_b64" | base64 -d | sha256sum | head -c 64)',
    'if [ -f "$CADDY" ]; then',
    '  current_sha=$(sha256sum "$CADDY" | head -c 64)',
    '  if [ "$current_sha" = "$expected_sha" ]; then',
    "    echo CADDY_PUBLIC_SHELL_ALREADY_PRESENT",
    "    exit 0",
    "  fi",
    "fi",
    'backup="$CADDY.bak.$(date -u +%Y%m%dT%H%M%SZ)"',
    'if [ -f "$CADDY" ]; then cp -a "$CADDY" "$backup"; fi',
    'printf \'%s\' "$expected_b64" | base64 -d > "$CADDY"',
    buildHostCaddyReloadScript(),
    "echo CADDY_PUBLIC_SHELL_REPAIRED",
  ].join("\n");
}

async function repairWebuiCaddyPublicShell(params: {
  instance: SecureInstance;
  apiServerKey: string;
  baseUrl: string;
  instanceIpv4: string;
}): Promise<
  | { ok: true; stdout: string }
  | { ok: false; reason: string; stdout?: string; stderr?: string; error?: string }
> {
  if (!params.instanceIpv4) {
    return { ok: false, reason: "missing_instance_ipv4" };
  }

  const config = getPlainConfig(params.instance.config);
  const runtimeSettings = getRuntimeAgentSettings(config);
  const caddySiteLabel = resolveWebuiCaddySiteLabel({
    baseUrl: params.baseUrl,
    instance: params.instance,
  });
  const caddyfile = buildWebUICaddyfile(
    caddySiteLabel,
    `agent-${params.instance.id}`,
    params.apiServerKey,
    {
      browserSidecarEnabled: runtimeSettings.browserSidecarEnabled === true,
      instanceId: params.instance.id,
    },
  );
  const script = buildWebuiCaddyPublicShellRepairScript({
    instanceId: params.instance.id,
    caddyfile,
  });
  const proxmoxHostConfig = getProxmoxHostRoutingConfigFromInfrastructure(
    getProxmoxInfrastructure(params.instance.config),
    { host_id: params.instance.host_id ?? null },
  );
  const result = await sshExec(params.instanceIpv4, script, {
    timeoutMs: WEBUI_CADDY_REPAIR_TIMEOUT_MS,
    ...(proxmoxHostConfig ? { proxmoxHostConfig } : {}),
  });

  if (!result.ok) {
    return {
      ok: false,
      reason: "ssh_exec_failed",
      stdout: redactSensitiveCommandOutput(result.stdout || "", 800),
      stderr: redactSensitiveCommandOutput(result.stderr || "", 800),
      error: redactSensitiveCommandOutput(result.error || "", 800),
    };
  }

  return {
    ok: true,
    stdout: redactSensitiveCommandOutput(result.stdout || "", 800),
  };
}

// Any HTTP-status-bearing failure on a public probe is worth a repair pass:
// the inner Caddyfile is the source of truth and the repair script is
// idempotent (SHA256-gated). 401/403 indicates the @publicHtml shell never
// landed; 404/5xx indicates Caddy is forwarding but to a route shape WebUI
// no longer serves (e.g. a template-rev drift). Connection-level failures
// (no probeStatus) skip repair because SSH-rewriting Caddy can't help when
// the box itself isn't reachable from the edge.
function shouldAttemptCaddyfileRecovery(probe: WebuiGatewayProbeResult): boolean {
  return !probe.ok && typeof probe.probeStatus === "number";
}

async function repairPublicShellAndRetryProbe(params: {
  instance: SecureInstance;
  apiServerKey: string;
  baseUrl: string;
  instanceIpv4: string;
  userId: string;
  instanceStatus: string | null;
  probe: WebuiGatewayProbeResult;
  retryPath: string;
}): Promise<WebuiGatewayProbeResult> {
  log.warn("webui handoff gateway probe failed; reconciling Caddy public shell before retry", {
    source: "webui-handoff",
    route: ROUTE,
    method: "GET",
    instanceId: params.instance.id,
    userId: params.userId,
    failureType: "webui_handoff_caddy_public_shell_repair_attempt",
    instanceStatus: params.instanceStatus,
    gatewayHost: getGatewayHost(params.baseUrl),
    retryAfterMs: PENDING_HANDOFF_RETRY_AFTER_MS,
    ...params.probe,
  });

  const repair = await repairWebuiCaddyPublicShell({
    instance: params.instance,
    apiServerKey: params.apiServerKey,
    baseUrl: params.baseUrl,
    instanceIpv4: params.instanceIpv4,
  });

  if (repair.ok) {
    log.warn("webui handoff Caddy public shell repair completed; retrying gateway probe", {
      source: "webui-handoff",
      route: ROUTE,
      method: "GET",
      instanceId: params.instance.id,
      userId: params.userId,
      failureType: "webui_handoff_caddy_public_shell_repaired",
      repairStdout: repair.stdout,
      retryPath: params.retryPath,
    });
    return probeWebuiGateway({
      baseUrl: params.baseUrl,
      instanceIpv4: params.instanceIpv4,
      pathname: params.retryPath,
    });
  }

  log.warn("webui handoff Caddy public shell repair failed", {
    source: "webui-handoff",
    route: ROUTE,
    method: "GET",
    instanceId: params.instance.id,
    userId: params.userId,
    failureType: "webui_handoff_caddy_public_shell_repair_failed",
    repairReason: repair.reason,
    ...(repair.stdout ? { repairStdout: repair.stdout } : {}),
    ...(repair.stderr ? { repairStderr: repair.stderr } : {}),
    ...(repair.error ? { repairError: repair.error } : {}),
  });

  return params.probe;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const readiness = await getOwnedInstanceReadiness(id, userId);
  if (!readiness.ok) {
    return NextResponse.json({ error: readiness.error }, { status: 404 });
  }

  if (PENDING_HANDOFF_STATUSES.has(readiness.status ?? "")) {
    log.info("webui handoff pending while instance is not ready", {
      source: "webui-handoff",
      route: ROUTE,
      method: "GET",
      instanceId: id,
      userId,
      failureType: "webui_handoff_instance_not_ready",
      instanceStatus: readiness.status,
      retryAfterMs: PENDING_HANDOFF_RETRY_AFTER_MS,
    });

    return NextResponse.json(
      {
        kind: "pending",
        reason: "instance_not_ready",
        instanceStatus: readiness.status,
        retryAfterMs: PENDING_HANDOFF_RETRY_AFTER_MS,
        message: "Your workspace is still starting. Hermes will open it as soon as the Web UI is ready.",
      },
      {
        status: 202,
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
        },
      },
    );
  }

  if (readiness.status !== "running") {
    // Distinct machine-readable reasons so the client (and analytics) can
    // tell an intentionally parked box apart from a broken one. 'stopped' is
    // the expected scale-to-zero/manual-stop state → Start panel; 'error'
    // needs a restart/repair; 'failed' is a dead deployment (redeploy or
    // support). Everything else (paused, archived, …) behaves like stopped.
    const notRunningReason =
      readiness.status === "error"
        ? "instance_error"
        : readiness.status === "failed"
          ? "instance_failed"
          : "instance_stopped";

    log.warn("webui handoff requested for non-running instance", {
      source: "webui-handoff",
      route: ROUTE,
      method: "GET",
      instanceId: id,
      userId,
      failureType: "webui_handoff_instance_not_running",
      instanceStatus: readiness.status,
      notRunningReason,
    });

    return NextResponse.json(
      {
        error: "Instance is not currently running",
        reason: notRunningReason,
        instanceStatus: readiness.status,
      },
      { status: 400 },
    );
  }

  const { instance, apiServerKey, instanceIpv4, error } = await getSecureUserInstance({
    id,
    userId,
    requireRunning: true,
  });

  if (!instance || !instance.gateway_url || !apiServerKey) {
    log.warn("webui handoff URL unavailable before mint", {
      source: "webui-handoff",
      route: ROUTE,
      method: "GET",
      instanceId: id,
      userId,
      failureType: "webui_handoff_unavailable",
      reason: error || "missing_gateway_or_api_server_key",
      hasInstance: Boolean(instance),
      hasGatewayUrl: Boolean(instance?.gateway_url),
      hasApiServerKey: Boolean(apiServerKey),
    });
    return NextResponse.json(
      { error: error || "WebUI iframe is unavailable for this instance" },
      { status: resolveErrorStatus(error) },
    );
  }

  // Per the existing webui deployment, the iframe sits on the same Caddy
  // front-end as the bearer-auth API surface. deriveWebUIBaseUrl strips any
  // gateway-port suffix the column may carry and returns the public origin.
  const baseUrl = deriveWebUIBaseUrl(instance.gateway_url);
  const searchParams = new URL(request.url).searchParams;
  const requestedLocale = searchParams.get("locale");
  const locale = normalizeLocale(requestedLocale) ?? DEFAULT_LOCALE;
  const requestedTheme = searchParams.get("theme");
  const requestedSkin = searchParams.get("skin");
  const theme = normalizeWebUIAppearanceTheme(requestedTheme);
  const skin = normalizeWebUIAppearanceSkin(requestedSkin);
  const appearance: WebUIAppearance | null = theme
    ? {
        theme,
        skin: skin ?? "hivra",
        colorScheme: theme === "dark" ? "dark" : "light",
      }
    : null;
  // The self-healing Caddyfile reconciliation below rewrites the per-instance
  // inner Caddyfile to the WebUI shape (buildWebUICaddyfile → reverse_proxy
  // <id>-official-dashboard / <id>-dashboard-sidecar). Post gateway≡webfree
  // collapse BOTH backend values ("webui" AND "gateway") provision that exact
  // webfree topology — the builders take no `backend` argument, so the box is
  // byte-identical either way — so the WebUI repair is correct for both, gated
  // via isWebfreeBackend. The legacy buildAgentCaddyfile stack (agent-<id>
  // gateway + -web + -sidecar) that this repair would have 502'd is retired:
  // no backend routes to it anymore. The 2026-06-13 brick (a recreated gateway
  // box clobbered by this repair after a transient `/` 4xx during startup)
  // can't recur now that a gateway box IS the webfree topology the repair
  // targets. The non-webfree else-branch below survives only as a fallback for
  // a row with an absent/unknown backend column: it skips the repair and checks
  // readiness against the sidecar (GATEWAY_SIDECAR_READINESS_PROBE_PATH),
  // treating an auth-gated 401/403 as "ready" via isHandoffProbeReachable.
  const isWebuiBackend = isWebfreeBackend(instance.backend);

  let gatewayProbe = await probeWebuiGateway({
    baseUrl,
    instanceIpv4,
    pathname: isWebuiBackend ? WEBUI_ROOT_PROBE_PATH : GATEWAY_SIDECAR_READINESS_PROBE_PATH,
  });

  if (!isHandoffProbeReachable(gatewayProbe, isWebuiBackend) && shouldAttemptCaddyfileRecovery(gatewayProbe)) {
    if (isWebuiBackend) {
      gatewayProbe = await repairPublicShellAndRetryProbe({
        instance,
        apiServerKey,
        baseUrl,
        instanceIpv4,
        userId,
        instanceStatus: readiness.status,
        probe: gatewayProbe,
        retryPath: WEBUI_ROOT_PROBE_PATH,
      });
    } else {
      log.info("webui handoff gateway probe failed for non-webui backend; skipping WebUI Caddy repair", {
        source: "webui-handoff",
        route: ROUTE,
        method: "GET",
        instanceId: id,
        userId,
        failureType: "webui_handoff_caddy_repair_skipped_non_webui_backend",
        backend: instance.backend ?? null,
        instanceStatus: readiness.status,
        ...gatewayProbe,
      });
    }
  }

  if (!isHandoffProbeReachable(gatewayProbe, isWebuiBackend)) {
    log.warn("webui handoff gateway probe failed", {
      source: "webui-handoff",
      route: ROUTE,
      method: "GET",
      instanceId: id,
      userId,
      failureType: "webui_handoff_gateway_unreachable",
      instanceStatus: readiness.status,
      gatewayHost: getGatewayHost(baseUrl),
      retryAfterMs: PENDING_HANDOFF_RETRY_AFTER_MS,
      ...gatewayProbe,
    });

    return NextResponse.json(
      {
        kind: "pending",
        reason: "gateway_unreachable",
        instanceStatus: readiness.status,
        retryAfterMs: PENDING_HANDOFF_RETRY_AFTER_MS,
        message:
          "Your workspace is running, but its secure gateway is not reachable yet. Hermes will retry automatically.",
      },
      {
        status: 202,
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
        },
      },
    );
  }

  let spaShellProbe = await probeWebuiGateway({
    baseUrl,
    instanceIpv4,
    pathname: isWebuiBackend ? WEBUI_SPA_SHELL_PROBE_PATH : GATEWAY_SIDECAR_READINESS_PROBE_PATH,
  });
  const spaShellNeededRecovery = isWebuiBackend && shouldAttemptCaddyfileRecovery(spaShellProbe);

  if (spaShellNeededRecovery) {
    spaShellProbe = await repairPublicShellAndRetryProbe({
      instance,
      apiServerKey,
      baseUrl,
      instanceIpv4,
      userId,
      instanceStatus: readiness.status,
      probe: spaShellProbe,
      retryPath: WEBUI_SPA_SHELL_PROBE_PATH,
    });
  }

  if (!isHandoffProbeReachable(spaShellProbe, isWebuiBackend)) {
    if (spaShellNeededRecovery && shouldAttemptCaddyfileRecovery(spaShellProbe)) {
      log.warn("webui handoff SPA shell still failing after Caddy reconciliation; continuing with root shell handoff", {
        source: "webui-handoff",
        route: ROUTE,
        method: "GET",
        instanceId: id,
        userId,
        failureType: "webui_handoff_spa_shell_recovery_failed_continuing",
        instanceStatus: readiness.status,
        gatewayHost: getGatewayHost(baseUrl),
        retryAfterMs: PENDING_HANDOFF_RETRY_AFTER_MS,
        ...spaShellProbe,
      });
    } else {
      log.warn("webui handoff SPA shell probe failed", {
        source: "webui-handoff",
        route: ROUTE,
        method: "GET",
        instanceId: id,
        userId,
        failureType: "webui_handoff_spa_shell_unreachable",
        instanceStatus: readiness.status,
        gatewayHost: getGatewayHost(baseUrl),
        retryAfterMs: PENDING_HANDOFF_RETRY_AFTER_MS,
        ...spaShellProbe,
      });

      return NextResponse.json(
        {
          kind: "pending",
          reason: "gateway_unreachable",
          instanceStatus: readiness.status,
          retryAfterMs: PENDING_HANDOFF_RETRY_AFTER_MS,
          message:
            "Your workspace is running, but its secure gateway is not reachable yet. Hermes will retry automatically.",
        },
        {
          status: 202,
          headers: {
            "Cache-Control": "no-store, no-cache, must-revalidate",
          },
        },
      );
    }
  }

  // A healthy root and /webchat shell do not prove that an older inner
  // Caddyfile serves client-side admin routes. Probe a nested document path so
  // pre-try_files instances self-heal before the user follows an admin link.
  if (isWebuiBackend) {
    let adminDocumentProbe = await probeWebuiGateway({
      baseUrl,
      instanceIpv4,
      pathname: WEBUI_ADMIN_DOCUMENT_PROBE_PATH,
    });
    const adminDocumentNeededRecovery = shouldAttemptCaddyfileRecovery(adminDocumentProbe);

    if (adminDocumentNeededRecovery) {
      adminDocumentProbe = await repairPublicShellAndRetryProbe({
        instance,
        apiServerKey,
        baseUrl,
        instanceIpv4,
        userId,
        instanceStatus: readiness.status,
        probe: adminDocumentProbe,
        retryPath: WEBUI_ADMIN_DOCUMENT_PROBE_PATH,
      });
    }

    if (!isHandoffProbeReachable(adminDocumentProbe, isWebuiBackend)) {
      log.warn("webui handoff admin document probe failed; continuing with chat shell handoff", {
        source: "webui-handoff",
        route: ROUTE,
        method: "GET",
        instanceId: id,
        userId,
        failureType: "webui_handoff_admin_document_unreachable",
        instanceStatus: readiness.status,
        gatewayHost: getGatewayHost(baseUrl),
        retryAfterMs: PENDING_HANDOFF_RETRY_AFTER_MS,
        ...adminDocumentProbe,
      });
    }
  }

  if (requestedLocale && !normalizeLocale(requestedLocale)) {
    log.warn("webui handoff requested unsupported locale", {
      source: "webui-handoff",
      route: ROUTE,
      method: "GET",
      instanceId: id,
      userId,
      failureType: "webui_handoff_unsupported_locale",
      requestedLocale,
      fallbackLocale: DEFAULT_LOCALE,
    });
  }

  if ((requestedTheme && !theme) || (requestedSkin && !skin)) {
    log.warn("webui handoff requested unsupported appearance", {
      source: "webui-handoff",
      route: ROUTE,
      method: "GET",
      instanceId: id,
      userId,
      failureType: "webui_handoff_unsupported_appearance",
      requestedTheme,
      requestedSkin,
    });
  }

  // The box is confirmed reachable above, but the readiness probes can't tell
  // whether the apiServerKey we sign with still matches the VM's baked key. Do
  // a one-shot (cooldown-gated) signed-handoff verification and, on a confirmed
  // drift, recover the live key off the VM so the mint below uses the corrected
  // key instead of silently handing the user a 403'ing white-screen handoff.
  const { apiServerKey: mintApiServerKey } = await detectAndRepairApiServerKeyDrift({
    instance,
    apiServerKey,
    baseUrl,
    instanceIpv4,
    isWebuiBackend,
    userId,
  });

  try {
    // Handoff URL mint. Post gateway≡webfree collapse BOTH backend values
    // ("webui" AND "gateway") ship the identical webfree stack — including the
    // WebUI sidecar appendage (/webui-login + hash-token shell) — so both mint
    // createCookieBackedWebuiIframeUrl. The createDashboardLoginIframeUrl
    // fallback below (base-sidecar /dashboard-login handler, gated on the
    // hermes_dashboard_session cookie) now only applies to a row whose backend
    // is absent/unknown, i.e. not webfree. The 2026-06-14 incident (minting the
    // WebUI URL for a gateway box → 401 on a /webui-login the base sidecar
    // didn't handle) can't recur now that a gateway box ships the full webfree
    // sidecar.
    const { url } = isWebuiBackend
      ? createCookieBackedWebuiIframeUrl({
          gatewayUrl: baseUrl,
          apiServerKey: mintApiServerKey,
          locale,
          appearance,
        })
      : createDashboardLoginIframeUrl({
          gatewayUrl: baseUrl,
          apiServerKey: mintApiServerKey,
          locale,
          appearance,
        });
    await recordInstanceUserActivity({
      instanceId: id,
      userId,
      source: "webui_login",
    });

    // expiresAt is preserved in the response shape for the WebuiIframe
    // component's existing TTL UI. The login URL itself is short lived,
    // while the redirect target still carries the long-lived hash bearer.
    return NextResponse.json(
      { url, expiresAt: Date.now() + 12 * 60 * 60 * 1000 },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
        },
      },
    );
  } catch (err) {
    log.warn("webui handoff URL mint failed", {
      source: "webui-handoff",
      route: ROUTE,
      method: "GET",
      instanceId: id,
      userId,
      failureType: "webui_handoff_mint_failed",
    }, err);
    return NextResponse.json(
      { error: "Failed to mint WebUI login URL" },
      { status: 500 },
    );
  }
}
