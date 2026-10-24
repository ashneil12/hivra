import type { ReactNode } from "react";

import styles from "./legal-document.module.css";

// A hyphenated word such as "Sub-processors" or "data-protection": letters either side of each hyphen.
const HYPHENATED_WORD = /([A-Za-z]+(?:-[A-Za-z]+)+)/g;

/**
 * Keeps each hyphenated word whole when a heading or a contents entry wraps, so "Sub-processors" never
 * leaves "Sub-" at the end of one line and "processors" alone on the next. The characters are untouched
 * (a wrapper around the same text, not a non-breaking hyphen), so the page text stays exactly as written.
 */
export function keepHyphenatedWordsWhole(text: string): ReactNode {
  const parts = text.split(HYPHENATED_WORD);
  if (parts.length === 1) return text;
  // split() with one capture group alternates plain text (even index) and the matched word (odd index).
  return parts.map((part, index) =>
    index % 2 === 1 ? (
      <span key={index} className={styles.whole}>
        {part}
      </span>
    ) : (
      part
    ),
  );
}
