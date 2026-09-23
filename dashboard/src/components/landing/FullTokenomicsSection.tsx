import { ArrowRight, ArrowUpRight } from "lucide-react";
import styles from "./founder-tokenomics.module.css";

const USES = [
  { name: "Compute and software", text: "Hold for a compute tier, fixed when you first qualify. Metered runtime, storage, extra cores and egress. Prebuilt operator packs and reserved capacity." },
  { name: "Work that improves security", text: "Containment bounties, verified threat reports and paid reviews. Certification bonds back a specific claim with collateral; nothing accrues just for holding it." },
  { name: "Builders and useful methods", text: "Pay the people publishing and maintaining tools on Exchange. Buy experience packages with the method, evidence and limits included for review." },
  { name: "Budgets with boundaries", text: "Fund missions against accepted evidence. Give an agent a capped, revocable allowance. Delegating work must never multiply the money available." },
] as const;

export default function FullTokenomicsSection({ headingLevel = 2 }: { headingLevel?: 1 | 2 } = {}) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return <section id="tokenomics" className={styles.economy} aria-labelledby="tokenomics-heading">
    <header className={styles.economyHeading}>
      <div><span className={styles.eyebrow}>The Hivra token</span><Heading id="tokenomics-heading">$HIVRA<br /><em>Tokenomics.</em></Heading></div>
      <div><p>$HermesOS is the existing token. $HIVRA is the proposed new token as HermesOS evolves into Hivra. This page explains existing compute access, the optional migration and the uses being planned.</p><a className={styles.textLink} href="/docs/litepaper/index.html#economy" target="_blank" rel="noopener noreferrer">Read the full tokenomics<ArrowUpRight size={20} aria-hidden="true" /></a></div>
    </header>

    <div className={styles.accessMigration}>
      <article className={styles.access}>
        <span className={styles.eyebrow}>Existing access</span>
        <h3>A fixed quantity.<br />{" "}A choice to keep.</h3>
        <p>Existing $HermesOS holders can qualify for compute. The amount you need is fixed when your holding first qualifies. A price fall doesn&apos;t take away access you already have, as long as you keep holding it.</p>
        <p>You can also pay through ordinary payment methods, or pay in the token, which costs less: a year of Pro is $49 in the token against $79 by card, and credit top-ups paid in the token come with bonus credits. Token payments are final. Self-hosting Hivra requires neither the token nor a Hivra account.</p>
      </article>
      <article className={styles.migration}>
        <span className={styles.eyebrow}>Proposed migration</span>
        <h3>Keeping access and converting tokens are separate decisions.</h3>
        <p>The proposal is $HIVRA on Base, launched through Bankr. An active claim would sell your old tokens into their existing pool and use the ETH proceeds to buy $HIVRA in the new pool. You&apos;d sign it from your own wallet, and Hivra never holds your tokens.</p>
        <ol className={styles.claimFlow} aria-label="Proposed claim flow"><li><span>01</span>$HermesOS</li><li aria-hidden="true"><ArrowRight size={19} /></li><li><span>02</span>ETH proceeds</li><li aria-hidden="true"><ArrowRight size={19} /></li><li><span>03</span>$HIVRA</li></ol>
        <p>Existing holders keep their access, without forced conversion or a claim deadline. The rate is a live market quote, not a fixed ratio. The fees and a maximum slippage limit get published before claims open. Once $HIVRA launches, new users hold and pay with $HIVRA.</p>
      </article>
    </div>

    <div className={styles.proposalNote}><span>What comes next</span><p>The migration, new uses and treasury plans are proposals. Their final terms get published before they take effect. Nothing here is an offer or an inducement to buy any asset.</p></div>
    <div className={styles.uses}>{USES.map(({ name, text }, index) => <article key={name}><span>{String(index + 1).padStart(2, "0")}</span><h3>{name}</h3><p>{text}</p></article>)}</div>

    <div className={styles.treasury}>
      <div><span className={styles.eyebrow}>The proposed treasury</span><h3>An operating fund.<br />{" "}Its job is to spend.</h3></div>
      <div><p>Trading fees and platform revenue would fund maintenance, independent audits, sponsored compute and security bounties. Contributors choose stablecoin or $HIVRA at equivalent value.</p><p>The treasury would sell to cover bills and contributor payments, and buy only when the $HIVRA it holds falls below what contributors have chosen to be paid in $HIVRA. Purchases, sales and payments would all be published, with what each one funded. Tokens held in the treasury aren&apos;t burned. They get paid out again.</p><p>No price target, holder payout or claim on revenue. No fixed share of revenue committed to buying tokens.</p></div>
    </div>
    <div className={styles.rules}><span>No staking or yield.</span><span>No company ownership.</span><span>No buying extra authority.</span></div>
    <div className={styles.economyEnding}><p>No presale or private round. The supply is fixed at 100 billion by the Bankr launch. Any founder allocation and its vesting get published before launch.</p><a className={styles.textLink} href="/TOKENOMICS.md" target="_blank" rel="noopener noreferrer">Read the tokenomics document<ArrowUpRight size={20} aria-hidden="true" /></a></div>
  </section>;
}
