/** @jest-environment node */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AGENTS_SECTION,
  CLOSING,
  COMPUTERS,
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

// Ash treats Windows and Omarchy computers as live (2026-09-28), so the shared
// rule that keeps "Windows" off other public pages does not apply here.
const HOMEPAGE_ALLOWED = /Windows computers are not generally available/;

// Links and the literal `git clone` command are not claims: the "clones" rule
// is about computer cloning, which is not shipped, not about cloning a repo.
const VISIBLE_COPY = [HERO, REACH, FIT, AGENTS_SECTION, HOME_AGENTS, COMPUTERS, HOW, OPEN_SOURCE, PRICING, FOUNDER, HOMEPAGE_FAQ, CLOSING, STICKY, GUARANTEE_LINE]
  .flatMap(strings)
  .filter(text => !text.startsWith("/") && !text.startsWith("https://") && text !== OPEN_SOURCE.clone);

describe("homepage copy", () => {
  it("makes none of the claims public pages are barred from making", () => {
    const hits = VISIBLE_COPY.flatMap(text => {
      return findBannedClaims(text)
        .filter(hit => !HOMEPAGE_ALLOWED.test(hit.why))
        .map(hit => `${hit.match} in "${text}": ${hit.why}`);
    });
    expect(hits).toEqual([]);
    expect(VISIBLE_COPY.flatMap(falseCliRunClaims)).toEqual([]);
  });

  it("labels nothing as a preview and names no licence", () => {
    expect(VISIBLE_COPY.filter(text => /preview|Apache/i.test(text))).toEqual([]);
    expect(COMPUTERS.body).toContain("Windows");
  });

  it("states the prices and sizes checkout sells, with the guarantee", () => {
    expect(PRICING.cloud.price).toBe(ENTRY_PLAN_PRICE);
    expect(PRICING.cloud.size).toBe(ENTRY_PLAN_SIZE);
    expect(PRICING.cloud.more).toBe(`Need more room? ${LARGER_PLAN_PRICE} a month for ${LARGER_PLAN_SIZE}.`);
    expect(PRICING.cloud.href).toBe("/get-started?plan=operator");
    expect(PRICING.cloud.moreHref).toBe("/get-started?plan=fleet");
    expect(GUARANTEE_LINE).toBe(`${MONEY_BACK_GUARANTEE}.`);
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

  it("compares Hivra with the litepaper's own table, cell for cell", () => {
    const table = litepaper.split("\n").filter(line => line.startsWith("|"));
    const [header, , ...rows] = table.map(line => line.split("|").slice(1, -1).map(cell => cell.trim()));
    expect(header.slice(1)).toEqual([...FIT.columns]);
    expect(rows.map(([label, ...cells]) => ({ label, cells }))).toEqual(FIT.rows.map(row => ({ label: row.label, cells: [...row.cells] })));
    for (const line of [FIT.lead, FIT.verdict, FIT.note, `${FIT.title} ${FIT.titleTail}`]) expect(litepaperText).toContain(line);
  });

  it("sends each agent card to Launch with that agent chosen", () => {
    expect(HOME_AGENTS.map(agent => agent.id)).toEqual(["claude-code", "codex", "hermes", "openclaw", "agent-zero", "aeon"]);
    for (const agent of HOME_AGENTS) expect(agent.href).toBe(buildLaunchHref({ start: true, profile: agent.id }));
  });
});
