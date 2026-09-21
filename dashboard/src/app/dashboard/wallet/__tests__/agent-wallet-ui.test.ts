import {
  AGENT_WITHDRAWAL_GAS_NOTICE,
  formatWalletAmountDisplay,
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
