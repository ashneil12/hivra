import {
  MICRODOLLARS_PER_CENT,
  MICRODOLLARS_PER_USD,
  centsToMicrodollars,
  microdollarsToDisplayDollars,
  multiplyMicrodollarsByRatio,
} from "@/lib/billing/microdollars";

describe("microdollar helpers", () => {
  it("uses microdollars as the internal USD unit", () => {
    expect(MICRODOLLARS_PER_USD).toBe(1_000_000);
    expect(MICRODOLLARS_PER_CENT).toBe(10_000);
    expect(centsToMicrodollars(123)).toBe(1_230_000);
    expect(microdollarsToDisplayDollars(123_456)).toBe("$0.1235");
  });

  it("rounds monetary ratios conservatively", () => {
    expect(multiplyMicrodollarsByRatio(1_000_001, 20, 100)).toBe(200_001);
  });

  it("rejects invalid monetary inputs before they reach accounting", () => {
    expect(() => centsToMicrodollars(-1)).toThrow(/non-negative integer/);
    expect(() => multiplyMicrodollarsByRatio(1, 0, 100)).toThrow(/positive integer/);
    expect(() => multiplyMicrodollarsByRatio(1.5, 1, 2)).toThrow(/non-negative integer/);
  });
});
