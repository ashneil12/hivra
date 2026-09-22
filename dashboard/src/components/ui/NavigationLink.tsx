"use client";

import type { ComponentProps } from "react";
import Link, { useLinkStatus } from "next/link";
import styles from "./NavigationLink.module.css";

function PendingHint() {
  const { pending } = useLinkStatus();
  return pending ? <span className={styles.hint} role="status" aria-label="Opening page"><span /></span> : null;
}

/** Let Next own navigation, cancellation and prefetching; reflect its actual pending state. */
export default function NavigationLink({ children, style, ...props }: ComponentProps<typeof Link>) {
  return <Link {...props} style={{ position: "relative", ...style }}>{children}<PendingHint /></Link>;
}
