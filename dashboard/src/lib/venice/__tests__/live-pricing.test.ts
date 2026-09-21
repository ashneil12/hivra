/**
 * @jest-environment node
 */
import {
  _resetVenicePricingCacheForTests,
  getVenicePricingMap,
} from "@/lib/venice/live-pricing";
import { VENICE_CHAT_MODEL_PRICES } from "@/lib/venice/pricing";

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

  it("falls back to the static catalog when VENICE_API_KEY is unset", async () => {
    delete process.env.VENICE_API_KEY;
    global.fetch = jest.fn();
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const result = await getVenicePricingMap();

    expect(result.source).toBe("fallback");
    expect(global.fetch).not.toHaveBeenCalled();
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
