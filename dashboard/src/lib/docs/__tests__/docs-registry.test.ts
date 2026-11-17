import fs from "fs";
import path from "path";

import { BLOG_ARTICLES } from "@/lib/blog-data";
import { DOCS, DOCS_IN_ORDER, DOC_SECTIONS } from "@/lib/docs/registry";
import type { DocPage } from "@/lib/docs/types";
import { ALL_AGENTS, getAgent } from "@/lib/hivra/agent-catalog";
import { AGENT_SEO_ENTRIES } from "@/lib/hivra/agent-seo-catalog";
import { TOOL_ENTRIES } from "@/lib/tools/tool-catalog";
import {
  bannedAboutHivra,
  bannedAnywhere,
  bareYesHivraLaptopRows,
  hivraTablePricesWithoutSize,
} from "@/lib/blog/claim-rules";
import { falseCliRunClaims, unknownDashboardNames } from "@/lib/blog/runtime-facts";

const APP_ROOT = path.join(__dirname, "..", "..", "..", "app");

function docCopy(doc: DocPage): string {
  return [
    doc.title,
    doc.metaTitle ?? "",
    doc.metaDescription,
    doc.summary,
    ...doc.blocks.flatMap((block) => [block.heading, ...block.paragraphs]),
    ...(doc.faqs ?? []).flatMap(({ q, a }) => [q, a]),
  ].join("\n");
}

function staticRouteExists(pathname: string): boolean {
  if (pathname === "/") return true;
  const dir = path.join(APP_ROOT, ...pathname.split("/").filter(Boolean));
  return fs.existsSync(path.join(dir, "page.tsx")) || fs.existsSync(path.join(dir, "route.ts"));
}

const PUBLIC_ROOT = path.join(__dirname, "..", "..", "..", "..", "public");

function resolves(href: string): boolean {
  const [pathname] = href.split(/[?#]/);
  if (pathname.startsWith("/images/docs/")) return fs.existsSync(path.join(PUBLIC_ROOT, pathname));
  const segments = pathname.split("/").filter(Boolean);
  if (pathname === "/docs" || pathname === "/sign-up" || pathname === "/sign-in") return true;
  if (segments[0] === "docs" && segments.length === 2) return segments[1] in DOCS;
  if (segments[0] === "blog" && segments.length === 2) return segments[1] in BLOG_ARTICLES;
  if (segments[0] === "agents" && segments.length === 2) return AGENT_SEO_ENTRIES.some((entry) => entry.slug === segments[1]);
  if (segments[0] === "tools" && segments.length === 2) return TOOL_ENTRIES.some((entry) => entry.slug === segments[1]);
  return staticRouteExists(pathname);
}

const AGENT_DOCS = DOC_SECTIONS.find((section) => section.id === "agents")!.docs;

describe("docs hub", () => {
  it("lists every doc in exactly one section, under the section the doc names", () => {
    const listed = DOC_SECTIONS.flatMap((section) => section.docs.map((slug) => ({ slug, section: section.id })));
    expect(new Set(listed.map(({ slug }) => slug)).size).toBe(listed.length);
    expect(listed.map(({ slug }) => slug).sort()).toEqual(Object.keys(DOCS).sort());
    for (const { slug, section } of listed) expect(DOCS[slug].section).toBe(section);
    expect(DOCS_IN_ORDER).toHaveLength(Object.keys(DOCS).length);
  });

  it("keys every doc by its own slug, with unique titles and a page module per slug", () => {
    for (const [slug, doc] of Object.entries(DOCS)) {
      expect(doc.slug).toBe(slug);
      expect(fs.existsSync(path.join(__dirname, "..", "pages", `${slug}.ts`))).toBe(true);
    }
    const titles = Object.values(DOCS).map((doc) => doc.metaTitle ?? doc.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("gives every doc a search title and description that fit a results page, a real date, and no dashes", () => {
    const wrong: string[] = [];
    for (const doc of Object.values(DOCS)) {
      if ((doc.metaTitle ?? doc.title).length > 58) wrong.push(`${doc.slug}: metaTitle over 58`);
      if (/\|\s*Hivra/.test(doc.metaTitle ?? doc.title)) wrong.push(`${doc.slug}: brand suffix in title`);
      if (doc.metaDescription.length > 155 || doc.metaDescription.length < 70) wrong.push(`${doc.slug}: metaDescription ${doc.metaDescription.length}`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(doc.lastReviewed) || new Date(doc.lastReviewed).getTime() > Date.now()) wrong.push(`${doc.slug}: lastReviewed`);
      if (/[–—]/.test(JSON.stringify(doc))) wrong.push(`${doc.slug}: em or en dash`);
      if (doc.blocks.length === 0) wrong.push(`${doc.slug}: no blocks`);
    }
    expect(wrong).toEqual([]);
  });

  it("links only to pages that exist", () => {
    const broken: string[] = [];
    for (const doc of Object.values(DOCS)) {
      for (const [, href] of docCopy(doc).matchAll(/\]\((\/[^)\s]*)\)/g)) {
        if (!resolves(href)) broken.push(`${doc.slug}: ${href}`);
      }
      for (const slug of doc.articles ?? []) if (!(slug in BLOG_ARTICLES)) broken.push(`${doc.slug}: article ${slug}`);
      for (const slug of doc.next ?? []) if (!(slug in DOCS)) broken.push(`${doc.slug}: next ${slug}`);
    }
    expect(broken).toEqual([]);
  });

  it("gives every image alt text and a caption, and keeps each under 400 KB", () => {
    const wrong: string[] = [];
    for (const doc of Object.values(DOCS)) {
      for (const [, alt, src, title] of docCopy(doc).matchAll(/!\[([^\]]*)\]\((\/[^)\s]+)(?:\s+"([^"]*)")?\)/g)) {
        if (alt.trim().length < 10) wrong.push(`${doc.slug}: ${src} alt text too short`);
        if (!title || title.trim().length < 10) wrong.push(`${doc.slug}: ${src} has no caption`);
        const file = path.join(PUBLIC_ROOT, src);
        if (!src.startsWith("/images/docs/")) wrong.push(`${doc.slug}: ${src} is not under /images/docs/`);
        else if (fs.existsSync(file) && fs.statSync(file).size > 400 * 1024) wrong.push(`${doc.slug}: ${src} over 400 KB`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("answers every question in plain text, with no links or markdown", () => {
    const wrong = Object.values(DOCS).flatMap((doc) => (doc.faqs ?? []).filter(({ a }) => /\]\(|[`*_]{2}|^\s*[-*] /m.test(a)).map(({ q }) => `${doc.slug}: ${q}`));
    expect(wrong).toEqual([]);
  });

  it("makes none of the claims the blog may not make", () => {
    const found: string[] = [];
    for (const doc of Object.values(DOCS)) {
      const copy = docCopy(doc);
      for (const label of [
        ...bannedAnywhere(copy),
        ...bannedAboutHivra(copy),
        ...bareYesHivraLaptopRows(copy),
        ...hivraTablePricesWithoutSize(copy),
        ...falseCliRunClaims(copy),
        ...unknownDashboardNames(copy),
      ]) found.push(`${doc.slug}: ${label}`);
    }
    expect(found).toEqual([]);
  });

  it("has a page for every agent in the catalog, with the status docs/STATUS.md gives it", () => {
    const catalogAgents = ALL_AGENTS.filter((agent) => agent.resourceKind !== "computer").map((agent) => agent.id);
    expect([...AGENT_DOCS].sort()).toEqual([...catalogAgents].sort());
    const previews = ["openbot", "nuphos"];
    for (const slug of AGENT_DOCS) {
      const doc = DOCS[slug];
      if (previews.includes(slug)) expect({ slug, status: doc.status }).toEqual({ slug, status: "preview" });
      else if (slug === "deepseek-harness") expect(doc.status).toBe("alpha");
      else expect({ slug, status: doc.status }).toEqual({ slug, status: "available" });
    }
  });

  it("says Hivra is not affiliated with the maker on every page about someone else's agent", () => {
    const missing = AGENT_DOCS.filter((slug) => getAgent(slug)?.vendor !== "Hivra" && !/not affiliated with/i.test(docCopy(DOCS[slug])));
    expect(missing).toEqual([]);
  });
});
