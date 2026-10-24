import { ArrowRight } from "lucide-react";
import ComparisonTable from "@/components/public-editorial/ComparisonTable";
import { FIT } from "./content";
import styles from "./home.module.css";

/** A bare Yes or No gets a mark beside the word; longer answers stay as the sentence they are. */
function Answer({ text }: { text: string }) {
  if (text === "Yes") return <span className={styles.fitYes}><i aria-hidden="true" />{text}</span>;
  if (text === "No") return <span className={styles.fitNo}><i aria-hidden="true" />{text}</span>;
  return <>{text}</>;
}

/**
 * Where Hivra fits: four places an agent can run, compared in a real table
 * (server rendered, scrollable inside its own frame on mid-width screens and
 * stacked into label and value blocks on phones). Everything is readable
 * before and without script.
 */
export default function Fit() {
  return (
    <section id="fit" className={styles.fit} aria-labelledby="fit-heading">
      <header className={styles.fitHead}>
        <span className={styles.eyebrow} aria-hidden="true" />
        <h2 id="fit-heading" className={styles.sectionTitle}>
          {FIT.title} <em>{FIT.titleTail}</em>
        </h2>
        <p className={styles.bodyText}>{FIT.lead}</p>
      </header>
      <ComparisonTable
        variant="home"
        caption="Where the agent runs: your laptop, a provider-managed agent, a typical hosted machine and Hivra, compared"
        rowHeading={FIT.rowHeading}
        columns={FIT.columns}
        highlight={FIT.columns.length - 1}
        rows={FIT.rows.map(row => ({ label: row.label, cells: row.cells.map(cell => <Answer key={cell} text={cell} />) }))}
      />
      <p className={styles.fitNote}>{FIT.note}</p>
      <div className={styles.fitFoot}>
        <a href={FIT.moreHref} className={styles.textCta} data-cta="fit-compare">
          {FIT.more}
          <ArrowRight size={16} aria-hidden="true" />
        </a>
      </div>
    </section>
  );
}
