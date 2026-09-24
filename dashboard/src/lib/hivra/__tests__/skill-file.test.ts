/** @jest-environment node */
// The one SKILL.md check every file we write must pass (the strictest Codex
// reader) and the repair for the broken shapes seen upstream.
import {
  SKILL_DESCRIPTION_MAX_CHARS,
  SKILL_NAME_MAX_CHARS,
  SkillContentError,
  bankrSkillSlug,
  loadableSkillContent,
  normalizeSkillContent,
  skillFrontmatterProblem,
} from "../skill-file";

const skill = (frontmatter: string, body = "# Body\n") => `---\n${frontmatter}\n---\n\n${body}`;
const META = { name: "twitter-agent", description: "Build and run a Twitter/X agent." };

describe("skillFrontmatterProblem", () => {
  it("accepts a well-formed SKILL.md", () => {
    expect(skillFrontmatterProblem(skill("name: trails\ndescription: Cross-chain swaps."))).toBeNull();
  });

  it("accepts what Codex accepts: CRLF lines, spaces around the fences, folded descriptions, nested metadata", () => {
    expect(skillFrontmatterProblem("---\r\nname: a\r\ndescription: b\r\n---\r\nbody")).toBeNull();
    expect(skillFrontmatterProblem(" --- \nname: a\ndescription: b\n---  \nbody")).toBeNull();
    expect(skillFrontmatterProblem(skill("name: a\ndescription: >\n  Line one\n  line two"))).toBeNull();
    expect(skillFrontmatterProblem(skill('name: a\ndescription: b\nmetadata:\n  {"clawdbot": {"emoji": "x"}}'))).toBeNull();
  });

  it("refuses a file with no frontmatter (the nested twitter-agent shape)", () => {
    expect(skillFrontmatterProblem("# Skill: twitter-agent\n> Build and run agents.\n")).toBe(
      "it doesn't start with a --- line",
    );
  });

  it("refuses an opening --- that is never closed (the trails shape)", () => {
    expect(skillFrontmatterProblem("---\n\nname: trails\ndescription: Swaps.\n\n# Trails\n")).toBe(
      "the --- block at the top is never closed",
    );
  });

  it("refuses a blank line or byte-order mark before the opening ---", () => {
    expect(skillFrontmatterProblem(`\n${skill("name: a\ndescription: b")}`)).toBe("it doesn't start with a --- line");
    expect(skillFrontmatterProblem(`\uFEFF${skill("name: a\ndescription: b")}`)).toBe("it doesn't start with a --- line");
  });

  it("refuses an empty block, invalid YAML, and a block that isn't key: value fields", () => {
    expect(skillFrontmatterProblem("---\n---\nbody")).toBe("the --- block at the top is empty");
    expect(skillFrontmatterProblem(skill("name: [unclosed\ndescription: b"))).toMatch(/isn't valid YAML/);
    // Older Codex releases refuse `key: text: more` (newer ones quietly quote it).
    expect(skillFrontmatterProblem(skill("name: a\ndescription: Build for AWS: ECS"))).toMatch(/isn't valid YAML/);
    expect(skillFrontmatterProblem(skill("- name\n- description"))).toBe("the --- block at the top isn't key: value fields");
    expect(skillFrontmatterProblem(skill("# only a comment"))).toBe("the --- block at the top isn't key: value fields");
  });

  it("needs a name of at most 64 characters", () => {
    expect(skillFrontmatterProblem(skill("description: b"))).toBe("it has no name");
    expect(skillFrontmatterProblem(skill('name: "  "\ndescription: b'))).toBe("its name is empty");
    expect(skillFrontmatterProblem(skill("name: [a, b]\ndescription: b"))).toBe("its name isn't text");
    expect(skillFrontmatterProblem(skill(`name: ${"a".repeat(SKILL_NAME_MAX_CHARS)}\ndescription: b`))).toBeNull();
    expect(skillFrontmatterProblem(skill(`name: ${"a".repeat(SKILL_NAME_MAX_CHARS + 1)}\ndescription: b`))).toBe(
      "its name is longer than 64 characters",
    );
    // Characters, not UTF-16 units, as Codex counts them.
    expect(skillFrontmatterProblem(skill(`name: ${"🐦".repeat(SKILL_NAME_MAX_CHARS)}\ndescription: b`))).toBeNull();
  });

  it("needs a description of at most 1024 characters after collapsing whitespace", () => {
    expect(skillFrontmatterProblem(skill("name: a"))).toBe("it has no description");
    expect(skillFrontmatterProblem(skill("name: a\ndescription:"))).toBe("it has no description");
    const words = (count: number) => Array.from({ length: count }, () => "a").join("   ");
    // 512 words collapse to 1023 characters, though they span more in the file.
    expect(skillFrontmatterProblem(skill(`name: a\ndescription: ${words(512)}`))).toBeNull();
    expect(skillFrontmatterProblem(skill(`name: a\ndescription: ${"d".repeat(SKILL_DESCRIPTION_MAX_CHARS + 1)}`))).toBe(
      "its description is longer than 1024 characters",
    );
  });

  it("needs metadata, when present, to be fields with a short-description of at most 1024 characters", () => {
    expect(skillFrontmatterProblem(skill("name: a\ndescription: b\nmetadata: text"))).toBe(
      "its metadata isn't key: value fields",
    );
    expect(skillFrontmatterProblem(skill("name: a\ndescription: b\nmetadata:"))).toBe("its metadata isn't key: value fields");
    expect(
      skillFrontmatterProblem(skill(`name: a\ndescription: b\nmetadata:\n  short-description: ${"s".repeat(1025)}`)),
    ).toBe("its metadata short-description is longer than 1024 characters");
    expect(skillFrontmatterProblem(skill("name: a\ndescription: b\nmetadata:\n  short-description: Short."))).toBeNull();
  });
});

describe("normalizeSkillContent", () => {
  it("returns loadable content unchanged", () => {
    const content = skill("name: trails\ndescription: Swaps.");
    expect(normalizeSkillContent(content, META)).toBe(content);
  });

  it("adds frontmatter from the catalog to a file that has none, keeping the body", () => {
    const body = "# Skill: twitter-agent\n> Build and run one or more agents.\n\n# Twitter Agent Skill\n";
    const repaired = normalizeSkillContent(body, META);
    expect(repaired).toBe(`---\nname: twitter-agent\ndescription: Build and run a Twitter/X agent.\n---\n\n${body}`);
    expect(skillFrontmatterProblem(repaired)).toBeNull();
  });

  it("quotes catalog text that YAML would misread", () => {
    const repaired = normalizeSkillContent("# Body\n", { name: "a", description: "Swap: bridge, and #earn" });
    expect(skillFrontmatterProblem(repaired)).toBeNull();
  });

  it("closes an opening --- that is never closed, after the fields, and drops the blank line under it", () => {
    const upstream = "---\n\nname: trails\ndescription: Trails — cross-chain swaps.\n\n# Trails\n\nBody text.\n";
    expect(normalizeSkillContent(upstream, META)).toBe(
      "---\nname: trails\ndescription: Trails — cross-chain swaps.\n---\n\n# Trails\n\nBody text.\n",
    );
  });

  it("closes the block before a heading when no blank line follows the fields", () => {
    expect(normalizeSkillContent("---\nname: a\ndescription: b\n# A\nBody\n", META)).toBe(
      "---\nname: a\ndescription: b\n---\n# A\nBody\n",
    );
  });

  it("drops blank lines and a byte-order mark above the opening ---", () => {
    const content = skill("name: a\ndescription: b");
    expect(normalizeSkillContent(`\n\n${content}`, META)).toBe(content);
    expect(normalizeSkillContent(`\uFEFF${content}`, META)).toBe(content);
    // Both at once: blank first line and an unclosed fence.
    expect(normalizeSkillContent("\n---\nname: a\ndescription: b\n\n# A\n", META)).toBe("---\nname: a\ndescription: b\n---\n\n# A\n");
  });

  it("refuses what no repair fixes, naming the original problem", () => {
    const refuse = (content: string, meta = META) => {
      try {
        normalizeSkillContent(content, meta);
      } catch (err) {
        expect(err).toBeInstanceOf(SkillContentError);
        return (err as SkillContentError).problem;
      }
      throw new Error("expected a refusal");
    };
    expect(refuse(skill("name: [unclosed\ndescription: b"))).toMatch(/isn't valid YAML/);
    expect(refuse(skill("description: b"))).toBe("it has no name");
    expect(refuse("")).toBe("it doesn't start with a --- line");
    expect(refuse("   \n\n")).toBe("it doesn't start with a --- line");
    // An opening --- over prose, not fields: likely a rule line, not frontmatter.
    expect(refuse("---\nJust some prose here.\n\nMore prose.\n")).toBe("the --- block at the top is never closed");
    // Catalog metadata that can't make a loadable block either.
    expect(refuse("# Body\n", { name: "a".repeat(65), description: "b" })).toBe("it doesn't start with a --- line");
    expect(refuse("# Body\n", { name: "a", description: "" })).toBe("it doesn't start with a --- line");
  });
});

describe("loadableSkillContent", () => {
  const entry = {
    identifier: "BankrBot/skills/skills/bankr-twitter-agent",
    description: "Nested Twitter/X agent framework skill.",
    content: "# Skill: twitter-agent\n",
  };

  it("names a repaired skill after its folder, as Codex itself would", () => {
    expect(loadableSkillContent(entry)).toBe(
      `---\nname: ${bankrSkillSlug(entry.identifier)}\ndescription: Nested Twitter/X agent framework skill.\n---\n\n# Skill: twitter-agent\n`,
    );
  });

  it("prefers the installedAs alias so the installed-skill match still works", () => {
    expect(loadableSkillContent({ ...entry, installedAs: "twitter-agent-v2" })).toMatch(/^---\nname: twitter-agent-v2\n/);
  });

  it("refuses an entry with no content", () => {
    expect(() => loadableSkillContent({ ...entry, content: undefined })).toThrow(SkillContentError);
  });
});
