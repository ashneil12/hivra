import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

import PublicSite from "@/components/public-site/PublicSite";
import type { HivraMigrationReceiptKind } from "@/lib/claim/hivra-migration-config";
import type { MigrationDate, ServedHivraMigration } from "@/lib/claim/hivra-migration";
import { RESTRICTED_TOKEN_PAGE_COPY } from "@/lib/token-phase-copy";
import { formatLaunchInstantUtc, tokenVerificationContent } from "@/lib/token-verification-content";

import styles from "./TokenFacts.module.css";
import { TokenGeoNotice } from "./TokenGeoNotice";

// Token-facing copy: plain facts, anything planned labelled as planned. It needs
// UK financial-promotion / legal review before release.

export type MigrationViewState =
  | { kind: "blocked"; notice: string }
  | { kind: "open"; migration: ServedHivraMigration; airdropLookupHref: string | null };

const DAY_MS = 24 * 60 * 60 * 1000;
const muted: CSSProperties = { color: "var(--public-muted)" };
const sectionStyle: CSSProperties = { borderTop: "1px solid var(--public-line)", padding: "2rem 0" };
const addressBox: CSSProperties = { display: "block", overflowWrap: "anywhere", padding: "1rem", border: "1px solid var(--public-line)", margin: "0 0 0.75rem" };
const eyebrow: CSSProperties = { fontSize: 11 };

const RECEIPT_GROUPS: readonly { kind: HivraMigrationReceiptKind; title: string }[] = [
  { kind: "liquidity", title: "Liquidity added and locked" },
  { kind: "founder-sale", title: "Founder sales" },
  { kind: "burn", title: "Burns" },
  { kind: "airdrop-batch", title: "Airdrop batches" },
];

const FRACTION_WORDS: Record<number, string> = { 10: "a tenth", 20: "a fifth", 25: "a quarter", 50: "half" };

function formatDate(date: MigrationDate): string {
  if (!date.dateOnly) return formatLaunchInstantUtc(date.iso);
  return new Date(date.iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

function pct(value: number): string {
  return `${value}%`;
}

function Section({ id, label, title, children }: { id: string; label?: string; title: string; children: ReactNode }) {
  return <section id={id} aria-labelledby={`${id}-title`} style={sectionStyle}>
    {label ? <p className="mono" style={eyebrow}>{label}</p> : null}
    <h2 id={`${id}-title`}>{title}</h2>
    {children}
  </section>;
}

function Address({ address, kind, linkText }: { address: string; kind: "token" | "address"; linkText: string }) {
  return <>
    <code style={addressBox}>{address}</code>
    <p><a href={`https://basescan.org/${kind}/${address}`} target="_blank" rel="noopener noreferrer">{linkText}</a></p>
  </>;
}

function WhatChanged({ migration }: { migration: ServedHivraMigration }) {
  const { snapshot, announcedAt } = migration;
  return <Section id="what-changed" title="What changed">
    <p>$HermesOS moved to $HIVRA, a new token on Base.</p>
    <p data-testid="migration-one-for-one">
      {snapshot
        ? <>Every wallet that held $HermesOS at Base block{" "}
            <a href={`https://basescan.org/block/${snapshot.block}`} target="_blank" rel="noopener noreferrer">{snapshot.block}</a>{" "}
            is sent one $HIVRA for each $HermesOS it held.</>
        : <>Every wallet that held $HermesOS at the snapshot block is sent one $HIVRA for each $HermesOS it held.</>}
    </p>
    <p>It is sent automatically. There is nothing to claim.</p>
    <p>The old $HermesOS contract is now legacy.</p>
    {snapshot ? <p><a href={snapshot.url} target="_blank" rel="noopener noreferrer">Open the published snapshot</a></p> : null}
    {announcedAt ? <p data-testid="migration-announced" style={muted}>Announced {formatDate(announcedAt)}.</p> : null}
  </Section>;
}

function Fees({ migration }: { migration: ServedHivraMigration }) {
  const { fee, treasurySafe } = migration;
  if (!fee && !treasurySafe) return null;
  return <Section id="fees" title="Where trading fees go">
    {fee ? <div data-testid="migration-fee">
      <p>Each trade in the $HIVRA pool pays a {pct(fee.totalPct)} fee.</p>
      <p>Doppler, the launch platform, keeps {pct(fee.protocolSharePct)} of the fees. The rest goes to Hivra&apos;s Safe, a shared wallet that needs 2 of 3 signers to move anything.</p>
      <p>Planned: each week, {FRACTION_WORDS[fee.liquiditySharePct] ?? pct(fee.liquiditySharePct)} of what the Safe received is added to the pool&apos;s liquidity and locked. Each addition is listed under Receipts.</p>
    </div> : <p>Hivra&apos;s share of the trading fees goes to this Safe.</p>}
    {treasurySafe ? <div data-testid="migration-safe">
      <p>The Safe:</p>
      <Address address={treasurySafe} kind="address" linkText="View the Safe on BaseScan" />
    </div> : null}
  </Section>;
}

function Founder({ migration }: { migration: ServedHivraMigration }) {
  const { founder, announcedAt } = migration;
  if (!founder) return null;
  const plan: ReactNode[] = [];
  if (founder.headStartDays !== null) {
    plan.push(announcedAt
      ? <>No sales in the first {founder.headStartDays} days after the announcement, so none before {formatLaunchInstantUtc(new Date(Date.parse(announcedAt.iso) + founder.headStartDays * DAY_MS).toISOString())}.</>
      : <>No sales in the first {founder.headStartDays} days after the announcement.</>);
  }
  if (founder.weeklyCapTokens) plan.push(<>At most {founder.weeklyCapTokens} $HermesOS sold in any week.</>);
  if (founder.maxPriceImpactPct !== null) plan.push(<>No single sale may move the $HermesOS pool by more than {pct(founder.maxPriceImpactPct)}.</>);
  if (founder.weeks !== null) {
    plan.push(<>Sales run for {founder.weeks} weeks
      {founder.saleStart ? <>, starting {formatDate(founder.saleStart)}</> : null}
      {founder.saleDay ? <>, on {founder.saleDay}s</> : null}.</>);
  }
  if (founder.burnDate || founder.burnAddress) {
    plan.push(founder.burnDate
      ? <>On {formatDate(founder.burnDate)}, any of his $HermesOS not sold are sent to the burn address, where no one can move them.</>
      : <>Any of his $HermesOS not sold by the end are sent to the burn address, where no one can move them.</>);
  }
  return <Section id="founder" title="The founder's tokens">
    <p>There is no team allocation of $HIVRA.</p>
    <p>The founder holds no $HIVRA.</p>
    <p data-testid="migration-founder-held">
      {founder.heldTokens
        ? <>He holds {founder.heldTokens} $HermesOS. They are not migrated, so they are sent no $HIVRA.</>
        : <>His $HermesOS are not migrated, so they are sent no $HIVRA.</>}
    </p>
    {plan.length > 0 ? <>
      <h3>Planned sales of his $HermesOS</h3>
      <p style={muted}>These are planned. Each sale and the burn are listed under Receipts when they happen.</p>
      <ul data-testid="migration-founder-plan">{plan.map((line, index) => <li key={index}>{line}</li>)}</ul>
    </> : null}
    {founder.burnAddress ? <div data-testid="migration-burn-address">
      <p>The burn address:</p>
      <Address address={founder.burnAddress} kind="address" linkText="View the burn address on BaseScan" />
    </div> : null}
    {founder.wallet ? <div data-testid="migration-founder-wallet">
      <p>The founder&apos;s wallet:</p>
      <Address address={founder.wallet} kind="address" linkText="View the founder's wallet on BaseScan" />
    </div> : null}
  </Section>;
}

function Receipts({ migration }: { migration: ServedHivraMigration }) {
  if (migration.receipts.length === 0) return null;
  return <Section id="receipts" title="Receipts">
    <p>Each line is a transaction on Base.</p>
    {RECEIPT_GROUPS.map(({ kind, title }) => {
      const items = migration.receipts.filter((receipt) => receipt.kind === kind);
      if (items.length === 0) return null;
      return <div key={kind} data-testid={`migration-receipts-${kind}`}>
        <h3>{title}</h3>
        <ul>
          {items.map((receipt) => <li key={receipt.txHash}>
            {formatDate(receipt.date)}{receipt.note ? <>: {receipt.note}</> : null}.{" "}
            <a href={`https://basescan.org/tx/${receipt.txHash}`} target="_blank" rel="noopener noreferrer">View on BaseScan</a>
          </li>)}
        </ul>
      </div>;
    })}
  </Section>;
}

/**
 * /token/migration. Rendered on the server for one request. A viewer the token
 * geo-policy blocks gets the notice and a link to the contracts, and no
 * migration details.
 */
export default function MigrationView({ state }: { state: MigrationViewState }) {
  const { riskLine, lookalikeWarning } = tokenVerificationContent;
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
          <p className="mono" style={{ color: "var(--public-accent)", fontSize: 11 }}>TOKEN MIGRATION</p>
          <h1 style={{ fontSize: "clamp(2.8rem, 7vw, 5rem)", lineHeight: 1.05, margin: "1rem 0" }}>$HermesOS moved to $HIVRA</h1>
          <p style={{ fontSize: "1.2rem", ...muted }}>What changed, where the trading fees go, and what happens to the founder&apos;s tokens. Each address and transaction links to BaseScan.</p>
          <p data-testid="token-risk-line" style={muted}>{riskLine}</p>
        </header>
        <WhatChanged migration={state.migration} />
        {state.airdropLookupHref ? <Section id="check-wallet" title="Check your wallet">
          <p>Paste a wallet address to see the $HIVRA it is sent, and whether it was sent.</p>
          <p data-testid="migration-airdrop-lookup"><Link href={state.airdropLookupHref}>Check a wallet for the $HIVRA airdrop</Link></p>
        </Section> : null}
        <Section id="contracts" title="Contracts">
          <h3>$HIVRA on Base</h3>
          <Address address={state.migration.hivraAddress} kind="token" linkText="View the $HIVRA contract on BaseScan" />
          <h3>$HermesOS on Base (legacy)</h3>
          <Address address={state.migration.hermesosAddress} kind="token" linkText="View the $HermesOS contract on BaseScan" />
        </Section>
        <Fees migration={state.migration} />
        <Founder migration={state.migration} />
        <Receipts migration={state.migration} />
        <Section id="stay-safe" title="Stay safe">
          <p><strong>Never connect a wallet to &quot;claim&quot; $HIVRA.</strong> Hivra never asks you to connect a wallet, sign a message or approve a transaction to receive it. Anyone who asks is not Hivra.</p>
          <p>Only trust the contract address on this page.</p>
          <p data-testid="token-lookalike-warning">Fake HIVRA tokens exist. {lookalikeWarning}</p>
          <p><Link href="/token">Verify the token contracts</Link></p>
        </Section>
      </>}
    </main>
  </PublicSite>;
}
