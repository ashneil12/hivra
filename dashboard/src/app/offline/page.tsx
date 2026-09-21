import type { Metadata } from "next";
import Link from "next/link";

// Branded fallback shown by the PWA service worker (dashboard/public/sw.js) when
// a navigation is attempted with no network. It is a fully static, public,
// auth-free route so the worker can precache it and serve it offline. Styles are
// inlined with hard fallbacks so the page still looks like Hivra even when the
// app's CSS bundle has not been cached yet.
export const metadata: Metadata = {
  title: "Offline",
  description: "You're offline. Hivra will reconnect when your connection returns.",
  robots: { index: false, follow: false },
};

// Pure static content — no request data — so the worker caches a stable shell.
export const dynamic = "force-static";

const PAGE_STYLE: React.CSSProperties = {
  minHeight: "100dvh",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  textAlign: "center",
  padding: "2.5rem 1.5rem",
  background: "var(--vellum-bg, #fdfcf9)",
  color: "var(--ink-black, #1a1a1a)",
  fontFamily: "var(--font-outfit, system-ui, -apple-system, sans-serif)",
};

export default function OfflinePage() {
  return (
    <main style={PAGE_STYLE}>
      <div style={{ width: "100%", maxWidth: 420 }}>
        <p
          style={{
            fontFamily: "var(--font-mono, ui-monospace, monospace)",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.18em",
            margin: 0,
            opacity: 0.55,
          }}
        >
          Hivra
        </p>

        <h1
          style={{
            fontFamily: "var(--font-playfair, Georgia, 'Times New Roman', serif)",
            fontSize: "1.9rem",
            lineHeight: 1.15,
            margin: "0.9rem 0 0",
          }}
        >
          You&rsquo;re offline
        </h1>

        <p
          style={{
            fontSize: 14,
            lineHeight: 1.75,
            margin: "0.85rem 0 0",
            color: "var(--text-secondary, rgba(26, 26, 26, 0.7))",
          }}
        >
          Hivra needs a connection to reach your agents. Check your network &mdash; the
          dashboard reconnects automatically the moment you&rsquo;re back online.
        </p>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "center", marginTop: "1.6rem" }}>
          <Link
            href="/dashboard/chat"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "11px 18px",
              background: "var(--ink-black, #1a1a1a)",
              color: "var(--vellum-bg, #fdfcf9)",
              border: "1px solid var(--ink-black, #1a1a1a)",
              textDecoration: "none",
              fontFamily: "var(--font-mono, ui-monospace, monospace)",
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
            }}
          >
            Try Reconnecting
          </Link>
          <Link
            href="/"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "11px 18px",
              background: "transparent",
              color: "var(--ink-black, #1a1a1a)",
              border: "1px solid var(--etched-border, rgba(26, 26, 26, 0.18))",
              textDecoration: "none",
              fontFamily: "var(--font-mono, ui-monospace, monospace)",
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
            }}
          >
            Back to Home
          </Link>
        </div>
      </div>
    </main>
  );
}
