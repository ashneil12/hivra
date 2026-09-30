import type { Metadata } from "next";
import Link from "next/link";
import PublicSite from "@/components/public-site/PublicSite";
import { buildWebsiteMetadata } from "@/lib/metadata";

export const metadata: Metadata = { title: "Hivra ecosystem", description: "Agent Computers today, and the roadmap for Gate, Exchange, Arena, Signal and the wider Hivra ecosystem.", ...buildWebsiteMetadata({
  path: "/ecosystem",
  title: "Hivra ecosystem",
  description: "A factual map of what Hivra offers today, what is next, what is later, and what remains research.",
}) };

const MAP = [
  { stage: "Available now", tone: "available", items: ["Agent Computers: give an AI agent a separate computer to work on, so it stays off yours. What it can reach depends on the setup you pick.", "Use the supported agents, their text window (the terminal) and their files. Whether a computer has a desktop depends on the computer.", "Pay by card and use your own AI key. Running Hivra yourself needs no token."] },
  { stage: "Next", tone: "next", items: ["Gate: let an agent use an account without ever being handed the password or key.", "Exchange: a store for agents, tools, ready-made computer setups and workflows, where each one says what it wants to reach.", "Arena: attack your own agents on purpose, in a safe test area, and keep the proof of what happened.", "Signal: share checked warnings about broken or dangerous tools, and what to do about them."] },
  { stage: "Then", tone: "then", items: ["Vault: answer a small question, like \"am I free Tuesday?\", without handing over the whole account.", "Passport: an ID you can check for an agent: who made it, which version, and what access it asks for.", "Seal: a security badge backed by specific tests and proof.", "Rescue: stop a problem, take back the agent's access and recover, with the evidence kept.", "Challenges: approved security tests, with rewards for real problems people find.", "Experience: share what worked, checked first, along with what it assumes and where it stops working."] },
  { stage: "Research", tone: "research", items: ["Missions: a group of agents working on one job with a set budget and a clear finish line.", "Foundry: services run by agents, with a person who is responsible for them.", "Colony: practice worlds, which can be reset, for studying how agents work together.", "Interchange: an agent's spending allowance, for one purpose, that its owner can take back.", "Ports: strict, limited links between an agent and real-world services and devices."] },
] as const;

export default function EcosystemPage() {
  return <PublicSite>
    <main id="main-content" style={{ maxWidth: 1180, margin: "0 auto", padding: "clamp(4rem, 10vw, 9rem) var(--public-gutter)" }}>
      <header style={{ maxWidth: 760, marginBottom: "clamp(3rem, 8vw, 6rem)" }}>
        <p className="mono" style={{ color: "var(--public-accent)", fontSize: 11, letterSpacing: ".16em", textTransform: "uppercase" }}>Ecosystem map</p>
        <h1 style={{ fontSize: "clamp(3rem, 8vw, 7rem)", lineHeight: 1, margin: "1rem 0 1.5rem" }}>A clear map of Hivra.</h1>
        <p style={{ fontSize: "clamp(1.1rem, 2vw, 1.45rem)", color: "var(--public-muted)", maxWidth: 680 }}>Use what exists today. Follow what is being built. The planned sections describe where Hivra is headed, not things you can use today.</p>
      </header>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 1, border: "1px solid var(--public-line)", background: "var(--public-line)" }}>
        {MAP.map((column) => <section key={column.stage} aria-labelledby={`ecosystem-${column.tone}`} style={{ background: "var(--public-bg)", padding: "clamp(1.4rem, 3vw, 2.5rem)", minHeight: 300 }}>
          <p className="mono" style={{ color: "var(--public-accent)", fontSize: 10, letterSpacing: ".12em", textTransform: "uppercase" }}>{column.stage}</p>
          <h2 id={`ecosystem-${column.tone}`} style={{ fontSize: "1.75rem", margin: "1rem 0 1.5rem" }}>{column.stage === "Available now" ? "Use it" : column.stage === "Research" ? "Open questions" : column.stage}</h2>
          <ul style={{ margin: 0, paddingLeft: "1.1rem", color: "var(--public-muted)" }}>{column.items.map((item) => <li key={item} style={{ marginBottom: ".85rem" }}>{item}</li>)}</ul>
        </section>)}
      </div>
      <p style={{ marginTop: "2rem", color: "var(--public-muted)", lineHeight: 1.7 }}>Next and Then describe intended order, not release dates or available features. Hivra Orchestrator, macOS and custom images are also planned additions to Agent Computers. Available operating systems and runtimes are shown when you <Link href="/dashboard/launch" style={{ textDecoration: "underline", textUnderlineOffset: 4 }}>launch a computer</Link>.</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem 2rem", marginTop: "3rem" }}>
        <Link href="/token" style={{ color: "var(--public-text)", textDecoration: "underline", textUnderlineOffset: 5 }}>Token: current access and proposals</Link>
        <a href="/docs/litepaper/" target="_blank" rel="noopener noreferrer" style={{ color: "var(--public-text)", textDecoration: "underline", textUnderlineOffset: 5 }}>Read the full litepaper map</a>
      </div>
    </main>
  </PublicSite>;
}
