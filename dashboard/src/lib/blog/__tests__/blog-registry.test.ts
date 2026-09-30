import fs from "fs";
import path from "path";

import { BLOG_ARTICLES, BLOG_ARTICLES_LIST } from "@/lib/blog-data";
import { generateStaticParams as featureParams } from "@/app/features/[slug]/page";
import { generateStaticParams as compareParams } from "@/app/compare/[slug]/page";

import { CUTOVER_BLOG_SLUGS } from "./cutover-slugs";

// Routes other cutover work adds. Blog links may point at these; anything else
// must already exist in this app.
const PORTED_AGENT_SLUGS = ["hermes", "claude-code", "codex", "aeon", "openclaw", "agent-zero"];
const PORTED_TOOL_SLUGS = [
  "agent-survival-check",
  "ai-agent-hosting-cost-calculator",
  "claude-code-limit-reset-calculator",
  "claude-code-plan-calculator",
];

const APP_ROOT = path.join(__dirname, "..", "..", "..", "app");

function staticRouteExists(pathname: string): boolean {
  if (pathname === "/") return true;
  const dir = path.join(APP_ROOT, ...pathname.split("/").filter(Boolean));
  return fs.existsSync(path.join(dir, "page.tsx")) || fs.existsSync(path.join(dir, "route.ts"));
}

function internalLinks(copy: string): string[] {
  return [...copy.matchAll(/\]\((\/[^)\s]*)\)/g)].map((match) => match[1]);
}

function resolvesInternally(href: string, featureSlugs: Set<string>, compareSlugs: Set<string>): boolean {
  const [pathname] = href.split(/[?#]/);
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] === "blog" && segments.length === 2) return segments[1] in BLOG_ARTICLES;
  if (segments[0] === "features" && segments.length === 2) return featureSlugs.has(segments[1]);
  if (segments[0] === "compare" && segments.length === 2) return compareSlugs.has(segments[1]);
  if (segments[0] === "agents" && segments.length === 2) return PORTED_AGENT_SLUGS.includes(segments[1]);
  if (segments[0] === "tools" && segments.length === 2) return PORTED_TOOL_SLUGS.includes(segments[1]);
  if (pathname === "/pricing") return true;
  return staticRouteExists(pathname);
}

describe("blog registry", () => {
  it("registers every cutover post under its own slug", () => {
    for (const slug of CUTOVER_BLOG_SLUGS) {
      expect(BLOG_ARTICLES[slug]).toBeDefined();
      expect(BLOG_ARTICLES[slug].slug).toBe(slug);
    }
  });

  it("keys every article by its own slug, with unique slugs and titles", () => {
    for (const [key, article] of Object.entries(BLOG_ARTICLES)) {
      expect(article.slug).toBe(key);
    }
    const slugs = BLOG_ARTICLES_LIST.map((article) => article.slug);
    const titles = BLOG_ARTICLES_LIST.map((article) => article.title);
    const metaTitles = BLOG_ARTICLES_LIST.map((article) => article.metaTitle ?? article.title);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(titles).size).toBe(titles.length);
    expect(new Set(metaTitles).size).toBe(metaTitles.length);
    expect(BLOG_ARTICLES_LIST).toHaveLength(Object.keys(BLOG_ARTICLES).length);
  });

  it("keeps an article module file for every registered slug", () => {
    for (const slug of Object.keys(BLOG_ARTICLES)) {
      expect(fs.existsSync(path.join(__dirname, "..", "articles", `${slug}.ts`))).toBe(true);
    }
  });

  it("carries real ISO dates, modified on or after publication and not in the future", () => {
    const now = Date.now();
    for (const article of BLOG_ARTICLES_LIST) {
      expect(article.publishedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(article.lastModified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const published = new Date(article.publishedDate).getTime();
      const modified = new Date(article.lastModified).getTime();
      expect(modified).toBeGreaterThanOrEqual(published);
      expect(modified).toBeLessThanOrEqual(now);
    }
  });

  it("never puts the brand suffix in a title: the root title template adds it", () => {
    for (const article of BLOG_ARTICLES_LIST) {
      expect(article.title).not.toMatch(/\|\s*Hivra/);
      expect(article.metaTitle ?? "").not.toMatch(/\|\s*Hivra/);
    }
  });

  it("gives the cutover posts search titles and descriptions that fit a results page", () => {
    for (const slug of CUTOVER_BLOG_SLUGS) {
      const article = BLOG_ARTICLES[slug];
      expect((article.metaTitle ?? article.title).length).toBeLessThanOrEqual(55);
      expect(article.metaDescription.length).toBeLessThanOrEqual(155);
      expect(article.faqs.length).toBeGreaterThan(0);
    }
  });

  it("writes the cutover posts without em or en dashes", () => {
    for (const slug of CUTOVER_BLOG_SLUGS) {
      expect(JSON.stringify(BLOG_ARTICLES[slug])).not.toMatch(/[\u2013\u2014]/);
    }
  });

  it("links only to routes that exist or that the cutover adds", () => {
    const featureSlugs = new Set(featureParams().map(({ slug }) => slug));
    const compareSlugs = new Set(compareParams().map(({ slug }) => slug));
    const broken: string[] = [];
    for (const article of BLOG_ARTICLES_LIST) {
      const hrefs = [
        ...article.sections.flatMap((section) => section.paragraphs.flatMap(internalLinks)),
        ...article.relatedArticles.map(({ slug }) => `/blog/${slug}`),
        ...(article.relatedFeatures ?? []).map(({ slug }) => `/features/${slug}`),
        ...(article.relatedComparisons ?? []).map(({ slug }) => `/compare/${slug}`),
      ];
      for (const href of hrefs) {
        if (!resolvesInternally(href, featureSlugs, compareSlugs)) broken.push(`${article.slug} -> ${href}`);
      }
      expect(article.relatedArticles.map(({ slug }) => slug)).not.toContain(article.slug);
    }
    expect(broken).toEqual([]);
  });
});
