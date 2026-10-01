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

  it("puts the plan questions first, in the order a reader asks them", () => {
    expect(article.faqs.map((faq) => faq.q).slice(0, 5)).toEqual([
      "Is Claude Code included in Pro?",
      "What is the Claude Max plan?",
      "What are Claude Max limits?",
      "What is the difference between Claude Pro and Max?",
      "Is Max worth it for Claude Code?",
    ]);
  });

  it("answers the questions people search for", () => {
    const questions = article.faqs.map((faq) => faq.q);
    for (const expected of [
      "Is Claude Code included in Pro?",
      "What are Claude Max limits?",
      "Is Max worth it for Claude Code?",
      "What happens when I hit the Claude Code limit?",
      // The Claude Max plan and "claude pro vs max" intents, and the People Also Ask ones.
      "What is the Claude Max plan?",
      "What is the difference between Claude Pro and Max?",
      "Is Claude Pro enough for Claude Code?",
      "Does Claude Max work faster than Pro?",
    ]) {
      expect(questions).toContain(expected);
    }
  });

  it("uses no em or en dash anywhere", () => {
    expect(JSON.stringify(article)).not.toMatch(/[–—]/);
  });
});

describe("the page targets the pricing queries and answers on the first screen", () => {
  // Research 2026-09-30: "claude code pricing" (27,100 a month in the US, 33,100
  // in August 2026), "claude max plan" (4,400) and "claude pro vs max" (2,400).
  // The results for the first are mostly articles, so the article owns it.
  it("names Claude Code pricing, Pro vs Max and the Claude Max plan in the title, meta and headings", () => {
    expect(article.title).toBe("Claude Code pricing: Pro vs Max, and when API billing is cheaper");
    expect(article.metaTitle).toBe("Claude Code Pricing: Pro vs Max and API costs");
    expect(article.metaDescription).toMatch(/^Claude Code pricing: Pro \$20, Max 5x \$100, Max 20x \$200 a month\./);
    expect(article.sections[0].heading).toBe("Claude Code pricing by plan, read 30 September 2026");
    expect(bodyCopy).toMatch(/Claude Max plan/);
    expect(article.slug).toBe("claude-max-vs-pro-for-claude-code");
  });

  it("answers Pro vs Max in the short answer: who should move, and that Max is more usage, not a different model", () => {
    // Pricing table, read 2026-09-30: Opus and Sonnet are listed for Pro and for both Max sizes.
    expect(article.shortAnswer).toContain("Move to Max 5x ($100) when Pro's five-hour limit stops you in most sessions, and to Max 20x ($200) only if Max 5x still does.");
    expect(article.shortAnswer).toContain("Max adds usage per session, not a different Opus or Sonnet.");
    const words = (article.shortAnswer ?? "").trim().split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(40);
    expect(words).toBeLessThanOrEqual(60);
  });

  it("puts the recommendation and the three prices in the tagline and the intro, from the constants", () => {
    const { pro, max5x, max20x } = F.plans;
    expect(article.tagline).toBe(`Start on Pro at ${usd(pro.priceUsd)}. Move to Max only when Pro's limit stops you.`);
    expect(article.intro).toContain(`Pro (${usd(pro.priceUsd)} a month), Max 5x (${usd(max5x.priceUsd)}) and Max 20x (${usd(max20x.priceUsd)})`);
    expect(article.intro).toContain("prices read 30 September 2026");
    expect(article.intro).not.toMatch(/^This page gives/);
  });

  it("keeps the weekly-multiple point to a pointer outside the table, the rule and the not-published list", () => {
    const mentions = bodyCopy.match(/weekly multiple/g) ?? [];
    expect(mentions.length).toBeLessThanOrEqual(6);
    const worth = article.faqs.find((faq) => faq.q === "Is Max worth it for Claude Code?");
    expect(worth?.a).not.toMatch(/weekly multiple/);
  });

  it("says a Team Premium seat is not a Max plan", () => {
    expect(sectionByHeading("Claude Code pricing by plan").paragraphs.join("\n")).toMatch(/A Premium seat is not a Max plan: it is bought as a seat on a Team plan with at least 2 members, and its 6\.25x sits between Max 5x and Max 20x/);
  });

  it("says Max is not a faster model, from the benefits Anthropic lists", () => {
    const faq = article.faqs.find((candidate) => candidate.q === "Does Claude Max work faster than Pro?");
    expect(faq?.a).toMatch(/^Anthropic's pricing page does not list speed as a Max benefit\. Pro and Max both run Opus and Sonnet\./);
    expect(faq?.a).toMatch(/billed through usage credits on Pro and Max alike and does not count against plan limits/);
  });
});

describe("the post reads its numbers from the calculator's constants", () => {
  it("states each plan price the calculator holds, in the short answer and the plans list", () => {
    const { pro, max5x, max20x } = F.plans;
    expect(article.shortAnswer).toContain(`Pro (${usd(pro.priceUsd)})`);
    expect(article.shortAnswer).toContain(`Max 5x (${usd(max5x.priceUsd)})`);
    expect(article.shortAnswer).toContain(`Max 20x (${usd(max20x.priceUsd)})`);
    const plans = sectionByHeading("Claude Code pricing by plan").paragraphs.join("\n");
    expect(plans).toContain(`${usd(pro.priceUsd)} a month, or ${usd(pro.annualMonthlyUsd)} a month on the annual plan (${usd(pro.annualUpfrontUsd)} billed up front)`);
    expect(plans).toContain(`${usd(max5x.priceUsd)} a month`);
    expect(plans).toContain(`${usd(max20x.priceUsd)} a month`);
    expect(plans).toContain(`${max5x.multiplier}x Pro's`);
    expect(plans).toContain(`${max20x.multiplier}x Pro's`);
  });

  it("lays the plans out as a list, because article tables scroll sideways on a 390 px phone", () => {
    // The shared article table has a 560 px minimum width, so any plans table
    // needed a swipe to reach Max 5x. A list shows every plan on a phone.
    const section = sectionByHeading("Claude Code pricing by plan").paragraphs;
    expect(section.some((paragraph) => paragraph.startsWith("|"))).toBe(false);
    const list = section.find((paragraph) => paragraph.startsWith("- **Pro:**"))!;
    expect(list.split("\n")).toEqual([
      "- **Pro:** $20 a month, or $17 a month on the annual plan ($200 billed up front). The baseline that the Max multiples are measured against.",
      "- **Max 5x:** $100 a month, monthly only. 5x Pro's usage per five-hour session.",
      "- **Max 20x:** $200 a month, monthly only. 20x Pro's usage per five-hour session.",
      "- **Weekly limit:** all three have one. Anthropic does not publish the size of Pro's, or a weekly multiple for Max.",
      "- **Fable 5.1:** usage credits only on Pro. Included on Max up to 50% of weekly limits.",
      "- **Claude Code:** included in all three.",
    ]);
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
    expect(section).toContain("| Plan | At $13 a day | At $30 a day |");
    expect(section).toContain("| Pro ($20) | 1.5 days | 0.7 days |");
    expect(section).toContain("| Max 5x ($100) | 7.7 days | 3.3 days |");
    expect(section).toContain("| Max 20x ($200) | 15.4 days | 6.7 days |");
    expect(section).toContain("break-even active days a month = plan price / API cost per active day");
    expect(article.shortAnswer).toContain("At Anthropic's $13 enterprise average day, API billing beats Pro only below 1.5 active days a month");
  });

  it("calls the $13 an enterprise average wherever it heads the break-even, and keeps the plan-limits caveat", () => {
    // Anthropic's $13 is an average across enterprise deployments, not a typical
    // solo day, and a plan is only cheaper if its limits cover the sessions.
    const section = sectionByHeading("API key or subscription").paragraphs.join("\n");
    expect(section).toContain("Break-even days at Anthropic's $13 enterprise average day, and at the $30 day that 90% of users stay below:");
    expect(section).toContain("across enterprise deployments");
    expect(section).toContain("as long as the plan's limits cover that usage");
    expect(bodyCopy).not.toMatch(/Anthropic's average day|\(Anthropic's average\)/);
    const faq = article.faqs.find((candidate) => candidate.q === "Is the API cheaper than a Claude subscription for Claude Code?");
    expect(faq?.a).toContain("per developer per active day across enterprise deployments, so a plan is cheaper, if its limits cover your sessions,");
    // The calculator page names the $13 an enterprise average too, in its FAQ and method.
    const calculator = getToolEntry("claude-code-plan-calculator")!;
    const estimateFaq = calculator.faqs.find((candidate) => candidate.q.startsWith("Where does the dollar estimate come from"));
    expect(estimateFaq?.a).toContain("Anthropic's $13 enterprise average");
    expect(JSON.stringify(calculator.method)).toContain("the $13 enterprise average times your active days");
    expect(JSON.stringify(calculator.method)).toContain("across enterprise deployments");
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

describe("says what Anthropic does not currently publish, not what it never published", () => {
  // Anthropic's July 2025 weekly-limit notice gave hours-per-week estimates that
  // were later removed, so "never" is false. "As of the read date, no Anthropic
  // page states it" is the claim the page can back.
  const ABSOLUTE = /\bnever (?:as a|as counts|given|published|stated)|has never (?:given|published|stated)|not an Anthropic number|any weekly figure/i;

  it("makes no absolute claim about what Anthropic has or has not published", () => {
    expect(bodyCopy).not.toMatch(ABSOLUTE);
    expect(article.intro).toMatch(/does not currently publish message or token counts/);
    expect(sectionByHeading("What Anthropic does not publish").paragraphs.join("\n")).toMatch(/numbers Anthropic does not currently publish\. This is what no Anthropic page states, as of 30 September 2026/);
    const faq = article.faqs.find((candidate) => candidate.q === "What are Claude Max limits?");
    expect(faq?.a).toMatch(/a weekly multiple or hour count you see elsewhere is not one Anthropic currently publishes/);
  });

  it("carries the same wording on the calculator page", () => {
    const strings = JSON.stringify(getToolEntry("claude-code-plan-calculator"));
    expect(strings).not.toMatch(ABSOLUTE);
  });
});

describe("does not say Claude Code needs a plan while the page explains the API key", () => {
  // The same post says Claude Code can bill per token on an API key with no plan
  // limits, and the FAQ ships in FAQPage JSON-LD, so a search engine must not
  // read two contradictory statements.
  it("says a plan or an API key in the FAQ and the calculator's FAQ", () => {
    const faq = article.faqs.find((candidate) => candidate.q === "Is Claude Code included in Pro?");
    expect(faq?.a).toContain("can also be billed to an API key instead of a plan");
    expect(bodyCopy).not.toMatch(/needs one of those paid plans|requires a paid plan|only with a paid plan/i);
    expect(JSON.stringify(getToolEntry("claude-code-plan-calculator"))).not.toMatch(/needs one of those paid plans|requires a paid plan|only with a paid plan/i);
  });
});

describe("the limit-hit playbook matches the interactive-mode docs", () => {
  // Docs (code.claude.com/docs/en/interactive-mode, read 2026-09-30): the
  // automatic wait is not started on its own when the reset is more than 24 hours
  // away ("a weekly limit can reset days out"), so a weekly limit that resets
  // sooner is still waited out. A wait picked from /rate-limit-options keeps
  // counting down.
  const section = sectionByHeading("What happens when you hit a limit").paragraphs.join("\n");

  it("does not say the 24-hour case covers weekly limits outright", () => {
    expect(section).not.toMatch(/which covers weekly limits/);
    expect(section).toContain("more than 24 hours away, which is often the case for a weekly limit, or in Remote Control sessions");
    expect(section).toContain("continues the task after a usage limit resets");
  });

  it("tells the reader they can start the wait themselves, in one short step", () => {
    expect(section).toContain("you can start a wait from `/rate-limit-options` and it keeps counting down");
    const step = section.split("\n").find((line) => line.startsWith("2. **Wait in the same session.**")) ?? "";
    expect(step.length).toBeLessThan(800);
    // The hand-off and re-arm details sit in a note, not in the step.
    expect(step).not.toMatch(/re-arms/);
    expect(section).toContain("The wait ends if you exit Claude Code or hand the session to another surface, and it re-arms at most twice in a row.");
  });

  it("links the limit reset calculator once, with the caveat that the window opening is reported, not documented", () => {
    expect(section.split("](/tools/claude-code-limit-reset-calculator)")).toHaveLength(2);
    expect(section).toContain("which is how the window is widely reported to open");
  });
});

describe("reports Anthropic's model guide as it reads", () => {
  // The guide (support article 14552983, modified 2026-09-22) says Opus uses
  // meaningfully more of your quota and costs several times more per turn than
  // Sonnet, and gives no figure. It was modified the day Opus became the default,
  // so nothing shows it predates that change.
  const section = sectionByHeading("Model choice changes").paragraphs.join("\n");

  it("says what the guide says about Opus and gives no quota figure", () => {
    const notPublished = sectionByHeading("What Anthropic does not publish").paragraphs.join("\n");
    expect(notPublished).toContain("Opus uses meaningfully more quota and costs several times more per turn, and gives no figure for quota");
    expect(notPublished).not.toMatch(/says only that Opus/);
  });

  it("does not claim the guide predates the new default", () => {
    expect(bodyCopy).not.toMatch(/predates/i);
    expect(section).toContain("The default is Opus, so switching is your lever");
  });
});

describe("Team seat prices read as a month, not a year", () => {
  it("says a month on the annual plan for both seats, in the plans section and the changelog", () => {
    const plans = sectionByHeading("Claude Code pricing by plan").paragraphs.join("\n");
    expect(plans).toContain("$25 a month ($20 a month on the annual plan) for Standard");
    expect(plans).toContain("$125 ($100 a month on the annual plan) for Premium");
    expect(bodyCopy).not.toMatch(/billed annually\) for (?:Standard|Premium)/);
    const row = CLAUDE_PLAN_CHANGELOG.find((entry) => entry.date === "2026-01-28")!;
    expect(row.text).toMatch(/\$20 a month on the annual plan or \$25 a month on the monthly plan/);
    expect(row.text).not.toMatch(/\(annual\)|\(monthly\)/);
  });
});

describe("the post and the calculator page do not repeat each other's FAQ", () => {
  // Two FAQPage blocks that answer the same questions in the same words compete
  // with each other and read as scaled content. The post owns the plan and price
  // questions; the tool page owns how the tool works.
  const tool = getToolEntry("claude-code-plan-calculator")!;
  const shingles = (text: string, size = 6): Set<string> => {
    const words = text.toLowerCase().replace(/[^a-z0-9$%.' ]/g, " ").split(/\s+/).filter(Boolean);
    const out = new Set<string>();
    for (let i = 0; i + size <= words.length; i++) out.add(words.slice(i, i + size).join(" "));
    return out;
  };

  it("shares no question", () => {
    const post = new Set(article.faqs.map((faq) => faq.q.toLowerCase()));
    expect(tool.faqs.filter((faq) => post.has(faq.q.toLowerCase())).map((faq) => faq.q)).toEqual([]);
  });

  it("shares at most a fifth of any answer's six-word phrases with any answer on the other page", () => {
    const worst: Array<{ tool: string; post: string; overlap: number }> = [];
    for (const toolFaq of tool.faqs) {
      const a = shingles(toolFaq.a);
      for (const postFaq of article.faqs) {
        const b = shingles(postFaq.a);
        const shared = [...a].filter((phrase) => b.has(phrase)).length;
        const overlap = shared / Math.max(1, Math.min(a.size, b.size));
        if (overlap > 0.2) worst.push({ tool: toolFaq.q, post: postFaq.q, overlap: Math.round(overlap * 100) / 100 });
      }
    }
    expect(worst).toEqual([]);
  });

  it("keeps the tool page to tool questions and points to the post for the plan comparison", () => {
    expect(tool.faqs.map((faq) => faq.q)).toEqual([
      "How does the calculator rate each plan?",
      "Why does the calculator never rate the weekly limit?",
      "Why does it ask where Pro stops me?",
      "Where does the dollar estimate come from, and how far should I trust it?",
      "Why does the model mix start at 100% Opus?",
      "What does the calculator leave out?",
      "Does the calculator replace /usage in Claude Code?",
    ]);
    expect(tool.faqs.find((faq) => faq.q === "What does the calculator leave out?")?.a).toContain("read the plan pricing post linked below");
    expect(tool.relatedLinks.map((link) => link.href)).toContain(`/blog/${SLUG}`);
  });
});

describe("keeps the facts the verifiers corrected", () => {
  // Corrected on 2026-09-30: the support article says `claude logout` and
  // `claude login`, but the CLI reference lists `claude auth login`, `claude auth
  // logout` and `claude auth status`, and the installed CLI has no top-level login
  // or logout. A set ANTHROPIC_API_KEY is fixed by unsetting it, not by /login.
  const section = sectionByHeading("API key or subscription").paragraphs.join("\n");

  it("gives the real sign-out and sign-in commands, never the top-level forms", () => {
    expect(section).toContain("`claude auth logout`, then `claude auth login`");
    expect(bodyCopy).not.toMatch(/claude (?:logout|login)\b/);
  });

  it("fixes a set API key by unsetting it, in the section body as well as the FAQ", () => {
    expect(section).toContain("unset ANTHROPIC_API_KEY");
    expect(section).toContain("If `ANTHROPIC_API_KEY` is set in your environment, Claude Code uses it instead of your plan and bills API usage");
    expect(section).toMatch(/Interactive sessions ask once whether to approve the key, and `claude -p` uses it whenever it is set/);
    expect(section).not.toMatch(/\/login/);
  });
});

describe("the plan changelog section", () => {
  const section = sectionByHeading("What changed and when");
  const text = section.paragraphs.join("\n");
  // The post reads one date format, "30 September 2026", in the changelog as in the prose.
  const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const long = (iso: string) => {
    const [year, month, dayOfMonth] = iso.split("-").map(Number);
    return `${dayOfMonth} ${MONTH_NAMES[month - 1]} ${year}`;
  };

  it("prints every changelog row, newest first, with its date and a link to the page that states it", () => {
    const rows = text.split("\n").filter((line) => /^- \*\*\d{1,2} [A-Z][a-z]+ \d{4}\*\*: /.test(line));
    expect(rows).toHaveLength(CLAUDE_PLAN_CHANGELOG.length);
    CLAUDE_PLAN_CHANGELOG.forEach((entry, index) => {
      expect(rows[index]).toBe(`- **${long(entry.date)}**: ${entry.text.replace(/\d{4}-\d{2}-\d{2}/g, long)} Source: [${entry.source.label}](${entry.source.url}).`);
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
    for (const date of [F.limitChanges.fiveHourDoubled, F.limitChanges.weeklyChanged, F.limitChanges.fiveHourRaised, F.defaultModel.since]) {
      expect(text).toContain(`- **${long(date)}**: `);
    }
  });

  it("uses one date format in the body, with no ISO date outside code and links", () => {
    const prose = bodyCopy.replace(/\]\([^)]*\)/g, "]").replace(/```[\s\S]*?```/g, "");
    expect(prose.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? []).toEqual([]);
    expect(text).toContain("It ran through 13 September 2026.");
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
    const allowed = new Set(["/", "/agents/claude-code", "/tools/claude-code-plan-calculator", "/tools/claude-code-limit-reset-calculator", "/tools/keep-mac-awake"]);
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
        expect.stringMatching(/^Claude Code pricing by plan/),
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

  it("scopes the shared limits to a plan sign-in and keeps to files, sessions and login", () => {
    const cloud = sectionByHeading("When Anthropic's own cloud is enough").paragraphs.join("\n");
    expect(cloud).toContain("When you sign in with your plan, every one of these options draws on the same plan limits");
    expect(cloud).toContain("On an API key there is no plan allowance to raise");
    expect(hivraText).toContain("your files, sessions and login to stay in place between tasks");
    // One Hivra computer per agent: nothing here says several agents share a computer.
    expect(hivraText).not.toMatch(/other agents/i);
  });

  it("says Hivra does not raise Claude's limits, and where the alternative is the better choice", () => {
    expect(hivraText).toMatch(/does not raise them/);
    expect(hivraText).toMatch(/Hivra is not the better choice in every case/);
    // Anthropic's own wording is "no separate compute charge" on a plan that shares its limits.
    expect(hivraText).toMatch(/Anthropic's cloud sessions have no separate compute charge and draw on your plan's limits/);
    expect(bodyCopy).not.toMatch(/cost nothing beyond your plan/);
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
    // The shared allowance only holds when you sign in with the plan, not an API key.
    expect(faq?.a).toMatch(/^No\. When you sign in with your plan, your limits follow your Anthropic account/);
  });
});

describe("the sibling posts it links to state the same Anthropic API prices and say what they did not recompute", () => {
  // The post is a dated table of Anthropic prices, so the posts it sends readers
  // to must not print the April 2026 Sonnet 4.6 and Opus 4.6 prices as current.
  const SIBLINGS = ["cost-of-running-ai-agent", "byo-api-key-explained", "ai-agent-api-cost-optimization"];
  const copyOf = (slug: string) => [...BLOG_ARTICLES[slug].sections.flatMap((section) => section.paragraphs), ...BLOG_ARTICLES[slug].faqs.map((faq) => faq.a)].join("\n");

  it.each(SIBLINGS)("%s names the current Claude models and none of the retired 4.6 prices", (slug) => {
    const copy = copyOf(slug);
    expect(copy).not.toMatch(/Sonnet 4\.6|Opus 4\.6|1M context, 128K max output|no surcharge as of March 2026/);
    expect(copy).toContain(F.api.sonnet.label);
    expect(copy).toContain(F.api.opus.label);
  });

  it.each(SIBLINGS)("%s prints the Sonnet 5.5 and Opus 5.5 prices from the constants, dated 30 September 2026", (slug) => {
    const copy = copyOf(slug);
    const { sonnet, opus } = F.api;
    const pair = (input: number, output: number) => new RegExp(`\\$${input}(?:\\.00)?\\s?/\\s?\\$${output}(?:\\.00)?`);
    expect(copy).toMatch(pair(sonnet.input, sonnet.output));
    expect(copy).toMatch(pair(opus.input, opus.output));
    expect(copy).toContain("30 September 2026");
  });

  it("do not re-date OpenAI prices and say which ranges were not recalculated", () => {
    expect(copyOf("cost-of-running-ai-agent")).toContain("OpenAI, as of April 2026: GPT-5 mini");
    expect(copyOf("cost-of-running-ai-agent")).toContain("The monthly ranges below were worked out at April 2026 prices and have not been recalculated.");
    expect(copyOf("ai-agent-api-cost-optimization")).toContain("OpenAI prices, as of April 2026:");
    expect(copyOf("ai-agent-api-cost-optimization")).toContain("worked out at April 2026 model prices and have not been recalculated");
    expect(copyOf("byo-api-key-explained")).toContain("a range worked out at April 2026 prices and not recalculated");
  });

  it("qualify the no-surprise-bill and zero-AI-cost lines the post contradicts", () => {
    expect(copyOf("claude-code-vs-codex-24-7")).toContain("as long as no API key is set in the environment and usage credits are off, the worst case for a runaway agent is hitting the window limit");
    expect(copyOf("cost-of-running-ai-agent")).toContain("$0 while they stay inside the subscription's limits");
    expect(copyOf("byo-api-key-explained")).toContain("adds no new AI cost while they stay inside the subscription's limits");
  });
});

describe("inbound links to the post", () => {
  const POST_LINK = `](/blog/${SLUG})`;

  it.each(["cost-of-running-ai-agent", "claude-code-vs-codex-24-7", "byo-api-key-explained", "keep-claude-code-running-24-7"])("%s links to it once, in its own text", (slug) => {
    const copy = BLOG_ARTICLES[slug].sections.flatMap((section) => section.paragraphs).join("\n");
    expect(copy.split(POST_LINK)).toHaveLength(2);
  });

  it("uses its pricing-query title as the anchor text in the sibling posts and on the calculator page", () => {
    for (const slug of ["cost-of-running-ai-agent", "claude-code-vs-codex-24-7", "byo-api-key-explained", "keep-claude-code-running-24-7"]) {
      const copy = BLOG_ARTICLES[slug].sections.flatMap((section) => section.paragraphs).join("\n");
      expect({ slug, anchored: copy.includes("[Claude Code pricing: Pro vs Max](" + `/blog/${SLUG})`) }).toEqual({ slug, anchored: true });
    }
    const label = getToolEntry("claude-code-plan-calculator")!.relatedLinks.find((link) => link.href === `/blog/${SLUG}`)?.label;
    expect(label).toMatch(/^Claude Code pricing: Pro vs Max/);
  });

  it("is linked from the plan calculator page, once, and the calculator links back to no other post", () => {
    const hrefs = getToolEntry("claude-code-plan-calculator")!.relatedLinks.map((link) => link.href);
    expect(hrefs.filter((href) => href === `/blog/${SLUG}`)).toHaveLength(1);
    expect(hrefs.filter((href) => href.startsWith("/blog/"))).toEqual([`/blog/${SLUG}`]);
  });
});
