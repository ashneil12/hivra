/**
 * The roadmap as a viewer sees it when the token surfaces are hidden: the switch is off, or the
 * viewer is in a country the token geo-policy lists. The copy has token sentences in a few places,
 * so the hidden roadmap is checked word by word, the way docs/litepaper/test_restricted.py checks
 * the static documents: any token word left anywhere fails the build, except the three short
 * "you do not need a token" sentences the copy rules allow everywhere.
 */
import { findBannedClaims } from "../tools/copy-rules";
import { PUBLIC_REPOSITORY_URL } from "../llms-txt";
import { inlineHrefs, plainInline } from "../inline-copy";
import {
  ROADMAP_NEGATIONS,
  ROADMAP_REPOSITORY_URL,
  resolveRoadmap,
  roadmapContent,
  roadmapStrings,
} from "../roadmap-content";

// The project's own token words (docs/litepaper/restrict.py) plus the wallet, payment, launch and
// migration words the roadmap uses.
const TOKEN_WORDS =
  /\$HIVRA|\$HermesOS|tokenomics|\btokens?\b|\bBankr\b|wallets?|x402|on-chain|cryptocurrenc|launchpad|litepaper|snapshot|airdrop|Sablier|migration/i;

// The one sentence that may name the Orchestrator, pinned whole so the exemption below covers no other use.
const ORCHESTRATOR_SENTENCE =
  "We also intend to explore an Orchestrator, a single place to talk to all your agents and hand work between them, alongside additional computer images including macOS where technically and legally feasible, and custom images. These are planned additions, not presently supported configurations.";

const hidden = () => resolveRoadmap(false);
const shown = () => resolveRoadmap(true);

/** Plain reading text of every string, with the allowed negations taken out. */
function textWithoutNegations(roadmap = hidden()): string {
  let text = roadmapStrings(roadmap).map(plainInline).join("\n");
  for (const negation of ROADMAP_NEGATIONS) text = text.split(negation).join("");
  return text;
}

describe("resolveRoadmap(false): token surfaces hidden", () => {
  it("has no token word in any sentence, heading or link, apart from the three negations", () => {
    const leaks = textWithoutNegations()
      .split("\n")
      .filter((line) => TOKEN_WORDS.test(line));
    expect(leaks).toEqual([]);
    const hrefs = roadmapStrings(hidden()).flatMap(inlineHrefs).concat(
      hidden().masthead.actions.map((action) => action.href),
      [hidden().closing, hidden().progress, hidden().history].flatMap((section) => section.actions.map((action) => action.href)),
    );
    for (const href of hrefs) expect(href).not.toMatch(/token|litepaper|bankr|snapshot|airdrop/i);
  });

  it("is a real test: the full roadmap has token words in several places", () => {
    const leaks = roadmapStrings(shown()).map(plainInline).filter((line) => TOKEN_WORDS.test(line));
    expect(leaks.length).toBeGreaterThanOrEqual(6);
  });

  it("keeps the three short negations, worded with 'a token' and never a ticker", () => {
    const text = roadmapStrings(hidden()).map(plainInline).join("\n");
    for (const negation of ROADMAP_NEGATIONS) {
      expect(text).toContain(negation);
      expect(negation).not.toMatch(/\$/);
    }
    expect(ROADMAP_NEGATIONS).toHaveLength(3);
  });

  it("leaves out the litepaper link, the migration, the snapshot, the launchpad and the token-access half sentence", () => {
    const roadmap = hidden();
    expect(roadmap.masthead.actions.map((action) => action.label)).toEqual(["Get started", "Explore the ecosystem"]);
    const topics = roadmap.stages.flatMap((stage) => stage.blocks.flatMap((block) => (block.kind === "topic" ? [block.heading] : [])));
    expect(topics).not.toContain("A possible launchpad and builder programme");
    const pay = roadmap.stages[0].blocks.find((block) => block.kind === "topic" && block.id === "a-straightforward-way-to-pay");
    expect(pay && pay.kind === "topic" ? pay.paragraphs : []).toEqual([
      "Hivra Cloud has ordinary subscription pricing. Neither using a card nor trying the self-host preview requires you to participate in a token.",
    ]);
    expect(roadmap.history.paragraphs).toEqual([
      "The first roadmap, written in April 2026 when the project was moving out of HermesOS, described a wider agent operating system, operator packs, a Hive Mind intelligence layer and an agent marketplace.",
      "Some of those ideas evolved into the current architecture. Others remain research questions.",
      "We are keeping that earlier document as part of the project's history rather than pretending the plan never changed.",
    ]);
    expect(roadmap.progress.paragraphs[1]).toBe(
      "For shipped changes, visit the [changelog](/changelog). For the live state of Hivra's public pages, visit [status](/status).",
    );
  });

  it("keeps everything that is not about the tokens: four stages, their topics, the notes and the close", () => {
    const roadmap = hidden();
    expect(roadmap.stages.map((stage) => stage.id)).toEqual(["today", "next", "then", "research"]);
    expect(roadmap.stages.map((stage) => stage.heading)).toEqual([
      "Available today",
      "Next: make the computer easier to trust and easier to use",
      "Then: the supporting pieces",
      "Research: where this could lead",
    ]);
    const topics = (id: string) =>
      roadmap.stages.find((stage) => stage.id === id)?.blocks.flatMap((block) => (block.kind === "topic" ? [block.heading] : [])) ?? [];
    expect(topics("today")).toEqual(["Agent Computers", "Choose where it runs", "The tools around the computer", "A straightforward way to pay"]);
    expect(topics("next")).toEqual([
      "Gate: clearer authority for agents",
      "Exchange: find and share what works",
      "Arena: test before you trust",
      "Signal: security warnings you can act on",
    ]);
    const then = roadmap.stages.find((stage) => stage.id === "then");
    const terms = then?.blocks.find((block) => block.kind === "terms");
    expect(terms && terms.kind === "terms" ? terms.items.map((item) => plainInline(item).split(":")[0]) : []).toEqual([
      "Vault",
      "Passport",
      "Seal",
      "Rescue",
      "Challenges",
      "Experience",
    ]);
    expect(roadmap.closing.actions.map((action) => action.label)).toEqual(["Explore Hivra", "Start a computer"]);
    expect(roadmap.closing.paragraphs[0]).toBe(`Hivra is [open source]({repository}). ${ROADMAP_NEGATIONS[2]}`);
  });

  it("does not change the full roadmap", () => {
    const before = JSON.stringify(roadmapContent);
    hidden();
    shown();
    expect(JSON.stringify(roadmapContent)).toBe(before);
  });
});

describe("resolveRoadmap(true): token surfaces visible", () => {
  it("shows every token sentence, the litepaper link and the launchpad topic", () => {
    const roadmap = shown();
    expect(roadmap.masthead.actions.map((action) => action.label)).toEqual(["Get started", "Explore the ecosystem", "Read the litepaper"]);
    const text = roadmapStrings(roadmap).join("\n");
    expect(text).toContain("A possible launchpad and builder programme");
    expect(text).toContain("It is **not a live product or committed launch**.");
    expect(text).toContain("Hivra Cloud has ordinary subscription pricing as well as the token-related access arrangements described on the billing and token pages.");
    expect(text).toContain("During the migration from $HermesOS to $HIVRA, eligibility and claim instructions belong on the dedicated token pages.");
    expect(text).toContain("qualifying holders claim through Sablier, pay the applicable claim fee and are not required to burn legacy tokens.");
    expect(text).toContain("In particular, the April roadmap's Bankr-linked token descriptions are **historical**, not instructions for the present migration.");
    expect(text).toContain("read the [litepaper]({litepaper})");
  });

  it("labels the launchpad as research, not a live product", () => {
    const text = roadmapStrings(shown()).join("\n");
    expect(text).toMatch(/not a live product or committed launch/);
    expect(text).toMatch(/We plan to revisit it after the current launch/);
  });
});

describe("roadmap copy rules, in either view", () => {
  const views = [
    ["hidden", hidden],
    ["visible", shown],
  ] as const;

  it.each(views)("%s: has no em or en dash, no plan name, no price, no trial or hosted free plan claim", (_name, view) => {
    const text = roadmapStrings(view()).map(plainInline).join("\n");
    expect(text).not.toMatch(/[\u2013\u2014]/);
    expect(text).not.toMatch(/\bStarter\b|\bPro\b|\bPower\b|\$\d/);
    // copy-rules bans /orchestrat/ because built-in multi-agent coordination is not shipped. The roadmap names the
    // Orchestrator once, as something we "intend to explore" and a planned addition that is "not presently supported"
    // (the ecosystem page says the same), so only that word in that sentence is set aside; everything else is scanned.
    expect(text.split(ORCHESTRATOR_SENTENCE)).toHaveLength(2);
    const scanned = text.replace(ORCHESTRATOR_SENTENCE, ORCHESTRATOR_SENTENCE.replace("an Orchestrator", "a planned addition"));
    expect(findBannedClaims(scanned)).toEqual([]);
  });

  it.each(views)("%s: makes no speed claim and promises no date", (_name, view) => {
    const text = roadmapStrings(view()).map(plainInline).join("\n");
    expect(text).not.toMatch(/one[- ]click|\binstant(?:ly)?\b|\bin \d+ (?:minutes|seconds)\b|\bwithin (?:minutes|seconds)\b|live in minutes/i);
    // Next, Then and Research are an order of work, never a calendar: the only dates are the history
    // of the April plan, and the snapshot sentence (token copy, flagged until the snapshot is taken).
    const dates = [...text.matchAll(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+20\d\d\b|\bQ[1-4]\b|\b20[2-3]\d\b/g)].map(
      (match) => match[0],
    );
    const allowed = new Set(["April 2026", "2026", "October 2026"]);
    expect(dates.filter((date) => !allowed.has(date))).toEqual([]);
    if (view === hidden) expect(dates).toEqual(["2026", "April 2026"]);
  });

  it.each(views)("%s: links only to pages that exist, and never to the litepaper route or an archive route", (_name, view) => {
    const roadmap = view();
    const hrefs = roadmapStrings(roadmap).flatMap(inlineHrefs);
    const actionHrefs = [roadmap.masthead, roadmap.history, roadmap.progress, roadmap.closing].flatMap((section) => section.actions.map((action) => action.href));
    const known = new Set(["/agents", "/changelog", "/status", "/ecosystem", "/about", "{start}", "{litepaper}", "{repository}"]);
    for (const href of [...hrefs, ...actionHrefs]) expect(known.has(href)).toBe(true);
    for (const href of [...hrefs, ...actionHrefs]) expect(href).not.toMatch(/^\/litepaper|archive|april-2026/);
  });
});

describe("the repository link", () => {
  it("is the public repository", () => {
    expect(ROADMAP_REPOSITORY_URL).toBe(PUBLIC_REPOSITORY_URL);
    expect(ROADMAP_REPOSITORY_URL).toBe("https://github.com/ashneil12/hivra");
  });

  it("says open source, not the licence", () => {
    const text = roadmapStrings(shown()).join("\n");
    expect(text).toMatch(/open source/);
    expect(text).not.toMatch(/\bApache\b|\bMIT\b|\bGPL\b|public domain|licen[cs]ed under/i);
  });
});
