import type { ReactNode } from "react";
import LandingHeader from "@/components/layout/LandingHeader";
import Footer from "@/components/landing/Footer";
import styles from "./public-site.module.css";

export interface PublicSiteProps {
  children: ReactNode;
  className?: string;
  variant?: string;
  "data-page"?: string;
  /** Keep auth resolution in the route; this frame is also safe in client pages. */
  isSignedIn?: boolean;
}

/** Public-only design scope. Each page supplies its own main landmark. */
export default function PublicSite({ children, className, variant = "default", "data-page": page, isSignedIn = false }: PublicSiteProps) {
  return (
    <div className={[styles.site, className].filter(Boolean).join(" ")} data-public-site data-variant={variant} data-page={page}>
      <LandingHeader isSignedIn={isSignedIn} />
      {children}
      <Footer />
    </div>
  );
}
