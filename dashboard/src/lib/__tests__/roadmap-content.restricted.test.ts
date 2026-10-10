/**
 * The roadmap for a viewer the token geo-policy blocks. The April 2026 plan has
 * a token section and token lines all through its phases, so the restricted copy
 * is checked word by word, the way docs/litepaper/test_restricted.py checks the
 * static documents: any token word left anywhere fails the build.
 */
import { restrictedRoadmapContent, roadmapContent } from "../roadmap-content";

// The project's own token words (docs/litepaper/restrict.py) plus the wallet and payment words the roadmap uses.
const TOKEN_WORDS = /\$HIVRA|\$HermesOS|tokenomics|\btokens?\b|\bBankr\b|wallets?|x402|on-chain|cryptocurrenc/i;

function strings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => strings(entry, into));
  else if (value && typeof value === "object") Object.values(value).forEach((entry) => strings(entry, into));
  return into;
}

describe("restrictedRoadmapContent", () => {
  it("has no token word in any string, heading, link or address", () => {
    const leaks = strings(restrictedRoadmapContent()).filter((text) => TOKEN_WORDS.test(text));
    expect(leaks).toEqual([]);
    // Every key but the `token: null` the page reads to leave its token section out.
    const { token, ...rest } = restrictedRoadmapContent();
    expect(token).toBeNull();
    expect(JSON.stringify(rest)).not.toMatch(TOKEN_WORDS);
  });

  it("is a real test: the full roadmap has token words, in its token section and all through its phases", () => {
    const phaseLeaks = strings(roadmapContent.roadmap).filter((text) => TOKEN_WORDS.test(text));
    expect(phaseLeaks.length).toBeGreaterThan(10);
    expect(strings(roadmapContent.token).filter((text) => TOKEN_WORDS.test(text)).length).toBeGreaterThan(10);
    expect(strings(roadmapContent.navLinks).join(" ")).toMatch(/token/i);
  });

  it("leaves out the token section, the token links and the token cards and features", () => {
    const restricted = restrictedRoadmapContent();
    expect(restricted.token).toBeNull();
    expect(restricted.navLinks).toEqual([]);
    expect(restricted.audience.cards.map((card) => card.title)).toEqual(["Standard access"]);
    expect(restricted.liveToday.features.map((feature) => feature.name)).not.toContain("Token access");
    expect(restricted.visionDirection.rows.map((row) => row.title)).toEqual([
      "From deployment to operators",
      "From isolated agents to a connected network",
    ]);
    expect(restricted.closing.metadata.map((item) => item.label)).toEqual(["Platform", "Blog", "Twitter / X"]);
  });

  it("keeps the whole plan that is not about the token: four phases, the operator packs, what is live", () => {
    const restricted = restrictedRoadmapContent();
    expect(restricted.roadmap.phases.map((phase) => phase.id)).toEqual(["phase-1", "phase-2", "phase-3", "phase-4"]);
    const headings = restricted.roadmap.phases.flatMap((phase) => phase.sections.map((section) => section.heading));
    for (const kept of ["What Are Operator Packs", "Flagship Operator Packs", "Compute Access", "Operator Marketplace", "Agent Endpoints", "Hivra as Infrastructure Layer"]) {
      expect(headings).toContain(kept);
    }
    for (const gone of ["Bankr Integration", "Agent Wallets", "Expanded Token Utility", "Card and Token Access"]) {
      expect(headings).not.toContain(gone);
    }
    // No section is left empty.
    for (const phase of restricted.roadmap.phases) {
      for (const section of phase.sections) {
        expect(Boolean(section.intro || section.callout || section.paragraphs?.length || section.bullets?.length)).toBe(true);
      }
    }
    expect(restricted.liveToday.features).toHaveLength(roadmapContent.liveToday.features.length - 1);
    expect(restricted.hero).toMatchObject({ title: roadmapContent.hero.title, subtitle: roadmapContent.hero.subtitle });
  });

  it("numbers the sections without a gap where the token section was", () => {
    const restricted = restrictedRoadmapContent();
    const eyebrows = [
      restricted.whatIsHermesOS,
      restricted.audience,
      restricted.liveToday,
      restricted.vision,
      restricted.roadmap,
      restricted.outOfScope,
      restricted.closing,
    ].map((section) => section.eyebrow.slice(0, 2));
    expect(eyebrows).toEqual(["01", "02", "03", "04", "05", "06", "07"]);
  });

  it("follows the copy rules: no em or en dash, and the lead that counts the directions is true", () => {
    const restricted = restrictedRoadmapContent();
    expect(strings(restricted).filter((text) => /[–—]/.test(text))).toEqual([]);
    expect(restricted.vision.directionLead).toBe("The platform is moving in two directions simultaneously:");
    expect(restricted.visionDirection.rows).toHaveLength(2);
    // One way in is left, so there is no "both paths" summary.
    expect(restricted.audience.summary).toBe("");
  });

  it("does not change the full roadmap", () => {
    const before = JSON.stringify(roadmapContent);
    restrictedRoadmapContent();
    restrictedRoadmapContent();
    expect(JSON.stringify(roadmapContent)).toBe(before);
    expect(roadmapContent.token.title).toBe("Fair launch. Community owned.");
  });
});
