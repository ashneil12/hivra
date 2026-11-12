import { SEPARATE } from "./content";
import styles from "./home.module.css";

/** Why the agent gets its own computer, straight under the hero. Plain server HTML. */
export default function Separate() {
  return (
    <section id="separate" className={styles.steps} aria-labelledby="separate-heading">
      <header className={styles.sectionHead}>
        <h2 id="separate-heading" className={styles.sectionTitle}>
          {SEPARATE.title} <em>{SEPARATE.titleTail}</em>
        </h2>
      </header>
      {SEPARATE.paragraphs.map(text => <p key={text} className={styles.bodyText}>{text}</p>)}
    </section>
  );
}
