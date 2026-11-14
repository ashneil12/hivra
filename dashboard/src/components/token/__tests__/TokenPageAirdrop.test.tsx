/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";

import TokenPageClient from "../TokenPageClient";
import { resolveAirdropFacts, type TokenPageAirdropFacts } from "@/lib/claim/conversion-state";
import type { TokenPageEntry } from "@/lib/token-verification-content";

jest.mock("@/components/public-site/PublicSite", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
const mockAirdrop = {
  senderAddress: "0x3333333333333333333333333333333333333333" as string | null,
  snapshotBlock: 36000000 as number | null,
  snapshotTakenAt: null as string | null,
  snapshotUrl: "https://hivra.cloud/token/airdrop-snapshot" as string | null,
  claim: { campaignUrl: null, opensAt: null, closesAt: null },
};
// The server resolves the airdrop facts and passes them down (getTokenPageAirdropFacts); the page itself never reads the config.
function facts(): TokenPageAirdropFacts {
  const { snapshot, senderAddress } = resolveAirdropFacts(mockAirdrop, HIVRA_LIVE.contractAddress as string, new Date("2026-11-01T00:00:00Z"));
  return { snapshot, senderAddress };
}

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

const SENDER = "0x3333333333333333333333333333333333333333";
const SNAPSHOT_URL = "https://hivra.cloud/token/airdrop-snapshot";

describe("/token airdrop details once $HIVRA is launched", () => {
  afterEach(() => {
    mockAirdrop.senderAddress = SENDER;
    mockAirdrop.snapshotBlock = 36000000;
    mockAirdrop.snapshotTakenAt = null;
    mockAirdrop.snapshotUrl = SNAPSHOT_URL;
  });

  it("shows the snapshot date, formatted, only once snapshotTakenAt is set, between the links and the block", () => {
    mockAirdrop.snapshotTakenAt = "2026-10-20T16:00:00Z";
    render(<TokenPageClient entries={[HIVRA_LIVE, HERMESOS]} airdropFacts={facts()} />);
    expect(screen.getByTestId("token-airdrop-details")).toHaveTextContent(
      `Snapshot date: 20 October 2026Snapshot block: 36000000Airdrop wallet: ${SENDER}View on BaseScan`,
    );
  });

  it("never prints a snapshot date it cannot read as a UTC instant", () => {
    mockAirdrop.snapshotTakenAt = "yesterday";
    render(<TokenPageClient entries={[HIVRA_LIVE, HERMESOS]} airdropFacts={facts()} />);
    expect(screen.getByTestId("token-airdrop-details")).not.toHaveTextContent("Snapshot date");
    expect(screen.getByTestId("token-airdrop-details")).toHaveTextContent("Snapshot block: 36000000");
  });

  it("shows the published snapshot block, the snapshot link and the airdrop wallet with its BaseScan link", () => {
    render(<TokenPageClient entries={[HIVRA_LIVE, HERMESOS]} airdropFacts={facts()} />);

    const details = within(screen.getByTestId("token-airdrop-details"));
    expect(screen.getByTestId("token-airdrop-details")).toHaveTextContent(`Snapshot block: 36000000Airdrop wallet: ${SENDER}View on BaseScan`);
    expect(screen.getByRole("link", { name: "View the published snapshot" })).toHaveAttribute("href", SNAPSHOT_URL);
    expect(details.getByRole("link", { name: "View on BaseScan" })).toHaveAttribute("href", `https://basescan.org/address/${SENDER}`);
  });

  it("shows nothing about the airdrop while $HIVRA is dormant", () => {
    const { container } = render(<TokenPageClient entries={[HERMESOS, HIVRA_DORMANT]} />);

    expect(screen.queryByTestId("token-airdrop-details")).not.toBeInTheDocument();
    expect(container.textContent).not.toContain(SENDER);
  });

  it.each([
    ["the snapshot list is not published", () => { mockAirdrop.snapshotUrl = null; }],
    ["the snapshot block is not published", () => { mockAirdrop.snapshotBlock = null; }],
    ["the snapshot list is not on an allowed Hivra location", () => { mockAirdrop.snapshotUrl = "https://hivra.example/snapshot"; }],
  ])("hides the snapshot block and the snapshot link when %s, and keeps the airdrop wallet", (_why, arrange) => {
    arrange();
    const { container } = render(<TokenPageClient entries={[HIVRA_LIVE, HERMESOS]} airdropFacts={facts()} />);

    expect(container.textContent).not.toContain("Snapshot block");
    expect(screen.queryByRole("link", { name: "View the published snapshot" })).not.toBeInTheDocument();
    expect(screen.getByTestId("token-airdrop-details")).toHaveTextContent(`Airdrop wallet: ${SENDER}`);
    expect(container.textContent).not.toMatch(/\[|CONFIRM|PLACEHOLDER/);
  });

  it("hides the airdrop wallet line and its BaseScan link when no sender is published", () => {
    mockAirdrop.senderAddress = null;
    const { container } = render(<TokenPageClient entries={[HIVRA_LIVE, HERMESOS]} airdropFacts={facts()} />);

    expect(container.textContent).not.toContain("Airdrop wallet");
    expect(container.querySelector('a[href^="https://basescan.org/address/"]')).toBeNull();
    expect(screen.getByTestId("token-airdrop-details")).toHaveTextContent("Snapshot block: 36000000");
  });

  it("hides the whole details block when neither the snapshot nor the sender is published", () => {
    mockAirdrop.senderAddress = null;
    mockAirdrop.snapshotUrl = null;
    render(<TokenPageClient entries={[HIVRA_LIVE, HERMESOS]} airdropFacts={facts()} />);

    expect(screen.queryByTestId("token-airdrop-details")).not.toBeInTheDocument();
    expect(screen.queryByTestId("token-holder-links")).not.toBeInTheDocument();
  });

  it("links to the eligibility and claim page only when the server says it is served", () => {
    const { rerender } = render(<TokenPageClient entries={[HIVRA_LIVE, HERMESOS]} airdropFacts={facts()} airdropLookupHref="/token/airdrop" />);
    expect(screen.getByRole("link", { name: "Check eligibility and claim through the official Sablier flow" })).toHaveAttribute("href", "/token/airdrop");

    rerender(<TokenPageClient entries={[HIVRA_LIVE, HERMESOS]} airdropFacts={facts()} />);
    expect(screen.getByTestId("token-airdrop-details")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /check eligibility/i })).not.toBeInTheDocument();
  });

  it("links to the migration details, in both places, only when the server says the page is served", () => {
    const { container, rerender } = render(<TokenPageClient entries={[HIVRA_LIVE, HERMESOS]} airdropFacts={facts()} migrationHref="/token/migration" />);
    const links = screen.getAllByRole("link", { name: "Read the migration details" });
    expect(links).toHaveLength(2);
    for (const link of links) expect(link).toHaveAttribute("href", "/token/migration");
    // The second one closes "Avoid fake migration links".
    expect(within(container.querySelector("#official-accounts") as HTMLElement).getByRole("link", { name: "Read the migration details" })).toBeInTheDocument();

    rerender(<TokenPageClient entries={[HIVRA_LIVE, HERMESOS]} airdropFacts={facts()} />);
    expect(screen.queryByRole("link", { name: "Read the migration details" })).not.toBeInTheDocument();
    expect(container.querySelector('a[href="/token/migration"]')).toBeNull();
  });

  it("never links a blocked viewer to the lookup or the migration page, whatever is passed", () => {
    const { container } = render(
      <TokenPageClient entries={[HIVRA_LIVE, HERMESOS]} airdropFacts={facts()} geoNotice="Token features aren't available to you." airdropLookupHref="/token/airdrop" migrationHref="/token/migration" />,
    );
    expect(container.querySelector('a[href="/token/airdrop"]')).toBeNull();
    expect(container.querySelector('a[href="/token/migration"]')).toBeNull();
  });

  it("hides the details from a viewer the token geo-policy blocks", () => {
    render(<TokenPageClient entries={[HIVRA_LIVE, HERMESOS]} airdropFacts={facts()} geoNotice="Token features aren't available to you." />);

    expect(screen.queryByTestId("token-airdrop-details")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "View the published snapshot" })).not.toBeInTheDocument();
  });
});
