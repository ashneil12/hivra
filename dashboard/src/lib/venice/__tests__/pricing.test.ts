import {
  UnsupportedVeniceModelError,
  VENICE_CHAT_PRICING_CATALOG_MAX_AGE_DAYS,
  VENICE_CHAT_PRICING_CATALOG_UPDATED_AT,
  calculateVeniceTokenCostMicroUsd,
  checkVeniceChatPricingCatalogStaleness,
  getVeniceChatModelPrice,
} from "@/lib/venice/pricing";

describe("Venice chat pricing catalog", () => {
  it("stores prices as microdollars per 1M tokens", () => {
    const price = getVeniceChatModelPrice("venice-uncensored-1-2");

    expect(VENICE_CHAT_PRICING_CATALOG_UPDATED_AT).toBe("2026-06-09");
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
    const now = new Date("2026-06-14T00:00:00Z");
    const staleness = checkVeniceChatPricingCatalogStaleness(now);
    expect(staleness).toMatchObject({
      stale: false,
      ageDays: 5,
      maxAgeDays: VENICE_CHAT_PRICING_CATALOG_MAX_AGE_DAYS,
      updatedAt: "2026-06-09",
    });
  });

  it("prices the Claude Fable 5 / Opus 4.8 models Venice now serves (static fallback parity)", () => {
    // Sourced from Venice's live GET /v1/models?type=text on 2026-06-09. These
    // back the static fallback used when the live pricing fetch is unavailable;
    // they must match what Venice actually charges so settlement stays exact.
    expect(getVeniceChatModelPrice("claude-fable-5")).toMatchObject({
      inputMicroUsdPerMillion: 12_000_000,
      outputMicroUsdPerMillion: 60_000_000,
      cacheReadMicroUsdPerMillion: 1_200_000,
      privacy: "anonymized",
    });
    expect(getVeniceChatModelPrice("claude-opus-4-8")).toMatchObject({
      inputMicroUsdPerMillion: 6_000_000,
      outputMicroUsdPerMillion: 30_000_000,
      cacheReadMicroUsdPerMillion: 600_000,
    });
    expect(getVeniceChatModelPrice("claude-opus-4-8-fast")).toMatchObject({
      inputMicroUsdPerMillion: 12_000_000,
      outputMicroUsdPerMillion: 60_000_000,
    });
  });

  it("reports the catalog as stale past the configured threshold", () => {
    const now = new Date("2026-07-20T00:00:00Z");
    const staleness = checkVeniceChatPricingCatalogStaleness(now);
    expect(staleness.stale).toBe(true);
    expect(staleness.ageDays).toBeGreaterThan(VENICE_CHAT_PRICING_CATALOG_MAX_AGE_DAYS);
  });
});
