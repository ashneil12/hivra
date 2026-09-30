import type { CSSProperties } from "react";

interface HivraMarkProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
}

/** The 192px app icon that docs/brand/export-brand-assets.py resizes from the approved logo. */
export const HIVRA_MARK_SRC = "/brand/hivra-icon-192.png";

/**
 * The approved Hivra mark (docs/brand/hivra-logo.jpg), never redrawn here.
 * 192px covers every current size (28 to 76px) at 2x.
 *
 * A plain <img> serves the exported PNG as is: it is already small, and the
 * next/image optimizer would only re-encode the approved bytes.
 */
export function HivraMark({ size = 40, className, style }: HivraMarkProps) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- see above: the approved bytes are served unmodified
    <img
      src={HIVRA_MARK_SRC}
      alt="Hivra"
      width={size}
      height={size}
      decoding="async"
      className={className}
      data-testid="hivra-mark"
      style={{ display: "block", flex: "0 0 auto", ...style }}
    />
  );
}
