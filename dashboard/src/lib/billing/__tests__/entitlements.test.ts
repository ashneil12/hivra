import { evaluateComputeEntitlement } from "@/lib/billing/entitlements";

describe("evaluateComputeEntitlement", () => {
  it("allows active subscribers up to their current plan resources", () => {
    const decision = evaluateComputeEntitlement({
      userId: "user_123",
      subscription: { plan: "operator", status: "active" },
      creditBalanceCredits: null,
      reservedCredits: 0,
      tokenHolding: { verified: false, balance: 0 },
      activeInstances: [],
      requestedInstance: { cpu: 0.5, ram: 1024 },
    });

    expect(decision).toMatchObject({
      mode: "dry_run",
      enforced: false,
      verified: true,
      failClosed: false,
      allowedTier: "operator",
      canProvision: true,
      shouldPause: false,
      payAsYouGoEnabled: false,
    });
    expect(decision.limits).toMatchObject({
      totalCpu: 2,
      totalRam: 4096,
      maxCpuPerInstance: 2,
      maxRamPerInstance: 4096,
    });
  });

  it("allows trialing subscribers up to their current plan resources", () => {
    const decision = evaluateComputeEntitlement({
      userId: "user_123",
      subscription: { plan: "operator", status: "trialing" },
      creditBalanceCredits: null,
      reservedCredits: 0,
      tokenHolding: { verified: false, balance: 0 },
      activeInstances: [],
      requestedInstance: { cpu: 0.5, ram: 1024 },
    });

    expect(decision).toMatchObject({
      verified: true,
      allowedTier: "operator",
      canProvision: true,
      payAsYouGoEnabled: false,
    });
  });

  it("fails closed when no entitlement source can be verified", () => {
    const decision = evaluateComputeEntitlement({
      userId: "user_123",
      subscription: null,
      creditBalanceCredits: null,
      reservedCredits: 0,
      tokenHolding: { verified: false, balance: 0 },
      activeInstances: [{ id: "inst_1", cpu: 1, ram: 2048, state: "active" }],
      requestedInstance: { cpu: 0.5, ram: 1024 },
    });

    expect(decision).toMatchObject({
      verified: false,
      failClosed: true,
      allowedTier: null,
      canProvision: false,
      shouldPause: true,
      shouldResume: false,
    });
    expect(decision.reasons).toContain("No verified subscription or token entitlement.");
  });

  it("unlocks the configured free base tier from a verified Hivra token holding", () => {
    const decision = evaluateComputeEntitlement({
      userId: "user_123",
      subscription: null,
      creditBalanceCredits: null,
      reservedCredits: 0,
      tokenHolding: { verified: true, balance: 1 },
      activeInstances: [],
      requestedInstance: { cpu: 0.5, ram: 1024 },
    });

    expect(decision).toMatchObject({
      verified: true,
      allowedTier: "token_base",
      canProvision: true,
      shouldPause: false,
      payAsYouGoEnabled: false,
    });
    expect(decision.limits).toMatchObject({
      totalCpu: 0.5,
      totalRam: 1024,
      maxCpuPerInstance: 0.5,
      maxRamPerInstance: 1024,
    });
  });

  it("does not unlock compute from credit balance alone", () => {
    const decision = evaluateComputeEntitlement({
      userId: "user_123",
      subscription: null,
      creditBalanceCredits: 500,
      reservedCredits: 250,
      tokenHolding: { verified: false, balance: 0 },
      activeInstances: [],
      requestedInstance: { cpu: 0.5, ram: 1024 },
    });

    expect(decision).toMatchObject({
      verified: false,
      allowedTier: null,
      availableCredits: 250,
      canProvision: false,
      failClosed: true,
      payAsYouGoEnabled: false,
    });
    expect(decision.reasons).toContain("Credits are available for billing/top-ups but do not unlock a compute tier.");
  });

  it("blocks provisioning when the requested instance exceeds the selected tier", () => {
    const decision = evaluateComputeEntitlement({
      userId: "user_123",
      subscription: null,
      creditBalanceCredits: 500,
      reservedCredits: 0,
      tokenHolding: { verified: true, balance: 1 },
      activeInstances: [],
      requestedInstance: { cpu: 2, ram: 4096 },
    });

    expect(decision.canProvision).toBe(false);
    expect(decision.reasons).toContain("Requested resources exceed allowed tier.");
  });
});
