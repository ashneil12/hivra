import { HIVRA_TOKEN_LAUNCH } from "@/lib/billing/hivra-token-launch";
import {
  HERMESOS_TOKEN,
  getActiveHivraToken,
  getHivraTokenPhase,
  isHivraActive,
  livePlatformTokens,
  platformTokenByAddress,
  platformTokenByKey,
  primaryPlatformToken,
  validateHivraLaunchConfig,
} from "@/lib/billing/token-registry";
import { displayTokenUnit } from "@/lib/billing/token-plan-prices";
import { HERMESOS_TOKEN_ADDRESS, HERMESOS_TOKEN_SYMBOL } from "@/lib/billing/token-holdings";
import { getTokenPageEntries } from "@/lib/token-verification-content";

const TEST_HIVRA = {
  contractAddress: "0x1111111111111111111111111111111111111111",
  decimals: 18,
  poolId: `0x${"ab".repeat(32)}`,
  activatesAt: "2026-10-01T16:00:00Z",
};
const BEFORE = new Date("2026-10-01T15:59:59Z");
const AFTER = new Date("2026-10-01T16:00:00Z");

describe("platform token registry", () => {
  it("the committed $HIVRA launch block is dormant or a complete, valid launch", () => {
    // Guards the activation PR: a half-filled or malformed paste fails here.
    const validation = validateHivraLaunchConfig(HIVRA_TOKEN_LAUNCH);
    expect(validation.status === "invalid" ? validation.errors : []).toEqual([]);
  });

  it("keeps the $HermesOS identity the billing code has always used", () => {
    expect(HERMESOS_TOKEN.address).toBe("0x95ccfd2b81a9667b0cc979992632f98fc853eba3");
    expect(HERMESOS_TOKEN_ADDRESS).toBe(HERMESOS_TOKEN.address);
    expect(HERMESOS_TOKEN.symbol).toBe("HermesOS");
    expect(HERMESOS_TOKEN_SYMBOL).toBe("HermesOS");
    expect(HERMESOS_TOKEN.decimals).toBe(18);
  });

  it("is $HermesOS-only while $HIVRA is dormant", () => {
    const dormant = { contractAddress: "", decimals: 18, poolId: "", activatesAt: "" };
    expect(validateHivraLaunchConfig(dormant)).toEqual({ status: "dormant" });
    expect(getHivraTokenPhase(AFTER, dormant)).toBe("dormant");
    expect(isHivraActive(AFTER, dormant)).toBe(false);
    expect(livePlatformTokens(AFTER, dormant)).toEqual([HERMESOS_TOKEN]);
    expect(primaryPlatformToken(AFTER, dormant)).toBe(HERMESOS_TOKEN);
    expect(platformTokenByKey("hivra", dormant)).toBeNull();
    expect(platformTokenByAddress(TEST_HIVRA.contractAddress, dormant)).toBeNull();
  });

  it("activates $HIVRA at its instant and makes it the primary token", () => {
    expect(getHivraTokenPhase(BEFORE, TEST_HIVRA)).toBe("scheduled");
    expect(primaryPlatformToken(BEFORE, TEST_HIVRA)).toBe(HERMESOS_TOKEN);
    expect(getHivraTokenPhase(AFTER, TEST_HIVRA)).toBe("active");
    const hivra = getActiveHivraToken(AFTER, TEST_HIVRA);
    expect(hivra).toMatchObject({
      key: "hivra",
      symbol: "HIVRA",
      displayUnit: "$HIVRA",
      address: TEST_HIVRA.contractAddress,
      poolId: TEST_HIVRA.poolId,
      decimals: 18,
    });
    expect(livePlatformTokens(AFTER, TEST_HIVRA).map((token) => token.key)).toEqual(["hermesos", "hivra"]);
    expect(primaryPlatformToken(AFTER, TEST_HIVRA).key).toBe("hivra");
    expect(platformTokenByAddress(TEST_HIVRA.contractAddress.toUpperCase().replace("0X", "0x"), TEST_HIVRA)?.key).toBe("hivra");
    expect(platformTokenByAddress(HERMESOS_TOKEN.publishedAddress, TEST_HIVRA)).toBe(HERMESOS_TOKEN);
  });

  it.each([
    ["address only", { ...TEST_HIVRA, poolId: "", activatesAt: "" }],
    ["bad address", { ...TEST_HIVRA, contractAddress: "0x123" }],
    ["zero address", { ...TEST_HIVRA, contractAddress: `0x${"0".repeat(40)}` }],
    ["the $HermesOS address", { ...TEST_HIVRA, contractAddress: HERMESOS_TOKEN.publishedAddress }],
    ["bad pool id", { ...TEST_HIVRA, poolId: "0xdead" }],
    ["timestamp without zone", { ...TEST_HIVRA, activatesAt: "2026-10-01T16:00:00" }],
    ["impossible date", { ...TEST_HIVRA, activatesAt: "2026-02-30T00:00:00Z" }],
    ["non-UTC offset", { ...TEST_HIVRA, activatesAt: "2026-10-01T16:00:00+01:00" }],
    ["bad decimals", { ...TEST_HIVRA, decimals: 18.5 }],
  ])("keeps $HIVRA dormant on a malformed launch block: %s", (_label, config) => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    expect(validateHivraLaunchConfig(config).status).toBe("invalid");
    expect(isHivraActive(AFTER, config)).toBe(false);
    expect(primaryPlatformToken(AFTER, config)).toBe(HERMESOS_TOKEN);
    errorSpy.mockRestore();
  });
});

describe("displayTokenUnit", () => {
  it("names each platform token by address, and legacy stored symbols as $HermesOS", () => {
    expect(displayTokenUnit("Hivra")).toBe("$HermesOS");
    expect(displayTokenUnit("HermesOS")).toBe("$HermesOS");
    expect(displayTokenUnit(undefined)).toBe("$HermesOS");
    expect(displayTokenUnit("HIVRA")).toBe("$HIVRA");
    expect(displayTokenUnit("Hivra", HERMESOS_TOKEN.address)).toBe("$HermesOS");
    expect(displayTokenUnit("USDC")).toBe("USDC");
  });
});

describe("/token page entries", () => {
  it("lists $HermesOS and a not-launched $HIVRA while dormant", () => {
    const entries = getTokenPageEntries(AFTER);
    expect(entries.map((entry) => [entry.label, entry.status, entry.contractAddress])).toEqual([
      ["$HermesOS", "live", HERMESOS_TOKEN.publishedAddress],
      ["$HIVRA", "not_launched", null],
    ]);
  });
});
