import ReachScene from "./ReachScene";
import { REACH } from "./content";
import styles from "./home.module.css";

/**
 * The problem, told in two parts. The argument (whose computer an agent uses)
 * is ordinary page text, laid out for reading. Under it, the scene shows the
 * same argument as a picture and stays pinned beside its short text.
 */
export default function Reach() {
  const { intro } = REACH;
  return (
    <section id="why" className={styles.reach} aria-labelledby="why-heading">
      <div className={styles.reachIntro}>
        <div className={styles.reachIntroHead}>
          <span className={styles.eyebrow} aria-hidden="true" />
          <h2 id="why-heading" className={styles.sectionTitle}>
            {intro.title} <em>{intro.tail}</em>
          </h2>
        </div>
        <div className={styles.reachProse}>
          {intro.body.map(paragraph => <p key={paragraph} className={styles.bodyText}>{paragraph}</p>)}
          <p className={styles.reachKicker}>{intro.pull}</p>
        </div>
      </div>
      <ReachScene copy={REACH} />
    </section>
  );
}
