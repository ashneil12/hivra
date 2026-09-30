import { BLOG_ARTICLES } from "@/lib/blog-data";
import { article } from "@/lib/blog/articles/claude-max-vs-pro-for-claude-code";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE, LARGER_PLAN_PRICE, LARGER_PLAN_SIZE, MONEY_BACK_GUARANTEE } from "@/lib/blog/plan-facts";
import { CLI_RUN_LIFETIME, falseCliRunClaims, unknownDashboardNames } from "@/lib/blog/runtime-facts";
import { topicForArticle, BLOG_TOPICS } from "@/lib/blog/topics";
import { CLAUDE_PLAN_CHANGELOG, CLAUDE_PLAN_FACTS, OFFICIAL_SOURCE_HOSTS, usd } from "@/lib/tools/claude-plan-facts";
import { getToolEntry } from "@/lib/tools/tool-catalog";

// /blog/claude-max-vs-pro-for-claude-code states Anthropic's prices, limits and
// dates. They come from the same module the plan calculator uses, so this test
// guards two things: that the post stays tied to those constants (a hard-typed
// number that is not one of them fails), and that the constants themselves are
// pinned to literals in lib/tools/__tests__/claude-plan-facts.test.ts.

const F = CLAUDE_PLAN_FACTS;
const SLUG = "claude-max-vs-pro-for-claude-code";

const sectionText = (section: { heading: string; paragraphs: string[] }) => [section.heading, ...section.paragraphs].join("\n");
const sectionByHeading = (prefix: string) => {
  const found = article.sections.find((section) => section.heading.startsWith(prefix));
  if (!found) throw new Error(`no section starting "${prefix}"`);
  return found;
};

const bodyCopy = [
  article.title,
  article.metaTitle ?? "",
  article.metaDescription,
  article.tagline,
  article.intro,
  article.shortAnswer ?? "",
  ...article.sections.map(sectionText),
  ...article.faqs.flatMap(({ q, a }) => [q, a]),
].join("\n");

/** Every markdown link target in the copy. */
function linkTargets(copy: string): string[] {
  return [...copy.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]);
}

describe("registry and wiring", () => {
  it("is registered under its slug and sits in exactly one topic, the one where the cost posts live", () => {
    expect(BLOG_ARTICLES[SLUG]).toBe(article);
    expect(article.slug).toBe(SLUG);
    const topics = BLOG_TOPICS.filter((topic) => topic.articles.includes(SLUG));
    expect(topics.map((topic) => topic.slug)).toEqual(["hosting-and-costs"]);
    expect(topicForArticle(SLUG)?.slug).toBe("hosting-and-costs");
  });

  it("is dated 2026-09-30, the day the facts were read", () => {
    expect(article.publishedDate).toBe("2026-09-30");
    expect(article.lastModified).toBe("2026-09-30");
    expect(article.lastModified).toBe(F.lastVerified);
  });

  it("has a 40 to 60 word short answer, a title within 58 characters and 8 to 11 FAQs", () => {
    const words = (article.shortAnswer ?? "").trim().split(/\s+/).filter(Boolean).length;
    expect(words).toBeGreaterThanOrEqual(40);
    expect(words).toBeLessThanOrEqual(60);
    expect((article.metaTitle ?? article.title).length).toBeLessThanOrEqual(58);
    expect(article.metaDescription.length).toBeGreaterThanOrEqual(70);
    expect(article.metaDescription.length).toBeLessThanOrEqual(155);
    expect(article.faqs.length).toBeGreaterThanOrEqual(8);
    expect(article.faqs.length).toBeLessThanOrEqual(11);
  });

  it("answers the questions people search for", () => {
    const questions = article.faqs.map((faq) => faq.q);
    for (const expected of [
      "Is Claude Code included in Pro?",
      "What are Claude Max limits?",
      "Is Max worth it for Claude Code?",
      "What happens when I hit the Claude Code limit?",
    ]) {
      expect(questions).toContain(expected);
    }
  });

  it("uses no em or en dash anywhere", () => {
    expect(JSON.stringify(article)).not.toMatch(/[–—]/);
  });
});

describe("the post reads its numbers from the calculator's constants", () => {
  it("states each plan price the calculator holds, in the short answer and the plans table", () => {
    const { pro, max5x, max20x } = F.plans;
    expect(article.shortAnswer).toContain(`Pro (${usd(pro.priceUsd)})`);
    expect(article.shortAnswer).toContain(`Max 5x (${usd(max5x.priceUsd)})`);
    expect(article.shortAnswer).toContain(`Max 20x (${usd(max20x.priceUsd)})`);
    const table = sectionByHeading("The plans side by side").paragraphs.join("\n");
    expect(table).toContain(`${usd(pro.priceUsd)} a month, or ${usd(pro.annualMonthlyUsd)} a month on the annual plan (${usd(pro.annualUpfrontUsd)} billed up front)`);
    expect(table).toContain(`${usd(max5x.priceUsd)} a month`);
    expect(table).toContain(`${usd(max20x.priceUsd)} a month`);
    expect(table).toContain(`${max5x.multiplier}x Pro's`);
    expect(table).toContain(`${max20x.multiplier}x Pro's`);
  });

  it("carries the same plan prices as the calculator's own page copy", () => {
    const calculator = JSON.stringify(getToolEntry("claude-code-plan-calculator"));
    for (const plan of Object.values(F.plans)) {
      expect(calculator).toContain(usd(plan.priceUsd));
      expect(bodyCopy).toContain(usd(plan.priceUsd));
    }
    expect(calculator).toContain(`${usd(F.plans.pro.annualMonthlyUsd)} a month on the annual plan`);
    expect(bodyCopy).toContain(`${usd(F.plans.pro.annualMonthlyUsd)} a month on the annual plan`);
  });

  it("prints the break-even days for Anthropic's $13 average and its $30 line, pinned to literals", () => {
    // 20 / 13 = 1.5, 100 / 13 = 7.7, 200 / 13 = 15.4; 20 / 30 = 0.7, 100 / 30 = 3.3, 200 / 30 = 6.7.
    const section = sectionByHeading("API key or subscription").paragraphs.join("\n");
    expect(section).toContain("| Pro | $20 | 1.5 days | 0.7 days |");
    expect(section).toContain("| Max 5x | $100 | 7.7 days | 3.3 days |");
    expect(section).toContain("| Max 20x | $200 | 15.4 days | 6.7 days |");
    expect(section).toContain("break-even active days a month = plan price / API cost per active day");
    expect(article.shortAnswer).toContain("beats Pro below 1.5 active days a month");
  });

  it("works the example from the constants: ten active days at $13 a day is $130", () => {
    const section = sectionByHeading("API key or subscription").paragraphs.join("\n");
    expect(section).toContain("10 active days a month at $13 a day is $130 on the API");
    expect(section).toContain("more than Max 5x's $100 and far more than Pro's $20");
    expect(section).toContain("less than Max 20x's $200");
  });

  it("prints the API price table from the constants, dated", () => {
    const section = sectionByHeading("API key or subscription").paragraphs.join("\n");
    expect(section).toContain("| Fable 5.1 | $10 | $50 | $0.25 | $12.50 |");
    expect(section).toContain("| Opus 5.5 | $4 | $20 | $0.20 | $5 |");
    expect(section).toContain("| Sonnet 5.5 | $2 | $10 | $0.20 | $2.50 |");
    expect(section).toContain("| Haiku 4.5 | $1 | $5 | $0.10 | $1.25 |");
    expect(section).toContain("read on 30 September 2026");
    expect(section).toMatch(/Haiku 5\.5 will join the Claude 5\.5 family in the coming weeks/);
    expect(section).toContain(`${F.anthropicCost.inputToOutputRatio} input tokens for every output token, up from ${F.anthropicCost.inputToOutputRatioBefore}`);
  });

  it("states no dollar amount that is not one of the constants, a computed value or a listed literal", () => {
    const allowed = new Set<string>();
    const add = (value: number) => allowed.add(usd(value));
    for (const plan of Object.values(F.plans)) {
      add(plan.priceUsd);
      if ("annualMonthlyUsd" in plan) {
        add(plan.annualMonthlyUsd);
        add(plan.annualUpfrontUsd);
      }
    }
    for (const [key, value] of Object.entries(F.team)) if (key.endsWith("Usd")) add(value);
    add(F.enterpriseSeatUsd);
    for (const model of Object.values(F.api)) {
      add(model.input);
      add(model.output);
      add(model.cacheRead);
      add(model.cacheWrite5m);
    }
    add(F.anthropicCost.perActiveDayUsd);
    add(F.anthropicCost.p90PerActiveDayUsd);
    add(F.anthropicCost.perMonthLowUsd);
    add(F.anthropicCost.perMonthHighUsd);
    add(10 * F.anthropicCost.perActiveDayUsd);
    // Hivra's own prices come from plan-facts; the rest are dated literals from
    // Anthropic's pages (usage bundles, article of 2026-05-18, and fast mode).
    for (const literal of [ENTRY_PLAN_PRICE, LARGER_PLAN_PRICE, "$45", "$1,000", "$700", "$8", "$40"]) allowed.add(literal);

    const changelog = CLAUDE_PLAN_CHANGELOG.map((row) => row.text).join("\n");
    const stray = [...new Set([...bodyCopy.matchAll(/\$\d+(?:,\d{3})*(?:\.\d+)?/g)].map((match) => match[0]))].filter((amount) => !allowed.has(amount));
    expect({ stray, changelogCoversThem: stray.filter((amount) => changelog.includes(amount)) }).toEqual({ stray: [], changelogCoversThem: [] });
  });

  it("never states a weekly multiple for Max, the community 2x, or a figure from a post on X", () => {
    expect(bodyCopy).not.toMatch(/\b2x\b|twice (?:Pro|the)|about double/i);
    expect(bodyCopy).not.toMatch(/x\.com|twitter\.com|reddit/i);
    expect(bodyCopy).not.toMatch(/Ultra/);
    // The peak-hours reduction is confirmed by Anthropic but its start date and window are not.
    expect(bodyCopy).not.toMatch(/2026-03-26|26 March|05:00|11:00 Pacific/);
    // The weekly limit is never described as a multiple of Pro's.
    expect(bodyCopy).toMatch(/no Anthropic page states a weekly multiple/);
  });
});

describe("the plan changelog section", () => {
  const section = sectionByHeading("What changed and when");
  const text = section.paragraphs.join("\n");

  it("prints every changelog row with its date and a link to the page that states it", () => {
    const rows = text.split("\n").filter((line) => /^\| \d{4}-\d{2}-\d{2} \|/.test(line));
    expect(rows).toHaveLength(CLAUDE_PLAN_CHANGELOG.length);
    CLAUDE_PLAN_CHANGELOG.forEach((entry, index) => {
      expect(rows[index]).toBe(`| ${entry.date} | ${entry.text} | [${entry.source.label}](${entry.source.url}) |`);
      expect(entry.source.url).toMatch(/^https:\/\//);
      expect((OFFICIAL_SOURCE_HOSTS as readonly string[]).includes(new URL(entry.source.url).hostname)).toBe(true);
    });
  });

  it("says when it was last checked and that Anthropic changes plans often", () => {
    expect(text).toContain("Last checked 30 September 2026.");
    expect(text).toContain("Anthropic changes plans often");
    expect(text).toMatch(/news sites or posts on X reported are left out/);
  });

  it("has rows for the changes the calculator depends on", () => {
    for (const date of [F.limitChanges.fiveHourDoubled, F.limitChanges.weeklyRaised, F.limitChanges.fiveHourRaised, F.defaultModel.since]) {
      expect(text).toContain(`| ${date} |`);
    }
  });
});

describe("links", () => {
  const targets = linkTargets(bodyCopy);
  const internal = targets.filter((target) => target.startsWith("/"));
  const external = targets.filter((target) => !target.startsWith("/"));

  it("points at the one calculator URL, the cost post and the 24/7 post, in the body", () => {
    expect(internal).toEqual(expect.arrayContaining(["/tools/claude-code-plan-calculator", "/blog/cost-of-running-ai-agent", "/blog/keep-claude-code-running-24-7"]));
    // One canonical tool URL: no variants, no query string, no copy of the calculator in the post.
    const calculatorLinks = targets.filter((target) => /plan-calculator/.test(target));
    expect(new Set(calculatorLinks)).toEqual(new Set(["/tools/claude-code-plan-calculator"]));
    expect(article.relatedArticles.map((related) => related.slug)).toEqual(expect.arrayContaining(["cost-of-running-ai-agent", "keep-claude-code-running-24-7"]));
  });

  it("links only to routes that exist", () => {
    const allowed = new Set(["/", "/agents/claude-code", "/tools/claude-code-plan-calculator", "/tools/keep-mac-awake"]);
    for (const target of internal) {
      const blog = /^\/blog\/([^/]+)$/.exec(target);
      expect({ target, ok: allowed.has(target) || (blog ? blog[1] in BLOG_ARTICLES : false) }).toEqual({ target, ok: true });
    }
    for (const related of article.relatedArticles) expect(BLOG_ARTICLES[related.slug]).toBeDefined();
  });

  it("links out only to pages the facts module lists, all https and on Anthropic's own hosts", () => {
    const known = new Set([...Object.values(F.sources).map((source) => source.url)]);
    for (const target of external) {
      expect({ target, known: known.has(target) }).toEqual({ target, known: true });
      expect(new URL(target).protocol).toBe("https:");
    }
  });
});

describe("the Hivra section and the claims rules", () => {
  const hivra = sectionByHeading("Running Claude Code off your laptop on Hivra");
  const hivraText = hivra.paragraphs.join("\n");

  it("comes after the plans, the break-even, the limits and Anthropic's own cloud, and is the only pitch", () => {
    const index = article.sections.indexOf(hivra);
    expect(article.sections.slice(0, index).map((section) => section.heading)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^The plans side by side/),
        "API key or subscription: the break-even",
        "What happens when you hit a limit, and what to do",
        "When Anthropic's own cloud is enough",
      ]),
    );
    expect(article.intro).not.toMatch(/Hivra/);
    expect(article.shortAnswer).not.toMatch(/Hivra/);
    const before = article.sections.slice(0, index).map(sectionText).join("\n");
    // The one earlier mention is the cloud section's line that a Hivra computer does not raise your limits.
    expect(before.match(/Hivra/g) ?? []).toHaveLength(1);
  });

  it("states price and size together, the card-payment guarantee, the run lifetime and the non-affiliation line", () => {
    expect(hivraText).toContain(`${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}`);
    expect(hivraText).toContain(`${LARGER_PLAN_PRICE} a month for ${LARGER_PLAN_SIZE}`);
    expect(hivraText).toContain(MONEY_BACK_GUARANTEE);
    expect(hivraText).toContain(CLI_RUN_LIFETIME);
    expect(hivraText).toContain("Hivra is independent and is not affiliated with Anthropic or OpenAI.");
  });

  it("scopes the markup statement to the visitor's own Anthropic login", () => {
    expect(hivraText).toMatch(/on your own Anthropic login it adds no markup on Claude usage/);
    expect(hivraText).not.toMatch(/zero markup/i);
  });

  it("says Hivra does not raise Claude's limits, and where the alternative is the better choice", () => {
    expect(hivraText).toMatch(/does not raise them/);
    expect(hivraText).toMatch(/Hivra is not the better choice in every case/);
    expect(hivraText).toMatch(/Anthropic's cloud sessions cost nothing beyond your plan/);
    expect(hivraText).toMatch(/ordinary, individual usage of Claude Code and the Agent SDK/);
  });

  it("uses the computer vocabulary and the dashboard's own tab names, and makes no false keep-running claim", () => {
    expect(bodyCopy.match(/Box Terminal|(?<!text )\bbox(?:es)?\b/gi)).toBeNull();
    expect(bodyCopy.match(/\b(?:runtimes?|instances?)\b/gi)).toBeNull();
    expect(unknownDashboardNames(bodyCopy)).toEqual([]);
    expect(falseCliRunClaims(bodyCopy)).toEqual([]);
    // Nothing about Windows or macOS availability on Hivra, and no plan names.
    const hivraSentences = bodyCopy.split(/(?<=[.!?])\s+|\n+/).filter((sentence) => /\bHivra\b/.test(sentence));
    for (const sentence of hivraSentences) {
      expect(sentence).not.toMatch(/\bWindows\b|\bmacOS\b|\b(?:Pro|Max|Power|Starter) plan\b/);
    }
  });

  it("answers the server question without promising a browser run outlives its tab", () => {
    const faq = article.faqs.find((candidate) => candidate.q.startsWith("Does running Claude Code on a server or on Hivra"));
    expect(faq?.a).toContain(CLI_RUN_LIFETIME);
    expect(faq?.a).toMatch(/^No\. Your limits follow your Anthropic account/);
  });
});

describe("inbound links to the post", () => {
  const POST_LINK = `](/blog/${SLUG})`;

  it.each(["cost-of-running-ai-agent", "claude-code-vs-codex-24-7", "byo-api-key-explained"])("%s links to it once, in its own text", (slug) => {
    const copy = BLOG_ARTICLES[slug].sections.flatMap((section) => section.paragraphs).join("\n");
    expect(copy.split(POST_LINK)).toHaveLength(2);
  });

  it("is linked from the plan calculator page, once, and the calculator links back to no other post", () => {
    const hrefs = getToolEntry("claude-code-plan-calculator")!.relatedLinks.map((link) => link.href);
    expect(hrefs.filter((href) => href === `/blog/${SLUG}`)).toHaveLength(1);
    expect(hrefs.filter((href) => href.startsWith("/blog/"))).toEqual([`/blog/${SLUG}`]);
  });
});
