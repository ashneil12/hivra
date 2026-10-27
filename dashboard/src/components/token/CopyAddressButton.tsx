"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyTextToClipboard } from "@/lib/client/clipboard";

type CopyState = "idle" | "copied" | "failed";

/** The /token "Copy address" button, shared by the dormant and launched layouts. */
export function CopyAddressButton({ value }: { value: string }) {
  const [state, setState] = useState<CopyState>("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [state]);
  return <>
    <button type="button" className="mono" onClick={async () => setState(await copyTextToClipboard(value) ? "copied" : "failed")}
      style={{ display: "inline-flex", alignItems: "center", gap: 8, minHeight: 44, margin: "12px 0 16px", padding: "0 16px", border: "1px solid var(--public-line)", background: "transparent", color: "var(--public-text)", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer" }}>
      {state === "copied" ? <Check size={14} aria-hidden="true" style={{ color: "var(--public-accent)" }} /> : <Copy size={14} aria-hidden="true" />}
      {state === "copied" ? "Address copied" : "Copy address"}
    </button>
    <span role="status" className="sr-only">{state === "copied" ? "Contract address copied" : state === "failed" ? "Copy failed. Select the address to copy it." : ""}</span>
  </>;
}
