/** @jest-environment jsdom */
/**
 * The launched /token (scheduled and active) is Ash's website pack page
 * 01-token.md (v3, 20 October 2026), verbatim. These tests pin his headings,
 * paragraphs, bold and italic runs and the order of sections and links, so a
 * reword shows up in review. They also pin that every address, date and link
 * target comes from data and that a line whose data is missing is left out.
 */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import TokenPageClient from "../TokenPageClient";
import type { TokenPageEntry } from "@/lib/token-verification-content";

const mockCopy = jest.fn();
jest.mock("@/lib/client/clipboard", () => ({ copyTextToClipboard: (value: string) => mockCopy(value) }));
jest.mock("@/components/public-site/PublicSite", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

const SENDER = "0x3B954866d4329E19C1B9165774c88508f2fefA0c";
const PUBLISHED_AIRDROP = {
  senderAddress: SENDER,
  snapshotBlock: 36000000,
  snapshotTakenAt: "2026-10-20T16:00:00Z",
  snapshotUrl: "https://hivra.cloud/token/airdrop-snapshot",
  claim: { campaignUrl: null, opensAt: null, closesAt: null },
};
// The claim core's config as the page reads it. The getter is read at render, so a test can swap the facts.
let mockAirdrop: Record<string, unknown> = { ...PUBLISHED_AIRDROP };
jest.mock("@/lib/claim/hivra-airdrop-config", () => ({
  ...jest.requireActual("@/lib/claim/hivra-airdrop-config"),
  get HIVRA_AIRDROP() {
    return mockAirdrop;
  },
}));

const HIVRA_ADDRESS = "0x1111111111111111111111111111111111111111";
const HERMESOS_ADDRESS = "0x95ccfD2B81A9667b0Cc979992632F98fc853EBa3";
const HERMESOS: TokenPageEntry = {
  key: "hermesos",
  label: "$HermesOS",
  status: "legacy",
  contractAddress: HERMESOS_ADDRESS,
  basescanUrl: `https://basescan.org/token/${HERMESOS_ADDRESS}`,
  activatesAt: null,
};
const HIVRA: TokenPageEntry = {
  key: "hivra",
  label: "$HIVRA",
  status: "live",
  contractAddress: HIVRA_ADDRESS,
  basescanUrl: `https://basescan.org/token/${HIVRA_ADDRESS}`,
  activatesAt: "2026-10-01T16:00:00.000Z",
};
const PHASES = {
  active: [HIVRA, HERMESOS],
  // Scheduled entries list $HermesOS first; the launched page still shows $HIVRA first.
  scheduled: [{ ...HERMESOS, status: "live" }, { ...HIVRA, status: "scheduled", activatesAt: "2099-10-01T16:00:00.000Z" }],
} as const satisfies Record<string, TokenPageEntry[]>;

function renderLaunched(
  entries: readonly TokenPageEntry[] = PHASES.active,
  hrefs: { airdropLookupHref: string | null; migrationHref: string | null } = { airdropLookupHref: "/token/airdrop", migrationHref: "/token/migration" },
) {
  return render(<TokenPageClient entries={[...entries]} {...hrefs} />);
}

/** Matches an element by its whole text, so a paragraph split by <strong> or <em> still matches. */
const whole = (tag: string, text: string) => (_: string, element: Element | null) =>
  element?.tagName === tag && element.textContent === text;

beforeEach(() => {
  mockAirdrop = { ...PUBLISHED_AIRDROP };
});

describe.each(Object.entries(PHASES))("launched /token (%s)", (_phase, entries) => {
  it("renders Ash's headings in order", () => {
    renderLaunched(entries);
    const headings = screen.getAllByRole("heading").map((node) => `${node.tagName} ${node.textContent}`);
    expect(headings).toEqual([
      "H1 $HIVRA and $HermesOS",
      "H2 Check the official contracts",
      "H3 $HIVRA · New ecosystem token",
      "H3 $HermesOS · Legacy token",
      "H2 Already hold $HermesOS?",
      "H2 How token access works",
      "H2 What could $HIVRA be used for?",
      "H3 Computing and tools",
      "H3 People building the ecosystem",
      "H3 Security that can be tested",
      "H3 Budgets with limits",
      "H2 What the token does not give you",
      "H2 Avoid fake migration links",
    ]);
  });

  it("renders the breadcrumb, eyebrow, intro, bold line and italic risk line", () => {
    const { container } = renderLaunched(entries);
    const main = screen.getByRole("main");
    expect(main.firstElementChild).toHaveTextContent(/^Ecosystem$/);
    expect(main.firstElementChild).toHaveAttribute("href", "/ecosystem");
    expect(container.querySelector("header strong")).toHaveTextContent(/^THE HIVRA TOKEN$/);
    for (const text of [
      "Hivra started as HermesOS. The platform has grown beyond its original name, and $HIVRA is the new token for the wider ecosystem we're building.",
      "The original $HermesOS token remains on Base. If you qualified for compute access through it before the transition, you keep that access under the existing rules. Eligible holders can claim $HIVRA through Sablier based on the snapshot already taken.",
      "You don't need a token to use Hivra. Pay by card for Hivra Cloud, or run the open-source platform yourself with no Hivra account or token.",
    ]) expect(screen.getByText(whole("P", text))).toBeInTheDocument();
    expect(screen.getByText("You don't need a token to use Hivra.").tagName).toBe("STRONG");
    const risk = screen.getByTestId("token-risk-line");
    expect(risk.querySelector("em")).toHaveTextContent(
      /^Cryptoassets can lose all their value\. This page explains Hivra's tokens and migration arrangements\. It is not an offer or invitation to buy\.$/,
    );
  });

  it("shows each contract card with Network, Contract, a copy button and a BaseScan link", () => {
    const { container } = renderLaunched(entries);
    for (const [key, address, note] of [
      ["hivra", HIVRA_ADDRESS, "The new token for Hivra's planned ecosystem. New $HIVRA-based access and payments are not automatically active just because the token has launched. Your Billing page will show when those options are available."],
      ["hermesos", HERMESOS_ADDRESS, "$HermesOS stays on-chain. Existing eligible accounts retain their earlier token-based access; there is no forced swap or conversion to keep that entitlement."],
    ] as const) {
      const card = within(container.querySelector(`[data-token="${key}"]`) as HTMLElement);
      expect(card.getByText(whole("P", "Network: Base"))).toBeInTheDocument();
      expect(card.getByText(whole("P", `Contract: ${address}`))).toBeInTheDocument();
      expect(card.getByRole("button", { name: "Copy address" })).toBeInTheDocument();
      const basescan = card.getByRole("link", { name: "View on BaseScan" });
      expect(basescan).toHaveAttribute("href", `https://basescan.org/token/${address}`);
      expect(basescan).toHaveAttribute("rel", "noopener noreferrer");
      expect(card.getByText(whole("P", note))).toBeInTheDocument();
    }
    expect(screen.getByText("not automatically active just because the token has launched").tagName).toBe("STRONG");
    expect(screen.getByText(whole("P", "This page is the source of truth for token addresses. We don't confirm addresses through DMs."))).toBeInTheDocument();
  });

  it("renders the holder, access, uses and limits sections word for word", () => {
    renderLaunched(entries);
    for (const text of [
      "Tokens can share a name or symbol without being connected to Hivra. Always compare the full address before interacting with one.",
      "The snapshot has already been taken. Eligible holders can claim $HIVRA through Sablier at a 1:1 ratio: one $HIVRA for each eligible $HermesOS recorded at the snapshot block.",
      "This is not an automatic airdrop. You need to complete the claim through the official Sablier claim flow, and a small fee applies. Check the fee shown before confirming. You do not need to buy more $HermesOS to qualify: eligibility was determined by the completed snapshot. The treatment of your original $HermesOS is not described here until the claim mechanics are confirmed.",
      "Not every address holding $HermesOS is included. Exclusions, including liquidity pools, launch contracts and the founder's wallet, are documented with the snapshot. Hivra-managed wallets are handled separately as explained on the airdrop page.",
      "Holding a qualifying token amount has been one way to access Hivra compute since the HermesOS days. For existing qualifying $HermesOS accounts, the amount needed was fixed when the holding first qualified. That established access continues as long as the applicable holding rules are met.",
      "You can also subscribe by card without a wallet. If you self-host Hivra, neither a Hivra subscription nor a token is required; you provide your own infrastructure and pay any underlying costs.",
      "New $HIVRA holder tiers and token payments will only be shown when they're enabled. Check Billing for your account's actual options rather than assuming they're live from a token announcement.",
      "Holding a token never gives an agent extra authority over another person's computer, files, credentials or accounts.",
      "Agent Computers are where the work happens. But running an ecosystem around them also means paying for computing resources, supporting the people who maintain tools, and rewarding researchers who find weaknesses before someone exploits them.",
      "The Litepaper sets out a proposal for a shared token across that work. These are plans, not promises of features available today. Each use needs its own implementation, rules and published terms.",
      "Proposed uses include compute time, storage, extra resources, ready-made agent setups and reserved capacity where available. Ordinary card and other payment options should remain available where they make more sense.",
      "Hivra Exchange is planned as a place to publish agents, tools and workflows with clearer information about their origins and permissions. The economic proposal includes payments to publishers and maintainers, and ways to share tested methods through Experience packages.",
      "Planned work around Arena, Challenges, Signal and Seal would help fund authorised security testing, verified threat reports and reviews of specific security claims. The intention is to pay for useful, verifiable work, not simply for holding a token.",
      "Longer-term ideas such as Missions and Interchange explore how agents might pay for approved work within budgets set by a responsible person. An agent shouldn't gain more spending authority by handing a task to another agent.",
      "$HIVRA does not represent ownership of Hivra or a claim on its revenue. The published proposal does not include staking or yield, and a larger token balance cannot buy wider access to people's data or weaken Hivra's security controls.",
      "The treasury and other proposed uses are subject to separate published terms. Future products do not create present entitlements.",
      "Claims are made through the official Sablier flow, not through links sent in DMs.",
      // The only curly apostrophe in the pack's /token page (Hivra’s), kept as Ash typed it.
      "A small fee applies to the legitimate claim. Only follow the verified claim link published on Hivra’s official website. Check the destination and the transaction details before connecting your wallet or confirming anything. Be wary of lookalike tokens, fake claim sites and impersonators.",
      "Our official channels are:",
      "Hivra does not have an official Telegram group.",
    ]) expect(screen.getByText(whole("P", text))).toBeInTheDocument();
    for (const bold of [
      "claim $HIVRA through Sablier",
      "1:1 ratio",
      "This is not an automatic airdrop.",
      "a small fee applies",
      "These are plans, not promises of features available today.",
      "Claims are made through the official Sablier flow, not through links sent in DMs.",
    ]) {
      expect(screen.getByText(bold).tagName).toBe("STRONG");
    }
  });

  it("puts every link in Ash's order with its served destination", () => {
    renderLaunched(entries);
    const links = screen.getAllByRole("link").map((node) => [node.textContent, node.getAttribute("href")]);
    expect(links).toEqual([
      ["Ecosystem", "/ecosystem"],
      ["View on BaseScan", `https://basescan.org/token/${HIVRA_ADDRESS}`],
      ["View on BaseScan", `https://basescan.org/token/${HERMESOS_ADDRESS}`],
      ["Check eligibility and claim through the official Sablier flow", "/token/airdrop"],
      ["Read the migration details", "/token/migration"],
      ["View the published snapshot", "https://hivra.cloud/token/airdrop-snapshot"],
      ["View on BaseScan", `https://basescan.org/address/${SENDER}`],
      ["Open Billing", "/dashboard/billing"],
      ["Explore the Hivra ecosystem", "/ecosystem"],
      ["Read the Litepaper", "/docs/litepaper"],
      ["Read the tokenomics", "/tokenomics"],
      ["@HivraOS", "https://x.com/HivraOS"],
      ["discord.gg/tDQZq8479F", "https://discord.gg/tDQZq8479F"],
      ["github.com/ashneil12/hivra", "https://github.com/ashneil12/hivra"],
      ["Read the migration details", "/token/migration"],
    ]);
  });

  it("never links straight to Sablier: the claim goes through the Hivra-owned airdrop page", () => {
    const { container } = renderLaunched(entries);
    expect(Array.from(container.querySelectorAll("a")).some((node) => /sablier\.com/i.test(node.getAttribute("href") ?? ""))).toBe(false);
  });

  it("shows the snapshot date, block and Airdrop wallet from the published facts", () => {
    renderLaunched(entries);
    const details = screen.getByTestId("token-airdrop-details");
    expect(within(details).getByText(whole("P", "Snapshot date: 20 October 2026"))).toBeInTheDocument();
    expect(within(details).getByText(whole("P", "Snapshot block: 36000000"))).toBeInTheDocument();
    expect(within(details).getByText(whole("P", `Airdrop wallet: ${SENDER}`))).toBeInTheDocument();
    expect(within(details).getByText("Snapshot date:").tagName).toBe("STRONG");
    expect(within(details).getAllByRole("code").map((node) => node.textContent)).toEqual(["36000000", SENDER]);
    // The three lines follow Ash's order.
    expect(details.textContent).toMatch(/^Snapshot date:.*Snapshot block:.*Airdrop wallet:/);
  });

  it("lists the official channels as Ash wrote them", () => {
    const { container } = renderLaunched(entries);
    const items = Array.from(container.querySelectorAll("#official-accounts li")).map((node) => node.textContent);
    expect(items).toEqual(["X: @HivraOS", "Discord: discord.gg/tDQZq8479F", "GitHub: github.com/ashneil12/hivra"]);
  });

  it("has no placeholder, em dash or obsolete automatic-airdrop copy", () => {
    const { container } = renderLaunched(entries);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/[–—]/);
    expect(text).not.toMatch(/\[|\]|VERIFIED HIVRA CONTRACT|CONFIRM/);
    expect(text).not.toMatch(/OPTIONAL TOKEN|Verify the token contracts|\$HIVRA for \$HermesOS holders|Hivra starts using it at/);
    expect(text).not.toMatch(/nothing to claim|sent automatically|sent to eligible wallets automatically|no wallet to connect|never connect a wallet|Check a wallet|distributed to wallets|Eligible holders also receive/i);
    expect(screen.queryByTestId("token-geo-notice")).not.toBeInTheDocument();
  });
});

describe("launched /token leaves out whatever is not published", () => {
  it("hides the links, snapshot facts and Airdrop wallet when nothing is published, and never shows a placeholder", () => {
    mockAirdrop = { senderAddress: null, snapshotBlock: null, snapshotTakenAt: null, snapshotUrl: null, claim: { campaignUrl: null, opensAt: null, closesAt: null } };
    const { container } = renderLaunched(PHASES.active, { airdropLookupHref: null, migrationHref: null });
    expect(screen.queryByTestId("token-holder-links")).not.toBeInTheDocument();
    expect(screen.queryByTestId("token-airdrop-details")).not.toBeInTheDocument();
    expect(screen.queryByTestId("token-migration-link")).not.toBeInTheDocument();
    for (const name of [/Check eligibility and claim/, /Read the migration details/, /View the published snapshot/]) {
      expect(screen.queryByRole("link", { name })).not.toBeInTheDocument();
    }
    expect(container.textContent).not.toMatch(/Snapshot date|Snapshot block|Airdrop wallet|\[|\]/);
    // The prose that does not depend on data is still there.
    expect(screen.getByRole("heading", { name: "Already hold $HermesOS?" })).toBeInTheDocument();
  });

  it("shows the Airdrop wallet alone when only it is published", () => {
    mockAirdrop = { ...PUBLISHED_AIRDROP, snapshotBlock: null, snapshotTakenAt: null, snapshotUrl: null };
    renderLaunched(PHASES.active, { airdropLookupHref: null, migrationHref: null });
    const details = screen.getByTestId("token-airdrop-details");
    expect(details).toHaveTextContent(`Airdrop wallet: ${SENDER}`);
    expect(details).not.toHaveTextContent(/Snapshot/);
    expect(screen.queryByTestId("token-holder-links")).not.toBeInTheDocument();
  });

  it("shows the snapshot block without a date until snapshotTakenAt is set", () => {
    mockAirdrop = { ...PUBLISHED_AIRDROP, snapshotTakenAt: null };
    renderLaunched();
    const details = screen.getByTestId("token-airdrop-details");
    expect(details).toHaveTextContent("Snapshot block: 36000000");
    expect(details).not.toHaveTextContent("Snapshot date");
    expect(screen.getByRole("link", { name: "View the published snapshot" })).toBeInTheDocument();
  });

  it("hides the date, block and snapshot link when the published list is not on an allowed Hivra location", () => {
    mockAirdrop = { ...PUBLISHED_AIRDROP, snapshotUrl: "https://example.com/snapshot" };
    renderLaunched();
    expect(screen.queryByRole("link", { name: "View the published snapshot" })).not.toBeInTheDocument();
    const details = screen.getByTestId("token-airdrop-details");
    expect(details).not.toHaveTextContent(/Snapshot/);
    expect(details).toHaveTextContent("Airdrop wallet");
  });

  it("hides a snapshot date that is not a real UTC instant instead of printing it", () => {
    mockAirdrop = { ...PUBLISHED_AIRDROP, snapshotTakenAt: "20 October 2026" };
    renderLaunched();
    expect(screen.getByTestId("token-airdrop-details")).not.toHaveTextContent("Snapshot date");
    expect(screen.getByTestId("token-airdrop-details")).toHaveTextContent("Snapshot block: 36000000");
  });

  it("links the claim page only when the server says /token/airdrop is served", () => {
    renderLaunched(PHASES.active, { airdropLookupHref: "/token/airdrop", migrationHref: null });
    expect(screen.getByRole("link", { name: "Check eligibility and claim through the official Sablier flow" })).toHaveAttribute("href", "/token/airdrop");
    expect(screen.queryByRole("link", { name: "Read the migration details" })).not.toBeInTheDocument();
  });

  it("links the migration page, in both places Ash put it, only when the server says /token/migration is served", () => {
    renderLaunched(PHASES.active, { airdropLookupHref: null, migrationHref: "/token/migration" });
    expect(screen.queryByRole("link", { name: "Check eligibility and claim through the official Sablier flow" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Read the migration details" })).toHaveLength(2);
    expect(screen.getByTestId("token-migration-link")).toBeInTheDocument();
  });
});

describe("launched /token copy button", () => {
  it("copies the $HIVRA contract from its card, and the $HermesOS contract from its own", async () => {
    mockCopy.mockResolvedValue(true);
    const { container } = renderLaunched();
    for (const [key, address] of [["hivra", HIVRA_ADDRESS], ["hermesos", HERMESOS_ADDRESS]] as const) {
      const card = within(container.querySelector(`[data-token="${key}"]`) as HTMLElement);
      await act(async () => {
        fireEvent.click(card.getByRole("button", { name: "Copy address" }));
      });
      expect(mockCopy).toHaveBeenLastCalledWith(address);
      expect(card.getByRole("button", { name: "Address copied" })).toBeInTheDocument();
    }
  });
});
