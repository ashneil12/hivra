import {
  COMPETITOR_FACTS,
  COMPETITOR_FACTS_CHECKED,
  PRICE_TABLE,
  formatCheckedMonth,
} from "../competitor-facts";
import { COMPARE_DIRECTORY } from "../directory";
import { HOST_COMPARISONS, HOST_COMPARISON_SLUGS } from "../host-comparisons";
import { COMPARE_PAGES } from "../pages";
import { inlineToPlain } from "../inline";
import type { CompareBlock, ComparePage } from "../types";
import { MAX_META_DESCRIPTION_LENGTH } from "@/app/features/__tests__/public-claims";
import {
  ENTRY_PLAN_PRICE,
  ENTRY_PLAN_SIZE,
  LARGER_PLAN_PRICE,
  LARGER_PLAN_SIZE,
} from "@/lib/blog/plan-facts";

const DASHES = /[‐-―−]/;

function blockText(block: CompareBlock): string[] {
  switch (block.kind) {
    case "p":
      return [inlineToPlain(block.text)];
    case "entries":
    case "steps":
      return block.items.flatMap((item) => [inlineToPlain(item.lead), inlineToPlain(item.text)]);
    case "providers":
      return block.items.flatMap((item) => [item.label, inlineToPlain(item.text)]);
    case "glance":
      return block.rows.flatMap((row) => [row.criterion, inlineToPlain(row.hivra), inlineToPlain(row.alternative)]);
    case "priceTable":
      return [];
  }
}

/**
 * Everything a reader (or the JSON-LD) sees on a page, as plain text. `withDescription: false` leaves out the
 * meta description, for a check that the description's own figures appear somewhere else on the page.
 */
function pageText(page: ComparePage, { withDescription = true }: { withDescription?: boolean } = {}): string {
  return [
    page.browserTitle,
    page.h1,
    ...(withDescription ? [page.metaDescription] : []),
    ...page.sections.flatMap((section) => [section.heading, ...section.blocks.flatMap(blockText)]),
    ...(page.sources ? [inlineToPlain(page.sources.intro), ...(page.sources.notes ?? []).map(inlineToPlain)] : []),
    ...page.faqs.flatMap((faq) => [faq.q, faq.a]),
    page.closing.heading,
    inlineToPlain(page.closing.text),
  ].join("\n");
}

describe("competitor facts", () => {
  it("carries an ISO check date that formats for readers as month and year only", () => {
    expect(COMPETITOR_FACTS_CHECKED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(formatCheckedMonth("2026-09-30")).toBe("September 2026");
  });

  it("is not older than the day the Hostinger, Agent 37, xCloud and Nous figures were last re-read (2026-10-21)", () => {
    expect(COMPETITOR_FACTS_CHECKED >= "2026-10-21").toBe(true);
  });

  it("gives every host comparison a fact record, sources over https and a page that quotes the key figures", () => {
    expect(HOST_COMPARISON_SLUGS.sort()).toEqual(Object.keys(COMPETITOR_FACTS).sort());
    for (const slug of HOST_COMPARISON_SLUGS) {
      const facts = COMPETITOR_FACTS[slug];
      expect(facts.sources.length).toBeGreaterThanOrEqual(3);
      for (const source of facts.sources) expect(source.href).toMatch(/^https:\/\//);
      expect(HOST_COMPARISONS[slug].sources?.links).toEqual(facts.sources);
      const text = pageText(HOST_COMPARISONS[slug]);
      for (const figure of facts.keyFigures) expect([slug, figure, text.includes(figure)]).toEqual([slug, figure, true]);
    }
  });

  it("drops Agent 37 facts its pages no longer state (re-checked 2026-10-02)", () => {
    const text = pageText(HOST_COMPARISONS["vs-agent-37"]);
    // The free tier's weekly awake cap is no longer on agent37.com, and managed plans now list Claude Code and Codex.
    expect(text).not.toMatch(/hours a week/);
    expect(text).not.toMatch(/not something its pages confirmed/);
    expect(COMPETITOR_FACTS["vs-agent-37"].sources.map((s) => s.href)).toContain("https://agent37.com/personal");
  });

  it("does not call Agent 37's SOC 2 report published: its own pages disagree about it (audit 2026-10-20)", () => {
    const text = pageText(HOST_COMPARISONS["vs-agent-37"]);
    expect(text).not.toMatch(/published SOC 2/i);
    expect(text).toMatch(/ask for the report/);
  });

  it("quotes Agent 37's plans up to $99.99 and says its trust centre lists SOC 2 as in progress (re-read 2026-10-21)", () => {
    const text = pageText(HOST_COMPARISONS["vs-agent-37"]);
    expect(COMPETITOR_FACTS["vs-agent-37"].keyFigures).toContain("$99.99");
    expect(text).toMatch(/to \$99\.99 a month for teams \(4 vCPU and 16 GB of RAM\)/);
    expect(text).toMatch(/its trust centre lists SOC 2 as in progress/);
    // The plan-name scanner bans "Max plan" (it also catches a rival's tier), so the tier is described, not named.
    expect(text).not.toMatch(/\bMax plan\b/);
  });

  it("quotes Hostinger's current sale prices, not the superseded ones (re-read 2026-10-21)", () => {
    const text = pageText(HOST_COMPARISONS["vs-hostinger"]);
    const table = PRICE_TABLE.map((row) => `${row.provider}\n${row.price}\n${row.terms}`).join("\n");
    expect(COMPETITOR_FACTS["vs-hostinger"].keyFigures).toEqual(["$4.99", "$11.99", "$8.79", "$119.76"]);
    expect(text).toMatch(/promotion is \$4\.99 a month on a 24-month commitment, renewing at \$11\.99/);
    expect(text).toMatch(/\$119\.76 for 24 months, our arithmetic/);
    expect(text).toMatch(/KVM 2 at \$8\.79\/mo/);
    expect(table).toContain("$4.99/mo, size not published");
    expect(table).toContain("$119.76, our arithmetic");
    expect(table).toContain("$8.79/mo for 2 vCPU and 8 GB RAM");
    // The sale label is what the page says; it must not claim the old prices or a live check.
    expect(text).toMatch(/Hostinger shows both the managed plan and the KVM 2 VPS at sale prices/);
    for (const stale of ["$5.99", "$143.76", "$8.99"]) {
      expect([stale, text.includes(stale), table.includes(stale)]).toEqual([stale, false, false]);
    }
  });

  it("lists Paperclip among xCloud's agents, with the xCloud page that sells it as a source (re-read 2026-10-21)", () => {
    const text = pageText(HOST_COMPARISONS["vs-xcloud"]);
    expect(text).toMatch(/OpenClaw, Hermes Agent, DeepSeek Harness, Paperclip/);
    expect(COMPETITOR_FACTS["vs-xcloud"].sources.map((s) => s.href)).toContain("https://xcloud.host/paperclip-hosting/");
  });

  it("calls every Nous per-size figure the last published one in the page and the price table", () => {
    const text = pageText(HOST_COMPARISONS["vs-nous-hermes-cloud"]);
    const row = PRICE_TABLE.find((r) => r.provider === "Nous Hermes Cloud");
    expect(row?.price).toMatch(/^Last published: /);
    expect(row?.terms).toMatch(/only after you sign in to its Portal/);
    // The row links to a page that no longer lists the price, and the table says so.
    expect(row?.terms).toMatch(/linked page no longer lists per-size prices/);
    expect(text).toMatch(/at its last published rate for 4 vCPU and 2 GB RAM/);
    // "Entry size" would claim the 4 vCPU and 2 GB instance is Nous's smallest, which only a rival's blog says.
    expect(text).not.toMatch(/entry size/i);
    expect(text).toMatch(/Always-on cost, smaller size/);
    expect(text).toMatch(/8 vCPU and 4 GB RAM at \$1\.09\/day, as last published/);
    expect(text).toMatch(/Nous Hermes Cloud's last published price for its 4 vCPU and 2 GB instance/);
    // "Largest" would claim Nous lists its sizes; only two tiers are known and they are behind a sign-in.
    expect(text).not.toMatch(/\bLargest\b/);
    expect(COMPETITOR_FACTS["vs-nous-hermes-cloud"].notPublished[0]).toMatch(/Portal sign-in/);
  });

  it("dates every host page's figures with a plain month, never a read-on date", () => {
    expect(formatCheckedMonth("2026-10-02")).toBe("October 2026");
    for (const slug of HOST_COMPARISON_SLUGS) {
      const page = HOST_COMPARISONS[slug];
      const text = pageText(page);
      expect([slug, page.sources?.intro.includes(`as of ${formatCheckedMonth()}`)]).toEqual([slug, true]);
      expect([slug, text.includes(`in ${formatCheckedMonth()}.`)]).toEqual([slug, true]);
      expect([slug, /\b(?:read|checked)(?: on)? \d{1,2} \w+ 20\d\d/i.test(text)]).toEqual([slug, false]);
    }
  });

  it("keeps every host page within search limits and free of dashes", () => {
    for (const slug of HOST_COMPARISON_SLUGS) {
      const page = HOST_COMPARISONS[slug];
      expect(page.metaDescription.length).toBeLessThanOrEqual(MAX_META_DESCRIPTION_LENGTH);
      // 62 characters before the " | Hivra" the layout template used to add, so 70 for the finished title.
      expect([slug, page.browserTitle.length <= 70]).toEqual([slug, true]);
      expect(page.browserTitle).toMatch(/ \| Hivra$/);
      expect(DASHES.test(pageText(page))).toBe(false);
    }
  });

  describe("meta descriptions", () => {
    // [path, description, the rest of the page]. The page text leaves the description out so a figure cannot vouch
    // for itself, and /compare adds its price table, which pageText does not read.
    const priceTableText = PRICE_TABLE.map((row) => `${row.provider}\n${row.price}\n${row.terms}`).join("\n");
    const descriptions: Array<[string, string, string]> = [
      ["/compare", COMPARE_DIRECTORY.metaDescription, `${pageText(COMPARE_DIRECTORY, { withDescription: false })}\n${priceTableText}`],
      ...Object.entries(COMPARE_PAGES).map(([slug, page]): [string, string, string] => [
        `/compare/${slug}`,
        page.metaDescription,
        pageText(page, { withDescription: false }),
      ]),
    ];

    it("covers all ten pages, each with its own description of 155 characters or fewer", () => {
      expect(descriptions).toHaveLength(10);
      expect(new Set(descriptions.map(([, description]) => description)).size).toBe(10);
      for (const [path, description] of descriptions) {
        expect([path, description.length <= MAX_META_DESCRIPTION_LENGTH]).toEqual([path, true]);
        expect([path, description.length >= 100]).toEqual([path, true]);
        expect([path, DASHES.test(description)]).toEqual([path, false]);
      }
    });

    it("ends with the freshness stamp whenever it quotes a price", () => {
      for (const [path, description] of descriptions) {
        if (!/\$\d/.test(description)) continue;
        expect([path, description.endsWith(`Prices as of ${formatCheckedMonth()}.`)]).toEqual([path, true]);
      }
    });

    it("only quotes dollar figures the body of the page carries as well", () => {
      let checked = 0;
      for (const [path, description, body] of descriptions) {
        for (const figure of description.match(/\$\d[\d,]*(?:\.\d+)?/g) ?? []) {
          checked += 1;
          expect([path, figure, body.includes(figure)]).toEqual([path, figure, true]);
        }
      }
      // A description that quoted no figure at all would pass the loop above without checking anything.
      expect(checked).toBeGreaterThanOrEqual(10);
    });

    it("states Hivra's price with its size, never alone", () => {
      for (const [path, description] of descriptions) {
        if (description.includes(ENTRY_PLAN_PRICE)) {
          expect([path, description.includes(ENTRY_PLAN_SIZE)]).toEqual([path, true]);
        }
        expect([path, /\$19\.99/.test(description)]).toEqual([path, false]);
      }
    });

    it("says what a metered or templated price assumes and who says it", () => {
      // Agent 37's $4.76 is the always-on figure; Render's missing login is what its README warns, not our finding.
      expect(HOST_COMPARISONS["vs-agent-37"].metaDescription).toMatch(/\$4\.76 a month, always on/);
      expect(COMPARE_PAGES["vs-render"].metaDescription).toMatch(/its README warns of no default login/);
    });
  });

  it("states Hivra's own price with the size it buys, matching checkout", () => {
    for (const slug of HOST_COMPARISON_SLUGS) {
      const text = pageText(HOST_COMPARISONS[slug]);
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
    const where: Record<(typeof HOST_COMPARISON_SLUGS)[number], RegExp> = {
      "vs-agent-37": /a meter helps when the machine is mostly idle/,
      "vs-hostinger": /Hostinger can be a very sensible choice/,
      "vs-xcloud": /Choose xCloud if its larger promotional server fits/,
      "vs-nous-hermes-cloud": /Use Nous if its native tooling/,
    };
    for (const slug of HOST_COMPARISON_SLUGS) {
      const section = HOST_COMPARISONS[slug].sections.find((s) => s.heading === "When the alternative is worth choosing");
      expect(section).toBeDefined();
      expect([slug, where[slug].test(section?.blocks.flatMap(blockText).join(" ") ?? "")]).toEqual([slug, true]);
    }
  });

  it("never presents Hivra as Nous's product", () => {
    const text = pageText(HOST_COMPARISONS["vs-nous-hermes-cloud"]);
    expect(text).toMatch(/not affiliated with Nous Research/i);
    expect(text).toMatch(/team behind Hermes/);
  });

  it("does not state Nous's portal-only prices as current fact", () => {
    // Nous moved its per-size prices behind a Portal sign-in (audit 2026-10-20), so the page says so and
    // calls the repo's figures the last published ones.
    const text = pageText(HOST_COMPARISONS["vs-nous-hermes-cloud"]);
    expect(text).toMatch(/last published/);
    expect(text).not.toMatch(/\bMedium\b/);
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
