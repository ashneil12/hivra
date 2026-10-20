import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

import PublicSite from "@/components/public-site/PublicSite";
import type { HivraMigrationReceiptKind } from "@/lib/claim/hivra-migration-config";
import type { MigrationDate, ServedHivraMigration } from "@/lib/claim/hivra-migration";
import { RESTRICTED_TOKEN_PAGE_COPY } from "@/lib/token-phase-copy";
import { formatUtcInstant } from "@/lib/claim/hivra-claim";
import { formatLaunchInstantUtc } from "@/lib/token-verification-content";

import styles from "./TokenFacts.module.css";
import { TokenGeoNotice } from "./TokenGeoNotice";

export type MigrationViewState =
  | { kind: "blocked"; notice: string }
  | {
      kind: "open";
      migration: ServedHivraMigration;
      /** /token/airdrop, set by the server only when that lookup is served. */
      airdropLookupHref: string | null;
      /** The validated Sablier campaign link, set by the server only while the claim is open. */
      claimHref: string | null;
    };

const SECTION: CSSProperties = { borderTop: "1px solid var(--public-line)", padding: "2rem 0" };
const LINK_LINE: CSSProperties = { margin: "0 0 0.5rem" };
const ADDRESS: CSSProperties = { overflowWrap: "anywhere" };
const MUTED: CSSProperties = { color: "var(--public-muted)" };

const FRACTION_WORDS: Record<number, string> = { 10: "one-tenth", 20: "one-fifth", 25: "one-quarter", 50: "one-half" };

function formatDate(date: MigrationDate): string {
  if (!date.dateOnly) return formatLaunchInstantUtc(date.iso);
  return new Date(date.iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** A percentage without float noise: 100 - 5 is 95, 100 - 1.1 is 98.9. */
function pct(value: number): string {
  return `${Number(value.toFixed(4))}%`;
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <section id={id} aria-labelledby={`${id}-title`} style={SECTION}>
    <h2 id={`${id}-title`}>{title}</h2>
    {children}
  </section>;
}

/** The pack's "**Title** / address / [Link]" block: one paragraph, one line each. */
function AddressBlock({ testId, title, children }: { testId: string; title: ReactNode; children: ReactNode }) {
  return <p data-testid={testId}>
    <strong>{title}</strong>
    {children}
  </p>;
}

function WhatChanged({ migration }: { migration: ServedHivraMigration }) {
  const { snapshot } = migration;
  return <Section id="what-changed" title="What changed?">
    <p>The original $HermesOS token remains on Base. It hasn&apos;t been converted or replaced inside your wallet automatically.</p>
    <p>A snapshot of eligible $HermesOS holdings has <strong>already been taken</strong>. Wallets included in that snapshot are eligible to claim <strong>one $HIVRA for each eligible $HermesOS</strong> recorded at the snapshot block.</p>
    <p>The new token is claimed through <strong>Sablier</strong>. This isn&apos;t an automatic airdrop: <strong>you initiate the claim and pay the small claim fee</strong>, along with any applicable network transaction costs shown before confirmation.</p>
    <p>You <strong>do not need to burn or surrender $HermesOS</strong> to make a claim under the current arrangement. The old token remains a separate token on Base.</p>
    <p>Existing accounts that previously qualified for token-based compute access keep that entitlement under the existing access rules. Claiming $HIVRA is separate from keeping that access.</p>
    {snapshot ? <p data-testid="migration-snapshot-facts">
      <strong>Snapshot block:</strong> <code>{snapshot.block}</code>
      {snapshot.takenAt ? <><br /><strong>Snapshot taken:</strong> <code>{formatLaunchInstantUtc(snapshot.takenAt)}</code></> : null}
      <br /><ExternalLink href={snapshot.url}>View the published snapshot</ExternalLink>
    </p> : null}
  </Section>;
}

function Eligibility({ airdropLookupHref, claimHref, claim }: { airdropLookupHref: string | null; claimHref: string | null; claim: ServedHivraMigration["claim"] }) {
  return <Section id="eligibility" title="Check your eligibility and claim">
    {airdropLookupHref ? <p>Not sure whether your wallet was included? Use the snapshot checker to look up a <strong>public wallet address</strong> and see the eligible allocation.</p> : null}
    <p>If you&apos;re eligible, follow the <strong>official Sablier claim link published by Hivra</strong>. Check the claim amount and any fees in your wallet before approving a transaction.</p>
    {airdropLookupHref || claimHref ? <div data-testid="migration-claim-links" style={{ margin: "0 0 1rem" }}>
      {airdropLookupHref ? <p style={LINK_LINE}><Link href={airdropLookupHref}>Check a wallet</Link></p> : null}
      {claimHref ? <p style={LINK_LINE}><ExternalLink href={claimHref}>Claim through Sablier</ExternalLink></p> : null}
    </div> : null}
    {claim.opensAt && claim.closesAt ? <p data-testid="migration-claim-window">
      <strong>Claim window:</strong> {formatUtcInstant(claim.opensAt)} to {formatUtcInstant(claim.closesAt)}
    </p> : null}
    <p><strong>Important:</strong> A legitimate Sablier claim involves connecting a wallet and authorising the necessary claim transaction. Don&apos;t trust a claim link sent through a DM. Start from Hivra&apos;s official token page, and verify the destination before signing.</p>
  </Section>;
}

function Contracts({ migration }: { migration: ServedHivraMigration }) {
  const { hivraAddress, hermesosAddress } = migration;
  return <Section id="contracts" title="Official token contracts">
    <AddressBlock testId="migration-hivra-contract" title="$HIVRA · New ecosystem token">
      <br />Network: Base
      <br />Contract: <code style={ADDRESS}>{hivraAddress}</code>
      <br /><ExternalLink href={`https://basescan.org/token/${hivraAddress}`}>View $HIVRA on BaseScan</ExternalLink>
    </AddressBlock>
    <AddressBlock testId="migration-hermesos-contract" title="$HermesOS · Legacy token">
      <br />Network: Base
      <br />Contract: <code style={ADDRESS}>{hermesosAddress}</code>
      <br /><ExternalLink href={`https://basescan.org/token/${hermesosAddress}`}>View $HermesOS on BaseScan</ExternalLink>
    </AddressBlock>
    <p>Always compare the full contract address with the official <Link href="/token">token page</Link>. A matching name or symbol is not enough.</p>
  </Section>;
}

function Fees({ migration }: { migration: ServedHivraMigration }) {
  const { fee, treasurySafe } = migration;
  if (!fee && !treasurySafe) return null;
  return <Section id="fees" title="How trading fees are handled">
    {fee ? <div data-testid="migration-fee">
      <p>The planned $HIVRA pool has a <strong>{pct(fee.totalPct)} trading fee</strong>. Under the documented arrangement, Doppler receives <strong>{pct(fee.protocolSharePct)} of the collected fees</strong>, with the remaining <strong>{pct(100 - fee.protocolSharePct)}</strong> directed to Hivra&apos;s Safe, a multisignature wallet requiring two of three approvals to move funds.</p>
      <p>The stated liquidity plan is to use <strong>{FRACTION_WORDS[fee.liquiditySharePct] ?? pct(fee.liquiditySharePct)} of the fees received by the Safe each week</strong> to add liquidity to the pool and lock that position. We will publish transaction links when additions happen, so the activity can be checked rather than taken on trust.</p>
    </div> : null}
    {treasurySafe ? <AddressBlock testId="migration-safe" title="Hivra Safe">
      <br /><code style={ADDRESS}>{treasurySafe}</code>
      <br /><ExternalLink href={`https://basescan.org/address/${treasurySafe}`}>View the Safe on BaseScan</ExternalLink>
    </AddressBlock> : null}
  </Section>;
}

function Founder({ migration }: { migration: ServedHivraMigration }) {
  const { founder } = migration;
  if (!founder) return null;
  const plan: { key: string; line: ReactNode }[] = [];
  if (founder.headStartDays !== null) {
    plan.push({ key: "head-start", line: <>Make no sales during the first {founder.headStartDays} days following the confirmed migration announcement.</> });
  }
  if (founder.weeklyCapTokens) {
    plan.push({ key: "weekly-cap", line: <>Sell no more than <strong>{founder.weeklyCapTokens} $HermesOS in any week</strong> during the planned sale period.</> });
  }
  if (founder.maxPriceImpactPct !== null) {
    plan.push({ key: "impact", line: <>Limit each planned sale according to a <strong>{pct(founder.maxPriceImpactPct)} legacy-pool price-impact threshold</strong>, while recognising that actual market movements cannot be guaranteed.</> });
  }
  if (founder.weeks !== null) {
    plan.push({ key: "weeks", line: <>Run the sales over <strong>{founder.weeks} weeks</strong>, starting on the final published date.</> });
  }
  if (founder.burnAddress) {
    plan.push({ key: "burn", line: <>Send any remaining founder-held $HermesOS to the stated burn address on the final published date.</> });
  }
  return <Section id="founder" title="What happens to the founder's $HermesOS?">
    <p data-testid="migration-founder-held">
      There is <strong>no separate team allocation of $HIVRA</strong> in the current migration plan.{" "}
      {founder.heldTokens
        ? <>The founder&apos;s approximately <strong>{founder.heldTokens} $HermesOS</strong> are excluded from the eligible snapshot allocation, so those holdings do not receive $HIVRA through the migration.</>
        : <>The founder&apos;s $HermesOS are excluded from the eligible snapshot allocation, so those holdings do not receive $HIVRA through the migration.</>}
    </p>
    {plan.length > 0 ? <>
      <p>The existing plan for the founder&apos;s legacy tokens is to:</p>
      <ul data-testid="migration-founder-plan">{plan.map(({ key, line }) => <li key={key}>{line}</li>)}</ul>
      <p>These are <strong>planned actions</strong>, not transactions that have already happened. Completed transactions will be linked below.</p>
    </> : null}
    {founder.wallet ? <AddressBlock testId="migration-founder-wallet" title="Founder wallet">
      <br /><code style={ADDRESS}>{founder.wallet}</code>
      <br /><ExternalLink href={`https://basescan.org/address/${founder.wallet}`}>View on BaseScan</ExternalLink>
    </AddressBlock> : null}
    {founder.burnAddress ? <AddressBlock testId="migration-burn-address" title="Intended burn address">
      <br /><code style={ADDRESS}>{founder.burnAddress}</code>
      <br /><ExternalLink href={`https://basescan.org/address/${founder.burnAddress}`}>View on BaseScan</ExternalLink>
    </AddressBlock> : null}
    {founder.saleStart || founder.burnDate ? <p data-testid="migration-founder-dates">
      {founder.saleStart ? <><strong>Sale start:</strong> <code>{formatDate(founder.saleStart)}</code></> : null}
      {founder.saleStart && founder.burnDate ? <br /> : null}
      {founder.burnDate ? <><strong>Final burn date:</strong> <code>{formatDate(founder.burnDate)}</code></> : null}
    </p> : null}
  </Section>;
}

/** One transaction per line: its date, the note if there is one, and its BaseScan link. */
function ReceiptItems({ receipts }: { receipts: readonly ServedHivraMigration["receipts"][number][] }) {
  return <ul>
    {receipts.map((receipt) => <li key={receipt.txHash}>
      {formatDate(receipt.date)}{receipt.note ? <>: {receipt.note}</> : null}.{" "}
      <ExternalLink href={`https://basescan.org/tx/${receipt.txHash}`}>View on BaseScan</ExternalLink>
    </li>)}
  </ul>;
}

function ReceiptGroup({ migration, kind, testId, title }: { migration: ServedHivraMigration; kind: HivraMigrationReceiptKind; testId: string; title: string }) {
  const items = migration.receipts.filter((receipt) => receipt.kind === kind);
  if (items.length === 0) return null;
  return <div data-testid={testId}>
    <h3>{title}</h3>
    <ReceiptItems receipts={items} />
  </div>;
}

/**
 * The pack's three groups. A group with nothing to show prints nothing, not even
 * its heading, and the pack's bracketed "link completed transactions here"
 * placeholders are never rendered.
 */
function OnChainRecords({ migration, claimHref }: { migration: ServedHivraMigration; claimHref: string | null }) {
  const { snapshot, claim, claimRecordsUrl } = migration;
  const claimReceipts = migration.receipts.filter((receipt) => receipt.kind === "claim");
  // Claim transactions only exist once claims have started, so the records link waits for that too.
  const recordsHref = claim.phase === "open" || claim.phase === "closed" ? claimRecordsUrl : null;
  const hasSnapshotAndClaims = snapshot !== null || claimHref !== null || recordsHref !== null || claimReceipts.length > 0;
  return <Section id="records" title="On-chain records">
    <p>The point of publishing addresses and transactions is straightforward: anyone should be able to check what has actually happened.</p>
    {hasSnapshotAndClaims ? <div data-testid="migration-records-snapshot">
      <h3>Snapshot and claims</h3>
      {snapshot ? <p style={LINK_LINE}><ExternalLink href={snapshot.url}>Published eligibility snapshot</ExternalLink></p> : null}
      {claimHref ? <p style={LINK_LINE}><ExternalLink href={claimHref}>Official Sablier claim campaign / contract</ExternalLink></p> : null}
      {recordsHref ? <p style={LINK_LINE}><ExternalLink href={recordsHref}>Verified claim transactions or claim dashboard</ExternalLink></p> : null}
      {claimReceipts.length > 0 ? <ReceiptItems receipts={claimReceipts} /> : null}
    </div> : null}
    <ReceiptGroup migration={migration} kind="liquidity" testId="migration-records-liquidity" title="Liquidity added and locked" />
    <ReceiptGroup migration={migration} kind="founder-sale" testId="migration-records-founder" title="Founder sales and burn" />
    <p>We won&apos;t present example transactions as completed activity.</p>
  </Section>;
}

/**
 * /token/migration. Ash's copy pack page 02-token-migration.md, applied
 * verbatim: headings, paragraphs, bold and italic runs, and the order of
 * sections and links. Do not reword it here; a copy change comes from Ash. Token
 * copy needs UK financial-promotion / legal review before release.
 *
 * Every bracketed placeholder in the pack is data here, and the line, value or
 * link is left out until the data exists and validates: the snapshot block,
 * time and link (HIVRA_AIRDROP), "Check a wallet" (only when /token/airdrop is
 * served), "Claim through Sablier" and "Official Sablier claim campaign /
 * contract" (both only while the claim is open: the Sablier link has no other
 * home than the open window), "Verified claim transactions or claim dashboard"
 * (a reviewed link, once claims have started), the $HIVRA
 * contract (the token registry), the Safe, the founder wallet and the burn
 * address, the sale start and burn dates, and every transaction link. Rendered
 * on the server for one request: a viewer the token geo-policy blocks gets the
 * notice and a link to the contracts, and no migration details.
 */
export default function MigrationView({ state }: { state: MigrationViewState }) {
  return <PublicSite>
    <main className={styles.content} id="main-content" style={{ maxWidth: 1000, margin: "0 auto", padding: "clamp(3rem, 8vw, 7rem) var(--public-gutter)", lineHeight: 1.7 }}>
      <Link href="/token">Token</Link>
      {state.kind === "blocked" ? <>
        <header style={{ margin: "2rem 0 3rem", maxWidth: 760 }}>
          <p className="mono" style={{ color: "var(--public-accent)", fontSize: 11 }}>{RESTRICTED_TOKEN_PAGE_COPY.eyebrow}</p>
          <h1 style={{ fontSize: "clamp(2.8rem, 7vw, 5rem)", lineHeight: 1.05, margin: "1rem 0" }}>{RESTRICTED_TOKEN_PAGE_COPY.heroTitle}</h1>
        </header>
        <TokenGeoNotice notice={state.notice} />
        <p>The official contract addresses are on the <Link href="/token">token page</Link>.</p>
      </> : <>
        <header style={{ margin: "2rem 0 3rem", maxWidth: 760 }}>
          <p className="mono" style={{ color: "var(--public-accent)", fontSize: 11 }}><strong>TOKEN TRANSITION</strong></p>
          <h1 style={{ fontSize: "clamp(2.8rem, 7vw, 5rem)", lineHeight: 1.05, margin: "1rem 0" }}>From $HermesOS to $HIVRA</h1>
          <p style={{ fontSize: "1.2rem", ...MUTED }}>HermesOS was the beginning of Hivra. What started as a way to deploy Hermes Agent has grown into a platform for giving different AI agents computers of their own, with a much wider ecosystem planned around them.</p>
          <p>$HIVRA is the new token for that direction. This page explains what the transition means for existing $HermesOS holders, how to claim if you&apos;re eligible, and how to check the on-chain records.</p>
          <p data-testid="token-risk-line" style={MUTED}><em>Cryptoassets are high risk and can lose all their value. This page provides information about the transition, not an offer or invitation to buy.</em></p>
        </header>
        <WhatChanged migration={state.migration} />
        <Eligibility airdropLookupHref={state.airdropLookupHref} claimHref={state.claimHref} claim={state.migration.claim} />
        <Contracts migration={state.migration} />
        <Fees migration={state.migration} />
        <Founder migration={state.migration} />
        <OnChainRecords migration={state.migration} claimHref={state.claimHref} />
        <Section id="remember" title="A few things to remember">
          <ul>
            <li>The <strong>snapshot is complete</strong>. Buying or receiving $HermesOS after the snapshot does not add to the recorded allocation.</li>
            <li><strong>Claims are not automatic</strong>. Eligible holders claim through Sablier and cover the applicable claim fee.</li>
            <li><strong>No burn of your original $HermesOS is required</strong> by the current claim process.</li>
            <li><strong>Never follow a claim link from a DM.</strong> Start from Hivra&apos;s official site and check the contract and transaction details before signing.</li>
            <li>You can still use Hivra through ordinary card billing, or self-host the open-source platform without a token.</li>
          </ul>
          <div style={{ margin: "0 0 1rem" }}>
            <p style={LINK_LINE}><Link href="/token">Verify official contracts</Link></p>
            <p style={LINK_LINE}><a href="/docs/litepaper">Read the Hivra Litepaper</a></p>
          </div>
        </Section>
      </>}
    </main>
  </PublicSite>;
}
