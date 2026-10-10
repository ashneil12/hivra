"use client";

import { useEffect, type ReactNode } from "react";
import styles from "./gloss.module.css";
import { retainGlossTips } from "./gloss-tip";

/**
 * One term with a hover and focus tooltip. The tooltip itself is drawn by
 * gloss-tip.ts on the page body, so a card's overflow cannot cut it off.
 * Hover, focus and a tap open it, and Escape closes it without moving focus.
 * The term stays a tab stop so a keyboard reader can reach the meaning.
 */
export default function Gloss({ tip, children }: { tip: string; children: ReactNode }) {
  useEffect(() => retainGlossTips(), []);

  return (
    <span
      className={styles.gloss}
      data-gloss=""
      tabIndex={0}
      data-tip={tip}
      // aria-description is not in React's typings yet.
      {...{ "aria-description": tip }}
    >
      {children}
    </span>
  );
}
