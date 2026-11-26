import {
  ACTIVE_HOLDER_USD_TARGET_CENTS,
  USD_TARGET_CENTS,
  activeHolderUsdTargetCents,
  activeThresholdTierCode,
} from "@/lib/billing/tier-thresholds";

describe("current holder-tier terms", () => {
  it("prices Pro at $299 and Power at $599 for new qualifications", () => {
    expect(ACTIVE_HOLDER_USD_TARGET_CENTS).toEqual({ pro: 29_900, power: 59_900 });
    expect(activeHolderUsdTargetCents("pro")).toBe(29_900);
    expect(activeHolderUsdTargetCents("power")).toBe(59_900);
  });

  it("issues only standard tier codes for new qualifications", () => {
    expect(activeThresholdTierCode("pro")).toBe("PRO_STANDARD");
    expect(activeThresholdTierCode("power")).toBe("POWER_STANDARD");
  });

  it("keeps historical launch codes decodable without reissuing their prices", () => {
    expect(USD_TARGET_CENTS).toEqual({
      PRO_LAUNCH: 9_900,
      PRO_STANDARD: 29_900,
      POWER_LAUNCH: 19_900,
      POWER_STANDARD: 59_900,
    });
  });

  it("does not expose a static token amount that can be quoted after the price moves", () => {
    expect.assertions(4);
    jest.isolateModules(() => {
      const mod = jest.requireActual<typeof import("@/lib/billing/tier-thresholds")>("@/lib/billing/tier-thresholds");
      expect("PRO_THRESHOLD_LAUNCH_TOKEN_UNITS" in mod).toBe(false);
      expect("PRO_THRESHOLD_STANDARD_TOKEN_UNITS" in mod).toBe(false);
      expect("POWER_THRESHOLD_LAUNCH_TOKEN_UNITS" in mod).toBe(false);
      expect("POWER_THRESHOLD_STANDARD_TOKEN_UNITS" in mod).toBe(false);
    });
  });
});
