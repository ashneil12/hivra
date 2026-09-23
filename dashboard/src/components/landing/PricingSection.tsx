import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { HOSTED_MACHINES } from "@/lib/subscription/hosted-ladder";
import styles from "./pricing.module.css";

// The ladder data lives in lib/subscription/hosted-ladder.ts so the billing
// page's "planned sizes" strip reads the same numbers as this public preview.
export { HOSTED_MACHINES };

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
          <div><dt>Windows</dt><dd>{plan.windows ? "Planned" : "Not included"}</dd></div>
          <div><dt>Support</dt><dd>{plan.support}</dd></div>
        </dl>
        <p className={styles.description}>{plan.body}</p>
        <Link className={styles.cardAction} href="/dashboard/infrastructure" aria-label={`View hosted options for ${plan.name}`}>View hosted options<ArrowRight size={16} aria-hidden="true" /></Link>
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
