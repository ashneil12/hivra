// Adapted from MonoCode (MIT License, Copyright (c) 2026 Nick); see THIRD_PARTY_LICENSES/monocode.txt.
import { memo, useMemo, type CSSProperties, type ElementType } from "react";
import styles from "./chat.module.css";

export interface ShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
}

function ShimmerComponent({
  children,
  as: Component = "span",
  className = "",
  duration = 2,
  spread = 2,
}: ShimmerProps) {
  const dynamicSpread = useMemo(
    () => (children?.length ?? 0) * spread,
    [children, spread],
  );

  return (
    <Component
      className={`${styles.shimmer} ${className}`.trim()}
      style={
        {
          "--spread": `${dynamicSpread}px`,
          "--shimmer-duration": `${duration}s`,
        } as CSSProperties
      }
    >
      {children}
    </Component>
  );
}

export const Shimmer = memo(ShimmerComponent);
