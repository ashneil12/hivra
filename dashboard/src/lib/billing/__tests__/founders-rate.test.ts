/**
 * Tests for the per-user founders-rate grant.
 *
 * The allowlist is parsed from HERMES_FOUNDERS_RATE_USER_IDS at module
 * load, so each case re-imports the module under an isolated env via
 * jest.resetModules() + require.
 */

type TierThresholdsModule = typeof import("../tier-thresholds");

const ORIGINAL_ALLOWLIST = process.env.HERMES_FOUNDERS_RATE_USER_IDS;

function loadWithAllowlist(value: string | undefined): TierThresholdsModule {
  jest.resetModules();
  if (value === undefined) {
    delete process.env.HERMES_FOUNDERS_RATE_USER_IDS;
  } else {
    process.env.HERMES_FOUNDERS_RATE_USER_IDS = value;
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../tier-thresholds") as TierThresholdsModule;
}

afterAll(() => {
  if (ORIGINAL_ALLOWLIST === undefined) {
    delete process.env.HERMES_FOUNDERS_RATE_USER_IDS;
  } else {
    process.env.HERMES_FOUNDERS_RATE_USER_IDS = ORIGINAL_ALLOWLIST;
  }
  jest.resetModules();
});

describe("isFoundersRateUser", () => {
  it("returns false for everyone when the allowlist is unset (no-op default)", () => {
    const mod = loadWithAllowlist(undefined);
    expect(mod.isFoundersRateUser("user_123")).toBe(false);
    expect(mod.isFoundersRateUser(null)).toBe(false);
    expect(mod.isFoundersRateUser(undefined)).toBe(false);
  });

  it("matches listed ids (comma- or whitespace-separated) and rejects others", () => {
    const mod = loadWithAllowlist(" user_abc, user_def\tuser_ghi ");
    expect(mod.isFoundersRateUser("user_abc")).toBe(true);
    expect(mod.isFoundersRateUser("user_def")).toBe(true);
    expect(mod.isFoundersRateUser("user_ghi")).toBe(true);
    expect(mod.isFoundersRateUser("user_zzz")).toBe(false);
    expect(mod.isFoundersRateUser(null)).toBe(false);
  });
});

describe("resolveActiveThresholds forceLaunchEpoch", () => {
  it("keeps the standard epoch past the window without the override", () => {
    const mod = loadWithAllowlist(undefined);
    const afterWindow = new Date(mod.LAUNCH_PROMO_END_DATE.getTime() + 86_400_000);
    const result = mod.resolveActiveThresholds(afterWindow);
    expect(result.epoch).toBe("standard");
    expect(result.pro.code).toBe("PRO_STANDARD");
  });

  it("pins the launch epoch past the window with the override (cheaper threshold)", () => {
    const mod = loadWithAllowlist(undefined);
    const afterWindow = new Date(mod.LAUNCH_PROMO_END_DATE.getTime() + 86_400_000);
    const standard = mod.resolveActiveThresholds(afterWindow);
    const founder = mod.resolveActiveThresholds(afterWindow, { forceLaunchEpoch: true });
    expect(founder.epoch).toBe("launch");
    expect(founder.pro.code).toBe("PRO_LAUNCH");
    expect(founder.power.code).toBe("POWER_LAUNCH");
    expect(founder.pro.amount).toBeLessThan(standard.pro.amount);
    expect(founder.power.amount).toBeLessThan(standard.power.amount);
  });

  it("resolveActiveThresholdForTier forwards the override", () => {
    const mod = loadWithAllowlist(undefined);
    const afterWindow = new Date(mod.LAUNCH_PROMO_END_DATE.getTime() + 86_400_000);
    const pro = mod.resolveActiveThresholdForTier("pro", afterWindow, {
      forceLaunchEpoch: true,
    });
    expect(pro.code).toBe("PRO_LAUNCH");
  });
});
