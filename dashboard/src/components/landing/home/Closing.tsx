import { ArrowRight } from "lucide-react";
import MotionSwitch from "./MotionSwitch";
import { AGENT_LAUNCH_HREF, CLOSING } from "./content";
import styles from "./home.module.css";

/** The page ends on one ask. */
export default function Closing() {
  return (
    <section id="start" className={styles.closing} aria-labelledby="closing-heading">
      <div className={styles.closingCopy}>
        <h2 id="closing-heading" className={styles.closingTitle}>{CLOSING.title}</h2>
        {CLOSING.paragraphs.map(text => <p key={text} className={styles.bodyText}>{text}</p>)}
        <div className={styles.heroActions}>
          <a href={AGENT_LAUNCH_HREF} className={styles.primaryCta} data-cta="closing-primary">
            <span>{CLOSING.primary}</span>
            <ArrowRight size={18} aria-hidden="true" />
          </a>
          <a href={CLOSING.secondaryHref} className={styles.textCta} data-cta="closing-secondary">
            {CLOSING.secondary}
            <ArrowRight size={16} aria-hidden="true" />
          </a>
        </div>
        <MotionSwitch />
      </div>
    </section>
  );
}
