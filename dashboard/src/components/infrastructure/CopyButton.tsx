"use client";

import { Check, Copy } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { copyTextToClipboard } from "@/lib/client/clipboard";

import styles from "./Infrastructure.module.css";

/** A small Copy button that says "Copied" for a moment after it works. The
 * value is never placed in a link or in storage. */
export function CopyButton({ value, label, text = "Copy" }: { value: string; label: string; text?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  const onCopy = useCallback(async () => {
    if (!await copyTextToClipboard(value)) return;
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1_600);
  }, [value]);
  return (
    <button type="button" className={styles.copyButton} onClick={() => void onCopy()} aria-label={label}>
      {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
      <span aria-live="polite">{copied ? "Copied" : text}</span>
    </button>
  );
}
