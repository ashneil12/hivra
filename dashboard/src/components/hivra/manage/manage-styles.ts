import type { CSSProperties } from "react";

// Shared look for Manage's cards and controls. Every control keeps a 40px
// minimum target.

export const manageLabel: CSSProperties = {
  fontFamily: "var(--font-sans)", fontSize: 11, fontWeight: 600,
  textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--hg-text-3)",
};

export const manageCard: CSSProperties = {
  border: "1px solid var(--hg-stroke)", background: "var(--hg-glass)",
  borderRadius: "var(--hg-radius-lg)", boxShadow: "var(--hg-glass-edge), var(--hg-shadow-sm)",
  backdropFilter: "blur(var(--hg-glass-blur)) saturate(1.3)",
  WebkitBackdropFilter: "blur(var(--hg-glass-blur)) saturate(1.3)",
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
  border: "1px solid var(--hg-accent)", background: "var(--hg-accent)", color: "var(--hg-on-accent)",
  borderRadius: "var(--hg-radius-sm)", fontFamily: "var(--font-sans)", fontSize: 12.5, fontWeight: 600,
  padding: "9px 14px", display: "inline-flex", alignItems: "center", gap: 7, minHeight: 40,
};

export const manageButtonGhost: CSSProperties = {
  border: "1px solid var(--hg-stroke)", background: "transparent", color: "var(--hg-text)",
  borderRadius: "var(--hg-radius-sm)", fontFamily: "var(--font-sans)", fontSize: 12.5, fontWeight: 600,
  padding: "9px 14px", display: "inline-flex", alignItems: "center", gap: 7, minHeight: 40,
};

export const manageError: CSSProperties = {
  border: "1px solid color-mix(in srgb, var(--hg-bad) 40%, transparent)",
  background: "color-mix(in srgb, var(--hg-bad) 8%, transparent)", color: "var(--hg-bad)", fontSize: 12.5,
  borderRadius: "var(--hg-radius-md)", padding: "9px 13px", fontFamily: "var(--font-sans)", lineHeight: 1.5, overflowWrap: "anywhere",
};

export const manageSpin: CSSProperties = { animation: "spin 1s linear infinite" };

/** A button's style while it can't be pressed. */
export function manageDisabled(style: CSSProperties, disabled: boolean, opacity = 0.5): CSSProperties {
  return { ...style, cursor: disabled ? "default" : "pointer", opacity: disabled ? opacity : 1 };
}
