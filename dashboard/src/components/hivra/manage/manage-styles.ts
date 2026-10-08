import type { CSSProperties } from "react";

// Shared look for Manage's cards and controls. Every control keeps a 40px
// minimum target.

export const manageLabel: CSSProperties = {
  fontFamily: "var(--font-mono), monospace", fontSize: 10, fontWeight: 700,
  textTransform: "uppercase", letterSpacing: "0.16em", color: "var(--text-muted)",
};

export const manageCard: CSSProperties = {
  border: "1px solid var(--etched-border)", background: "rgba(255,255,255,0.035)",
  padding: 18, display: "grid", gap: 14, boxSizing: "border-box", minWidth: 0,
  // minmax(0,1fr): the single column may SHRINK below its content's max-content
  // (e.g. a long endpoint URL) so children truncate instead of widening the card.
  gridTemplateColumns: "minmax(0, 1fr)",
};

export const manageValue: CSSProperties = {
  fontFamily: "var(--font-mono), monospace", fontSize: 12.5, color: "var(--ink-black)",
};

export const manageMuted: CSSProperties = {
  fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55,
};

export const manageButtonDark: CSSProperties = {
  border: "1px solid var(--ink-black)", background: "var(--ink-black)", color: "var(--bg-surface)",
  fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 800,
  padding: "9px 14px", display: "inline-flex", alignItems: "center", gap: 7, minHeight: 40,
};

export const manageButtonGhost: CSSProperties = {
  border: "1px solid var(--etched-border)", background: "transparent", color: "var(--ink-black)",
  fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 800,
  padding: "9px 14px", display: "inline-flex", alignItems: "center", gap: 7, minHeight: 40,
};

export const manageError: CSSProperties = {
  border: "1px solid #c0392b", background: "rgba(192,57,43,0.08)", color: "#e06c5a", fontSize: 12.5,
  padding: "9px 13px", fontFamily: "var(--font-mono), monospace", lineHeight: 1.5, overflowWrap: "anywhere",
};

export const manageSpin: CSSProperties = { animation: "spin 1s linear infinite" };

/** A button's style while it can't be pressed. */
export function manageDisabled(style: CSSProperties, disabled: boolean, opacity = 0.5): CSSProperties {
  return { ...style, cursor: disabled ? "default" : "pointer", opacity: disabled ? opacity : 1 };
}
