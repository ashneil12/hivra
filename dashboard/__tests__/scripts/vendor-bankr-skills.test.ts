import { patchSkillContent, rawSkillContentUrl } from "../../scripts/vendor-bankr-skills";

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
