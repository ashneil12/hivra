/**
 * Cloudflare named-tunnel provisioning for durable per-box Hivra URLs.
 *
 * The trycloudflare quick tunnels the boxes use today get a NEW random
 * *.trycloudflare.com hostname every restart, which breaks bookmarks and resets
 * the chat-history binding on every stop/start/resize. A named tunnel gives each
 * box a stable `<slug>.<zone>` that survives restarts.
 *
 * TLS gotcha (the reason this file is fussy about hostname depth): the named
 * tunnel only handles the ORIGIN hop (edge → box). The EDGE certificate is still
 * Cloudflare's plain Universal SSL, which covers `<zone>` and `*.<zone>` ONLY —
 * one label deep. A hostname two-or-more levels under the zone (e.g.
 * `<slug>.agents.canary.<zone>`) has NO edge cert, so the browser can't even
 * TLS-handshake it and every fetch dies with "Failed to fetch". So we ALWAYS pin
 * box hostnames to exactly one label under the zone apex (see `boxHostname`),
 * folding any deeper `CLOUDFLARE_TUNNEL_DOMAIN` labels into the slug as a readable
 * namespace prefix instead of as real DNS labels.
 *
 * Requires a token with **Account → Cloudflare Tunnel → Edit** (the DNS token in
 * CLOUDFLARE_API_TOKEN is NOT enough). Configure CLOUDFLARE_TUNNEL_API_TOKEN; if
 * absent or unprivileged, `getTunnelConfig` returns null and the provisioner
 * falls back to the quick tunnel — nothing breaks, URLs just stay ephemeral.
 */

import { log } from "@/lib/logger";

const LOG_SOURCE = "cloudflare-tunnel";
const CF_API = "https://api.cloudflare.com/client/v4";

export interface CloudflareTunnelConfig {
  apiToken: string;
  accountId: string;
  zoneId: string;
  /** Desired suffix for box hostnames. Labels deeper than the zone apex are folded
   *  into the slug (see `boxHostname`), so the effective hostname is always one
   *  label under the zone. E.g. "hermesos.cloud" or "agents.canary.hermesos.cloud". */
  domain: string;
}

export function getTunnelConfig(
  env: Record<string, string | undefined> = process.env,
): CloudflareTunnelConfig | null {
  // Reuse the EXISTING CLOUDFLARE_API_TOKEN (the zone-DNS key already on Vercel)
  // — it just needs the "Account → Cloudflare Tunnel → Edit" permission ADDED to
  // it; no new key/env var. A dedicated CLOUDFLARE_TUNNEL_API_TOKEN overrides if
  // set. Account id is derived from the zone when CLOUDFLARE_ACCOUNT_ID is unset.
  const apiToken = (env.CLOUDFLARE_TUNNEL_API_TOKEN || env.CLOUDFLARE_API_TOKEN)?.trim();
  const zoneId = env.CLOUDFLARE_ZONE_ID?.trim();
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim() || "";
  const baseDomain = env.CLOUDFLARE_DNS_DOMAIN?.trim().replace(/^\.+|\.+$/g, "");
  // Universal SSL covers `*.<zone>` but NOT `*.<sub>.<zone>`, so a hostname more
  // than one label under the zone has no edge cert and won't serve. If this is set
  // deeper than the zone apex (e.g. `agents.canary.hermesos.cloud`), createBoxTunnel
  // folds the extra labels into the slug (`boxHostname`) so the final hostname stays
  // exactly one level deep. Defaults to the zone apex resolved at provision time.
  const domain = (env.CLOUDFLARE_TUNNEL_DOMAIN?.trim().replace(/^\.+|\.+$/g, "")) || baseDomain || "hermesos.cloud";
  if (!apiToken || !zoneId || !domain) return null;
  return { apiToken, accountId, zoneId, domain };
}

// One GET to /zones/<id> gives us both the account id (needed for the cfd_tunnel
// endpoints) and the zone apex name (needed to pin box hostnames one label deep so
// Universal SSL covers them). A DNS-scoped token can read this. Cached per process.
let cachedAccountId = "";
let cachedZoneName = "";
async function resolveZone(cfg: CloudflareTunnelConfig): Promise<{ accountId: string; name: string }> {
  if (cachedZoneName && (cfg.accountId || cachedAccountId)) {
    return { accountId: cfg.accountId || cachedAccountId, name: cachedZoneName };
  }
  const zone = await cf<{ name?: string; account?: { id?: string } }>(cfg, `/zones/${cfg.zoneId}`);
  cachedZoneName = zone.name ?? "";
  cachedAccountId = zone.account?.id ?? "";
  if (!cachedZoneName) throw new Error("could not read Cloudflare zone name");
  const accountId = cfg.accountId || cachedAccountId;
  if (!accountId) throw new Error("could not derive Cloudflare account id from zone");
  return { accountId, name: cachedZoneName };
}

async function resolveAccountId(cfg: CloudflareTunnelConfig): Promise<string> {
  if (cfg.accountId) return cfg.accountId;
  return (await resolveZone(cfg)).accountId;
}

/**
 * Build a box hostname that is GUARANTEED to be exactly one label under the zone
 * apex — the only depth Cloudflare Universal SSL (`*.<zone>`) serves an edge cert
 * for. Any labels in `configuredDomain` below the apex are folded into the slug as
 * a dash-joined prefix (preserved as a readable namespace, e.g.
 * `agents.canary.hermesos.cloud` + slug `box-abc` → `agents-canary-box-abc.hermesos.cloud`).
 * A `configuredDomain` that isn't under the apex at all is ignored (apex is used).
 */
export function boxHostname(slug: string, zoneApex: string, configuredDomain?: string | null): string {
  const apex = zoneApex.toLowerCase().replace(/^\.+|\.+$/g, "");
  const dom = (configuredDomain || "").toLowerCase().replace(/^\.+|\.+$/g, "");
  let prefix = "";
  if (dom && dom !== apex && dom.endsWith("." + apex)) {
    prefix = dom
      .slice(0, -(apex.length + 1)) // labels below the apex, e.g. "agents.canary"
      .replace(/[^a-z0-9-]/g, "-") // dots → dashes
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (prefix) prefix += "-";
  }
  const safeSlug =
    (prefix + slug)
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) // 63-char DNS label limit, with headroom
      .replace(/-+$/g, "") || "box"; // a mid-dash truncation must not leave a trailing dash
  return `${safeSlug}.${apex}`;
}

export function isTunnelConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return getTunnelConfig(env) !== null;
}

interface CfResponse<T> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result?: T;
}

async function cf<T>(cfg: CloudflareTunnelConfig, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${CF_API}${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(15_000),
    redirect: "error",
    headers: {
      Authorization: `Bearer ${cfg.apiToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  let body: CfResponse<T>;
  try {
    body = (await res.json()) as CfResponse<T>;
  } catch {
    throw new Error(`Cloudflare ${path} → HTTP ${res.status}: non-JSON`);
  }
  if (!res.ok || !body.success) {
    const detail = body.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ?? `HTTP ${res.status}`;
    throw new Error(`Cloudflare ${path} → ${detail}`);
  }
  return body.result as T;
}

export interface ProvisionedTunnel {
  tunnelId: string;
  /** The run token the box passes to `cloudflared tunnel run --token`. */
  token: string;
  /** The stable public hostname, one label under the zone, e.g. "box-1090.hermesos.cloud". */
  hostname: string;
  url: string;
  dnsRecordId: string;
}

export interface BoxTunnelJournal {
  beforeCreate(identity: { hostname: string }): Promise<void>;
  /** Clear an intent only when this caller has not attempted a provider POST. */
  cancelBeforeCreate(identity: { hostname: string }): Promise<void>;
  created(identity: { tunnelId: string; hostname: string }): Promise<void>;
  cleanupConfirmed(identity: { tunnelId: string; hostname: string }): Promise<void>;
}

export class BoxTunnelProvisionError extends Error {
  constructor(public readonly cleanupVerified: boolean) {
    super(cleanupVerified
      ? "Named tunnel setup failed before agent launch; no tunnel remains."
      : "Named tunnel setup is incomplete; its recorded identity must be reconciled before retrying.");
    this.name = "BoxTunnelProvisionError";
  }
}

/**
 * Create a named tunnel for one box: tunnel → remote ingress config (hostname →
 * localhost:port) → proxied CNAME to <tunnelId>.cfargotunnel.com. Returns the run
 * token (the box runs cloudflared with it) + the durable URL. Best-effort cleanup
 * on partial failure so we don't leak a tunnel without DNS or vice-versa.
 */
export async function createBoxTunnel(
  slug: string,
  opts: { port?: number; configOverride?: CloudflareTunnelConfig | null; journal?: BoxTunnelJournal } = {},
): Promise<ProvisionedTunnel | null> {
  const cfg = opts.configOverride ?? getTunnelConfig();
  if (!cfg) return null;
  const port = opts.port ?? 8080;

  let tunnelId = "";
  let dnsRecordId = "";
  let hostname = "";
  let intentStarted = false;
  let providerCreateAttempted = false;
  // A journal write may take time. Do not start a later provider request after
  // this attempt's deadline, even if that write eventually returns.
  const signal = AbortSignal.timeout(30_000);
  try {
    // Resolve the zone apex first so the hostname is pinned one label deep
    // (Universal-SSL-covered) regardless of how deep CLOUDFLARE_TUNNEL_DOMAIN is set.
    const { accountId, name: zoneApex } = await resolveZone(cfg);
    hostname = boxHostname(slug, zoneApex, cfg.domain);
    const safeSlug = hostname.slice(0, hostname.indexOf("."));
    const name = `hivra-${safeSlug}`;
    const cfgDomain = cfg.domain.toLowerCase().replace(/^\.+|\.+$/g, "");
    if (cfgDomain && cfgDomain !== zoneApex && !cfgDomain.endsWith("." + zoneApex)) {
      log.warn("CLOUDFLARE_TUNNEL_DOMAIN is not under the Cloudflare zone; pinned to zone apex", { source: LOG_SOURCE, domain: cfg.domain, zone: zoneApex });
    }
    intentStarted = true;
    await opts.journal?.beforeCreate({ hostname });
    signal.throwIfAborted();
    providerCreateAttempted = true;
    const tunnel = await cf<{ id: string; token: string }>(cfg, `/accounts/${accountId}/cfd_tunnel`, {
      method: "POST",
      body: JSON.stringify({ name, config_src: "cloudflare" }),
      signal,
    });
    tunnelId = tunnel.id;
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(tunnelId ?? "")) {
      throw new Error("Cloudflare returned an invalid tunnel identity");
    }
    await opts.journal?.created({ tunnelId, hostname });
    if (typeof tunnel.token !== "string" || !tunnel.token) throw new Error("Cloudflare returned no tunnel credential");

    await cf(cfg, `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
      method: "PUT",
      signal,
      body: JSON.stringify({
        config: {
          ingress: [
            { hostname, service: `http://localhost:${port}` },
            { service: "http_status:404" },
          ],
        },
      }),
    });

    const dns = await cf<{ id: string }>(cfg, `/zones/${cfg.zoneId}/dns_records`, {
      method: "POST",
      signal,
      body: JSON.stringify({
        type: "CNAME",
        name: hostname,
        content: `${tunnelId}.cfargotunnel.com`,
        proxied: true,
        ttl: 1,
        comment: `hivra box ${safeSlug}`,
      }),
    });
    dnsRecordId = dns.id;

    log.info("cloudflare tunnel provisioned", { source: LOG_SOURCE, hostname, tunnelId });
    return { tunnelId, token: tunnel.token, hostname, url: `https://${hostname}`, dnsRecordId };
  } catch (err) {
    if (opts.journal) {
      if (!providerCreateAttempted) {
        // The DB may have committed before its response was lost. No provider
        // POST ran, but the exact intent still has to be cleared and confirmed.
        if (intentStarted) {
          try {
            await opts.journal.cancelBeforeCreate({ hostname });
          } catch {
            throw new BoxTunnelProvisionError(false);
          }
        }
        throw new BoxTunnelProvisionError(true);
      }
      if (tunnelId) {
        try {
          const { deleteBoxTunnelVerified } = await import("./cloudflare-tunnel-cleanup");
          await deleteBoxTunnelVerified({ tunnelId, hostname }, cfg);
          await opts.journal.cleanupConfirmed({ tunnelId, hostname });
        } catch {
          throw new BoxTunnelProvisionError(false);
        }
        throw new BoxTunnelProvisionError(true);
      }
      // Unknown create outcome (including a lost POST response) retains the
      // prewritten hostname. Never convert it to an untracked quick tunnel.
      throw new BoxTunnelProvisionError(false);
    }
    log.error("cloudflare tunnel provision failed; cleaning up", err, { source: LOG_SOURCE, hostname, tunnelId });
    if (dnsRecordId) await cf(cfg, `/zones/${cfg.zoneId}/dns_records/${dnsRecordId}`, { method: "DELETE" }).catch(() => {});
    if (tunnelId) await deleteTunnelById(cfg, tunnelId).catch(() => {});
    return null;
  }
}

async function deleteTunnelById(cfg: CloudflareTunnelConfig, tunnelId: string): Promise<void> {
  const accountId = await resolveAccountId(cfg);
  // Clean up any stale connections first, then delete the tunnel.
  await cf(cfg, `/accounts/${accountId}/cfd_tunnel/${tunnelId}/connections`, { method: "DELETE" }).catch(() => {});
  await cf(cfg, `/accounts/${accountId}/cfd_tunnel/${tunnelId}`, { method: "DELETE" });
}

/** Tear down a box's tunnel + its CNAME. Best-effort; never throws. */
export async function deleteBoxTunnel(
  params: { tunnelId?: string | null; hostname?: string | null },
  configOverride?: CloudflareTunnelConfig | null,
): Promise<void> {
  const cfg = configOverride ?? getTunnelConfig();
  if (!cfg) return;
  try {
    if (params.hostname) {
      const search = new URLSearchParams({ type: "CNAME", name: params.hostname });
      const recs = await cf<Array<{ id: string }>>(cfg, `/zones/${cfg.zoneId}/dns_records?${search.toString()}`).catch(() => []);
      for (const r of recs) await cf(cfg, `/zones/${cfg.zoneId}/dns_records/${r.id}`, { method: "DELETE" }).catch(() => {});
    }
    if (params.tunnelId) await deleteTunnelById(cfg, params.tunnelId);
  } catch (err) {
    log.warn("cloudflare tunnel teardown failed; continuing", { source: LOG_SOURCE, error: err instanceof Error ? err.message : String(err) });
  }
}
