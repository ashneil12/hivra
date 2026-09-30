import { Plus } from "lucide-react";
import { HOMEPAGE_FAQ } from "./content";
import styles from "./home.module.css";

/** Native disclosure: works without script, animates where the browser can. */
export default function Faq() {
  return (
    <section id="faq" className={styles.faq} aria-labelledby="faq-heading">
      <header className={styles.faqHead}>
        <span className={styles.eyebrow}>Questions</span>
        <h2 id="faq-heading" className={styles.sectionTitle}>Straight answers.</h2>
      </header>
      <div className={styles.faqList}>
        {HOMEPAGE_FAQ.map(({ q, a }, index) => (
          <details key={q} className={styles.faqItem} open={index === 0}>
            <summary>
              <h3>{q}</h3>
              <Plus size={20} aria-hidden="true" />
            </summary>
            <p>{a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
