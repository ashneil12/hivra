// Persona-souls lint — guards every authored soul against phantom-resource
// regressions.
//
// WHY THIS EXISTS: Sloane's original soul shipped citing 25 backticked doc
// filenames, a "27 documents" knowledge base, and a master index — none of
// which exist on the box. The box ships NO knowledge base. An agent that
// promises resources it doesn't have is an 11x-style overpromise: it burns
// user trust the moment someone asks it to "check the master index" and it
// can't. This test makes that class of regression impossible to merge for
// ALL six souls (see PERSONA_ENGINE_DECOUPLE_PLAN.md, Phase 2 items 7-8).
//
// There is NO in-repo manifest of files that live on a box (box images are
// built in other repos), so a static allowlist is the mechanism: if a soul
// ever legitimately needs to reference a real on-box file, add it to
// ALLOWED_FILE_REFERENCES with a comment proving it ships on the box.

import { readFileSync } from "fs";
import { join } from "path";

const RAW = readFileSync(join(__dirname, "..", "persona-souls.json"), "utf8");

const EXPECTED_SOUL_IDS = ["bea", "sloane", "pike", "marlo", "sable", "lane"] as const;

// Backticked doc-file references (`foo.md`, `strategy_100m_offers_hormozi.txt`,
// `Add-Ons/Kingdom Mode.md`, ...). Souls must not cite files unless they are
// proven to exist on the box via this allowlist. EMPTY today — the box ships
// no persona doc files at all.
const ALLOWED_FILE_REFERENCES: string[] = [];

const FILE_REFERENCE_PATTERN = /`[\w/\- .]+\.(?:md|txt|json|csv|pdf)`/g;

interface SoulDef {
  name: string;
  role: string;
  soulPrompt: string;
}

describe("persona-souls.json lint (phantom-resource guard)", () => {
  // JSON.parse throwing here IS the test: the file must stay valid JSON —
  // it is edited by decode/re-encode scripts, never by hand.
  const souls = JSON.parse(RAW) as Record<string, SoulDef>;

  it("contains exactly the six expected persona ids", () => {
    // Keep in lockstep with PersonaSoulId in persona-souls-accessor.ts and the
    // soulPromptId values in welcome-persona-catalog.ts.
    expect(Object.keys(souls).sort()).toEqual([...EXPECTED_SOUL_IDS].sort());
  });

  it.each(EXPECTED_SOUL_IDS)("%s has non-empty name, role, and soulPrompt", (id) => {
    const soul = souls[id];
    expect(soul).toBeDefined();
    expect(typeof soul.name).toBe("string");
    expect(soul.name.trim()).not.toBe("");
    expect(typeof soul.role).toBe("string");
    expect(soul.role.trim()).not.toBe("");
    expect(typeof soul.soulPrompt).toBe("string");
  });

  it.each(EXPECTED_SOUL_IDS)("%s soulPrompt is a real prompt (> 2,000 chars)", (id) => {
    // hivra-agent-bootstrap.test.ts relies on souls being long enough to
    // fully replace the generic SOUL.md template. A shriveled soul means a
    // botched decode/re-encode edit — fail loudly.
    expect(souls[id].soulPrompt.length).toBeGreaterThan(2000);
  });

  it.each(EXPECTED_SOUL_IDS)("%s soulPrompt cites no phantom doc files", (id) => {
    // Backticked filename = a promise that the agent can open that file.
    // The box ships none of them. Anything matched here must either be
    // removed or added to ALLOWED_FILE_REFERENCES with proof it exists.
    const matches = souls[id].soulPrompt.match(FILE_REFERENCE_PATTERN) ?? [];
    const phantom = matches.filter((m) => !ALLOWED_FILE_REFERENCES.includes(m));
    expect(phantom).toEqual([]);
  });

  it.each(EXPECTED_SOUL_IDS)("%s soulPrompt claims no knowledge base", (id) => {
    // "Search your knowledge base" / "your KB has..." — there is no KB on the
    // box. The agent would be instructed to retrieve from something that
    // does not exist, then either stall or confabulate results.
    expect(souls[id].soulPrompt).not.toMatch(/knowledge base/i);
  });

  it.each(EXPECTED_SOUL_IDS)("%s soulPrompt claims no document counts", (id) => {
    // "You have access to ... 27 documents" was the original overpromise.
    expect(souls[id].soulPrompt).not.toMatch(/\b\d+ documents\b/i);
  });

  describe("sloane identity (D2: she is Sloane, not a concealed product)", () => {
    it("self-identifies as Sloane", () => {
      // The user hires "Sloane" from the persona picker. The soul must agree
      // with the name on the card — an agent that says "actually I'm
      // something else" on first contact breaks the core persona promise.
      expect(souls.sloane.soulPrompt).toContain("Sloane");
    });

    it('never presents as "Operator OS"', () => {
      // The original soul self-identified as "Operator OS™" and told the
      // agent to conceal that from the user. Both are gone; keep them gone.
      expect(souls.sloane.soulPrompt).not.toContain("Operator OS");
    });
  });
});
