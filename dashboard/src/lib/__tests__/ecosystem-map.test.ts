/** @jest-environment node */
// The ecosystem map is a statement about what is live and what is only planned, so its
// statuses are pinned to the litepaper (LITEPAPER.md, "What we're building around it") and
// to the 15 names the page, the e2e spec and the sitemap notes use. Moving a product
// between stages is Ash's call: this test fails until the litepaper and the map agree.
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  ECOSYSTEM_PRODUCT_NAMES,
  ECOSYSTEM_PRODUCTS,
  ECOSYSTEM_STAGES,
  ecosystemProductSlug,
  ecosystemStageOf,
  type EcosystemStageId,
} from "../ecosystem-map";

const APPROVED_LITEPAPER = path.resolve(__dirname, "../../components/landing/__tests__/fixtures/litepaper-2026-09-approved.md");

const PINNED: Record<EcosystemStageId, string[]> = {
  "available-now": ["Agent Computers"],
  next: ["Gate", "Exchange", "Arena", "Signal"],
  then: ["Vault", "Passport", "Seal", "Rescue", "Challenges", "Experience"],
  research: ["Missions", "Foundry", "Colony", "Interchange", "Ports"],
};

/** Product name to the litepaper group it is written under. */
function litepaperGroups(): Record<string, EcosystemStageId> {
  const lines = readFileSync(APPROVED_LITEPAPER, "utf8").split("\n");
  const found: Record<string, EcosystemStageId> = {};
  let group: EcosystemStageId | null = null;
  let started = false;
  for (const line of lines) {
    if (/^### Agent Computers\s+·\s+Available now\s*$/.test(line)) {
      group = "available-now";
      started = true;
      found["Agent Computers"] = group;
    } else if (/^### Next\s*$/.test(line)) group = "next";
    else if (/^### Then\s*$/.test(line)) group = "then";
    else if (/^### Research\s*$/.test(line)) group = "research";
    else if (started && /^## /.test(line)) break;
    else if (group && group !== "available-now") {
      const product = line.match(/^\*\*([A-Z][A-Za-z]+)\.\*\* \*.+\*$/);
      if (product) found[product[1]] = group;
    }
  }
  return found;
}

describe("the ecosystem map", () => {
  it("holds the 15 products and Agent Computers, in four stages", () => {
    expect(ECOSYSTEM_STAGES.map((stage) => stage.id)).toEqual(["available-now", "next", "then", "research"]);
    expect(ECOSYSTEM_STAGES.map((stage) => stage.label)).toEqual(["Available now", "Next", "Then", "Research"]);
    for (const stage of ECOSYSTEM_STAGES) {
      expect({ stage: stage.id, names: stage.products.map((product) => product.name) }).toEqual({
        stage: stage.id,
        names: PINNED[stage.id],
      });
    }
    expect(ECOSYSTEM_PRODUCT_NAMES).toHaveLength(16);
    expect(new Set(ECOSYSTEM_PRODUCTS.map((product) => product.slug)).size).toBe(16);
  });

  it("keeps every product in the group the litepaper puts it in", () => {
    const written = litepaperGroups();
    // Sanity: the parser read the groups it is meant to guard.
    expect(Object.keys(written).sort()).toEqual([...ECOSYSTEM_PRODUCT_NAMES].sort());
    for (const product of ECOSYSTEM_PRODUCTS) {
      expect({ name: product.name, stage: product.stage }).toEqual({ name: product.name, stage: written[product.name] });
    }
  });

  it("gives the planned stages their hedges and Available now none", () => {
    const next = ECOSYSTEM_STAGES.find((stage) => stage.id === "next");
    const then = ECOSYSTEM_STAGES.find((stage) => stage.id === "then");
    expect(next?.title).toBe("Make individual agents more useful and accountable");
    expect(next?.intro).toBe("These products are planned. They are not currently available simply because they're named here.");
    expect(then?.title).toBe("Identity, recovery and shared knowledge");
    expect(then?.intro).toBe(
      "These ideas follow the first planned products in the intended sequence. The order may change; none comes with a promised release date.",
    );
    expect(ECOSYSTEM_STAGES.find((stage) => stage.id === "research")?.title).toBe("Things worth exploring, not yet promises");
    expect(ECOSYSTEM_STAGES.find((stage) => stage.id === "available-now")?.title).toBeUndefined();
  });

  it("carries a tagline and at least one paragraph per product, with no dash, date, token or price", () => {
    for (const product of ECOSYSTEM_PRODUCTS) {
      expect(product.tagline.trim().length).toBeGreaterThan(10);
      expect(product.paragraphs.length).toBeGreaterThan(0);
      const text = [product.tagline, ...product.paragraphs].join(" ");
      expect(text).not.toMatch(/[–—]/);
      expect(text).not.toMatch(/\$\d|\b20\d\d\b|\$HIVRA|\$HermesOS|token|airdrop|snapshot/i);
    }
  });

  it("states the counts the pack states: 2 paragraphs for Next, 1 for Then and Research, 3 for Agent Computers", () => {
    const counts = Object.fromEntries(ECOSYSTEM_PRODUCTS.map((product) => [product.name, product.paragraphs.length]));
    expect(counts).toEqual({
      "Agent Computers": 3,
      Gate: 2,
      Exchange: 2,
      Arena: 2,
      Signal: 2,
      Vault: 1,
      Passport: 1,
      Seal: 1,
      Rescue: 1,
      Challenges: 1,
      Experience: 1,
      Missions: 1,
      Foundry: 1,
      Colony: 1,
      Interchange: 1,
      Ports: 1,
    });
  });

  it("looks a product up by name", () => {
    expect(ecosystemStageOf("Gate")).toBe("next");
    expect(ecosystemStageOf("Ports")).toBe("research");
    expect(ecosystemStageOf("Nothing")).toBeUndefined();
    expect(ecosystemProductSlug("Agent Computers")).toBe("agent-computers");
    expect(ecosystemProductSlug("Nothing")).toBeUndefined();
  });
});
