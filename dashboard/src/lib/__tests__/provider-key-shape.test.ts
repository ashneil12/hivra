import { validateProviderKeyShape } from "../provider-key-shape";

describe("validateProviderKeyShape", () => {
  it("accepts OpenRouter keys with the sk-or prefix", () => {
    expect(validateProviderKeyShape("openrouter", "sk-or-v1-valid")).toBeNull();
  });

  it("rejects GitHub token-shaped values for OpenRouter", () => {
    expect(validateProviderKeyShape("openrouter", "ghp_wrong_secret")).toEqual({
      failureType: "provider_key_invalid_shape",
      message: "OpenRouter API keys must start with sk-or-.",
      provider: "openrouter",
    });
  });

  it("accepts Surplus Intelligence keys with the inf_ prefix", () => {
    expect(validateProviderKeyShape("surplus", "inf_abc123")).toBeNull();
  });

  it("rejects non-inf_ keys for Surplus Intelligence", () => {
    expect(validateProviderKeyShape("surplus", "sk-not-a-surplus-key")).toEqual({
      failureType: "provider_key_invalid_shape",
      message: "Surplus Intelligence API keys must start with inf_.",
      provider: "surplus",
    });
  });

  it("does not guess Gemini key validity from local shape", () => {
    expect(validateProviderKeyShape("gemini", "AIzaSyExampleKeyValue")).toBeNull();
    expect(validateProviderKeyShape("gemini", "google-live-valid-non-aiza-shape-example")).toBeNull();
    expect(validateProviderKeyShape("gemini", "sk-or-not-a-gemini-key")).toBeNull();
  });

  it("does not guess for providers without a stable local shape rule", () => {
    expect(validateProviderKeyShape("custom_llm", "anything-user-configured")).toBeNull();
  });
});
