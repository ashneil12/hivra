import type { Metadata } from "next";
import Link from "next/link";

// Branded fallback shown by the PWA service worker (dashboard/public/sw.js) when
// a navigation is attempted with no network. It is a fully static, public,
// auth-free route so the worker can precache it and serve it offline. Styles are
// inlined with hard fallbacks so the page still looks like Hivra even when the
// app's CSS bundle has not been cached yet.
export const metadata: Metadata = {
  title: "Offline",
  description: "You're offline. Check your Wi-Fi or mobile data, then try again.",
  robots: { index: false, follow: false },
};

// Pure static content (no request data), so the worker caches a stable shell.
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

const PARAGRAPH_STYLE: React.CSSProperties = {
  fontSize: 15,
  lineHeight: 1.75,
  margin: "0.85rem 0 0",
  color: "var(--text-secondary, rgba(26, 26, 26, 0.7))",
};

// Ash's words for this page (15-offline.md).
export default function OfflinePage() {
  return (
    <main id="main-content" style={PAGE_STYLE}>
      <div style={{ width: "100%", maxWidth: 460 }}>
        <p
          style={{
            fontFamily: "var(--font-mono, ui-monospace, monospace)",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.18em",
            margin: 0,
            opacity: 0.75,
          }}
        >
          Hivra
        </p>

        <h1
          style={{
            // The brand display face, as on the rest of the site (.serif in globals.css); the system face
            // stands in when the bundle has not been cached.
            fontFamily: "var(--font-grotesk, 'Space Grotesk', system-ui, -apple-system, sans-serif)",
            fontSize: "2rem",
            fontWeight: 500,
            letterSpacing: "-0.04em",
            lineHeight: 1.15,
            margin: "0.9rem 0 0",
          }}
        >
          You&rsquo;re offline.
        </h1>

        <p style={PARAGRAPH_STYLE}>
          Hivra can&rsquo;t reach your agents from this connection right now. Check your Wi-Fi or mobile data, then
          try again.
        </p>

        <p style={PARAGRAPH_STYLE}>
          A network interruption on your device doesn&rsquo;t necessarily stop a computer that&rsquo;s still running
          on Hivra Cloud. However, tasks and connections may be affected by their own errors or service incidents.
        </p>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "center", marginTop: "1.6rem" }}>
          <Link
            href="/dashboard/chat"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              minHeight: 44,
              padding: "0 20px",
              background: "var(--ink-black, #1a1a1a)",
              color: "var(--vellum-bg, #fdfcf9)",
              border: "1px solid var(--ink-black, #1a1a1a)",
              textDecoration: "none",
              fontFamily: "var(--font-mono, ui-monospace, monospace)",
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
            }}
          >
            Try reconnecting
          </Link>
          <Link
            href="/"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              minHeight: 44,
              padding: "0 20px",
              background: "transparent",
              color: "var(--ink-black, #1a1a1a)",
              border: "1px solid var(--etched-border, rgba(26, 26, 26, 0.18))",
              textDecoration: "none",
              fontFamily: "var(--font-mono, ui-monospace, monospace)",
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
            }}
          >
            Back to home
          </Link>
        </div>
      </div>
    </main>
  );
}
