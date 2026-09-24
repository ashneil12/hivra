import net from "node:net";

/**
 * Cloudflare's published edge ranges, from https://www.cloudflare.com/ips-v4
 * and https://www.cloudflare.com/ips-v6 as last published before 2026-09-24
 * (copied into the repo; not fetched at runtime). If the deployment's origin is
 * proxied by Cloudflare, Vercel's TCP peer is one of these edges, so an
 * address inside them says nothing about the server that called. The list can
 * go stale when Cloudflare adds a range; until it is updated, a new edge range
 * would show as a server address. Update both lists together.
 */
export const CLOUDFLARE_EDGE_RANGES_CHECKED = "2026-09-24" as const;
const CLOUDFLARE_EDGE_IPV4 = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
  "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
  "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
] as const;
const CLOUDFLARE_EDGE_IPV6 = [
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32",
  "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
] as const;

const cloudflareEdges = (() => {
  const list = new net.BlockList();
  for (const range of CLOUDFLARE_EDGE_IPV4) {
    const [address, prefix] = range.split("/");
    list.addSubnet(address, Number(prefix), "ipv4");
  }
  for (const range of CLOUDFLARE_EDGE_IPV6) {
    const [address, prefix] = range.split("/");
    list.addSubnet(address, Number(prefix), "ipv6");
  }
  return list;
})();

export type TrustedClientAddress =
  | { address: string; family: 4 | 6 }
  | { address: null; family: null; reason: "not_configured" | "missing" | "invalid" | "list" | "cloudflare_edge" };

type EnvLike = Record<string, string | undefined>;

/** The one request header this deployment trusts for the calling address:
 * Vercel's own `x-vercel-forwarded-for`, or the header a self-hosted operator
 * names in HIVRA_TRUSTED_CLIENT_ADDRESS_HEADER. Null when neither applies. */
export function trustedClientAddressHeader(env: EnvLike = process.env): string | null {
  if (env.VERCEL === "1") return "x-vercel-forwarded-for";
  const configured = env.HIVRA_TRUSTED_CLIENT_ADDRESS_HEADER?.trim().toLowerCase();
  return configured && /^[a-z0-9][a-z0-9-]{0,63}$/.test(configured) ? configured : null;
}

/**
 * The address of the machine that made this request, as the platform saw it.
 * Reads exactly one header (above). `cf-connecting-ip`, `x-real-ip` and a
 * client-supplied `x-forwarded-for` are never read, because a client can set
 * them where no proxy overwrites them. A comma list, anything that is not one
 * IP address, and a Cloudflare edge address all count as "not seen". This is
 * never the rate-limit key (`getIP`) and never an address the report claims.
 */
export function trustedClientAddress(request: Request, env: EnvLike = process.env): TrustedClientAddress {
  const header = trustedClientAddressHeader(env);
  if (!header) return { address: null, family: null, reason: "not_configured" };
  const raw = request.headers.get(header);
  if (raw === null || !raw.trim()) return { address: null, family: null, reason: "missing" };
  const value = raw.trim();
  if (value.includes(",")) return { address: null, family: null, reason: "list" };
  let address = value.toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped) address = mapped[1];
  const family = net.isIP(address);
  if (family !== 4 && family !== 6) return { address: null, family: null, reason: "invalid" };
  if (cloudflareEdges.check(address, family === 4 ? "ipv4" : "ipv6")) {
    return { address: null, family: null, reason: "cloudflare_edge" };
  }
  return { address, family };
}
