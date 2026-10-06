import {
  COMPETITOR_FACTS,
  COMPETITOR_FACTS_CHECKED,
  PRICE_TABLE,
  formatCheckedDate,
  formatCheckedMonth,
} from "../competitor-facts";
import { HOST_COMPARISONS, HOST_COMPARISON_SLUGS } from "../host-comparisons";
import { MAX_META_DESCRIPTION_LENGTH } from "@/app/features/__tests__/public-claims";
import {
  ENTRY_PLAN_PRICE,
  ENTRY_PLAN_SIZE,
  LARGER_PLAN_PRICE,
  LARGER_PLAN_SIZE,
} from "@/lib/blog/plan-facts";

const DASHES = /[‐-―−]/;

function pageText(slug: (typeof HOST_COMPARISON_SLUGS)[number]): string {
  const c = HOST_COMPARISONS[slug];
  return [
    c.title,
    c.h1,
    c.metaDescription,
    c.tagline,
    ...c.intro,
    ...c.sections.flatMap((s) => [s.heading, ...s.paragraphs]),
    ...c.vsTable.flatMap((r) => [r.criterion, r.hermesOs, r.other]),
    c.verdict,
    ...c.faqs.flatMap((f) => [f.q, f.a]),
  ].join("\n");
}

describe("competitor facts", () => {
  it("carries an ISO check date that formats for readers", () => {
    expect(COMPETITOR_FACTS_CHECKED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(formatCheckedDate("2026-09-30")).toBe("30 September 2026");
  });

  it("gives every host comparison a fact record, sources over https and a page that quotes the key figures", () => {
    expect(HOST_COMPARISON_SLUGS.sort()).toEqual(Object.keys(COMPETITOR_FACTS).sort());
    for (const slug of HOST_COMPARISON_SLUGS) {
      const facts = COMPETITOR_FACTS[slug];
      expect(facts.sources.length).toBeGreaterThanOrEqual(3);
      for (const source of facts.sources) expect(source.href).toMatch(/^https:\/\//);
      expect(HOST_COMPARISONS[slug].factSources).toEqual(facts.sources);
      const text = pageText(slug);
      for (const figure of facts.keyFigures) expect([slug, figure, text.includes(figure)]).toEqual([slug, figure, true]);
    }
  });

  it("drops Agent 37 facts its pages no longer state (re-checked 2026-10-02)", () => {
    const text = pageText("vs-agent-37");
    // The free tier's weekly awake cap is no longer on agent37.com, and managed plans now list Claude Code and Codex.
    expect(text).not.toMatch(/hours a week/);
    expect(text).not.toMatch(/not something its pages confirmed/);
    expect(COMPETITOR_FACTS["vs-agent-37"].sources.map((s) => s.href)).toContain("https://agent37.com/personal");
  });

  it("stamps every host page's meta description with a plain \"as of\" month, never a read-on date", () => {
    expect(formatCheckedMonth("2026-10-02")).toBe("October 2026");
    for (const slug of HOST_COMPARISON_SLUGS) {
      const meta = HOST_COMPARISONS[slug].metaDescription;
      expect([slug, meta.includes(`Prices as of ${formatCheckedMonth()}.`)]).toEqual([slug, true]);
      expect([slug, /\b(?:read|checked)(?: on)? \d{1,2} \w+ 20\d\d/i.test(meta)]).toEqual([slug, false]);
    }
  });

  it("keeps every host page within search limits and free of dashes", () => {
    for (const slug of HOST_COMPARISON_SLUGS) {
      const c = HOST_COMPARISONS[slug];
      expect(c.metaDescription.length).toBeLessThanOrEqual(MAX_META_DESCRIPTION_LENGTH);
      expect(c.title.length).toBeLessThanOrEqual(62);
      expect(DASHES.test(pageText(slug))).toBe(false);
    }
  });

  it("states Hivra's own price with the size it buys, matching checkout", () => {
    for (const slug of HOST_COMPARISON_SLUGS) {
      const text = pageText(slug);
      expect(text).toContain(ENTRY_PLAN_PRICE);
      expect(text).toMatch(/2 vCPU and 4 GB/);
    }
    expect(ENTRY_PLAN_SIZE).toBe("2 vCPU and 4 GB of RAM");
    expect(LARGER_PLAN_SIZE).toBe("4 vCPU and 8 GB of RAM");
    expect([ENTRY_PLAN_PRICE, LARGER_PLAN_PRICE]).toEqual(["$9.99", "$19.99"]);
    const hivraRows = PRICE_TABLE.filter((row) => row.hivra).map((row) => row.price);
    expect(hivraRows).toEqual([
      `${ENTRY_PLAN_PRICE}/mo for 2 vCPU and 4 GB RAM`,
      `${LARGER_PLAN_PRICE}/mo for 4 vCPU and 8 GB RAM`,
    ]);
  });

  it("names where each other provider is the better choice", () => {
    for (const slug of HOST_COMPARISON_SLUGS) {
      const c = HOST_COMPARISONS[slug];
      expect(c.vsTable.some((row) => !row.hermosWins)).toBe(true);
      expect(c.sections.some((s) => /better (choice|fit)|wins/i.test(s.heading + s.paragraphs.join(" ")))).toBe(true);
    }
  });

  it("never presents Hivra as Nous's product", () => {
    const text = pageText("vs-nous-hermes-cloud");
    expect(text).toMatch(/not affiliated with Nous Research/i);
    expect(text).toMatch(/Nous Hermes Cloud is run by Nous Research/);
  });

  it("builds a price table with a source per row, sizes in the price cell and no price after a stale date", () => {
    expect(PRICE_TABLE.length).toBeGreaterThanOrEqual(8);
    for (const row of PRICE_TABLE) {
      expect(row.source.href).toMatch(/^(https:\/\/|\/pricing$)/);
      expect(DASHES.test(`${row.provider}${row.price}${row.terms}`)).toBe(false);
    }
    for (const row of PRICE_TABLE.filter((r) => r.price.includes("$19.99"))) {
      expect(row.price).toMatch(/4 vCPU/);
    }
  });
});
