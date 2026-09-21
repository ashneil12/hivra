import {
  fetchLiveProviderModels,
  getLiveModelDiscoveryStatusMessage,
  supportsLiveModelDiscovery,
  supportsPublicLiveModelDiscovery,
} from "../provider-models";

describe("provider live models", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it("uses OpenAI's authenticated models endpoint when an API key is available", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "gpt-5.4", owned_by: "openai" },
          { id: "gpt-5.5", owned_by: "openai" },
        ],
      }),
    });

    const models = await fetchLiveProviderModels("openai", "sk-openai-test");

    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      expect.objectContaining({
        cache: "no-store",
        headers: expect.objectContaining({
          Authorization: "Bearer sk-openai-test",
          Accept: "application/json",
        }),
        signal: expect.any(AbortSignal),
      })
    );

    expect(models).toEqual([
      { value: "gpt-5.4", label: "gpt-5.4" },
      { value: "gpt-5.5", label: "gpt-5.5" },
    ]);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.resetAllMocks();
  });

  it("uses OpenRouter's user-scoped models endpoint and normalizes the response", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "openai/gpt-5.4", name: "OpenAI: GPT-5.4" },
          { id: "anthropic/claude-sonnet-4.6", name: "Anthropic: Claude Sonnet 4.6" },
        ],
      }),
    });

    const models = await fetchLiveProviderModels("openrouter", "sk-or-test");

    expect(global.fetch).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/models/user",
      expect.objectContaining({
        cache: "no-store",
        headers: expect.objectContaining({
          Authorization: "Bearer sk-or-test",
          Accept: "application/json",
        }),
        signal: expect.any(AbortSignal),
      })
    );

    expect(models).toEqual([
      { value: "openai/gpt-5.4", label: "OpenAI: GPT-5.4" },
      { value: "anthropic/claude-sonnet-4.6", label: "Anthropic: Claude Sonnet 4.6" },
    ]);
  });

  it("uses Venice's live models endpoint and normalizes the response", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "kimi-k2-6", model_spec: { name: "Kimi K2.6" } },
          { id: "venice-uncensored", model_spec: { name: "Venice Uncensored" } },
        ],
      }),
    });

    const models = await fetchLiveProviderModels("venice");

    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.venice.ai/api/v1/models",
      expect.objectContaining({
        cache: "no-store",
        headers: expect.objectContaining({
          Accept: "application/json",
        }),
        signal: expect.any(AbortSignal),
      })
    );

    expect(models).toEqual([
      { value: "kimi-k2-6", label: "Kimi K2.6" },
      { value: "venice-uncensored", label: "Venice Uncensored" },
    ]);
  });

  it("uses Nous Portal's public models endpoint and returns the routed catalog", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "openai/gpt-5.4", name: "OpenAI: GPT-5.4" },
          { id: "nousresearch/hermes-4-70b", name: "Hermes 4 70B" },
        ],
      }),
    });

    const models = await fetchLiveProviderModels("nous");

    expect(global.fetch).toHaveBeenCalledWith(
      "https://inference-api.nousresearch.com/v1/models",
      expect.objectContaining({
        cache: "no-store",
        headers: expect.objectContaining({
          Accept: "application/json",
        }),
        signal: expect.any(AbortSignal),
      })
    );

    expect(models).toEqual([
      { value: "openai/gpt-5.4", label: "OpenAI: GPT-5.4" },
      { value: "nousresearch/hermes-4-70b", label: "Hermes 4 70B" },
    ]);
  });

  it("uses OpenRouter's public endpoint when no API key is available", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: "moonshotai/kimi-k2.6", name: "MoonshotAI: Kimi K2.6" }],
      }),
    });

    const models = await fetchLiveProviderModels("openrouter");

    expect(global.fetch).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/models",
      expect.objectContaining({
        cache: "no-store",
        headers: expect.objectContaining({
          Accept: "application/json",
        }),
        signal: expect.any(AbortSignal),
      })
    );

    expect(models).toEqual([{ value: "moonshotai/kimi-k2.6", label: "MoonshotAI: Kimi K2.6" }]);
  });

  it("uses Crof's public endpoint when no API key is available", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: "kimi-k2.6-precision", name: "MoonshotAI: Kimi K2.6" }],
      }),
    });

    const models = await fetchLiveProviderModels("crof");

    expect(global.fetch).toHaveBeenCalledWith(
      "https://crof.ai/v1/models",
      expect.objectContaining({
        cache: "no-store",
        headers: expect.objectContaining({
          Accept: "application/json",
        }),
        signal: expect.any(AbortSignal),
      })
    );

    expect(models).toEqual([{ value: "kimi-k2.6-precision", label: "MoonshotAI: Kimi K2.6" }]);
  });

  it("uses Bankr's authenticated models endpoint and normalizes the response", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "claude-opus-4.7", owned_by: "anthropic" },
          { id: "gpt-5.4", owned_by: "openai" },
        ],
      }),
    });

    const models = await fetchLiveProviderModels("bankr", "bk-test");

    expect(global.fetch).toHaveBeenCalledWith(
      "https://llm.bankr.bot/v1/models",
      expect.objectContaining({
        cache: "no-store",
        headers: expect.objectContaining({
          Accept: "application/json",
          Authorization: "Bearer bk-test",
        }),
        signal: expect.any(AbortSignal),
      })
    );

    expect(models).toEqual([
      { value: "claude-opus-4.7", label: "claude-opus-4.7" },
      { value: "gpt-5.4", label: "gpt-5.4" },
    ]);
  });

  it("uses CometAPI's public catalog, keeps only text models, and prefixes the upstream provider", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "gpt-image-2", name: "GPT Image 2", provider: "OpenAI", model_type: "image" },
          { id: "gpt-5.5-all", name: "GPT 5.5 ALL", provider: "OpenAI", model_type: "text" },
          { id: "gpt-5.4", name: "GPT-5.4", provider: "OpenAI", model_type: "text" },
          { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "Anthropic", model_type: "text" },
          { id: "claude-opus-4-6", name: "Duplicate should be ignored", provider: "Anthropic", model_type: "text" },
        ],
      }),
    });

    const models = await fetchLiveProviderModels("cometapi", "ck-live-key");

    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.cometapi.com/api/models",
      expect.objectContaining({
        cache: "no-store",
        headers: expect.objectContaining({
          Accept: "application/json",
          Authorization: "Bearer ck-live-key",
        }),
        signal: expect.any(AbortSignal),
      })
    );

    expect(models).toEqual([
      { value: "claude-opus-4-6", label: "Anthropic · Claude Opus 4.6" },
      { value: "gpt-5.5-all", label: "OpenAI · GPT 5.5 ALL" },
      { value: "gpt-5.4", label: "OpenAI · GPT-5.4" },
    ]);
  });

  it("allows CometAPI discovery without an API key because the catalog is public", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: "kimi-k2.6", name: "Kimi K2.6", provider: "Moonshot AI", model_type: "text" }],
      }),
    });

    const models = await fetchLiveProviderModels("cometapi");

    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.cometapi.com/api/models",
      expect.objectContaining({
        cache: "no-store",
        headers: expect.objectContaining({
          Accept: "application/json",
        }),
        signal: expect.any(AbortSignal),
      })
    );

    expect(models).toEqual([
      { value: "kimi-k2.6", label: "Moonshot AI · Kimi K2.6" },
    ]);
  });

  it("does not double-prefix CometAPI labels when the upstream label already starts with the provider", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: "gpt-5.4", name: "OpenAI GPT-5.4", provider: "OpenAI", model_type: "text" }],
      }),
    });

    const models = await fetchLiveProviderModels("cometapi");

    expect(models).toEqual([
      { value: "gpt-5.4", label: "OpenAI GPT-5.4" },
    ]);
  });

  it("uses Gemini's API-key query catalog and keeps chat models only", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          {
            name: "models/gemini-3.5-flash",
            displayName: "Gemini 3.5 Flash",
            supportedGenerationMethods: ["generateContent", "countTokens"],
          },
          {
            name: "models/gemini-3-flash-preview",
            displayName: "Gemini 3 Flash Preview",
            supportedGenerationMethods: ["generateContent"],
          },
          {
            name: "models/gemini-embedding-001",
            displayName: "Gemini Embedding",
            supportedGenerationMethods: ["embedContent"],
          },
          {
            name: "models/imagen-4.0-generate-001",
            displayName: "Imagen 4",
            supportedGenerationMethods: ["predict"],
          },
          {
            name: "models/gemini-3.1-flash-tts-preview",
            displayName: "Gemini 3.1 Flash TTS Preview",
            supportedGenerationMethods: ["generateContent"],
          },
        ],
      }),
    });

    const models = await fetchLiveProviderModels("gemini", "google-key");

    expect(global.fetch).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models?key=google-key",
      expect.objectContaining({
        cache: "no-store",
        method: "GET",
        headers: { Accept: "application/json" },
        signal: expect.any(AbortSignal),
      })
    );
    expect(models).toEqual([
      { value: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
      { value: "gemini-3-flash-preview", label: "Gemini 3 Flash Preview" },
    ]);
  });

  it("requires an API key for Gemini because Google does not expose a public model catalog", async () => {
    await expect(fetchLiveProviderModels("gemini")).rejects.toThrow(
      "Live model discovery requires an API key for provider: gemini"
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed live model payloads", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { id: "not-an-array" } }),
    });

    await expect(fetchLiveProviderModels("venice", "venice-key")).rejects.toThrow(
      "Provider did not return a models array"
    );
  });

  it("normalizes the provider id and de-duplicates returned models", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "openai/gpt-5.4", name: "OpenAI: GPT-5.4" },
          { id: "openai/gpt-5.4", name: "Duplicate label should be ignored" },
        ],
      }),
    });

    const models = await fetchLiveProviderModels(" OpenRouter ", "sk-or-test");

    expect(models).toEqual([{ value: "openai/gpt-5.4", label: "OpenAI: GPT-5.4" }]);
  });

  it("requires an API key for providers without a public model catalog", async () => {
    await expect(fetchLiveProviderModels("moonshot")).rejects.toThrow(
      "Live model discovery requires an API key for provider: moonshot"
    );
  });

  it("requires an API key for Bankr because it only exposes an authenticated model catalog", async () => {
    await expect(fetchLiveProviderModels("bankr")).rejects.toThrow(
      "Live model discovery requires an API key for provider: bankr"
    );
  });

  it("reports which providers support public model discovery", () => {
    expect(supportsLiveModelDiscovery(" Bankr ")).toBe(true);
    expect(supportsLiveModelDiscovery(" cometapi ")).toBe(true);
    expect(supportsLiveModelDiscovery(" gemini ")).toBe(true);
    expect(supportsPublicLiveModelDiscovery("openrouter")).toBe(true);
    expect(supportsPublicLiveModelDiscovery("nous")).toBe(true);
    expect(supportsPublicLiveModelDiscovery("venice")).toBe(true);
    expect(supportsPublicLiveModelDiscovery("crof")).toBe(true);
    expect(supportsPublicLiveModelDiscovery(" cometapi ")).toBe(true);
    expect(supportsPublicLiveModelDiscovery(" gemini ")).toBe(false);
    expect(supportsPublicLiveModelDiscovery(" Bankr ")).toBe(false);
    expect(supportsPublicLiveModelDiscovery("moonshot")).toBe(false);
  });

  it("suppresses Bankr credit lookup failures behind a neutral presets message", () => {
    expect(
      getLiveModelDiscoveryStatusMessage({
        provider: "bankr",
        isLoading: false,
        hasLiveModels: false,
        error: "Provider returned HTTP 402",
        supportsPublicModels: false,
      })
    ).toBe("Using curated Bankr model presets.");

    expect(
      getLiveModelDiscoveryStatusMessage({
        provider: "bankr",
        isLoading: false,
        hasLiveModels: false,
        error: "Insufficient LLM Gateway credits. Visit bankr.bot to check your balance.",
        supportsPublicModels: false,
      })
    ).toBe("Using curated Bankr model presets.");
  });

  it("keeps non-Bankr lookup errors visible", () => {
    expect(
      getLiveModelDiscoveryStatusMessage({
        provider: "openrouter",
        isLoading: false,
        hasLiveModels: false,
        error: "Provider returned HTTP 429",
        supportsPublicModels: true,
      })
    ).toBe("Live lookup failed, using presets: Provider returned HTTP 429");
  });
});
