import type { ReactNode } from "react";
import LandingHeader from "@/components/layout/LandingHeader";
import Footer from "@/components/landing/Footer";
import { newTokenSurfacesEnabled } from "@/lib/token-surfaces";
import styles from "./public-site.module.css";

export interface PublicSiteProps {
  children: ReactNode;
  className?: string;
  variant?: string;
  "data-page"?: string;
  /**
   * Keep auth resolution in the route; this frame is also safe in client pages.
   * Omit it to let the header read Clerk's session hint on the client.
   */
  isSignedIn?: boolean;
  /**
   * Whether the litepaper and token links show (HIVRA_NEW_TOKEN_SURFACES).
   * Server pages leave it out and it is read here. A page that renders this
   * frame inside a client component must pass it, because the switch is not
   * readable in the browser.
   */
  tokenSurfaces?: boolean;
}

/** Public-only design scope. Each page supplies its own main landmark. */
export default function PublicSite({ children, className, variant = "default", "data-page": page, isSignedIn, tokenSurfaces }: PublicSiteProps) {
  const showTokenSurfaces = tokenSurfaces ?? newTokenSurfacesEnabled();
  return (
    <div className={[styles.site, className].filter(Boolean).join(" ")} data-public-site data-variant={variant} data-page={page}>
      <LandingHeader isSignedIn={isSignedIn} tokenSurfaces={showTokenSurfaces} />
      {children}
      <Footer tokenSurfaces={showTokenSurfaces} />
    </div>
  );
}
