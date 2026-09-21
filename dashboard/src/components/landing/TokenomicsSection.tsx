import { ArrowRight, ArrowUpRight } from "lucide-react";
import styles from "./founder-tokenomics.module.css";

const TOKEN_USES = [
  { title: "Computers and Nibbii", body: <>The plan brings compute and <a href="https://nibbii.pet/" target="_blank" rel="noopener noreferrer">Nibbii</a> access under one token. You can still pay normally for either product.</> },
  { title: "Tools and useful work", body: <>Pay for operator packs, published tools and work from other agents. Give an agent a budget you can cap and revoke.</> },
  { title: "Security worth testing", body: <>Fund containment bounties, verified threat reports and independent reviews. Pay for findings people can reproduce.</> },
] as const;

export default function TokenomicsSection() {
  return <section id="tokenomics" className={`${styles.economy} ${styles.homeEconomy}`} aria-labelledby="tokenomics-heading">
    <header className={styles.economyHeading}>
      <div><span className={styles.eyebrow}>The Hivra token</span><h2 id="tokenomics-heading">$HIVRA</h2></div>
      <p>The proposed token for Hivra. Access to computers and software, payments for useful work, and funding for the people testing how safe it is.</p>
    </header>
    <div className={styles.tokenTransition}>
      <div className={styles.tokenNames} aria-label="Proposed transition from HermesOS to Hivra">
        <div><span>Existing token</span><strong>$HermesOS</strong></div><ArrowRight size={28} aria-hidden="true" /><div><span>Proposed token</span><strong>$HIVRA</strong></div>
      </div>
      <div><h3>What happened to HermesOS?</h3>
        <p>HermesOS is becoming Hivra as the platform grows beyond a single agent. The proposed token migration is a separate, optional choice.</p>
        <p>Existing $HermesOS holders keep their qualifying compute access. The required quantity is fixed at deposit, so a price fall doesn&apos;t raise it. You still need to maintain that balance.</p>
        <p>No forced conversion or claim deadline is planned. Eligibility and the final claim terms will be published before migration opens.</p>
      </div>
    </div>
    <div className={styles.tokenUtilityHeading}><h3>What $HIVRA is being built for</h3><span>Proposed uses</span></div>
    <div className={styles.homeTokenUses}>{TOKEN_USES.map((use,index)=><article key={use.title}><span>{String(index+1).padStart(2,"0")}</span><h4>{use.title}</h4><p>{use.body}</p></article>)}</div>
    <div className={styles.tokenReading}>
      <p>Card payments remain available. Self-hosting needs no token and no Hivra account. The migration and new uses are proposals, with final terms published before they take effect.</p>
      <div><a className={styles.textLink} href="/tokenomics" target="_blank" rel="noopener noreferrer">Read the tokenomics<ArrowUpRight size={20} aria-hidden="true" /></a><a className={styles.textLink} href="/docs/litepaper/index.html#economy" target="_blank" rel="noopener noreferrer">Read the Litepaper<ArrowUpRight size={20} aria-hidden="true" /></a></div>
    </div>
  </section>;
}
