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
  title: "Hivra vs Alternatives: AI Agent Hosting Comparison",
  description:
    "Compare Hivra to self-hosting, Railway, Render, and OpenClaw. Find the right way to host an AI agent such as Hermes, OpenClaw, Claude Code or Codex.",
  ...buildWebsiteMetadata({
    path: "/compare",
    title: "Hivra vs Alternatives: AI Agent Hosting Comparison",
    description:
      "Compare Hivra to self-hosting, Railway, Render, and OpenClaw for running persistent AI agents.",
  }),
};

const comparisons = [
  {
    slug: "vs-self-hosted",
    title: "Hivra vs Self-Hosted VPS",
    tagline: "Control vs. time. The honest tradeoff.",
    description:
      "Self-hosting Hermes on Hetzner or DigitalOcean costs less per month — but hours of setup, ongoing maintenance, and midnight debugging sessions add up. Hivra hosting starts at $9.99/mo for 2 vCPU and 4 GB.",
  },
  {
    slug: "vs-railway",
    title: "Hivra vs Railway",
    tagline: "Generic cloud vs. purpose-built agent hosting.",
    description:
      "Railway is a great generic cloud platform. But it's not built for Hermes agents. No agent dashboard, no multi-agent profiles, no pre-configured Hermes stack. You'd build all of that yourself.",
  },
  {
    slug: "vs-render",
    title: "Hivra vs Render",
    tagline: "Another generic platform that wasn't built for agents.",
    description:
      "Render is a solid general-purpose host. But \"deploy Hermes to Render\" means writing your own Dockerfile, configuring networking, and running without any agent-specific tooling. Hivra is already configured.",
  },
  {
    slug: "openclaw-to-hermes",
    title: "Migrating from OpenClaw to Hivra",
    tagline: "Keep your agent. Leave the maintenance.",
    description:
      "OpenClaw is powerful open-source software, but you run and update it yourself. Hivra can host OpenClaw for you, or you can move to Hermes with Hermes' own migration command.",
  },
  {
    slug: "ai-agent-hosting-alternatives",
    title: "Best AI Agent Hosting Platforms in 2026",
    tagline: "The honest landscape for hosting persistent AI agents.",
    description:
      "From raw VPS to managed platforms, explore every option for hosting a persistent AI agent in 2026 — with honest tradeoffs on cost, setup time, and maintenance burden.",
  },
];

const breadcrumbSchema = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: [
    { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
    { "@type": "ListItem", position: 2, name: "Compare", item: `${SITE_URL}/compare` },
  ],
};

export default function ComparePage() {
  return (<PublicSite className={styles.page} data-page="compare"><StructuredData schema={breadcrumbSchema} /><main className={styles.main} id="main-content"><Breadcrumbs items={[{ label: "Compare" }]} /><header className={styles.masthead}><span className={styles.eyebrow}>Honest Comparisons</span><h1>Hivra vs <strong>everything else.</strong></h1><p>We&apos;ll tell you when self-hosting makes more sense, and what it costs in time when it doesn&apos;t.</p></header>
  <div className={styles.directory}>{comparisons.map(({ slug, title, tagline, description }, index) => <Link key={slug} href={`/compare/${slug}`}><span>{String(index + 1).padStart(2, "0")}</span><h2>{title}</h2><div><h3>{tagline}</h3><p>{description}</p><span className={styles.readLink}>Read comparison<ArrowUpRight size={20} aria-hidden="true" /></span></div></Link>)}</div>
  <section className={styles.cta}><p>From $9.99/mo for 2 vCPU and 4 GB. 7-day money-back guarantee on card payments.</p><Link href={PUBLIC_START_HREF} className={styles.button}>Deploy My Agent<ArrowUpRight size={20} aria-hidden="true" /></Link></section><EditorialRelated title="See also:" links={[{ label: "Pricing", href: "/pricing" }, { label: "All Hivra features", href: "/features" }]} /></main></PublicSite>);
}
