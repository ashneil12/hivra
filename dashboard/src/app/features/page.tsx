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
    "Explore every capability of Hivra: persistent memory, browser automation, multi-agent coordination, scheduled tasks, and zero-markup AI key hosting. All pre-configured. No Docker.",
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
      "Unlike tools that reset on every conversation, Hermes agents retain full context across sessions. Projects, preferences, lessons — all compound over time.",
  },
  {
    slug: "browser-automation",
    title: "Browser Automation",
    tagline: "Your agent can actually browse the web.",
    description:
      "Full browser automation is pre-configured and running from day one. Your agent can research, fill forms, extract data, and interact with any website autonomously.",
  },
  {
    slug: "multi-agent",
    title: "Multi-Agent Coordination",
    tagline: "Multiple agents. One compute pool.",
    description:
      "Run specialized agents from a single compute instance: 3 active agents on Pro, 5 on Power, coordinated without per-seat pricing.",
  },
  {
    slug: "no-docker-hosting",
    title: "No Docker Required",
    tagline: "Deployed in 5 minutes without touching a terminal.",
    description:
      "Hivra handles the entire infrastructure layer. No VPS provisioning, no Docker configs, no Nginx/Caddy setup. Just paste your AI key and go.",
  },
  {
    slug: "openclaw-alternative",
    title: "OpenClaw Migration",
    tagline: "Your OpenClaw setup moves over intact.",
    description:
      "Native migration path from OpenClaw. Your existing agent prompts, skills, and configurations transfer directly. No starting from scratch.",
  },
  {
    slug: "scheduled-tasks",
    title: "Scheduled Tasks & Cron Jobs",
    tagline: "Your agent works while you sleep.",
    description:
      "Define recurring tasks that run on a schedule — email triage, competitive monitoring, data sync, API calls. Full cron support, pre-configured.",
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
    body: "Your agent keeps context across sessions, projects, and follow-up work without a manual reset loop.",
  },
  {
    title: "Browser automation",
    body: "Research, forms, data extraction, and website interaction are available on day one.",
  },
  {
    title: "Scheduled tasks",
    body: "Recurring jobs and cron-style runs are already built in, so agents keep working when you're away.",
  },
  {
    title: "Multi-agent coordination",
    body: "Run specialized agents from one instance instead of paying for separate products and setups.",
  },
] as const;

export default function FeaturesPage() {
  return (<PublicSite className={styles.page} data-page="features"><StructuredData schema={breadcrumbSchema} /><main className={styles.main} id="main-content"><Breadcrumbs items={[{ label: "Features" }]} /><header className={styles.masthead}><span className={styles.eyebrow}>Platform Features</span><h1>Everything pre-configured. <strong>Nothing to set up.</strong></h1><p>Every feature your agent needs is already running when you sign up. No plugins, no config files, no docs to read first.</p></header><div className={styles.indexHead}><h2>What you get on day one</h2><Link href="/#pricing">See Pricing</Link></div><div className={styles.introGrid}>{quickSummary.map(({ title, body }) => <div key={title}><h2>{title}</h2><p>{body}</p></div>)}</div><p className={styles.directoryAction}><Link href={PUBLIC_START_HREF} className={styles.button}>Start Deploying <ArrowUpRight size={20} aria-hidden="true" /></Link></p>
  <div className={styles.directory}>{features.map(({ slug, title, tagline, description }, index) => <Link key={slug} href={`/features/${slug}`}><span>{String(index + 1).padStart(2, "0")}</span><h2>{title}</h2><div><h3>{tagline}</h3><p>{description}</p><span className={styles.readLink}>Learn more<ArrowUpRight size={20} aria-hidden="true" /></span></div></Link>)}</div>
  <section className={styles.cta}><p>7-day money-back guarantee on all plans</p><Link href={PUBLIC_START_HREF} className={styles.button}>Deploy My Agent — From $9.99/mo<ArrowUpRight size={20} aria-hidden="true" /></Link></section><EditorialRelated title="See also:" links={[{ label: "Hivra vs alternatives", href: "/compare" }]} /></main></PublicSite>);
}
