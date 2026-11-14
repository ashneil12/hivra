import { ArrowUpRight } from "lucide-react";
import { TokenGeoNotice } from "@/components/token/TokenGeoNotice";
import { getHivraTokenPhase, type HivraTokenPhase } from "@/lib/billing/token-registry";
import TokenomicsLaunchedView from "@/components/token/TokenomicsLaunchedView";
import { DORMANT_TOKENOMICS_COPY, RESTRICTED_TOKEN_PAGE_COPY } from "@/lib/token-phase-copy";
import type { TokenPageEntry } from "@/lib/token-verification-content";
import styles from "./founder-tokenomics.module.css";
import { glossify } from "@/components/gloss/glossify";
import PrelaunchSections from "@/components/token/PrelaunchSections";

/** Set only when the token geo-policy blocks this viewer. */
export type TokenomicsGeoRestriction = { notice: string; entries: TokenPageEntry[] };

/** Phase-independent, and the same idea the litepaper's economy section opens with. */
const PROJECT_LEAD = "Hivra gives an AI agent a computer of its own, so it does its work there and stays off yours. One shared token could pay for the parts around that: the computers, the security rewards, and the people who keep tools alive.";

/**
 * What a viewer the token geo-policy blocks sees instead of the economy
 * proposal: the factual contract addresses, where to verify them, and the
 * notice. No payment discount, bonus, migration, uses or treasury copy.
 */
function RestrictedTokenomicsSection({ headingLevel, restriction }: { headingLevel: 1 | 2; restriction: TokenomicsGeoRestriction }) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return <section id="tokenomics" className={styles.economy} aria-labelledby="tokenomics-heading">
    <header className={styles.economyHeading}>
      <div><span className={styles.eyebrow}>The Hivra token</span><Heading id="tokenomics-heading">Token<br /><em>contracts.</em></Heading></div>
      <div><p>{RESTRICTED_TOKEN_PAGE_COPY.tokenomicsLead}</p></div>
    </header>
    <TokenGeoNotice notice={restriction.notice} />
    <div data-testid="tokenomics-contracts">
      {restriction.entries.map((entry) => (
        <p key={entry.key}>
          <strong>{entry.label} on Base: </strong>
          {entry.contractAddress && entry.basescanUrl
            ? <><code style={{ overflowWrap: "anywhere" }}>{entry.contractAddress}</code>{" "}<a href={entry.basescanUrl} target="_blank" rel="noopener noreferrer">View on BaseScan</a></>
            : "Not launched yet. There is no contract yet."}
        </p>
      ))}
      <p><a className={styles.textLink} href="/token">Verify the token contracts<ArrowUpRight size={20} aria-hidden="true" /></a></p>
    </div>
  </section>;
}

/**
 * `phase` is the $HIVRA phase to write the copy for; the page passes the one it
 * rendered with, and it defaults to the phase now. Dormant, this is the section
 * as it was before $HIVRA launched. Once $HIVRA is launched (scheduled or
 * active), an unblocked viewer reads Ash's website pack page instead
 * (TokenomicsLaunchedView), with /token/airdrop and /token/migration linked only
 * when the server says they are served.
 */
export default function FullTokenomicsSection({
  headingLevel = 2,
  geoRestriction = null,
  phase = getHivraTokenPhase(),
  airdropLookupHref = null,
  migrationHref = null,
}: {
  headingLevel?: 1 | 2;
  geoRestriction?: TokenomicsGeoRestriction | null;
  phase?: HivraTokenPhase;
  /** /token/airdrop, set by the server only when that page is served and the viewer is not blocked. */
  airdropLookupHref?: string | null;
  /** /token/migration, set by the server only when that page is served and the viewer is not blocked. */
  migrationHref?: string | null;
} = {}) {
  if (geoRestriction) return <RestrictedTokenomicsSection headingLevel={headingLevel} restriction={geoRestriction} />;
  if (phase !== "dormant") {
    return <TokenomicsLaunchedView headingLevel={headingLevel} airdropLookupHref={airdropLookupHref} migrationHref={migrationHref} />;
  }
  const copy = DORMANT_TOKENOMICS_COPY;
  const Heading = headingLevel === 1 ? "h1" : "h2";
  // Before the launch the page shows the planned facts from token-launch-status.ts, the same as /token.
  return <section id="tokenomics" className={styles.economy} aria-labelledby="tokenomics-heading">
    <header className={styles.economyHeading}>
      <div><span className={styles.eyebrow}>The Hivra token</span><Heading id="tokenomics-heading">$HIVRA<br /><em>Tokenomics.</em></Heading></div>
      <div><p>{glossify(PROJECT_LEAD, { token: true })}</p><p>{copy.headerLead}</p><a className={styles.textLink} href="/docs/litepaper/index.html#economy" target="_blank" rel="noopener noreferrer">Read the full economy section<ArrowUpRight size={20} aria-hidden="true" /></a></div>
    </header>
    <div className={styles.accessMigration}>
      <article className={styles.access}>
        <span className={styles.eyebrow}>Existing access</span>
        <h3>A fixed quantity.<br />{" "}A choice to keep.</h3>
        <p>Existing $HermesOS holders can qualify for compute. The amount you need is fixed when your holding first qualifies. A price fall doesn&apos;t take away access you already have, as long as you keep holding it. Self-hosting Hivra requires neither the token nor a Hivra account.</p>
      </article>
    </div>
    <PrelaunchSections />
    <div className={styles.economyEnding}><p>No presale or private round. No founder allocation of new $HIVRA is planned. The final supply and contract are published once verified.</p><a className={styles.textLink} href="/TOKENOMICS.md" target="_blank" rel="noopener noreferrer">Read the tokenomics document<ArrowUpRight size={20} aria-hidden="true" /></a></div>
  </section>;
}
