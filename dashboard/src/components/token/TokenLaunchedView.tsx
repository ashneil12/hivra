"use client";

import type { CSSProperties } from "react";
import Link from "next/link";
import styles from "./TokenFacts.module.css";
import PublicSite from "@/components/public-site/PublicSite";
import { HIVRA_AIRDROP } from "@/lib/claim/hivra-airdrop-config";
import { resolveAirdropFacts } from "@/lib/claim/conversion-state";
import { formatSnapshotDateUtc, tokenVerificationContent, type TokenPageEntry } from "@/lib/token-verification-content";
import { CopyAddressButton } from "./CopyAddressButton";

/**
 * /token once $HIVRA is launched (scheduled or active), for a viewer the token
 * geo-policy does not block. The words are Ash's website pack, page 01-token.md
 * (v3, 20 October 2026), applied verbatim: headings, paragraphs, bold, italics
 * and the order of sections and links. Do not reword them here; a copy change
 * comes from Ash. Token copy needs UK financial-promotion / legal review before
 * release.
 *
 * Every address, date and link target comes from data, never from this file:
 * - contracts: the token registry, via `entries` (hivra-token-launch.ts for $HIVRA);
 * - snapshot date, snapshot block, published snapshot and Airdrop wallet:
 *   HIVRA_AIRDROP, checked by resolveAirdropFacts (the date, block and list show
 *   only once the block and its list are both valid; the date only when set);
 * - "Check eligibility and claim through the official Sablier flow" and "Read the
 *   migration details": set by the server only when /token/airdrop and
 *   /token/migration are actually served. /token/airdrop is the Hivra-owned page
 *   that holds the verified Sablier link; this page never links to Sablier itself.
 * A line or link whose value is not published is left out, never shown as a placeholder.
 */

const SECTION: CSSProperties = { borderTop: "1px solid var(--public-line)", padding: "2rem 0" };
const ADDRESS: CSSProperties = { overflowWrap: "anywhere" };
const LINK_LINE: CSSProperties = { margin: "0 0 0.5rem" };

function basescanAddressUrl(address: string): string {
  return `https://basescan.org/address/${address}`;
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
}

function ContractCard({ entry, title, children }: { entry: TokenPageEntry | undefined; title: string; children: React.ReactNode }) {
  if (!entry?.contractAddress) return null;
  return <div data-token={entry.key} style={{ margin: "1.5rem 0" }}>
    <h3 style={{ marginBottom: "0.5rem" }}>{title}</h3>
    <p style={{ marginBottom: 0 }}><strong>Network:</strong> Base</p>
    <p style={{ marginBottom: 0 }}><strong>Contract:</strong> <code style={ADDRESS}>{entry.contractAddress}</code></p>
    <CopyAddressButton value={entry.contractAddress} />
    {entry.basescanUrl ? <p><ExternalLink href={entry.basescanUrl}>View on BaseScan</ExternalLink></p> : null}
    {children}
  </div>;
}

export default function TokenLaunchedView({
  entries,
  airdropLookupHref,
  migrationHref,
}: {
  entries: readonly TokenPageEntry[];
  /** /token/airdrop (the page that holds the verified Sablier link) when it is served, else null. */
  airdropLookupHref: string | null;
  /** /token/migration when that page is served, else null. */
  migrationHref: string | null;
}) {
  const hivra = entries.find((entry) => entry.key === "hivra");
  const hermesos = entries.find((entry) => entry.key === "hermesos");
  const facts = hivra?.contractAddress ? resolveAirdropFacts(HIVRA_AIRDROP, hivra.contractAddress, null) : null;
  const snapshot = facts?.snapshot ?? null;
  const senderAddress = facts?.senderAddress ?? null;
  const { officialAccounts } = tokenVerificationContent;

  return <PublicSite>
    <main className={styles.content} id="main-content" style={{ maxWidth: 1000, margin: "0 auto", padding: "clamp(3rem, 8vw, 7rem) var(--public-gutter)", lineHeight: 1.7 }}>
      <Link href="/ecosystem">Ecosystem</Link>
      <header style={{ margin: "2rem 0 3rem", maxWidth: 760 }}>
        <p className="mono" style={{ color: "var(--public-accent)", fontSize: 11 }}><strong>THE HIVRA TOKEN</strong></p>
        <h1 style={{ fontSize: "clamp(2.8rem, 7vw, 5rem)", lineHeight: 1.05, margin: "1rem 0" }}>$HIVRA and $HermesOS</h1>
        <p style={{ fontSize: "1.2rem", color: "var(--public-muted)" }}>Hivra started as HermesOS. The platform has grown beyond its original name, and $HIVRA is the new token for the wider ecosystem we&apos;re building.</p>
        <p>The original $HermesOS token remains on Base. If you qualified for compute access through it before the transition, you keep that access under the existing rules. Eligible holders can claim $HIVRA through Sablier based on the snapshot already taken.</p>
        <p><strong>You don&apos;t need a token to use Hivra.</strong> Pay by card for Hivra Cloud, or run the open-source platform yourself with no Hivra account or token.</p>
        <p data-testid="token-risk-line" style={{ color: "var(--public-muted)" }}><em>Cryptoassets can lose all their value. This page explains Hivra&apos;s tokens and migration arrangements. It is not an offer or invitation to buy.</em></p>
      </header>

      <section id="verify" aria-labelledby="verify-title" style={SECTION}>
        <h2 id="verify-title">Check the official contracts</h2>
        <p>Tokens can share a name or symbol without being connected to Hivra. Always compare the full address before interacting with one.</p>
        <ContractCard entry={hivra} title="$HIVRA · New ecosystem token">
          <p>The new token for Hivra&apos;s planned ecosystem. New $HIVRA-based access and payments are <strong>not automatically active just because the token has launched</strong>. Your Billing page will show when those options are available.</p>
        </ContractCard>
        <ContractCard entry={hermesos} title="$HermesOS · Legacy token">
          <p>$HermesOS stays on-chain. Existing eligible accounts retain their earlier token-based access; there is no forced swap or conversion to keep that entitlement.</p>
        </ContractCard>
        <p><strong>This page is the source of truth for token addresses.</strong> We don&apos;t confirm addresses through DMs.</p>
      </section>

      <section id="holders" aria-labelledby="holders-title" style={SECTION}>
        <h2 id="holders-title">Already hold $HermesOS?</h2>
        <p>The snapshot has already been taken. Eligible holders can <strong>claim $HIVRA through Sablier</strong> at a <strong>1:1 ratio</strong>: one $HIVRA for each eligible $HermesOS recorded at the snapshot block.</p>
        <p><strong>This is not an automatic airdrop.</strong> You need to complete the claim through the official Sablier claim flow, and <strong>a small fee applies</strong>. Check the fee shown before confirming. You do not need to buy more $HermesOS to qualify: eligibility was determined by the completed snapshot. The treatment of your original $HermesOS is not described here until the claim mechanics are confirmed.</p>
        <p>Not every address holding $HermesOS is included. Exclusions, including liquidity pools, launch contracts and the founder&apos;s wallet, are documented with the snapshot. Hivra-managed wallets are handled separately as explained on the airdrop page.</p>
        {airdropLookupHref || migrationHref || snapshot ? <div data-testid="token-holder-links" style={{ margin: "0 0 1rem" }}>
          {airdropLookupHref ? <p style={LINK_LINE}><Link href={airdropLookupHref}>Check eligibility and claim through the official Sablier flow</Link></p> : null}
          {migrationHref ? <p style={LINK_LINE}><Link href={migrationHref}>Read the migration details</Link></p> : null}
          {snapshot ? <p style={LINK_LINE}><ExternalLink href={snapshot.url}>View the published snapshot</ExternalLink></p> : null}
        </div> : null}
        {snapshot || senderAddress ? <div data-testid="token-airdrop-details">
          {snapshot?.takenAt ? <p style={{ marginBottom: 0 }}><strong>Snapshot date:</strong> {formatSnapshotDateUtc(snapshot.takenAt)}</p> : null}
          {snapshot ? <p style={{ marginBottom: 0 }}><strong>Snapshot block:</strong> <code>{snapshot.block}</code></p> : null}
          {senderAddress ? <>
            <p style={{ marginBottom: 0 }}><strong>Airdrop wallet:</strong> <code style={ADDRESS}>{senderAddress}</code></p>
            <p><ExternalLink href={basescanAddressUrl(senderAddress)}>View on BaseScan</ExternalLink></p>
          </> : null}
        </div> : null}
      </section>

      <section id="access" aria-labelledby="access-title" style={SECTION}>
        <h2 id="access-title">How token access works</h2>
        <p>Holding a qualifying token amount has been one way to access Hivra compute since the HermesOS days. For existing qualifying $HermesOS accounts, the amount needed was fixed when the holding first qualified. That established access continues as long as the applicable holding rules are met.</p>
        <p>You can also subscribe by card without a wallet. If you self-host Hivra, neither a Hivra subscription nor a token is required; you provide your own infrastructure and pay any underlying costs.</p>
        <p>New $HIVRA holder tiers and token payments will only be shown when they&apos;re enabled. Check Billing for your account&apos;s actual options rather than assuming they&apos;re live from a token announcement.</p>
        <p><Link href="/dashboard/billing">Open Billing</Link></p>
        <p>Holding a token never gives an agent extra authority over another person&apos;s computer, files, credentials or accounts.</p>
      </section>

      <section id="uses" aria-labelledby="uses-title" style={SECTION}>
        <h2 id="uses-title">What could $HIVRA be used for?</h2>
        <p>Agent Computers are where the work happens. But running an ecosystem around them also means paying for computing resources, supporting the people who maintain tools, and rewarding researchers who find weaknesses before someone exploits them.</p>
        <p>The Litepaper sets out a proposal for a shared token across that work. <strong>These are plans, not promises of features available today.</strong> Each use needs its own implementation, rules and published terms.</p>
        <h3>Computing and tools</h3>
        <p>Proposed uses include compute time, storage, extra resources, ready-made agent setups and reserved capacity where available. Ordinary card and other payment options should remain available where they make more sense.</p>
        <h3>People building the ecosystem</h3>
        <p>Hivra Exchange is planned as a place to publish agents, tools and workflows with clearer information about their origins and permissions. The economic proposal includes payments to publishers and maintainers, and ways to share tested methods through Experience packages.</p>
        <h3>Security that can be tested</h3>
        <p>Planned work around Arena, Challenges, Signal and Seal would help fund authorised security testing, verified threat reports and reviews of specific security claims. The intention is to pay for useful, verifiable work, not simply for holding a token.</p>
        <h3>Budgets with limits</h3>
        <p>Longer-term ideas such as Missions and Interchange explore how agents might pay for approved work within budgets set by a responsible person. An agent shouldn&apos;t gain more spending authority by handing a task to another agent.</p>
        <div style={{ margin: "0 0 1rem" }}>
          <p style={LINK_LINE}><Link href="/ecosystem">Explore the Hivra ecosystem</Link></p>
          <p style={LINK_LINE}><a href="/docs/litepaper">Read the Litepaper</a></p>
          <p style={LINK_LINE}><Link href="/tokenomics">Read the tokenomics</Link></p>
        </div>
      </section>

      <section id="not-included" aria-labelledby="not-included-title" style={SECTION}>
        <h2 id="not-included-title">What the token does not give you</h2>
        <p>$HIVRA does not represent ownership of Hivra or a claim on its revenue. The published proposal does not include staking or yield, and a larger token balance cannot buy wider access to people&apos;s data or weaken Hivra&apos;s security controls.</p>
        <p>The treasury and other proposed uses are subject to separate published terms. Future products do not create present entitlements.</p>
      </section>

      <section id="official-accounts" aria-labelledby="official-accounts-title" style={SECTION}>
        <h2 id="official-accounts-title">Avoid fake migration links</h2>
        <p><strong>Claims are made through the official Sablier flow, not through links sent in DMs.</strong></p>
        <p>A small fee applies to the legitimate claim. Only follow the verified claim link published on Hivra’s official website. Check the destination and the transaction details before connecting your wallet or confirming anything. Be wary of lookalike tokens, fake claim sites and impersonators.</p>
        <p>Our official channels are:</p>
        <ul>
          {officialAccounts.map((account) => (
            <li key={account.service}>
              <strong>{account.service}:</strong>{" "}
              <ExternalLink href={account.href}>{account.handle}</ExternalLink>
            </li>
          ))}
        </ul>
        <p>Hivra does not have an official Telegram group.</p>
        {migrationHref ? <p data-testid="token-migration-link"><Link href={migrationHref}>Read the migration details</Link></p> : null}
      </section>
    </main>
  </PublicSite>;
}
