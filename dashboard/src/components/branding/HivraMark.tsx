import type { CSSProperties } from "react";

interface HivraMarkProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
}

/**
 * Project-authored Hivra mark. The simple rail-and-bridge geometry remains
 * legible at favicon size and avoids a runtime dependency on a bitmap logo.
 */
export function HivraMark({ size = 40, className, style }: HivraMarkProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      data-testid="hivra-mark"
      viewBox="0 0 128 128"
      width={size}
      height={size}
      style={{ display: "block", flex: "0 0 auto", ...style }}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="128" height="128" rx="18" fill="#0a0a0c" />
      <path d="M24 20h18v88H24zM86 20h18v88H86z" fill="#f7f4ee" />
      <path d="M36 54h56v20H36z" fill="#ef3f48" />
      <path d="M29 32h8v12h-8zM29 84h8v12h-8zM91 32h8v12h-8zM91 84h8v12h-8z" fill="#0a0a0c" />
    </svg>
  );
}
