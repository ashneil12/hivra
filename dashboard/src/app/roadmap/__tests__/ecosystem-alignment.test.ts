/** @jest-environment node */
// The roadmap and the ecosystem map once defined Foundry, Signal, Challenges, Vault, Arena and
// Experience differently (the roadmap said Foundry makes agents, Signal watches an agent's logs,
// Vault protects sensitive material), and the roadmap's Interchange line spoke of settlement
// between systems, which the map never says. The map (lib/ecosystem-map.ts) is pinned to the litepaper,
// so the roadmap follows it. Each product below names the phrases both pages must carry: if the
// map changes a definition, or the roadmap drifts from it, this fails until the two agree again.
import { readFileSync } from "node:fs";
import path from "node:path";

import { COMPUTER_ROADMAP } from "@/app/ecosystem/ecosystem-content";
import { ECOSYSTEM_PRODUCTS } from "@/lib/ecosystem-map";
import { plainInline } from "@/lib/inline-copy";
import { resolveRoadmap, roadmapStrings, type ResolvedRoadmap } from "@/lib/roadmap-content";

const roadmap: ResolvedRoadmap = resolveRoadmap(true);

/** What the roadmap says about one product, as plain reading text. */
function roadmapSegment(name: string): string {
  const blocks = roadmap.stages.flatMap((stage) => stage.blocks);
  const topic = blocks.find((block) => block.kind === "topic" && block.heading.startsWith(`${name}:`));
  if (topic && topic.kind === "topic") return plainInline([topic.heading, ...topic.paragraphs].join(" "));
  const term = blocks.flatMap((block) => (block.kind === "terms" ? block.items : [])).find((item) => item.startsWith(`**${name}:**`));
  if (term) return plainInline(term);
  const research = blocks.flatMap((block) => (block.kind === "text" ? [block.text] : [])).find((text) => text.includes(`**${name}**`));
  if (research) return plainInline(research);
  return "";
}

function mapSegment(name: string): string {
  const product = ECOSYSTEM_PRODUCTS.find((item) => item.name === name);
  return plainInline([product?.tagline ?? "", ...(product?.paragraphs ?? [])].join(" "));
}

const SHARED_PHRASES: Record<string, string[]> = {
  Arena: ["controlled place to put agents and tools under pressure", "adversarial tasks", "boundaries hold", "evidence of what happened"],
  Signal: ["actionable notices about unsafe tools, broken integrations and relevant threats"],
  Vault: ["narrowly scoped answers", "without opening the whole account"],
  Challenges: ["authorised security research", "permission to find real weaknesses and a clear route for reporting them"],
  Experience: ["assumptions, limits and provenance", "another agent or person can decide whether"],
  Foundry: ["run useful services while humans remain responsible for what those services do, what they spend and what happens when they fail"],
  Interchange: ["allowances for a defined job, with limits, records and the ability for the owner to revoke them"],
};

describe("the roadmap follows the ecosystem map", () => {
  it.each(Object.entries(SHARED_PHRASES))("%s: says what the map says it is", (name, phrases) => {
    const onRoadmap = roadmapSegment(name).replace(/\s+/g, " ");
    const onMap = mapSegment(name).replace(/\s+/g, " ");
    expect(onRoadmap).not.toBe("");
    for (const phrase of phrases) {
      expect({ name, phrase, onMap: onMap.includes(phrase) }).toEqual({ name, phrase, onMap: true });
      expect({ name, phrase, onRoadmap: onRoadmap.includes(phrase) }).toEqual({ name, phrase, onRoadmap: true });
    }
  });

  it("keeps the retired roadmap definitions out", () => {
    const text = [
      roadmapSegment("Arena"),
      roadmapSegment("Signal"),
      roadmapSegment("Vault"),
      roadmapSegment("Challenges"),
      roadmapSegment("Experience"),
      roadmapSegment("Foundry"),
      roadmapSegment("Interchange"),
    ].join(" ");
    expect(text).not.toMatch(/operator configurations|operational health|understand what an agent is doing|sensitive material/i);
    expect(text).not.toMatch(/structured problems|retain and reuse|make evaluation more practical/i);
    expect(text).not.toMatch(/settlement/i);
  });

  it("words Challenges and Experience as the map does: something that could exist or is explored, not a programme that runs", () => {
    // The map says Challenges "could give researchers permission" and "would need to be defined before anyone could
    // treat them as an active programme", and that Experience "explores how to publish" lessons. The roadmap keeps that hedge.
    expect(mapSegment("Challenges")).toMatch(/could give researchers permission/);
    expect(mapSegment("Experience")).toMatch(/explores how to publish/);
    expect(roadmapSegment("Challenges")).toMatch(/\bcould reward\b/);
    expect(roadmapSegment("Experience")).toMatch(/\bexplores how to share\b/);
  });

  it("names the Orchestrator as the ecosystem page does: planned, not presently supported", () => {
    const research = roadmap.stages.find((stage) => stage.id === "research");
    const text = plainInline(
      (research?.blocks ?? []).flatMap((block) => (block.kind === "text" ? [block.text] : [])).join(" "),
    );
    const onEcosystemPage = plainInline(COMPUTER_ROADMAP.paragraph);
    for (const phrase of ["intend to explore an Orchestrator", "macOS where technically and legally feasible", "custom images", "not presently supported configurations"]) {
      expect({ phrase, onEcosystemPage: onEcosystemPage.includes(phrase) }).toEqual({ phrase, onEcosystemPage: true });
      expect({ phrase, onRoadmap: text.includes(phrase) }).toEqual({ phrase, onRoadmap: true });
    }
    expect(text).not.toMatch(/richer orchestration/i);
  });
});

describe("the roadmap's status words follow README.md and ROADMAP.md", () => {
  // README.md headlines "Self-host preview", so self-hosting is a preview. A free account is defined as bringing your
  // own computer, so the page says plainly that you can connect a server you already have. That is true only if the
  // release that ships it includes the connect flow, and ROADMAP.md still lists it among what is on Canary and "not yet
  // on hivra.cloud" (its "Where things stand" paragraph and the Slice 3 row). The check below stays as the tripwire:
  // when ROADMAP.md changes, confirm that the release includes the connect flow. (docs/STATUS.md is the source of
  // truth for availability; Windows and Omarchy are offered with conditions, not in preview.)
  const repoRoot = path.resolve(__dirname, "../../../../..");

  it("has a README that still calls self-hosting a preview and a ROADMAP that still lists connect-your-server as Canary only", () => {
    expect(readFileSync(path.join(repoRoot, "README.md"), "utf8")).toMatch(/^## Self-host preview$/m);
    expect(readFileSync(path.join(repoRoot, "ROADMAP.md"), "utf8")).toMatch(
      /not yet on hivra\.cloud:[\s\S]{0,400}connecting a server you already have with one command/i,
    );
  });

  it("says on the roadmap page that Hivra Cloud is paid, that connecting a server needs only a free account, and that self-hosting is a preview", () => {
    const choose = roadmap.stages
      .flatMap((stage) => stage.blocks)
      .find((block) => block.kind === "topic" && block.id === "choose-where-it-runs");
    const text = choose && choose.kind === "topic" ? choose.paragraphs.join(" ") : "";
    expect(text).toMatch(/^Hivra Cloud is where Hivra runs computers for you, on a paid plan\./);
    expect(text).toMatch(/You can also connect a server you already have, and a free account is enough for that\./);
    expect(text).toMatch(/Self-hosting the whole platform is a preview\./);
  });

  it.each<[string, boolean]>([
    ["token surfaces visible", true],
    ["token surfaces hidden", false],
  ])("never offers self-hosting or your own infrastructure without the word preview (%s)", (_name, visible) => {
    const strings = roadmapStrings(resolveRoadmap(visible)).map(plainInline);
    const mentions = strings.filter((text) => /self-host|infrastructure of your own/i.test(text));
    expect(mentions.length).toBeGreaterThanOrEqual(3);
    for (const text of mentions) expect(text).toMatch(/\bpreview\b/i);
  });
});
