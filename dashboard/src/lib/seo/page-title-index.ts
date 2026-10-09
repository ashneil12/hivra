// src/lib/seo/page-title-index.ts
//
// Path -> title index for every SEO surface this repo owns: the agent
// landing pages and the blog. The decision engine uses it to notice
// when a backlog keyword is already served by a page that shipped
// without anyone back-linking its seo_targets row.
//
// Titles come from the same constants the pages render from, so the
// index cannot drift from what Google actually sees.

import { BLOG_ARTICLES_LIST } from "@/lib/blog-data";
import { AGENT_SEO_ENTRIES } from "@/lib/hivra/agent-seo-catalog";
import type { SeoPageTitleRow } from "@/lib/seo/decision-engine";

/**
 * Every known page path with the title it renders. Sorted by path so
 * the analyst brief stays byte-for-byte deterministic across runs.
 *
 * Tools are intentionally absent: tool-catalog entries live behind a
 * client component map and their keywords are seeded as `live` targets
 * on build, so they never reach the backlog as phantom gaps.
 */
export function buildPageTitleIndex(): SeoPageTitleRow[] {
  const rows: SeoPageTitleRow[] = [
    ...AGENT_SEO_ENTRIES.map((entry) => ({
      path: `/agents/${entry.slug}`,
      title: entry.metaTitle,
    })),
    ...BLOG_ARTICLES_LIST.map((article) => ({
      path: `/blog/${article.slug}`,
      // The h1 is the richer signal; metaTitle is truncated for the SERP.
      title: article.metaTitle ? `${article.title} ${article.metaTitle}` : article.title,
    })),
  ];
  return rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
