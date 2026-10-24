import type { FeatureFaqItem } from "../_content/types";
import { renderInline } from "./Inline";
import shared from "../../../components/public-editorial/secondary-site.module.css";
import styles from "../features.module.css";

/**
 * The questions at the foot of a feature page. Same markup and classes as the shared
 * EditorialQuestions, with the heading the copy uses ("Frequently asked questions")
 * and answers that may hold a link or bold text. The FAQPage JSON-LD is built from the
 * same strings (plainText), so the structured data and this list cannot differ.
 */
export function FeatureFaq({ faqs }: { faqs: readonly FeatureFaqItem[] }) {
  if (!faqs.length) return null;
  return (
    <section className={shared.questions}>
      <h2>Frequently asked questions</h2>
      <div>
        {faqs.map(({ q, a }) => (
          <details key={q} open>
            <summary>
              {q}
              <span aria-hidden="true">+</span>
            </summary>
            <div className={styles.answer}>
              <p>{renderInline(a, { gloss: true })}</p>
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

export default FeatureFaq;
