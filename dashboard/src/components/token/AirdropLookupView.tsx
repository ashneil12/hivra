import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

import PublicSite from "@/components/public-site/PublicSite";
import type { AirdropSnapshot } from "@/lib/claim/conversion-state";
import { formatUtcInstant, type HivraClaimPhase } from "@/lib/claim/hivra-claim";
import {
  CLAIM_STATE_LABELS,
  claimStateLabel,
  formatHivraAmount,
  formatWholeNumber,
  type AirdropLookupResult,
} from "@/lib/claim/hivra-airdrop-lookup";
import { RESTRICTED_TOKEN_PAGE_COPY } from "@/lib/token-phase-copy";

import styles from "./TokenFacts.module.css";
import { TokenGeoNotice } from "./TokenGeoNotice";

export type AirdropLookupViewState =
  | { kind: "blocked"; notice: string }
  | {
      kind: "open";
      snapshot: AirdropSnapshot;
      /**
       * The Sablier claim. `href` is the validated campaign link, set only while
       * the claim is open; `opensAt` and `closesAt` are ISO instants or null.
       */
      claim: { phase: HivraClaimPhase; href: string | null; opensAt: string | null; closesAt: string | null };
      /** The verified final counts; null unless the list is final. */
      counts: { holders: number; includedWei: string; percentOfSupply: string } | null;
      /** /token/migration, set by the server only when that page is served. */
      migrationHref: string | null;
      /** What the viewer submitted, as typed; null before a lookup. */
      query: string | null;
      result: AirdropLookupResult | null;
    };

const panel: CSSProperties = { margin: "1.5rem 0", padding: "1.25rem", border: "1px solid var(--public-line)" };
const muted: CSSProperties = { color: "var(--public-muted)" };
const linkLabel: CSSProperties = { fontSize: 12, letterSpacing: "0.08em" };

function Amount({ wei }: { wei: string }) {
  return <p data-testid="airdrop-amount" style={{ fontSize: "clamp(1.6rem, 4vw, 2.2rem)", fontWeight: 600, margin: "0 0 0.5rem", overflowWrap: "anywhere" }}>
    {formatHivraAmount(wei)} $HIVRA
  </p>;
}

function WalletLine({ address }: { address: string }) {
  return <p style={muted}>Wallet <code style={{ overflowWrap: "anywhere" }}>{address}</code></p>;
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return <a className="mono" style={linkLabel} href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
}

/**
 * One wallet's answer, using only states the app can verify: the published list
 * (Eligible, Not eligible) and the configured claim window (Claim not yet open,
 * Available to claim, Claim window closed). It cannot see Sablier's on-chain
 * claims, so there is no "Claimed" and no "Unable to verify".
 */
function LookupResult({ result, block, phase }: { result: AirdropLookupResult; block: number; phase: HivraClaimPhase }) {
  switch (result.kind) {
    case "invalid":
      return <p>That is not a wallet address. A Base address starts with 0x followed by 40 letters and numbers.</p>;
    case "holder":
      return <>
        <p data-testid="airdrop-state"><strong>{CLAIM_STATE_LABELS.eligible}</strong></p>
        <Amount wei={result.amountWei} />
        <WalletLine address={result.address} />
        <p data-testid="airdrop-claim-state"><strong>{claimStateLabel(phase)}</strong></p>
      </>;
    case "managed":
      return <>
        <p data-testid="airdrop-state"><strong>{CLAIM_STATE_LABELS.eligible}</strong></p>
        <Amount wei={result.amountWei} />
        <WalletLine address={result.address} />
        <p>Hivra-managed wallet: this allocation is handled separately.</p>
      </>;
    case "excluded":
      return <>
        <p data-testid="airdrop-state"><strong>{CLAIM_STATE_LABELS.notEligible}</strong></p>
        <WalletLine address={result.address} />
        <p>This wallet is left out: {result.label}.</p>
      </>;
    case "absent":
      return <>
        <p data-testid="airdrop-state"><strong>{CLAIM_STATE_LABELS.notEligible}</strong></p>
        <WalletLine address={result.address} />
        <p>This wallet held no $HermesOS at Base block {formatWholeNumber(block)}.</p>
      </>;
  }
}

/**
 * /token/airdrop. Ash's copy pack page 03-token-airdrop.md, applied verbatim:
 * headings, paragraphs, bold and italic runs, and the order of sections and
 * links. Do not reword it here; a copy change comes from Ash. Token copy needs
 * UK financial-promotion / legal review before release.
 *
 * Every bracketed placeholder in the pack is data here, and the line or link is
 * left out until the data exists and validates: the claim window (both ends),
 * the claim link (only while the claim is open), the snapshot link, the final
 * counts (only when the list is final) and the migration link (only when that
 * page is served). The pack's "Already claimed?" line is left out because the app
 * cannot verify claims. Two short lines are not in the pack: "(rounded up)" after the
 * percentage of supply (the generator rounds it up) and the line about Hivra-managed
 * wallets, which only repeats the pack's own "handled separately" from /token. Rendered on the server for one request: a viewer the
 * token geo-policy blocks gets the notice and a link to the contracts, never an
 * amount, a total or the lookup form.
 */
export default function AirdropLookupView({ state }: { state: AirdropLookupViewState }) {
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
          <p className="mono" style={{ color: "var(--public-accent)", fontSize: 11 }}><strong>$HIVRA HOLDER CLAIM</strong></p>
          <h1 style={{ fontSize: "clamp(2.8rem, 7vw, 5rem)", lineHeight: 1.05, margin: "1rem 0" }}>Check your $HIVRA allocation</h1>
          <p style={{ fontSize: "1.2rem", ...muted }}>The $HermesOS snapshot has been completed. If your wallet was eligible, you can check how much $HIVRA was allocated to it and claim through Sablier once the official claim window is open.</p>
          <p>The allocation is <strong>one $HIVRA for each $HermesOS held in an eligible wallet at the snapshot block</strong>. You don&apos;t need to burn or surrender your original $HermesOS tokens.</p>
          <p><strong>This is a claim, not an automatic transfer.</strong> Claiming requires a wallet transaction, and you pay the applicable claim and network fees. You&apos;ll be shown the relevant costs before confirming.</p>
          <p data-testid="token-risk-line" style={muted}><em>Cryptoassets are high risk and can lose all their value. This page explains the holder claim process and is not an offer or invitation to buy.</em></p>
        </header>
        <section aria-labelledby="lookup-title" style={{ borderTop: "1px solid var(--public-line)", padding: "2rem 0" }}>
          <h2 id="lookup-title">Check a wallet</h2>
          <p>Enter a public Base wallet address to check whether it appears in the published snapshot and see its allocation.</p>
          <form method="get" action="/token/airdrop" role="search" style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
            <label htmlFor="airdrop-address" style={{ display: "flex", flexDirection: "column", gap: 6, flex: "1 1 320px", minWidth: 0 }}>
              <span className="mono" style={{ fontSize: 11 }}><strong>WALLET ADDRESS</strong></span>
              <input id="airdrop-address" name="address" type="text" inputMode="text" autoComplete="off" spellCheck={false}
                placeholder="0x…" defaultValue={state.query ?? ""} maxLength={100} required
                style={{ minHeight: 44, padding: "0 12px", border: "1px solid var(--public-line)", background: "transparent", color: "var(--public-text)", fontFamily: "var(--font-mono, monospace)", width: "100%" }} />
            </label>
            <button type="submit" className="mono"
              style={{ minHeight: 44, padding: "0 16px", border: "1px solid var(--public-line)", background: "transparent", color: "var(--public-text)", fontSize: 11, letterSpacing: "0.08em", cursor: "pointer" }}>
              CHECK WALLET
            </button>
          </form>
          {state.result ? <div data-testid="airdrop-result" aria-live="polite" style={panel}>
            <LookupResult result={state.result} block={state.snapshot.block} phase={state.claim.phase} />
          </div> : null}
          <p>You can check an address without connecting a wallet. <strong>To make a claim</strong>, follow the verified Sablier link shown here and connect the eligible wallet there.</p>
          <h3>Claim your allocation</h3>
          <p>If you&apos;re eligible, you&apos;ll be able to claim during the published claim window.</p>
          {state.claim.href ? <p data-testid="airdrop-claim-link"><ExternalLink href={state.claim.href}>CLAIM THROUGH SABLIER</ExternalLink></p> : null}
          {state.claim.opensAt && state.claim.closesAt ? <p data-testid="airdrop-claim-window">
            <strong>Claim window:</strong> {formatUtcInstant(state.claim.opensAt)} to {formatUtcInstant(state.claim.closesAt)}
          </p> : null}
          <p><strong>Fees:</strong> Claimants pay the applicable Sablier claim fee and network transaction cost. Check the amounts shown before confirming.</p>
        </section>
        <section aria-labelledby="airdrop-facts-title" style={{ borderTop: "1px solid var(--public-line)", padding: "2rem 0" }}>
          <h2 id="airdrop-facts-title">The published snapshot</h2>
          <p>The snapshot records the wallets and balances used to calculate eligibility. It has already taken place; buying or receiving $HermesOS after the snapshot does not change your allocation.</p>
          <p data-testid="airdrop-snapshot-block"><strong>Snapshot block:</strong> {formatWholeNumber(state.snapshot.block)}</p>
          <p><ExternalLink href={state.snapshot.url}>VIEW THE PUBLISHED SNAPSHOT</ExternalLink></p>
          {state.counts ? <div data-testid="airdrop-totals">
            <p style={{ marginBottom: 0 }}><strong>Eligible wallets:</strong> {formatWholeNumber(state.counts.holders)}</p>
            <p style={{ marginBottom: 0 }}><strong>Total $HIVRA allocated:</strong> {formatHivraAmount(state.counts.includedWei)} $HIVRA</p>
            <p><strong>Percentage of supply:</strong> {state.counts.percentOfSupply}% (rounded up)</p>
          </div> : null}
          <p>The published eligibility data should also explain exclusions, including liquidity pools, launch contracts and the founder&apos;s wallet, where applicable.</p>
          <p>Wallets that Hivra manages for a user, such as lock wallets and agent wallets, are handled separately.</p>
        </section>
        <section aria-labelledby="claim-safely-title" style={{ borderTop: "1px solid var(--public-line)", padding: "2rem 0" }}>
          <h2 id="claim-safely-title">Claim safely</h2>
          <p>There may be fake $HIVRA tokens, sites and messages that look convincing. A legitimate claim will still require you to approve a transaction, so <strong>don&apos;t treat every wallet-connection request as a scam or every transaction as safe</strong>. Check that you&apos;re using the official Sablier campaign linked from this page, and read what your wallet is asking you to approve.</p>
          <ul>
            <li>Start from <strong>hivra.cloud/token</strong> or this claim page, not a link sent to you in a DM.</li>
            <li>Confirm you&apos;re on the verified Sablier campaign before connecting your wallet.</li>
            <li>Check the displayed transaction and fees. Never share your seed phrase or private key.</li>
            <li>You do <strong>not</strong> need to buy more $HermesOS, send it to someone, or burn it to qualify for your existing snapshot allocation.</li>
          </ul>
          <p><Link className="mono" style={linkLabel} href="/token">VERIFY OFFICIAL TOKEN CONTRACTS</Link></p>
          {state.migrationHref ? <p><Link className="mono" style={linkLabel} href={state.migrationHref}>READ THE FULL MIGRATION DETAILS</Link></p> : null}
        </section>
      </>}
    </main>
  </PublicSite>;
}
