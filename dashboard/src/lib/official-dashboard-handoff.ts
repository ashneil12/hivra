import crypto from "node:crypto";

// Existing instance sidecars reject login links more than 60s in the future.
// Issue below that ceiling so normal Vercel-to-VM clock drift does not make a
// fresh owner click fail with "Dashboard login expiry is invalid".
export const OFFICIAL_DASHBOARD_LOGIN_TTL_MS = 30_000;

function normalizeGatewayUrl(gatewayUrl: string): string {
  const trimmed = gatewayUrl.trim();
  if (!trimmed) {
    throw new Error("Gateway URL not configured");
  }

  try {
    const parsed = new URL(trimmed);
    parsed.pathname = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    // Preserve the old failure mode for malformed URLs: the final URL
    // construction will throw, but still avoid changing non-URL strings here.
  }

  return trimmed.replace(/\/+$/, "");
}

export function resolveOfficialDashboardGatewayUrl(params: {
  gatewayUrl: string;
  instanceIpv4?: string;
}): string {
  const normalizedGatewayUrl = normalizeGatewayUrl(params.gatewayUrl);
  // Keep the issued gateway host intact. Rewriting managed HTTPS hosts to a raw IP
  // breaks the browser handoff because the dashboard certificate and session flow
  // are bound to the original gateway domain.
  return normalizedGatewayUrl;
}

export function normalizeOfficialDashboardPath(nextPath = "/"): string {
  const trimmed = nextPath.trim() || "/";
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.includes("\\")) {
    throw new Error("Official dashboard redirects must stay on the gateway host");
  }

  return trimmed;
}

function signOfficialDashboardHandoff(params: {
  apiServerKey: string;
  expiresAt: number;
  nonce: string;
  nextPath: string;
}): string {
  const payload = `${params.expiresAt}.${params.nonce}.${params.nextPath}`;
  return crypto.createHmac("sha256", params.apiServerKey).update(payload).digest("hex");
}

export function createOfficialDashboardLoginUrl(params: {
  gatewayUrl: string;
  apiServerKey: string;
  nextPath?: string;
  instanceIpv4?: string;
}): string {
  const gatewayUrl = resolveOfficialDashboardGatewayUrl({
    gatewayUrl: params.gatewayUrl,
    instanceIpv4: params.instanceIpv4,
  });
  const nextPath = normalizeOfficialDashboardPath(params.nextPath);
  const nonce = crypto.randomBytes(16).toString("hex");
  const expiresAt = Date.now() + OFFICIAL_DASHBOARD_LOGIN_TTL_MS;
  const sig = signOfficialDashboardHandoff({
    apiServerKey: params.apiServerKey,
    expiresAt,
    nonce,
    nextPath,
  });

  const loginUrl = new URL(`${gatewayUrl}/_sidecar/dashboard-login`);
  loginUrl.searchParams.set("exp", String(expiresAt));
  loginUrl.searchParams.set("nonce", nonce);
  loginUrl.searchParams.set("next", nextPath);
  loginUrl.searchParams.set("sig", sig);

  return loginUrl.toString();
}
