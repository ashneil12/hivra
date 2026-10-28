"use client";

import Link from "next/link";
import styles from "./TokenFacts.module.css";
import PublicSite from "@/components/public-site/PublicSite";
import type { HivraTokenPhase } from "@/lib/billing/token-registry";
import type { TokenPageAirdropFacts } from "@/lib/claim/conversion-state";
import { DORMANT_TOKEN_PAGE_COPY, RESTRICTED_TOKEN_PAGE_COPY } from "@/lib/token-phase-copy";
import {
  tokenPhaseFromEntries,
  tokenVerificationContent,
  type TokenPageEntry,
  type TokenPageEntryStatus,
} from "@/lib/token-verification-content";
import { CopyAddressButton } from "./CopyAddressButton";
import { TokenGeoNotice } from "./TokenGeoNotice";
import TokenLaunchedView from "./TokenLaunchedView";
import PrelaunchSections from "./PrelaunchSections";

const STATUS_LABEL: Record<TokenPageEntryStatus, string> = {
  live: "LIVE",
  legacy: "LEGACY",
  // $HIVRA is on Base. Whether Hivra's token access and payments use it is a separate switch (see Billing).
  scheduled: "LIVE ON BASE",
  not_launched: "NOT LAUNCHED YET",
};

// Once $HIVRA is on Base, no note says new accounts use it or when Hivra starts to: new $HIVRA-based
// access and payments appear in Billing only when their own published conditions are met.
const ENTRY_NOTE: Record<"hermesos" | "hivra", Record<TokenPageEntryStatus, string>> = {
  hermesos: {
    live: "The existing $HermesOS contract. $HIVRA has not launched.",
    legacy: "The legacy $HermesOS contract. Accounts that used it before $HIVRA launched can keep using it.",
    scheduled: "The existing $HermesOS contract.",
    not_launched: "The existing $HermesOS contract.",
  },
  hivra: {
    live: "The $HIVRA contract.",
    legacy: "The $HIVRA contract.",
    scheduled: "The $HIVRA contract.",
    not_launched: "",
  },
};

/** The note under a listed contract. */
function entryNote(entry: TokenPageEntry, phase: HivraTokenPhase): string {
  // $HIVRA is on Base but not necessarily in use yet: never say "$HIVRA has not launched".
  if (phase === "scheduled" && entry.key === "hermesos") return ENTRY_NOTE.hermesos.scheduled;
  return ENTRY_NOTE[entry.key][entry.status];
}

/**
 * `entries` are computed on the server at render, so the markup never depends on the viewer's clock;
 * the $HIVRA phase, and with it the phase-dependent copy, is read from them.
 * `geoNotice` is set only when the token geo-policy blocks this viewer: the page then keeps the
 * factual contract, official account and access sections, adds the notice, and drops the proposals.
 *
 * Once $HIVRA is launched (scheduled or active), a viewer the geo-policy does not block reads
 * Ash's website pack page (TokenLaunchedView). The layout below is the dormant page, and the
 * page a blocked viewer reads in every phase; only the note under a launched contract changed,
 * which no longer says new accounts use $HIVRA.
 */
export default function TokenPageClient({
  entries,
  geoNotice = null,
  airdropFacts = null,
  airdropLookupHref = null,
  migrationHref = null,
  receiptsHref = null,
  tokenSurfaces,
}: {
  entries: TokenPageEntry[];
  geoNotice?: string | null;
  /** The published snapshot and Airdrop wallet, set by the server once $HIVRA is launched and the viewer is not blocked. */
  airdropFacts?: TokenPageAirdropFacts | null;
  /** /token/airdrop, set by the server only when that lookup is served and the viewer is not blocked. */
  airdropLookupHref?: string | null;
  /** /token/migration, set by the server only when that page is served and the viewer is not blocked. */
  migrationHref?: string | null;
  /** /token/receipts, set by the server only when that page is served and the viewer is not blocked. */
  receiptsHref?: string | null;
  /**
   * HIVRA_NEW_TOKEN_SURFACES as the server read it. The switch is server-only, so
   * a client render that is left to read it sees "off": the header would drop the
   * litepaper link the server rendered and React would report a hydration mismatch.
   */
  tokenSurfaces?: boolean;
}) {
  const phase = tokenPhaseFromEntries(entries);
  if (phase !== "dormant" && !geoNotice) {
    return <TokenLaunchedView entries={entries} airdropFacts={airdropFacts} airdropLookupHref={airdropLookupHref} migrationHref={migrationHref} receiptsHref={receiptsHref} tokenSurfaces={tokenSurfaces} />;
  }
  // Reached only while $HIVRA is dormant, or by a blocked viewer, who reads none of
  // the phase copy below (the restricted copy replaces it and the prelaunch sections are dropped).
  const phaseCopy = DORMANT_TOKEN_PAGE_COPY;
  // A blocked viewer reads the contracts and the access they already have, not the
  // status, proposal or qualify-for-compute lines (RESTRICTED_TOKEN_PAGE_COPY).
  const restricted = geoNotice ? RESTRICTED_TOKEN_PAGE_COPY : null;
  const copy = { ...phaseCopy, heroTitle: restricted?.heroTitle ?? phaseCopy.heroTitle, heroLead: restricted?.heroLead ?? phaseCopy.heroLead };
  const { officialAccounts, noTelegram, lookalikeWarning, riskLine } = tokenVerificationContent;
  return <PublicSite tokenSurfaces={tokenSurfaces}>
    <main className={styles.content} id="main-content" style={{ maxWidth: 1000, margin: "0 auto", padding: "clamp(3rem, 8vw, 7rem) var(--public-gutter)", lineHeight: 1.7 }}>
      <Link href="/ecosystem">Ecosystem</Link>
      <header style={{ margin: "2rem 0 3rem", maxWidth: 760 }}>
        <p className="mono" style={{ color: "var(--public-accent)", fontSize: 11 }}>{restricted ? restricted.eyebrow : "OPTIONAL TOKEN"}</p>
        <h1 style={{ fontSize: "clamp(2.8rem, 7vw, 5rem)", lineHeight: 1.05, margin: "1rem 0" }}>{copy.heroTitle}</h1>
        <p style={{ fontSize: "1.2rem", color: "var(--public-muted)" }}>{copy.heroLead}</p>
        <p data-testid="token-risk-line" style={{ color: "var(--public-muted)" }}>{riskLine}</p>
      </header>
      {geoNotice ? <TokenGeoNotice notice={geoNotice} /> : null}
      <section id="verify" aria-labelledby="verify-title" style={{ borderTop: "1px solid var(--public-line)", padding: "2rem 0" }}>
        <h2 id="verify-title">Verify the token contracts</h2>
        <p>Hivra has two platform tokens on Base. Compare the full contract address before using either.</p>
        {entries.map((entry) => (
          <div key={entry.key} data-token={entry.key} style={{ margin: "1.5rem 0" }}>
            <h3 style={{ marginBottom: "0.5rem" }}>
              {entry.label}{" "}
              <span className="mono" style={{ fontSize: 11, color: "var(--public-muted)" }}>{STATUS_LABEL[entry.status]}</span>
            </h3>
            {entry.contractAddress ? (
              <>
                <code style={{ display: "block", overflowWrap: "anywhere", padding: "1rem", border: "1px solid var(--public-line)" }}>{entry.contractAddress}</code>
                <CopyAddressButton value={entry.contractAddress} />
                <p>
                  <a href={entry.basescanUrl ?? undefined} target="_blank" rel="noopener noreferrer">
                    {entry.key === "hermesos" ? "View the contract on BaseScan" : "View the $HIVRA contract on BaseScan"}
                  </a>
                </p>
                <p style={{ color: "var(--public-muted)" }}>{entryNote(entry, phase)}</p>
              </>
            ) : (
              <p style={{ color: "var(--public-muted)" }}>
                Not launched yet. There is no $HIVRA contract yet. Any $HIVRA address shown to you before it appears here is not Hivra&apos;s.
              </p>
            )}
          </div>
        ))}
        <p data-testid="token-lookalike-warning"><strong>{lookalikeWarning}</strong></p>
        <p><strong>Hivra never confirms contract addresses in DMs or private messages.</strong> This page is the only place Hivra publishes them.</p>
      </section>
      <section id="official-accounts" aria-labelledby="official-accounts-title" style={{ borderTop: "1px solid var(--public-line)", padding: "2rem 0" }}>
        <h2 id="official-accounts-title">Official accounts</h2>
        <p>These are Hivra&apos;s official accounts. Compare the handle before you trust a post or a message.</p>
        <ul>
          {officialAccounts.map((account) => (
            <li key={account.service}>
              {account.service}:{" "}
              <a href={account.href} target="_blank" rel="noopener noreferrer">{account.handle}</a>
            </li>
          ))}
        </ul>
        <p><strong>{noTelegram}</strong></p>
      </section>
      <section id="live-now" aria-labelledby="access-title" style={{ borderTop: "1px solid var(--public-line)", padding: "2rem 0" }}>
        <p className="mono" style={{ fontSize: 11 }}>CURRENT ACCESS</p>
        <h2 id="access-title">Existing holder access</h2>
        {restricted
          ? <p>{restricted.accessParagraph}</p>
          : <p>{phaseCopy.accessParagraph}</p>}
        <p>Open Billing to check your plan or manage an existing entitlement. Connecting a wallet is an optional action; ordinary card billing does not require one.</p>
        <Link href="/dashboard/billing">Open Billing</Link>
        <p style={{ color: "var(--public-muted)" }}>Self-hosting requires neither a token nor a Hivra account. A token balance never grants wider permissions on a computer or access to another person’s credentials.</p>
      </section>
      {/* Reached by an unblocked viewer only while $HIVRA is dormant: the planned launch facts (token-launch-status.ts). */}
      {geoNotice ? null : <PrelaunchSections />}
    </main>
  </PublicSite>;
}
