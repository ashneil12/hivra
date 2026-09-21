import { log } from "@/lib/logger";

const LOG_SOURCE = "abuse-proxycheck";
const PROXYCHECK_BASE = "https://proxycheck.io/v2";
const REQUEST_TIMEOUT_MS = 4_000;

/**
 * Network signals returned by proxycheck.io for a given IP.
 *
 * Any field may be `null` when the upstream couldn't determine it (rare in
 * practice, but happens for private/loopback IPs and some IPv6 ranges).
 */
export interface NetworkSignals {
  ip: string;
  asn: string | null;
  asnOrganization: string | null;
  countryCode: string | null;
  isVpn: boolean;
  isProxy: boolean;
  isTor: boolean;
  isDatacenter: boolean;
  /** proxycheck's own reputation risk score, 0-100 (higher = worse). */
  upstreamRiskScore: number | null;
  /** Raw response for debugging / persistence in raw_signals. */
  raw: Record<string, unknown>;
}

/**
 * Lookup IP reputation via proxycheck.io.
 *
 * Returns `null` (rather than throwing) on:
 *   - missing PROXYCHECK_API_KEY (graceful degradation — risk scorer treats
 *     missing network signals as neutral, so the rest of the gate still works)
 *   - network errors / timeouts
 *   - upstream API errors
 *   - localhost / loopback IPs (no point checking, returns null)
 *
 * The risk scorer is responsible for deciding what to do with `null`. Today
 * it treats network=null as "no contribution to score" — fail-open. If we
 * ever decide to fail-closed on missing signals, change the scorer, not this.
 */
export async function lookupIp(ip: string): Promise<NetworkSignals | null> {
  if (isLoopbackOrPrivate(ip)) {
    return null;
  }

  const apiKey = process.env.PROXYCHECK_API_KEY;
  if (!apiKey) {
    log.warn("PROXYCHECK_API_KEY not set — skipping IP reputation check", {
      source: LOG_SOURCE,
      failureType: "proxycheck_api_key_missing",
    });
    return null;
  }

  // vpn=3: full VPN/proxy/Tor analysis
  // asn=1: include ASN/provider data
  // risk=2: include reputation risk score
  const url = `${PROXYCHECK_BASE}/${encodeURIComponent(ip)}?key=${encodeURIComponent(apiKey)}&vpn=3&asn=1&risk=2`;

  let response: Response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    log.warn("proxycheck request failed", {
      source: LOG_SOURCE,
      failureType: "proxycheck_request_failed",
      errorName: err instanceof Error ? err.name : typeof err,
    });
    return null;
  }

  if (!response.ok) {
    log.warn("proxycheck returned non-2xx", {
      source: LOG_SOURCE,
      failureType: "proxycheck_http_error",
      status: response.status,
    });
    return null;
  }

  let body: ProxycheckResponse;
  try {
    body = (await response.json()) as ProxycheckResponse;
  } catch (err) {
    log.warn("proxycheck returned invalid JSON", {
      source: LOG_SOURCE,
      failureType: "proxycheck_invalid_json",
      errorName: err instanceof Error ? err.name : typeof err,
    });
    return null;
  }

  if (body.status !== "ok") {
    // status can be "warning" (still has data) or "error"/"denied" (no data).
    // We accept "warning" since the per-IP block usually still populates.
    if (body.status !== "warning") {
      log.warn("proxycheck status not ok", {
        source: LOG_SOURCE,
        failureType: "proxycheck_status_error",
        upstreamStatus: body.status,
        upstreamMessage: body.message,
      });
      return null;
    }
  }

  const ipBlock = body[ip] as ProxycheckIpBlock | undefined;
  if (!ipBlock || typeof ipBlock !== "object") {
    return null;
  }

  // proxycheck encodes "type" in two ways depending on detection class:
  //   - VPN/Proxy: { proxy: "yes", type: "VPN" } or "Proxy"
  //   - Tor exit nodes: { proxy: "yes", type: "TOR" }
  //   - Hosting/datacenter ranges: { proxy: "yes", type: "Hosting" }
  // We normalize to four booleans so the scorer can weight them independently.
  const type = (ipBlock.type || "").toUpperCase();
  const isProxyDetected = ipBlock.proxy === "yes";
  const isVpn = isProxyDetected && type === "VPN";
  const isTor = isProxyDetected && type === "TOR";
  const isDatacenter =
    isProxyDetected && (type === "HOSTING" || type === "BUSINESS");
  // Treat any "yes" that isn't VPN/Tor/Datacenter as a generic proxy.
  const isProxy = isProxyDetected && !isVpn && !isTor && !isDatacenter;

  return {
    ip,
    asn: typeof ipBlock.asn === "string" ? ipBlock.asn : null,
    asnOrganization: typeof ipBlock.provider === "string" ? ipBlock.provider : null,
    countryCode: typeof ipBlock.isocode === "string" ? ipBlock.isocode : null,
    isVpn,
    isProxy,
    isTor,
    isDatacenter,
    upstreamRiskScore: typeof ipBlock.risk === "number" ? ipBlock.risk : null,
    raw: ipBlock as Record<string, unknown>,
  };
}

function isLoopbackOrPrivate(ip: string): boolean {
  if (!ip) return true;
  if (ip === "127.0.0.1" || ip === "::1" || ip === "0.0.0.0") return true;
  // RFC 1918 ranges — skip checking, never going to be VPN/Tor
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  // IPv6 link-local + unique-local
  if (ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) {
    return true;
  }
  return false;
}

// ── proxycheck.io response shape (subset we care about) ──────────────────────

interface ProxycheckResponse {
  status: "ok" | "warning" | "error" | "denied";
  message?: string;
  [ipKey: string]: unknown;
}

interface ProxycheckIpBlock {
  asn?: string;
  provider?: string;
  country?: string;
  isocode?: string;
  proxy?: "yes" | "no";
  type?: string;
  risk?: number;
}
