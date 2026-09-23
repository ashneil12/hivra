/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

import ConvertPage from "../page";

jest.mock("@/lib/billing/hivra-token-launch", () => ({
  HIVRA_TOKEN_LAUNCH: {
    contractAddress: "0x1111111111111111111111111111111111111111",
    decimals: 18,
    poolId: `0x${"ab".repeat(32)}`,
    activatesAt: "2026-01-01T00:00:00Z",
  },
}));
jest.mock("@/lib/claim/conversion-links-config", () => ({
  ...jest.requireActual("@/lib/claim/conversion-links-config"),
  CONVERSION_LINKS: { termsUrl: "https://hivra.cloud/terms", conversionUrl: "https://bankr.bot/convert" },
}));

describe("/dashboard/convert with a live $HIVRA and valid links", () => {
  it("stays closed while the per-user access gate is not wired", () => {
    render(<ConvertPage />);

    expect(screen.getByTestId("convert-closed")).toHaveTextContent(
      "Conversion is not open yet. Terms are published before it opens.",
    );
    expect(screen.queryByRole("link", { name: /go to conversion/i })).not.toBeInTheDocument();
  });
});
