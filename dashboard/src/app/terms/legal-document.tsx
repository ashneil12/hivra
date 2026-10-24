import type { ReactNode } from "react";

import LegalContents from "./legal-contents.client";
import styles from "./legal-document.module.css";
import { keepHyphenatedWordsWhole } from "./legal-text";

export interface LegalSectionData {
  /** Stable anchor for deep links and the contents list, for example "data-retention". */
  id: string;
  /** The heading exactly as the document writes it, number included. */
  heading: string;
  children: ReactNode;
}

export interface LegalDocumentProps {
  title: string;
  /** The paragraphs that open the document, before "Last Updated". */
  lead: ReactNode;
  /** The label is shown as supplied; the ISO day is for the <time> element only. */
  lastUpdated: { label: string; iso: string };
  sections: LegalSectionData[];
}

export type LegalListVariant = "inline" | "stacked" | "columns";

/**
 * A list of rows that each open with a bold lead-in. "inline" keeps the label in the line, for
 * short entries; "stacked" puts it over its text, for items that run to several sentences;
 * "columns" sets it in a left column (stacked again on a narrow screen), for a schedule; its items
 * are the label followed by plain text only (no links), which the grid lays out as one cell. Each
 * item must start with its <strong> label.
 */
export function LegalList({ variant = "inline", children }: { variant?: LegalListVariant; children: ReactNode }) {
  const variantClass = variant === "inline" ? undefined : styles[variant];
  return <ul className={[styles.list, variantClass].filter(Boolean).join(" ")}>{children}</ul>;
}

/**
 * One row of a "columns" schedule that stays label-over-text on a wide screen too. Use it for a row
 * whose text runs to many lines, where a narrow right-hand column would make it long and thin; short
 * rows beside it keep the schedule look.
 */
export function LegalItem({ stacked = false, children }: { stacked?: boolean; children: ReactNode }) {
  return <li data-stacked={stacked ? "" : undefined}>{children}</li>;
}

/**
 * One legal document: the contents list beside a single reading column. The contents sit before
 * <main> (as an on-page table of contents does on documentation sites), so the page's main
 * landmark holds the document alone.
 */
export default function LegalDocument({ title, lead, lastUpdated, sections }: LegalDocumentProps) {
  return (
    <div className={styles.shell}>
      {/* Seen only while it has keyboard focus: the contents list sits before <main>, so this is the way past it. */}
      <a className={styles.skip} href="#main-content">
        Skip to the document
      </a>
      <div className={styles.rail}>
        <LegalContents items={sections.map(({ id, heading }) => ({ id, label: heading }))} />
      </div>
      <main className={styles.document} id="main-content">
        <h1 className="serif">{title}</h1>
        <div className={styles.lead}>{lead}</div>
        <p className={styles.updated}>
          Last Updated: <time dateTime={lastUpdated.iso}>{lastUpdated.label}</time>
        </p>
        {sections.map(({ id, heading, children }) => (
          <section key={id} id={id} className={styles.section}>
            <h2 className="serif">{keepHyphenatedWordsWhole(heading)}</h2>
            {children}
          </section>
        ))}
      </main>
    </div>
  );
}
