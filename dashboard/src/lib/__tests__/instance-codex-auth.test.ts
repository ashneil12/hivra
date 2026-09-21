import { shouldAutoOpenCodexOAuth } from "@/lib/instance-codex-auth";

describe("shouldAutoOpenCodexOAuth", () => {
  it("opens the first-launch Codex OAuth flow for disconnected Codex agents", () => {
    expect(
      shouldAutoOpenCodexOAuth({
        provider: "codex",
        api_key_preview: "Not connected",
      })
    ).toBe(true);

    expect(
      shouldAutoOpenCodexOAuth({
        provider: "openai-codex",
        api_key_preview: "Not connected",
      })
    ).toBe(true);
  });

  it("does not interrupt agents that already have a reusable Codex session", () => {
    expect(
      shouldAutoOpenCodexOAuth({
        provider: "codex",
        api_key_preview: "OAuth session (reusable)",
      })
    ).toBe(false);
  });

  it("does not open Codex OAuth for non-Codex providers", () => {
    expect(
      shouldAutoOpenCodexOAuth({
        provider: "nous",
        api_key_preview: "Not connected",
      })
    ).toBe(false);
  });
});
