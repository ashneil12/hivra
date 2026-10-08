import Link from "next/link";
import type { CSSProperties, MouseEventHandler, ReactNode } from "react";

/** The litepaper's own address, so a click skips the /docs/litepaper redirects. */
export const LITEPAPER_HREF = "/docs/litepaper/index.html";

/**
 * Static documents such as the litepaper are files, not app routes. A
 * next/link would prefetch a React Server Components payload for them,
 * which 404s on every page view and turns each click into a failed soft
 * navigation before the real page load.
 */
export function isStaticDocument(href: string): boolean {
  return href.startsWith("/docs/");
}

interface PublicLinkProps {
  href: string;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  target?: string;
  rel?: string;
}

/** A header or footer link: app routes navigate in the app, static documents load as pages. */
export default function PublicLink({ href, ...props }: PublicLinkProps) {
  return isStaticDocument(href) ? <a href={href} {...props} /> : <Link href={href} {...props} />;
}
