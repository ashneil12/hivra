/** Fit a menu between the visible header and bottom navigation, including keyboard occlusion. */
export function surfaceMenuLayout(anchor: { top: number; bottom: number }, bounds: { top: number; bottom: number }) {
  const below = Math.max(0, bounds.bottom - anchor.bottom - 16);
  const above = Math.max(0, anchor.top - bounds.top - 16);
  const placement = below < 180 && above > below ? "above" : "below";
  return { placement, maxHeight: Math.min(420, placement === "above" ? above : below) };
}
