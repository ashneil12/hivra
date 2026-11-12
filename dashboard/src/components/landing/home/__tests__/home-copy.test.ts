/** @jest-environment node */
import {
  AGENTS_SECTION,
  AGENTS_STAT,
  CLOSING,
  COMPUTERS,
  FAQ_TITLE,
  FOUNDER,
  GUARANTEE_LINE,
  HERO,
  HOMEPAGE_FAQ,
  HOME_AGENTS,
  PRICING,
  STAYS_ON,
  STEPS,
  STICKY,
  TOKEN_FAQ_SENTENCE,
  homepageFaq,
} from "../content";
import { findBannedClaims } from "@/lib/tools/copy-rules";
import {
  ENTRY_PLAN_PRICE,
  ENTRY_PLAN_SIZE,
  LARGER_PLAN_PRICE,
  LARGER_PLAN_SIZE,
  MONEY_BACK_GUARANTEE,
  FREE_ACCOUNT_SENTENCE,
  HOSTED_COMPUTE_NEEDS_PLAN,
  HOSTED_COMPUTE_NEEDS_PLAN_SHORT,
  PLAN_DISPLAY,
} from "@/lib/blog/plan-facts";
import { CLI_RUN_LIFETIME, SERVER_SIDE_AGENTS_KEEP_WORKING, falseCliRunClaims } from "@/lib/blog/runtime-facts";
import { buildLaunchHref } from "@/lib/hivra/launch-navigation";
import { unqualifiedKeepRunningClaims } from "@/lib/hivra/agent-seo-catalog";

// The homepage wording is Ash's website pack (01-homepage.md, 20 Oct 2026). The
// pack no longer equals LITEPAPER.md, so the old tests that matched the REACH
// and FIT copy against the litepaper word for word are retired on purpose; what
// is pinned here are the repo's own rules and the facts the page states.

/** Every string the homepage shows, however deeply it is nested. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

// The short homepage (10 Nov 2026) names neither Windows nor Omarchy, so the
// shared rule that keeps "Windows" off public pages applies here in full.
const HOMEPAGE_ALLOWED = /^$/;

/** A price shown beside its size in the same card, as the page text reads. */
const PRICE_CARDS = [PRICING.cloud, PRICING.larger].map(card => `${card.price}${card.per} ${card.size}`);

const isLink = (text: string) => text.startsWith("/") || text.startsWith("#") || text.startsWith("https://");
const isBarePrice = (text: string) => text === PRICING.cloud.price || text === PRICING.larger.price || text === PRICING.free.price;

// Links and the bare price figure (it is scanned with its size, above) are not claims.
const VISIBLE_COPY = [
  HERO,
  AGENTS_STAT,
  AGENTS_SECTION,
  HOME_AGENTS,
  COMPUTERS,
  STEPS,
  PRICING,
  FOUNDER,
  HOMEPAGE_FAQ,
  homepageFaq(true),
  FAQ_TITLE,
  CLOSING,
  STICKY,
  GUARANTEE_LINE,
]
  .flatMap(strings)
  .filter(text => !isLink(text) && !isBarePrice(text));

/** Copy that is written for this page and makes promises about running (the founder lines are old litepaper text, not shown). */
const OWN_WORDS = [HERO, AGENTS_SECTION, HOME_AGENTS, COMPUTERS, STEPS, PRICING, HOMEPAGE_FAQ, homepageFaq(true), CLOSING, STICKY, GUARANTEE_LINE].flatMap(strings);

describe("homepage copy", () => {
  it("makes none of the claims public pages are barred from making", () => {
    const hits = [...VISIBLE_COPY, ...PRICE_CARDS].flatMap(text => {
      return findBannedClaims(text)
        .filter(hit => !HOMEPAGE_ALLOWED.test(hit.why))
        .map(hit => `${hit.match} in "${text}": ${hit.why}`);
    });
    expect(hits).toEqual([]);
    expect(VISIBLE_COPY.flatMap(falseCliRunClaims)).toEqual([]);
  });

  it("holds no dash, no placeholder in brackets and no American spelling", () => {
    expect(VISIBLE_COPY.filter(text => /[\u2013\u2014]/.test(text))).toEqual([]);
    expect(VISIBLE_COPY.filter(text => /[[\]]/.test(text))).toEqual([]);
    expect(VISIBLE_COPY.filter(text => /\b(?:favorite|favor|color|center|organization|optimize|license|behavior)\b/i.test(text))).toEqual([]);
  });

  // F-17. Only a run started in tmux, or a Claude Code run sent through Telegram,
  // is certain to keep going on every computer (lib/blog/runtime-facts.ts), so the
  // page says what holds everywhere: a paid computer stays on and is not paused.
  it("promises only that a paid computer stays on, never that every run keeps going", () => {
    expect(STAYS_ON).toBe("A paid Hivra Cloud computer stays on and is not paused for inactivity");
    expect(STEPS.steps[2].body).toContain(`${STAYS_ON}.`);
    expect(OWN_WORDS.flatMap(text => unqualifiedKeepRunningClaims(text))).toEqual([]);
  });

  // The guard that scans the homepage must flag the exact sentences it replaced,
  // so a repeat of the old wording fails here and not in review.
  it("flags the retired keep-running sentences", () => {
    const retired = [
      "Hivra gives each one a private computer in the cloud. It keeps working when you close your laptop, and you decide what it can reach.",
      "Its files and sessions remain in its own environment, and processes you set up to keep running can continue.",
    ];
    expect(retired.flatMap(text => unqualifiedKeepRunningClaims(text))).toHaveLength(2);
  });

  // F-15. No page states how long setting up a server takes.
  it("states no invented time for renting and setting up a server", () => {
    expect(VISIBLE_COPY.filter(text => /\b(?:weekend|afternoon)\b|\b(?:an|one|\d+) hours?\b/i.test(text))).toEqual([]);
  });

  it("labels nothing as a preview, names no licence and claims no affiliation", () => {
    expect(VISIBLE_COPY.filter(text => /preview|Apache|\bMIT\b|public domain/i.test(text))).toEqual([]);
    expect(VISIBLE_COPY.filter(text => /\b(?:affiliated|endorsed|partner(?:ed|ship)?)\b/i.test(text))).toEqual([]);
  });

  it("names neither Windows nor Omarchy, and no plan or size name", () => {
    expect(VISIBLE_COPY.filter(text => /\b(?:Windows|Omarchy)\b/.test(text))).toEqual([]);
    expect(VISIBLE_COPY.filter(text => /\b(?:Starter|Power)\b|\bHivra Pro\b|\bPro plan\b/.test(text))).toEqual([]);
  });

  it("states the prices and sizes checkout sells, by price and size", () => {
    expect(PRICING.cloud.name).toBe(PLAN_DISPLAY.entry);
    expect(PRICING.larger.name).toBe(PLAN_DISPLAY.larger);
    expect(PRICING.cloud.price).toBe(ENTRY_PLAN_PRICE);
    expect(PRICING.cloud.size).toBe(ENTRY_PLAN_SIZE);
    expect(PRICING.larger.price).toBe(LARGER_PLAN_PRICE);
    expect(PRICING.larger.size).toBe(LARGER_PLAN_SIZE);
    expect(PRICE_CARDS).toEqual(["$9.99/month 2 vCPU and 4 GB of RAM", "$19.99/month 4 vCPU and 8 GB of RAM"]);
    expect(PRICING.titleTail).toBe(`Hosted plans start at ${ENTRY_PLAN_PRICE} a month.`);
    expect(PRICING.cloud.href).toBe("/get-started?plan=operator");
    expect(PRICING.larger.href).toBe("/get-started?plan=fleet");
    expect(PRICING.free.href).toBe("/sign-up");
    expect(PRICING.free.selfHost.href).toBe("https://github.com/ashneil12/hivra");
    expect(STICKY.note).toBe(`Hivra Cloud from ${ENTRY_PLAN_PRICE}/month`);
  });

  it("states the guarantee in the shared wording and does not claim a trial, a free hosted plan or annual prices", () => {
    expect(GUARANTEE_LINE).toBe(`${MONEY_BACK_GUARANTEE}.`);
    expect(PRICING.guarantee.lead).toBe(`Hosted plans carry a ${MONEY_BACK_GUARANTEE}, subject to the`);
    expect(PRICING.guarantee.href).toBe("/terms");
    expect(VISIBLE_COPY.filter(text => /seven-day|eligible|at checkout|\btrial\b|no card|free plan|\/yr|per year/i.test(text))).toEqual([]);
  });

  it("says the plan does not include AI usage, and where a login is promised adds the provider's terms", () => {
    expect(PRICING.aiUsage).toContain(
      "The plan does not include AI usage. Bring your own account or key where the agent supports it, or pay with Hivra credits.",
    );
    expect(STEPS.steps[1].body).toContain("subject to the provider's terms");
    // A login is never promised without the provider's terms.
    for (const text of VISIBLE_COPY.filter(candidate => /\bsign in with\b|\b(?:ChatGPT|Claude) login\b/i.test(candidate))) expect(text).toContain("subject to the provider's terms");
    const cards = Object.fromEntries(HOME_AGENTS.map(agent => [agent.id, agent]));
    expect(cards["claude-code"].line).toContain("subject to the provider's terms");
    expect(cards.codex.line).toContain("subject to the provider's terms");
    const keepUsing = HOMEPAGE_FAQ.find(({ q }) => q === "Can I keep using Claude Code or Codex?");
    expect(keepUsing?.a).toContain("subject to the provider's terms");
    expect(keepUsing?.a).toContain("The plan does not include AI usage.");
    // Claude Code takes its own account or Hivra credits (lib/launch/model-access.ts).
    expect(keepUsing?.a).toContain("Claude Code uses your own Claude or Anthropic account, or Hivra credits. For Codex, bring your own account or key, or pay with Hivra credits.");
  });

  it("answers six questions, in this order", () => {
    expect(HOMEPAGE_FAQ.map(({ q }) => q)).toEqual([
      "What exactly is Hivra?",
      "Can I keep using Claude Code or Codex?",
      "What happens when I close my laptop?",
      "Does a separate computer make the agent perfectly safe?",
      "Is Hivra free?",
      "Do I need a token?",
    ]);
    expect(FAQ_TITLE).toBe("Questions.");
  });

  it("answers the keep-running question with the verified runtime facts, word for word", () => {
    const answer = HOMEPAGE_FAQ.find(({ q }) => q === "What happens when I close my laptop?");
    expect(answer?.a).toBe(`${CLI_RUN_LIFETIME} ${SERVER_SIDE_AGENTS_KEEP_WORKING} You can return to the same environment through your browser.`);
  });

  // The token surfaces are off in production and some viewers are geo-blocked:
  // then no sentence on the page is about a token beyond the short "no".
  it("keeps every other token sentence behind the token gate", () => {
    const off = homepageFaq(false);
    const on = homepageFaq(true);
    expect(HOMEPAGE_FAQ).toEqual(off);
    expect(off.find(({ q }) => q === "Do I need a token?")?.a).toBe("No. You can use card-paid hosting or self-host without one.");
    expect(on.find(({ q }) => q === "Do I need a token?")?.a).toBe(`No. You can use card-paid hosting or self-host without one. ${TOKEN_FAQ_SENTENCE}`);
    expect(on.filter(({ q }) => q !== "Do I need a token?")).toEqual(off.filter(({ q }) => q !== "Do I need a token?"));

    const alwaysOn = [HERO, AGENTS_SECTION, HOME_AGENTS, COMPUTERS, STEPS, PRICING, CLOSING, STICKY, off, FAQ_TITLE].flatMap(strings);
    expect(alwaysOn.filter(text => /\$HIVRA|\$HermesOS|hermesos token|airdrop|snapshot|litepaper|tokenomics|launchpad|bankr|migrat/i.test(text))).toEqual([]);
    expect(alwaysOn.filter(text => /\btokens?\b/i.test(text))).toEqual(["Do I need a token?"]);
    expect(alwaysOn.concat(on.map(({ a }) => a)).filter(text => /\/litepaper|docs\/litepaper/.test(text))).toEqual([]);
  });

  it("sends each agent card to Launch with that agent chosen, with the limits the cards state", () => {
    // The recommended agent leads, so it takes one of the two large cards.
    expect(HOME_AGENTS.map(agent => agent.id)).toEqual(["hermes", "claude-code", "codex", "openclaw", "agent-zero"]);
    for (const agent of HOME_AGENTS) expect(agent.href).toBe(buildLaunchHref({ start: true, profile: agent.id }));
    // Cards are read by the job they do; the agent's name is the title.
    expect(HOME_AGENTS.map(agent => agent.role)).toEqual([
      "Research and everyday tasks",
      "Code with Claude",
      "Code with Codex",
      "Work from your chat apps",
      "Take on bigger tasks",
    ]);
    // One card, the one most people should start with, carries a badge.
    expect(HOME_AGENTS.filter(agent => agent.badge).map(agent => [agent.id, agent.badge])).toEqual([["hermes", "Recommended"]]);
    // Only a real limit shows on a card. No card singles out one agent as the paid one: the cost belongs to
    // the computer, and the line above the cards says so once (pinned in the next test).
    expect(Object.fromEntries(HOME_AGENTS.map(agent => [agent.id, agent.note]))).toEqual({
      "claude-code": undefined,
      codex: undefined,
      hermes: "Hermes runs on Hivra Cloud only.",
      openclaw: undefined,
      "agent-zero": undefined,
    });
  });

  // Owner decision, 21 October 2026: Hivra runs no free computer. The cards used to say "Needs a paid size."
  // on OpenClaw and Agent Zero only, which told a visitor the other four agents could run on Hivra Cloud for
  // nothing. The rule is stated once in the canonical words wherever a visitor chooses what to start.
  it("says in the canonical words that every Hivra Cloud computer is paid and a free account works with your own", () => {
    const rule =
      "Every computer that Hivra Cloud runs for you needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM. A free account works with a computer or server you connect yourself.";
    expect(HOSTED_COMPUTE_NEEDS_PLAN).toBe(rule);
    expect(AGENTS_SECTION.paid).toBe(rule);
    // The closing leads with Hivra Cloud and its guarantee; "free" only comes with its condition, your own server.
    expect(CLOSING.paid).toContain(`Launch with Hivra Cloud from ${ENTRY_PLAN_PRICE} a month, with a ${MONEY_BACK_GUARANTEE}.`);
    expect(CLOSING.paid).toContain("Connect supported infrastructure with a free Hivra account.");
    expect(AGENTS_SECTION.paid).toContain(`from ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}`);
    expect(HOSTED_COMPUTE_NEEDS_PLAN_SHORT).toBe("Every Hivra Cloud computer needs a paid plan.");
    // "Free" never stands alone: it always names the server you bring (UTAUT2 review, 12 Nov 2026).
    expect(HERO.proof).toEqual(["7-day money-back guarantee", "Free on your own server", "Open source"]);
    expect(VISIBLE_COPY.filter(text => /^Free to start$/i.test(text))).toEqual([]);
    // The free card separates the free Hivra account from the server, which the person provides.
    expect(PRICING.free.per).toBe("Hivra account");
    expect(PRICING.free.size).toBe("You provide the server");
    const hasRule = HOMEPAGE_FAQ.find(({ q }) => q === "Is Hivra free?");
    expect(hasRule?.a).toContain("Hivra Cloud is the managed option and requires a paid plan for each computer.");
    expect(hasRule?.a).toContain("there is no Hivra hosting charge");
    expect(FREE_ACCOUNT_SENTENCE).toBe("A free account works with a computer or server you connect yourself.");
    // No per-agent paid note survives anywhere on the page, and every line that says a computer needs a paid
    // plan says it of every Hivra Cloud computer, never of one agent.
    expect(VISIBLE_COPY.filter(text => /paid size/i.test(text))).toEqual([]);
    expect(HOME_AGENTS.filter(agent => /paid/i.test(`${agent.line} ${agent.note ?? ""}`)).map(agent => agent.id)).toEqual([]);
    const paidLines = VISIBLE_COPY.filter(text => /needs a paid plan/i.test(text));
    expect(paidLines.length).toBeGreaterThanOrEqual(1);
    for (const text of paidLines) expect(text).toMatch(/Every (?:computer that Hivra Cloud runs for you|Hivra Cloud computer) needs a paid plan/);
  });

  it("points the buttons at the destinations that exist", () => {
    expect(PRICING.full.href).toBe("/pricing");
    expect(COMPUTERS.href).toBe("/dashboard/launch?kind=computer&start=1&profile=ubuntu-desktop");
  });
});
