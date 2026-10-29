import type * as TierThresholds from "@/lib/billing/tier-thresholds";

// The override gate runs at module load, so each case re-imports the module
// under its own environment.
const OVERRIDE_ENV = "HERMES_TIER_THRESHOLD_OVERRIDE_PRO_LAUNCH";
const DATE_OVERRIDE_ENV = "HERMES_LAUNCH_PROMO_END_DATE_OVERRIDE";
const DEFAULT_PRO_LAUNCH = 3_794_557n * 10n ** 18n;
const OVERRIDE_PRO_LAUNCH = 200_000n * 10n ** 18n;

function loadThresholds(env: Record<string, string | undefined>): typeof TierThresholds {
  const keys = ["VERCEL_ENV", "NODE_ENV", OVERRIDE_ENV, DATE_OVERRIDE_ENV];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) {
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  let loaded: typeof TierThresholds | undefined;
  try {
    jest.isolateModules(() => {
      loaded = jest.requireActual<typeof TierThresholds>("@/lib/billing/tier-thresholds");
    });
  } finally {
    warn.mockRestore();
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
  return loaded!;
}

describe("tier threshold overrides gate", () => {
  it("ignores overrides on Vercel production", () => {
    const thresholds = loadThresholds({
      VERCEL_ENV: "production",
      NODE_ENV: "production",
      [OVERRIDE_ENV]: "200000",
    });
    expect(thresholds.PRO_THRESHOLD_LAUNCH_TOKEN_UNITS).toBe(DEFAULT_PRO_LAUNCH);
  });

  it("ignores overrides on a non-Vercel production run (fails closed)", () => {
    const thresholds = loadThresholds({
      VERCEL_ENV: undefined,
      NODE_ENV: "production",
      [OVERRIDE_ENV]: "200000",
      [DATE_OVERRIDE_ENV]: "2026-06-30T23:59:59Z",
    });
    expect(thresholds.PRO_THRESHOLD_LAUNCH_TOKEN_UNITS).toBe(DEFAULT_PRO_LAUNCH);
    expect(thresholds.LAUNCH_PROMO_END_DATE.toISOString()).toBe("2026-05-30T23:59:59.000Z");
  });

  it("ignores overrides on an unrecognised VERCEL_ENV value", () => {
    const thresholds = loadThresholds({
      VERCEL_ENV: "something-else",
      NODE_ENV: "production",
      [OVERRIDE_ENV]: "200000",
    });
    expect(thresholds.PRO_THRESHOLD_LAUNCH_TOKEN_UNITS).toBe(DEFAULT_PRO_LAUNCH);
  });

  it("honors overrides on Vercel preview and development deployments", () => {
    for (const vercelEnv of ["preview", "development"]) {
      const thresholds = loadThresholds({
        VERCEL_ENV: vercelEnv,
        NODE_ENV: "production",
        [OVERRIDE_ENV]: "200000",
      });
      expect(thresholds.PRO_THRESHOLD_LAUNCH_TOKEN_UNITS).toBe(OVERRIDE_PRO_LAUNCH);
    }
  });

  it("honors overrides on a local development or test run with VERCEL_ENV unset", () => {
    const thresholds = loadThresholds({
      VERCEL_ENV: undefined,
      NODE_ENV: "test",
      [OVERRIDE_ENV]: "200000",
    });
    expect(thresholds.PRO_THRESHOLD_LAUNCH_TOKEN_UNITS).toBe(OVERRIDE_PRO_LAUNCH);
  });
});
