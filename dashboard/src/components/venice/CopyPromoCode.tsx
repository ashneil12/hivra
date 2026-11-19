"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import styles from "./venice-promo.module.css";

/** The promo code on its ticket, with a button that copies it. */
export default function CopyPromoCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      // Clipboard blocked: the code stays visible and selectable.
    }
  }

  return (
    <div className={styles.codeRow}>
      <strong className={styles.code}>{code}</strong>
      <button type="button" className={styles.copy} onClick={copy} data-cta="venice-promo-copy" aria-label={copied ? "Code copied" : `Copy code ${code}`}>
        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
        <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
      </button>
    </div>
  );
}
