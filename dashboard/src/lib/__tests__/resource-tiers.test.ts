import {
  freeResourceTierForStorage,
  isBaseResourceTierForUpgradePrompt,
  isFreeResourceTier,
  isSingleInstanceBaseResourceTier,
} from "@/lib/resource-tiers";

describe("resource tier helpers", () => {
  it("treats credit_base only as a legacy Free tier alias", () => {
    expect(isFreeResourceTier("free")).toBe(true);
    expect(isFreeResourceTier("credit_base")).toBe(true);
    expect(isFreeResourceTier(" Credit_Base ")).toBe(true);
    expect(isFreeResourceTier("credits")).toBe(false);
    expect(isFreeResourceTier("operator")).toBe(false);
  });

  it("keeps the legacy storage tier explicit while upgrade prompts use tier semantics", () => {
    expect(freeResourceTierForStorage()).toBe("credit_base");
    expect(isBaseResourceTierForUpgradePrompt(null)).toBe(true);
    expect(isBaseResourceTierForUpgradePrompt("free")).toBe(true);
    expect(isBaseResourceTierForUpgradePrompt("credit_base")).toBe(true);
    expect(isBaseResourceTierForUpgradePrompt("token_base")).toBe(true);
    expect(isBaseResourceTierForUpgradePrompt("operator")).toBe(false);
  });

  it("limits only Free aliases and token-base to one base instance", () => {
    expect(isSingleInstanceBaseResourceTier("free")).toBe(true);
    expect(isSingleInstanceBaseResourceTier("credit_base")).toBe(true);
    expect(isSingleInstanceBaseResourceTier("token_base")).toBe(true);
    expect(isSingleInstanceBaseResourceTier("operator")).toBe(false);
    expect(isSingleInstanceBaseResourceTier(null)).toBe(false);
  });
});
