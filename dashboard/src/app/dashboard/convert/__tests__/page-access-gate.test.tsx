/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

import { readConversionAccessGate } from "@/lib/claim/conversion-access.server";

import ConvertPage from "../page";

jest.mock("next/navigation", () => ({ useRouter: () => ({ refresh: jest.fn() }) }));
jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn(async () => ({ userId: "user_1" })) }));
jest.mock("@/lib/claim/conversion-access.server", () => ({ readConversionAccessGate: jest.fn() }));
// A live $HIVRA and valid links, so only the per-user access gate decides.
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

const gate = jest.mocked(readConversionAccessGate);

describe("/dashboard/convert access gate", () => {
  it("reads the gate for the signed-in user", async () => {
    gate.mockResolvedValue(null);
    render(await ConvertPage());

    expect(gate).toHaveBeenCalledWith("user_1", expect.any(Date));
  });

  it("stays closed when the gate can't be read", async () => {
    gate.mockResolvedValue(null);
    render(await ConvertPage());

    expect(screen.getByTestId("convert-closed")).toHaveTextContent(
      "Conversion is not open yet. Terms are published before it opens.",
    );
    expect(screen.queryByRole("link", { name: /go to conversion/i })).not.toBeInTheDocument();
  });

  it("shows the switch step, not the swap link, to a grandfathered holder who hasn't switched", async () => {
    gate.mockResolvedValue({ grandfathered: true, convertedAt: null, conversionGraceEndsAt: null });
    render(await ConvertPage());

    expect(screen.getByTestId("convert-switch-access")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /go to conversion/i })).not.toBeInTheDocument();
  });

  it("shows the swap link once the holder's tier counts $HIVRA", async () => {
    gate.mockResolvedValue({ grandfathered: true, convertedAt: "2026-10-01T12:00:00.000Z", conversionGraceEndsAt: "2026-10-04T12:00:00.000Z" });
    render(await ConvertPage());

    expect(screen.getByRole("link", { name: "Go to conversion" })).toHaveAttribute("href", "https://bankr.bot/convert");
  });
});
