/** @jest-environment jsdom */
/**
 * The launched /tokenomics (scheduled and active) is Ash's website pack page
 * 04-tokenomics.md (20 October 2026), verbatim. These tests pin his headings (with
 * the numbered 01. to 04. ones), paragraphs, bold and italic runs and the order of
 * sections and links, so a reword shows up in review. They also pin that the pages
 * it links to are linked only when the server says they are served.
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

import TokenomicsLaunchedView from "../TokenomicsLaunchedView";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

const SERVED = { airdropLookupHref: "/token/airdrop", migrationHref: "/token/migration" } as const;
const NOT_SERVED = { airdropLookupHref: null, migrationHref: null } as const;

/** Matches an element by its whole text, so a paragraph split by <strong> or <em> still matches. */
const whole = (tag: string, text: string) => (_: string, element: Element | null) =>
  element?.tagName === tag && element.textContent === text;

describe("launched /tokenomics", () => {
  it("renders Ash's headings in order, with the numbered ones as he numbered them", () => {
    render(<TokenomicsLaunchedView {...SERVED} />);
    expect(screen.getAllByRole("heading").map((node) => `${node.tagName} ${node.textContent}`)).toEqual([
      "H1 $HIVRA: what it's for",
      "H2 What works today",
      "H3 Existing holder access",
      "H2 From $HermesOS to $HIVRA",
      "H3 A snapshot has been taken. Eligible holders can claim.",
      "H2 What we're working towards",
      "H3 01. Computers, software and capacity",
      "H3 02. Security research that produces evidence",
      "H3 03. Tools, publishers and shared experience",
      "H3 04. Budgets agents can't quietly expand",
      "H2 The proposed treasury",
      "H3 Funding the work behind the platform",
      "H2 What holding $HIVRA does not mean",
      "H2 Keep the distinction clear",
    ]);
  });

  it("renders the eyebrow in italics, the lead, and the italic risk line", () => {
    const { container } = render(<TokenomicsLaunchedView {...SERVED} />);
    expect(container.querySelector("header em")).toHaveTextContent(/^THE HIVRA TOKEN$/);
    for (const text of [
      "Hivra gives AI agents computers of their own. But keeping those computers running is only part of the work. Researchers need to be paid for finding security flaws. Builders need a way to distribute and maintain useful tools. And, eventually, agents may need to pay for narrowly defined services without being handed unrestricted access to someone's money.",
      "That's the thinking behind $HIVRA: a potential way to pay for useful activity across the Hivra ecosystem. It isn't a requirement for using Hivra, and most of the uses described below are still plans, not features you can access today.",
      "$HermesOS is the legacy token. Eligible existing holders keep their established compute access under the applicable rules. The new $HIVRA token is part of Hivra's transition, with token-based services being introduced separately as they're ready.",
    ]) expect(screen.getByText(whole("P", text))).toBeInTheDocument();
    expect(screen.getByTestId("tokenomics-risk-line").querySelector("em")).toHaveTextContent(
      /^Cryptoassets can lose all their value\. This page explains current arrangements and future proposals; it is not a promise of returns or an invitation to purchase tokens\.$/,
    );
  });

  it("renders every section word for word, with his bold runs", () => {
    render(<TokenomicsLaunchedView {...SERVED} />);
    for (const text of [
      "Some existing $HermesOS holders qualify for compute access through their holdings. When a holding first qualifies, the required token quantity is fixed under the existing access rules. A change in market price alone does not recalculate that requirement, provided the holder continues to meet the applicable conditions.",
      "Hivra also accepts ordinary card payments. You don't need to buy or hold a token to use the platform. And if you self-host Hivra, you don't need a Hivra account either.",
      "$HIVRA-based access and payment options are not necessarily active just because the token exists. They will become available only when their separately defined activation conditions have been met. Check your Billing page for the options currently available to your account.",
      "The $HermesOS holder snapshot was completed before or by 20 October 2026. Wallets included in the published eligibility list are allocated $HIVRA at a 1:1 ratio, based on the amount of $HermesOS they held at the snapshot block.",
      "This is not an automatic transfer. Eligible holders must claim through the official Sablier process. Claiming requires a wallet transaction and a small fee paid by the claimant, including applicable network costs. Hivra is not sponsoring those fees.",
      "The current claim arrangement does not require holders to burn or surrender their original $HermesOS. Existing holder access and the right to claim a snapshot allocation are separate matters.",
      "The migration claim window is time-limited. The definitive deadline, snapshot block, fee details and official claim destination will be published through Hivra's token and migration pages. Do not rely on links sent in private messages.",
      "The wider Hivra ecosystem is still being built. The uses below are proposals, and each will need working software, operating rules and published terms before it can go live. A token balance alone won't make an unbuilt service available.",
      "Agent Computers is where work happens today. In future, $HIVRA could support metered charges for running time, storage, processing power and data transfer, as well as ready-made agent setups and reserved capacity.",
      "Holding tokens for a compute tier is an established feature of the legacy $HermesOS arrangement. The proposed $HIVRA equivalents and additional services are separate decisions and should not be confused with what's already active.",
      "A security claim is worth more when someone has tried to break it. Hivra plans to use Challenges and Arena to let researchers test narrowly defined boundaries in authorised environments and provide reproducible evidence of failures.",
      "The proposed economy could fund those bounties, independent verification and rewards for useful threat reports submitted to Signal. Seal could support security claims backed by specific tests and, subject to final terms, deposits that put something at stake when a claim is proved wrong.",
      "The aim is to pay for demonstrable work, not for leaving tokens idle.",
      "Exchange is planned as a place to find agents, tools, MCP servers, workflows and ready-made computer setups, with clearer information about who published them, which version you're installing and what permissions they need.",
      "A future payment system could compensate publishers for maintaining those tools. Experience could make carefully documented methods reusable, with the steps, evidence and limitations included rather than a promise that one agent's success will always work for another.",
      "An agent may eventually need to buy compute, pay for a tool or commission another agent to do part of a job. That's the idea behind Interchange and Missions.",
      "The owner would set the purpose, amount and limits. Delegating work could not create more spending authority, and an agent would not approve its own larger budget. The mechanics still need to be designed and tested before any token-funded version becomes available.",
      "Hivra needs ongoing maintenance, security reviews, infrastructure and people who look after tools others depend on. The proposed treasury is intended to pay for that work, not to distribute profits to holders.",
      "The broader plan is for eligible trading fees and platform revenue to support development, operations, open-source maintenance, independent security testing, sponsored compute and research rewards.",
      "Contributors could choose to be paid in stablecoins or $HIVRA at an equivalent agreed value, rather than being required to accept tokens for their work.",
      "The treasury would be able to sell assets to cover real expenses. Under the proposed policy, token purchases would only address an operational shortfall against contributor payment commitments, not defend a market price. Transactions and the work they funded would be publicly documented, including spending outside the blockchain.",
      "The new token's launch fee collection arrangements are separate from this longer-term treasury policy. Read the migration page for the currently specified pool fee, Safe wallet and planned liquidity handling. Future treasury rules, signers and permissions must be published before those plans are implemented.",
      "Owning a token does not make you an owner of Hivra or give you a share of its revenue. There is no proposed staking yield, guaranteed return or entitlement to price support.",
      "A token also cannot buy access to another person's files, credentials or computer, bypass a security control or give an agent permission its owner never granted. The safety boundaries apply regardless of how services are paid for.",
      "The longer-term economic design rules out manufactured activity, circular transactions intended to create volume and token-based exemptions from security rules.",
      "Available now: Agent Computers, ordinary payment options, legacy $HermesOS holder access where eligible, and the snapshot-based $HIVRA claim arrangement once its official claim interface is enabled.",
      "Subject to activation: New $HIVRA-based access and payment services.",
      "Proposed: Additional spending and settlement across compute, Exchange, Arena, Signal, Seal, Challenges, Experience, Missions and Interchange, alongside the wider treasury policy.",
      "The full Litepaper explains why Hivra is building these pieces and which belong to Next, Then or Research. It isn't a delivery timetable or a guarantee that every proposal will ship unchanged.",
    ]) expect(screen.getByText(whole("P", text))).toBeInTheDocument();
    for (const bold of [
      "not necessarily active just because the token exists",
      "20 October 2026",
      "1:1 ratio",
      "not an automatic transfer",
      "Sablier",
      "not",
      "proposals",
      "Challenges",
      "Arena",
      "Signal",
      "Seal",
      "Exchange",
      "Experience",
      "Interchange",
      "Missions",
      "The new token's launch fee collection arrangements are separate from this longer-term treasury policy.",
      "Available now:",
      "Subject to activation:",
      "Proposed:",
      "Next",
      "Then",
      "Research",
    ]) {
      expect(screen.getAllByText(bold, { selector: "strong" }).length).toBeGreaterThan(0);
    }
  });

  it("puts every link in Ash's order with its served destination", () => {
    render(<TokenomicsLaunchedView {...SERVED} />);
    expect(screen.getAllByRole("link").map((node) => [node.textContent, node.getAttribute("href")])).toEqual([
      ["Read the full tokenomics document", "/TOKENOMICS.md"],
      ["Check your access in Billing", "/dashboard/billing"],
      ["Check your eligibility", "/token/airdrop"],
      ["Read how the migration works", "/token/migration"],
      ["Verify official token contracts", "/token"],
      ["View migration fees and on-chain records", "/token/migration"],
      ["Read the Litepaper", "/docs/litepaper"],
      ["Read the tokenomics document", "/TOKENOMICS.md"],
      ["Verify the token contracts", "/token"],
    ]);
  });

  it("links to the claim page and the migration page only when the server says they are served", () => {
    render(<TokenomicsLaunchedView {...NOT_SERVED} />);
    expect(screen.getAllByRole("link").map((node) => node.textContent)).toEqual([
      "Read the full tokenomics document",
      "Check your access in Billing",
      "Verify official token contracts",
      "Read the Litepaper",
      "Read the tokenomics document",
      "Verify the token contracts",
    ]);
    for (const name of [/Check your eligibility/, /Read how the migration works/, /View migration fees and on-chain records/]) {
      expect(screen.queryByRole("link", { name })).not.toBeInTheDocument();
    }
  });

  it("drops the token-pricing line and the bonus-credit offer, and has no placeholder, dash or obsolete claim", () => {
    const { container } = render(<TokenomicsLaunchedView {...SERVED} />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/\$49|\$79|by card, and credit|bonus credit|costs less|which costs/i);
    expect(text).not.toMatch(/[–—]/);
    expect(text).not.toMatch(/\[|\]|CONFIRM|VERIFIED/);
    expect(text).not.toMatch(/nothing to claim|sent automatically|automatically|never connect a wallet|airdrop|new accounts use|new users hold|new Hivra accounts use|Bankr|ETH proceeds/i);
  });

  it("uses a level-two title when the section is embedded under another page title", () => {
    render(<TokenomicsLaunchedView {...SERVED} headingLevel={2} />);
    expect(screen.getByRole("heading", { name: "$HIVRA: what it's for" }).tagName).toBe("H2");
  });
});
