/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";

import { TokenContractLine } from "@/components/billing/TransferDetails";
import { HERMESOS_TOKEN } from "@/lib/billing/token-registry";

describe("TokenContractLine (every 'Send exactly' step)", () => {
  it("shows the $HermesOS contract for a $HermesOS quote, including legacy 'Hivra' payloads", () => {
    const { unmount } = render(<TokenContractLine tokenAddress={HERMESOS_TOKEN.address} tokenSymbol="HermesOS" />);
    expect(screen.getByText(HERMESOS_TOKEN.publishedAddress)).toBeInTheDocument();
    expect(screen.getByText(/Send only \$HermesOS from this contract/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "the token page" })).toHaveAttribute("href", "/token");
    unmount();
    render(<TokenContractLine tokenSymbol="Hivra" />);
    expect(screen.getByText(HERMESOS_TOKEN.publishedAddress)).toBeInTheDocument();
  });

  it("names nothing for a token it can't identify", () => {
    const { container } = render(
      <TokenContractLine tokenAddress="0x3333333333333333333333333333333333333333" tokenSymbol="HIVRA" />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
