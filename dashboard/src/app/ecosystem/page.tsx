import type { Metadata } from "next";
import Link from "next/link";
import PublicSite from "@/components/public-site/PublicSite";
import { buildWebsiteMetadata } from "@/lib/metadata";

export const metadata: Metadata = buildWebsiteMetadata({
  path: "/ecosystem",
  title: "Hivra ecosystem",
  description: "A factual map of what Hivra offers today, what is next, what is later, and what remains research.",
});

const MAP = [
  { stage: "Available now", tone: "available", items: ["Agent computers on Hivra Cloud or your infrastructure", "Browser workspace with chat, terminal, files and desktop surfaces", "Card payments and self-hosting without a token", "Bring your own model key"] },
  { stage: "Shipping next", tone: "next", items: ["More computer images and native app access", "Shared workspace capabilities for agents and people", "Clearer operator tools with bounded permissions"] },
  { stage: "Later", tone: "later", items: ["Gate: controlled access for published agent capabilities", "Exchange: reviewed tools and methods for operators", "Arena and Signal: shared evaluation and evidence surfaces"] },
  { stage: "Research", tone: "research", items: ["Optional $HIVRA migration from $HermesOS", "Token based access and payments for useful work", "Treasury, certification and agent budget proposals"] },
] as const;

export default function EcosystemPage() {
  return <PublicSite>
    <main id="main-content" style={{ maxWidth: 1180, margin: "0 auto", padding: "clamp(4rem, 10vw, 9rem) var(--public-gutter)" }}>
      <header style={{ maxWidth: 760, marginBottom: "clamp(3rem, 8vw, 6rem)" }}>
        <p className="mono" style={{ color: "var(--public-accent)", fontSize: 11, letterSpacing: ".16em", textTransform: "uppercase" }}>Ecosystem map</p>
        <h1 style={{ fontSize: "clamp(3rem, 8vw, 7rem)", lineHeight: 1, margin: "1rem 0 1.5rem" }}>A clear map of Hivra.</h1>
        <p style={{ fontSize: "clamp(1.1rem, 2vw, 1.45rem)", color: "var(--public-muted)", maxWidth: 680 }}>Use what exists today. Follow what is being built. Treat later ideas and research as proposals until they have an implementation and acceptance evidence.</p>
      </header>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 1, border: "1px solid var(--public-line)", background: "var(--public-line)" }}>
        {MAP.map((column) => <section key={column.stage} aria-labelledby={`ecosystem-${column.tone}`} style={{ background: "var(--public-bg)", padding: "clamp(1.4rem, 3vw, 2.5rem)", minHeight: 300 }}>
          <p className="mono" style={{ color: "var(--public-accent)", fontSize: 10, letterSpacing: ".12em", textTransform: "uppercase" }}>{column.stage}</p>
          <h2 id={`ecosystem-${column.tone}`} style={{ fontSize: "1.75rem", margin: "1rem 0 1.5rem" }}>{column.stage === "Available now" ? "Use it" : column.stage === "Research" ? "Still being tested" : column.stage}</h2>
          <ul style={{ margin: 0, paddingLeft: "1.1rem", color: "var(--public-muted)" }}>{column.items.map((item) => <li key={item} style={{ marginBottom: ".85rem" }}>{item}</li>)}</ul>
        </section>)}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem 2rem", marginTop: "3rem" }}>
        <Link href="/token" style={{ color: "var(--public-text)", textDecoration: "underline", textUnderlineOffset: 5 }}>Read the factual token area</Link>
        <a href="/docs/litepaper/index.html#future" target="_blank" rel="noopener noreferrer" style={{ color: "var(--public-text)", textDecoration: "underline", textUnderlineOffset: 5 }}>Read the full litepaper map</a>
      </div>
    </main>
  </PublicSite>;
}
