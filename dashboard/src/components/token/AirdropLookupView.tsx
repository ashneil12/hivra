import Link from "next/link";
import type { CSSProperties } from "react";

import PublicSite from "@/components/public-site/PublicSite";
import type { AirdropSnapshot } from "@/lib/claim/conversion-state";
import { formatHivraAmount, type AirdropLookupResult } from "@/lib/claim/hivra-airdrop-lookup";
import { RESTRICTED_TOKEN_PAGE_COPY } from "@/lib/token-phase-copy";
import { tokenVerificationContent } from "@/lib/token-verification-content";

import styles from "./TokenFacts.module.css";
import { TokenGeoNotice } from "./TokenGeoNotice";

export type AirdropLookupViewState =
  | { kind: "blocked"; notice: string }
  | {
      kind: "open";
      snapshot: AirdropSnapshot;
      senderAddress: string | null;
      totals: { holders: number; includedWei: string; percentOfSupply: string };
      /** What the viewer submitted, as typed; null before a lookup. */
      query: string | null;
      result: AirdropLookupResult | null;
    };

const panel: CSSProperties = { margin: "1.5rem 0", padding: "1.25rem", border: "1px solid var(--public-line)" };
const muted: CSSProperties = { color: "var(--public-muted)" };

function Amount({ wei }: { wei: string }) {
  return <p data-testid="airdrop-amount" style={{ fontSize: "clamp(1.6rem, 4vw, 2.2rem)", fontWeight: 600, margin: "0 0 0.5rem", overflowWrap: "anywhere" }}>
    {formatHivraAmount(wei)} $HIVRA
  </p>;
}

function WalletLine({ address }: { address: string }) {
  return <p style={muted}>Wallet <code style={{ overflowWrap: "anywhere" }}>{address}</code></p>;
}

function LookupResult({ result, block }: { result: AirdropLookupResult; block: number }) {
  switch (result.kind) {
    case "invalid":
      return <p>That is not a wallet address. A Base address starts with 0x followed by 40 letters and numbers.</p>;
    case "holder":
      return <>
        <Amount wei={result.amountWei} />
        <WalletLine address={result.address} />
        {result.sentTx
          ? <p>Sent.{" "}
              <a href={`https://basescan.org/tx/${result.sentTx}`} target="_blank" rel="noopener noreferrer">View the transfer on BaseScan</a>
            </p>
          : <p>Not sent yet. Transfers go out in batches from Hivra&apos;s airdrop wallet. Check back after the airdrop.</p>}
      </>;
    case "managed":
      return <>
        <Amount wei={result.amountWei} />
        <WalletLine address={result.address} />
        <p>{result.sent ? "Hivra-managed wallet: sent to the owner." : "Hivra-managed wallet: it will be sent to the owner."}</p>
      </>;
    case "excluded":
      return <>
        <p><strong>Not in the snapshot airdrop.</strong></p>
        <WalletLine address={result.address} />
        <p>This wallet is left out: {result.label}.</p>
      </>;
    case "absent":
      return <>
        <p><strong>Not in the snapshot.</strong></p>
        <WalletLine address={result.address} />
        <p>This wallet held no $HermesOS at Base block {block}.</p>
      </>;
  }
}

/**
 * /token/airdrop. Rendered on the server for one request: a viewer the token
 * geo-policy blocks gets the notice and a link to the contracts, never an
 * amount, a total or the lookup form.
 */
export default function AirdropLookupView({ state }: { state: AirdropLookupViewState }) {
  const { riskLine } = tokenVerificationContent;
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
          <p className="mono" style={{ color: "var(--public-accent)", fontSize: 11 }}>HOLDER AIRDROP</p>
          <h1 style={{ fontSize: "clamp(2.8rem, 7vw, 5rem)", lineHeight: 1.05, margin: "1rem 0" }}>Check a wallet</h1>
          <p style={{ fontSize: "1.2rem", ...muted }}>
            Wallets that held $HermesOS at Base block {state.snapshot.block} are sent $HIVRA one for one. There is nothing to claim and nothing to connect. Paste a wallet address to see what it is sent.
          </p>
          <p data-testid="token-risk-line" style={muted}>{riskLine}</p>
        </header>
        <section aria-labelledby="lookup-title" style={{ borderTop: "1px solid var(--public-line)", padding: "2rem 0" }}>
          <h2 id="lookup-title">Look up a wallet</h2>
          <form method="get" action="/token/airdrop" role="search" style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
            <label htmlFor="airdrop-address" style={{ display: "flex", flexDirection: "column", gap: 6, flex: "1 1 320px", minWidth: 0 }}>
              <span className="mono" style={{ fontSize: 11 }}>WALLET ADDRESS</span>
              <input id="airdrop-address" name="address" type="text" inputMode="text" autoComplete="off" spellCheck={false}
                placeholder="0x..." defaultValue={state.query ?? ""} maxLength={100} required
                style={{ minHeight: 44, padding: "0 12px", border: "1px solid var(--public-line)", background: "transparent", color: "var(--public-text)", fontFamily: "var(--font-mono, monospace)", width: "100%" }} />
            </label>
            <button type="submit" className="mono"
              style={{ minHeight: 44, padding: "0 16px", border: "1px solid var(--public-line)", background: "transparent", color: "var(--public-text)", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer" }}>
              Check wallet
            </button>
          </form>
          {state.result ? <div data-testid="airdrop-result" aria-live="polite" style={panel}>
            <LookupResult result={state.result} block={state.snapshot.block} />
          </div> : null}
          <p><strong>Hivra never asks you to connect a wallet, sign a message or approve a transaction to receive the airdrop.</strong> Anyone who asks is not Hivra.</p>
        </section>
        <section aria-labelledby="airdrop-facts-title" style={{ borderTop: "1px solid var(--public-line)", padding: "2rem 0" }}>
          <h2 id="airdrop-facts-title">The published snapshot</h2>
          <p data-testid="airdrop-totals">
            {state.totals.holders.toLocaleString("en-GB")} wallets are sent {formatHivraAmount(state.totals.includedWei)} $HIVRA in total, {state.totals.percentOfSupply}% of the 100 billion supply (rounded up).
          </p>
          <p>
            Snapshot block:{" "}
            <a href={`https://basescan.org/block/${state.snapshot.block}`} target="_blank" rel="noopener noreferrer">{state.snapshot.block}</a>.{" "}
            <a href={state.snapshot.url} target="_blank" rel="noopener noreferrer">Open the published snapshot</a>
          </p>
          {state.senderAddress ? <p>
            The transfers come from Hivra&apos;s airdrop wallet:{" "}
            <code style={{ overflowWrap: "anywhere" }}>{state.senderAddress}</code>{" "}
            <a href={`https://basescan.org/address/${state.senderAddress}`} target="_blank" rel="noopener noreferrer">View on BaseScan</a>
          </p> : null}
          <p style={muted}>Hivra-managed wallets are sent to their owners&apos; own wallets, so the list shows only the snapshot address and amount for them. Wallets left out, such as pools and launch contracts, are listed with the reason.</p>
          <p><Link href="/token">Verify the token contracts</Link></p>
        </section>
      </>}
    </main>
  </PublicSite>;
}
