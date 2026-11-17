// What Venice itself says about the privacy of each model it serves, for
// every model type (text, image, video, audio, embeddings and the rest).
//
// "Private models only" (agent-private-only.ts) must never let a model
// through on a guess, so this lookup is strict where the pricing map is
// lenient: a model counts as private only when Venice states it, or when
// Hivra's own catalog snapshot states it for a model Venice's list does not
// carry. Anything else is unknown (null), and unknown is refused.
//
// The pricing map (live-pricing.ts) is not used for this: it covers text
// models only, and it fills a missing privacy value with "private".
//
// Venice's model list is public, so the fetch works without a key. A key is
// sent when one is configured (it avoids the anonymous rate limit) and the
// call is repeated without it if Venice refuses the key.

import { log } from "@/lib/logger";
import { venicePrivacyFor, type VenicePrivacy } from "@/lib/venice/model-privacy";
import { resolveManagedVeniceUpstreamKey } from "@/lib/venice/upstream-keys";

const VENICE_ALL_MODELS_URL = "https://api.venice.ai/api/v1/models?type=all";
const CACHE_TTL_MS = 10 * 60 * 1000;
// After a failed refresh, try again soon instead of holding the gap for a full TTL.
const FAILURE_RETRY_MS = 30 * 1000;
const FETCH_TIMEOUT_MS = 8_000;

interface PrivacyCacheEntry {
  /** Model id to the privacy Venice stated for it. */
  stated: Map<string, VenicePrivacy>;
  fetchedAt: number;
  ttlMs: number;
}

let cache: PrivacyCacheEntry | null = null;
let inFlight: Promise<PrivacyCacheEntry> | null = null;

/**
 * The privacy value Venice stated, or null when it stated none this code
 * recognises. Venice labels its end-to-end encrypted models "private" and
 * marks them by the `e2ee-` id prefix.
 */
export function readStatedVenicePrivacy(value: unknown, modelId: string): VenicePrivacy | null {
  const stated = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (stated === "anonymized") return "anonymized";
  if (stated === "e2ee_private") return "e2ee_private";
  if (stated === "private") return modelId.startsWith("e2ee-") ? "e2ee_private" : "private";
  return null;
}

async function requestAllModels(key: string | null, signal: AbortSignal): Promise<Response> {
  return fetch(VENICE_ALL_MODELS_URL, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    cache: "no-store",
    signal,
  });
}

async function fetchStatedPrivacy(): Promise<Map<string, VenicePrivacy>> {
  const resolvedKey = resolveManagedVeniceUpstreamKey({ endpoint: "/api/v1/models?type=all" });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let json: { data?: unknown };
  try {
    let response = await requestAllModels(resolvedKey?.key ?? null, controller.signal);
    if (resolvedKey && (response.status === 401 || response.status === 403 || response.status === 429)) {
      response = await requestAllModels(null, controller.signal);
    }
    if (!response.ok) throw new Error(`Venice /v1/models returned HTTP ${response.status}`);
    json = (await response.json()) as { data?: unknown };
  } finally {
    clearTimeout(timer);
  }

  const stated = new Map<string, VenicePrivacy>();
  for (const item of Array.isArray(json.data) ? json.data : []) {
    if (!item || typeof item !== "object") continue;
    const record = item as { id?: unknown; model_spec?: unknown };
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) continue;
    const spec = record.model_spec && typeof record.model_spec === "object"
      ? (record.model_spec as { privacy?: unknown })
      : {};
    const privacy = readStatedVenicePrivacy(spec.privacy, id);
    if (privacy) stated.set(id, privacy);
  }
  if (stated.size === 0) throw new Error("Venice /v1/models stated no privacy for any model");
  return stated;
}

async function loadStatedPrivacy(): Promise<Map<string, VenicePrivacy>> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < cache.ttlMs) return cache.stated;
  if (inFlight) return (await inFlight).stated;

  inFlight = (async () => {
    try {
      const entry: PrivacyCacheEntry = { stated: await fetchStatedPrivacy(), fetchedAt: now, ttlMs: CACHE_TTL_MS };
      cache = entry;
      return entry;
    } catch (error) {
      log.warn("Venice's model privacy list could not be refreshed; using the last list, or Hivra's catalog if there is none", {
        source: "venice-model-privacy",
        route: VENICE_ALL_MODELS_URL,
        failureType: "venice_model_privacy_fetch_failed",
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      // Keep the last good list. With none, only Hivra's catalog answers, so
      // models outside it stay unknown until Venice can be reached.
      const entry: PrivacyCacheEntry = { stated: cache?.stated ?? new Map(), fetchedAt: now, ttlMs: FAILURE_RETRY_MS };
      cache = entry;
      return entry;
    } finally {
      inFlight = null;
    }
  })();
  return (await inFlight).stated;
}

/**
 * A lookup for many models at once (a model list): each answer is what
 * Venice states now, else what Hivra's catalog snapshot states, else null
 * (unknown).
 */
export async function getVeniceModelPrivacyLookup(): Promise<(modelId: string) => VenicePrivacy | null> {
  const stated = await loadStatedPrivacy();
  return (modelId: string) => {
    const id = modelId.trim();
    return id ? stated.get(id) ?? venicePrivacyFor(id) : null;
  };
}

/** The privacy of one Venice model, of any type, or null when unknown. */
export async function resolveVeniceModelPrivacy(modelId: string): Promise<VenicePrivacy | null> {
  return (await getVeniceModelPrivacyLookup())(modelId);
}

// Reset hook for tests. Never called from production code paths.
export function _resetVeniceModelPrivacyCacheForTests() {
  cache = null;
  inFlight = null;
}
