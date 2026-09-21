// Live Venice pricing cache.
//
// Venice publishes per-model rates (input.usd, output.usd, cache_input.usd)
// at `GET /api/v1/models?type=text`. The static catalog in `pricing.ts` is a
// fallback for when we can't reach Venice — but the source of truth for
// settlement should be whatever Venice would charge us at request time, not
// a snapshot from N days ago.
//
// This module fetches and caches that live data with a short TTL. Consumers
// (cost-estimator, chat completions, models endpoint) call
// `getVenicePricingMap()` which returns a Map<modelId, VeniceChatModelPrice>
// with live rates layered over the static defaults (displayName etc. come
// from static; rates + privacy + context window come from live when
// available).
//
// Failure modes:
//   * VENICE_API_KEY missing → fall back to static (and warn).
//   * Venice API errors / network down → fall back to static, retry next TTL.
//   * Live entry malformed → drop that entry, keep the rest, keep static for it.
//
// Concurrency: in-flight fetch is shared across concurrent callers via the
// `inFlight` promise — N parallel chats trigger ONE fetch, not N.

import { log } from "@/lib/logger";
import { resolveManagedVeniceUpstreamKey } from "@/lib/venice/upstream-keys";
import {
  VENICE_CHAT_MODEL_PRICES,
  type VeniceChatModelPrice,
} from "@/lib/venice/pricing";

type PricingSource = "live" | "fallback" | "merged";

interface PricingCacheEntry {
  map: Map<string, VeniceChatModelPrice>;
  source: PricingSource;
  fetchedAt: number;
  liveModelCount: number;
}

const VENICE_LIVE_MODELS_URL = "https://api.venice.ai/api/v1/models?type=text";
const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;

let cache: PricingCacheEntry | null = null;
let inFlight: Promise<PricingCacheEntry> | null = null;

function staticMap(): Map<string, VeniceChatModelPrice> {
  return new Map(VENICE_CHAT_MODEL_PRICES.map((entry) => [entry.model, entry]));
}

function readNumber(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function usdToMicroUsd(value: number) {
  return Math.round(value * 1_000_000);
}

function normalisePrivacy(value: unknown, modelId = ""): VeniceChatModelPrice["privacy"] {
  const isE2eeModel = modelId.startsWith("e2ee-");
  if (typeof value !== "string") return isE2eeModel ? "e2ee_private" : "private";
  const v = value.toLowerCase();
  if (v === "anonymized") return v;
  if (v === "e2ee_private" || isE2eeModel) return "e2ee_private";
  return "private";
}

// Lift a /v1/models entry into our shape. Falls back to the static entry's
// displayName + maxOutputTokens defaults when the live record is missing
// those fields.
function liftLiveModel(
  entry: unknown,
  staticEntries: Map<string, VeniceChatModelPrice>,
): VeniceChatModelPrice | null {
  if (!entry || typeof entry !== "object") return null;
  const obj = entry as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  if (!id) return null;

  const spec = (obj.model_spec || {}) as Record<string, unknown>;

  // Venice has shipped two shapes for the pricing block:
  //   model_spec.pricing.{input,output,cache_input}.usd  (current)
  //   model_spec.{input,output,cache_input}.usd          (older)
  // Tolerate both so a Venice rev that bounces between them doesn't blank
  // our settlement.
  const pricing = (spec.pricing || spec) as Record<string, unknown>;
  const inputBlock = (pricing.input || {}) as Record<string, unknown>;
  const outputBlock = (pricing.output || {}) as Record<string, unknown>;
  const cacheInputBlock = (pricing.cache_input || {}) as Record<string, unknown>;

  const inputUsd = readNumber(inputBlock.usd);
  const outputUsd = readNumber(outputBlock.usd);
  if (inputUsd == null || outputUsd == null) return null;

  const cacheInputUsd = readNumber(cacheInputBlock.usd);
  const contextWindow = readNumber(spec.availableContextTokens) ?? readNumber(spec.context_length);
  const maxOutputTokens = readNumber(spec.maxCompletionTokens);
  const privacy = normalisePrivacy(spec.privacy, id);

  const fallback = staticEntries.get(id);
  const resolvedContextWindow = contextWindow ?? fallback?.contextWindow ?? 128_000;
  const resolvedMaxOutputTokens =
    maxOutputTokens ?? fallback?.maxOutputTokens ?? Math.min(8_192, resolvedContextWindow);

  return {
    model: id,
    displayName: fallback?.displayName ?? id,
    inputMicroUsdPerMillion: usdToMicroUsd(inputUsd),
    outputMicroUsdPerMillion: usdToMicroUsd(outputUsd),
    cacheReadMicroUsdPerMillion: cacheInputUsd != null ? usdToMicroUsd(cacheInputUsd) : null,
    cacheWriteMicroUsdPerMillion: fallback?.cacheWriteMicroUsdPerMillion ?? null,
    contextWindow: resolvedContextWindow,
    maxOutputTokens: resolvedMaxOutputTokens,
    privacy,
  };
}

async function fetchLiveVenicePricing(): Promise<{
  map: Map<string, VeniceChatModelPrice>;
  liveModelCount: number;
}> {
  const resolvedKey = resolveManagedVeniceUpstreamKey({
    endpoint: "/api/v1/models?type=text",
  });
  if (!resolvedKey) {
    throw new Error("Venice upstream key is not configured");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(VENICE_LIVE_MODELS_URL, {
      headers: { Authorization: `Bearer ${resolvedKey.key}` },
      cache: "no-store",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`Venice /v1/models returned HTTP ${response.status}`);
  }

  const json = (await response.json()) as { data?: unknown };
  const items = Array.isArray(json.data) ? json.data : [];

  const baseline = staticMap();
  // Start from static so models Venice hasn't published prices for still
  // settle. Overwrite each entry with the lifted live record when present.
  const merged = new Map(baseline);
  let liveCount = 0;
  for (const item of items) {
    const lifted = liftLiveModel(item, baseline);
    if (lifted) {
      merged.set(lifted.model, lifted);
      liveCount += 1;
    }
  }

  return { map: merged, liveModelCount: liveCount };
}

export interface VenicePricingMapResult {
  map: Map<string, VeniceChatModelPrice>;
  source: PricingSource;
  fetchedAt: number;
  liveModelCount: number;
}

// Reset hook for tests — never called from prod code paths.
export function _resetVenicePricingCacheForTests() {
  cache = null;
  inFlight = null;
}

export async function getVenicePricingMap(
  opts: { forceRefresh?: boolean } = {},
): Promise<VenicePricingMapResult> {
  const now = Date.now();

  if (!opts.forceRefresh && cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return {
      map: cache.map,
      source: cache.source,
      fetchedAt: cache.fetchedAt,
      liveModelCount: cache.liveModelCount,
    };
  }

  if (inFlight) {
    const resolved = await inFlight;
    return {
      map: resolved.map,
      source: resolved.source,
      fetchedAt: resolved.fetchedAt,
      liveModelCount: resolved.liveModelCount,
    };
  }

  inFlight = (async () => {
    try {
      const { map, liveModelCount } = await fetchLiveVenicePricing();
      const entry: PricingCacheEntry = {
        map,
        source: liveModelCount > 0 ? "merged" : "fallback",
        fetchedAt: now,
        liveModelCount,
      };
      cache = entry;
      return entry;
    } catch (error) {
      log.warn("Live Venice pricing fetch failed; settlements will use the static catalog", {
        source: "venice-live-pricing",
        route: VENICE_LIVE_MODELS_URL,
        failureType: "venice_live_pricing_fetch_failed",
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      const entry: PricingCacheEntry = {
        map: staticMap(),
        source: "fallback",
        fetchedAt: now,
        liveModelCount: 0,
      };
      cache = entry;
      return entry;
    } finally {
      inFlight = null;
    }
  })();

  const resolved = await inFlight;
  return {
    map: resolved.map,
    source: resolved.source,
    fetchedAt: resolved.fetchedAt,
    liveModelCount: resolved.liveModelCount,
  };
}
