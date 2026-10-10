"use client";

import { RotateCw } from "lucide-react";

import InteractiveBackground from "@/components/InteractiveBackground";
import { LocaleProvider } from "@/components/i18n/LocaleProvider";
import LandingHeader, { HomeOrDashboardLink } from "@/components/layout/LandingHeader";
import Footer from "@/components/landing/Footer";

// Branded runtime-error boundary for the dashboard app root. Next.js requires the
// error boundary to be a client component taking { error, reset }. Mirrors the
// public-page scaffold used by /status and /stats so an unhandled render error
// shows the Hivra shell with a recovery action instead of the bare Next.js error
// screen. Pure presentational: no server auth/Clerk, no DB/schema, no tenant data;
// the header and recovery link read Clerk's client session hint. The
// error itself is already captured globally by OpsTelemetryProvider / PostHog in
// the root layout, so this boundary only renders friendly recovery UI.
export default function RootError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
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
            Something went wrong
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
            This page hit a snag
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
            An unexpected error interrupted this page. You can try again, or head back to
            somewhere safe.
          </p>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "1rem",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <button
              type="button"
              onClick={() => reset()}
              className="action-button"
              style={{
                padding: "12px 24px",
                fontSize: 11,
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                letterSpacing: "0.1em",
                cursor: "pointer",
                border: "none",
              }}
            >
              <RotateCw size={14} aria-hidden="true" /> Try again
            </button>
            <HomeOrDashboardLink
              className="mono"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                minHeight: 44,
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: "0.12em",
                fontWeight: 700,
                textDecoration: "none",
                color: "var(--text-secondary)",
              }}
            />
          </div>
        </main>

        <Footer />
      </div>
    </LocaleProvider>
  );
}
