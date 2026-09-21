import {
  buildHermesWebConfigPayload,
  buildSkillCategories,
  extractHermesSessionToken,
  findSkillByName,
} from "@/lib/hermes-web";

describe("hermes-web helpers", () => {
  it("extracts the injected upstream session token from dashboard HTML", () => {
    const html = `<!doctype html><html><head><script>window.__HERMES_SESSION_TOKEN__="secret-token-123";</script></head></html>`;

    expect(extractHermesSessionToken(html)).toBe("secret-token-123");
  });

  it("builds sorted category counts from upstream skill metadata", () => {
    expect(
      buildSkillCategories([
        { name: "beta", category: "qa" },
        { name: "alpha", category: "devops" },
        { name: "gamma", category: "qa" },
        { name: "uncategorized", category: null },
      ]),
    ).toEqual([
      { name: "devops", skill_count: 1 },
      { name: "qa", skill_count: 2 },
    ]);
  });

  it("finds a specific skill by name from the upstream list", () => {
    const skill = { name: "browser-debug", description: "Debug browser flows", category: "browser" };

    expect(findSkillByName([skill], "browser-debug")).toEqual(skill);
    expect(findSkillByName([skill], "missing-skill")).toBeNull();
  });

  it("builds an upstream-compatible model payload while preserving context length", () => {
    expect(
      buildHermesWebConfigPayload(
        {
          model: "old-model",
          model_context_length: 64000,
          display: { skin: "default" },
        },
        {
          model: "new-model",
          provider: "custom",
          baseUrl: "https://example.com/v1",
        },
      ),
    ).toEqual({
      model: {
        default: "new-model",
        provider: "custom",
        base_url: "https://example.com/v1",
        context_length: 64000,
      },
      display: { skin: "default" },
    });
  });

  it("can clear the provider while keeping a model override", () => {
    expect(
      buildHermesWebConfigPayload(
        {
          model: "existing-model",
          model_context_length: 0,
          agent: { fast_mode: true },
        },
        {
          model: "existing-model",
          provider: "",
          baseUrl: null,
        },
      ),
    ).toEqual({
      model: {
        default: "existing-model",
      },
      agent: { fast_mode: true },
    });
  });
});
