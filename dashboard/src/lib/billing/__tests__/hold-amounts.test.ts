import { readHoldAmounts } from "../hold-amounts";

// Shape of /api/billing/wallet/eligibility `data`, trimmed to what the reader uses.
const eligibility = {
  balance: null,
  thresholds: {
    configured: true,
    proDisplay: "134,476,535",
    powerDisplay: "269,855,596",
    priceUsd: "0.000001108",
    priceFetchedAt: "2026-09-24T12:59:43.827Z",
    epoch: "standard",
  },
  tiers: {
    pro: { currentlyEligible: false, currentThresholdDisplay: "134,476,535" },
    power: { currentlyEligible: true, currentThresholdDisplay: "269,855,596" },
  },
  veniceBoost: {
    thresholdUsd: 199,
    cpuBonus: 1,
    ramBonusMb: 2048,
    currentlyEligible: false,
    requiredVvvDisplay: "7",
    countsStakedVvv: true,
  },
};

describe("readHoldAmounts", () => {
  it("reads the server's per-plan hold amounts with a rough dollar value", () => {
    const amounts = readHoldAmounts(eligibility);
    expect(amounts?.pro).toEqual({ amountDisplay: "134,476,535", usdApprox: 149, eligible: false });
    expect(amounts?.power).toEqual({ amountDisplay: "269,855,596", usdApprox: 299, eligible: true });
    expect(amounts?.balanceDisplay).toBeNull();
    expect(amounts?.vvvBoost).toEqual({
      requiredDisplay: "7",
      usdThreshold: 199,
      cpuBonus: 1,
      ramBonusGb: 2,
      eligible: false,
      countsStaked: true,
    });
  });

  it("keeps the verified balance when there is one", () => {
    expect(readHoldAmounts({ ...eligibility, balance: { balanceDisplay: "12,000" } })?.balanceDisplay).toBe("12,000");
  });

  it("returns nothing when thresholds aren't configured", () => {
    expect(readHoldAmounts({ ...eligibility, thresholds: { configured: false } })).toBeNull();
    expect(readHoldAmounts(null)).toBeNull();
  });

  it("drops the dollar value when the price is unknown", () => {
    const amounts = readHoldAmounts({ ...eligibility, thresholds: { ...eligibility.thresholds, priceUsd: null } });
    expect(amounts?.pro.usdApprox).toBeNull();
  });
});
