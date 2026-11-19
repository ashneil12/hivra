import { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import { getVenicePricingMap } from "@/lib/venice/live-pricing";
import { verifyManagedVeniceProxyKey } from "@/lib/venice/proxy-keys";
import { resolveManagedVeniceUpstreamKey } from "@/lib/venice/upstream-keys";
import { readBearerKey } from "@/lib/venice/proxy-bearer";
import { managedVenicePrivateOnlyModelFilter } from "@/lib/venice/agent-private-only";

// Keep only the models a "private models only" key may call. A body that is
// not a model list is returned as it came: the setting is enforced when a
// model is called, this only keeps the agent's own pickers honest.
function keepListedModels(text: string, keep: (modelId: string) => boolean): string {
  try {
    const parsed = JSON.parse(text) as { data?: unknown };
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.data)) return text;
    const data = parsed.data.filter(
      (entry) => !!entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string"
        && keep((entry as { id: string }).id)
    );
    return JSON.stringify({ ...parsed, data });
  } catch {
    return text;
  }
}

export async function GET(req: NextRequest) {
  const plaintextKey = readBearerKey(req);
  if (!plaintextKey) return apiError("Unauthorized", 401);

  const verifiedKey = await verifyManagedVeniceProxyKey({ plaintextKey });
  if (!verifiedKey) return apiError("Unauthorized", 401);

  // Null unless this key is set to private models only (agent-private-only.ts).
  const keepModel = await managedVenicePrivateOnlyModelFilter(verifiedKey);

  // Per-type catalogs (image / video / tts / music / upscale / embedding) live
  // only on Venice — they are NOT in our text (LLM) pricing map. Proxy any
  // non-text `?type=` straight to Venice so the WebUI media dropdowns list the
  // right models per modality. Without this, every type fell through to the
  // priced text catalog below and the Video/Image/Audio pickers showed LLMs
  // (claude-opus, deepseek, …).
  let modelType = "";
  try {
    modelType = (new URL(req.url).searchParams.get("type") || "").trim().toLowerCase();
  } catch {
    modelType = "";
  }
  if (modelType && modelType !== "text") {
    const serverKey = resolveManagedVeniceUpstreamKey({
    proxyKeyId: verifiedKey.id,
    endpoint: "/api/v1/models",
  })?.key;
    if (!serverKey) {
      return apiError("Managed Venice is not configured.", 503, {
        failureType: "managed_venice_server_key_missing",
      });
    }
    let upstream: Response;
    try {
      upstream = await fetch(
        `https://api.venice.ai/api/v1/models?type=${encodeURIComponent(modelType)}`,
        { headers: { Authorization: `Bearer ${serverKey}`, Accept: "application/json" } }
      );
    } catch (error) {
      return apiError(
        "Venice upstream request failed.",
        502,
        { failureType: "managed_venice_models_upstream_fetch_failed" },
        undefined,
        { cause: error }
      );
    }
    const upstreamBody = await upstream.text();
    const upstreamText = keepModel && upstream.ok ? keepListedModels(upstreamBody, keepModel) : upstreamBody;
    return new Response(upstreamText, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "application/json",
      },
    });
  }

  const live = await getVenicePricingMap();
  // `created` is required by the OpenAI models-list schema. We don't track
  // per-model release dates, so use the cache's fetchedAt as a coarse proxy
  // so consumers can tell when the catalog was last refreshed.
  const createdSeconds = Math.floor(live.fetchedAt / 1000);
  const prices = Array.from(live.map.values()).filter((price) => !keepModel || keepModel(price.model));
  const data = prices.map((price) => ({
    id: price.model,
    object: "model",
    created: createdSeconds,
    owned_by: "venice.ai",
    display_name: price.displayName,
    context_length: price.contextWindow,
    model_spec: {
      availableContextTokens: price.contextWindow,
      maxCompletionTokens: price.maxOutputTokens,
      privacy: price.privacy,
      pricing: {
        input: { usd: price.inputMicroUsdPerMillion / 1_000_000 },
        output: { usd: price.outputMicroUsdPerMillion / 1_000_000 },
        ...(price.cacheReadMicroUsdPerMillion != null
          ? { cache_read: { usd: price.cacheReadMicroUsdPerMillion / 1_000_000 } }
          : {}),
        ...(price.cacheWriteMicroUsdPerMillion != null
          ? { cache_write: { usd: price.cacheWriteMicroUsdPerMillion / 1_000_000 } }
          : {}),
      },
    },
  }));

  return new Response(JSON.stringify({ object: "list", data }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, max-age=60",
      "X-Hermes-Venice-Pricing-Source": live.source,
    },
  });
}
