/** @jest-environment node */
import {
  AGENTS_SECTION,
  AGENTS_STAT,
  CLOSING,
  COMPUTERS,
  FAQ_TITLE,
  HERO,
  HOMEPAGE_FAQ,
  HOME_AGENTS,
  PRICING,
  SEPARATE,
  STEPS,
  STICKY,
  homepageFaq,
} from "../content";
import { findBannedClaims } from "@/lib/tools/copy-rules";
import {
  ENTRY_PLAN_PRICE,
  ENTRY_PLAN_SIZE,
  LARGER_PLAN_PRICE,
  LARGER_PLAN_SIZE,
  MONEY_BACK_GUARANTEE,
  PLAN_DISPLAY,
} from "@/lib/blog/plan-facts";
import { buildLaunchHref } from "@/lib/hivra/launch-navigation";

// The homepage wording is Ash's final copy of 12 Nov 2026, used word for word.
// These tests pin the facts it states and the implementation notes that came
// with it, so a later edit can't drift from either without a failing test.

/** Every string the homepage shows, however deeply it is nested. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

const isLink = (text: string) => text.startsWith("/") || text.startsWith("#") || text.startsWith("https://");
const isBarePrice = (text: string) => /^\$\d+\.\d{2}$/.test(text);

const VISIBLE_COPY = [HERO, SEPARATE, AGENTS_STAT, AGENTS_SECTION, HOME_AGENTS, COMPUTERS, STEPS, PRICING, HOMEPAGE_FAQ, FAQ_TITLE, CLOSING, STICKY]
  .flatMap(strings)
  .filter(text => !isLink(text) && !isBarePrice(text));

describe("homepage copy", () => {
  it("makes none of the claims public pages are barred from making", () => {
    const hits = VISIBLE_COPY.flatMap(text => findBannedClaims(text).map(hit => `${hit.match} in "${text}": ${hit.why}`));
    expect(hits).toEqual([]);
  });

  it("holds no dash, no placeholder in brackets and no American spelling", () => {
    expect(VISIBLE_COPY.filter(text => /[–—]/.test(text))).toEqual([]);
    expect(VISIBLE_COPY.filter(text => /[[\]]/.test(text))).toEqual([]);
    expect(VISIBLE_COPY.filter(text => /\b(?:favorite|favor|color|center|organization|optimize|license|behavior)\b/i.test(text))).toEqual([]);
  });

  it("leads with the agent's own computer", () => {
    expect(`${HERO.titleLead} ${HERO.titleWord} ${HERO.titleTail}`).toBe("Give your AI agent a computer of its own.");
    expect(HERO.proof).toEqual(["Your agent's own computer", "Bring your own AI key", "Run on Hivra Cloud or your own infrastructure"]);
    expect(HERO.secondaryHref).toBe("#how");
    expect(`${SEPARATE.title} ${SEPARATE.titleTail}`).toBe("Your agent needs computer access. It doesn't need your computer.");
  });

  // Implementation note 11: agents keep their own interfaces.
  it("never flattens every agent into a chat", () => {
    expect(VISIBLE_COPY.filter(text => /just talk to it|then you just|chat with it/i.test(text))).toEqual([]);
  });

  // Implementation note 1.
  it("puts Hermes first with the Recommended badge, and no other card carries one", () => {
    expect(HOME_AGENTS.map(agent => agent.id)).toEqual(["hermes", "claude-code", "codex", "openclaw", "agent-zero"]);
    expect(HOME_AGENTS.filter(agent => agent.badge).map(agent => [agent.id, agent.badge])).toEqual([["hermes", "Recommended"]]);
    expect(VISIBLE_COPY.filter(text => /Start here/.test(text))).toEqual([]);
    for (const agent of HOME_AGENTS) expect(agent.href).toBe(buildLaunchHref({ start: true, profile: agent.id }));
  });

  // Implementation note 2: a promised login always carries the provider's terms.
  it("adds the provider's terms wherever an account sign-in is promised", () => {
    const logins = VISIBLE_COPY.filter(text => /\bsign in with\b/i.test(text));
    expect(logins.length).toBeGreaterThan(0);
    for (const text of logins) expect(text).toMatch(/subject to (?:the|that) provider's terms/);
  });

  // Implementation note 9.
  it("states the guarantee in exactly the shared wording wherever it appears", () => {
    expect(MONEY_BACK_GUARANTEE).toBe("7-day money-back guarantee on card payments");
    const mentions = VISIBLE_COPY.filter(text => /money-back/i.test(text));
    expect(mentions.length).toBeGreaterThanOrEqual(2);
    for (const text of mentions) expect(text).toContain(MONEY_BACK_GUARANTEE);
    expect(VISIBLE_COPY.filter(text => /seven-day|\btrial\b|no card|free plan|\/yr|per year/i.test(text))).toEqual([]);
  });

  // Implementation note 6: a free account never includes free compute.
  it("never says the free account comes with free computing", () => {
    expect(VISIBLE_COPY.filter(text => /^Free to start\b|free hosting|free compute|free computer/i.test(text))).toEqual([]);
    expect(PRICING.free.tagline).toBe("No Hivra hosting charge");
    expect(PRICING.free.body).toContain("You provide and maintain the server. Hivra doesn't charge you for hosting it.");
    const isFree = HOMEPAGE_FAQ.find(({ q }) => q === "Is Hivra free?");
    expect(isFree?.a).toContain("Every Hivra Cloud computer requires a paid plan.");
    expect(isFree?.a).toContain("You'll still be responsible for the cost and maintenance of that infrastructure.");
  });

  // Implementation note 5.
  it("never says a separate computer makes an agent completely secure", () => {
    const security = HOMEPAGE_FAQ.find(({ q }) => q === "Is my agent completely isolated and secure?");
    expect(security?.a).toContain("no environment can guarantee complete security");
    expect(VISIBLE_COPY.filter(text => /perfectly safe|completely safe|fully secure|100% secure/i.test(text))).toEqual([]);
  });

  // Implementation notes 7 and 8.
  it("does not advertise a finished open-source release or the starter credit", () => {
    const openSource = HOMEPAGE_FAQ.find(({ q }) => q === "Is Hivra open source?");
    expect(openSource?.a).toContain("will be provided when the release is ready");
    expect(VISIBLE_COPY.filter(text => /starter credit|\$2\b/i.test(text))).toEqual([]);
  });

  it("states the prices and sizes checkout sells", () => {
    expect(PRICING.cloud.name).toBe(PLAN_DISPLAY.entry);
    expect(PRICING.larger.name).toBe(PLAN_DISPLAY.larger);
    expect([PRICING.cloud.price, PRICING.cloud.size]).toEqual([ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE]);
    expect([PRICING.larger.price, PRICING.larger.size]).toEqual([LARGER_PLAN_PRICE, LARGER_PLAN_SIZE]);
    expect(PRICING.cloud.tagline).toBe(`Managed hosting | From ${ENTRY_PLAN_PRICE}/month`);
    expect(PRICING.cloud.href).toBe("/get-started?plan=operator");
    expect(PRICING.larger.href).toBe("/pricing");
    expect(PRICING.free.href).toBe("/sign-up");
    expect(STICKY.note).toBe(`Hivra Cloud from ${ENTRY_PLAN_PRICE}/month`);
  });

  it("gives choosing where the agent runs its own step", () => {
    expect(STEPS.steps.map(step => step.title)).toEqual(["Choose your agent", "Connect its AI", "Choose where it runs", "Launch and get to work"]);
  });

  it("answers these questions, in this order, with no token question", () => {
    expect(FAQ_TITLE).toBe("Frequently asked questions");
    expect(HOMEPAGE_FAQ.map(({ q }) => q)).toEqual([
      "Is Hivra free?",
      "Do I need my own server?",
      "Do I need an API key?",
      "Will my agent keep running if I close my laptop?",
      "Is my agent completely isolated and secure?",
      "Can I use my own Claude or ChatGPT subscription?",
      "Is Hivra open source?",
    ]);
    expect(homepageFaq(true)).toEqual(homepageFaq(false));
    expect(VISIBLE_COPY.filter(text => /\$HIVRA|airdrop|snapshot|litepaper|tokenomics|launchpad|bankr|\btokens?\b/i.test(text))).toEqual([]);
  });

  it("ends on the closing ask with both ways to start", () => {
    expect(CLOSING.title).toBe("Your agent doesn't need to run on your computer.");
    expect(CLOSING.paragraphs).toContain(`Launch on Hivra Cloud from ${ENTRY_PLAN_PRICE}/month, with a ${MONEY_BACK_GUARANTEE}.`);
    expect(CLOSING.secondaryHref).toBe("/sign-up");
  });

  it("points the buttons at the destinations that exist", () => {
    expect(COMPUTERS.href).toBe("/dashboard/launch?kind=computer&start=1&profile=ubuntu-desktop");
  });
});
