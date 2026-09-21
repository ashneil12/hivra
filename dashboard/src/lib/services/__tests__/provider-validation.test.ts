import { validateProviderApiKey } from "../provider-validation";

describe("validateProviderApiKey", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.resetAllMocks();
  });

  it("validates OpenRouter keys against the authenticated key endpoint", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
    });

    const result = await validateProviderApiKey("openrouter", "sk-or-v1-live");

    expect(result).toEqual({ valid: true });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/auth/key",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer sk-or-v1-live",
        }),
        signal: expect.any(AbortSignal),
      })
    );
  });

  it("validates Bankr keys against the LLM gateway models endpoint", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
    });

    const result = await validateProviderApiKey("bankr", "bk_live_key");

    expect(result).toEqual({ valid: true });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://llm.bankr.bot/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer bk_live_key",
        }),
        signal: expect.any(AbortSignal),
      })
    );
  });

  it("surfaces Bankr authorization failures clearly", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({
        error: {
          message: "Unauthorized",
        },
      }),
    });

    const result = await validateProviderApiKey("bankr", "bk_bad_key");

    expect(result).toEqual({
      valid: false,
      error: "Unauthorized",
    });
  });

  it("falls back to the default invalid-key message when Bankr returns a non-JSON 401", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => {
        throw new Error("not json");
      },
    });

    const result = await validateProviderApiKey("bankr", "bk_bad_key");

    expect(result).toEqual({
      valid: false,
      error: "Invalid API key",
    });
  });

  it("maps Bankr rate limits when the provider response body is not parseable", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => {
        throw new Error("not json");
      },
    });

    const result = await validateProviderApiKey("bankr", "bk_busy_key");

    expect(result).toEqual({
      valid: false,
      error: "Rate limited",
    });
  });

  it("validates CometAPI keys against the OpenAI-compatible models endpoint", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
    });

    const result = await validateProviderApiKey("cometapi", "ck_live_key");

    expect(result).toEqual({ valid: true });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.cometapi.com/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer ck_live_key",
        }),
        signal: expect.any(AbortSignal),
      })
    );
  });

  it("validates Gemini keys with the Google Generative Language key query", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
    });

    const result = await validateProviderApiKey("gemini", "AIzaSyLiveKey");

    expect(result).toEqual({ valid: true });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models?key=AIzaSyLiveKey",
      expect.objectContaining({
        method: "GET",
        headers: {},
        signal: expect.any(AbortSignal),
      })
    );
  });

  it("surfaces Gemini invalid-key errors without leaking the submitted key", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        error: {
          message: "API key not valid. Please pass a valid API key.",
        },
      }),
    });

    const result = await validateProviderApiKey("gemini", "AIzaSyBadSecret");

    expect(result).toEqual({
      valid: false,
      error: "API key not valid. Please pass a valid API key.",
    });
    expect(result.error).not.toContain("AIzaSyBadSecret");
  });

  it("redacts secret-bearing request URLs from transport failures", async () => {
    (global.fetch as jest.Mock).mockRejectedValue(
      new Error("request to https://generativelanguage.googleapis.com/v1beta/models?key=super-secret failed")
    );

    const result = await validateProviderApiKey("gemini", "super-secret");

    expect(result).toEqual({
      valid: false,
      error: "request to https://generativelanguage.googleapis.com/v1beta/models?key=[REDACTED] failed",
    });
    expect(result.error).not.toContain("super-secret");
  });
});
