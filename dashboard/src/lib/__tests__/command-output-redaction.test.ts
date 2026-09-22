import { redactSensitiveCommandOutput } from "@/lib/command-output-redaction";

describe("redactSensitiveCommandOutput", () => {
  it("redacts common token and secret formats before logging", () => {
    const raw = [
      'refresh_token=super-secret',
      '"client_secret":"very-secret"',
      "Authorization: Bearer top-secret-token",
      "password=hunter2",
      "https://generativelanguage.googleapis.com/v1beta/models?key=gemini-secret&api_key=secondary-secret",
    ].join("\n");

    const redacted = redactSensitiveCommandOutput(raw);

    expect(redacted).toContain("refresh_token=[REDACTED]");
    expect(redacted).toContain('"client_secret":"[REDACTED]"');
    expect(redacted).toContain("Authorization: Bearer [REDACTED]");
    expect(redacted).toContain("password=[REDACTED]");
    expect(redacted).toContain("https://generativelanguage.googleapis.com/v1beta/models?key=[REDACTED]&api_key=[REDACTED]");
    expect(redacted).not.toContain("super-secret");
    expect(redacted).not.toContain("very-secret");
    expect(redacted).not.toContain("top-secret-token");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain("gemini-secret");
    expect(redacted).not.toContain("secondary-secret");
  });

  it("redacts generic secret-like values even when they are not key/value pairs", () => {
    const raw = [
      "db leaked sk-live-secret",
      "hosts-secret-leak",
      "upload-secret-leak",
      "super-secret",
    ].join("\n");

    const redacted = redactSensitiveCommandOutput(raw);

    expect(redacted).toContain("db leaked [REDACTED]");
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("sk-live-secret");
    expect(redacted).not.toContain("hosts-secret-leak");
    expect(redacted).not.toContain("upload-secret-leak");
    expect(redacted).not.toContain("super-secret");
  });

  it("redacts Tailscale auth keys from command output", () => {
    const raw = "tailscale up failed for tskey-auth-abcDEF123456";

    const redacted = redactSensitiveCommandOutput(raw);

    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("tskey-auth-abcDEF123456");
  });

  it("redacts agent-run reporter credentials wherever they appear", () => {
    const token = ["hvra_otlp_v1", "eyJ2IjoxLCJ1c2VySWQiOiJ1c2VyIn0", "c2lnbmF0dXJlLWZpeHR1cmU"].join("."); // synthetic, built at runtime
    const raw = [
      `reporter replayed ${token} after restart`,
      `HIVRA_ACTIVITY_TOKEN:${token}`,
      "truncated hvra_otlp_v1.eyJ2IjoxfQ",
    ].join("\n");

    const redacted = redactSensitiveCommandOutput(raw, 1000);

    expect(redacted).toBe([
      "reporter replayed [REDACTED] after restart",
      "HIVRA_ACTIVITY_TOKEN:[REDACTED]",
      "truncated [REDACTED]",
    ].join("\n"));
    expect(redacted).not.toContain("hvra_otlp_v1");
    expect(redacted).not.toContain("c2lnbmF0dXJlLWZpeHR1cmU");
  });

  it("redacts camelCase secret fields from JSON error bodies", () => {
    const raw = JSON.stringify({
      error: "forbidden",
      message: "partner scope does not allow wallet creation",
      apiKey: "bk_ptr_secret_that_must_not_be_logged",
      partnerKey: "partner-key-secret",
    });

    const redacted = redactSensitiveCommandOutput(raw);

    expect(redacted).toContain('"apiKey":"[REDACTED]"');
    expect(redacted).toContain('"partnerKey":"[REDACTED]"');
    expect(redacted).not.toContain("bk_ptr_secret_that_must_not_be_logged");
    expect(redacted).not.toContain("partner-key-secret");
  });
});
