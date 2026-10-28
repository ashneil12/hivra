/** @jest-environment node */
import {
  AGENTS_SECTION,
  AGENTS_STAT,
  CLOSING,
  COMPUTERS,
  FAQ_TITLE,
  FIT,
  FOUNDER,
  GUARANTEE_LINE,
  HERO,
  HOMEPAGE_FAQ,
  HOME_AGENTS,
  HOW,
  OPEN_SOURCE,
  PRICING,
  REACH,
  STAYS_ON,
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

// The homepage may name Windows and Omarchy (owner decision 2026-09-28), but only
// with their conditions and never as plainly available, so the shared rule that
// keeps "Windows" off other public pages is skipped here. The condition that goes
// with Windows is pinned below.
const HOMEPAGE_ALLOWED = /Windows computers are not generally available/;

/** A price shown beside its size in the same card, as the page text reads. */
const PRICE_CARDS = [PRICING.cloud, PRICING.larger].map(card => `${card.price}${card.per} ${card.size}`);

const isLink = (text: string) => text.startsWith("/") || text.startsWith("#") || text.startsWith("https://");
const isBarePrice = (text: string) => text === PRICING.cloud.price || text === PRICING.larger.price;

// Links, the bare price figure (it is scanned with its size, above) and the
// literal `git clone` command are not claims: the "clones" rule is about
// computer cloning, which is not shipped, not about cloning a repo.
const VISIBLE_COPY = [
  HERO,
  AGENTS_STAT,
  REACH,
  FIT,
  AGENTS_SECTION,
  HOME_AGENTS,
  COMPUTERS,
  HOW,
  OPEN_SOURCE,
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
  .filter(text => !isLink(text) && text !== OPEN_SOURCE.clone && !isBarePrice(text));

/** Copy that is written for this page and makes promises about running (the founder lines are old litepaper text, not shown). */
const OWN_WORDS = [HERO, AGENTS_SECTION, HOME_AGENTS, COMPUTERS, HOW, PRICING, HOMEPAGE_FAQ, homepageFaq(true), CLOSING, STICKY, GUARANTEE_LINE].flatMap(strings);

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

  // F-17. The hero once said "It keeps working when you close your laptop".
  // Only a run started in tmux, or a Claude Code run sent through Telegram, is
  // certain to keep going on every computer (lib/blog/runtime-facts.ts), so the
  // page says what holds everywhere: a paid computer stays on and is not paused.
  it("promises only that a paid computer stays on, never that every run keeps going", () => {
    expect(STAYS_ON).toBe("A paid Hivra Cloud computer stays on and is not paused for inactivity");
    expect(HERO.subhead[1]).toContain(`${STAYS_ON}, even when you close your laptop.`);
    expect(HOW.steps[0].body).toContain(`${STAYS_ON}.`);
    // The only run-level promise names tmux.
    expect(HOW.steps[0].body).toContain("a run you start in tmux keeps going.");
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

  // The code runs Omarchy as a prepared computer (it refuses a launch when no
  // prepared slot exists) and Windows on the visitor's own server from their own
  // licensed image, so neither is ever called plainly available.
  it("names Omarchy and Windows only with their conditions, and no other plan or size name", () => {
    const body = COMPUTERS.body.join(" ");
    expect(body).toContain(
      "Ubuntu, Omarchy (prepared computer) and Windows on your own server with your licensed image are among the operating-system options",
    );
    expect(body).not.toMatch(/\bavailable\b/i);
    // The chips follow the sentence's order: Omarchy, then Windows.
    expect(COMPUTERS.others.map(({ name, note }) => `${name} ${note}`)).toEqual([
      "Omarchy (prepared computer)",
      "Windows on your own server with your licensed image",
    ]);
    for (const text of VISIBLE_COPY.filter(candidate => candidate.length > 20 && /\bWindows\b/.test(candidate))) expect(text).toContain("Windows on your own server with your licensed image");
    for (const text of VISIBLE_COPY.filter(candidate => candidate.length > 20 && /\bOmarchy\b/.test(candidate))) expect(text).toContain("Omarchy (prepared computer)");
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
    expect(PRICING.titleTail).toBe(`Or let us run it from ${ENTRY_PLAN_PRICE} a month.`);
    expect(PRICING.cloud.href).toBe("/get-started?plan=operator");
    expect(PRICING.larger.href).toBe("/get-started?plan=fleet");
    expect(PRICING.server.href).toBe("/sign-up");
    expect(PRICING.selfHost.href).toBe("https://github.com/ashneil12/hivra");
    expect(STICKY.note).toBe("Free to start");
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
    expect(HERO.proof[1]).toContain("subject to the provider's terms");
    const cards = Object.fromEntries(HOME_AGENTS.map(agent => [agent.id, agent]));
    expect(cards["claude-code"].line).toContain("subject to the provider's terms");
    expect(cards.codex.line).toContain("subject to the provider's terms");
    const keepUsing = HOMEPAGE_FAQ.find(({ q }) => q === "Can I keep using Claude Code or Codex?");
    expect(keepUsing?.a).toContain("subject to the provider's terms");
    expect(keepUsing?.a).toContain("The plan does not include AI usage.");
    // Claude Code has no Hivra-credits path (agent-catalog.ts: no alternative providers), so credits are named for Codex only.
    expect(keepUsing?.a).toContain("Claude Code uses your own Claude or Anthropic account. For Codex, bring your own account or key, or pay with Hivra credits.");
    expect(keepUsing?.a).not.toMatch(/Claude Code[^.]*Hivra credits/);
  });

  it("answers the seven questions in the pack's order", () => {
    expect(HOMEPAGE_FAQ.map(({ q }) => q)).toEqual([
      "What exactly is Hivra?",
      "Can I keep using Claude Code or Codex?",
      "What happens when I close my laptop?",
      "Does a separate computer make the agent perfectly safe?",
      "Do I have to use Hivra Cloud?",
      "Do I need a token?",
      "Why not rent a normal server?",
    ]);
    expect(FAQ_TITLE).toBe("A few questions, answered.");
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

    const alwaysOn = [HERO, REACH, FIT, AGENTS_SECTION, HOME_AGENTS, COMPUTERS, HOW, OPEN_SOURCE, PRICING, CLOSING, STICKY, off, FAQ_TITLE].flatMap(strings);
    expect(alwaysOn.filter(text => /\$HIVRA|\$HermesOS|hermesos token|airdrop|snapshot|litepaper|tokenomics|launchpad|bankr|migrat/i.test(text))).toEqual([]);
    expect(alwaysOn.filter(text => /\btokens?\b/i.test(text))).toEqual(["Do I need a token?"]);
    expect(alwaysOn.concat(on.map(({ a }) => a)).filter(text => /\/litepaper|docs\/litepaper/.test(text))).toEqual([]);
  });

  it("sends each agent card to Launch with that agent chosen, with the limits the cards state", () => {
    expect(HOME_AGENTS.map(agent => agent.id)).toEqual(["claude-code", "codex", "hermes", "openclaw", "agent-zero", "aeon"]);
    for (const agent of HOME_AGENTS) expect(agent.href).toBe(buildLaunchHref({ start: true, profile: agent.id }));
    expect(HOME_AGENTS.map(agent => agent.role)).toEqual([
      "Coding",
      "Coding",
      "Research and automation",
      "Chat-based agent",
      "General-purpose agent workspace",
      "Scheduled project automation",
    ]);
    // Only a real limit shows on a card. No card singles out one agent as the paid one: the cost belongs to
    // the computer, and the line above the cards says so once (pinned in the next test).
    expect(Object.fromEntries(HOME_AGENTS.map(agent => [agent.id, agent.note]))).toEqual({
      "claude-code": undefined,
      codex: undefined,
      hermes: "Hermes runs on Hivra Cloud only.",
      openclaw: undefined,
      "agent-zero": undefined,
      aeon: undefined,
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
    // The closing leads with the free start; the paid-plan rule stays stated in the canonical words elsewhere.
    expect(CLOSING.paid).toContain("launch on Hivra Cloud with a paid plan");
    expect(CLOSING.paid).not.toMatch(/\$\d/);
    expect(AGENTS_SECTION.paid).toContain(`from ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}`);
    expect(COMPUTERS.body).toContain(HOSTED_COMPUTE_NEEDS_PLAN_SHORT);
    expect(HOSTED_COMPUTE_NEEDS_PLAN_SHORT).toBe("Every Hivra Cloud computer needs a paid plan.");
    // The hero names the paid route and the free one without a price (the hero test above keeps prices off the first screen).
    expect(HERO.proof[0]).toBe("Free to start. Sign up, connect your own server or cloud, or self-host the platform.");
    expect(HERO.proof[2]).toBe("Prefer not to run a server? Hivra can host it for you on a paid plan.");
    expect(PRICING.server.body).toBe("Use infrastructure you already rent and pay that provider directly. A free account is enough.");
    const hasRule = HOMEPAGE_FAQ.find(({ q }) => q === "Do I have to use Hivra Cloud?");
    expect(hasRule?.a).toContain(HOSTED_COMPUTE_NEEDS_PLAN_SHORT);
    expect(FREE_ACCOUNT_SENTENCE).toBe("A free account works with a computer or server you connect yourself.");
    // No per-agent paid note survives anywhere on the page, and every line that says a computer needs a paid
    // plan says it of every Hivra Cloud computer, never of one agent.
    expect(VISIBLE_COPY.filter(text => /paid size/i.test(text))).toEqual([]);
    expect(HOME_AGENTS.filter(agent => /paid/i.test(`${agent.line} ${agent.note ?? ""}`)).map(agent => agent.id)).toEqual([]);
    const paidLines = VISIBLE_COPY.filter(text => /needs a paid plan/i.test(text));
    expect(paidLines.length).toBeGreaterThanOrEqual(4);
    for (const text of paidLines) expect(text).toMatch(/Every (?:computer that Hivra Cloud runs for you|Hivra Cloud computer) needs a paid plan/);
  });

  it("points the pack's buttons at the destinations that exist", () => {
    expect(FIT.moreHref).toBe("/compare");
    expect(COMPUTERS.explore.href).toBe("#computers");
    expect(HOW.secondary.href).toBe("#pricing");
    expect(OPEN_SOURCE.security.href).toBe("/security");
    expect(PRICING.full.href).toBe("/pricing");
    expect(OPEN_SOURCE.clone).toBe("git clone https://github.com/ashneil12/hivra");
  });

  it("compares four places in six rows, each answer present for each column", () => {
    expect(FIT.columns).toEqual(["Your laptop", "A provider-managed agent", "A typical hosted machine", "Hivra"]);
    expect(FIT.rows).toHaveLength(6);
    for (const row of FIT.rows) expect(row.cells).toHaveLength(FIT.columns.length);
    expect(FIT.rows[0].cells[3]).toBe("Yes, on a paid cloud plan");
  });
});
