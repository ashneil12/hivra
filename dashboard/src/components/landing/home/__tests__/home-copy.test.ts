/** @jest-environment node */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AGENTS_SECTION,
  CLOSING,
  COMPUTERS,
  FOUNDER,
  GUARANTEE_LINE,
  HERO,
  HOMEPAGE_FAQ,
  HOME_AGENTS,
  HOW,
  OPEN_SOURCE,
  PRICING,
  REACH,
  STICKY,
} from "../content";
import { findBannedClaims } from "@/lib/tools/copy-rules";
import {
  ENTRY_PLAN_PRICE,
  ENTRY_PLAN_SIZE,
  LARGER_PLAN_PRICE,
  LARGER_PLAN_SIZE,
  MONEY_BACK_GUARANTEE,
} from "@/lib/blog/plan-facts";
import { CLI_RUN_LIFETIME, SERVER_SIDE_AGENTS_KEEP_WORKING, falseCliRunClaims } from "@/lib/blog/runtime-facts";
import { buildLaunchHref } from "@/lib/hivra/launch-navigation";

const REPO_ROOT = path.resolve(__dirname, "../../../../../..");
const litepaper = readFileSync(path.join(REPO_ROOT, "LITEPAPER.md"), "utf8");
/** The litepaper as a reader sees it: no Markdown emphasis markers. */
const litepaperText = litepaper.replace(/\*\*/g, "").replace(/(^|\s)\*([^*\n]+)\*/g, "$1$2");

/** Every string the homepage shows, however deeply it is nested. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

// Windows is not generally available: it may appear only in the sentence that
// says it is in private preview, and as the name on its private-preview chip.
const WINDOWS_PREVIEW_SENTENCE = "Windows and Omarchy are in private preview.";

// Links and the literal `git clone` command are not claims: the "clones" rule
// is about computer cloning, which is not shipped, not about cloning a repo.
const VISIBLE_COPY = [HERO, REACH, AGENTS_SECTION, HOME_AGENTS, COMPUTERS, HOW, OPEN_SOURCE, PRICING, FOUNDER, HOMEPAGE_FAQ, CLOSING, STICKY, GUARANTEE_LINE]
  .flatMap(strings)
  .filter(text => !text.startsWith("/") && !text.startsWith("https://") && text !== OPEN_SOURCE.clone);

describe("homepage copy", () => {
  it("makes none of the claims public pages are barred from making", () => {
    const hits = VISIBLE_COPY.flatMap(text => {
      const scoped = text === "Windows" ? "" : text.split(WINDOWS_PREVIEW_SENTENCE).join("");
      return findBannedClaims(scoped).map(hit => `${hit.match} in "${text}": ${hit.why}`);
    });
    expect(hits).toEqual([]);
    expect(VISIBLE_COPY.flatMap(falseCliRunClaims)).toEqual([]);
  });

  it("only names Windows as a private preview", () => {
    const mentions = VISIBLE_COPY.filter(text => /\bWindows\b/.test(text));
    expect(mentions.every(text => text === "Windows" || text.includes(WINDOWS_PREVIEW_SENTENCE))).toBe(true);
    expect(COMPUTERS.body).toContain(WINDOWS_PREVIEW_SENTENCE);
  });

  it("states the prices and sizes checkout sells, with the guarantee", () => {
    expect(PRICING.cloud.price).toBe(ENTRY_PLAN_PRICE);
    expect(PRICING.cloud.size).toBe(ENTRY_PLAN_SIZE);
    expect(PRICING.cloud.more).toBe(`Need more room? ${LARGER_PLAN_PRICE} a month for ${LARGER_PLAN_SIZE}.`);
    expect(PRICING.cloud.href).toBe("/get-started?plan=operator");
    expect(PRICING.cloud.moreHref).toBe("/get-started?plan=fleet");
    expect(GUARANTEE_LINE).toBe(`${MONEY_BACK_GUARANTEE}.`);
    expect(HERO.subhead).toContain(`From ${ENTRY_PLAN_PRICE} a month.`);
    expect(CLOSING.body).toContain(MONEY_BACK_GUARANTEE);
    expect(STICKY.note).toBe(`From ${ENTRY_PLAN_PRICE} a month`);
  });

  it("answers the keep-running question with the verified runtime facts, word for word", () => {
    const answer = HOMEPAGE_FAQ.find(({ q }) => q === "What happens when I close my laptop?");
    expect(answer?.a).toBe(`${CLI_RUN_LIFETIME} ${SERVER_SIDE_AGENTS_KEEP_WORKING}`);
    // The illustration and step copy only promise tmux runs keep going.
    expect(HOW.steps[0].body).toContain("A run you start in tmux keeps going.");
  });

  it("quotes the approved litepaper exactly", () => {
    const quoted = [
      ...REACH.bodyA,
      REACH.kicker,
      REACH.bodyB,
      ...REACH.states.map(state => state.caption),
      REACH.shareCaption,
      REACH.note,
      ...FOUNDER.lines,
    ];
    for (const line of quoted) expect(litepaperText).toContain(line);
    expect(litepaperText).toContain(`${REACH.titleB} ${REACH.bodyB}`);
  });

  it("sends each agent card to Launch with that agent chosen", () => {
    expect(HOME_AGENTS.map(agent => agent.id)).toEqual(["claude-code", "codex", "hermes", "openclaw", "agent-zero", "aeon"]);
    for (const agent of HOME_AGENTS) expect(agent.href).toBe(buildLaunchHref({ start: true, profile: agent.id }));
  });
});
