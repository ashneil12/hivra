import { ArrowRight } from "lucide-react";
import ClosingArt from "./ClosingArt";
import MotionSwitch from "./MotionSwitch";
import { AGENT_LAUNCH_HREF, CLOSING, SELF_HOST_SOURCE_URL } from "./content";
import styles from "./home.module.css";

/** The page ends on one ask, with the price and the guarantee beside it. */
export default function Closing() {
  return (
    <section id="start" className={styles.closing} aria-labelledby="closing-heading">
      <ClosingArt />
      <div className={styles.closingCopy}>
        <h2 id="closing-heading" className={styles.closingTitle}>
          {CLOSING.title} <em>{CLOSING.titleTail}</em>
        </h2>
        <p className={styles.bodyText}>
          {CLOSING.body} {CLOSING.selfHostLead}{" "}
          <a href={SELF_HOST_SOURCE_URL} target="_blank" rel="noopener noreferrer">{CLOSING.selfHostLink}</a>.
        </p>
        <div className={styles.heroActions}>
          <a href={AGENT_LAUNCH_HREF} className={styles.primaryCta} data-cta="closing-primary">
            <span>{CLOSING.primary}</span>
            <ArrowRight size={18} aria-hidden="true" />
          </a>
          <a href="#computers" className={styles.textCta} data-cta="closing-secondary">
            {CLOSING.secondary}
            <ArrowRight size={16} aria-hidden="true" />
          </a>
        </div>
        <MotionSwitch />
      </div>
    </section>
  );
}
