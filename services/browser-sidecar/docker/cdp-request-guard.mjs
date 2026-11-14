// Request guard for the CDP host-header-fixing proxy (cdp-proxy.mjs).
//
// Chrome's DevTools endpoints only accept a `Host` that is an IP literal or
// `localhost`, which is what stops a web page from DNS-rebinding its own
// hostname onto the debugging port. The proxy rewrites `Host` before it
// forwards, so without this guard that protection is gone: any page the agent
// opens (or any sibling container) could rebind `evil.example:9224` to the
// proxy, read /json/version for the browser id, then open the WebSocket and
// drive the logged-in Chrome — every cookie and session in it. `Origin` is
// checked too, because Chrome runs with --remote-allow-origins=* and a page's
// WebSocket handshake always carries the page's Origin.
//
// Allowed hostnames are the ones a page cannot point at this proxy:
//   - IP literals and `localhost` (Chrome's own rule), and
//   - single-label names with no dot, such as the docker service name
//     `agent-<id>-browser-sidecar` that BROWSER_CDP_URL uses. Public DNS names,
//     which a rebinding attacker needs, always contain a dot.
// A request with an `Origin` is let through only when that Origin names the
// same host and port the request was sent to; a browser page on any other
// origin is refused. Non-browser CDP clients (the agent, Playwright) send no
// Origin at all.

const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const SINGLE_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function splitHostHeader(hostHeader) {
  const value = String(hostHeader || "").trim().toLowerCase();
  if (!value) return null;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 0) return null;
    const rest = value.slice(end + 1);
    if (rest && !/^:\d{1,5}$/.test(rest)) return null;
    return { hostname: value.slice(1, end), port: rest ? rest.slice(1) : "" };
  }
  const parts = value.split(":");
  if (parts.length > 2) return null;
  if (parts.length === 2 && !/^\d{1,5}$/.test(parts[1])) return null;
  return { hostname: parts[0], port: parts[1] || "" };
}

export function isAllowedCdpHostname(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return false;
  if (host === "localhost") return true;
  if (IPV4_LITERAL.test(host)) return true;
  if (host.includes(":")) return /^[0-9a-f:.]+$/.test(host); // bracketed IPv6 literal
  return SINGLE_LABEL.test(host);
}

// Returns null when the request may be proxied, or a short reason string.
export function cdpRequestRejection(headers) {
  const hostHeader = headers?.host;
  const host = splitHostHeader(hostHeader);
  if (!host || !isAllowedCdpHostname(host.hostname)) return "host-not-allowed";

  const origin = headers?.origin;
  if (origin === undefined) return null;
  let parsed;
  try {
    parsed = new URL(String(origin));
  } catch {
    return "origin-not-allowed";
  }
  const originHost = parsed.host.toLowerCase();
  if (originHost !== String(hostHeader).trim().toLowerCase()) return "origin-not-allowed";
  return null;
}
