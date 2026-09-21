import Link from "next/link";
import { ArrowRight } from "lucide-react";
import styles from "./pricing.module.css";

// Owner-approved relaunch offer. This is public-site copy, not the billing or
// allocation contract. Managed capacity and billing require separate acceptance.
export const HOSTED_MACHINES = [
  { name: "Starter", price: "$9.99", ram: "4 GB", cpu: "2", storage: "40 GB", computers: "1", windows: false, support: "Standard", body: "One machine, always awake. Enough for an agent that works while you don't." },
  { name: "Pro", price: "$19.99", ram: "8 GB", cpu: "4", storage: "160 GB", computers: "3", windows: true, support: "Standard", body: "Three machines means the coding agent, the research agent and the half-finished experiment all get their own room.", popular: true },
  { name: "Studio", price: "$49", ram: "16 GB", cpu: "8", storage: "320 GB", computers: "Unlimited", windows: true, support: "Priority", body: "Spin one up for a project on Monday. Delete it on Friday. Nobody has to order hardware." },
  { name: "Max", price: "$99", ram: "32 GB", cpu: "12", storage: "640 GB", computers: "Unlimited", windows: true, support: "Priority", body: "For when the job is genuinely big." },
] as const;

export default function PricingSection() {
  return <section id="pricing" className={styles.pricing} aria-labelledby="pricing-heading">
    <header className={styles.heading}>
      <span className={styles.eyebrow}>Pricing preview</span>
      <h2 id="pricing-heading">Pick a size.<span>Use it how you like.</span></h2>
      <p>Self-host for free on your own infrastructure. Hosted prices, resources and benefits below are proposed and are not yet available as shown.</p>
    </header>
    <div id="hosted-machines" className={styles.ladder} aria-label="Free self-hosting and hosted plans">
      <article className={`${styles.machine} ${styles.freeMachine}`} aria-labelledby="plan-free">
        <div className={styles.machineTop}><h3 id="plan-free">Free</h3><span>Self-hosted</span></div>
        <p className={styles.machinePrice}><strong>$0</strong><span>software</span></p>
        <p className={styles.freeLead}>Bring your own infrastructure.</p>
        <p className={styles.description}>Run the full platform on your own hardware or cloud. No token and no Hivra account required.</p>
        <p className={styles.freeCosts}>You provide and maintain the server. Hosting and model-provider usage are paid separately.</p>
        <a className={styles.action} href="/docs/litepaper/index.html#platform" target="_blank" rel="noopener noreferrer">Explore self-hosting<ArrowRight size={18} aria-hidden="true" /></a>
      </article>
      {HOSTED_MACHINES.map(plan => <article key={plan.name} className={styles.machine} data-popular={"popular" in plan} aria-labelledby={`plan-${plan.name.toLowerCase()}`}>
        <div className={styles.machineTop}><h3 id={`plan-${plan.name.toLowerCase()}`}>{plan.name}</h3>{"popular" in plan && <span>Most popular</span>}</div>
        <p className={styles.machinePrice}><strong>{plan.price}</strong><span>/mo</span></p>
        <dl className={styles.machineSpecs}>
          <div><dt>RAM</dt><dd>{plan.ram}</dd></div>
          <div><dt>vCPU</dt><dd>{plan.cpu}</dd></div>
          <div><dt>Storage</dt><dd>{plan.storage}</dd></div>
          <div><dt>Computers</dt><dd>{plan.computers}</dd></div>
          <div><dt>Windows</dt><dd>{plan.windows ? "Yes" : "Not included"}</dd></div>
          <div><dt>Support</dt><dd>{plan.support}</dd></div>
        </dl>
        <p className={styles.description}>{plan.body}</p>
      </article>)}
    </div>
    <div className={styles.purchaseRow}>
      <div className={styles.notes}>
        <p>Snapshots and clones on every hosted plan. Bring your own model key and we add nothing to what you spend.</p>
        <p>Annual billing: two months free.</p>
      </div>
      <Link className={styles.action} href="/dashboard/infrastructure">View hosted options<ArrowRight size={18} aria-hidden="true" /></Link>
    </div>
  </section>;
}
