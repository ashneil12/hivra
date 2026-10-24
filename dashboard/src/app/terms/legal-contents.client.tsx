"use client";

import { useEffect, useRef } from "react";

import styles from "./legal-document.module.css";
import { keepHyphenatedWordsWhole } from "./legal-text";

/** Matches the single-column breakpoint in legal-document.module.css. */
const WIDE_LAYOUT_QUERY = "(min-width: 901px)";

export interface LegalContentsItem {
  id: string;
  label: string;
}

function isWideLayout(): boolean {
  // jsdom and very old browsers have no matchMedia: treat them as the wide layout.
  return typeof window.matchMedia !== "function" || window.matchMedia(WIDE_LAYOUT_QUERY).matches;
}

/**
 * The list of sections beside a legal document. Server HTML ships it open for the wide layout;
 * on a narrow screen it collapses once scripts have run (until then the stylesheet hides it, so
 * it never paints above the document). Choosing a section closes it again on a narrow screen.
 */
export default function LegalContents({ items, label = "Contents" }: { items: LegalContentsItem[]; label?: string }) {
  const detailsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const details = detailsRef.current;
    if (!details) return;
    if (!isWideLayout()) details.open = false;
    details.dataset.ready = "";
  }, []);

  const closeOnNarrowLayout = () => {
    const details = detailsRef.current;
    if (details && !isWideLayout()) details.open = false;
  };

  return (
    <details ref={detailsRef} className={styles.contents} open>
      <summary>{label}</summary>
      <nav aria-label={label}>
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <a href={`#${item.id}`} onClick={closeOnNarrowLayout}>
                {keepHyphenatedWordsWhole(item.label)}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </details>
  );
}
