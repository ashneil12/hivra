import type { Metadata } from "next";
import { notFound } from "next/navigation";
import PublicSite from "@/components/public-site/PublicSite";
import { Breadcrumbs, EditorialQuestions, type EditorialQuestion } from "@/components/public-editorial/Editorial";
import { ActionLinks } from "@/components/public-editorial/ActionLinks";
import editorial from "@/components/public-editorial/secondary-site.module.css";
import { MEMORY_MAX_CHARACTERS, MEMORY_MAX_ITEMS, MEMORY_RECALL_AT_10, MEMORY_START_HREF, MEMORY_TYPICAL_MS } from "@/lib/memory/facts";
import { isHivraMemoryEnabled } from "@/lib/memory/flag";
import { MEMORY_INSTRUCTIONS } from "@/lib/memory/setup";
import { absoluteTitle, buildWebsiteMetadata } from "@/lib/metadata";
import styles from "./memory.module.css";

const TITLE = "Free cloud memory for any AI agent | Hivra";
const DESCRIPTION =
  "One memory shared by Claude Code, Codex, Cursor, Hermes and OpenClaw. Hosted for you, free, set up in two minutes. Export or delete it any time.";

export const metadata: Metadata = {
  title: absoluteTitle(TITLE),
  description: DESCRIPTION,
  ...buildWebsiteMetadata({ path: "/memory", title: TITLE, description: DESCRIPTION }),
};

// The preview switch is read per request, so turning it on needs no rebuild of this page.
export const dynamic = "force-dynamic";

const ITEMS = MEMORY_MAX_ITEMS.toLocaleString("en-US");
const CHARACTERS = MEMORY_MAX_CHARACTERS.toLocaleString("en-US");

const PROBLEMS = [
  { title: "Every agent starts from zero", body: "You explain your project to Claude Code, then again to Codex, then again to the agent on your server. None of them knows what the others learned." },
  { title: "Built-in memory stays put", body: "Most agents keep notes in a file on one machine. Change laptop, model or agent and the notes stay behind." },
  { title: "Hosted memory is priced like a product", body: "Memory you can carry between agents usually means a monthly plan or a server to run yourself. For most people it is a small amount of text." },
] as const;

const AGENTS = [
  { name: "Claude Code", body: "One command adds it. A short block in CLAUDE.md makes Claude read it at the start of every session." },
  { name: "Codex", body: "Three lines in config.toml and the same block in AGENTS.md." },
  { name: "Cursor and other MCP apps", body: "Paste a small settings block. Anything that speaks MCP over HTTPS can connect." },
  { name: "Hermes", body: "Connect it as an MCP server on your own Hermes, or on one Hivra runs for you." },
  { name: "OpenClaw", body: "Connect it as an MCP server so the agent in your messaging apps shares what your coding agents know." },
  { name: "Your own scripts", body: "A plain HTTPS API with the same key: save, search, export. No SDK to install." },
] as const;

const STEPS = [
  { title: "Get a key", body: "Sign up free and create a key. Make one for everything, or one per agent so you can switch a single agent off." },
  { title: "Paste two things", body: "The connection line for your agent, and a short instruction block so it actually uses the memory." },
  { title: "Work as usual", body: "The agent reads your memory when it starts and saves what matters as it goes. Open another agent and it already knows." },
] as const;

const TOOLS = [
  { name: "wake", body: "Read at the start of a session. The whole memory in about a hundred lines: recent things in full, older things as one-line summaries." },
  { name: "remember", body: "Save one fact, preference or decision. If it makes an older memory out of date, the agent names the old one and it is replaced." },
  { name: "recall", body: "Search by meaning and by exact words together, so both “what did we decide about billing” and a file name find the right memory." },
  { name: "zoom", body: "Open a summary line to see the memories underneath it." },
  { name: "summarize", body: "The agent writes the one-line summaries itself as memory grows, a little at a time." },
  { name: "profile", body: "A short “about me” every agent reads first: who you are and how you like to work." },
  { name: "forget", body: "Remove a memory for good." },
  { name: "export", body: "Everything, as Markdown or JSON, whenever you ask." },
] as const;

const QUESTIONS: EditorialQuestion[] = [
  {
    q: "Is it really free?",
    a: `Yes. The free memory holds up to ${ITEMS} memories of up to ${CHARACTERS} characters each, with no card and no trial clock. It costs Hivra very little to run because nothing runs while your agents are idle, and no AI model is called on our side when an agent saves or searches.`,
  },
  {
    q: "Why does Hivra give this away?",
    a: "Hivra's paid product is a private computer for your agent that stays on when your laptop is closed. Memory is how we hope you get to know us. If you later launch an agent on Hivra, it starts with everything your other agents already know.",
  },
  {
    q: "Do I need a Hivra agent or a paid plan to use it?",
    a: "No. A free account and a key are enough. It works with agents that run on your own laptop or server and never touch Hivra's computers.",
  },
  {
    q: "Can Hivra read my memories?",
    a: "Your memories are stored on the service Hivra runs, so Hivra could technically reach them to fix a fault. We do not read them for any other reason, do not sell them and do not train anything on them. If that is not private enough for something, do not save it.",
  },
  {
    q: "What happens to passwords and API keys?",
    a: "Text that looks like a common API key, token or private key is cut out before a memory is saved. Treat that as a safety net, not a vault: tell your agents not to save secrets.",
  },
  {
    q: "Will my agent use it without being told?",
    a: "Often not. In our tests an agent with a memory of its own skipped a new memory tool in about one session in three. With the short instruction block in its rules file it used it every time, which is why setup includes that block.",
  },
  {
    q: "What happens when I reach the limit?",
    a: `New saves are refused with a clear message until you forget something or old memories are replaced. Nothing is deleted for you. Most people stay far below ${ITEMS}: replaced memories do not count.`,
  },
  {
    q: "Can I leave?",
    a: "Yes. Ask any connected agent to export and you get everything as Markdown or JSON. “Delete everything” on your memory page removes every memory and every key straight away.",
  },
  {
    q: "Can I give one agent read-only access?",
    a: "Yes. A key can be read-only, and each key can be revoked on its own without touching the others.",
  },
  {
    q: "Does it replace my agent's built-in memory?",
    a: "It can sit beside it, but it works best as the one place your agents write to. The instruction block tells the agent to use this memory instead of its own, so you do not end up with two that disagree.",
  },
];

export default function MemoryPage() {
  if (!isHivraMemoryEnabled()) notFound();
  const faq = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: QUESTIONS.map(({ q, a }) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })),
  };
  return (
    <PublicSite className={editorial.page} data-page="memory" tokenSurfaces={false}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faq).replace(/</g, "\\u003c") }} />
      <main className={editorial.main} id="main-content">
        <Breadcrumbs items={[{ label: "Memory" }]} />
        <header className={`${editorial.masthead} ${styles.hero}`}>
          <h1>Free cloud memory for any AI agent.</h1>
          <p>
            One memory that Claude Code, Codex, Cursor, Hermes and OpenClaw all share. What one agent learns, the others know. Hosted for you, free, set up in two minutes.
          </p>
          <ActionLinks
            items={[
              { label: "Get your free memory", href: MEMORY_START_HREF, kind: "primary", cta: "memory-hero" },
              { label: "See how it works", href: "#how", kind: "secondary", cta: "memory-how" },
            ]}
          />
          <p className={styles.heroNote}>No card. No Hivra agent needed. Export or delete everything whenever you like.</p>
        </header>

        <section className={styles.first} aria-labelledby="memory-why">
          <h2 id="memory-why">Why agents need a memory that travels</h2>
          <ul className={styles.grid3}>
            {PROBLEMS.map((item) => (
              <li key={item.title}><strong>{item.title}</strong>{item.body}</li>
            ))}
          </ul>
        </section>

        <section className={styles.section} aria-labelledby="how">
          <h2 id="how">How it works</h2>
          <ol className={styles.steps}>
            {STEPS.map((step) => (
              <li key={step.title}><strong>{step.title}</strong>{step.body}</li>
            ))}
          </ol>
        </section>

        <section className={styles.section} aria-labelledby="memory-agents">
          <h2 id="memory-agents">Works with the agents you already use</h2>
          <p className={styles.lead}>
            Hivra Memory is a standard MCP server reached over HTTPS, plus a plain API. If an agent can connect to an MCP server, it can share this memory. Nothing to install and nothing to keep running.
          </p>
          <ul className={styles.grid3}>
            {AGENTS.map((agent) => (
              <li key={agent.name}><strong>{agent.name}</strong>{agent.body}</li>
            ))}
          </ul>
        </section>

        <section className={styles.section} aria-labelledby="memory-setup">
          <h2 id="memory-setup">The whole setup, for Claude Code</h2>
          <p className={styles.lead}>One command to connect. Your memory page fills in the address and your key, and has the same for Codex, Cursor and plain HTTPS.</p>
          <pre className={styles.code}>{`claude mcp add --transport http --scope user memory <your memory address> --header "Authorization: Bearer <your key>"`}</pre>
          <p className={styles.lead}>Then one block in CLAUDE.md, so Claude reads the memory at the start of every session and saves to it as it works:</p>
          <pre className={styles.code}>{MEMORY_INSTRUCTIONS}</pre>
        </section>

        <section className={styles.section} aria-labelledby="memory-tools">
          <h2 id="memory-tools">What your agent can do with it</h2>
          <p className={styles.lead}>Eight tools. The agent does the thinking: it decides what is worth keeping and what is out of date, so nothing is rewritten behind your back.</p>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr><th scope="col">Tool</th><th scope="col">What it does</th></tr>
              </thead>
              <tbody>
                {TOOLS.map((tool) => (
                  <tr key={tool.name}><td>{tool.name}</td><td>{tool.body}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="memory-good">
          <h2 id="memory-good">Built to stay useful as it grows</h2>
          <ul className={styles.grid2}>
            <li><strong>It does not flood the agent</strong>A memory that pastes everything into every session gets slower and worse. Here the agent wakes up to about a hundred lines however much is stored: recent things in full, older things as summaries it can open.</li>
            <li><strong>Old facts get replaced, not piled up</strong>When you change your mind, the agent names the memory that is now wrong and the new one takes its place. Search stops returning the old answer.</li>
            <li><strong>Search finds meaning and exact words</strong>On a public long-conversation benchmark (LoCoMo), the right memory was in the first ten results for {MEMORY_RECALL_AT_10.meaning}% of questions, against {MEMORY_RECALL_AT_10.keywordOnly}% for keyword search alone.</li>
            <li><strong>Fast enough not to notice</strong>A save or a search took about {MEMORY_TYPICAL_MS} milliseconds against the live service when we measured it in November 2026.</li>
          </ul>
          <p className={styles.note}>Both figures are Hivra&apos;s own measurements from 17 November 2026, not an independent test. The benchmark number counts a question as found when any passage that answers it appears in the first ten results.</p>
        </section>

        <section className={styles.section} aria-labelledby="memory-private">
          <h2 id="memory-private">What is private, and what is not</h2>
          <ul className={styles.plain}>
            <li><strong>Your memory has a store of its own.</strong> Each person gets a separate database. A key opens one person&apos;s memory and nothing else.</li>
            <li><strong>No model reads it to rewrite it.</strong> No chat model runs on Hivra&apos;s side. To make search by meaning work, each memory is turned into a list of numbers by an embedding model on the same cloud that stores it.</li>
            <li><strong>Not sold, not used for training.</strong> Hivra does neither.</li>
            <li><strong>Common secrets are cut out.</strong> Text that looks like an API key, token or private key is removed before saving.</li>
            <li><strong>You can take it or wipe it.</strong> Export everything as Markdown or JSON. Delete everything in one step.</li>
            <li><strong>Hivra runs the service, so Hivra could reach it.</strong> We only would to fix a fault. We will not tell you that nobody can see your data, because for a hosted memory that would not be true.</li>
          </ul>
        </section>

        <section className={styles.section} aria-labelledby="memory-free">
          <h2 id="memory-free">What you get free</h2>
          <ul className={styles.grid3}>
            <li><strong>{ITEMS} memories</strong>Up to {CHARACTERS} characters each. Replaced and forgotten memories do not count.</li>
            <li><strong>As many agents as you like</strong>Every agent you connect shares the same memory. Separate keys, read-only keys, revoke any time.</li>
            <li><strong>No clock</strong>Not a trial. No card asked for. It stays free while you use it.</li>
          </ul>
        </section>

        <section className={styles.section} aria-labelledby="memory-next">
          <h2 id="memory-next">When you want more than memory</h2>
          <p className={styles.lead}>
            Memory makes the agents on your laptop smarter. A Hivra agent is one that keeps working when the laptop is closed: it runs on a private computer of its own, and it starts with everything in your memory. You never have to take that step, and your memory stays free either way.
          </p>
          <ActionLinks
            items={[
              { label: "Get your free memory", href: MEMORY_START_HREF, kind: "primary", cta: "memory-bottom" },
              { label: "What a Hivra agent is", href: "/why-hivra", kind: "secondary", cta: "memory-why-hivra" },
              { label: "Pricing", href: "/pricing", kind: "secondary", cta: "memory-pricing" },
            ]}
          />
        </section>

        <EditorialQuestions questions={QUESTIONS} title="Questions people ask" />
      </main>
    </PublicSite>
  );
}
