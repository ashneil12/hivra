import { COMPARE_PAGES, COMPARE_PAGE_SLUGS } from "../pages";
import { PRODUCT_COMPARISONS, PRODUCT_COMPARISON_SLUGS } from "../product-comparisons";
import { HOST_COMPARISON_SLUGS } from "../host-comparisons";
import { COMPARE_DIRECTORY } from "../directory";
import { formatCheckedMonth } from "../competitor-facts";
import { PRODUCT_FACTS_CHECKED } from "../products/checked";
import { inlineToPlain } from "../inline";
import type { CompareBlock, ComparePage, GlanceRow } from "../types";
import { AGENT_SEO_SLUGS } from "@/lib/hivra/agent-seo-catalog";
import { DOCS } from "@/lib/docs/registry";
import { BLOG_ARTICLES_LIST } from "@/lib/blog-data";

const NEW_SLUGS = ["vs-claude-code-on-the-web", "vs-openai-codex-cloud", "vs-cursor-cloud-agents", "vs-github-codespaces", "vs-fly-sprites", "vs-e2b", "vs-lobsterland", "vs-construct-computer", "vs-orgo", "vs-machine0", "vs-kiloclaw", "vs-simular-box", "vs-cubicles"];
const MONTH = formatCheckedMonth(PRODUCT_FACTS_CHECKED);

function blocks(page: ComparePage): CompareBlock[] {
  return page.sections.flatMap((section) => section.blocks);
}

function glanceRows(page: ComparePage): GlanceRow[] {
  return blocks(page).flatMap((block) => (block.kind === "glance" ? block.rows : []));
}

function plainText(page: ComparePage): string {
  const parts: string[] = [page.browserTitle, page.h1, page.metaDescription];
  for (const section of page.sections) {
    parts.push(section.heading);
    for (const block of section.blocks) {
      if (block.kind === "p") parts.push(inlineToPlain(block.text));
      else if (block.kind === "entries" || block.kind === "steps") parts.push(...block.items.flatMap((i) => [inlineToPlain(i.lead), inlineToPlain(i.text)]));
      else if (block.kind === "glance") parts.push(...block.rows.flatMap((r) => [r.criterion, inlineToPlain(r.hivra), inlineToPlain(r.alternative)]));
    }
  }
  if (page.sources) parts.push(inlineToPlain(page.sources.intro), ...(page.sources.notes ?? []).map(inlineToPlain));
  parts.push(...page.faqs.flatMap((f) => [f.q, f.a]), inlineToPlain(page.closing.text));
  return parts.join("\n");
}

describe("the twenty-two comparison pages", () => {
  it("registers the six agent product and sandbox pages beside the nine others", () => {
    expect([...PRODUCT_COMPARISON_SLUGS].sort()).toEqual([...NEW_SLUGS].sort());
    expect(COMPARE_PAGE_SLUGS).toHaveLength(22);
    for (const slug of NEW_SLUGS) {
      expect(COMPARE_PAGES[slug]).toBe(PRODUCT_COMPARISONS[slug]);
      expect(COMPARE_PAGES[slug].slug).toBe(slug);
    }
  });

  it("lists every page on the /compare directory exactly once", () => {
    const listed = COMPARE_DIRECTORY.sections.flatMap((s) => s.blocks).flatMap((b) => (b.kind === "providers" ? b.items.map((i) => i.slug) : []));
    expect([...listed].sort()).toEqual([...COMPARE_PAGE_SLUGS].sort());
    expect(new Set(listed).size).toBe(listed.length);
    for (const item of COMPARE_DIRECTORY.sections.flatMap((s) => s.blocks).flatMap((b) => (b.kind === "providers" ? b.items : []))) {
      expect(item.label.length).toBeGreaterThan(2);
      expect(item.text.length).toBeGreaterThan(20);
    }
  });

  it("gives the directory more than two plain-text FAQs", () => {
    expect(COMPARE_DIRECTORY.faqs.length).toBeGreaterThanOrEqual(5);
    for (const faq of COMPARE_DIRECTORY.faqs) {
      expect(faq.a).not.toMatch(/\*\*|`|\]\(|\[[^\]]+\]\(/);
      expect(faq.q.length).toBeGreaterThan(10);
    }
  });

  describe.each(NEW_SLUGS)("/compare/%s", (slug) => {
    const page = COMPARE_PAGES[slug];

    it("has an At a glance table of at least 12 filled rows", () => {
      const rows = glanceRows(page);
      expect(rows.length).toBeGreaterThanOrEqual(12);
      for (const row of rows) {
        expect(row.criterion.trim()).toBeTruthy();
        expect(row.hivra.trim()).toBeTruthy();
        expect(row.alternative.trim()).toBeTruthy();
      }
    });

    it("has at least 7 FAQs, each with an answer in plain text", () => {
      expect(page.faqs.length).toBeGreaterThanOrEqual(7);
      expect(page.faqs.length).toBeLessThanOrEqual(12);
      for (const faq of page.faqs) {
        expect(faq.q.trim()).toBeTruthy();
        expect(faq.a.trim()).toBeTruthy();
        expect(faq.a).not.toMatch(/\*\*|`|\]\(/);
      }
    });

    it("lists sources on https pages and dates them with the month the figures were collected", () => {
      expect(page.sources).toBeDefined();
      expect(page.sources?.links.length).toBeGreaterThanOrEqual(3);
      for (const link of page.sources?.links ?? []) expect(link.href).toMatch(/^https:\/\//);
      expect(page.sources?.checked).toBe(PRODUCT_FACTS_CHECKED);
      expect(page.sources?.intro).toContain(`as of ${MONTH}`);
      expect(plainText(page)).toContain(`in ${MONTH}.`);
      expect(page.metaDescription.endsWith(`Prices as of ${MONTH}.`)).toBe(true);
    });

    it("says where the alternative wins", () => {
      const section = page.sections.find((s) => s.heading === "When the alternative is worth choosing");
      expect(section?.tone).toBe("callout");
      const text = (section?.blocks ?? [])
        .flatMap((b) => (b.kind === "p" ? [inlineToPlain(b.text)] : b.kind === "entries" ? b.items.map((i) => `${inlineToPlain(i.lead)} ${inlineToPlain(i.text)}`) : []))
        .join(" ");
      expect(text).toMatch(/\b(?:better|wins?|best)\b|\bChoose\b/);
      expect(text.length).toBeGreaterThan(300);
    });

    it("states that Hivra is independent and never claims a partnership", () => {
      const text = plainText(page);
      expect(text).toMatch(/not affiliated with/i);
      expect(text).not.toMatch(/official (?:partner|integration|reseller)|in partnership with|(?:is|are) endorsed by|officially (?:supported|certified)|authorised by|authorized by/i);
      expect(text).not.toMatch(/Hivra is (?:an? )?(?:official|certified)/i);
    });

    it("keeps its title, description and wording inside the site's rules", () => {
      expect(page.browserTitle.length).toBeLessThanOrEqual(70);
      expect(page.browserTitle).toMatch(/ \| Hivra$/);
      expect(page.metaDescription.length).toBeLessThanOrEqual(155);
      expect(page.metaDescription.length).toBeGreaterThanOrEqual(100);
      expect(plainText(page)).not.toMatch(/[‐-―−]/);
    });
  });

  describe.each(COMPARE_PAGE_SLUGS)("related links on /compare/%s", (slug) => {
    const page = COMPARE_PAGES[slug];
    const hrefs = page.related.map((link) => link.href);

    it("links 2 to 4 sibling comparisons, none of them itself, all registered", () => {
      const siblings = hrefs.filter((h) => h.startsWith("/compare/"));
      expect(siblings.length).toBeGreaterThanOrEqual(2);
      expect(siblings.length).toBeLessThanOrEqual(4);
      expect(siblings).not.toContain(`/compare/${slug}`);
      for (const href of siblings) expect(COMPARE_PAGE_SLUGS).toContain(href.slice("/compare/".length));
    });

    it("links pricing, an agent page, a docs page and a blog post that exist", () => {
      expect(hrefs).toContain("/pricing");
      const agents = hrefs.filter((h) => h.startsWith("/agents/"));
      const docs = hrefs.filter((h) => h.startsWith("/docs/"));
      const blog = hrefs.filter((h) => h.startsWith("/blog/"));
      expect(agents.length).toBeGreaterThanOrEqual(1);
      expect(docs.length).toBeGreaterThanOrEqual(1);
      expect(blog.length).toBeGreaterThanOrEqual(1);
      for (const h of agents) expect(AGENT_SEO_SLUGS as string[]).toContain(h.slice("/agents/".length));
      for (const h of docs) expect(Object.keys(DOCS)).toContain(h.slice("/docs/".length));
      const blogSlugs = new Set(BLOG_ARTICLES_LIST.map((a) => a.slug));
      for (const h of blog) expect(blogSlugs.has(h.slice("/blog/".length))).toBe(true);
      for (const link of page.related) expect(link.label).not.toMatch(/undefined/);
    });
  });

  it("keeps the host slugs and the product slugs apart", () => {
    for (const slug of HOST_COMPARISON_SLUGS) expect(PRODUCT_COMPARISON_SLUGS).not.toContain(slug);
  });
});
