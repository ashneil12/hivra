import {
  buildHermesWelcomeSystemPrompt,
  buildWelcomePersonalizationContext,
  hasWelcomePersonalization,
  normalizeWelcomePersonalizationDraft,
  parseWelcomePersonalizationContext,
} from "@/lib/welcome-personalization";

describe("welcome personalization", () => {
  it("normalizes deploy-time onboarding answers", () => {
    expect(
      normalizeWelcomePersonalizationDraft({
        goal: "build",
        context: "  I run a React app.  ",
        firstTask: "  Audit auth.  ",
      }),
    ).toEqual({
      goal: "build",
      context: "I run a React app.",
      firstTask: "Audit auth.",
    });
  });

  it("detects a non-empty draft", () => {
    expect(hasWelcomePersonalization({})).toBe(false);
    expect(hasWelcomePersonalization({ firstTask: "Show me what you can do" })).toBe(true);
  });

  it("builds context that can be saved to a Hivra/Claude agent row", () => {
    const context = buildWelcomePersonalizationContext({
      goal: "build",
      context: "I run a React app.",
      firstTask: "Audit auth.",
    });

    expect(context).toContain("Context from launch setup");
    expect(context).toContain("I run a React app.");
    expect(context).toContain("First task to demonstrate value");
    expect(context).toContain("Audit auth.");
  });

  it("recovers editable launch answers without nesting generated markdown", () => {
    const composed = buildWelcomePersonalizationContext({
      context: "I run a React app.",
      firstTask: "Audit auth.",
    });

    expect(parseWelcomePersonalizationContext(composed)).toEqual({
      context: "I run a React app.",
      firstTask: "Audit auth.",
      who: "",
      business: "",
      goals: [],
    });
  });

  it("recovers audience answers so a later provisioning edit preserves them", () => {
    const composed = buildWelcomePersonalizationContext({
      who: "Founder",
      business: "A secure agent platform",
      goals: ["Ship faster", "Improve reliability"],
      context: "I run a React app.",
      firstTask: "Audit auth.",
    });

    expect(parseWelcomePersonalizationContext(composed)).toEqual({
      who: "Founder",
      business: "A secure agent platform",
      goals: ["Ship faster", "Improve reliability"],
      context: "I run a React app.",
      firstTask: "Audit auth.",
    });
  });

  it("unwraps an already nested launch document to its innermost answers", () => {
    const first = buildWelcomePersonalizationContext({
      context: "I run a React app.",
      firstTask: "Audit auth.",
    });
    const nested = buildWelcomePersonalizationContext({ context: first });

    expect(parseWelcomePersonalizationContext(nested)).toEqual({
      context: "I run a React app.",
      firstTask: "Audit auth.",
      who: "",
      business: "",
      goals: [],
    });
  });

  it("builds a Hermes system prompt that pre-arms first chat without claiming the user already chatted", () => {
    const prompt = buildHermesWelcomeSystemPrompt({
      agentName: "Hermes Prime",
      draft: {
        goal: "build",
        context: "I run a React app.",
        firstTask: "Audit auth.",
      },
    });

    expect(prompt).toContain("Hermes Prime");
    expect(prompt).toContain("Build software");
    expect(prompt).toContain("I run a React app.");
    expect(prompt).toContain("Audit auth.");
    expect(prompt).toContain("When the user first messages you");
    expect(prompt).not.toContain("hidden setup message");
  });

  it("uses the FULL persona soul as the base when a known soulPromptId is given (Hermes lane)", () => {
    const withSoul = buildHermesWelcomeSystemPrompt({
      agentName: "Bea",
      basePrompt: "GENERIC_BASE_PROMPT",
      draft: { goal: "assist", soulPromptId: "bea" },
    });
    // The soul replaces the agent-type basePrompt as the base...
    expect(withSoul).not.toContain("GENERIC_BASE_PROMPT");
    expect(withSoul.length).toBeGreaterThan(2000);
    // ...but the firstRun launch block is still appended.
    expect(withSoul).toContain("When the user first messages you");
  });

  it("falls back to basePrompt for unknown / missing soulPromptId (zero-regression)", () => {
    const baseline = buildHermesWelcomeSystemPrompt({
      agentName: "Helper",
      basePrompt: "GENERIC_BASE_PROMPT",
      draft: { goal: "assist" },
    });
    const unknown = buildHermesWelcomeSystemPrompt({
      agentName: "Helper",
      basePrompt: "GENERIC_BASE_PROMPT",
      draft: { goal: "assist", soulPromptId: "not-a-real-soul" },
    });
    expect(baseline).toContain("GENERIC_BASE_PROMPT");
    expect(unknown).toContain("GENERIC_BASE_PROMPT");
    // Unknown id is byte-identical to the no-id path.
    expect(unknown).toBe(baseline);
  });
});
