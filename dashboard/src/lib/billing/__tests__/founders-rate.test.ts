/**
 * Regression coverage for the retired founders-rate lane: an allowlisted
 * legacy user is treated exactly like any other new entrant. Already locked
 * qualification rows are decoded by their historical tier codes elsewhere;
 * this lane must never mint a cheaper new launch lock again.
 */

describe("retired founders-rate pricing", () => {
  const saved = process.env.HERMES_FOUNDERS_RATE_USER_IDS;

  afterAll(() => {
    if (saved === undefined) delete process.env.HERMES_FOUNDERS_RATE_USER_IDS;
    else process.env.HERMES_FOUNDERS_RATE_USER_IDS = saved;
    jest.resetModules();
  });

  it("ignores the legacy allowlist and exposes no per-user launch override", () => {
    process.env.HERMES_FOUNDERS_RATE_USER_IDS = "user_founder";
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../tier-thresholds") as typeof import("../tier-thresholds") & Record<string, unknown>;
    expect(mod.isFoundersRateUser).toBeUndefined();
    expect(mod.resolveActiveThresholds).toBeUndefined();
    expect(mod.resolveActiveThresholdForTier).toBeUndefined();
    expect(mod.activeHolderUsdTargetCents("pro")).toBe(29_900);
    expect(mod.activeHolderUsdTargetCents("power")).toBe(59_900);
  });
});
