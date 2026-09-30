import PublicSite from "@/components/public-site/PublicSite";
import { Breadcrumbs, EditorialRelated } from "@/components/public-editorial/Editorial";
import styles from "../../components/public-editorial/secondary-site.module.css";
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import StructuredData from "@/components/StructuredData";
import { buildWebsiteMetadata } from "@/lib/metadata";
import { SITE_URL } from "@/lib/seo-urls";
import { PUBLIC_START_HREF } from "@/lib/public-start";

export const metadata: Metadata = {
  title: "Hivra Features: Persistent AI Agent Hosting",
  description:
    "What Hivra runs for you: persistent memory, browser automation, scheduled tasks and multiple agents, including Hermes, OpenClaw, Claude Code and Codex.",
  ...buildWebsiteMetadata({
    path: "/features",
    title: "Hivra Features: Persistent AI Agent Hosting",
    description:
      "Every capability of Hivra: persistent memory, browser automation, multi-agent support, and more.",
  }),
};

const features = [
  {
    slug: "persistent-memory",
    title: "Persistent Memory",
    tagline: "Your agent remembers. Every session. Forever.",
    description:
      "Most AI tools forget everything when a chat ends. Hermes agents keep their context from one session to the next: your projects, your preferences and what they have learned, all building up over time.",
  },
  {
    slug: "browser-automation",
    title: "Browser Automation",
    tagline: "Your agent can actually browse the web.",
    description:
      "Browsing comes set up on paid plans. Your agent can research, fill in forms, pull out data and use websites on its own.",
  },
  {
    slug: "multi-agent",
    title: "Multiple Agents",
    tagline: "Several agents. One pool of computing power.",
    description:
      "Run specialized agents side by side from one account, sharing one pool of computing power instead of paying per seat. Each keeps its own memory and tools.",
  },
  {
    slug: "no-docker-hosting",
    title: "No Docker Required",
    tagline: "Set up without typing a single command.",
    description:
      "Hivra handles all the server setup for you: no renting a server, no Docker files, no web-server settings. Just add your AI key or login and go.",
  },
  {
    slug: "openclaw-alternative",
    title: "OpenClaw Alternative",
    tagline: "Keep OpenClaw, or move to Hermes.",
    description:
      "Hivra can run OpenClaw itself on paid plans, next to Hermes and other agents. Moving an existing setup is a manual step; Hermes has its own OpenClaw migration command.",
  },
  {
    slug: "scheduled-tasks",
    title: "Scheduled Tasks & Cron Jobs",
    tagline: "Your agent works while you sleep.",
    description:
      "Set up jobs that repeat on a schedule, like sorting your email, watching competitors or syncing data. The scheduler (called cron) comes set up for Hermes agents.",
  },
];

const breadcrumbSchema = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: [
    { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
    { "@type": "ListItem", position: 2, name: "Features", item: `${SITE_URL}/features` },
  ],
};

const quickSummary = [
  {
    title: "Persistent memory",
    body: "Your agent remembers what you told it from one session to the next, so you never have to start over.",
  },
  {
    title: "Browser automation",
    body: "Research, filling in forms, pulling out data and using websites all come set up on paid plans.",
  },
  {
    title: "Scheduled tasks",
    body: "Repeat jobs are already built in, so agents keep working when you're away.",
  },
  {
    title: "Multiple agents",
    body: "Run more than one specialized agent from one account instead of paying for separate products and setups.",
  },
] as const;

export default function FeaturesPage() {
  return (<PublicSite className={styles.page} data-page="features"><StructuredData schema={breadcrumbSchema} /><main className={styles.main} id="main-content"><Breadcrumbs items={[{ label: "Features" }]} /><header className={styles.masthead}><span className={styles.eyebrow}>Platform Features</span><h1>Everything pre-configured. <strong>Nothing to set up.</strong></h1><p>Hivra runs Hermes, OpenClaw, Claude Code, Codex and other agents. For Hermes on paid plans, memory, browsing and schedules come set up. No plug-ins, no settings files, no manual to read first.</p></header><div className={styles.indexHead}><h2>What you get on day one</h2><Link href="/pricing">See Pricing</Link></div><div className={styles.introGrid}>{quickSummary.map(({ title, body }) => <div key={title}><h2>{title}</h2><p>{body}</p></div>)}</div><p className={styles.directoryAction}><Link href={PUBLIC_START_HREF} className={styles.button}>Start Deploying <ArrowUpRight size={20} aria-hidden="true" /></Link></p>
  <div className={styles.directory}>{features.map(({ slug, title, tagline, description }, index) => <Link key={slug} href={`/features/${slug}`}><span>{String(index + 1).padStart(2, "0")}</span><h2>{title}</h2><div><h3>{tagline}</h3><p>{description}</p><span className={styles.readLink}>Learn more<ArrowUpRight size={20} aria-hidden="true" /></span></div></Link>)}</div>
  <section className={styles.cta}><p>From $9.99/mo for 2 vCPU and 4 GB. 7-day money-back guarantee on card payments.</p><Link href={PUBLIC_START_HREF} className={styles.button}>Deploy My Agent<ArrowUpRight size={20} aria-hidden="true" /></Link></section><EditorialRelated title="See also:" links={[{ label: "Pricing", href: "/pricing" }, { label: "Hivra vs alternatives", href: "/compare" }]} /></main></PublicSite>);
}
