// Deterministic 32-byte key so the secret round-trip below can actually
// encrypt/decrypt (crypto.ts throws without it). Mirrors src/__tests__/crypto.test.ts.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "a".repeat(64);

import {
  buildAdvancedInstanceConfigPayload,
  getPublicInstanceConfig,
  getRuntimeAgentSettings,
} from "@/lib/instance-settings";

describe("instance settings", () => {
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
