import {
  UnsupportedVeniceModelError,
  VENICE_CHAT_MODEL_PRICES,
  VENICE_CHAT_PRICING_CATALOG_MAX_AGE_DAYS,
  VENICE_CHAT_PRICING_CATALOG_UPDATED_AT,
  calculateVeniceTokenCostMicroUsd,
  checkVeniceChatPricingCatalogStaleness,
  getVeniceChatModelPrice,
} from "@/lib/venice/pricing";

describe("Venice chat pricing catalog", () => {
  it("stores prices as microdollars per 1M tokens", () => {
    const price = getVeniceChatModelPrice("venice-uncensored-1-2");

    expect(VENICE_CHAT_PRICING_CATALOG_UPDATED_AT).toBe("2026-11-10");
    expect(price).toMatchObject({
      model: "venice-uncensored-1-2",
      inputMicroUsdPerMillion: 200_000,
      outputMicroUsdPerMillion: 900_000,
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
    });
    expect(calculateVeniceTokenCostMicroUsd(1_000_000, price.inputMicroUsdPerMillion)).toBe(
      200_000
    );
  });

  it("fails closed for unknown models", () => {
    expect(() => getVeniceChatModelPrice("unknown-model")).toThrow(
      UnsupportedVeniceModelError
    );
  });

  it("reports the catalog as fresh inside the staleness window", () => {
    // 5 days after the snapshot — well inside the 30-day window.
    const now = new Date("2026-11-15T00:00:00Z");
    const staleness = checkVeniceChatPricingCatalogStaleness(now);
    expect(staleness).toMatchObject({
      stale: false,
      ageDays: 5,
      maxAgeDays: VENICE_CHAT_PRICING_CATALOG_MAX_AGE_DAYS,
      updatedAt: VENICE_CHAT_PRICING_CATALOG_UPDATED_AT,
    });
  });

  it("prices the Claude Fable 5 / Opus 4.8 models Venice now serves (static fallback parity)", () => {
    // Sourced from Venice's live GET /v1/models?type=text on 2026-06-09. These
    // back the static fallback used when the live pricing fetch is unavailable;
    // they must match what Venice actually charges so settlement stays exact.
    expect(getVeniceChatModelPrice("claude-fable-5")).toMatchObject({
      inputMicroUsdPerMillion: 10_000_000,
      outputMicroUsdPerMillion: 50_000_000,
      cacheReadMicroUsdPerMillion: 1_000_000,
      privacy: "anonymized",
    });
    expect(getVeniceChatModelPrice("claude-opus-4-8")).toMatchObject({
      inputMicroUsdPerMillion: 5_000_000,
      outputMicroUsdPerMillion: 25_000_000,
      cacheReadMicroUsdPerMillion: 500_000,
    });
    expect(getVeniceChatModelPrice("claude-opus-4-8-fast")).toMatchObject({
      inputMicroUsdPerMillion: 10_000_000,
      outputMicroUsdPerMillion: 50_000_000,
    });
  });

  // Review of #166: the catalog said 24,000 output tokens for GLM 5.1 while
  // Venice allowed 80,000. These rows are what the proxy holds for while live
  // pricing is down, so their limits must be Venice's. Sourced from Venice's
  // live GET /api/v1/models?type=text on 2026-09-25.
  it.each([
    [
      "zai-org-glm-5-1",
      { inputMicroUsdPerMillion: 1_540_000, outputMicroUsdPerMillion: 4_840_000, cacheReadMicroUsdPerMillion: 286_000, contextWindow: 200_000, maxOutputTokens: 80_000 },
    ],
    [
      "qwen3-5-35b-a3b",
      { contextWindow: 256_000, maxOutputTokens: 16_384 },
    ],
    [
      "qwen3-vl-235b-a22b",
      { inputMicroUsdPerMillion: 210_000, outputMicroUsdPerMillion: 1_900_000, cacheReadMicroUsdPerMillion: 100_000, contextWindow: 128_000, maxOutputTokens: 16_384 },
    ],
  ])("%s matches Venice's 2026-09-25 limits and rates", (modelId, expected) => {
    expect(getVeniceChatModelPrice(modelId)).toMatchObject(expected);
  });

  it("never presents a catalog output maximum as one Venice confirmed", () => {
    for (const row of VENICE_CHAT_MODEL_PRICES) {
      expect(row.maxOutputTokensSource).toBe("catalog");
    }
  });

  it("reports the catalog as stale past the configured threshold", () => {
    const now = new Date("2026-12-20T00:00:00Z");
    const staleness = checkVeniceChatPricingCatalogStaleness(now);
    expect(staleness.stale).toBe(true);
    expect(staleness.ageDays).toBeGreaterThan(VENICE_CHAT_PRICING_CATALOG_MAX_AGE_DAYS);
  });
});
