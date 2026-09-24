/** @jest-environment node */
/**
 * The $HIVRA activation helper (scripts/token/prepare-hivra-activation.mjs) is
 * an ES module run by Node, so its fixture tests are node:test; this runs them
 * in the dashboard suite and checks the helper cannot drift from the registry
 * it writes for.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { HIVRA_MIN_PRICE_LIQUIDITY_USD, validateHivraLaunchConfig } from "@/lib/billing/token-registry";
import { PLATFORM_PRICE_MAX_DEVIATION_BPS, PLATFORM_PRICE_MEDIAN_WINDOW_MINUTES } from "@/lib/billing/price-feed";

const SCRIPT = join(process.cwd(), "scripts/token/prepare-hivra-activation.mjs");
const LAUNCH_FILE = join(process.cwd(), "src/lib/billing/hivra-token-launch.ts");

const VALID = {
  contractAddress: "0x52908400098527886E0F7030069857D2E4169EE7",
  decimals: 18,
  poolId: `0x${"ab".repeat(32)}`,
  activatesAt: "2026-10-01T16:00:00Z",
};

const POOL_ID_SAMPLES = [
  VALID.poolId,
  `0x${"AB".repeat(32)}`,
  `0x${"ab".repeat(20)}`,
  `0x${"ab".repeat(31)}`,
  `0x${"ab".repeat(33)}`,
  `0x${"zz".repeat(32)}`,
  `${"ab".repeat(32)}`,
  "",
];
const INSTANT_SAMPLES = ["2026-10-01T16:00:00Z", "2026-10-01T16:00Z", "2026-10-01 16:00:00", "2026-10-01T16:00:00+00:00", "2026-10-01T16:00:00.000Z"];

/** Values the helper computes, read by importing it in a real Node ES module run. */
function helperValues(): {
  poolIdAccepted: boolean[];
  instantAccepted: boolean[];
  floor: number;
  medianWindow: number;
  maxDeviation: number;
  dormantRoundTrip: string;
  rendered: string;
} {
  const program = `
    import { readFileSync } from "node:fs";
    import * as helper from ${JSON.stringify(SCRIPT)};
    const launch = readFileSync(helper.LAUNCH_FILE, "utf8");
    console.log(JSON.stringify({
      poolIdAccepted: ${JSON.stringify(POOL_ID_SAMPLES)}.map((id) => helper.POOL_ID_PATTERN.test(id)),
      instantAccepted: ${JSON.stringify(INSTANT_SAMPLES)}.map((at) => helper.UTC_INSTANT_PATTERN.test(at)),
      floor: helper.readMinPriceLiquidityUsd(readFileSync(helper.REGISTRY_FILE, "utf8")),
      medianWindow: helper.PRICE_MEDIAN_WINDOW_MINUTES,
      maxDeviation: helper.PRICE_MAX_DEVIATION_BPS,
      dormantRoundTrip: helper.renderLaunchSource(launch, helper.readLaunchBlock(launch)),
      rendered: helper.renderLaunchSource(launch, ${JSON.stringify(VALID)}),
    }));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", program], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30_000,
  });
  return JSON.parse(output);
}

describe("prepare-hivra-activation helper", () => {
  let values: ReturnType<typeof helperValues>;
  beforeAll(() => {
    values = helperValues();
  }, 60_000);

  it("passes its fixture tests (no network)", () => {
    const output = execFileSync(process.execPath, ["--test", "scripts/token/prepare-hivra-activation.test.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(output).toMatch(/# fail 0/);
    expect(output).toMatch(/# pass [1-9]\d*/);
  }, 90_000);

  it("uses the registry's liquidity floor and the price feed's median band", () => {
    expect(values.floor).toBe(HIVRA_MIN_PRICE_LIQUIDITY_USD);
    expect(values.medianWindow).toBe(PLATFORM_PRICE_MEDIAN_WINDOW_MINUTES);
    expect(values.maxDeviation).toBe(PLATFORM_PRICE_MAX_DEVIATION_BPS);
  });

  it("accepts exactly the pool ids and instants the registry accepts", () => {
    POOL_ID_SAMPLES.forEach((poolId, index) => {
      const registryAccepts = validateHivraLaunchConfig({ ...VALID, poolId }).status === "configured";
      expect([poolId, values.poolIdAccepted[index]]).toEqual([poolId, registryAccepts]);
    });
    INSTANT_SAMPLES.forEach((activatesAt, index) => {
      const registryAccepts = validateHivraLaunchConfig({ ...VALID, activatesAt }).status === "configured";
      expect([activatesAt, values.instantAccepted[index]]).toEqual([activatesAt, registryAccepts]);
    });
  });

  it("writes a hivra-token-launch.ts the registry reads as a configured launch, changing nothing else", () => {
    const current = readFileSync(LAUNCH_FILE, "utf8");
    expect(values.dormantRoundTrip).toBe(current);

    const block = /contractAddress: "([^"]*)",\n {2}decimals: (\d+),\n {2}poolId: "([^"]*)",\n {2}activatesAt: "([^"]*)",/.exec(values.rendered);
    expect(block).not.toBeNull();
    const [, contractAddress, decimals, poolId, activatesAt] = block as RegExpExecArray;
    const parsed = { contractAddress, decimals: Number(decimals), poolId, activatesAt };
    expect(parsed).toEqual(VALID);
    expect(validateHivraLaunchConfig(parsed).status).toBe("configured");
    // Only the launch block differs from the committed file.
    const outside = (source: string) => source.replace(/export const HIVRA_TOKEN_LAUNCH[\s\S]*?\n\};/, "<block>");
    expect(outside(values.rendered)).toBe(outside(current));
  });
});
