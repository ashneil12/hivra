/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

import TokenPageClient from "../TokenPageClient";
import type { TokenPageEntry } from "@/lib/token-verification-content";

jest.mock("@/components/public-site/PublicSite", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
const mockAirdrop = {
  senderAddress: "0x3333333333333333333333333333333333333333" as string | null,
  snapshotBlock: 36000000 as number | null,
  snapshotUrl: "https://hivra.cloud/token/airdrop-snapshot" as string | null,
  sentAt: null,
};
jest.mock("@/lib/claim/hivra-airdrop-config", () => ({
  ...jest.requireActual("@/lib/claim/hivra-airdrop-config"),
  get HIVRA_AIRDROP() {
    return mockAirdrop;
  },
}));

const HERMESOS: TokenPageEntry = {
  key: "hermesos",
  label: "$HermesOS",
  status: "legacy",
  contractAddress: "0x95ccfD2B81A9667b0Cc979992632F98fc853EBa3",
  basescanUrl: "https://basescan.org/token/0x95ccfD2B81A9667b0Cc979992632F98fc853EBa3",
  activatesAt: null,
};
const HIVRA_LIVE: TokenPageEntry = {
  key: "hivra",
  label: "$HIVRA",
  status: "live",
  contractAddress: "0x1111111111111111111111111111111111111111",
  basescanUrl: "https://basescan.org/token/0x1111111111111111111111111111111111111111",
  activatesAt: "2026-10-01T16:00:00.000Z",
};
const HIVRA_DORMANT: TokenPageEntry = { ...HIVRA_LIVE, status: "not_launched", contractAddress: null, basescanUrl: null, activatesAt: null };

describe("/token airdrop details", () => {
  afterEach(() => {
    mockAirdrop.snapshotBlock = 36000000;
    mockAirdrop.snapshotUrl = "https://hivra.cloud/token/airdrop-snapshot";
  });

  it("shows the published snapshot block, list and sender once $HIVRA is launched", () => {
    render(<TokenPageClient entries={[HIVRA_LIVE, HERMESOS]} />);

    expect(screen.getByTestId("token-airdrop-details")).toHaveTextContent("Snapshot block: 36000000.");
    expect(screen.getByRole("link", { name: "Open the published snapshot" })).toHaveAttribute(
      "href",
      "https://hivra.cloud/token/airdrop-snapshot",
    );
    expect(screen.getByText("0x3333333333333333333333333333333333333333")).toBeInTheDocument();
  });

  it("shows nothing about the airdrop while $HIVRA is dormant", () => {
    const { container } = render(<TokenPageClient entries={[HERMESOS, HIVRA_DORMANT]} />);

    expect(screen.queryByTestId("token-airdrop-details")).not.toBeInTheDocument();
    expect(container.textContent).not.toContain("0x3333333333333333333333333333333333333333");
  });

  it("shows no details until the snapshot is published", () => {
    mockAirdrop.snapshotUrl = null;
    render(<TokenPageClient entries={[HIVRA_LIVE, HERMESOS]} />);

    expect(screen.queryByTestId("token-airdrop-details")).not.toBeInTheDocument();
  });

  it("links to the wallet lookup only when the server says it is served", () => {
    const { rerender } = render(<TokenPageClient entries={[HIVRA_LIVE, HERMESOS]} airdropLookupHref="/token/airdrop" />);
    expect(screen.getByRole("link", { name: "Check a wallet for the $HIVRA airdrop" })).toHaveAttribute("href", "/token/airdrop");

    rerender(<TokenPageClient entries={[HIVRA_LIVE, HERMESOS]} />);
    expect(screen.getByTestId("token-airdrop-details")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /check a wallet/i })).not.toBeInTheDocument();
  });

  it("never links a blocked viewer to the lookup, whatever is passed", () => {
    const { container } = render(
      <TokenPageClient entries={[HIVRA_LIVE, HERMESOS]} geoNotice="Token features aren't available to you." airdropLookupHref="/token/airdrop" />,
    );
    expect(container.querySelector('a[href="/token/airdrop"]')).toBeNull();
  });

  it("hides the details from a viewer the token geo-policy blocks", () => {
    render(<TokenPageClient entries={[HIVRA_LIVE, HERMESOS]} geoNotice="Token features aren't available to you." />);

    expect(screen.queryByTestId("token-airdrop-details")).not.toBeInTheDocument();
  });
});
