import { CURATED_SKILLS } from "../curated-skills";

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
  "skills/bankr-twitter-agent",
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
