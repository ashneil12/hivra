// SSRF navigation guard for the browser-sidecar.
//
// The sidecar drives a real browser inside the tenant VM's network namespace,
// so a /goto (or a flow `goto` step) must not be pointable at:
//  - loopback / the unspecified address (sidecar's own debug ports, sibling
//    sockets on lo),
//  - the cloud / hypervisor metadata endpoint (169.254.169.254 and the
//    link-local range it lives in),
//  - the docker-bridge names of sibling Hermes services (warden, the
//    dashboard sidecar, autoheal, the agent, etc.).
//
// RFC1918 ranges are INTENTIONALLY allowed — agents may legitimately drive a
// tenant-owned LAN service via this VM.
//
// The guard normalizes the host before matching so it can't be bypassed with
// IPv4-mapped IPv6 (`http://[::ffff:127.0.0.1]/`, `http://[::ffff:169.254.169.254]/`)
// or the unspecified address (`http://[::]/`), which Node's URL parser leaves
// as distinct hostnames that literal-string matching would miss.

const BLOCKED_HOSTS = new Set<string>([
  "warden",
  "dashboard-sidecar",
  "autoheal",
  "official-dashboard",
  "browser-sidecar",
  "webui",
  "hermes-webui",
  "hermes-agent",
  // Cloud / hypervisor metadata endpoints.
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.tencentyun.com",
  "instance-data",
]);

function stripBrackets(host: string): string {
  return host.replace(/^\[/, "").replace(/\]$/, "");
}

// If `host` is an IPv4-mapped IPv6 address (`::ffff:a.b.c.d` or its canonical
// hex `::ffff:7f00:1` form), return the embedded dotted IPv4; otherwise null.
function embeddedMappedIpv4(host: string): string | null {
  if (!host.startsWith("::ffff:")) return null;
  const tail = host.slice("::ffff:".length);
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(tail)) return tail;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
  if (!hex) return null;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join(".");
}

function isLoopbackOrUnspecified(host: string): boolean {
  if (host === "localhost") return true;
  if (host === "127.0.0.1" || host.startsWith("127.")) return true;
  if (host === "::1") return true;
  if (host === "0.0.0.0" || host === "::") return true;
  return false;
}

// 169.254.0.0/16 — link-local. The cloud metadata IP (169.254.169.254) lives
// here, and link-local is never a legitimate navigation target.
function isLinkLocal(host: string): boolean {
  return /^169\.254\./.test(host);
}

export function isBlockedNavigationHost(hostname: string): boolean {
  const lower = stripBrackets(hostname.toLowerCase().trim());
  if (!lower) return true;
  // Resolve IPv4-mapped IPv6 so the v4 loopback/link-local rules apply to
  // `::ffff:127.0.0.1`, `::ffff:169.254.169.254`, etc.
  const candidate = embeddedMappedIpv4(lower) ?? lower;
  if (isLoopbackOrUnspecified(candidate)) return true;
  if (isLinkLocal(candidate)) return true;
  if (BLOCKED_HOSTS.has(candidate)) return true;
  if (BLOCKED_HOSTS.has(lower)) return true;
  return false;
}

export type NavigationBlockCode = "INVALID_URL" | "UNSUPPORTED_SCHEME" | "BLOCKED_DESTINATION";

export class BlockedNavigationError extends Error {
  constructor(public readonly code: NavigationBlockCode) {
    super(code);
    this.name = "BlockedNavigationError";
  }
}

// Parse + validate a navigation target exactly the way the /goto route does,
// so the flow runner's `goto` step enforces the same policy. Throws
// BlockedNavigationError on rejection; returns the parsed URL on success.
export function assertNavigationAllowed(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BlockedNavigationError("INVALID_URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BlockedNavigationError("UNSUPPORTED_SCHEME");
  }
  if (isBlockedNavigationHost(parsed.hostname)) {
    throw new BlockedNavigationError("BLOCKED_DESTINATION");
  }
  return parsed;
}
