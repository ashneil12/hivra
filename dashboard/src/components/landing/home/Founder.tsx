import { ArrowRight } from "lucide-react";
import LitWords from "./LitWords";
import { FOUNDER } from "./content";
import styles from "./home.module.css";

export default function Founder() {
  return (
    <section id="founder" className={styles.founder} aria-labelledby="founder-heading">
      <span className={styles.founderRule} aria-hidden="true" />
      <div className={styles.founderInner}>
        <h2 id="founder-heading" className={styles.eyebrow}>{FOUNDER.eyebrow}</h2>
        <blockquote className={styles.founderQuote}>
          <LitWords lines={FOUNDER.lines} />
        </blockquote>
        <div className={styles.founderSign}>
          <span className={styles.founderMark} aria-hidden="true">A.</span>
          <span>
            <strong>{FOUNDER.name}</strong>
            <small>{FOUNDER.role}</small>
          </span>
          <a href={FOUNDER.href} className={styles.textCta}>
            {FOUNDER.link}
            <ArrowRight size={16} aria-hidden="true" />
          </a>
        </div>
      </div>
    </section>
  );
}
