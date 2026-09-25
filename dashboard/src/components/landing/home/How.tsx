import { ArrowRight } from "lucide-react";
import HowScene from "./HowScene";
import { AGENT_LAUNCH_HREF, HOW } from "./content";
import styles from "./home.module.css";

export default function How() {
  return (
    <section id="workspace" className={styles.how} aria-labelledby="how-heading">
      <header className={styles.sectionHead}>
        <span className={styles.eyebrow}>{HOW.eyebrow}</span>
        <h2 id="how-heading" className={styles.sectionTitle}>
          {HOW.title} <em>{HOW.titleTail}</em>
        </h2>
      </header>
      <HowScene copy={HOW} />
      <div className={styles.sectionActions}>
        <a href={AGENT_LAUNCH_HREF} className={styles.primaryCta} data-cta="how-primary">
          <span>Launch an agent</span>
          <ArrowRight size={18} aria-hidden="true" />
        </a>
        <a href="#pricing" className={styles.textCta}>
          See pricing
          <ArrowRight size={16} aria-hidden="true" />
        </a>
      </div>
    </section>
  );
}
