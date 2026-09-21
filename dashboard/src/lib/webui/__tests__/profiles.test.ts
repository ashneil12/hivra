import {
  buildWebUIDefaultModel,
  mapWebUIProfileToDashboard,
  readWebUIProfileProviderOverride,
  readWebUIRuntimeModelSettings,
  resolveWebUIDefaultModelProvider,
  WEBUI_PROFILE_PROVIDERS_CONFIG_KEY,
  withWebUIProfileProviderOverride,
} from "@/lib/webui/profiles";

describe("mapWebUIProfileToDashboard", () => {
  it("maps WebUI openai-codex profiles back to the dashboard ChatGPT OAuth provider", () => {
    const mapped = mapWebUIProfileToDashboard({
      instanceId: "inst-1",
      userId: "user-1",
      profile: {
        name: "default",
        provider: "openai-codex",
        model: "@openai-codex:gpt-5.5",
        is_default: true,
        is_active: true,
      },
    });

    expect(mapped.provider).toBe("codex");
    expect(mapped.model).toBe("gpt-5.5");
    expect(mapped.config.provider).toBe("codex");
    expect(mapped.config.model).toBe("gpt-5.5");
  });

  it("reads profile-scoped runtime model settings from WebUI settings payloads", () => {
    expect(readWebUIRuntimeModelSettings({
      default_model: "@openai-codex:gpt-5.5",
      active_provider: "openai-codex",
    })).toEqual({
      provider: "codex",
      model: "gpt-5.5",
    });
  });

  it("prefers dashboardProviderOverride over the derived 'custom' for OpenAI-compatible providers", () => {
    // Live failure 2026-05-02: user picked CometAPI + claude-opus-4-7 in
    // BASE LLM OVERRIDE, save persisted correctly to config.yaml/.env, but
    // on reload the dashboard showed provider="custom" because hermes-cli
    // collapses every OpenAI-compatible provider behind a base_url to
    // "custom". The dashboard-controlled override (sourced from
    // instance.config.webui_profile_providers, since WebUI's settings.json
    // allowlists keys and silently drops unknown ones) recovers the
    // dashboard-side identity so the dropdown round-trips correctly.
    const mapped = mapWebUIProfileToDashboard({
      instanceId: "inst-1",
      userId: "user-1",
      profile: {
        name: "default",
        provider: "custom",
        model: "claude-opus-4-7",
        is_default: true,
        is_active: true,
      },
      dashboardProviderOverride: "cometapi",
    });

    expect(mapped.provider).toBe("cometapi");
    expect(mapped.model).toBe("claude-opus-4-7");
    expect(mapped.config.provider).toBe("cometapi");
  });

  it("falls back to the derived provider when no dashboardProviderOverride is supplied", () => {
    // Pre-sidecar legacy state: existing instances saved before the sidecar
    // landed will see provider='custom' until the next save populates the
    // override. Don't crash, don't paper over — show what WebUI reports.
    const mapped = mapWebUIProfileToDashboard({
      instanceId: "inst-1",
      userId: "user-1",
      profile: {
        name: "default",
        provider: "custom",
        model: "claude-opus-4-7",
        is_default: true,
        is_active: true,
      },
    });

    expect(mapped.provider).toBe("custom");
  });

  it("ignores blank/whitespace-only override and falls back to derived value", () => {
    const mapped = mapWebUIProfileToDashboard({
      instanceId: "inst-1",
      userId: "user-1",
      profile: {
        name: "default",
        provider: "openai-codex",
        model: "@openai-codex:gpt-5.5",
        is_default: true,
        is_active: true,
      },
      dashboardProviderOverride: "   ",
    });

    expect(mapped.provider).toBe("codex");
  });
});

describe("readWebUIProfileProviderOverride", () => {
  it("returns the trimmed dashboard provider id for a given webui profile", () => {
    expect(
      readWebUIProfileProviderOverride(
        {
          [WEBUI_PROFILE_PROVIDERS_CONFIG_KEY]: {
            default: "  cometapi  ",
            research: "anthropic",
          },
          agentSettings: { systemPrompt: "..." },
        },
        "default",
      ),
    ).toBe("cometapi");

    expect(
      readWebUIProfileProviderOverride(
        {
          [WEBUI_PROFILE_PROVIDERS_CONFIG_KEY]: {
            default: "cometapi",
            research: "anthropic",
          },
        },
        "research",
      ),
    ).toBe("anthropic");
  });

  it("returns null when the override map is missing or doesn't contain the requested profile", () => {
    expect(readWebUIProfileProviderOverride(null, "default")).toBeNull();
    expect(readWebUIProfileProviderOverride(undefined, "default")).toBeNull();
    expect(readWebUIProfileProviderOverride({}, "default")).toBeNull();
    expect(
      readWebUIProfileProviderOverride(
        { [WEBUI_PROFILE_PROVIDERS_CONFIG_KEY]: { research: "anthropic" } },
        "default",
      ),
    ).toBeNull();
  });

  it("returns null when the stored value is non-string, blank, or the map is mistyped", () => {
    expect(
      readWebUIProfileProviderOverride(
        { [WEBUI_PROFILE_PROVIDERS_CONFIG_KEY]: { default: "" } },
        "default",
      ),
    ).toBeNull();
    expect(
      readWebUIProfileProviderOverride(
        { [WEBUI_PROFILE_PROVIDERS_CONFIG_KEY]: { default: 42 } },
        "default",
      ),
    ).toBeNull();
    // Map field exists but is an array — defensive: treat as missing.
    expect(
      readWebUIProfileProviderOverride(
        { [WEBUI_PROFILE_PROVIDERS_CONFIG_KEY]: ["cometapi"] },
        "default",
      ),
    ).toBeNull();
  });
});

describe("withWebUIProfileProviderOverride", () => {
  it("creates the map when no override exists yet, preserving siblings", () => {
    const next = withWebUIProfileProviderOverride(
      { agentSettings: { systemPrompt: "x" }, model: "claude-opus-4-7" },
      "default",
      "cometapi",
    );
    expect(next.agentSettings).toEqual({ systemPrompt: "x" });
    expect(next.model).toBe("claude-opus-4-7");
    expect(next[WEBUI_PROFILE_PROVIDERS_CONFIG_KEY]).toEqual({ default: "cometapi" });
  });

  it("merges into an existing map without dropping other profiles", () => {
    const next = withWebUIProfileProviderOverride(
      {
        [WEBUI_PROFILE_PROVIDERS_CONFIG_KEY]: { research: "anthropic" },
      },
      "default",
      "cometapi",
    );
    expect(next[WEBUI_PROFILE_PROVIDERS_CONFIG_KEY]).toEqual({
      research: "anthropic",
      default: "cometapi",
    });
  });

  it("overwrites an existing entry for the same profile name", () => {
    const next = withWebUIProfileProviderOverride(
      {
        [WEBUI_PROFILE_PROVIDERS_CONFIG_KEY]: { default: "openrouter" },
      },
      "default",
      "cometapi",
    );
    expect(next[WEBUI_PROFILE_PROVIDERS_CONFIG_KEY]).toEqual({ default: "cometapi" });
  });

  it("resets a malformed map (array) instead of crashing or merging into it", () => {
    const next = withWebUIProfileProviderOverride(
      { [WEBUI_PROFILE_PROVIDERS_CONFIG_KEY]: ["cometapi"] },
      "default",
      "cometapi",
    );
    expect(next[WEBUI_PROFILE_PROVIDERS_CONFIG_KEY]).toEqual({ default: "cometapi" });
  });

  it("starts from an empty config when none is provided", () => {
    const next = withWebUIProfileProviderOverride(null, "default", "cometapi");
    expect(next).toEqual({
      [WEBUI_PROFILE_PROVIDERS_CONFIG_KEY]: { default: "cometapi" },
    });
  });
});

describe("buildWebUIDefaultModel", () => {
  it("keeps unsupported dashboard-only providers as bare model values during migration", () => {
    expect(buildWebUIDefaultModel("deepseek-v4-pro", "venice", {
      supportedProviderIds: ["openai", "openrouter", "gemini"],
    })).toBe("deepseek-v4-pro");
  });

  it("uses first-class WebUI gateway providers when the target runtime supports them", () => {
    expect(buildWebUIDefaultModel("deepseek-v4-pro", "venice", {
      supportedProviderIds: ["venice", "bankr", "cometapi", "groq"],
    })).toBe("@venice:deepseek-v4-pro");
  });

  it("uses the WebUI provider alias when the target runtime supports it", () => {
    expect(buildWebUIDefaultModel("kimi-k2.6", "moonshot", {
      supportedProviderIds: ["kimi-coding"],
    })).toBe("@kimi-coding:kimi-k2.6");
  });
});

describe("resolveWebUIDefaultModelProvider", () => {
  it("infers OpenRouter for namespaced model ids that are newer than the static catalog", () => {
    const resolved = resolveWebUIDefaultModelProvider({
      model: "anthropic/claude-opus-4.7-fast",
    });

    expect(resolved).toEqual({ provider: "openrouter", source: "model" });
    expect(
      buildWebUIDefaultModel("anthropic/claude-opus-4.7-fast", resolved.provider),
    ).toBe("@openrouter:anthropic/claude-opus-4.7-fast");
  });

  it("keeps the stored dashboard provider override ahead of model namespace inference", () => {
    expect(
      resolveWebUIDefaultModelProvider({
        model: "anthropic/claude-opus-4.7-fast",
        currentDashboardProvider: "crof",
      }),
    ).toEqual({ provider: "crof", source: "override" });
  });

  it("repairs collapsed WebUI custom state when the model carries an OpenRouter namespace", () => {
    expect(
      resolveWebUIDefaultModelProvider({
        model: "anthropic/claude-opus-4.7-fast",
        currentDashboardProvider: "custom",
      }),
    ).toEqual({ provider: "openrouter", source: "model" });
  });

  it("lets an explicit provider win when the UI sends one", () => {
    expect(
      resolveWebUIDefaultModelProvider({
        model: "anthropic/claude-opus-4.7-fast",
        explicitProvider: "venice",
        currentDashboardProvider: "openrouter",
      }),
    ).toEqual({ provider: "venice", source: "explicit" });
  });
});
