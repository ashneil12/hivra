import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

import PublicSite from "@/components/public-site/PublicSite";
import type { ServedTokenReceipts, ShownReceipt } from "@/lib/token-receipts/token-receipts-chain";
import type { TokenAmount } from "@/lib/token-receipts/token-receipts";
import { RECEIPT_TOKEN_DECIMALS, formatReceiptDate, formatTokenAmount, type ReceiptToken } from "@/lib/token-receipts/token-receipts-format";
import { RESTRICTED_TOKEN_PAGE_COPY } from "@/lib/token-phase-copy";

import styles from "./TokenFacts.module.css";
import { TokenGeoNotice } from "./TokenGeoNotice";

export type ReceiptsViewState =
  | { kind: "blocked"; notice: string }
  | {
      kind: "open";
      receipts: ServedTokenReceipts;
      /** /token/migration when that page is served, else null. */
      migrationHref: string | null;
    };

const SECTION: CSSProperties = { borderTop: "1px solid var(--public-line)", padding: "2rem 0" };
const ADDRESS: CSSProperties = { overflowWrap: "anywhere" };
const MUTED: CSSProperties = { color: "var(--public-muted)" };
const LINK_LINE: CSSProperties = { margin: "0 0 0.5rem" };
const CELL: CSSProperties = { textAlign: "left", padding: "0.5rem 0.75rem 0.5rem 0", borderBottom: "1px solid var(--public-line)", whiteSpace: "nowrap" };

const TOKEN_LABEL: Record<ReceiptToken, string> = { ETH: "ETH", WETH: "WETH", HIVRA: "$HIVRA", HermesOS: "$HermesOS", USDC: "USDC" };
const FRACTION_WORDS: Record<number, string> = { 10: "one-tenth", 20: "one-fifth", 25: "one-quarter", 50: "one-half" };

function amount(token: ReceiptToken, wei: bigint): string {
  return `${formatTokenAmount(wei, RECEIPT_TOKEN_DECIMALS[token])} ${TOKEN_LABEL[token]}`;
}

function amounts(list: readonly TokenAmount[]): string {
  const parts = list.map(({ token, wei }) => amount(token, wei));
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function pct(value: number): string {
  return `${Number(value.toFixed(4))}%`;
}

function day(iso: string): string {
  return formatReceiptDate(iso, true);
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

function AddressLine({ testId, label, address }: { testId: string; label: string; address: string }) {
  return <p data-testid={testId}>
    <strong>{label}</strong>
    <br /><code style={ADDRESS}>{address}</code>
    <br /><ExternalLink href={`https://basescan.org/address/${address}`}>View on BaseScan</ExternalLink>
  </p>;
}

/** What one verified line says happened, in the words of its kind. */
function whatHappened(receipt: Extract<ShownReceipt, { check: "verified" }>): string {
  const moved = amounts(receipt.amounts);
  const others = receipt.otherTransfers > 0 ? `${receipt.otherTransfers} other token transfer${receipt.otherTransfers === 1 ? "" : "s"}` : "";
  const what = [moved, others].filter(Boolean).join(" and ");
  switch (receipt.kind) {
    case "fee-claim":
      return `The Safe received ${what}`;
    case "liquidity-add":
      return `The Safe added ${what} to liquidity`;
    case "liquidity-lock": {
      const positions = receipt.positionIds.map((id) => `#${id}`).join(", ");
      const locked = [positions ? `position ${positions}` : "", what].filter(Boolean).join(" and ") || "liquidity";
      const lock = receipt.lock;
      const until = lock?.unlocksAt ? `, locked until ${formatReceiptDate(lock.unlocksAt.iso, lock.unlocksAt.dateOnly)}` : ", with no unlock date";
      return `The Safe locked ${locked} with ${lock?.locker ?? "the locker"}${until}`;
    }
    case "founder-sale":
      return `The founder wallet sold ${what}`;
    case "founder-burn":
      return `The founder wallet burned ${what}`;
  }
}

function ReceiptList({ testId, receipts, empty }: { testId: string; receipts: readonly ShownReceipt[]; empty: ReactNode }) {
  if (receipts.length === 0) return <p data-testid={`${testId}-empty`} style={MUTED}>{empty}</p>;
  return <ul data-testid={testId}>
    {receipts.map((receipt) => <li key={`${receipt.kind}:${receipt.txHash}`}>
      <strong>{formatReceiptDate(receipt.date.iso, receipt.date.dateOnly)}</strong>
      {": "}
      {receipt.check === "verified" ? whatHappened(receipt) : <span data-testid="receipt-unchecked">Not checked: Base could not be reached just now</span>}.
      {receipt.note ? <> {receipt.note}</> : null}{" "}
      <ExternalLink href={`https://basescan.org/tx/${receipt.txHash}`}>View on BaseScan</ExternalLink>
      {receipt.kind === "liquidity-lock" && receipt.lock?.url ? <>{" · "}<ExternalLink href={receipt.lock.url}>View the lock</ExternalLink></> : null}
    </li>)}
  </ul>;
}

function Summary({ receipts }: { receipts: ServedTokenReceipts }) {
  const { totals } = receipts;
  const rows: { key: string; label: string; value: string }[] = [
    { key: "fees", label: "Fees received by the Safe", value: totals.feesReceived.length > 0 ? amounts(totals.feesReceived) : "None recorded yet" },
    { key: "liquidity", label: "Liquidity added from fees", value: totals.liquidityAdded.length > 0 ? amounts(totals.liquidityAdded) : "None recorded yet" },
    { key: "sold", label: "Founder $HermesOS sold", value: totals.founderSoldWei > 0n ? amount("HermesOS", totals.founderSoldWei) : "None recorded yet" },
    { key: "burned", label: "Founder $HermesOS burned", value: totals.founderBurnedWei > 0n ? amount("HermesOS", totals.founderBurnedWei) : "Not burned yet" },
  ];
  return <dl data-testid="receipts-summary" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "1rem", margin: "0 0 2rem" }}>
    {rows.map((row) => <div key={row.key} data-testid={`receipts-total-${row.key}`} style={{ border: "1px solid var(--public-line)", padding: "1rem" }}>
      <dt className="mono" style={{ fontSize: 11, ...MUTED }}>{row.label.toUpperCase()}</dt>
      <dd style={{ margin: "0.5rem 0 0", fontSize: "1.1rem", overflowWrap: "anywhere" }}>{row.value}</dd>
    </div>)}
  </dl>;
}

function Fees({ receipts }: { receipts: ServedTokenReceipts }) {
  const { fee, treasurySafe, balances } = receipts;
  const held = [
    balances.safeEthWei !== null ? amount("ETH", balances.safeEthWei) : null,
    balances.safeHivraWei !== null ? amount("HIVRA", balances.safeHivraWei) : null,
  ].filter((value): value is string => value !== null);
  return <Section id="fees" title="Trading fees claimed">
    {fee ? <p>The $HIVRA pool charges a <strong>{pct(fee.totalPct)} trading fee</strong>. Doppler keeps {pct(fee.protocolSharePct)} of the fees it collects, and the other {pct(100 - fee.protocolSharePct)} goes to Hivra&apos;s Safe, a multisignature wallet that needs two of three approvals to move funds. Each line below is a claim of those fees arriving in the Safe.</p> : null}
    {treasurySafe ? <AddressLine testId="receipts-safe" label="Hivra Safe" address={treasurySafe} /> : null}
    {treasurySafe && held.length > 0 ? <p data-testid="receipts-safe-balance">
      <strong>In the Safe right now:</strong> {held.join(" and ")}. Money waiting in the Safe is not locked liquidity.
    </p> : null}
    <ReceiptList testId="receipts-fee-claims" receipts={receipts.receipts.filter((receipt) => receipt.kind === "fee-claim")} empty="No fee claims recorded yet." />
  </Section>;
}

function Liquidity({ receipts }: { receipts: ServedTokenReceipts }) {
  const { fee } = receipts;
  const lines = receipts.receipts.filter((receipt) => receipt.kind === "liquidity-add" || receipt.kind === "liquidity-lock");
  return <Section id="liquidity" title="Liquidity added and locked">
    {fee ? <p>The plan is to use <strong>{FRACTION_WORDS[fee.liquiditySharePct] ?? pct(fee.liquiditySharePct)} of the fees the Safe receives each week</strong> to add liquidity to the pool, then lock that position. It is done by hand, so each addition and each lock is listed here with its transaction.</p> : null}
    <ReceiptList testId="receipts-liquidity" receipts={lines} empty="No liquidity has been added or locked from fees yet." />
  </Section>;
}

function FounderWeeksTable({ receipts }: { receipts: ServedTokenReceipts }) {
  const weeks = receipts.founderWeeks;
  if (!weeks) return null;
  return <>
    <div style={{ overflowX: "auto", margin: "0 0 1rem" }}>
      <table data-testid="receipts-founder-weeks" style={{ borderCollapse: "collapse", minWidth: "100%" }}>
        <thead><tr>
          <th scope="col" style={CELL}>Week</th>
          <th scope="col" style={CELL}>Dates (UTC)</th>
          <th scope="col" style={CELL}>Sold</th>
          <th scope="col" style={CELL}>Within the weekly limit</th>
        </tr></thead>
        <tbody>
          {weeks.rows.map((row) => <tr key={row.week} data-testid={`receipts-founder-week-${row.week}`}>
            <td style={CELL}>{row.week}</td>
            <td style={CELL}>{day(row.startsAt)} to {day(new Date(Date.parse(row.endsAt) - 1).toISOString())}</td>
            <td style={CELL}>{row.upcoming ? "Not started" : row.soldWei > 0n ? amount("HermesOS", row.soldWei) : "Nothing"}</td>
            <td style={CELL}>{row.upcoming ? "" : receipts.weeklyCapWei === null ? "No limit set" : row.overCap ? <strong>No, over the limit</strong> : "Yes"}</td>
          </tr>)}
        </tbody>
      </table>
    </div>
    {weeks.afterPlanWei > 0n ? <p data-testid="receipts-founder-after-plan"><strong>Sold after the planned weeks:</strong> {amount("HermesOS", weeks.afterPlanWei)}.</p> : null}
  </>;
}

function Founder({ receipts }: { receipts: ServedTokenReceipts }) {
  const { founder, balances } = receipts;
  if (!founder) return null;
  const plan: string[] = [];
  if (founder.headStartDays !== null) plan.push(`no sales in the first ${founder.headStartDays} days after the migration announcement`);
  if (founder.weeklyCapTokens) plan.push(`at most ${founder.weeklyCapTokens} $HermesOS in any week`);
  if (founder.weeks !== null) plan.push(`over ${founder.weeks} weeks${founder.saleStart ? ` from ${formatReceiptDate(founder.saleStart.iso, founder.saleStart.dateOnly)}` : ""}`);
  return <Section id="founder" title="Founder $HermesOS sell-down">
    <p>The founder&apos;s legacy $HermesOS {founder.heldTokens ? <>(about <strong>{founder.heldTokens}</strong>) </> : null}get no $HIVRA in the migration.{plan.length > 0 ? <> The published plan is {plan.join(", ")}.</> : null} Whatever is left after that is burned (below).</p>
    {founder.wallet ? <AddressLine testId="receipts-founder-wallet" label="Founder wallet" address={founder.wallet} /> : null}
    {founder.wallet && balances.founderHermesosWei !== null ? <p data-testid="receipts-founder-balance">
      <strong>Held in the founder wallet right now:</strong> {amount("HermesOS", balances.founderHermesosWei)}.
    </p> : null}
    <FounderWeeksTable receipts={receipts} />
    <ReceiptList testId="receipts-founder-sales" receipts={receipts.receipts.filter((receipt) => receipt.kind === "founder-sale")} empty="No founder sales yet." />
  </Section>;
}

function Burn({ receipts }: { receipts: ServedTokenReceipts }) {
  const { founder } = receipts;
  const burns = receipts.receipts.filter((receipt) => receipt.kind === "founder-burn");
  if (!founder && burns.length === 0) return null;
  return <Section id="burn" title="Final burn">
    {founder?.burnAddress ? <p>The founder&apos;s unsold $HermesOS go to the burn address{founder.burnDate ? <> on <strong>{formatReceiptDate(founder.burnDate.iso, founder.burnDate.dateOnly)}</strong></> : null}. It is a well-known address with no known owner, so tokens sent there are out of circulation for good. This burns only the founder&apos;s tokens, not anyone else&apos;s.</p> : null}
    {founder?.burnAddress ? <AddressLine testId="receipts-burn-address" label="Burn address" address={founder.burnAddress} /> : null}
    <ReceiptList testId="receipts-burns" receipts={burns} empty="The burn has not happened yet." />
  </Section>;
}

/**
 * /token/receipts. One page that answers "did they do what they said?" for the
 * $HIVRA trading fees, the liquidity those fees fund, the founder's weekly
 * $HermesOS sales and the final burn. Every amount comes from the transaction's
 * own logs on Base (lib/token-receipts), never from a typed-in figure. Token
 * copy needs UK financial-promotion / legal review before release.
 */
export default function ReceiptsView({ state }: { state: ReceiptsViewState }) {
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
        <header style={{ margin: "2rem 0 2rem", maxWidth: 760 }}>
          <p className="mono" style={{ color: "var(--public-accent)", fontSize: 11 }}><strong>ON-CHAIN RECEIPTS</strong></p>
          <h1 style={{ fontSize: "clamp(2.8rem, 7vw, 5rem)", lineHeight: 1.05, margin: "1rem 0" }}>Token receipts</h1>
          <p style={{ fontSize: "1.2rem", ...MUTED }}>What has actually happened with the $HIVRA pool&apos;s trading fees, the liquidity they pay for, and the founder&apos;s legacy $HermesOS.</p>
          <p>Every amount here is read from its transaction on Base, not typed in by us, so you can check it rather than take our word for it.</p>
          <p data-testid="token-risk-line" style={MUTED}><em>Cryptoassets are high risk and can lose all their value. This page reports transactions. It is not an offer or invitation to buy.</em></p>
          <p data-testid="receipts-checked-at" style={{ ...MUTED, fontSize: "0.9rem" }}>Checked against Base: {formatReceiptDate(state.receipts.checkedAt, false)}</p>
          {state.receipts.chainComplete ? null : <p data-testid="receipts-chain-incomplete"><strong>Base could not be reached for every line just now.</strong> Lines marked &ldquo;Not checked&rdquo; are listed but left out of the totals. Try again in a few minutes.</p>}
        </header>
        <Summary receipts={state.receipts} />
        <Fees receipts={state.receipts} />
        <Liquidity receipts={state.receipts} />
        <Founder receipts={state.receipts} />
        <Burn receipts={state.receipts} />
        <Section id="check" title="Check it yourself">
          <p>Each line links to its transaction on BaseScan. A line only appears once its transaction succeeded on Base, on the day it says, and moves what it says: fees reaching the Safe, the Safe adding or locking liquidity, or $HermesOS leaving the founder wallet. The totals count only lines that were checked.</p>
          <div style={{ margin: "0 0 1rem" }}>
            <p style={LINK_LINE}><Link href="/token">Verify the official contracts</Link></p>
            {state.migrationHref ? <p style={LINK_LINE}><Link href={state.migrationHref}>Read the migration details</Link></p> : null}
            <p style={LINK_LINE}><ExternalLink href={`https://basescan.org/token/${state.receipts.hivraAddress}`}>$HIVRA on BaseScan</ExternalLink></p>
            <p style={LINK_LINE}><ExternalLink href={`https://basescan.org/token/${state.receipts.hermesosAddress}`}>$HermesOS on BaseScan</ExternalLink></p>
          </div>
        </Section>
      </>}
    </main>
  </PublicSite>;
}
