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
jest.mock("@/lib/claim/hivra-airdrop-config", () => ({
  ...jest.requireActual("@/lib/claim/hivra-airdrop-config"),
  HIVRA_AIRDROP: {
    senderAddress: "0x3333333333333333333333333333333333333333",
    snapshotBlock: 36000000,
    snapshotTakenAt: null,
    snapshotUrl: "https://hivra-lookalike.example/snapshot",
    claim: { campaignUrl: "https://app.sablier.com.evil.example/campaign", opensAt: null, closesAt: null },
  },
}));

describe("/dashboard/convert with a live $HIVRA, a rejected snapshot link and a rejected claim link", () => {
  it("hides the snapshot and logs why", async () => {
    render(await ConvertPage());

    expect(screen.getByText("0x1111111111111111111111111111111111111111")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open the published snapshot" })).not.toBeInTheDocument();
    expect(screen.getByTestId("convert-snapshot-pending")).toBeInTheDocument();
    expect(jest.mocked(log.warn)).toHaveBeenCalledWith("HIVRA airdrop config rejected", {
      source: "dashboard/convert",
      problems: "snapshotUrl must be https on an allowed Hivra location; claim.campaignUrl must be a plain https link on app.sablier.com",
    });
  });
});
