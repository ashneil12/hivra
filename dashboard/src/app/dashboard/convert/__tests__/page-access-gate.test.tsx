/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

import { readConversionAccessGate } from "@/lib/claim/conversion-access.server";

import ConvertPage from "../page";

jest.mock("next/navigation", () => ({ useRouter: () => ({ refresh: jest.fn() }) }));
jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn(async () => ({ userId: "user_1" })) }));
jest.mock("@/lib/claim/conversion-access.server", () => ({ readConversionAccessGate: jest.fn() }));
// A live $HIVRA and a closed claim window, so only the per-user access gate decides.
jest.mock("@/lib/billing/hivra-token-launch", () => ({
  HIVRA_TOKEN_LAUNCH: {
    contractAddress: "0x1111111111111111111111111111111111111111",
    decimals: 18,
    poolId: `0x${"ab".repeat(32)}`,
    activatesAt: "2026-01-01T00:00:00Z",
  },
}));
jest.mock("@/lib/claim/hivra-airdrop-config", () => ({
  ...jest.requireActual("@/lib/claim/hivra-airdrop-config"),
  HIVRA_AIRDROP: {
    senderAddress: "0x3333333333333333333333333333333333333333",
    snapshotBlock: 36000000,
    snapshotTakenAt: null,
    snapshotUrl: "https://hivra.cloud/token/airdrop-snapshot",
    claim: {
      campaignUrl: "https://app.sablier.com/airdrops/campaign/0xabc123/",
      opensAt: "2026-01-01T00:00:00Z",
      closesAt: "2026-01-02T00:00:00Z",
    },
  },
}));

const gate = jest.mocked(readConversionAccessGate);

describe("/dashboard/convert access gate", () => {
  it("reads the gate for the signed-in user", async () => {
    gate.mockResolvedValue(null);
    render(await ConvertPage());

    expect(gate).toHaveBeenCalledWith("user_1", expect.any(Date));
  });

  it("shows the claim but nothing about the tier when the gate can't be read", async () => {
    gate.mockResolvedValue(null);
    render(await ConvertPage());

    expect(screen.getByTestId("convert-snapshot-block")).toBeInTheDocument();
    expect(screen.getByTestId("convert-claim-window")).toHaveTextContent(/^Claim window: 1 January 2026.*00:00 UTC to 2 January 2026.*00:00 UTC$/);
    expect(screen.queryByTestId("convert-switch-access")).not.toBeInTheDocument();
    expect(screen.getByText(/Billing shows which token your tier counts/)).toBeInTheDocument();
  });

  it("does not link to the wallet lookup while the committed list is not published", async () => {
    gate.mockResolvedValue(null);
    const previous = process.env.HIVRA_NEW_TOKEN_SURFACES;
    process.env.HIVRA_NEW_TOKEN_SURFACES = "1";
    try {
      const { container } = render(await ConvertPage());
      expect(screen.getByTestId("convert-snapshot-block")).toBeInTheDocument();
      expect(container.querySelector('a[href="/token/airdrop"]')).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.HIVRA_NEW_TOKEN_SURFACES;
      else process.env.HIVRA_NEW_TOKEN_SURFACES = previous;
    }
  });

  it("offers the switch step to a grandfathered holder who hasn't switched, once the claim window has closed", async () => {
    gate.mockResolvedValue({ grandfathered: true, convertedAt: null, conversionGraceEndsAt: null });
    render(await ConvertPage());

    expect(screen.getByTestId("convert-switch-access")).toBeInTheDocument();
  });

  it("shows the grace end once the holder's tier counts $HIVRA", async () => {
    gate.mockResolvedValue({ grandfathered: true, convertedAt: "2026-10-01T12:00:00.000Z", conversionGraceEndsAt: "2026-10-04T12:00:00.000Z" });
    render(await ConvertPage());

    expect(screen.queryByTestId("convert-switch-access")).not.toBeInTheDocument();
    expect(screen.getByText(/Until 4 October 2026 at 12:00 UTC, holding either token keeps your tier/)).toBeInTheDocument();
  });
});
