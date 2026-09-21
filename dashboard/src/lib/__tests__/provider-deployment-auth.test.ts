import { serializeCodexVaultBundle } from "@/lib/codex-oauth";
import { resolveProviderDeploymentSecret } from "../provider-deployment-auth";

describe("provider deployment auth", () => {
  it("treats the WebUI openai-codex provider alias as a Codex OAuth bundle", () => {
    const serialized = serializeCodexVaultBundle({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      lastRefresh: "2026-05-06T12:00:00.000Z",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      source: "stored-vault",
    });

    expect(resolveProviderDeploymentSecret("openai-codex", serialized)).toEqual({
      apiKey: "",
      authBundle: expect.objectContaining({
        accessToken: "access-token",
        refreshToken: "refresh-token",
      }),
    });
  });
});
