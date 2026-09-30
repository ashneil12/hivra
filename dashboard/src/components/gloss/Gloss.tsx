"use client";

import { useRef, type ReactNode } from "react";
import styles from "./gloss.module.css";

/** One term with a hover and focus tooltip, kept on screen and dismissed with Escape. */
export default function Gloss({ tip, children }: { tip: string; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);

  function place() {
    const term = ref.current;
    if (!term) return;
    const width = Math.min(300, window.innerWidth - 32);
    const box = term.getBoundingClientRect();
    const left = Math.max(16, Math.min(box.left + box.width / 2 - width / 2, window.innerWidth - 16 - width));
    term.style.setProperty("--gloss-x", `${left - box.left}px`);
    term.style.setProperty("--gloss-w", `${width}px`);
    if (box.top < 170) term.setAttribute("data-below", "");
    else term.removeAttribute("data-below");
  }

  return (
    <span
      ref={ref}
      className={styles.gloss}
      tabIndex={0}
      data-tip={tip}
      // aria-description is not in React's typings yet.
      {...{ "aria-description": tip }}
      onPointerEnter={place}
      onFocus={place}
      onKeyDown={(event) => {
        if (event.key === "Escape") event.currentTarget.blur();
      }}
    >
      {children}
    </span>
  );
}
