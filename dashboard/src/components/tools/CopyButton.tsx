"use client";

// A copy-to-clipboard button for the tools: one per command, result or link.
// The text can be a string or a function read at click time (a link built from
// the address bar as it is then). When the clipboard is blocked the button says
// so, because the text is always on the page to select by hand.

import { useEffect, useRef, useState } from "react";

import styles from "@/app/tools/tools.module.css";

type CopyState = "idle" | "copied" | "failed";

interface CopyButtonProps {
  text: string | (() => string);
  label?: string;
  copiedLabel?: string;
  /** Names the button for assistive tech while idle, for example "Copy: tmux ls". */
  ariaLabel?: string;
  /** Called after a successful copy, for tool events. */
  onCopied?: () => void;
  compact?: boolean;
}

export default function CopyButton({ text, label = "Copy", copiedLabel = "Copied", ariaLabel, onCopied, compact = false }: CopyButtonProps) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    let next: CopyState = "copied";
    try {
      await navigator.clipboard.writeText(typeof text === "function" ? text() : text);
    } catch {
      next = "failed";
    }
    setState(next);
    if (next === "copied") onCopied?.();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  };

  const className = [styles.smallButton, compact ? styles.copyCompact : null].filter(Boolean).join(" ");
  const visible = state === "copied" ? copiedLabel : state === "failed" ? (compact ? "Copy failed" : "Copy failed, select the text") : label;

  return (
    <button
      type="button"
      onClick={copy}
      className={className}
      data-active={state === "copied"}
      aria-label={state === "idle" ? ariaLabel : undefined}
      aria-live="polite"
    >
      {visible}
    </button>
  );
}
