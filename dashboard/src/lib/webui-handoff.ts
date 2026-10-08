import crypto from "node:crypto";
import { appendWebUILocaleSearchParams, type Locale } from "@/lib/i18n";
import {
  appendWebUIAppearanceSearchParams,
  type WebUIAppearance,
} from "@/lib/webui-appearance";

// Match OFFICIAL_DASHBOARD_LOGIN_TTL_MS = 30_000. Sidecar tolerates expiry up
// to DASHBOARD_LOGIN_TTL_MS = 60_000 in the future, so 30s gives a 30s grace
// window for clock skew + browser request latency.
export const WEBUI_HANDOFF_TTL_MS = 30_000;
const WEBUI_STATIC_ENTRY_PATH = "/webchat";

function normalizeBaseUrlForHash(gatewayUrl: string): string {
  const trimmed = gatewayUrl.trim();
  if (!trimmed) {
    throw new Error("Gateway URL not configured");
  }
  try {
    const parsed = new URL(trimmed);
    parsed.pathname = WEBUI_STATIC_ENTRY_PATH;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return trimmed.replace(/\/+$/, "") + WEBUI_STATIC_ENTRY_PATH;
  }
}

/**
 * Hash-token iframe URL: <fqdn>/webchat#iframe_token=<bearer>.
 *
 * Pattern lifted from Moltbot/optimized-claw — token sits in the URL fragment
 * (never sent to the server, never logged), the iframe content reads it
 * client-side via location.hash and uses it as Authorization: Bearer for all
 * subsequent fetches. Avoids the third-party-cookie partition mess that
 * stymied the cookie-based handoff in Chrome M125+.
 *
 * Webui's index.html on the per-VM container is patched with a shim that
 * reads location.hash, strips it from history, and overrides fetch + XHR to
 * inject the Bearer header. Caddy's /webchat file_server path lets the
 * initial static shell load without auth; static assets were already public.
 *
 * Security note: the bearer here IS the per-instance apiServerKey, which is
 * a long-lived secret. Anyone who can read the iframe URL (e.g. browser
 * history before the shim strips it, screen recordings) can extract it.
 * createCookieBackedWebuiIframeUrl keeps it out of the request line by carrying
 * it in the login URL's fragment. Harden further by issuing a short-lived JWT
 * and having Caddy validate via forward_auth; that needs a matching change on
 * every box.
 */
function createWebuiIframeHashUrl(params: {
  gatewayUrl: string;
  apiServerKey: string;
  locale?: Locale;
  appearance?: WebUIAppearance | null;
}): { url: string } {
  const baseUrl = normalizeBaseUrlForHash(params.gatewayUrl);
  if (!params.apiServerKey || typeof params.apiServerKey !== "string") {
    throw new Error("apiServerKey is required for iframe hash URL");
  }
  let url = `${baseUrl}#iframe_token=${encodeURIComponent(params.apiServerKey)}`;
  if (params.locale) {
    url = appendWebUILocaleSearchParams(url, params.locale);
  }
  if (params.appearance) {
    url = appendWebUIAppearanceSearchParams(url, params.appearance);
  }
  return { url };
}

/**
 * Handoff URL for webfree boxes (backend "webui" and "gateway").
 *
 * The sidecar's /_sidecar/webui-login checks the signature, sets the session
 * cookie and answers 302 to `next`. The box page then reads the per-instance
 * apiServerKey from `#iframe_token=<key>`.
 *
 * The key goes in the FRAGMENT OF THE LOGIN URL, not inside `next`. It used to
 * be inside `next`, which is a query parameter, so the long-lived key was part
 * of the request line: it landed in the box's access log, in anything between
 * the browser and the box, and again in the sidecar's 302 Location header. A
 * fragment is never sent to a server. The browser keeps the fragment across the
 * redirect when the Location has none (RFC 9110 section 10.2.2, the Fetch
 * standard's HTTP-redirect fetch), so the iframe and the new tab still land on
 * /webchat#iframe_token=<key> exactly as before. Nothing changes on the box,
 * and boxes still running the older sidecar work without an update, because
 * `next` is now a plain path that every sidecar version already accepts.
 *
 * The signature covers `next` as the sidecar will see it, which is the path
 * with no fragment.
 */
export function createCookieBackedWebuiIframeUrl(params: {
  gatewayUrl: string;
  apiServerKey: string;
  locale?: Locale;
  appearance?: WebUIAppearance | null;
  now?: number;
}): { url: string; expiresAt: number; nonce: string } {
  const iframeUrl = new URL(createWebuiIframeHashUrl(params).url);
  const nextPath = `${iframeUrl.pathname}${iframeUrl.search}`;
  const login = createWebuiLoginUrl({
    gatewayUrl: params.gatewayUrl,
    apiServerKey: params.apiServerKey,
    nextPath,
    now: params.now,
  });
  const loginUrl = new URL(login.url);
  loginUrl.hash = iframeUrl.hash;
  return { ...login, url: loginUrl.toString() };
}

/**
 * Handoff URL for gateway-backend instances.
 *
 * Gateway-backend boxes (bare agent + official-dashboard web + base sidecar)
 * ship ONLY the base sidecar, whose handoff endpoint is `/dashboard-login`
 * (sets the `hermes_dashboard_session` cookie that buildAgentCaddyfile's
 * `@dashboard_browser` matcher gates on). The WebUI `/webui-login` handler
 * (WEBUI_HANDOFF_APPENDAGE) is only concatenated for webui-backend deploys, so
 * minting a `/_sidecar/webui-login` URL here lands on a path the sidecar does
 * not handle → it falls through to requireDashboardAccess → 401 → the
 * "Open this dashboard from <brand> to authenticate." page. Mint
 * `/_sidecar/dashboard-login` instead.
 *
 * The gateway web SPA self-authenticates from its server-injected session
 * token once the document loads, so there is no `#iframe_token` hash bearer in
 * the redirect target — `next` is just `/` plus the locale/appearance query.
 * That also avoids leaking the apiServerKey in the redirect Location header.
 */
export function createDashboardLoginIframeUrl(params: {
  gatewayUrl: string;
  apiServerKey: string;
  locale?: Locale;
  appearance?: WebUIAppearance | null;
  now?: number;
}): { url: string; expiresAt: number; nonce: string } {
  const iframeUrl = new URL(createWebuiIframeHashUrl(params).url);
  // Gateway-backend serves its dashboard SPA at root. Reuse the locale/appearance
  // query builder above, but do not inherit WebUI-backend's /webchat entry path
  // or the hash bearer.
  iframeUrl.pathname = "/";
  const nextPath = `${iframeUrl.pathname}${iframeUrl.search}`;
  return createWebuiLoginUrl({
    gatewayUrl: params.gatewayUrl,
    apiServerKey: params.apiServerKey,
    nextPath,
    now: params.now,
    loginPath: "/_sidecar/dashboard-login",
  });
}

export function normalizeWebuiNextPath(nextPath = "/"): string {
  const trimmed = nextPath.trim() || "/";
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.includes("\\")) {
    throw new Error("WebUI iframe redirects must stay on the gateway host");
  }
  return trimmed;
}

function normalizeWebuiBaseUrl(gatewayUrl: string): string {
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
    // Preserve the old failure mode for malformed URLs
  }

  return trimmed.replace(/\/+$/, "");
}

export function buildWebuiHandoffPayload(
  expiresAt: number,
  nonce: string,
  nextPath: string,
): string {
  return `${expiresAt}.${nonce}.${nextPath}`;
}

export function signWebuiHandoff(params: {
  apiServerKey: string;
  expiresAt: number;
  nonce: string;
  nextPath: string;
}): string {
  return crypto
    .createHmac("sha256", params.apiServerKey)
    .update(buildWebuiHandoffPayload(params.expiresAt, params.nonce, params.nextPath))
    .digest("hex");
}

export function verifyWebuiHandoffSignature(params: {
  apiServerKey: string;
  expiresAt: number;
  nonce: string;
  nextPath: string;
  signature: string;
}): boolean {
  const expected = signWebuiHandoff({
    apiServerKey: params.apiServerKey,
    expiresAt: params.expiresAt,
    nonce: params.nonce,
    nextPath: params.nextPath,
  });
  if (expected.length !== params.signature.length) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(params.signature, "hex"),
    );
  } catch {
    return false;
  }
}

export function createWebuiLoginUrl(params: {
  gatewayUrl: string;
  apiServerKey: string;
  nextPath?: string;
  now?: number;
  /**
   * Sidecar handoff path. Defaults to the WebUI handler `/_sidecar/webui-login`
   * (webui-backend). Gateway-backend boxes ship only the base sidecar, whose
   * handler is `/_sidecar/dashboard-login` — pass that for backend="gateway".
   */
  loginPath?: string;
}): { url: string; expiresAt: number; nonce: string } {
  const baseUrl = normalizeWebuiBaseUrl(params.gatewayUrl);
  const nextPath = normalizeWebuiNextPath(params.nextPath);
  const nonce = crypto.randomBytes(16).toString("hex");
  const expiresAt = (params.now ?? Date.now()) + WEBUI_HANDOFF_TTL_MS;
  const sig = signWebuiHandoff({
    apiServerKey: params.apiServerKey,
    expiresAt,
    nonce,
    nextPath,
  });

  const loginUrl = new URL(`${baseUrl}${params.loginPath ?? "/_sidecar/webui-login"}`);
  loginUrl.searchParams.set("exp", String(expiresAt));
  loginUrl.searchParams.set("nonce", nonce);
  loginUrl.searchParams.set("next", nextPath);
  loginUrl.searchParams.set("sig", sig);

  return {
    url: loginUrl.toString(),
    expiresAt,
    nonce,
  };
}
