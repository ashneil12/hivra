import type { MetadataRoute } from "next";
import { BLOG_ARTICLES_LIST } from "@/lib/blog-data";
import { AGENT_PAGES_LAST_MODIFIED, AGENT_SEO_SLUGS } from "@/lib/hivra/agent-seo-catalog";
import { dayToDate, PAGE_LAST_MODIFIED } from "@/lib/seo-lastmod";
import { TOOL_ENTRIES } from "@/lib/tools/tool-catalog";
import { HOST_COMPARISON_SLUGS } from "@/lib/compare/host-comparisons";
import { COMPETITOR_FACTS_CHECKED } from "@/lib/compare/competitor-facts";

// SCRIPTURE_ANCHOR: seo-paths | Jeremiah 6:16 | Verse: Stand in the ways and see, and ask for the old paths.
export const SITE_URL = "https://hivra.cloud";

// Sitemap lastmod values come from lib/seo-lastmod.ts (the last real content
// change per page) and from each blog article's own lastModified. They are never
// bumped site-wide and never set to a release date: Google uses lastmod only when
// it is consistently accurate.

// The pages the cutover rewrote (the homepage, the blog index, the privacy
// policy, /pricing, /agents, /tools, /features and /compare) carry at least this
// date. Google compares lastmod with its last crawl of production, which is the
// retired build, so a page that differs from that build must not look older than
// the cutover. If the cutover ships well after this date, move it to the Promote
// date. Pages whose real change is later keep the later date.
export const CUTOVER_LAST_MODIFIED = new Date("2026-09-24");

function cutoverPage(day: string | Date): Date {
  const real = typeof day === "string" ? dayToDate(day) : day;
  return real.getTime() < CUTOVER_LAST_MODIFIED.getTime() ? CUTOVER_LAST_MODIFIED : real;
}

/** The newest real date among the blog articles: what changed on the index. */
function newestArticleDate(): Date {
  return BLOG_ARTICLES_LIST.reduce((newest, article) => {
    const date = new Date(article.lastModified || article.publishedDate);
    return date.getTime() > newest.getTime() ? date : newest;
  }, new Date(0));
}

export function getSiteUrls(): MetadataRoute.Sitemap {
  // Core public pages. The changelog RSS feed is deliberately not listed: a
  // feed is not a page, and it is discovered from /changelog.
  const corePages: MetadataRoute.Sitemap = [
    {
      url: SITE_URL,
      lastModified: cutoverPage(PAGE_LAST_MODIFIED.home),
      changeFrequency: "weekly",
      priority: 1.0,
    },
    {
      // The index changes when an article does.
      url: `${SITE_URL}/blog`,
      lastModified: cutoverPage(newestArticleDate()),
      changeFrequency: "weekly",
      priority: 0.9,
    },
    {
      url: `${SITE_URL}/features`,
      lastModified: cutoverPage(PAGE_LAST_MODIFIED.featuresHub),
      changeFrequency: "weekly",
      priority: 0.9,
    },
    {
      url: `${SITE_URL}/compare`,
      lastModified: cutoverPage(PAGE_LAST_MODIFIED.compareHub),
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/token`,
      lastModified: dayToDate(PAGE_LAST_MODIFIED.token),
      changeFrequency: "monthly",
      priority: 0.2,
    },
    {
      url: `${SITE_URL}/why-hivra`,
      lastModified: dayToDate(PAGE_LAST_MODIFIED.whyHivra),
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      // Public roadmap page.
      url: `${SITE_URL}/roadmap`,
      lastModified: dayToDate(PAGE_LAST_MODIFIED.roadmap),
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      // Public changelog page (the HTML view).
      url: `${SITE_URL}/changelog`,
      lastModified: dayToDate(PAGE_LAST_MODIFIED.changelog),
      changeFrequency: "weekly",
      priority: 0.7,
    },
    {
      // Live platform-health page (public, signed-out accessible).
      url: `${SITE_URL}/status`,
      lastModified: dayToDate(PAGE_LAST_MODIFIED.status),
      changeFrequency: "weekly",
      priority: 0.4,
    },
    {
      // Live deploy-counter / public stats page.
      url: `${SITE_URL}/stats`,
      lastModified: dayToDate(PAGE_LAST_MODIFIED.stats),
      changeFrequency: "weekly",
      priority: 0.4,
    },
    {
      // The entity home: who and what Hivra is, formerly HermesOS, contact.
      url: `${SITE_URL}/about`,
      lastModified: dayToDate(PAGE_LAST_MODIFIED.about),
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      // How to report a vulnerability; /.well-known/security.txt points here.
      url: `${SITE_URL}/security`,
      lastModified: dayToDate(PAGE_LAST_MODIFIED.security),
      changeFrequency: "monthly",
      priority: 0.3,
    },
    {
      url: `${SITE_URL}/privacy`,
      lastModified: cutoverPage(PAGE_LAST_MODIFIED.privacy),
      changeFrequency: "monthly",
      priority: 0.3,
    },
    {
      url: `${SITE_URL}/terms`,
      lastModified: dayToDate(PAGE_LAST_MODIFIED.terms),
      changeFrequency: "monthly",
      priority: 0.3,
    },
  ];

  // Feature pages
  const featureSlugs = [
    "persistent-memory",
    "browser-automation",
    "multi-agent",
    "no-docker-hosting",
    "openclaw-alternative",
    "scheduled-tasks",
  ];

  const featurePages: MetadataRoute.Sitemap = featureSlugs.map((slug) => ({
    url: `${SITE_URL}/features/${slug}`,
    lastModified: cutoverPage(PAGE_LAST_MODIFIED.featureDetail),
    changeFrequency: "monthly" as const,
    priority: 0.8,
  }));

  // Comparison pages
  const compareSlugs = [
    "vs-self-hosted",
    "vs-railway",
    "vs-render",
    "openclaw-to-hermes",
    "ai-agent-hosting-alternatives",
  ];

  const comparePages: MetadataRoute.Sitemap = [
    ...compareSlugs.map((slug) => ({
      url: `${SITE_URL}/compare/${slug}`,
      lastModified: cutoverPage(PAGE_LAST_MODIFIED.compareDetail),
      changeFrequency: "monthly" as const,
      priority: 0.75,
    })),
    // The host comparisons carry the date their competitor numbers were read
    // (lib/compare/competitor-facts.ts), so a refreshed check moves them.
    ...HOST_COMPARISON_SLUGS.map((slug) => ({
      url: `${SITE_URL}/compare/${slug}`,
      lastModified: cutoverPage(COMPETITOR_FACTS_CHECKED),
      changeFrequency: "monthly" as const,
      priority: 0.75,
    })),
  ];

  // Blog articles: pulled live from the article registry. Each carries its own
  // real lastModified (or its publish date), so none is tied to a release.
  const blogPages: MetadataRoute.Sitemap = BLOG_ARTICLES_LIST.map((article) => ({
    url: `${SITE_URL}/blog/${article.slug}`,
    lastModified: new Date(article.lastModified || article.publishedDate),
    changeFrequency: "monthly" as const,
    priority: 0.8,
  }));

  // Pricing, agent and tool pages were indexed on the retired site and were
  // restored on 2026-09-24 so the cutover does not drop them.
  const pricingPage: MetadataRoute.Sitemap = [
    { url: `${SITE_URL}/pricing`, lastModified: cutoverPage(PAGE_LAST_MODIFIED.pricing), changeFrequency: "weekly", priority: 0.9 },
  ];

  const agentPagesLastModified = cutoverPage(AGENT_PAGES_LAST_MODIFIED);
  const agentPages: MetadataRoute.Sitemap = [
    { url: `${SITE_URL}/agents`, lastModified: agentPagesLastModified, changeFrequency: "weekly", priority: 0.9 },
    ...AGENT_SEO_SLUGS.map((slug) => ({
      url: `${SITE_URL}/agents/${slug}`,
      lastModified: agentPagesLastModified,
      changeFrequency: "weekly" as const,
      priority: 0.85,
    })),
  ];

  const toolPagesLastModified = cutoverPage(PAGE_LAST_MODIFIED.tools);
  const toolPages: MetadataRoute.Sitemap = [
    { url: `${SITE_URL}/tools`, lastModified: toolPagesLastModified, changeFrequency: "monthly", priority: 0.8 },
    ...TOOL_ENTRIES.map((entry) => ({
      url: `${SITE_URL}/tools/${entry.slug}`,
      lastModified: toolPagesLastModified,
      changeFrequency: "monthly" as const,
      priority: 0.8,
    })),
  ];

  return [...corePages, ...pricingPage, ...agentPages, ...toolPages, ...featurePages, ...comparePages, ...blogPages];
}
