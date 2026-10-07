import {
  HOSTED_COMPUTE_REQUIRES_PLAN_MESSAGE,
  isFreeAccountEntitlement,
} from "@/lib/billing/hosted-compute";

describe("isFreeAccountEntitlement", () => {
  it("is true only for the Free fallback row", () => {
    expect(isFreeAccountEntitlement({ plan: "free", source: "free" })).toBe(true);
  });

  it("is false for every paid or token-backed entitlement", () => {
    expect(isFreeAccountEntitlement({ plan: "operator", source: "stripe" })).toBe(false);
    expect(isFreeAccountEntitlement({ plan: "fleet", source: "apple_iap" })).toBe(false);
    expect(isFreeAccountEntitlement({ plan: "operator", source: "token_holding" })).toBe(false);
    expect(isFreeAccountEntitlement({ plan: "fleet", source: "token_yearly" })).toBe(false);
    expect(isFreeAccountEntitlement({ plan: "ws_cloud_pro", source: "workspace_cloud" })).toBe(false);
  });

  it("is false when there is no entitlement at all", () => {
    expect(isFreeAccountEntitlement(null)).toBe(false);
    expect(isFreeAccountEntitlement(undefined)).toBe(false);
  });
});

describe("hosted compute refusal copy", () => {
  it("says what the free account does include, and what to do next", () => {
    expect(HOSTED_COMPUTE_REQUIRES_PLAN_MESSAGE).toMatch(/paid plan/i);
    expect(HOSTED_COMPUTE_REQUIRES_PLAN_MESSAGE).toMatch(/your own computer/i);
    expect(HOSTED_COMPUTE_REQUIRES_PLAN_MESSAGE).toMatch(/choose a plan/i);
  });
});
