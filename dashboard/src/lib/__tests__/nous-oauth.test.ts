import {
  buildNousHermesAuthStore,
  buildNousPollCommand,
  buildNousStartCommand,
  buildNousStatusCommand,
  DEFAULT_NOUS_CLIENT_ID,
  DEFAULT_NOUS_INFERENCE_URL,
  DEFAULT_NOUS_PORTAL_URL,
  formatStoredNousSecretPreview,
  parseNousVaultBundle,
  readNousProviderLoggedInFlag,
  resolveNousDeploymentSecret,
  serializeNousVaultBundle,
  verifyNousPortalConnection,
  verifyNousSavedSession,
} from "@/lib/nous-oauth";

describe("nous-oauth helpers", () => {
  it("resolves the running container across the webui and webfree topologies", () => {
    for (const command of [
      buildNousStartCommand("inst_123", "1024:1024"),
      buildNousStatusCommand("inst_123", "1024:1024"),
      buildNousPollCommand("inst_123", "session-1", "1024:1024"),
    ]) {
      expect(command).toContain('docker exec -u "1024:1024" -i "$AGENT_CONTAINER"');
      expect(command).toContain(
        "for candidate_container in agent-inst_123 agent-inst_123-gateway; do"
      );
      expect(command).toContain(
        'docker inspect --format=\'{{.State.Running}}\' "$candidate_container"'
      );
      // classifyWebUINousStartFailure keys on this docker stderr to map the
      // failure to container_unavailable; the sentinel must stay intact.
      expect(command).toContain(
        'echo "Error response from daemon: No such container: agent-inst_123" >&2'
      );
      expect(command.indexOf('if [ -z "$AGENT_CONTAINER" ]; then')).toBeLessThan(
        command.indexOf("docker exec -u")
      );
    }
  });

  it("serializes and parses a reusable Nous Vault bundle", () => {
    const serialized = serializeNousVaultBundle({
      portalBaseUrl: "https://portal.nousresearch.com/",
      inferenceBaseUrl: "https://inference-api.nousresearch.com/v1/",
      clientId: "hermes-cli",
      accessToken: "access-123",
      refreshToken: "refresh-456",
      scope: "inference:mint_agent_key",
      tokenType: "Bearer",
      obtainedAt: "2026-04-22T10:00:00Z",
      expiresAt: "2026-04-22T11:00:00Z",
      expiresIn: 3600,
      tls: {
        insecure: false,
      },
      agentKey: "nk-live",
      agentKeyId: "key_123",
      agentKeyExpiresAt: "2026-04-23T10:00:00Z",
      agentKeyExpiresIn: 86400,
      agentKeyReused: false,
      agentKeyObtainedAt: "2026-04-22T10:00:05Z",
      label: "Primary Nous Portal",
      source: "dashboard-device-code",
    });

    expect(parseNousVaultBundle(serialized)).toEqual({
      portalBaseUrl: "https://portal.nousresearch.com",
      inferenceBaseUrl: "https://inference-api.nousresearch.com/v1",
      clientId: "hermes-cli",
      accessToken: "access-123",
      refreshToken: "refresh-456",
      scope: "inference:mint_agent_key",
      tokenType: "Bearer",
      obtainedAt: "2026-04-22T10:00:00Z",
      expiresAt: "2026-04-22T11:00:00Z",
      expiresIn: 3600,
      tls: {
        insecure: false,
        caBundle: undefined,
      },
      agentKey: "nk-live",
      agentKeyId: "key_123",
      agentKeyExpiresAt: "2026-04-23T10:00:00Z",
      agentKeyExpiresIn: 86400,
      agentKeyReused: false,
      agentKeyObtainedAt: "2026-04-22T10:00:05Z",
      label: "Primary Nous Portal",
      source: "dashboard-device-code",
    });
  });

  it("falls back to Hermes defaults for missing optional metadata", () => {
    const serialized = JSON.stringify({
      kind: "nous_oauth_bundle",
      version: 1,
      portal_base_url: `${DEFAULT_NOUS_PORTAL_URL}/`,
      inference_base_url: `${DEFAULT_NOUS_INFERENCE_URL}/`,
      client_id: "",
      access_token: "access-123",
      refresh_token: "refresh-456",
    });

    expect(parseNousVaultBundle(serialized)).toEqual({
      portalBaseUrl: DEFAULT_NOUS_PORTAL_URL,
      inferenceBaseUrl: DEFAULT_NOUS_INFERENCE_URL,
      clientId: DEFAULT_NOUS_CLIENT_ID,
      accessToken: "access-123",
      refreshToken: "refresh-456",
      scope: "inference:mint_agent_key",
      tokenType: "Bearer",
      obtainedAt: undefined,
      expiresAt: undefined,
      expiresIn: undefined,
      tls: undefined,
      agentKey: undefined,
      agentKeyId: undefined,
      agentKeyExpiresAt: undefined,
      agentKeyExpiresIn: undefined,
      agentKeyReused: undefined,
      agentKeyObtainedAt: undefined,
      label: undefined,
      source: undefined,
    });
  });

  it("shows a reusable preview for stored Nous OAuth bundles", () => {
    const serialized = serializeNousVaultBundle({
      portalBaseUrl: DEFAULT_NOUS_PORTAL_URL,
      inferenceBaseUrl: DEFAULT_NOUS_INFERENCE_URL,
      clientId: DEFAULT_NOUS_CLIENT_ID,
      accessToken: "access-123",
      refreshToken: "refresh-456",
    });

    expect(formatStoredNousSecretPreview(serialized)).toBe("OAuth session + agent key (reusable)");
    expect(formatStoredNousSecretPreview("")).toBe("Not connected");
  });

  it("builds a Hermes auth store payload for reusable Nous sessions", () => {
    const authStore = JSON.parse(
      buildNousHermesAuthStore({
        portalBaseUrl: DEFAULT_NOUS_PORTAL_URL,
        inferenceBaseUrl: DEFAULT_NOUS_INFERENCE_URL,
        clientId: DEFAULT_NOUS_CLIENT_ID,
        accessToken: "access-123",
        refreshToken: "refresh-456",
        obtainedAt: "2026-04-22T10:00:00Z",
        expiresAt: "2026-04-22T11:00:00Z",
        expiresIn: 3600,
        agentKey: "nk-live",
        agentKeyExpiresAt: "2026-04-23T10:00:00Z",
      })
    );

    expect(authStore.active_provider).toBe("nous");
    expect(authStore.providers.nous.portal_base_url).toBe(DEFAULT_NOUS_PORTAL_URL);
    expect(authStore.providers.nous.inference_base_url).toBe(DEFAULT_NOUS_INFERENCE_URL);
    expect(authStore.providers.nous.access_token).toBe("access-123");
    expect(authStore.providers.nous.refresh_token).toBe("refresh-456");
    expect(authStore.providers.nous.agent_key).toBe("nk-live");
    expect(authStore.providers.nous.tls.insecure).toBe(false);
  });

  it("keeps plain API keys unchanged until a bundle is present", () => {
    expect(resolveNousDeploymentSecret("nous-api-key")).toEqual({
      apiKey: "nous-api-key",
    });

    const serialized = serializeNousVaultBundle({
      portalBaseUrl: DEFAULT_NOUS_PORTAL_URL,
      inferenceBaseUrl: DEFAULT_NOUS_INFERENCE_URL,
      clientId: DEFAULT_NOUS_CLIENT_ID,
      accessToken: "access-123",
      refreshToken: "refresh-456",
    });

    expect(resolveNousDeploymentSecret(serialized)).toEqual({
      apiKey: "",
      authBundle: {
        portalBaseUrl: DEFAULT_NOUS_PORTAL_URL,
        inferenceBaseUrl: DEFAULT_NOUS_INFERENCE_URL,
        clientId: DEFAULT_NOUS_CLIENT_ID,
        accessToken: "access-123",
        refreshToken: "refresh-456",
        scope: "inference:mint_agent_key",
        tokenType: "Bearer",
        obtainedAt: undefined,
        expiresAt: undefined,
        expiresIn: undefined,
        tls: undefined,
        agentKey: undefined,
        agentKeyId: undefined,
        agentKeyExpiresAt: undefined,
        agentKeyExpiresIn: undefined,
        agentKeyReused: undefined,
        agentKeyObtainedAt: undefined,
        label: undefined,
        source: undefined,
      },
    });
  });

  it("retries Nous status verification until the saved session becomes readable", async () => {
    const readStatus = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          success: true,
          data: {
            authenticated: false,
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          success: true,
          data: {
            authenticated: true,
          },
        },
      });
    const waitForMs = jest.fn().mockResolvedValue(undefined);

    const payload = await verifyNousSavedSession({
      readStatus,
      retryDelaysMs: [0, 25],
      waitForMs,
    });

    expect(readStatus).toHaveBeenCalledTimes(2);
    expect(waitForMs).toHaveBeenCalledWith(25);
    expect(payload).toEqual({
      success: true,
      data: {
        authenticated: true,
      },
    });
  });

  it("surfaces a Vault persistence error immediately", async () => {
    await expect(
      verifyNousSavedSession({
        readStatus: async () => ({
          ok: true,
          payload: {
            success: true,
            data: {
              authenticated: true,
              persistenceError: "insert failed",
            },
          },
        }),
      })
    ).rejects.toThrow("Nous Portal connected on this agent, but reusable Vault save failed: insert failed");
  });

  it("reads Nous provider login state from the provider catalog payload", () => {
    expect(
      readNousProviderLoggedInFlag({
        success: true,
        data: {
          providers: [{ id: "nous", status: { logged_in: true } }],
        },
      })
    ).toBe(true);

    expect(
      readNousProviderLoggedInFlag({
        success: true,
        data: {
          providers: [{ id: "nous", status: { logged_in: false } }],
        },
      })
    ).toBe(false);
  });

  it("treats provider connection as success even when reusable-session export is not yet readable", async () => {
    const payload = await verifyNousPortalConnection({
      readProviderCatalog: async () => ({
        ok: true,
        payload: {
          success: true,
          data: {
            providers: [{ id: "nous", status: { logged_in: true } }],
          },
        },
      }),
      readSavedSessionStatus: async () => ({
        ok: true,
        payload: {
          success: true,
          data: {
            authenticated: false,
          },
        },
      }),
    });

    expect(payload).toEqual({
      providerPayload: {
        success: true,
        data: {
          providers: [{ id: "nous", status: { logged_in: true } }],
        },
      },
      savedSessionVerified: false,
    });
  });

  it("surfaces reusable-session persistence failures after provider login succeeds", async () => {
    await expect(
      verifyNousPortalConnection({
        readProviderCatalog: async () => ({
          ok: true,
          payload: {
            success: true,
            data: {
              providers: [{ id: "nous", status: { logged_in: true } }],
            },
          },
        }),
        readSavedSessionStatus: async () => ({
          ok: true,
          payload: {
            success: true,
            data: {
              authenticated: false,
              persistenceError: "insert failed",
            },
          },
        }),
      })
    ).rejects.toThrow(
      "Nous Portal connected on this agent, but reusable Vault save failed: insert failed"
    );
  });

  it("retries provider-catalog verification after a transient read failure", async () => {
    let attempts = 0;

    const payload = await verifyNousPortalConnection({
      readProviderCatalog: async () => {
        attempts += 1;

        if (attempts === 1) {
          throw new Error("temporary provider timeout");
        }

        return {
          ok: true,
          payload: {
            success: true,
            data: {
              providers: [{ id: "nous", status: { logged_in: true } }],
            },
          },
        };
      },
      retryDelaysMs: [0, 0],
    });

    expect(attempts).toBe(2);
    expect(payload).toEqual({
      providerPayload: {
        success: true,
        data: {
          providers: [{ id: "nous", status: { logged_in: true } }],
        },
      },
      savedSessionVerified: false,
    });
  });
});
