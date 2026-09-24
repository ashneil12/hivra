import { CORE_SCHEMA, load } from "js-yaml";

import { skillFrontmatterProblem } from "@/lib/hivra/skill-file";
import { CURATED_SKILLS } from "../curated-skills";

// `skills/bankr-twitter-agent` is deliberately absent: upstream's v2 of the
// twitter-agent skill sits at that nested path with no frontmatter, and the
// `bankr-twitter-agent` entry already seeds a skill named twitter-agent.
const CURRENT_BANKR_SKILL_PATHS = [
  "0xwork",
  "agenticbets",
  "alchemy",
  "bankr",
  "bankr-token-scam-analysis",
  "bankr-twitter-agent",
  "base",
  "botchan",
  "cattown",
  "clanker",
  "endaoment",
  "ens-primary-name",
  "erc-8004",
  "gitlawb",
  "helixa",
  "hydrex",
  "litcoin",
  "moltycash",
  "neynar",
  "nookplot",
  "onchainkit",
  "productclank",
  "qrcoin",
  "quicknode",
  "quotient",
  "signals",
  "siwa",
  "stakr",
  "symbiosis",
  "trails",
  "trustlayer-sybil-scanner",
  "veil",
  "yoink",
  "zapper",
  "zerion",
  "zyfai",
];

const WITH_CONTENT = CURATED_SKILLS.filter((skill) => typeof skill.content === "string" && skill.content.trim());

describe("Bankr curated skills", () => {
  it("vendors content for every BankrBot skill path we seed onto agents", () => {
    const bankrSkills = CURATED_SKILLS.filter((skill) => skill.category === "bankr");
    const byPath = new Map(bankrSkills.map((skill) => [
      skill.identifier.replace(/^BankrBot\/skills\//, ""),
      skill,
    ]));

    expect([...byPath.keys()].sort()).toEqual(CURRENT_BANKR_SKILL_PATHS.sort());
    for (const path of CURRENT_BANKR_SKILL_PATHS) {
      expect(byPath.get(path)?.content?.trim()).toBeTruthy();
    }
  });
});

describe("curated skill content", () => {
  // Codex refuses a SKILL.md it can't read and logs the failure into every chat
  // turn. The catalog itself must hold loadable files, not lean on the repair.
  it("is a SKILL.md that Codex can load, for every curated and Bankr skill", () => {
    const problems = WITH_CONTENT
      .map((skill) => ({ id: skill.id, problem: skillFrontmatterProblem(skill.content as string) }))
      .filter((result) => result.problem !== null);
    expect(problems).toEqual([]);
  });

  it("gives every skill its own frontmatter name, so no two seeded skills collide", () => {
    const owners = new Map<string, string[]>();
    for (const skill of WITH_CONTENT) {
      // The block between the opening and closing --- (loadability is checked above).
      const block = (skill.content as string).split("\n---")[0].replace(/^---\n/, "");
      let fields: { name?: unknown } | undefined;
      try {
        fields = load(block, { schema: CORE_SCHEMA }) as { name?: unknown } | undefined;
      } catch {
        fields = undefined;
      }
      const name = typeof fields?.name === "string" ? fields.name : `(no name: ${skill.id})`;
      owners.set(name, [...(owners.get(name) ?? []), skill.id]);
    }
    expect([...owners].filter(([, ids]) => ids.length > 1)).toEqual([]);
  });
});
