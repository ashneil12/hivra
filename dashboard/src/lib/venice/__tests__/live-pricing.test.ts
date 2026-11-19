/**
 * @jest-environment node
 */
import {
  _resetVenicePricingCacheForTests,
  getVenicePricingMap,
} from "@/lib/venice/live-pricing";
import { VENICE_CHAT_MODEL_PRICES } from "@/lib/venice/pricing";
import { resolveVeniceChatPrice } from "@/lib/venice/cost-estimator";
import { managedVeniceOutputCapPatch } from "@/lib/venice/chat-output-budget";

const liveDeepseek = {
  id: "deepseek-v4-flash",
  model_spec: {
    availableContextTokens: 1_000_000,
    maxCompletionTokens: 262_144,
    privacy: "private",
    pricing: {
      input: { usd: 0.138 },
      output: { usd: 0.275 },
      cache_input: { usd: 0.028 },
    },
  },
};

const originalFetch = global.fetch;
const originalApiKey = process.env.VENICE_API_KEY;
const originalInferenceKeys = process.env.MANAGED_VENICE_INFERENCE_KEYS;

function mockOkJson(body: unknown): jest.Mock {
  return jest.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

beforeEach(() => {
  _resetVenicePricingCacheForTests();
  process.env.VENICE_API_KEY = "venice_test_key";
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalApiKey === undefined) {
    delete process.env.VENICE_API_KEY;
  } else {
    process.env.VENICE_API_KEY = originalApiKey;
  }
  if (originalInferenceKeys === undefined) {
    delete process.env.MANAGED_VENICE_INFERENCE_KEYS;
  } else {
    process.env.MANAGED_VENICE_INFERENCE_KEYS = originalInferenceKeys;
  }
});

describe("getVenicePricingMap", () => {
  it("returns live cache_input rates so cache-heavy models bill correctly across every provider Venice exposes", async () => {
    const live = {
      data: [
        {
          id: "deepseek-v4-flash",
          model_spec: {
            availableContextTokens: 1_000_000,
            maxCompletionTokens: 32_768,
            privacy: "anonymized",
            pricing: {
              input: { usd: 0.17 },
              output: { usd: 0.35 },
              cache_input: { usd: 0.028 },
            },
          },
        },
        {
          id: "claude-opus-4-7",
          model_spec: {
            availableContextTokens: 1_000_000,
            maxCompletionTokens: 128_000,
            privacy: "anonymized",
            pricing: {
              input: { usd: 6 },
              output: { usd: 30 },
              cache_input: { usd: 0.6 },
            },
          },
        },
      ],
    };
    global.fetch = mockOkJson(live);

    const result = await getVenicePricingMap();

    expect(result.source).toBe("merged");
    expect(result.liveModelCount).toBe(2);
    const deepseek = result.map.get("deepseek-v4-flash");
    expect(deepseek?.cacheReadMicroUsdPerMillion).toBe(28_000);
    expect(deepseek?.inputMicroUsdPerMillion).toBe(170_000);
    // Live data wins for privacy too — deepseek-v4-flash is anonymized upstream.
    expect(deepseek?.privacy).toBe("anonymized");
    // Cache-input must be priced for cross-provider models, not just DeepSeek.
    const claude = result.map.get("claude-opus-4-7");
    expect(claude?.cacheReadMicroUsdPerMillion).toBe(600_000);
  });

  it("accepts numeric-string live pricing for same-day Venice model releases", async () => {
    global.fetch = mockOkJson({
      data: [
        {
          id: "same-day-release-1",
          model_spec: {
            availableContextTokens: "128000",
            maxCompletionTokens: "8192",
            privacy: "private",
            pricing: {
              input: { usd: "0.42" },
              output: { usd: "1.37" },
              cache_input: { usd: "0.08" },
            },
          },
        },
      ],
    });

    const result = await getVenicePricingMap();

    expect(result.source).toBe("merged");
    expect(result.liveModelCount).toBe(1);
    expect(result.map.get("same-day-release-1")).toEqual(
      expect.objectContaining({
        model: "same-day-release-1",
        displayName: "same-day-release-1",
        inputMicroUsdPerMillion: 420_000,
        outputMicroUsdPerMillion: 1_370_000,
        cacheReadMicroUsdPerMillion: 80_000,
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
      })
    );
  });

  it("dedupes concurrent callers into a single fetch", async () => {
    const fetchMock = mockOkJson({ data: [] });
    global.fetch = fetchMock;

    await Promise.all([
      getVenicePricingMap(),
      getVenicePricingMap(),
      getVenicePricingMap(),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns the cached map within the TTL without re-fetching", async () => {
    const fetchMock = mockOkJson({ data: [] });
    global.fetch = fetchMock;

    await getVenicePricingMap();
    await getVenicePricingMap();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the static catalog when Venice's models endpoint errors", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response("upstream blew up", { status: 500 }),
    );
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const result = await getVenicePricingMap();

    expect(result.source).toBe("fallback");
    expect(result.liveModelCount).toBe(0);
    expect(result.map.size).toBe(VENICE_CHAT_MODEL_PRICES.length);
    // Static deepseek-v4-flash carries the cache rate too — the fix isn't
    // just live; it's also baked into the static fallback.
    expect(result.map.get("deepseek-v4-flash")?.cacheReadMicroUsdPerMillion).toBe(28_000);
    warnSpy.mockRestore();
  });

  it("uses the managed inference key pool for live pricing before the legacy key", async () => {
    process.env.MANAGED_VENICE_INFERENCE_KEYS = JSON.stringify(["pricing_pool_a"]);
    process.env.VENICE_API_KEY = "legacy_pricing_key";
    const fetchMock = mockOkJson({ data: [] });
    global.fetch = fetchMock;

    await getVenicePricingMap();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.venice.ai/api/v1/models?type=text",
      expect.objectContaining({
        headers: { Authorization: "Bearer pricing_pool_a" },
      })
    );
  });

  it("fetches the public models list anonymously when no upstream key is configured", async () => {
    delete process.env.VENICE_API_KEY;
    delete process.env.MANAGED_VENICE_INFERENCE_KEYS;
    const fetchMock = mockOkJson({ data: [liveDeepseek] });
    global.fetch = fetchMock;

    const result = await getVenicePricingMap();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.venice.ai/api/v1/models?type=text",
      expect.objectContaining({ headers: {} })
    );
    expect(result.source).toBe("merged");
    expect(result.map.get("deepseek-v4-flash")?.inputMicroUsdPerMillion).toBe(138_000);
  });

  it("retries anonymously when Venice rejects the configured key", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [liveDeepseek] }), { status: 200 })
      );
    global.fetch = fetchMock;

    const result = await getVenicePricingMap();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers).toEqual({});
    expect(result.liveModelCount).toBe(1);
  });

  it("keeps the last live prices when a later refresh fails", async () => {
    global.fetch = mockOkJson({ data: [liveDeepseek] });
    await getVenicePricingMap();
    global.fetch = jest.fn().mockResolvedValue(new Response("down", { status: 503 }));
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const result = await getVenicePricingMap({ forceRefresh: true });

    expect(result.source).toBe("merged");
    expect(result.map.get("deepseek-v4-flash")?.maxOutputTokensSource).toBe("venice_live");
    warnSpy.mockRestore();
  });

  it("retries soon after a failed first fetch instead of pinning the catalog for the full TTL", async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date("2026-11-10T00:00:00Z"));
      global.fetch = jest.fn().mockResolvedValue(new Response("down", { status: 503 }));
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      expect((await getVenicePricingMap()).source).toBe("fallback");

      jest.setSystemTime(new Date("2026-11-10T00:00:45Z"));
      global.fetch = mockOkJson({ data: [liveDeepseek] });
      expect((await getVenicePricingMap()).source).toBe("merged");
      warnSpy.mockRestore();
    } finally {
      jest.useRealTimers();
    }
  });

  // The consumers (hold sizing and settlement) take this map as-is, so live
  // limits and rates must reach them with the "venice_live" source.
  it("feeds live limits and rates to the cost estimator and the output cap patch", async () => {
    global.fetch = mockOkJson({ data: [liveDeepseek] });
    const { map } = await getVenicePricingMap();

    const price = resolveVeniceChatPrice("deepseek-v4-flash", map);
    expect(price.maxOutputTokens).toBe(262_144);
    expect(price.maxOutputTokensSource).toBe("venice_live");
    expect(price.inputMicroUsdPerMillion).toBe(138_000);
    // Confirmed maximum: no cap needs writing into the request.
    expect(
      managedVeniceOutputCapPatch("chat", { model: "deepseek-v4-flash" }, 262_144, price)
    ).toEqual({});
    // Catalog fallback is only a guess, so the held cap is always written.
    const catalogPrice = resolveVeniceChatPrice("deepseek-v4-flash");
    expect(catalogPrice.maxOutputTokensSource).toBe("catalog");
    expect(
      managedVeniceOutputCapPatch("chat", { model: "deepseek-v4-flash" }, catalogPrice.maxOutputTokens, catalogPrice)
    ).toEqual({ max_completion_tokens: catalogPrice.maxOutputTokens });
  });

  // Review of #166: the chat proxy writes the cap it held into the forwarded
  // request unless Venice itself published the model's output maximum. It can
  // only tell the two apart if every row says where its maximum came from.
  it("marks an output maximum as Venice's only when the live row published one", async () => {
    global.fetch = mockOkJson({
      data: [
        {
          id: "zai-org-glm-5-1",
          model_spec: {
            availableContextTokens: 200_000,
            maxCompletionTokens: 80_000,
            pricing: { input: { usd: 1.54 }, output: { usd: 4.84 } },
          },
        },
        {
          // Listed, priced, but no maxCompletionTokens: the maximum falls back to the catalog.
          id: "deepseek-v4-flash",
          model_spec: { pricing: { input: { usd: 0.17 }, output: { usd: 0.35 } } },
        },
      ],
    });

    const result = await getVenicePricingMap();

    expect(result.map.get("zai-org-glm-5-1")).toMatchObject({
      maxOutputTokens: 80_000,
      maxOutputTokensSource: "venice_live",
    });
    expect(result.map.get("deepseek-v4-flash")).toMatchObject({
      maxOutputTokens: VENICE_CHAT_MODEL_PRICES.find((row) => row.model === "deepseek-v4-flash")
        ?.maxOutputTokens,
      maxOutputTokensSource: "catalog",
    });
    // A catalog model Venice did not list keeps the catalog's guess.
    expect(result.map.get("claude-opus-4-8")?.maxOutputTokensSource).toBe("catalog");
  });

  it("marks every output maximum as the catalog's when the live refresh fails", async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response("down", { status: 503 }));
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const result = await getVenicePricingMap();

    expect(result.source).toBe("fallback");
    expect([...result.map.values()].every((row) => row.maxOutputTokensSource === "catalog")).toBe(true);
    warnSpy.mockRestore();
  });

  it("drops malformed entries but keeps the rest of the live response", async () => {
    global.fetch = mockOkJson({
      data: [
        { id: "missing-prices", model_spec: {} },
        {
          id: "deepseek-v4-flash",
          model_spec: {
            availableContextTokens: 1_000_000,
            maxCompletionTokens: 32_768,
            privacy: "anonymized",
            pricing: {
              input: { usd: 0.17 },
              output: { usd: 0.35 },
            },
          },
        },
      ],
    });

    const result = await getVenicePricingMap();
    expect(result.liveModelCount).toBe(1);
    expect(result.map.get("deepseek-v4-flash")).toBeDefined();
    // The malformed entry doesn't poison the map and the static fallback
    // for `missing-prices` (which doesn't exist in the catalog) is naturally
    // absent.
    expect(result.map.has("missing-prices")).toBe(false);
  });
});
