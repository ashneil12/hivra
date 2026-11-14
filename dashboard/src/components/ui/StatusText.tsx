"use client";

import { useState, type HTMLAttributes } from "react";

/**
 * A status word (Running, Starting, Needs attention) that fades and slides
 * into place when it changes, rather than jumping. The first render is still:
 * a page full of statuses must not all animate on load. Reduced motion turns
 * the swap into a plain change (see `.hg-status-swap` in globals.css).
 */
export function StatusText({ value, className, ...rest }: { value: string } & Omit<HTMLAttributes<HTMLSpanElement>, "children">) {
  const [shown, setShown] = useState(value);
  const [changed, setChanged] = useState(false);
  if (value !== shown) {
    setShown(value);
    setChanged(true);
  }
  const classes = [changed ? "hg-status-swap" : undefined, className].filter(Boolean).join(" ") || undefined;
  // A new key remounts the span, so the animation replays on every change.
  return <span key={shown} className={classes} {...rest}>{value}</span>;
}
