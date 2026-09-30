import type { Metadata } from "next";
import { ArrowLeft } from "lucide-react";

import Link from "@/components/ui/NavigationLink";
import { DASHBOARD_RUNTIME_LIST_HREF } from "@/lib/dashboard-navigation";

export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false, follow: false },
};

// notFound() inside the dashboard renders here, inside the dashboard layout, so
// the sidebar and phone bottom bar stay put instead of dropping to the public
// marketing 404 with its Log in / Register header.
export default function DashboardNotFound() {
  return (
    <div
      data-testid="dashboard-not-found"
      className="min-h-full w-full flex items-center justify-center px-4 py-6 md:px-6 md:py-10"
    >
      <div
        className="w-full max-w-2xl"
        style={{
          border: "1px solid var(--etched-border)",
          background: "var(--bg-surface)",
          padding: "clamp(1.25rem, 5vw, 2rem)",
        }}
      >
        <p
          className="mono"
          style={{
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: "0.18em",
            color: "var(--hivra-red)",
            marginBottom: "1rem",
            fontWeight: 700,
          }}
        >
          Error 404
        </p>
        <h1
          className="serif"
          style={{
            fontSize: "clamp(1.6rem, 4vw, 2.2rem)",
            lineHeight: 1.1,
            marginBottom: "0.75rem",
            color: "var(--ink-black)",
          }}
        >
          This page does not exist.
        </h1>
        <p style={{ color: "var(--text-secondary)", lineHeight: 1.7, marginBottom: "1.5rem" }}>
          The link may be out of date, or the agent or computer it pointed to was removed.
        </p>
        <Link
          href={DASHBOARD_RUNTIME_LIST_HREF}
          className="mono inline-flex items-center gap-2 no-underline"
          style={{
            minHeight: 44,
            padding: "0 16px",
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: "#fff",
            background: "var(--hivra-red)",
          }}
        >
          <ArrowLeft size={14} aria-hidden="true" />
          Back to Home
        </Link>
      </div>
    </div>
  );
}
