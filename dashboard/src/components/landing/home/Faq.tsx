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
        <h2 id="faq-heading" className={styles.sectionTitle}>{FAQ_TITLE}</h2>
      </header>
      <div className={styles.faqList}>
        {items.map(({ q, a }) => (
          <details key={q} className={styles.faqItem}>
            <summary>
              <h3>{q}</h3>
              <Plus size={20} aria-hidden="true" />
            </summary>
            {a.split("\n\n").map(paragraph => <p key={paragraph}>{glossify(paragraph)}</p>)}
          </details>
        ))}
      </div>
    </section>
  );
}
