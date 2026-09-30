"use client";

// "Cite this" for a tool page: a ready sentence and an HTML snippet, each with a
// copy button. The anchor in the snippet is the brand name only (see
// lib/tools/cite.ts).

import styles from "@/app/tools/tools.module.css";
import CopyButton from "./CopyButton";

export default function CiteBlock({ sentence, html }: { sentence: string; html: string }) {
  return (
    <div className={styles.cite} data-testid="cite-block">
      <div className={styles.headWrap}>
        <span className={styles.panelTitle} style={{ margin: 0 }}>
          Cite this page
        </span>
        <span className={styles.citeActions}>
          <CopyButton text={sentence} label="Copy citation" ariaLabel="Copy the citation sentence" />
          <CopyButton text={html} label="Copy HTML" ariaLabel="Copy the citation as an HTML link" />
        </span>
      </div>
      <p className={styles.citeText}>{sentence}</p>
      <pre className={[styles.pre, styles.preWrap].join(" ")}>{html}</pre>
    </div>
  );
}
