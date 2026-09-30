import type { Metadata } from "next";

import InteractiveBackground from "@/components/InteractiveBackground";
import { LocaleProvider } from "@/components/i18n/LocaleProvider";
import LandingHeader, { HomeOrDashboardLink } from "@/components/layout/LandingHeader";
import Footer from "@/components/landing/Footer";

export const metadata: Metadata = {
  title: "Page not found",
  // A 404 should never be indexed, but its links are still worth following.
  robots: { index: false, follow: true },
};

// Branded 404 for the dashboard app root. Mirrors the public-page scaffold used
// by /status and /stats (LocaleProvider + InteractiveBackground + LandingHeader +
// Footer) so a mistyped URL stays inside the product instead of dropping to the
// bare Next.js default. Pure presentational: no server auth/Clerk, no DB/schema, no
// tenant data. A sync server component — LocaleProvider resolves the visitor's
// locale client-side, and the header and CTA read Clerk's session hint there
// too, so signed-in visitors are offered the dashboard without per-request work.
export default function NotFound() {
  return (
    <LocaleProvider>
      <div
        className="relative min-h-screen font-sans"
        style={{ background: "var(--vellum-bg)", overflowX: "clip" }}
      >
        <InteractiveBackground />
        <LandingHeader />

        <main
          className="relative z-10"
          style={{
            minHeight: "62vh",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            padding: "8rem 2rem 5rem",
          }}
        >
          <p
            className="mono"
            style={{
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: "0.22em",
              color: "var(--gold-leaf)",
              fontWeight: 700,
              marginBottom: "1.25rem",
            }}
          >
            Error 404
          </p>
          <h1
            className="serif"
            style={{
              fontSize: "clamp(2rem, 4vw, 2.8rem)",
              fontWeight: 300,
              lineHeight: 1.15,
              color: "var(--ink-black)",
              margin: 0,
              maxWidth: 600,
            }}
          >
            This page wandered off
          </h1>
          <p
            style={{
              fontSize: "1.05rem",
              lineHeight: 1.7,
              color: "var(--text-secondary)",
              maxWidth: 460,
              margin: "1.25rem 0 2.25rem",
            }}
          >
            The page you&rsquo;re looking for doesn&rsquo;t exist or has moved. Let&rsquo;s get
            you back to somewhere that does.
          </p>
          <HomeOrDashboardLink
            className="action-button"
            style={{
              padding: "12px 24px",
              minHeight: 44,
              fontSize: 11,
              textDecoration: "none",
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              letterSpacing: "0.1em",
            }}
          />
        </main>

        <Footer />
      </div>
    </LocaleProvider>
  );
}
