import { ArrowRight, ArrowUpRight } from "lucide-react";
import styles from "./founder-tokenomics.module.css";

const USES = [
  { name: "Compute and software", text: "Metered runtime, storage, extra cores and egress. Prebuilt operator packs, reserved capacity, and access to Nibbii alongside compute." },
  { name: "Work that improves security", text: "Containment bounties, verified threat reports and paid reviews. Certification bonds back a specific claim with collateral; nothing accrues just for holding it." },
  { name: "Builders and useful methods", text: "Pay the people publishing and maintaining tools on Exchange. Buy experience packages with the method, evidence and limits included for review." },
  { name: "Budgets with boundaries", text: "Fund missions against accepted evidence. Give an agent a capped, revocable allowance. Delegating work must never multiply the money available." },
] as const;

export default function TokenomicsSection() {
  return <section id="tokenomics" className={styles.economy} aria-labelledby="tokenomics-heading">
    <header className={styles.economyHeading}>
      <div><span className={styles.eyebrow}>The economy</span><h2 id="tokenomics-heading">Pay for useful work.<br />{" "}<em>Keep the terms clear.</em></h2></div>
      <div><p>A token already provides access to compute. The next question is how it can pay for software people use, findings they can verify, and work they can check.</p><a className={styles.textLink} href="/docs/litepaper/index.html#economy" target="_blank" rel="noopener noreferrer">Read the full tokenomics<ArrowUpRight size={20} aria-hidden="true" /></a></div>
    </header>

    <div className={styles.accessMigration}>
      <article className={styles.access}>
        <span className={styles.eyebrow}>Existing access</span>
        <h3>A fixed quantity.<br />{" "}A choice to keep.</h3>
        <p>Existing $HermesOS holders can qualify for compute. The required token quantity is fixed at deposit, so a market price fall does not raise the amount needed for that tier. You still need to maintain the qualifying balance.</p>
        <p>Ordinary payment methods remain available. Self-hosting requires neither the token nor a Hivra account.</p>
      </article>
      <article className={styles.migration}>
        <span className={styles.eyebrow}>Proposed migration</span>
        <h3>Keeping access and converting tokens are separate decisions.</h3>
        <p>The proposal is a Hivra token on Base, launched through Bankr. An active claim would sell old tokens into their pool and use the ETH proceeds to buy Hivra in the new pool.</p>
        <ol className={styles.claimFlow} aria-label="Proposed claim flow"><li><span>01</span>Old tokens</li><li aria-hidden="true"><ArrowRight size={19} /></li><li><span>02</span>ETH proceeds</li><li aria-hidden="true"><ArrowRight size={19} /></li><li><span>03</span>Hivra tokens</li></ol>
        <p>The plan preserves existing access without forced conversion or a claim deadline. Eligibility, the conversion rate, fees and protection against price movement will be published with the final terms before claims open.</p>
      </article>
    </div>

    <div className={styles.proposalNote}><span>What comes next</span><p>The migration, new uses and treasury plans are proposals. Their final terms get published before they take effect.</p></div>
    <div className={styles.uses}>{USES.map(({ name, text }, index) => <article key={name}><span>{String(index + 1).padStart(2, "0")}</span><h3>{name}</h3><p>{text}</p></article>)}</div>

    <div className={styles.treasury}>
      <div><span className={styles.eyebrow}>The proposed treasury</span><h3>An operating fund.<br />{" "}Its job is to spend.</h3></div>
      <div><p>Trading fees and platform revenue would fund maintenance, independent audits, sponsored compute and security bounties. Contributors choose stablecoin or Hivra at equivalent value.</p><p>The treasury would sell to cover commitments and buy when its working balance needs replenishing. Purchases, sales and payments would all be published, with what they funded. Treasury tokens circulate again; they are not burned.</p><p>No price target, holder payout or claim on revenue. No fixed share of revenue committed to buying tokens.</p></div>
    </div>
    <div className={styles.rules}><span>No staking or yield.</span><span>No company ownership.</span><span>No buying extra authority.</span></div>
    <div className={styles.economyEnding}><p>Supply, any founder allocation and its vesting remain to be settled and published before launch.</p><a className={styles.textLink} href="/TOKENOMICS.md" target="_blank" rel="noopener noreferrer">Read the tokenomics document<ArrowUpRight size={20} aria-hidden="true" /></a></div>
  </section>;
}
