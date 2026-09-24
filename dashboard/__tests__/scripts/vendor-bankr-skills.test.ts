import { patchSkillContent, rawSkillContentUrl, vendoredSkillContent } from "../../scripts/vendor-bankr-skills";
import { SkillContentError, skillFrontmatterProblem } from "../../src/lib/hivra/skill-file";

describe("vendor-bankr-skills", () => {
  it("builds raw URLs without escaping nested Bankr skill paths", () => {
    expect(rawSkillContentUrl("BankrBot/skills/skills/bankr-twitter-agent", "SKILL.md")).toBe(
      "https://raw.githubusercontent.com/BankrBot/skills/main/skills/bankr-twitter-agent/SKILL.md"
    );
  });

  it("supports repositories that use lowercase skill.md", () => {
    expect(rawSkillContentUrl("BankrBot/skills/BOTCOIN", "skill.md")).toBe(
      "https://raw.githubusercontent.com/BankrBot/skills/main/BOTCOIN/skill.md"
    );
  });

  it("escapes Unicode line separators in generated TypeScript string literals", () => {
    const source = [
      "export const CURATED_SKILLS = [",
      "  {",
      '    identifier: "BankrBot/skills/bankr",',
      '    repoUrl: "https://github.com/BankrBot/skills/tree/main/bankr",',
      "  },",
      "];",
      "",
    ].join("\n");

    const patched = patchSkillContent(source, "BankrBot/skills/bankr", "before\u2028after");

    expect(patched).toContain("before\\u2028after");
    expect(patched).not.toContain("before\u2028after");
  });

  it("treats dollar signs in skill content as literal text", () => {
    const source = [
      "export const CURATED_SKILLS = [",
      "  {",
      '    identifier: "BankrBot/skills/bankr",',
      '    content: "old",',
      '    repoUrl: "https://github.com/BankrBot/skills/tree/main/bankr",',
      "  },",
      "];",
      "",
    ].join("\n");

    const patched = patchSkillContent(source, "BankrBot/skills/bankr", "For prompts containing `$`.");

    expect(patched).toContain("For prompts containing `$`.");
    expect(patched.match(/export const CURATED_SKILLS/g)).toHaveLength(1);
  });
});

describe("vendoredSkillContent", () => {
  const trails = {
    identifier: "BankrBot/skills/trails",
    description: "Cross-chain swap, bridge, and DeFi orchestration via Sequence.",
  };
  const twitterV2 = {
    identifier: "BankrBot/skills/skills/bankr-twitter-agent",
    installedAs: "twitter-agent",
    description: "Build and run Twitter/X agents.",
  };

  it("keeps an upstream SKILL.md that Codex can load exactly as it is", () => {
    const upstream = "---\nname: trails\ndescription: Swaps.\n---\n\n# Trails\n";
    expect(vendoredSkillContent(trails, upstream)).toEqual({ content: upstream, repaired: null });
  });

  it("closes the frontmatter upstream trails opens and never closes", () => {
    const upstream = "---\n\nname: trails\ndescription: Trails — cross-chain swaps. Use when bridging.\n\n# Trails\n\nBody.\n";
    const { content, repaired } = vendoredSkillContent(trails, upstream);
    expect(repaired).toBe("the --- block at the top is never closed");
    expect(content).toBe("---\nname: trails\ndescription: Trails — cross-chain swaps. Use when bridging.\n---\n\n# Trails\n\nBody.\n");
    expect(skillFrontmatterProblem(content)).toBeNull();
  });

  it("adds frontmatter from the catalog when upstream has none", () => {
    const upstream = "# Skill: twitter-agent\n> Build and run one or more Twitter/X agents.\n\n# Twitter Agent Skill\n";
    const { content, repaired } = vendoredSkillContent(twitterV2, upstream);
    expect(repaired).toBe("it doesn't start with a --- line");
    expect(content).toBe(`---\nname: twitter-agent\ndescription: Build and run Twitter/X agents.\n---\n\n${upstream}`);
    expect(skillFrontmatterProblem(content)).toBeNull();
  });

  it("drops a blank first line above the frontmatter", () => {
    const loadable = "---\nname: trails\ndescription: Swaps.\n---\n# Trails\n";
    expect(vendoredSkillContent(trails, `\n${loadable}`)).toEqual({
      content: loadable,
      repaired: "it doesn't start with a --- line",
    });
  });

  it("refuses upstream content no repair can fix, so the catalog keeps what it has", () => {
    expect(() => vendoredSkillContent(trails, "---\nname: [trails\ndescription: Swaps.\n---\n")).toThrow(SkillContentError);
    expect(() => vendoredSkillContent(trails, "---\ndescription: Swaps.\n---\n# Trails\n")).toThrow(/it has no name/);
    expect(() => vendoredSkillContent({ ...trails, description: "" }, "# Trails\n")).toThrow(SkillContentError);
  });
});
