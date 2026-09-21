import {
  getPersonaSoulPrompt,
  resolvePersonaSoulFromSystemPrompt,
} from "@/lib/persona-souls-accessor";
import { buildHermesWelcomeSystemPrompt } from "@/lib/welcome-personalization";

// resolvePersonaSoulFromSystemPrompt is the seam that lets provisioning seed a
// persona's authored soul into the box's SOUL.md from nothing but the
// instance's stored config (the Hermes create path threads no soulPromptId).
// If it stops recognizing the stored prompt, persona boxes silently downgrade
// to the who-am-I ritual and contradict the identity the user picked — so the
// recognition is tested against the REAL composition function, not a fixture.
describe("resolvePersonaSoulFromSystemPrompt", () => {
  it("recognizes the soul inside a real welcome system prompt (composition contract)", () => {
    const stored = buildHermesWelcomeSystemPrompt({
      agentName: "Bea",
      draft: {
        soulPromptId: "bea",
        goal: "assist",
        who: "Founder",
        business: "Acme Beds",
        goals: ["inbox triage"],
        context: "We sell beds online.",
        firstTask: "Summarize my unread email.",
      },
    });
    const resolved = resolvePersonaSoulFromSystemPrompt(stored);
    expect(resolved?.id).toBe("bea");
    // The seeded SOUL.md must be the FULL authored soul, not the stored
    // composite (soul + first-run launch block).
    expect(resolved?.soulPrompt).toBe(getPersonaSoulPrompt("bea"));
  });

  it("recognizes a raw soul stored with no first-run block appended", () => {
    const resolved = resolvePersonaSoulFromSystemPrompt(getPersonaSoulPrompt("pike"));
    expect(resolved?.id).toBe("pike");
  });

  it("returns null for a personalization-only prompt (custom persona / no soul)", () => {
    // "Build your own" and no-persona deploys produce a firstRun-only prompt —
    // they must keep the existing onboarding ritual (zero-regression contract).
    const stored = buildHermesWelcomeSystemPrompt({
      agentName: "Custom Agent",
      draft: { goal: "assist", personality: "direct and helpful" },
    });
    expect(stored.length).toBeGreaterThan(0);
    expect(resolvePersonaSoulFromSystemPrompt(stored)).toBeNull();
  });

  it("returns null for empty / missing / generic prompts", () => {
    expect(resolvePersonaSoulFromSystemPrompt(undefined)).toBeNull();
    expect(resolvePersonaSoulFromSystemPrompt(null)).toBeNull();
    expect(resolvePersonaSoulFromSystemPrompt("")).toBeNull();
    expect(resolvePersonaSoulFromSystemPrompt("   ")).toBeNull();
    expect(resolvePersonaSoulFromSystemPrompt("You are a helpful assistant.")).toBeNull();
  });

  it("does not false-positive on a prompt that merely mentions a persona", () => {
    expect(
      resolvePersonaSoulFromSystemPrompt("Act like Bea, the assistant persona from Hivra.")
    ).toBeNull();
  });
});
