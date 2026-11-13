import "server-only";

import { lookup } from "node:dns/promises";
import { CHAT_SERVICE_ENDPOINTS, probeEndpoints, type ProbeEndpoint } from "./endpoints";

/**
 * Resolves the chat services' public names for the probe's safety net. Each
 * name gets at most `timeoutMs`; a name that does not resolve is left out
 * (the safety net then sees less, never more). Cached for a few minutes, so a
 * sweep of many agents resolves once.
 */
const CACHE_MS = 5 * 60_000;
let cache: { at: number; endpoints: ProbeEndpoint[] } | null = null;

type Lookup = (host: string) => Promise<readonly string[]>;

const defaultLookup: Lookup = async (host) => (await lookup(host, { all: true, verbatim: true })).map((r) => r.address);

export async function resolveChatEndpoints(
  options: { now?: () => number; timeoutMs?: number; lookupImpl?: Lookup; fresh?: boolean } = {},
): Promise<ProbeEndpoint[]> {
  const now = options.now ?? Date.now;
  if (!options.fresh && cache && now() - cache.at < CACHE_MS) return cache.endpoints;
  const timeoutMs = options.timeoutMs ?? 2_000;
  const find = options.lookupImpl ?? defaultLookup;
  const resolved: Record<string, string[]> = {};
  await Promise.all(CHAT_SERVICE_ENDPOINTS.flatMap((service) => service.hosts.map(async (host) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<readonly string[]>((resolve) => { timer = setTimeout(() => resolve([]), timeoutMs); });
    try {
      const addresses = await Promise.race([find(host).catch(() => [] as readonly string[]), timeout]);
      (resolved[service.platform] ??= []).push(...addresses);
    } finally {
      if (timer) clearTimeout(timer);
    }
  })));
  const endpoints = probeEndpoints(resolved);
  if (endpoints.length > 0) cache = { at: now(), endpoints };
  return endpoints;
}
