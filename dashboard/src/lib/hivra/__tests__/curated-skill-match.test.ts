import {
  normalizeSavedName,
  isCuratedSkillInstalled,
  type InstalledBoxSkill,
} from "../curated-skill-match";

describe("normalizeSavedName", () => {
  it("lowercases and strips all non-alphanumerics", () => {
    expect(normalizeSavedName("Claude Code")).toBe("claudecode");
    expect(normalizeSavedName("claude-code")).toBe("claudecode");
    expect(normalizeSavedName("claude_code")).toBe("claudecode");
    expect(normalizeSavedName("  Quotient API  ")).toBe("quotientapi");
  });

  it("returns empty string for null/undefined/blank", () => {
    expect(normalizeSavedName(null)).toBe("");
    expect(normalizeSavedName(undefined)).toBe("");
    expect(normalizeSavedName("   ")).toBe("");
    expect(normalizeSavedName("!!!")).toBe("");
  });
});

describe("isCuratedSkillInstalled", () => {
  const box = (names: string[]): InstalledBoxSkill[] => names.map((name) => ({ name }));

  it("matches on the display name regardless of spacing/case/hyphens", () => {
    expect(isCuratedSkillInstalled({ name: "1Password" }, box(["1password"]))).toBe(true);
    expect(isCuratedSkillInstalled({ name: "Bankr Twitter Agent" }, box(["bankr-twitter-agent"]))).toBe(true);
    expect(isCuratedSkillInstalled({ name: "Claude Code" }, box(["ClaudeCode"]))).toBe(true);
  });

  it("returns false when no installed skill matches", () => {
    expect(isCuratedSkillInstalled({ name: "1Password" }, box(["github", "slack"]))).toBe(false);
    expect(isCuratedSkillInstalled({ name: "1Password" }, box([]))).toBe(false);
  });

  it("matches via the installedAs frontmatter override (dir != frontmatter name)", () => {
    // Catalog displays "Quotient" but the SKILL.md ships `name: quotient-api`.
    const entry = { name: "Quotient", installedAs: "quotient-api" };
    expect(isCuratedSkillInstalled(entry, box(["quotient-api"]))).toBe(true);
    // Still also matches if the box happens to report the display name.
    expect(isCuratedSkillInstalled(entry, box(["Quotient"]))).toBe(true);
    // No match when neither the name nor the alias is present.
    expect(isCuratedSkillInstalled(entry, box(["something-else"]))).toBe(false);
  });

  it("never matches on empty/blank tokens (no false positives)", () => {
    // An entry whose name normalizes to "" must not match a box skill that also
    // normalizes to "".
    expect(isCuratedSkillInstalled({ name: "!!!" }, box(["@@@"]))).toBe(false);
    expect(isCuratedSkillInstalled({ name: "" }, box([""]))).toBe(false);
  });

  it("uses installedAs in addition to (not instead of) name", () => {
    const entry = { name: "GitHub", installedAs: "gh-cli" };
    expect(isCuratedSkillInstalled(entry, box(["github"]))).toBe(true);
    expect(isCuratedSkillInstalled(entry, box(["gh cli"]))).toBe(true);
  });
});
