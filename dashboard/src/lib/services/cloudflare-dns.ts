/**
 * Cloudflare DNS integration for per-instance A records on hermesos.cloud.
 * Reads CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID, CLOUDFLARE_DNS_DOMAIN,
 * and optional CLOUDFLARE_DNS_PROXIED.
 *
 * Replaces the prior `<dashed-ip>.sslip.io` gateway hostnames for instances
 * whose subdomain we control. The 2026-04-30 outage was caused by minting
 * `<sub>.hermesos.cloud` URLs without ever creating A records — every fetch
 * hit NXDOMAIN. This module is the wiring that comment forbids reintroducing
 * the dnsDomain branch without: it creates records, verifies propagation,
 * and rolls back on failure so callers can fall back to sslip.
 *
 * Design rules:
 *  - Pure environment-driven config. If any of CLOUDFLARE_API_TOKEN,
 *    CLOUDFLARE_ZONE_ID, or CLOUDFLARE_DNS_DOMAIN is missing, the
 *    integration is "not configured" and callers fall back to sslip.
 *  - Mint creates the record AND verifies propagation against 1.1.1.1
 *    before returning ok. If verify times out, the just-created record is
 *    rolled back so the next attempt starts from a clean slate.
 *  - Idempotent: a stale record from a failed provision (same IP) is
 *    adopted, not duplicated.
 */

import { Resolver } from "node:dns/promises";
import { log } from "@/lib/logger";

// SCRIPTURE_ANCHOR: dns-name | Genesis 2:19 | Verse: Whatever the man called every living creature, that was its name.
const LOG_SOURCE = "cloudflare-dns";
const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

// Cloudflare convention: ttl=1 means "automatic" (~5 minutes). Lower than
// that requires a paid plan; we don't need lower for instance churn.
const DEFAULT_TTL = 1;
const DEFAULT_PROPAGATION_TIMEOUT_MS = 30_000;
const DEFAULT_PROPAGATION_POLL_INTERVAL_MS = 1_000;
const DEFAULT_RESOLVERS = ["1.1.1.1", "1.0.0.1"];

export interface CloudflareDnsConfig {
  apiToken: string;
  zoneId: string;
  domain: string;
  proxied?: boolean;
}

function envFlag(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}

export function getCloudflareDnsConfig(
  env: Record<string, string | undefined> = process.env,
): CloudflareDnsConfig | null {
  const apiToken = env.CLOUDFLARE_API_TOKEN?.trim();
  const zoneId = env.CLOUDFLARE_ZONE_ID?.trim();
  const domain = env.CLOUDFLARE_DNS_DOMAIN?.trim().replace(/^\.+|\.+$/g, "");
  if (!apiToken || !zoneId || !domain) return null;
  return { apiToken, zoneId, domain, proxied: envFlag(env.CLOUDFLARE_DNS_PROXIED) };
}

export function isCloudflareDnsConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return getCloudflareDnsConfig(env) !== null;
}

/**
 * Inspect an instance's persisted gateway URL and return the EXACT domain
 * portion after the instance's subdomain — i.e. everything to the right
 * of the leftmost label. Pass the result back into
 * `resolveGatewayConfiguration({ ..., dnsDomain })` from redeploy /
 * resync paths so the rebuilt FQDN matches what's already running on
 * the box.
 *
 * Returns the EXACT existing domain (not just the configured Cloudflare
 * zone) because instances may live under sub-subdomains of the zone —
 * e.g. legacy per-host wildcards `<inst>.fixturenodea.agents.hermesos.cloud`
 * predating this Cloudflare integration. Returning just the configured
 * `CLOUDFLARE_DNS_DOMAIN` would re-derive `<inst>.agents.hermesos.cloud`
 * and silently flip the running instance to a different URL.
 *
 * Returns null (caller falls back to sslip) when:
 *  - Cloudflare isn't configured in env.
 *  - The gateway URL or subdomain is missing.
 *  - The URL hostname doesn't start with `<subdomain>.`.
 *  - The remainder isn't under the configured Cloudflare namespace and
 *    doesn't exactly match the operator-configured Proxmox gateway domain
 *    (so we don't claim DNS we don't own).
 */
export function deriveDnsDomainFromGatewayUrl(
  gatewayUrl: string | null | undefined,
  subdomain: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (!gatewayUrl || !subdomain) return null;
  const config = getCloudflareDnsConfig(env);
  if (!config) return null;
  try {
    const hostname = new URL(gatewayUrl).hostname.toLowerCase();
    const sub = subdomain.toLowerCase();
    const prefix = `${sub}.`;
    if (!hostname.startsWith(prefix)) return null;
    const domain = hostname.slice(prefix.length);
    const zone = config.domain.toLowerCase();
    const proxmoxGatewayDomain = env.PROXMOX_GATEWAY_DOMAIN
      ?.trim()
      .replace(/^\.+|\.+$/g, "")
      .toLowerCase();
    if (
      domain === zone ||
      domain.endsWith(`.${zone}`) ||
      (proxmoxGatewayDomain && domain === proxmoxGatewayDomain)
    ) {
      return domain;
    }
  } catch {
    // Malformed gateway_url — treat as sslip path (return null).
  }
  return null;
}

interface CloudflareApiResponse<T> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result?: T;
}

export interface CloudflareDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied?: boolean;
  /** ISO-8601. Returned by list endpoints; absent from create/update responses. */
  created_on?: string;
}

async function cfFetch<T>(
  config: CloudflareDnsConfig,
  path: string,
  init: RequestInit = {},
): Promise<CloudflareApiResponse<T>> {
  const res = await fetch(`${CLOUDFLARE_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  let body: CloudflareApiResponse<T>;
  try {
    body = (await res.json()) as CloudflareApiResponse<T>;
  } catch {
    throw new Error(`Cloudflare API ${path} → HTTP ${res.status}: non-JSON response`);
  }
  if (!res.ok || !body.success) {
    const detail =
      body.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ?? `HTTP ${res.status}`;
    throw new Error(`Cloudflare API ${path} → ${detail}`);
  }
  return body;
}

export async function createDnsRecord(
  config: CloudflareDnsConfig,
  params: { fqdn: string; ip: string; comment?: string; proxied?: boolean },
): Promise<{ id: string }> {
  const proxied = params.proxied ?? config.proxied ?? false;
  const body = await cfFetch<CloudflareDnsRecord>(
    config,
    `/zones/${config.zoneId}/dns_records`,
    {
      method: "POST",
      body: JSON.stringify({
        type: "A",
        name: params.fqdn,
        content: params.ip,
        ttl: DEFAULT_TTL,
        proxied,
        ...(params.comment ? { comment: params.comment } : {}),
      }),
    },
  );
  if (!body.result?.id) {
    throw new Error(`Cloudflare API returned no record id for ${params.fqdn}`);
  }
  return { id: body.result.id };
}

export async function updateDnsRecordProxyState(
  config: CloudflareDnsConfig,
  recordId: string,
  proxied: boolean,
): Promise<void> {
  await cfFetch<CloudflareDnsRecord>(
    config,
    `/zones/${config.zoneId}/dns_records/${recordId}`,
    {
      method: "PATCH",
      body: JSON.stringify({ proxied }),
    },
  );
}

/**
 * Repoint an existing A record to a new origin IP (and proxy state). Used when
 * an instance moves hosts (recreate / migration) so the existing record is
 * corrected in place rather than leaving a stale record alongside a freshly
 * created one — the split-brain that 404'd instance fixturecase13 on 2026-05-20.
 */
async function updateDnsRecordContent(
  config: CloudflareDnsConfig,
  recordId: string,
  params: { ip: string; proxied?: boolean; comment?: string },
): Promise<void> {
  const proxied = params.proxied ?? config.proxied ?? false;
  await cfFetch<CloudflareDnsRecord>(
    config,
    `/zones/${config.zoneId}/dns_records/${recordId}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        type: "A",
        content: params.ip,
        ttl: DEFAULT_TTL,
        proxied,
        ...(params.comment ? { comment: params.comment } : {}),
      }),
    },
  );
}

export async function findDnsRecord(
  config: CloudflareDnsConfig,
  fqdn: string,
): Promise<CloudflareDnsRecord | null> {
  const search = new URLSearchParams({ type: "A", name: fqdn });
  const body = await cfFetch<CloudflareDnsRecord[]>(
    config,
    `/zones/${config.zoneId}/dns_records?${search.toString()}`,
  );
  return body.result?.[0] ?? null;
}

/**
 * Return EVERY A record for an exact fqdn. `findDnsRecord` only returns the
 * first, which hides the duplicate-record / split-brain case that mintInstanceDns
 * must reconcile on a host move.
 */
async function findAllDnsRecords(
  config: CloudflareDnsConfig,
  fqdn: string,
): Promise<CloudflareDnsRecord[]> {
  const search = new URLSearchParams({ type: "A", name: fqdn });
  const body = await cfFetch<CloudflareDnsRecord[]>(
    config,
    `/zones/${config.zoneId}/dns_records?${search.toString()}`,
  );
  return body.result ?? [];
}

interface CloudflareListResultInfo {
  page: number;
  per_page: number;
  total_pages: number;
  count: number;
  total_count: number;
}

interface CloudflareListResponse<T> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result?: T;
  result_info?: CloudflareListResultInfo;
}

export interface ListDnsRecordsOptions {
  /** Match record names ending with this suffix (e.g. ".agents.hermesos.cloud"). */
  nameSuffix?: string;
  /** Page size for the Cloudflare API; CF caps this at 5000. */
  perPage?: number;
  /** Hard cap on total records fetched, defensive against runaway zones. */
  maxRecords?: number;
}

const LIST_DEFAULT_PER_PAGE = 1000;
const LIST_DEFAULT_MAX_RECORDS = 10_000;

export async function listAllDnsRecords(
  config: CloudflareDnsConfig,
  options: ListDnsRecordsOptions = {},
): Promise<CloudflareDnsRecord[]> {
  const perPage = options.perPage ?? LIST_DEFAULT_PER_PAGE;
  const maxRecords = options.maxRecords ?? LIST_DEFAULT_MAX_RECORDS;
  const all: CloudflareDnsRecord[] = [];
  for (let page = 1; ; page += 1) {
    const search = new URLSearchParams({
      type: "A",
      page: String(page),
      per_page: String(perPage),
    });
    if (options.nameSuffix) {
      search.set("name.endswith", options.nameSuffix);
    }
    const res = await fetch(
      `${CLOUDFLARE_API_BASE}/zones/${config.zoneId}/dns_records?${search.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
          "Content-Type": "application/json",
        },
      },
    );
    let body: CloudflareListResponse<CloudflareDnsRecord[]>;
    try {
      body = (await res.json()) as CloudflareListResponse<CloudflareDnsRecord[]>;
    } catch {
      throw new Error(`Cloudflare list ${page} → HTTP ${res.status}: non-JSON response`);
    }
    if (!res.ok || !body.success) {
      const detail =
        body.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ?? `HTTP ${res.status}`;
      throw new Error(`Cloudflare list page ${page} → ${detail}`);
    }
    const batch = body.result ?? [];
    for (const r of batch) {
      all.push(r);
      if (all.length >= maxRecords) return all;
    }
    const info = body.result_info;
    if (!info || info.total_pages === 0 || page >= info.total_pages || batch.length === 0) {
      return all;
    }
  }
}

export async function deleteDnsRecordById(
  config: CloudflareDnsConfig,
  recordId: string,
): Promise<void> {
  await cfFetch<{ id: string }>(
    config,
    `/zones/${config.zoneId}/dns_records/${recordId}`,
    { method: "DELETE" },
  );
}

export interface VerifyDnsPropagationOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  resolverIps?: string[];
  /** Override for tests — if provided, used instead of node:dns. */
  resolve4?: (fqdn: string) => Promise<string[]>;
}

export async function verifyDnsPropagation(
  fqdn: string,
  expectedIp: string,
  options: VerifyDnsPropagationOptions = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROPAGATION_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_PROPAGATION_POLL_INTERVAL_MS;
  const resolve4 =
    options.resolve4 ??
    (() => {
      const resolver = new Resolver();
      resolver.setServers(options.resolverIps ?? DEFAULT_RESOLVERS);
      return resolver.resolve4(fqdn);
    });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ips = await resolve4(fqdn);
      if (ips.includes(expectedIp)) return true;
    } catch {
      // ENOTFOUND / SERVFAIL while propagating — keep polling.
    }
    if (Date.now() + pollIntervalMs >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return false;
}

export interface MintInstanceDnsParams {
  subdomain: string;
  ip: string;
  comment?: string;
  /** Skip the propagation verify step. Default: false (verify on). */
  skipVerify?: boolean;
  /**
   * Create a proxied Cloudflare record. DNS verification cannot compare the
   * public answer to the origin IP in this mode because Cloudflare returns
   * edge IPs, so successful API creation/adoption is the verification point.
   */
  proxied?: boolean;
  /** Override propagation timeout (ms). */
  propagationTimeoutMs?: number;
  /** Test seam for the resolver. */
  resolve4?: VerifyDnsPropagationOptions["resolve4"];
}

export interface MintInstanceDnsResult {
  ok: boolean;
  fqdn?: string;
  recordId?: string;
  error?: string;
}

/**
 * Create-and-verify an A record for `<subdomain>.<CLOUDFLARE_DNS_DOMAIN>`
 * pointing at `ip`. If the record already exists with the same IP from a
 * prior failed provision, it is adopted. If verification fails, the record
 * is rolled back. Returns ok=false (with a reason) so the caller can fall
 * back to sslip.
 */
export async function mintInstanceDns(
  params: MintInstanceDnsParams,
  configOverride?: CloudflareDnsConfig | null,
): Promise<MintInstanceDnsResult> {
  const config = configOverride ?? getCloudflareDnsConfig();
  if (!config) return { ok: false, error: "cloudflare_not_configured" };
  const fqdn = `${params.subdomain}.${config.domain}`;
  const proxied = params.proxied ?? config.proxied ?? false;

  // Idempotent reconcile. Cloudflare permits multiple A records for one name,
  // so a blind create on a host move (recreate / migration) leaves the OLD
  // record in place → split-brain round-robin where ~half the requests hit a
  // dead origin and 404. (Observed 2026-05-20: instance fixturecase13 recreated
  // onto fixturenodea kept a stale fixturenodea A record and 404'd until the dup was removed.)
  // Reconcile every existing record: keep one, repoint it to the new IP,
  // delete the rest; only create when none exist.
  let recordId: string;
  const existingRecords = await findAllDnsRecords(config, fqdn).catch(
    () => [] as CloudflareDnsRecord[],
  );

  if (existingRecords.length > 0) {
    const [primary, ...duplicates] = existingRecords;
    for (const dup of duplicates) {
      try {
        await deleteDnsRecordById(config, dup.id);
        log.warn("cloudflare DNS removed duplicate record", {
          source: LOG_SOURCE,
          fqdn,
          ip: params.ip,
          removedRecordId: dup.id,
          removedContent: dup.content,
          keptRecordId: primary.id,
        });
      } catch (deleteErr) {
        // Non-fatal: a leftover dup is worse than the primary being wrong,
        // but the primary repoint below is what unblocks routing. Log and
        // let the reconcile-cloudflare-dns GC mop up later.
        log.error("cloudflare DNS duplicate record delete failed", deleteErr, {
          source: LOG_SOURCE,
          fqdn,
          recordId: dup.id,
        });
      }
    }

    if (primary.content !== params.ip || Boolean(primary.proxied) !== proxied) {
      try {
        await updateDnsRecordContent(config, primary.id, {
          ip: params.ip,
          proxied,
          comment: params.comment,
        });
      } catch (updateErr) {
        log.error("cloudflare DNS existing record repoint failed", updateErr, {
          source: LOG_SOURCE,
          fqdn,
          ip: params.ip,
          recordId: primary.id,
          previousContent: primary.content,
        });
        return {
          ok: false,
          error: updateErr instanceof Error ? updateErr.message : String(updateErr),
        };
      }
      log.info("cloudflare DNS repointed existing record", {
        source: LOG_SOURCE,
        fqdn,
        ip: params.ip,
        recordId: primary.id,
        previousContent: primary.content,
        proxied,
      });
    } else {
      log.info("cloudflare DNS adopting existing record", {
        source: LOG_SOURCE,
        fqdn,
        ip: params.ip,
        recordId: primary.id,
        proxied,
      });
    }
    recordId = primary.id;
  } else {
    try {
      const created = await createDnsRecord(config, {
        fqdn,
        ip: params.ip,
        comment: params.comment,
        proxied,
      });
      recordId = created.id;
    } catch (createErr) {
      // Race: another writer created the record between our list and create.
      // Re-find and repoint rather than failing the caller to sslip.
      const raced = await findDnsRecord(config, fqdn).catch(() => null);
      if (raced) {
        if (raced.content !== params.ip || Boolean(raced.proxied) !== proxied) {
          try {
            await updateDnsRecordContent(config, raced.id, {
              ip: params.ip,
              proxied,
              comment: params.comment,
            });
          } catch (updateErr) {
            log.error("cloudflare DNS raced record repoint failed", updateErr, {
              source: LOG_SOURCE,
              fqdn,
              ip: params.ip,
              recordId: raced.id,
            });
            return {
              ok: false,
              error: updateErr instanceof Error ? updateErr.message : String(updateErr),
            };
          }
        }
        log.info("cloudflare DNS adopted raced record", {
          source: LOG_SOURCE,
          fqdn,
          ip: params.ip,
          recordId: raced.id,
          proxied,
        });
        recordId = raced.id;
      } else {
        log.error("cloudflare DNS create failed", createErr, {
          source: LOG_SOURCE,
          fqdn,
          ip: params.ip,
        });
        return {
          ok: false,
          error: createErr instanceof Error ? createErr.message : String(createErr),
        };
      }
    }
  }

  if (proxied) {
    log.info("cloudflare DNS record is proxied; origin-IP DNS propagation check skipped", {
      source: LOG_SOURCE,
      fqdn,
      ip: params.ip,
      recordId,
    });
    return { ok: true, fqdn, recordId };
  }

  if (params.skipVerify) {
    return { ok: true, fqdn, recordId };
  }

  const propagated = await verifyDnsPropagation(fqdn, params.ip, {
    timeoutMs: params.propagationTimeoutMs,
    resolve4: params.resolve4,
  });

  if (!propagated) {
    log.warn("cloudflare DNS did not propagate within timeout; rolling back record", {
      source: LOG_SOURCE,
      fqdn,
      ip: params.ip,
      recordId,
    });
    await deleteDnsRecordById(config, recordId).catch((err) => {
      log.error("cloudflare DNS rollback delete failed", err, {
        source: LOG_SOURCE,
        fqdn,
        recordId,
      });
    });
    return { ok: false, error: "dns_propagation_timeout" };
  }

  return { ok: true, fqdn, recordId };
}

/**
 * Remove the A record for `<subdomain>.<CLOUDFLARE_DNS_DOMAIN>`. Safe
 * to call on instances that were minted under sslip — those won't have a
 * matching record and the call returns ok=true without doing anything.
 */
export async function removeInstanceDns(
  subdomain: string,
  configOverride?: CloudflareDnsConfig | null,
): Promise<{ ok: boolean; removed?: boolean; error?: string }> {
  const config = configOverride ?? getCloudflareDnsConfig();
  if (!config) return { ok: false, error: "cloudflare_not_configured" };
  const fqdn = `${subdomain}.${config.domain}`;
  try {
    const record = await findDnsRecord(config, fqdn);
    if (!record) return { ok: true, removed: false };
    await deleteDnsRecordById(config, record.id);
    return { ok: true, removed: true };
  } catch (err) {
    log.error("cloudflare DNS remove failed", err, { source: LOG_SOURCE, fqdn });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface RemoveInstanceDnsBestEffortContext {
  source: string;
  instanceId?: string;
  userId?: string | null;
  route?: string;
  hostId?: string;
  /**
   * Extra structured fields are forwarded to the log line — callers can
   * spread their full RequestContext (requestId, method, traceId) without
   * extracting individual fields.
   */
  [key: string]: unknown;
}

/**
 * Best-effort DNS cleanup wrapper used by every instance-destroy path. A
 * stale A record after teardown wastes a slot on the zone's record cap
 * (200 on Free, 3500 on Pro — the 2026-05-17 hermesos.cloud incident was
 * the cap going saturated). The cleanup must never block the destroy
 * itself: the VM is already gone, a stale record points nowhere, and a
 * follow-up sweep can mop it up. Instances on sslip have no matching
 * record and removeInstanceDns is a no-op for them.
 *
 * Returns void and never throws. Callers should not wrap the call in
 * try/catch or `.catch(...)`.
 */
export async function removeInstanceDnsBestEffort(
  subdomain: string | null | undefined,
  ctx: RemoveInstanceDnsBestEffortContext,
  options: { dnsDomain?: string | null } = {},
): Promise<void> {
  if (!subdomain) return;
  const baseConfig = getCloudflareDnsConfig();
  const dnsDomain = options.dnsDomain?.trim().replace(/^\.+|\.+$/g, "");
  const config =
    baseConfig && dnsDomain
      ? { ...baseConfig, domain: dnsDomain }
      : undefined;
  const result = await removeInstanceDns(subdomain, config).catch((err) => ({
    ok: false as const,
    error: err instanceof Error ? err.message : String(err),
  }));
  if (!result.ok) {
    log.warn("cloudflare DNS cleanup failed; continuing", {
      ...ctx,
      failureType: "cloudflare_dns_cleanup_failed",
      error: result.error,
    });
  }
}
