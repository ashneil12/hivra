import { BLOG_ARTICLES, BLOG_ARTICLES_LIST } from "@/lib/blog-data";
import { findBannedClaims } from "@/lib/tools/copy-rules";
import {
  ENTRY_PLAN_PRICE,
  ENTRY_PLAN_SIZE,
  FREE_ACCOUNT_SENTENCE,
  HOSTED_COMPUTE_NEEDS_PLAN,
  HOSTED_COMPUTE_NEEDS_PLAN_SENTENCE,
  HOSTED_COMPUTE_NEEDS_PLAN_SHORT,
  MONEY_BACK_GUARANTEE,
} from "../plan-facts";

// Owner decisions of 21 October 2026: every computer that Hivra Cloud runs for you is paid, whichever agent
// it runs, and a free account works with a computer or server you connect yourself. The copy is written
// for the world with lapse enforcement on: it ships together with the HIVRA_LAPSE_ENFORCE_LIVE switch.
// These tests also keep the pricing figures the 21 October rescale made honest: a total appears only
// where the volume behind it is stated in the same article.

type Article = (typeof BLOG_ARTICLES_LIST)[number];

function articleCopy(article: Article): string {
  return [
    article.title,
    article.metaTitle ?? "",
    article.metaDescription,
    article.tagline,
    article.intro,
    article.shortAnswer ?? "",
    ...article.sections.flatMap((section) => [section.heading, ...section.paragraphs]),
    ...article.faqs.flatMap(({ q, a }) => [q, a]),
  ].join("\n");
}

const copyOf = (slug: string) => articleCopy(BLOG_ARTICLES[slug]);
const faqAnswer = (slug: string, question: RegExp) => {
  const faq = BLOG_ARTICLES[slug].faqs.find(({ q }) => question.test(q));
  expect(faq).toBeDefined();
  return faq!.a;
};
const sentences = (copy: string) => copy.split(/(?<=[.!?])\s+|\n+/);

/**
 * Claims that only some agents need a paid plan on Hivra, or that read as if an unpaid hosted computer
 * exists beside the paid ones. Every Hivra Cloud computer needs a paid plan.
 */
const SELECTIVE_PAID_PLAN_CLAIMS: RegExp[] = [
  /\b(?:OpenClaw|Agent Zero|both agents)\b[^.!?\n]{0,40}\bneeds? (?:a )?paid plan\b/i,
  /\bIt needs a paid plan\b/,
  /\bOpenClaw itself\b[^.!?\n]{0,40}\bon paid plans\b/i,
  /\bso does Hivra on paid plans\b/i,
  /\bOpenClaw\b[^.!?\n]{0,160}\bon paid plans\b/i,
  /\bYes, on paid plans\b/,
  /\bincluded with paid plans on Hivra\b/i,
];
const selectivePaidPlanClaims = (copy: string) => SELECTIVE_PAID_PLAN_CLAIMS.filter((pattern) => pattern.test(copy)).map(String);

describe("hosted computers need a paid plan, whichever agent runs on them", () => {
  it("builds the canonical sentences from the billing constants", () => {
    expect(HOSTED_COMPUTE_NEEDS_PLAN_SENTENCE).toBe(
      `Every computer that Hivra Cloud runs for you needs a paid plan, from ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}.`
    );
    expect(HOSTED_COMPUTE_NEEDS_PLAN_SENTENCE).toBe(
      "Every computer that Hivra Cloud runs for you needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM."
    );
    expect(FREE_ACCOUNT_SENTENCE).toBe("A free account works with a computer or server you connect yourself.");
    expect(HOSTED_COMPUTE_NEEDS_PLAN).toBe(`${HOSTED_COMPUTE_NEEDS_PLAN_SENTENCE} ${FREE_ACCOUNT_SENTENCE}`);
    expect(HOSTED_COMPUTE_NEEDS_PLAN_SHORT).toBe("Every Hivra Cloud computer needs a paid plan.");
  });

  it("passes the banned-claim rules the public pages are scanned against, and writes no dash", () => {
    for (const text of [HOSTED_COMPUTE_NEEDS_PLAN, HOSTED_COMPUTE_NEEDS_PLAN_SHORT, FREE_ACCOUNT_SENTENCE]) {
      expect({ text, hits: findBannedClaims(text) }).toEqual({ text, hits: [] });
      expect(text).not.toMatch(/[\u2013\u2014]/);
    }
  });

  it("catches the old selective claims and leaves the new wording alone", () => {
    for (const old of [
      "Six agents are launchable today. OpenClaw and Agent Zero need a paid plan.",
      "Hermes, Claude Code, Codex, Aeon, OpenClaw, and Agent Zero all launch on Hivra. OpenClaw and Agent Zero need a paid plan.",
      "Hivra hosts both on managed VMs: [OpenClaw itself](/agents/openclaw) on paid plans, and Hermes launched from the dashboard.",
      "ClawHost and Blink Claw host OpenClaw directly, and so does Hivra on paid plans.",
      "Not on Hivra. OpenClaw needs a paid plan, from $9.99 a month.",
      "**Hivra.** Both agents need a paid plan, from $9.99 a month.",
      "It needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM.",
      "Hivra runs the open-source OpenClaw agent on a private managed VM with the server side handled for you, on paid plans from $9.99 a month for 2 vCPU and 4 GB of RAM.",
      "| Always-on compute | No. Sleep, reboots, and travel all kill it | Yes | Yes, on paid plans |",
      "that comes from the host (included with paid plans on Hivra), whichever CLI you run.",
    ]) {
      expect({ old, hits: selectivePaidPlanClaims(old) }).not.toEqual({ old, hits: [] });
    }
    for (const current of [
      HOSTED_COMPUTE_NEEDS_PLAN,
      "Every Hivra Cloud computer needs a paid plan, and that includes the one OpenClaw runs on.",
      "Every Hivra Cloud computer needs a paid plan, and OpenClaw's starts at $9.99 a month for 2 vCPU and 4 GB of RAM.",
      "Hivra hosts both on managed VMs, each on a paid plan: [OpenClaw itself](/agents/openclaw), and Hermes launched from the dashboard.",
      "and so does Hivra, on a paid plan. Hivra also hosts Hermes Agent on the same plans",
      "with the server side handled for you. Every Hivra Cloud computer needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM.",
      "| Always-on compute | No. Sleep, reboots, and travel all kill it | Yes | Yes |",
      "that comes from the host (included on every Hivra Cloud computer), whichever CLI you run.",
    ]) {
      expect({ current, hits: selectivePaidPlanClaims(current) }).toEqual({ current, hits: [] });
    }
  });

  it("singles out no agent as the one that needs a paid plan, in any article", () => {
    const found = BLOG_ARTICLES_LIST.flatMap((article) =>
      selectivePaidPlanClaims(articleCopy(article)).map((claim) => `${article.slug}: ${claim}`)
    );
    expect(found).toEqual([]);
  });

  it("says the same thing on the pages that used to single out OpenClaw and Agent Zero", () => {
    expect(copyOf("ai-agent-hosting-guide")).toContain(HOSTED_COMPUTE_NEEDS_PLAN);
    // The pointer to the OpenClaw and Agent Zero comparison names its two agents, so the paid-plan sentences cannot sit between "those last two" and the list.
    expect(copyOf("ai-agent-hosting-guide")).toContain("If you're weighing OpenClaw against Agent Zero, see");
    expect(copyOf("ai-agent-hosting-guide")).not.toMatch(/those last two/);
    expect(copyOf("ai-agent-vps")).toContain(`${HOSTED_COMPUTE_NEEDS_PLAN_SHORT} ${FREE_ACCOUNT_SENTENCE}`);
    expect(copyOf("agent-zero-vs-openclaw-hosting")).toContain("Every Hivra Cloud computer needs a paid plan, whichever agent runs on it");
    expect(copyOf("openclaw-broken-after-update")).toContain("Every Hivra Cloud computer needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM.");
    expect(faqAnswer("openclaw-broken-after-update", /without running the server myself/i)).toContain(
      "with the server side handled for you. Every Hivra Cloud computer needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM."
    );
    expect(copyOf("how-to-self-host-openclaw")).toContain("each on a paid plan: [OpenClaw itself](/agents/openclaw)");

    const openclaw = BLOG_ARTICLES["is-openclaw-free-what-it-costs-to-run"];
    const free = openclaw.faqs.find(({ q }) => /free hosted plan/i.test(q));
    expect(free?.a).toBe(
      `Not on Hivra. ${HOSTED_COMPUTE_NEEDS_PLAN} A machine you already own, or a Pi you buy outright, is the route with no monthly hosting bill.`
    );
    // The price in that answer is the interpolated entry price with its size, not a hand-typed "$9.99".
    expect(free?.a).toContain(`${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}`);
  });
});

describe("the memory cancellation answer", () => {
  const answer = () => faqAnswer("persistent-memory-explained", /cancel my Hivra subscription/i);

  it("promises no download window and no roadmap item that does not exist", () => {
    expect(answer()).not.toMatch(/roadmap|grace window|grace period|download after/i);
    expect(answer()).not.toMatch(/\b\d+[- ](?:hours?|days?|weeks?|months?)\b/i);
  });

  it("tells the owner to export first, that the computer is stopped, that files are kept for a limited time and deletion is emailed first", () => {
    // Written for the world with lapse enforcement on (HIVRA_LAPSE_ENFORCE_LIVE is "true"): the copy and the switch ship together.
    expect(answer()).toContain("Export before you cancel.");
    expect(answer()).toContain("Every Hivra Cloud computer needs a paid plan.");
    expect(answer()).toContain(
      "Except for Hermes agents, which follow an older process that the Terms describe, the computer is stopped when a plan ends or when a card payment is still unpaid after the retries."
    );
    expect(answer()).toContain("Its files are kept for a limited time so that you can start it again once you have paid");
    expect(answer()).toContain("Hivra emails you before anything is deleted");
    expect(answer()).toContain("Hivra does not promise how long that time is or that the files are backed up");
  });

  it("keeps plain text in the answer, because FAQ answers ship as structured data", () => {
    expect(answer()).not.toMatch(/\]\(|\*\*/);
  });
});

describe("no article sells the money-back guarantee as a way to try Hivra", () => {
  it("puts no trial wording in a sentence about the guarantee", () => {
    const found = BLOG_ARTICLES_LIST.flatMap((article) =>
      sentences(articleCopy(article))
        .filter((sentence) => sentence.includes(MONEY_BACK_GUARANTEE))
        .filter((sentence) => /\b(?:so you can|try|test|trial|sample)\b/i.test(sentence))
        .map((sentence) => `${article.slug}: ${sentence.slice(0, 160)}`)
    );
    expect(found).toEqual([]);
  });

  it("does not use a heading that invites a pay-then-refund trial next to the guarantee", () => {
    expect(BLOG_ARTICLES["agent-zero-vs-openclaw-hosting"].sections.map(({ heading }) => heading)).not.toContain(
      "Running both, and the fastest way to try either one"
    );
    expect(BLOG_ARTICLES["is-it-safe-to-leave-an-ai-agent-running-unattended"].sections.map(({ heading }) => heading)).not.toContain(
      "Try it with the boundaries already built"
    );
    expect(copyOf("agent-zero-vs-openclaw-hosting")).not.toMatch(/earn its keep/i);
    expect(copyOf("managed-vs-self-hosted-ai-agents")).not.toMatch(/easy to evaluate|see whether a computer/i);
    expect(BLOG_ARTICLES["managed-vs-self-hosted-ai-agents"].sections.map(({ heading }) => heading)).not.toContain("Try the managed side");
    expect(BLOG_ARTICLES["claude-code-vs-codex-24-7"].sections.map(({ heading }) => heading)).not.toContain("Try the comparison on your own backlog");
  });

  it("puts no try, test or trial heading above a paragraph that states the guarantee, in any article", () => {
    const found = BLOG_ARTICLES_LIST.flatMap((article) =>
      article.sections
        .filter((section) => section.paragraphs.some((paragraph) => paragraph.includes(MONEY_BACK_GUARANTEE)))
        .filter((section) => /\b(?:try|test|trial|sample|evaluate)\b/i.test(section.heading))
        .map((section) => `${article.slug}: ${section.heading}`)
    );
    expect(found).toEqual([]);
  });

  it("states the card-payments limit once, not twice", () => {
    for (const article of BLOG_ARTICLES_LIST) {
      expect({ slug: article.slug, doubled: /card payments[^.]{0,40}money-back guarantee on card payments/i.test(articleCopy(article)) }).toEqual({
        slug: article.slug,
        doubled: false,
      });
    }
  });
});

describe("Haiku 5.5 prices: only totals whose inputs the article states", () => {
  it("keeps the worked sums in the API cost article equal to their stated inputs", () => {
    const table = copyOf("ai-agent-api-cost-optimization");
    // 20 runs a day for 30 days at 8,000 input and 2,000 output tokens is 4.8 and 1.2 million tokens a month.
    expect(table).toContain("20 runs a day for 30 days, which is 600 runs");
    expect(table).toContain("4.8 million input tokens and 1.2 million output tokens a month");
    const rows = [...table.matchAll(/(\d+(?:\.\d+)?)×\$(\d+(?:\.\d+)?) \+ (\d+(?:\.\d+)?)×\$(\d+(?:\.\d+)?) = \*\*\$(\d+\.\d{2})\*\*/g)];
    expect(rows.length).toBeGreaterThanOrEqual(6);
    for (const [, inputMillions, inputRate, outputMillions, outputRate, total] of rows) {
      expect(inputMillions).toBe("4.8");
      expect(outputMillions).toBe("1.2");
      expect(Number(total)).toBeCloseTo(4.8 * Number(inputRate) + 1.2 * Number(outputRate), 2);
    }
    expect(table).toContain("Claude Haiku 5.5 | $0.10 / $0.50 | 4.8×$0.10 + 1.2×$0.50 = **$1.08**");
    expect(table).toContain("half of Haiku = **$0.54**");
  });

  it("does not bring back the monthly totals that were the old estimates scaled by the 10x rate ratio", () => {
    const cost = copyOf("cost-of-running-ai-agent");
    for (const total of ["$7 to $8", "$57 to $108", "$10-17", "$60-117", "$8 to $15", "$1 or less", "about $1 a month on tokens"]) {
      expect({ total, present: cost.includes(total) }).toEqual({ total, present: false });
    }
    const api = copyOf("ai-agent-api-cost-optimization");
    for (const total of ["$8-19", "$18-29", "$25-62", "$20-32", "under $1/month"]) {
      expect({ total, present: api.includes(total) }).toEqual({ total, present: false });
    }
    expect(copyOf("byo-api-key-explained")).not.toMatch(/a dollar or so a month/);
    expect(copyOf("self-hosting-hermes-guide")).not.toMatch(/a dollar or so a month/);
  });

  it("says the Haiku part falls with the rate instead, beside the sourced per-token rates", () => {
    const cost = copyOf("cost-of-running-ai-agent");
    expect(cost).toContain("$0.10 input / $0.50 output per MTok for prompts up to 100,000 tokens");
    expect(cost).toContain("The Haiku-only part of these ranges falls to roughly a tenth, because the Haiku rate is a tenth of what it was.");
    expect(cost).toContain("The monthly ranges below were worked out at April 2026 prices and have not been recalculated.");
    expect(copyOf("byo-api-key-explained")).toContain("the Haiku rate is now a tenth of what it was");
    expect(copyOf("ai-agent-api-cost-optimization")).toContain("Haiku 5.5's rate is a tenth of what Haiku 4.5's was");
    expect(copyOf("ai-agent-api-cost-optimization")).toContain("there is no monthly total here");
    // The FAQ ranges have no stated volumes, so the answer does not date them to a rate card it did not compute them from.
    const monthly = faqAnswer("ai-agent-api-cost-optimization", /cost per month to run a Hermes agent/i);
    expect(monthly).not.toContain("October 2026 rates");
    expect(monthly).toContain("No monthly total is given, because the token volumes behind these ranges are not stated.");
  });

  it("gives the cost article one story for the minimal setup, in the headline, the table and the answers", () => {
    const article = BLOG_ARTICLES["cost-of-running-ai-agent"];
    const table = article.sections.flatMap((section) => section.paragraphs).find((paragraph) => paragraph.includes("| Self-hosted, minimal |"))!;
    expect(table).toContain("Hetzner CX23 (€5.49 before VAT and IPv4)");
    expect(table).toContain("1 to 2 hours of upkeep");
    // 1 to 2 hours at $50 an hour is the only dollar figure that follows from numbers the article states.
    expect(table).toContain("$50 to $100 of your time");
    expect(article.shortAnswer).toContain("$50 to $100 at $50 an hour");
    // The hours are the article's own estimate ("at least 1 to 2 hours a month" in its time section), so the headline says so.
    expect(article.shortAnswer).toContain("at least 1 to 2 hours of upkeep a month");
    expect(article.sections.flatMap((section) => section.paragraphs).join("\n")).toContain("at least 1 to 2 hours a month on updates, logs and odd failures");
    expect(article.shortAnswer).toContain("€5.49 a month before VAT and IPv4");
    expect(`${article.shortAnswer}\n${article.faqs.map(({ a }) => a).join("\n")}`).not.toMatch(/\$(?:7|8|10|17|57|60|108|117)\b/);
    const words = (article.shortAnswer ?? "").trim().split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(40);
    expect(words).toBeLessThanOrEqual(60);
  });
});

describe("Hetzner prices: one basis, and the stock warning", () => {
  const HETZNER_PRICE = /€(?:5\.49|8\.49|15\.99)/;
  const cheapestMentions = BLOG_ARTICLES_LIST.filter((article) => /€(?:5\.49|8\.49)/.test(articleCopy(article)));
  /** Every string a reader or a search result sees on its own: the metadata, the headline, each paragraph and each FAQ answer. */
  const strings = (article: Article) => [
    article.title,
    article.metaTitle ?? "",
    article.metaDescription,
    article.tagline,
    article.intro,
    article.shortAnswer ?? "",
    ...article.sections.flatMap((section) => [section.heading, ...section.paragraphs]),
    ...article.faqs.flatMap(({ q, a }) => [q, a]),
  ];

  it("says in the same paragraph, answer or snippet that a CX23, CX33 or CX43 price excludes VAT and IPv4", () => {
    expect(cheapestMentions.length).toBeGreaterThanOrEqual(8);
    const missing = BLOG_ARTICLES_LIST.flatMap((article) =>
      strings(article)
        .filter((text) => HETZNER_PRICE.test(text))
        .filter((text) => !/(?:excluding|excl\.|before) VAT and IPv4/.test(text))
        .map((text) => `${article.slug}: ${text.slice(0, 120)}`)
    );
    expect(missing).toEqual([]);
  });

  it("tells every page that quotes the price that Hetzner showed the plans as unavailable in October 2026", () => {
    for (const article of cheapestMentions) {
      expect({ slug: article.slug, stock: /unavailable in October 2026/.test(articleCopy(article)) }).toEqual({ slug: article.slug, stock: true });
    }
  });

  it("says it in the best-vps headline and the answers that name the cheapest server", () => {
    const article = BLOG_ARTICLES["best-vps-for-hermes-agent"];
    expect(article.shortAnswer).toContain("Hetzner showed both as unavailable in October 2026, so check stock");
    expect(faqAnswer("best-vps-for-hermes-agent", /cheapest server/i)).toContain("unavailable in October 2026");
    expect(faqAnswer("what-is-hermes-agent", /Hermes Agent free/i)).toContain("unavailable in October 2026");
    expect(faqAnswer("how-to-self-host-hermes-agent", /cheapest server/i)).toContain("unavailable in October 2026");
  });

  it("gives the with-IPv4 prices Hetzner lists, and warns that stock is limited, where servers are recommended", () => {
    for (const slug of ["best-vps-for-hermes-agent", "cost-of-running-ai-agent", "ai-agent-vps"]) {
      const copy = copyOf(slug);
      expect(copy).toContain("€5.99");
      expect(copy).toContain("€8.99");
      expect(copy).toContain("Hetzner says the number of servers in this range is limited");
      expect(copy).toMatch(/unavailable/);
    }
  });
});

describe("dated sources and unsourced anecdotes", () => {
  it("writes the GPT-5.5 date as a past date from OpenAI's pages, not a coming event", () => {
    const copy = copyOf("codex-pricing-by-chatgpt-plan");
    expect(copy).toContain("14 October 2026");
    expect(copy).not.toMatch(/GPT-5\.5 retires on|GPT-5\.5 leaves|When does GPT-5\.5|ChatGPT Work and Codex on all plans/);
    expect(copy).toContain("That date has passed");
    expect(copy).toContain("The OpenAI API and Codex sessions that use an API key are not affected.");
  });

  it("carries no named cost anecdote and no routing claim that rests on one", () => {
    const copy = copyOf("ai-agent-api-cost-optimization");
    expect(copy).not.toMatch(/Ari Vance|Helen Mireille|real developers actually spend|30 to 40%/i);
    expect(copy).toContain("takes the month from about $22 to about $1");
  });

  it("says managed Venice credits pass through Hivra, and names no almost-always saving", () => {
    const copy = copyOf("byo-api-key-explained");
    expect(copy).not.toContain("every AI request your agent makes goes straight to the provider");
    expect(copy).toContain("when you bring your own key or login");
    expect(copy).toContain("those requests do pass through Hivra");
    expect(BLOG_ARTICLES["byo-api-key-explained"].intro).toContain("With your own credentials, requests go straight from the agent to the model provider");
    expect(BLOG_ARTICLES["byo-api-key-explained"].shortAnswer).toContain("with your own key your prompts don't pass through a Hivra proxy");
    expect(copy).toContain("managed Venice credits are the exception: those requests do pass through Hivra");
    expect(copy).not.toMatch(/almost always/i);
  });

  it("prices the Telegram overhead at a stated Sonnet 5.5 rate", () => {
    const copy = copyOf("hermes-agent-telegram-discord-setup");
    expect(copy).not.toContain("Sonnet 4.6 pricing");
    expect(copy).toContain("Sonnet 5.5 input pricing ($2 per million tokens, as of October 2026), that is roughly $0.03 to $0.04 per message");
    // 15,000 to 20,000 tokens at $2 per million.
    expect((15000 * 2) / 1e6).toBeCloseTo(0.03, 5);
    expect((20000 * 2) / 1e6).toBeCloseTo(0.04, 5);
  });
});
