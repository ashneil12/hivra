/**
 * Validates that a user-supplied URL is safe to fetch FROM the dashboard
 * server. The concern is server-side SSRF when the dashboard makes an
 * outbound request to a URL the user controls (custom LLM provider base
 * URL, OAuth provider base URLs returned by the user's own VM, a memory
 * backend endpoint the user types into settings, etc.).
 *
 * Every caller of this helper documents the same intent: the URL must point
 * at a *publicly reachable* host. The dashboard runs in a public cloud and
 * reaches the fleet over public hostnames, so it never legitimately needs to
 * fetch an RFC1918 / loopback / link-local / metadata address — those only
 * resolve to the dashboard's own private infrastructure (the SSRF target).
 * We therefore reject all private/reserved ranges by DEFAULT.
 *
 * What this rejects:
 *  - non-http/https schemes (`file:`, `gopher:`, `ftp:`, etc.)
 *  - Loopback (127/8, ::1), unspecified (0/8, ::), link-local (169.254/16,
 *    fe80::/10), and the cloud-metadata IP (169.254.169.254) it contains
 *  - RFC1918 private ranges (10/8, 172.16/12, 192.168/16)
 *  - CGNAT shared address space (100.64/10)
 *  - IPv6 ULA (fc00::/7) and IPv6-mapped equivalents of any blocked v4
 *
 * What this DOES NOT do:
 *  - Resolve DNS hostnames. A hostname could DNS-rebind to a private IP.
 *    Rebind-proofing requires validating the address at *connect* time;
 *    use `ssrfSafeFetch` (src/lib/ssrf-safe-fetch.ts) which does exactly
 *    that via a custom undici lookup. This pure check is the cheap
 *    first layer that rejects literal private IPs before any request.
 *
 * Returned `reason` is intentionally not echoed to clients verbatim; it's
 * stable identifier text for logs/tests.
 */

export type UrlSafetyResult =
  | { ok: true }
  | { ok: false; reason: string };

export interface UrlSafetyOptions {
  /**
   * Escape hatch for the rare caller that genuinely needs to reach a private
   * address (none in this repo today — every caller wants a public host).
   * Defaults to false: private/reserved ranges are rejected.
   */
  allowPrivateNetwork?: boolean;
}

/**
 * Classifies a bare IP address (v4 or v6 textual form) as a private/reserved
 * range that the dashboard must never fetch. Returns a stable reason string
 * when the address is blocked, or null when it is a public address.
 *
 * Shared by `checkOutboundUrlSafety` (URL-literal pre-check) and the
 * connect-time `lookup` validator in ssrf-safe-fetch.ts, so both layers agree
 * on exactly which addresses are off-limits.
 */
export function reservedAddressReason(rawAddress: string): string | null {
  const address = rawAddress?.trim().toLowerCase();
  if (!address) return null;

  // Plain IPv4 dotted quad.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) {
    return reservedIpv4Reason(address);
  }

  // IPv6 forms (only reached for colon-bearing hosts).
  if (address.includes(":")) {
    const hextets = parseIpv6Hextets(address);
    if (!hextets) return null;

    // Detect mapped and deprecated compatible forms after expansion, not by a
    // textual ::ffff: prefix. Full spellings such as
    // 0:0:0:0:0:ffff:7f00:1 reach the same IPv4 socket destination.
    const mappedV4 = ipv4FromIpv6Hextets(hextets);
    if (mappedV4) {
      const v4Reason = reservedIpv4Reason(mappedV4);
      if (v4Reason) return `ipv6_mapped_${v4Reason}`;
    }

    return reservedIpv6Reason(hextets);
  }

  return null;
}

function reservedIpv4Reason(ip: string): string | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!match) return null;
  const octets = match.slice(1, 5).map((part) => Number.parseInt(part, 10));
  if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return null;
  }
  const [a, b] = octets;

  if (a === 0) return "unspecified"; // 0.0.0.0/8 "this network"
  if (a === 10) return "private_v4"; // 10.0.0.0/8
  if (a === 127) return "loopback_v4"; // 127.0.0.0/8
  if (a === 169 && b === 254) return "link_local_v4"; // 169.254.0.0/16 (incl. metadata)
  if (a === 172 && b >= 16 && b <= 31) return "private_v4"; // 172.16.0.0/12
  if (a === 192 && b === 168) return "private_v4"; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return "cgnat_v4"; // 100.64.0.0/10

  return null;
}

function reservedIpv6Reason(hextets: number[]): string | null {
  // Loopback / unspecified.
  if (hextets.slice(0, 7).every((part) => part === 0) && hextets[7] <= 1) {
    return "loopback_v6";
  }
  // Link-local fe80::/10.
  if ((hextets[0] & 0xffc0) === 0xfe80) {
    return "link_local_v6";
  }
  // Unique-local fc00::/7. Includes the AWS IPv6 metadata fd00:ec2::254.
  if ((hextets[0] & 0xfe00) === 0xfc00) {
    return "unique_local_v6";
  }
  return null;
}

function parseIpv4Octets(address: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!match) return null;
  const octets = match.slice(1, 5).map((part) => Number.parseInt(part, 10));
  return octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? octets
    : null;
}

function parseIpv6Hextets(rawAddress: string): number[] | null {
  const address = rawAddress.split("%", 1)[0];
  let normalized = address;
  const lastColon = normalized.lastIndexOf(":");
  const dottedTail = normalized.slice(lastColon + 1);
  if (dottedTail.includes(".")) {
    const octets = parseIpv4Octets(dottedTail);
    if (!octets) return null;
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    normalized = `${normalized.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const compressed = normalized.split("::");
  if (compressed.length > 2) return null;
  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const parts = side.split(":");
    if (!parts.every((part) => /^[0-9a-f]{1,4}$/.test(part))) return null;
    return parts.map((part) => Number.parseInt(part, 16));
  };
  const left = parseSide(compressed[0]);
  const right = parseSide(compressed[1] ?? "");
  if (!left || !right) return null;
  if (compressed.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...Array<number>(missing).fill(0), ...right];
}

function ipv4FromIpv6Hextets(hextets: number[]): string | null {
  const mappedPrefix = hextets.slice(0, 5).every((part) => part === 0)
    && hextets[5] === 0xffff;
  const compatiblePrefix = hextets.slice(0, 6).every((part) => part === 0);
  if (!mappedPrefix && !compatiblePrefix) return null;
  const octets = [
    (hextets[6] >> 8) & 0xff,
    hextets[6] & 0xff,
    (hextets[7] >> 8) & 0xff,
    hextets[7] & 0xff,
  ];
  return octets.join(".");
}

export function checkOutboundUrlSafety(
  rawUrl: string,
  options: UrlSafetyOptions = {},
): UrlSafetyResult {
  const trimmed = rawUrl?.trim();
  if (!trimmed) {
    return { ok: false, reason: "empty" };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "unsupported_scheme" };
  }

  // strip [...] from IPv6 hostnames
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) {
    return { ok: false, reason: "missing_host" };
  }

  // localhost and aliases (resolve to loopback; never a real public host)
  if (host === "localhost" || host === "ip6-localhost") {
    return { ok: false, reason: "loopback_alias" };
  }

  if (!options.allowPrivateNetwork) {
    const reason = reservedAddressReason(host);
    if (reason) {
      return { ok: false, reason };
    }
  }

  return { ok: true };
}
