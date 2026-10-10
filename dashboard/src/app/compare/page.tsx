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
import { COMPETITOR_FACTS_CHECKED, PRICE_TABLE, formatCheckedMonth } from "@/lib/compare/competitor-facts";

export const metadata: Metadata = {
  title: "Hivra vs Alternatives: AI Agent Hosting Comparison",
  description:
    "Hivra compared with Agent 37, Hostinger, xCloud, Nous Hermes Cloud, self-hosting, Railway and Render, with prices checked against each vendor's own pages.",
  ...buildWebsiteMetadata({
    path: "/compare",
    title: "Hivra vs Alternatives: AI Agent Hosting Comparison",
    description:
      "Hivra compared with Agent 37, Hostinger, xCloud, Nous Hermes Cloud, self-hosting, Railway and Render for running persistent AI agents.",
  }),
};

const comparisons = [
  {
    slug: "vs-agent-37",
    title: "Hivra vs Agent 37",
    tagline: "Metered API or flat monthly price.",
    description:
      "Agent 37 is cheaper on raw compute, and it has a free tier and a SOC 2 Type I report. Hivra charges a flat monthly price and is open source. Both keep an agent running when your laptop is closed.",
  },
  {
    slug: "vs-hostinger",
    title: "Hivra vs Hostinger",
    tagline: "Prepaid low price or monthly flat price.",
    description:
      "Hostinger's managed plan is $5.99 a month on a 24-month prepaid term, then renews at $11.99. It doesn't publish the managed plan's size. Its VPS is the better buy if you'll commit for two years or want root access.",
  },
  {
    slug: "vs-xcloud",
    title: "Hivra vs xCloud",
    tagline: "More hardware on promotion, or a fixed monthly price.",
    description:
      "xCloud gives you 4 vCPU and 6 GB of RAM for $9.99 a month on promotion. Its docs still call OpenClaw hosting a beta, and you have to request a refund. Checked against its own pages.",
  },
  {
    slug: "vs-nous-hermes-cloud",
    title: "Hivra vs Nous Hermes Cloud",
    tagline: "The maker's own hosting, or a flat price for more agents.",
    description:
      "Nous Hermes Cloud bills by the second and costs about $16.80 over 30 days for the Medium size, plus model usage. Hivra hosts Hermes and other agents at a flat monthly price. Not affiliated.",
  },
  {
    slug: "vs-self-hosted",
    title: "Hivra vs Self-Hosted VPS",
    tagline: "You get control, and you pay for it in time.",
    description:
      "Running Hermes yourself on a server you rent from Hetzner or DigitalOcean costs less each month. But the setup, the upkeep and the midnight debugging add up. Hivra hosting starts at $9.99/mo for 2 vCPU and 4 GB.",
  },
  {
    slug: "vs-railway",
    title: "Hivra vs Railway",
    tagline: "Generic cloud vs. purpose-built agent hosting.",
    description:
      "Railway is a good generic cloud platform that wasn't built for Hermes agents, so it has no agent dashboard, no multi-agent profiles and no ready-made Hermes setup. You'd build all of that yourself.",
  },
  {
    slug: "vs-render",
    title: "Hivra vs Render",
    tagline: "Hermes on Render's one-click template, or on a Hivra computer.",
    description:
      "Render has a one-click Hermes template that runs on its $25 Standard plan, with no login in front of the dashboard. Hivra starts at $9.99 for 2 vCPU and 4 GB with Hermes installed.",
  },
  {
    slug: "openclaw-to-hermes",
    title: "Migrating from OpenClaw to Hivra",
    tagline: "Keep your agent, skip the maintenance.",
    description:
      "OpenClaw is open-source software that you run and update yourself. Hivra can host OpenClaw for you, or you can move to Hermes with Hermes' own migration command.",
  },
  {
    slug: "ai-agent-hosting-alternatives",
    title: "AI Agent Hosting Alternatives Compared (2026)",
    tagline: "Criteria first. Dated prices across the main hosts.",
    description:
      "A bare rented server, a fully managed platform, or something in between: the main options for hosting an AI agent that keeps running in 2026, and what each costs in money, setup work and upkeep.",
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
  return (<PublicSite className={styles.page} data-page="compare"><StructuredData schema={breadcrumbSchema} /><main className={styles.main} id="main-content"><Breadcrumbs items={[{ label: "Compare" }]} /><header className={styles.masthead}><span className={styles.eyebrow}>Comparisons</span><h1>Hivra vs <strong>the alternatives.</strong></h1><p>We&apos;ll tell you when self-hosting makes more sense, and what it costs in time when it doesn&apos;t.</p></header>
  <div className={styles.directory}>{comparisons.map(({ slug, title, tagline, description }, index) => <Link key={slug} href={`/compare/${slug}`}><span>{String(index + 1).padStart(2, "0")}</span><h2>{title}</h2><div><h3>{tagline}</h3><p>{description}</p><span className={styles.readLink}>Read comparison<ArrowUpRight size={20} aria-hidden="true" /></span></div></Link>)}</div>
  <section aria-labelledby="price-table-heading"><h2 id="price-table-heading">What does each host cost?</h2><p>Sizes differ between providers, so each row states its own. Prices are in US dollars, straight from each provider&apos;s own pages, as of <time dateTime={COMPETITOR_FACTS_CHECKED}>{formatCheckedMonth()}</time>. Model usage is extra unless a row says otherwise. Cloudways isn&apos;t listed, because its page doesn&apos;t say whether its prices already include its launch discount.</p><div className={styles.tableScroll} role="region" aria-label="Price table" tabIndex={0}><table><thead><tr><th scope="col">Provider</th><th scope="col">Price for the size</th><th scope="col">Billing and what it leaves out</th><th scope="col">Source</th></tr></thead><tbody>{PRICE_TABLE.map(({ provider, price, terms, source }, index) => <tr key={`${provider}-${index}`}><th scope="row">{provider}</th><td>{price}</td><td>{terms}</td><td>{source.href.startsWith("/") ? <Link href={source.href}>{source.label}</Link> : <a href={source.href} rel="noopener noreferrer">{source.label}</a>}</td></tr>)}</tbody></table></div></section>
  <section className={styles.cta}><p>From $9.99/mo for 2 vCPU and 4 GB. 7-day money-back guarantee on card payments.</p><Link href={PUBLIC_START_HREF} className={styles.button}>Deploy My Agent<ArrowUpRight size={20} aria-hidden="true" /></Link></section><EditorialRelated title="See also:" links={[{ label: "Pricing", href: "/pricing" }, { label: "All Hivra features", href: "/features" }]} /></main></PublicSite>);
}
