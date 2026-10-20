import type { CSSProperties } from "react";
import Link from "next/link";

import styles from "./TokenFacts.module.css";

/**
 * /tokenomics once $HIVRA is launched (scheduled or active), for a viewer the
 * token geo-policy does not block. The words are Ash's website pack, page
 * 04-tokenomics.md (20 October 2026), applied verbatim: headings, paragraphs,
 * bold, italics, the numbered headings (01. to 04.) and the order of sections and
 * links. Do not reword them here; a copy change comes from Ash. Token copy needs
 * UK financial-promotion / legal review before release.
 *
 * The pack leaves out the old lines about a year of Pro in the token against
 * card and the bonus credits on token top-ups, so they are not here. This file
 * changes no billing logic.
 *
 * Link targets come from data, never from this file:
 * - "Check your eligibility": the server passes /token/airdrop (the Hivra-owned
 *   page that holds the verified Sablier link) only when that page is served;
 * - "Read how the migration works" and "View migration fees and on-chain
 *   records": the server passes /token/migration only when that page is served.
 * A link whose page is not served is left out, never shown pointing at a 404.
 *
 * The dormant /tokenomics (FullTokenomicsSection) does not use this file.
 */

const SECTION: CSSProperties = { borderTop: "1px solid var(--public-line)", padding: "2rem 0" };
const LINK_LINE: CSSProperties = { margin: "0 0 0.5rem" };

export default function TokenomicsLaunchedView({
  headingLevel = 1,
  airdropLookupHref,
  migrationHref,
}: {
  headingLevel?: 1 | 2;
  /** /token/airdrop when that page is served, else null. */
  airdropLookupHref: string | null;
  /** /token/migration when that page is served, else null. */
  migrationHref: string | null;
}) {
  const Title = headingLevel === 1 ? "h1" : "h2";
  return <div className={styles.content} style={{ maxWidth: 1000, margin: "0 auto", padding: "clamp(3rem, 8vw, 7rem) var(--public-gutter)", lineHeight: 1.7 }}>
    <header style={{ margin: "0 0 3rem", maxWidth: 760 }}>
      <p className="mono" style={{ color: "var(--public-accent)", fontSize: 11 }}><em>THE HIVRA TOKEN</em></p>
      <Title id="tokenomics-heading" style={{ fontSize: "clamp(2.8rem, 7vw, 5rem)", lineHeight: 1.05, margin: "1rem 0" }}>$HIVRA: what it&apos;s for</Title>
      <p style={{ fontSize: "1.2rem", color: "var(--public-muted)" }}>Hivra gives AI agents computers of their own. But keeping those computers running is only part of the work. Researchers need to be paid for finding security flaws. Builders need a way to distribute and maintain useful tools. And, eventually, agents may need to pay for narrowly defined services without being handed unrestricted access to someone&apos;s money.</p>
      <p>That&apos;s the thinking behind $HIVRA: a potential way to pay for useful activity across the Hivra ecosystem. It isn&apos;t a requirement for using Hivra, and most of the uses described below are still plans, not features you can access today.</p>
      <p>$HermesOS is the legacy token. Eligible existing holders keep their established compute access under the applicable rules. The new $HIVRA token is part of Hivra&apos;s transition, with token-based services being introduced separately as they&apos;re ready.</p>
      <p style={LINK_LINE}><a href="/TOKENOMICS.md" target="_blank" rel="noopener noreferrer">Read the full tokenomics document</a></p>
      <p data-testid="tokenomics-risk-line" style={{ color: "var(--public-muted)" }}><em>Cryptoassets can lose all their value. This page explains current arrangements and future proposals; it is not a promise of returns or an invitation to purchase tokens.</em></p>
    </header>

    <section id="works-today" aria-labelledby="works-today-title" style={SECTION}>
      <h2 id="works-today-title">What works today</h2>
      <h3>Existing holder access</h3>
      <p>Some existing $HermesOS holders qualify for compute access through their holdings. When a holding first qualifies, the required token quantity is fixed under the existing access rules. A change in market price alone does not recalculate that requirement, provided the holder continues to meet the applicable conditions.</p>
      <p>Hivra also accepts ordinary card payments. You don&apos;t need to buy or hold a token to use the platform. And if you self-host Hivra, you don&apos;t need a Hivra account either.</p>
      <p>$HIVRA-based access and payment options are <strong>not necessarily active just because the token exists</strong>. They will become available only when their separately defined activation conditions have been met. Check your Billing page for the options currently available to your account.</p>
      <p style={LINK_LINE}><Link href="/dashboard/billing">Check your access in Billing</Link></p>
    </section>

    <section id="migration" aria-labelledby="migration-title" style={SECTION}>
      <h2 id="migration-title">From $HermesOS to $HIVRA</h2>
      <h3>A snapshot has been taken. Eligible holders can claim.</h3>
      <p>The $HermesOS holder snapshot was completed before or by <strong>20 October 2026</strong>. Wallets included in the published eligibility list are allocated $HIVRA at a <strong>1:1 ratio</strong>, based on the amount of $HermesOS they held at the snapshot block.</p>
      <p>This is <strong>not an automatic transfer</strong>. Eligible holders must claim through the official <strong>Sablier</strong> process. Claiming requires a wallet transaction and a small fee paid by the claimant, including applicable network costs. Hivra is not sponsoring those fees.</p>
      <p>The current claim arrangement does <strong>not</strong> require holders to burn or surrender their original $HermesOS. Existing holder access and the right to claim a snapshot allocation are separate matters.</p>
      <p>The migration claim window is time-limited. The definitive deadline, snapshot block, fee details and official claim destination will be published through Hivra&apos;s token and migration pages. Do not rely on links sent in private messages.</p>
      <div data-testid="tokenomics-migration-links" style={{ margin: "0 0 1rem" }}>
        {airdropLookupHref ? <p style={LINK_LINE}><Link href={airdropLookupHref}>Check your eligibility</Link></p> : null}
        {migrationHref ? <p style={LINK_LINE}><Link href={migrationHref}>Read how the migration works</Link></p> : null}
        <p style={LINK_LINE}><Link href="/token">Verify official token contracts</Link></p>
      </div>
    </section>

    <section id="proposals" aria-labelledby="proposals-title" style={SECTION}>
      <h2 id="proposals-title">What we&apos;re working towards</h2>
      <p>The wider Hivra ecosystem is still being built. The uses below are <strong>proposals</strong>, and each will need working software, operating rules and published terms before it can go live. A token balance alone won&apos;t make an unbuilt service available.</p>

      <h3>01. Computers, software and capacity</h3>
      <p>Agent Computers is where work happens today. In future, $HIVRA could support metered charges for running time, storage, processing power and data transfer, as well as ready-made agent setups and reserved capacity.</p>
      <p>Holding tokens for a compute tier is an established feature of the legacy $HermesOS arrangement. The proposed $HIVRA equivalents and additional services are separate decisions and should not be confused with what&apos;s already active.</p>

      <h3>02. Security research that produces evidence</h3>
      <p>A security claim is worth more when someone has tried to break it. Hivra plans to use <strong>Challenges</strong> and <strong>Arena</strong> to let researchers test narrowly defined boundaries in authorised environments and provide reproducible evidence of failures.</p>
      <p>The proposed economy could fund those bounties, independent verification and rewards for useful threat reports submitted to <strong>Signal</strong>. <strong>Seal</strong> could support security claims backed by specific tests and, subject to final terms, deposits that put something at stake when a claim is proved wrong.</p>
      <p>The aim is to pay for demonstrable work, not for leaving tokens idle.</p>

      <h3>03. Tools, publishers and shared experience</h3>
      <p><strong>Exchange</strong> is planned as a place to find agents, tools, MCP servers, workflows and ready-made computer setups, with clearer information about who published them, which version you&apos;re installing and what permissions they need.</p>
      <p>A future payment system could compensate publishers for maintaining those tools. <strong>Experience</strong> could make carefully documented methods reusable, with the steps, evidence and limitations included rather than a promise that one agent&apos;s success will always work for another.</p>

      <h3>04. Budgets agents can&apos;t quietly expand</h3>
      <p>An agent may eventually need to buy compute, pay for a tool or commission another agent to do part of a job. That&apos;s the idea behind <strong>Interchange</strong> and <strong>Missions</strong>.</p>
      <p>The owner would set the purpose, amount and limits. Delegating work could not create more spending authority, and an agent would not approve its own larger budget. The mechanics still need to be designed and tested before any token-funded version becomes available.</p>
    </section>

    <section id="treasury" aria-labelledby="treasury-title" style={SECTION}>
      <h2 id="treasury-title">The proposed treasury</h2>
      <h3>Funding the work behind the platform</h3>
      <p>Hivra needs ongoing maintenance, security reviews, infrastructure and people who look after tools others depend on. The proposed treasury is intended to pay for that work, not to distribute profits to holders.</p>
      <p>The broader plan is for eligible trading fees and platform revenue to support development, operations, open-source maintenance, independent security testing, sponsored compute and research rewards.</p>
      <p>Contributors could choose to be paid in stablecoins or $HIVRA at an equivalent agreed value, rather than being required to accept tokens for their work.</p>
      <p>The treasury would be able to sell assets to cover real expenses. Under the proposed policy, token purchases would only address an operational shortfall against contributor payment commitments, not defend a market price. Transactions and the work they funded would be publicly documented, including spending outside the blockchain.</p>
      <p><strong>The new token&apos;s launch fee collection arrangements are separate from this longer-term treasury policy.</strong> Read the migration page for the currently specified pool fee, Safe wallet and planned liquidity handling. Future treasury rules, signers and permissions must be published before those plans are implemented.</p>
      {migrationHref ? <p data-testid="tokenomics-migration-records-link" style={LINK_LINE}><Link href={migrationHref}>View migration fees and on-chain records</Link></p> : null}
    </section>

    <section id="not-included" aria-labelledby="not-included-title" style={SECTION}>
      <h2 id="not-included-title">What holding $HIVRA does not mean</h2>
      <p>Owning a token does not make you an owner of Hivra or give you a share of its revenue. There is no proposed staking yield, guaranteed return or entitlement to price support.</p>
      <p>A token also cannot buy access to another person&apos;s files, credentials or computer, bypass a security control or give an agent permission its owner never granted. The safety boundaries apply regardless of how services are paid for.</p>
      <p>The longer-term economic design rules out manufactured activity, circular transactions intended to create volume and token-based exemptions from security rules.</p>
    </section>

    <section id="distinction" aria-labelledby="distinction-title" style={SECTION}>
      <h2 id="distinction-title">Keep the distinction clear</h2>
      <p><strong>Available now:</strong> Agent Computers, ordinary payment options, legacy $HermesOS holder access where eligible, and the snapshot-based $HIVRA claim arrangement once its official claim interface is enabled.</p>
      <p><strong>Subject to activation:</strong> New $HIVRA-based access and payment services.</p>
      <p><strong>Proposed:</strong> Additional spending and settlement across compute, Exchange, Arena, Signal, Seal, Challenges, Experience, Missions and Interchange, alongside the wider treasury policy.</p>
      <p>The full Litepaper explains why Hivra is building these pieces and which belong to <strong>Next</strong>, <strong>Then</strong> or <strong>Research</strong>. It isn&apos;t a delivery timetable or a guarantee that every proposal will ship unchanged.</p>
      <div style={{ margin: "0 0 1rem" }}>
        <p style={LINK_LINE}><a href="/docs/litepaper">Read the Litepaper</a></p>
        <p style={LINK_LINE}><a href="/TOKENOMICS.md" target="_blank" rel="noopener noreferrer">Read the tokenomics document</a></p>
        <p style={LINK_LINE}><Link href="/token">Verify the token contracts</Link></p>
      </div>
    </section>
  </div>;
}
