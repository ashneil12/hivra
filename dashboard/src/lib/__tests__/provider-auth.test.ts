import {
  allowsProviderDeployWithoutApiKey,
  isCodexAuthProvider,
  isXaiOAuthProvider,
  supportsHermesAuthProvider,
} from "@/lib/provider-auth";

describe("provider-auth", () => {
  it("treats the WebUI openai-codex provider id as ChatGPT OAuth", () => {
    expect(isCodexAuthProvider("openai-codex")).toBe(true);
    expect(supportsHermesAuthProvider("openai-codex")).toBe(true);
  });

  it("does not allow unsupported oauth-like providers to deploy with an empty runtime secret", () => {
    expect(allowsProviderDeployWithoutApiKey("qwen-oauth")).toBe(false);
  });

  it("treats xai-oauth (and its aliases) as a SuperGrok OAuth provider", () => {
    expect(isXaiOAuthProvider("xai-oauth")).toBe(true);
    expect(isXaiOAuthProvider("grok-oauth")).toBe(true);
    expect(isXaiOAuthProvider("x-ai-oauth")).toBe(true);
    expect(isXaiOAuthProvider("xai-grok-oauth")).toBe(true);
    expect(supportsHermesAuthProvider("xai-oauth")).toBe(true);
    expect(allowsProviderDeployWithoutApiKey("xai-oauth")).toBe(true);
  });

  it("does not confuse xai (api-key) with xai-oauth", () => {
    expect(isXaiOAuthProvider("xai")).toBe(false);
    expect(allowsProviderDeployWithoutApiKey("xai")).toBe(false);
  });
});
