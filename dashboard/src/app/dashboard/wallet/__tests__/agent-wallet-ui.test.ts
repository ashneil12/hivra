import {
  AGENT_WITHDRAWAL_GAS_NOTICE,
  formatWalletAmountCompact,
  formatWalletAmountDisplay,
  isWalletAmountShortened,
} from "../agent-wallet-ui";

describe("agent wallet UI helpers", () => {
  it("adds comma grouping while preserving the displayed decimal precision", () => {
    expect(formatWalletAmountDisplay("50000")).toBe("50,000");
    expect(formatWalletAmountDisplay("1234567.8900")).toBe("1,234,567.8900");
    expect(formatWalletAmountDisplay("0.0000")).toBe("0.0000");
    expect(formatWalletAmountDisplay("—")).toBe("—");
  });

  it("explains that Bankr gas sponsorship covers Base withdrawal fees", () => {
    expect(AGENT_WITHDRAWAL_GAS_NOTICE).toContain("Gas sponsorship");
    expect(AGENT_WITHDRAWAL_GAS_NOTICE).toContain("Base");
  });
});

describe("formatWalletAmountCompact", () => {
  it("cuts an 18-decimal balance to 6 fraction digits without rounding up", () => {
    // 1843201.123456789012345678 would round UP to .123457; it must not.
    expect(formatWalletAmountCompact("1843201.123456789012345678")).toBe("1,843,201.123456");
    expect(formatWalletAmountCompact("52718.293847561029384756")).toBe("52,718.293847");
    expect(formatWalletAmountCompact("0.999999999999999999")).toBe("0.999999");
  });

  it("keeps values that already fit exactly as displayed", () => {
    expect(formatWalletAmountCompact("1843201.123456")).toBe("1,843,201.123456");
    expect(formatWalletAmountCompact("0.0000")).toBe("0.0000");
    expect(formatWalletAmountCompact("0.010000")).toBe("0.010000");
    expect(formatWalletAmountCompact("1,234,567.8900")).toBe("1,234,567.8900");
    expect(formatWalletAmountCompact("10000000")).toBe("10,000,000");
    expect(formatWalletAmountCompact("—")).toBe("—");
    expect(formatWalletAmountCompact("")).toBe("—");
    expect(formatWalletAmountCompact(null)).toBe("—");
  });

  it("drops trailing zeros left by the cut, and the point when nothing is left", () => {
    expect(formatWalletAmountCompact("12.5000000001")).toBe("12.5");
    expect(formatWalletAmountCompact("7.0000000009")).toBe("7");
  });

  it("shows dust as <0.000001 instead of zero", () => {
    expect(formatWalletAmountCompact("0.000000123456789")).toBe("<0.000001");
    expect(formatWalletAmountCompact("0.0000009")).toBe("<0.000001");
    expect(formatWalletAmountCompact("-0.0000009")).toBe(">-0.000001");
    // An exact zero with many digits stays a zero, not dust.
    expect(formatWalletAmountCompact("0.000000000000000000")).toBe("0");
  });

  it("honours a different cap and leaves unparseable text alone", () => {
    expect(formatWalletAmountCompact("3.14159265", 2)).toBe("3.14");
    expect(formatWalletAmountCompact("0.001", 2)).toBe("<0.01");
    expect(formatWalletAmountCompact("n/a")).toBe("n/a");
  });

  it("reports when the compact form hides digits", () => {
    expect(isWalletAmountShortened("1843201.123456789012345678")).toBe(true);
    expect(isWalletAmountShortened("0.0000009")).toBe(true);
    expect(isWalletAmountShortened("1843201.123456")).toBe(false);
    expect(isWalletAmountShortened("0.010000")).toBe(false);
    expect(isWalletAmountShortened("—")).toBe(false);
  });
});
