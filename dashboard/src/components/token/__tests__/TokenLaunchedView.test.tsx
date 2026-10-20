/** @jest-environment jsdom */
/**
 * The launched /token (scheduled and active) is Ash's rewrite v2 of 20 October
 * 2026, verbatim. These tests pin his headings, paragraphs, bold and italic
 * runs and the order of sections and links, so a reword shows up in review.
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
jest.mock("@/lib/claim/hivra-airdrop-config", () => ({
  ...jest.requireActual("@/lib/claim/hivra-airdrop-config"),
  HIVRA_AIRDROP: {
    senderAddress: "0x3B954866d4329E19C1B9165774c88508f2fefA0c",
    snapshotBlock: 36000000,
    snapshotUrl: "https://hivra.cloud/token/airdrop-snapshot",
    sentAt: null,
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

function renderLaunched(entries: readonly TokenPageEntry[] = PHASES.active) {
  return render(<TokenPageClient entries={[...entries]} airdropLookupHref="/token/airdrop" migrationHref="/token/migration" />);
}

/** Matches an element by its whole text, so a paragraph split by <strong> or <em> still matches. */
const whole = (tag: string, text: string) => (_: string, element: Element | null) =>
  element?.tagName === tag && element.textContent === text;

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
      "The original $HermesOS token remains on Base. If you qualified for compute access through it before the transition, you keep that access under the existing rules. Eligible holders also receive $HIVRA based on a published snapshot.",
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
      "The new token is being distributed to wallets in the published snapshot at a 1:1 ratio: one $HIVRA for each eligible $HermesOS recorded at the snapshot block.",
      "You don't have to claim anything. There is no swap form, wallet approval or payment required. The distribution is sent to eligible wallets automatically, and your original $HermesOS remains in your wallet.",
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
      "There is nothing to claim and no wallet to connect for the holder airdrop.",
      "Hivra won't ask you in a DM to sign a message, approve a transaction or pay a fee to receive $HIVRA. Be wary of fake tokens, claim sites and accounts using a similar name.",
      "Our official channels are:",
      "Hivra does not have an official Telegram group.",
    ]) expect(screen.getByText(whole("P", text))).toBeInTheDocument();
    for (const bold of ["1:1 ratio", "These are plans, not promises of features available today.", "There is nothing to claim and no wallet to connect for the holder airdrop."]) {
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
      ["Check a wallet", "/token/airdrop"],
      ["Read the migration details", "/token/migration"],
      ["View the published snapshot", "https://hivra.cloud/token/airdrop-snapshot"],
      ["View on BaseScan", "https://basescan.org/address/0x3B954866d4329E19C1B9165774c88508f2fefA0c"],
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

  it("lists the official channels as Ash wrote them", () => {
    const { container } = renderLaunched(entries);
    const items = Array.from(container.querySelectorAll("#official-accounts li")).map((node) => node.textContent);
    expect(items).toEqual(["X: @HivraOS", "Discord: discord.gg/tDQZq8479F", "GitHub: github.com/ashneil12/hivra"]);
  });

  it("has no placeholder, em dash or old launched copy", () => {
    const { container } = renderLaunched(entries);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/[–—]/);
    expect(text).not.toMatch(/\[|\]|VERIFIED HIVRA CONTRACT|CONFIRM BASE BLOCK/);
    expect(text).not.toMatch(/OPTIONAL TOKEN|Verify the token contracts|\$HIVRA for \$HermesOS holders|Hivra starts using it at/);
    expect(screen.queryByTestId("token-geo-notice")).not.toBeInTheDocument();
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
