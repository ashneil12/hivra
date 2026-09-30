import { HERMESOS_DISPLAY_UNIT, displayTokenUnit } from "../token-plan-prices";

describe("displayTokenUnit", () => {
  it("shows $HermesOS for the stored Hivra symbol and for missing symbols", () => {
    expect(displayTokenUnit("Hivra")).toBe(HERMESOS_DISPLAY_UNIT);
    // "HIVRA" is the new token's stored symbol, no longer a legacy spelling.
    expect(displayTokenUnit("HIVRA")).toBe("$HIVRA");
    expect(displayTokenUnit("HermesOS")).toBe("$HermesOS");
    expect(displayTokenUnit("$HermesOS")).toBe("$HermesOS");
    expect(displayTokenUnit(undefined)).toBe("$HermesOS");
    expect(displayTokenUnit("  ")).toBe("$HermesOS");
  });

  it("leaves other assets alone", () => {
    expect(displayTokenUnit("USDC")).toBe("USDC");
    expect(displayTokenUnit("VVV")).toBe("VVV");
    expect(displayTokenUnit(" ETH ")).toBe("ETH");
  });
});
