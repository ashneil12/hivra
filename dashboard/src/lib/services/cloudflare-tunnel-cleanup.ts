import "server-only";

import { getTunnelConfig, type CloudflareTunnelConfig } from "./cloudflare-tunnel";

const CF_API = "https://api.cloudflare.com/client/v4";
const ID = /^[a-f0-9]{32}$/i;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

class CloudflareTunnelCleanupError extends Error {
  constructor(public readonly stage: string) {
    // Never include the credential, provider body, or a request URL in errors.
    super(`Cloudflare cleanup could not be verified (${stage}).`);
    this.name = "CloudflareTunnelCleanupError";
  }
}

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ObjectValue : {};
}

/**
 * Strict deletion for the durable agent lifecycle. The legacy best-effort
 * helper is deliberately not used: an unavailable API is not evidence that
 * access is gone. Safe to call again after a partial or interrupted deletion.
 */
export async function deleteBoxTunnelVerified(
  params: { tunnelId?: string | null; hostname?: string | null },
  config: CloudflareTunnelConfig | null = getTunnelConfig(),
): Promise<void> {
  if (!params.tunnelId && !params.hostname) return;
  const tunnelId = params.tunnelId?.toLowerCase();
  const hostname = params.hostname?.toLowerCase();
  if (!tunnelId || !UUID.test(tunnelId) || !hostname || !HOSTNAME.test(hostname)) {
    throw new CloudflareTunnelCleanupError("resource_identity");
  }
  if (!config || !ID.test(config.zoneId) || (config.accountId && !ID.test(config.accountId))) {
    throw new CloudflareTunnelCleanupError("configuration");
  }

  // One finite budget for the entire cleanup, including response body reads.
  const signal = AbortSignal.timeout(20_000);
  async function request(path: string, stage: string, method = "GET"): Promise<ObjectValue> {
    try {
      const response = await fetch(`${CF_API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${config!.apiToken}`, "Content-Type": "application/json" },
        signal,
        redirect: "error",
        cache: "no-store",
      });
      const body = object(await response.json());
      if (!response.ok || body.success !== true || !("result" in body)) throw new Error();
      return body;
    } catch {
      throw new CloudflareTunnelCleanupError(stage);
    }
  }

  const zone = object((await request(`/zones/${config.zoneId}`, "zone_read")).result);
  const accountId = object(zone.account).id;
  if (typeof accountId !== "string" || !ID.test(accountId) ||
      (config.accountId && accountId !== config.accountId) ||
      typeof zone.name !== "string" || !hostname.endsWith(`.${zone.name.toLowerCase()}`)) {
    throw new CloudflareTunnelCleanupError("zone_identity");
  }

  const tunnelPath = `/accounts/${accountId}/cfd_tunnel/${tunnelId}`;
  async function readTunnel(): Promise<ObjectValue> {
    const tunnel = object((await request(tunnelPath, "tunnel_read")).result);
    if (tunnel.id !== tunnelId || tunnel.account_tag !== accountId ||
        !(tunnel.deleted_at === null || (typeof tunnel.deleted_at === "string" &&
          Number.isFinite(Date.parse(tunnel.deleted_at))))) {
      throw new CloudflareTunnelCleanupError("tunnel_evidence");
    }
    return tunnel;
  }

  const search = new URLSearchParams({ name: hostname, page: "1", per_page: "100" });
  const dnsPath = `/zones/${config.zoneId}/dns_records?${search}`;
  async function readDns(): Promise<ObjectValue[]> {
    const body = await request(dnsPath, "dns_read");
    const info = object(body.result_info);
    if (!Array.isArray(body.result) || body.result.length > 100 ||
        info.page !== 1 || info.count !== body.result.length ||
        info.total_count !== body.result.length ||
        (info.total_pages !== 0 && info.total_pages !== 1)) {
      throw new CloudflareTunnelCleanupError("dns_evidence");
    }
    return body.result.map(object);
  }

  const tunnel = await readTunnel();
  const records = await readDns();
  // Check every record before mutation. Refuse already-repointed or reused
  // names. Cloudflare does not offer a conditional DNS DELETE: concurrent
  // external edits to these Hivra-owned records cannot be serialized here.
  for (const record of records) {
    if (typeof record.id !== "string" || !ID.test(record.id) ||
        record.type !== "CNAME" || record.name !== hostname ||
        record.content !== `${tunnelId}.cfargotunnel.com`) {
      throw new CloudflareTunnelCleanupError("dns_ownership");
    }
  }
  for (const record of records) {
    await request(`/zones/${config.zoneId}/dns_records/${record.id}`, "dns_delete", "DELETE");
  }
  if (tunnel.deleted_at === null) {
    await request(`${tunnelPath}/connections`, "connections_delete", "DELETE");
    await request(tunnelPath, "tunnel_delete", "DELETE");
  }
  const verified = await readTunnel();
  if (!verified.deleted_at) {
    throw new CloudflareTunnelCleanupError("tunnel_still_present");
  }
  // GET-tunnel's embedded connections field is deprecated and may always be
  // empty. Only the dedicated endpoint provides current connector evidence.
  const connectionResponse = await request(`${tunnelPath}/connections`, "connections_read");
  const connections = connectionResponse.result;
  const connectionInfo = object(connectionResponse.result_info);
  if (!Array.isArray(connections) || connections.length !== 0 ||
      (connectionInfo.count !== undefined && connectionInfo.count !== 0) ||
      (connectionInfo.total_count !== undefined && connectionInfo.total_count !== 0) ||
      (connectionInfo.page !== undefined && connectionInfo.page !== 1) ||
      (connectionInfo.total_pages !== undefined && connectionInfo.total_pages !== 0 && connectionInfo.total_pages !== 1)) {
    throw new CloudflareTunnelCleanupError("connections_still_present");
  }
  if ((await readDns()).length !== 0) throw new CloudflareTunnelCleanupError("dns_still_present");
}
