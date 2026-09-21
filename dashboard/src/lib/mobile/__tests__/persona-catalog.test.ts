/**
 * Mobile persona catalog tests. Locks in:
 *   - full coverage: every WELCOME_PERSONAS entry ships in the mobile catalog
 *     with authored suggested first tasks (2–3, consumer language)
 *   - the jargon firewall: NO engine fields (agentTypeKey, soulPromptId,
 *     personality prompt-clause, icon) ever leave the server
 *   - display order preserved (Bea first, custom last)
 */

import { buildMobilePersonaCatalog } from "../persona-catalog";
import { WELCOME_PERSONAS } from "@/lib/welcome-persona-catalog";

describe("buildMobilePersonaCatalog", () => {
  const catalog = buildMobilePersonaCatalog();

  it("covers every welcome persona, in display order", () => {
    expect(catalog.map((p) => p.id)).toEqual(WELCOME_PERSONAS.map((p) => p.id));
    // Bea (id atlas) is the first/recommended card; custom stays last.
    expect(catalog[0]).toMatchObject({ id: "atlas", displayName: "Bea" });
    expect(catalog[catalog.length - 1]).toMatchObject({ id: "custom", isCustom: true });
  });

  it("gives every persona 2–3 authored suggested first tasks", () => {
    for (const persona of catalog) {
      expect(persona.suggestedFirstTasks.length).toBeGreaterThanOrEqual(2);
      expect(persona.suggestedFirstTasks.length).toBeLessThanOrEqual(3);
      for (const task of persona.suggestedFirstTasks) {
        expect(typeof task).toBe("string");
        expect(task.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("exposes exactly the consumer fields — no engine jargon leaves the server", () => {
    for (const persona of catalog) {
      expect(Object.keys(persona).sort()).toEqual(
        [
          "displayName",
          "emoji",
          "goal",
          "id",
          "isCustom",
          "pitch",
          "role",
          "suggestedFirstTasks",
        ].sort()
      );
    }
    const serialized = JSON.stringify(catalog);
    for (const banned of ["agentTypeKey", "soulPromptId", "personality", "icon", "Hermes Agent"]) {
      expect(serialized).not.toContain(banned);
    }
  });

  it("carries the persona card copy through unchanged", () => {
    const bea = catalog.find((p) => p.id === "atlas");
    const source = WELCOME_PERSONAS.find((p) => p.id === "atlas")!;
    expect(bea).toMatchObject({
      displayName: source.name,
      role: source.role,
      pitch: source.pitch,
      emoji: source.emoji,
      goal: source.goal,
      isCustom: false,
    });
  });
});
