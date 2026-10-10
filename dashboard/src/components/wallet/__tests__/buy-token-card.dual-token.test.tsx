/** @jest-environment jsdom */
/**
 * The Buy card's label names the token its Uniswap link and contract are for:
 * $HermesOS while $HIVRA is dormant, $HIVRA once it is live.
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

const mockLaunch = { contractAddress: "", decimals: 18, poolId: "", activatesAt: "" };
jest.mock("@/lib/billing/hivra-token-launch", () => ({
  get HIVRA_TOKEN_LAUNCH() {
    return mockLaunch;
  },
}));
jest.mock("@/components/i18n/LocaleProvider", () => ({
  useLocale: () => ({ copy: jest.requireActual("@/lib/i18n").MARKETING_COPY.en, locale: "en" }),
}));

import { BuyTokenCard } from "../QuoteSection";

const HIVRA_ADDRESS = "0x3333333333333333333333333333333333333333";

beforeEach(() => Object.assign(mockLaunch, { contractAddress: "", poolId: "", activatesAt: "" }));

it("is a $HermesOS card while $HIVRA is dormant", () => {
  render(<BuyTokenCard />);
  expect(screen.getByRole("region", { name: "Buy $HermesOS" })).toBeInTheDocument();
  expect(screen.getByText("Get $HermesOS")).toBeInTheDocument();
});

it("labels the card $HIVRA when it points at $HIVRA", () => {
  Object.assign(mockLaunch, { contractAddress: HIVRA_ADDRESS, poolId: `0x${"ab".repeat(32)}`, activatesAt: "2026-01-01T00:00:00Z" });
  render(<BuyTokenCard />);
  expect(screen.getByRole("region", { name: "Buy $HIVRA" })).toBeInTheDocument();
  expect(screen.getByText("Get $HIVRA")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Uniswap/ })).toHaveAttribute("href", expect.stringContaining(HIVRA_ADDRESS));
  expect(screen.queryByText(/\$HermesOS/)).not.toBeInTheDocument();
});
