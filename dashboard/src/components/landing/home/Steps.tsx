import { STEPS } from "./content";
import styles from "./home.module.css";
import { glossify } from "@/components/gloss/glossify";

/** Sign-up to a working agent in three steps. Plain server HTML, nothing hidden behind motion. */
export default function Steps() {
  return (
    <section id="how" className={styles.steps} aria-labelledby="steps-heading">
      <header className={styles.sectionHead}>
        <h2 id="steps-heading" className={styles.sectionTitle}>
          {STEPS.title} <em>{STEPS.titleTail}</em>
        </h2>
      </header>
      <ol className={styles.stepList}>
        {STEPS.steps.map(step => (
          <li key={step.n} className={styles.step}>
            <span className={styles.stepNumber} aria-hidden="true">{step.n}</span>
            <h3>{step.title}</h3>
            <p>{glossify(step.body)}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
