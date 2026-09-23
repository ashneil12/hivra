/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";

jest.mock("@/lib/billing/hivra-token-launch", () => ({
  HIVRA_TOKEN_LAUNCH: {
    contractAddress: "0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf",
    decimals: 18,
    poolId: `0x${"cd".repeat(32)}`,
    activatesAt: "2026-01-01T00:00:00Z",
  },
}));

import { TokenContractLine } from "@/components/billing/TransferDetails";

// The mocked launch block's contract, lower-cased as stored on quotes.
const HIVRA_CONTRACT = "0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf";

it("shows the $HIVRA contract for a $HIVRA quote", () => {
  render(<TokenContractLine tokenAddress={HIVRA_CONTRACT} tokenSymbol="HIVRA" />);
  expect(screen.getByText("0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf")).toBeInTheDocument();
  expect(screen.getByText(/Send only \$HIVRA from this contract\. Any other token sent here is not credited/)).toBeInTheDocument();
});
