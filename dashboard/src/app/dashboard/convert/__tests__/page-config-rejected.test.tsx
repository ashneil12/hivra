/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

import { log } from "@/lib/logger";

import ConvertPage from "../page";

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn(async () => ({ userId: "user_1" })) }));
jest.mock("@/lib/claim/conversion-access.server", () => ({ readConversionAccessGate: jest.fn(async () => null) }));
jest.mock("@/lib/logger", () => ({ log: { warn: jest.fn() } }));
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
  CONVERSION_LINKS: {
    termsUrl: "https://hivra.cloud/terms",
    conversionUrl: "https://bankr-lookalike.example/convert",
  },
}));

describe("/dashboard/convert with a live $HIVRA and a rejected conversion link", () => {
  it("keeps conversion closed and logs why", async () => {
    render(await ConvertPage());

    expect(screen.getByText("0x1111111111111111111111111111111111111111")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /go to conversion/i })).not.toBeInTheDocument();
    expect(jest.mocked(log.warn)).toHaveBeenCalledWith("HIVRA conversion links rejected", {
      source: "dashboard/convert",
      problems: "conversionUrl must be https on an allowed host",
    });
  });
});
