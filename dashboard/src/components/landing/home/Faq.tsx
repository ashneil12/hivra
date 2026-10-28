import { Plus } from "lucide-react";
import { FAQ_TITLE, HOMEPAGE_FAQ } from "./content";
import styles from "./home.module.css";
import { glossify } from "@/components/gloss/glossify";

/**
 * Native disclosure: works without script, animates where the browser can.
 * `items` is the list the page also publishes as FAQPage JSON-LD, so the
 * visible answers and the structured ones are the same strings.
 */
export default function Faq({ items = HOMEPAGE_FAQ }: { items?: readonly { q: string; a: string }[] }) {
  return (
    <section id="faq" className={styles.faq} aria-labelledby="faq-heading">
      <header className={styles.faqHead}>
        <span className={styles.eyebrow} aria-hidden="true" />
        <h2 id="faq-heading" className={styles.sectionTitle}>{FAQ_TITLE}</h2>
      </header>
      <div className={styles.faqList}>
        {items.map(({ q, a }, index) => (
          <details key={q} className={styles.faqItem} open={index === 0}>
            <summary>
              <h3>{q}</h3>
              <Plus size={20} aria-hidden="true" />
            </summary>
            <p>{glossify(a)}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
