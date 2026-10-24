import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { parseChangelog, resolveChangelogEntries, TOKEN_SURFACE_SECTIONS } from "../changelog";

// The release notes in hermes_changelog.md are a shipping record. The copy overhaul changed
// the page's introduction and three entry titles; the dated notes keep their wording and
// order, with only the clean-up the public copy rules ask for: no dash, British spelling, no
// plan names, no hosted free-plan claim, no emoji on the headings. This pins each shipped
// entry's body by hash, so a later edit to history fails here and has to be deliberate.
// New entries added above these are not affected.
const SOURCE = readFileSync(path.join(__dirname, "..", "..", "..", "hermes_changelog.md"), "utf8");

const SHIPPED = [
  { date: "2026-06-21", title: "Rename agents and reconnect with confidence", sha256: "ecaa53504e51b1a1a49f39ee1f29af60d71cbd077f0f75cf20d949109bc32b5f" },
  { date: "2026-06-19", title: "Import browser cookies for the accounts your agent uses", sha256: "52185baa9284d6bc403d84898dbe48b5027f59cb5fd4dea93cd14c897599cf95" },
  { date: "2026-06-18", title: "Making everyday use more reliable", sha256: "27d9b8ec98d692f3bff3fbb4914172a79b20fd6686f72451a51389f867501d30" },
  { date: "2026-06-14", title: "Agent Memory, Templates, LLM Picker, and Claude on Venice", sha256: "97d5351ea6bc0c4917475df63cf90b797dcf6a03261bf9e6d6589c5ed749ea5c" },
  { date: "2026-06-13", title: "Agent Activity, Telegram Connect, and Platform Fixes", sha256: "fe97e0451b82b12ac66b982b86e0337d875229dcbf95737697320ea0a79e6f76" },
  { date: "2026-06-12", title: "Aeon with Managed Credits", sha256: "1a3428b374e81158a272695cc573dddaae41f1e0bf578891e8d6a6e31a61fd91" },
] as const;

describe("hermes_changelog.md", () => {
  const parsed = parseChangelog(SOURCE);

  it("keeps the last-updated marker and every shipped entry's date, in order", () => {
    expect(parsed.lastUpdated).toBe("2026-06-21");
    const dates = parsed.entries.map((entry) => entry.date);
    expect(dates.slice(-SHIPPED.length)).toEqual(SHIPPED.map((entry) => entry.date));
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it("uses the approved section titles", () => {
    const byDate = new Map(parsed.entries.map((entry) => [entry.date, entry.title]));
    for (const shipped of SHIPPED) expect(byDate.get(shipped.date)).toBe(shipped.title);
  });

  it("leaves every shipped entry's notes as pinned", () => {
    const byDate = new Map(parsed.entries.map((entry) => [entry.date, entry.body]));
    for (const shipped of SHIPPED) {
      const body = byDate.get(shipped.date) ?? "";
      expect(createHash("sha256").update(body).digest("hex")).toBe(shipped.sha256);
    }
  });

  it("holds no em or en dash anywhere in the file", () => {
    expect(SOURCE).not.toMatch(/[–—]/);
  });

  it("uses British spelling in the notes", () => {
    expect(SOURCE).not.toMatch(/\b(catalog|center|centered|color|behavior|favorite|organiz\w*|recogniz\w*|optimiz\w*|customiz\w*)\b/i);
  });

  it("names no plan, tier or hosted free plan", () => {
    expect(SOURCE).not.toMatch(/\b(starter|pro|power|operator-tier|free and paid|free and operator)\b/i);
  });

  it("puts no emoji on the section headings", () => {
    for (const heading of SOURCE.match(/^###? .*$/gm) ?? []) expect(heading).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe("the sections that name Bankr (token surfaces)", () => {
  const { entries } = parseChangelog(SOURCE);

  it("are all still in the source file, so a rename cannot leave Bankr wording on show", () => {
    for (const { heading } of TOKEN_SURFACE_SECTIONS) {
      expect(entries.some((entry) => entry.body.includes(`### ${heading}\n`))).toBe(true);
    }
  });

  it("show in full only to a viewer who may see token copy", () => {
    expect(resolveChangelogEntries(entries, true)).toEqual(entries);
    const shown = resolveChangelogEntries(entries, true).map((entry) => entry.body).join("\n");
    expect(shown).toContain("Bankr wallet");
  });

  it("are replaced by their plain wording for everyone else, and nothing else changes", () => {
    const hidden = resolveChangelogEntries(entries, false);
    expect(hidden.map((entry) => entry.body).join("\n")).not.toMatch(/bankr/i);
    expect(hidden.map((entry) => entry.title)).toEqual(entries.map((entry) => entry.title));

    const thirteenth = hidden.find((entry) => entry.date === "2026-06-13");
    expect(thirteenth?.body).toContain("### Skills for CLI agents\nCLI agents (Codex, Claude Code) now have the ability to install skills from the catalogue.\n\n### Paid agents resume automatically");
    for (const entry of hidden) {
      if (entry.date === "2026-06-13") continue;
      expect(entry).toBe(entries.find((original) => original.date === entry.date));
    }
  });

  it("leave the rest of the 13 June notes exactly as written", () => {
    const original = entries.find((entry) => entry.date === "2026-06-13")?.body ?? "";
    const hidden = resolveChangelogEntries(entries, false).find((entry) => entry.date === "2026-06-13")?.body ?? "";
    const strip = (body: string) => body.replace(/### (Bankr wallet and skills|Skills) for CLI agents\n.*\n\n/, "");
    expect(strip(hidden)).toBe(strip(original));
  });
});

describe("the feed", () => {
  it("carries no Bankr wording: it is rendered once for every viewer", async () => {
    const { GET } = await import("../../app/changelog/rss.xml/route");
    const xml = await GET().text();
    expect(xml).not.toMatch(/bankr/i);
    expect(xml).toContain("Skills for CLI agents");
    expect(xml).not.toMatch(/[–—]/);
  });
});
