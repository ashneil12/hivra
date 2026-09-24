import type { MetadataRoute } from "next";
import { BLOG_ARTICLES_LIST } from "@/lib/blog-data";
import { AGENT_PAGES_LAST_MODIFIED, AGENT_SEO_SLUGS } from "@/lib/hivra/agent-seo-catalog";
import { TOOL_ENTRIES } from "@/lib/tools/tool-catalog";

// SCRIPTURE_ANCHOR: seo-paths | Jeremiah 6:16 | Verse: Stand in the ways and see, and ask for the old paths.
export const SITE_URL = "https://hivra.cloud";

// Last substantive update to the core marketing surfaces (brand-bridge metadata
// refresh, 2026-07). Bump this when the key pages genuinely change — blog posts
// carry their own real per-article dates below and are NOT tied to this.
const CORE_PAGES_LAST_MODIFIED = new Date("2026-07-07");

// The /features and /compare pages (hubs and details) were rewritten in the
// 2026-09-24 truth pass: speed, backup, import and price claims removed, FAQs
// changed. Crawlers only recrawl on a newer lastmod, so these must carry the
// rewrite date. If the cutover ships well after this date, move it to the
// Promote date: Google compares lastmod with its last crawl of production.
const FEATURE_COMPARE_LAST_MODIFIED = new Date("2026-09-24");

export function getSiteUrls(): MetadataRoute.Sitemap {
  // Core public pages
  const corePages: MetadataRoute.Sitemap = [
    {
      url: SITE_URL,
      lastModified: CORE_PAGES_LAST_MODIFIED,
      changeFrequency: "weekly",
      priority: 1.0,
    },
    {
      url: `${SITE_URL}/blog`,
      lastModified: CORE_PAGES_LAST_MODIFIED,
      changeFrequency: "weekly",
      priority: 0.9,
    },
    {
      url: `${SITE_URL}/features`,
      lastModified: FEATURE_COMPARE_LAST_MODIFIED,
      changeFrequency: "weekly",
      priority: 0.9,
    },
    {
      url: `${SITE_URL}/compare`,
      lastModified: FEATURE_COMPARE_LAST_MODIFIED,
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/token`,
      lastModified: new Date("2026-04-17"),
      changeFrequency: "monthly",
      priority: 0.2,
    },
    {
      url: `${SITE_URL}/why-hivra`,
      lastModified: CORE_PAGES_LAST_MODIFIED,
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      // Public roadmap page.
      url: `${SITE_URL}/roadmap`,
      lastModified: CORE_PAGES_LAST_MODIFIED,
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      // Public changelog page (the HTML view; the RSS feed below is separate).
      url: `${SITE_URL}/changelog`,
      lastModified: new Date("2026-06-22"),
      changeFrequency: "weekly",
      priority: 0.7,
    },
    {
      // Public RSS feed for the changelog (auto-discovered from /changelog too).
      url: `${SITE_URL}/changelog/rss.xml`,
      lastModified: new Date("2026-06-21"),
      changeFrequency: "weekly",
      priority: 0.4,
    },
    {
      // Live platform-health page (public, signed-out accessible).
      url: `${SITE_URL}/status`,
      lastModified: new Date("2026-06-22"),
      changeFrequency: "weekly",
      priority: 0.4,
    },
    {
      // Live deploy-counter / public stats page.
      url: `${SITE_URL}/stats`,
      lastModified: new Date("2026-06-22"),
      changeFrequency: "weekly",
      priority: 0.4,
    },
    {
      url: `${SITE_URL}/privacy`,
      lastModified: new Date("2026-03-01"),
      changeFrequency: "monthly",
      priority: 0.3,
    },
    {
      url: `${SITE_URL}/terms`,
      lastModified: new Date("2026-03-01"),
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
    lastModified: FEATURE_COMPARE_LAST_MODIFIED,
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

  const comparePages: MetadataRoute.Sitemap = compareSlugs.map((slug) => ({
    url: `${SITE_URL}/compare/${slug}`,
    lastModified: FEATURE_COMPARE_LAST_MODIFIED,
    changeFrequency: "monthly" as const,
    priority: 0.75,
  }));

  // Blog articles — pulled live from the article registry (always up to date)
  const blogPages: MetadataRoute.Sitemap = BLOG_ARTICLES_LIST.map((article) => ({
    url: `${SITE_URL}/blog/${article.slug}`,
    lastModified: new Date(article.lastModified || article.publishedDate),
    changeFrequency: "monthly" as const,
    priority: 0.8,
  }));

  // Pricing, agent and tool pages were indexed on the retired site and were
  // restored on 2026-09-24 so the cutover does not drop them.
  const restoredPagesLastModified = new Date("2026-09-24");
  const pricingPage: MetadataRoute.Sitemap = [
    { url: `${SITE_URL}/pricing`, lastModified: restoredPagesLastModified, changeFrequency: "weekly", priority: 0.9 },
  ];

  const agentPagesLastModified = new Date(AGENT_PAGES_LAST_MODIFIED);
  const agentPages: MetadataRoute.Sitemap = [
    { url: `${SITE_URL}/agents`, lastModified: agentPagesLastModified, changeFrequency: "weekly", priority: 0.9 },
    ...AGENT_SEO_SLUGS.map((slug) => ({
      url: `${SITE_URL}/agents/${slug}`,
      lastModified: agentPagesLastModified,
      changeFrequency: "weekly" as const,
      priority: 0.85,
    })),
  ];

  const toolPages: MetadataRoute.Sitemap = [
    { url: `${SITE_URL}/tools`, lastModified: restoredPagesLastModified, changeFrequency: "monthly", priority: 0.8 },
    ...TOOL_ENTRIES.map((entry) => ({
      url: `${SITE_URL}/tools/${entry.slug}`,
      lastModified: restoredPagesLastModified,
      changeFrequency: "monthly" as const,
      priority: 0.8,
    })),
  ];

  return [...corePages, ...pricingPage, ...agentPages, ...toolPages, ...featurePages, ...comparePages, ...blogPages];
}
