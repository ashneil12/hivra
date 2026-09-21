import { fetchFirstReachableGatewayResponse } from "@/lib/agent-gateway";
import { log } from "@/lib/logger";
import { createWebuiLoginUrl } from "@/lib/webui-handoff";
import { recoverAndPersistApiServerKeyFromManagedHost } from "@/lib/services/instance-security";

const ROUTE = "/api/instances/[id]/webui-login-url";

// The signed-handoff drift probe mints a throwaway login URL with the STORED
// apiServerKey and asks the live sidecar to verify it. A 403 on a fresh,
// in-window, well-formed handoff is an unambiguous signature mismatch — the
// stored key no longer matches the VM's baked API_SERVER_KEY.
const WEBUI_HANDOFF_SIGNATURE_PROBE_TIMEOUT_MS = 3500;
const WEBUI_LOGIN_SIDECAR_PATH = "/_sidecar/webui-login";
const DASHBOARD_LOGIN_SIDECAR_PATH = "/_sidecar/dashboard-login";

// One drift detect/repair pass per instance per cooldown. The probe is a cheap
// HTTP round-trip and the recovery is an SSH read of the VM's live key, so this
// cooldown both keeps the happy path fast (a verified key is not re-probed every
// open) and — critically — prevents an SSH-storm when a box is genuinely broken
// and the recovery cannot find a fresh key. Best-effort per-lambda-instance,
// matching the managedSidecarRefreshCache pattern in instance-security.ts; even
// across several warm lambdas this stays well-bounded.
const API_SERVER_KEY_RESYNC_COOLDOWN_MS = 5 * 60 * 1000;
const API_SERVER_KEY_RESYNC_TRACKER_MAX = 5000;
const apiServerKeyResyncAttempts = new Map<string, number>();

export function shouldAttemptApiServerKeyResync(instanceId: string, now: number): boolean {
  const last = apiServerKeyResyncAttempts.get(instanceId);
  return last === undefined || now - last >= API_SERVER_KEY_RESYNC_COOLDOWN_MS;
}

function markApiServerKeyResyncAttempt(instanceId: string, now: number): void {
  if (apiServerKeyResyncAttempts.size >= API_SERVER_KEY_RESYNC_TRACKER_MAX) {
    for (const [key, attemptedAt] of apiServerKeyResyncAttempts) {
      if (now - attemptedAt >= API_SERVER_KEY_RESYNC_COOLDOWN_MS) {
        apiServerKeyResyncAttempts.delete(key);
      }
    }
  }
  apiServerKeyResyncAttempts.set(instanceId, now);
}

// Test-only: clears the per-instance cooldown tracker so suites don't bleed
// module state across cases. Never called in production paths.
export function __resetApiServerKeyResyncTrackerForTests(): void {
  apiServerKeyResyncAttempts.clear();
}

function getGatewayHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl.replace(/^https?:\/\//, "").split("/")[0] || "unknown";
  }
}

export interface ApiServerKeyDriftInstance {
  id: string;
  gateway_url: string | null;
  host_id?: string | null;
  hetzner_server_id?: number | null;
  ipv4_address?: string | null;
  backend?: "gateway" | "webui" | null;
  /** Carries `config.infrastructure` so the recovery step can route the live-key
   *  SSH read through the managing pve host for Proxmox guests (whose private IP
   *  Vercel cannot reach directly). Omitted/Hetzner instances recover via their
   *  public IP as before. */
  config?: unknown;
}

// Server-side signature verification. Mints a THROWAWAY signed handoff with the
// stored apiServerKey (its own fresh nonce, so it never collides with the URL
// handed to the client) and asks the live sidecar to verify it. The sidecar
// checks the HMAC before the nonce-reuse/session steps, so a `403` on this
// fresh, in-window, well-formed request can ONLY mean the signature did not
// match — i.e. the stored key has drifted from the VM's baked API_SERVER_KEY.
// A successful handoff is a 302 (→ opaqueredirect / status 0 under
// redirect:"manual"); any other status, or a network error, is inconclusive
// and is NOT treated as drift. The cookie/nonce the sidecar mints on a success
// is throwaway and self-prunes on TTL.
export async function probeSignedHandoffSignature(params: {
  baseUrl: string;
  instanceIpv4: string;
  apiServerKey: string;
  isWebuiBackend: boolean;
}): Promise<boolean> {
  try {
    const { url } = createWebuiLoginUrl({
      gatewayUrl: params.baseUrl,
      apiServerKey: params.apiServerKey,
      nextPath: "/",
      loginPath: params.isWebuiBackend ? WEBUI_LOGIN_SIDECAR_PATH : DASHBOARD_LOGIN_SIDECAR_PATH,
    });
    const minted = new URL(url);
    const { response } = await fetchFirstReachableGatewayResponse({
      baseUrl: params.baseUrl,
      pathname: `${minted.pathname}${minted.search}`,
      instanceIpv4: params.instanceIpv4,
      timeoutMs: WEBUI_HANDOFF_SIGNATURE_PROBE_TIMEOUT_MS,
      method: "GET",
      timeoutScope: "request",
      redirect: "manual",
    });
    await response.body?.cancel().catch(() => undefined);
    return response.status === 403;
  } catch {
    return false;
  }
}

// Detects + auto-corrects a present-but-wrong apiServerKey (drift). The readiness
// probes upstream (in webui-login-url/route.ts) only confirm the sidecar is
// alive and gating access; they cannot see whether the key this route SIGNS
// handoffs with is the one the VM VERIFIES with. When that drifts (an
// out-of-band box rebuild regenerates API_SERVER_KEY but leaves
// hermes_instances.api_server_key_encrypted stale) every signed handoff 403s at
// the sidecar → blank white iframe. Here we confirm the drift with a signed
// probe and, once per cooldown, recover the live key off the VM
// (recoverAndPersist with ignoreApiServerKey only persists a key that DIFFERS
// from the stored one), returning it so the caller re-mints with the corrected
// key in the same request. Returns the key to mint with — either the recovered
// one, or the original when there is no drift / nothing to recover / we are
// inside the cooldown.
export async function detectAndRepairApiServerKeyDrift(params: {
  instance: ApiServerKeyDriftInstance;
  apiServerKey: string;
  baseUrl: string;
  instanceIpv4: string;
  isWebuiBackend: boolean;
  userId: string;
  now?: number;
}): Promise<{ apiServerKey: string }> {
  const fallback = { apiServerKey: params.apiServerKey };
  if (!params.instanceIpv4 || !params.apiServerKey) {
    return fallback;
  }

  const now = params.now ?? Date.now();
  if (!shouldAttemptApiServerKeyResync(params.instance.id, now)) {
    return fallback;
  }
  // Claim the cooldown slot up front so a hung/throwing probe, or a recovery
  // that can't find a fresh key, still can't be retried until the cooldown
  // elapses. This is the SSH-storm guard.
  markApiServerKeyResyncAttempt(params.instance.id, now);

  const drifted = await probeSignedHandoffSignature({
    baseUrl: params.baseUrl,
    instanceIpv4: params.instanceIpv4,
    apiServerKey: params.apiServerKey,
    isWebuiBackend: params.isWebuiBackend,
  });
  if (!drifted) {
    return fallback;
  }

  log.warn("webui handoff signature rejected by a healthy sidecar; attempting apiServerKey drift recovery", {
    source: "webui-handoff",
    route: ROUTE,
    method: "GET",
    instanceId: params.instance.id,
    userId: params.userId,
    failureType: "webui_handoff_api_server_key_drift_detected",
    backend: params.instance.backend ?? null,
    gatewayHost: getGatewayHost(params.baseUrl),
  });

  const recovered = await recoverAndPersistApiServerKeyFromManagedHost(params.instance, {
    ignoreApiServerKey: params.apiServerKey,
  });

  if (recovered?.apiServerKey) {
    log.warn("webui handoff apiServerKey drift self-healed; re-minting with the recovered VM key", {
      source: "webui-handoff",
      route: ROUTE,
      method: "GET",
      instanceId: params.instance.id,
      userId: params.userId,
      failureType: "webui_handoff_api_server_key_drift_repaired",
    });
    return { apiServerKey: recovered.apiServerKey };
  }

  log.warn("webui handoff apiServerKey drift detected but no fresh VM key recovered", {
    source: "webui-handoff",
    route: ROUTE,
    method: "GET",
    instanceId: params.instance.id,
    userId: params.userId,
    failureType: "webui_handoff_api_server_key_drift_recovery_failed",
  });
  return fallback;
}
