import {
  buildManagedVeniceRemoteConfig,
  buildManagedVeniceRuntimeEnvUpdates,
  buildManagedVeniceStoredInstanceConfig,
  buildVeniceByokRemoteConfig,
  buildVeniceByokRuntimeEnvUpdates,
  buildVeniceByokStoredInstanceConfig,
  disableManagedVeniceForWebUIInstance,
  enableManagedVeniceForWebUIInstance,
  ManagedVeniceEnableError,
} from "../managed-webui-enable";
import { encryptApiKey } from "@/lib/crypto";

const TEST_ENCRYPTION_KEY = "a".repeat(64);

function buildHermesInstancesDb(instance: Record<string, unknown>) {
  const updates: Record<string, unknown>[] = [];
  const selectQuery: Record<string, jest.Mock> = {};
  selectQuery.eq = jest.fn(() => selectQuery);
  selectQuery.neq = jest.fn(() => selectQuery);
  selectQuery.single = jest.fn(async () => ({ data: instance, error: null }));

  const table = {
    select: jest.fn(() => selectQuery),
    update: jest.fn((payload: Record<string, unknown>) => {
      updates.push(payload);
      const updateQuery: Record<string, jest.Mock> = {};
      updateQuery.eq = jest.fn(() => updateQuery);
      updateQuery.select = jest.fn(() => ({
        single: jest.fn(async () => ({
          data: { ...instance, ...payload },
          error: null,
        })),
      }));
      return updateQuery;
    }),
  };

  return {
    db: {
      from: jest.fn((name: string) => {
        if (name !== "hermes_instances") {
          throw new Error(`Unexpected table: ${name}`);
        }
        return table;
      }),
    },
    table,
    updates,
  };
}

describe("managed Venice WebUI enablement helpers", () => {
  const proxyBaseUrl = "https://app.hermesos.test/api/managed-venice/v1";

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  });

  it("builds a live WebUI env patch that points Venice traffic at Hivra billing", () => {
    const env = buildManagedVeniceRuntimeEnvUpdates({
      proxyKey: "hven_live_proxy_key",
      proxyBaseUrl,
      model: "glm-5.1",
      dashboardEnableUrl: "https://app.hermesos.test/dashboard/billing?managedVenice=deposit",
    });

    expect(env).toMatchObject({
      HERMES_INFERENCE_PROVIDER: "custom",
      OPENAI_API_KEY: "hven_live_proxy_key",
      OPENAI_BASE_URL: proxyBaseUrl,
      // Venice key must also be exposed under the host-derived env name or
      // resumed sessions resolve "no-key-required" and 401.
      VENICE_API_KEY: "hven_live_proxy_key",
      VENICE_BASE_URL: proxyBaseUrl,
      // HERMES_MODEL must be scrubbed ("") not pinned — config.yaml owns the model.
      // A pin re-detects a native keyless provider from the model name and bricks chat (#204).
      HERMES_MODEL: "",
      HERMES_WEBUI_DEFAULT_MODEL: "glm-5.1",
      HERMES_MANAGED_VENICE_ENABLE_URL:
        "https://app.hermesos.test/dashboard/billing?managedVenice=deposit",
      OPENROUTER_API_KEY: "",
      ANTHROPIC_API_KEY: "",
    });
  });

  it("stores managed Venice metadata without dropping existing instance settings", () => {
    const currentConfig = {
      model: "old-model",
      agentSettings: {
        runtimeMode: "managed",
        tavilyApiKeyEncrypted: "enc:tavily",
      },
      existing: true,
    };

    const nextConfig = buildManagedVeniceStoredInstanceConfig(currentConfig, {
      walletType: "hermesos",
      model: "glm-5.1",
      proxyBaseUrl,
      proxyKeyId: "key_123",
      keyPrefix: "hven_live_abcd",
      enabledAt: "2026-05-16T12:00:00.000Z",
    });

    expect(nextConfig).toMatchObject({
      existing: true,
      model: "glm-5.1",
      agentSettings: {
        runtimeMode: "managed",
        tavilyApiKeyEncrypted: "enc:tavily",
        customLlmBaseUrl: proxyBaseUrl,
      },
      managedVenice: {
        enabled: true,
        walletType: "hermesos",
        proxyBaseUrl,
        proxyKeyId: "key_123",
        keyPrefix: "hven_live_abcd",
        enabledAt: "2026-05-16T12:00:00.000Z",
      },
    });
    expect(currentConfig.agentSettings).not.toHaveProperty("customLlmBaseUrl");
  });

  it("writes Hermes Web config as an OpenAI-compatible custom endpoint", () => {
    const remoteConfig = buildManagedVeniceRemoteConfig(
      {
        model_context_length: 8192,
        toolsets: ["hermes-cli"],
        model: {
          provider: "venice",
          default: "old-model",
        },
      },
      {
        model: "glm-5.1",
        proxyBaseUrl,
      }
    );

    expect(remoteConfig).toMatchObject({
      toolsets: ["hermes-cli"],
      model: {
        provider: "custom",
        default: "glm-5.1",
        base_url: proxyBaseUrl,
        context_length: 8192,
      },
    });
  });

  it("issues a user-scoped proxy key, saves it, and applies it to a running WebUI agent", async () => {
    const { db, updates } = buildHermesInstancesDb({
      id: "inst_123",
      user_id: "user_123",
      name: "Ada",
      status: "running",
      backend: "webui",
      provider: "openrouter",
      gateway_url: "https://ada.example.test",
      api_key_encrypted: null,
      config: {
        model: "old-model",
        agentSettings: { runtimeMode: "managed" },
      },
    });
    const createProxyKey = jest.fn(async () => ({
      id: "key_123",
      accountId: "acct_123",
      userId: "user_123",
      name: "Ada managed Venice",
      keyPrefix: "hven_live_new",
      status: "active" as const,
      pausedReason: null,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: "2026-05-16T12:00:00.000Z",
      updatedAt: "2026-05-16T12:00:00.000Z",
      defaultWalletType: "hermesos" as const,
      plaintextKey: "hven_live_new_proxy_key",
    }));
    const putConfig = jest.fn(async () => ({ ok: true }));
    const ssh = jest.fn(async (ip: string, command: string) => {
      void ip;
      void command;
      return {
        ok: true,
        stdout: "",
        stderr: "",
      };
    });
    const api = {
      baseUrl: "https://ada.example.test/web-api",
      get: jest.fn(async () => new Response(JSON.stringify({ model: { provider: "openrouter" } }))),
      post: jest.fn(),
      put: jest.fn(),
      del: jest.fn(),
    };

    const result = await enableManagedVeniceForWebUIInstance(
      {
        instanceId: "inst_123",
        userId: "user_123",
        walletType: "hermesos",
        model: "glm-5.1",
      },
      {
        db,
        proxyBaseUrl,
        dashboardEnableUrl: "https://app.hermesos.test/dashboard/billing?managedVenice=deposit",
        now: () => new Date("2026-05-16T12:00:00.000Z"),
        createProxyKey,
        getSecureInstance: jest.fn(async () => ({
          instance: {
            id: "inst_123",
            user_id: "user_123",
            status: "running",
            gateway_url: "https://ada.example.test",
            api_server_key_encrypted: "encrypted-api-server-key",
          },
          apiServerKey: "api_server_secret",
          instanceIpv4: "10.240.0.5",
          error: null,
        })),
        agentWebApiFactory: jest.fn(async () => api),
        putConfig,
        ssh,
      }
    );

    expect(createProxyKey).toHaveBeenCalledWith({
      userId: "user_123",
      name: "Ada managed Venice",
      defaultWalletType: "hermesos",
    });
    expect(updates[0]).toMatchObject({
      provider: "venice",
      config: {
        model: "glm-5.1",
        managedVenice: {
          enabled: true,
          walletType: "hermesos",
          proxyBaseUrl,
          proxyKeyId: "key_123",
        },
        agentSettings: {
          runtimeMode: "managed",
          customLlmBaseUrl: proxyBaseUrl,
        },
      },
    });
    expect(putConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        ip: "10.240.0.5",
        config: expect.objectContaining({
          model: expect.objectContaining({
            provider: "custom",
            default: "glm-5.1",
            base_url: proxyBaseUrl,
          }),
        }),
      })
    );
    expect(String(ssh.mock.calls[0][1])).toContain("docker compose up -d --force-recreate");
    expect(result).toMatchObject({
      applied: true,
      applyError: null,
      managedVenice: {
        enabled: true,
        walletType: "hermesos",
        keyPrefix: "hven_live_new_",
      },
    });
  });

  it("reuses an existing managed Venice proxy key for the same wallet type", async () => {
    const existingKey = "hven_live_existing_proxy_key";
    const { db } = buildHermesInstancesDb({
      id: "inst_123",
      user_id: "user_123",
      name: "Ada",
      status: "running",
      backend: "webui",
      provider: "venice",
      gateway_url: "https://ada.example.test",
      api_key_encrypted: encryptApiKey(existingKey),
      config: {
        model: "glm-5.1",
        managedVenice: {
          enabled: true,
          walletType: "card",
        },
        agentSettings: { customLlmBaseUrl: proxyBaseUrl },
      },
    });
    const createProxyKey = jest.fn();

    await enableManagedVeniceForWebUIInstance(
      {
        instanceId: "inst_123",
        userId: "user_123",
        walletType: "card",
        apply: false,
      },
      {
        db,
        proxyBaseUrl,
        createProxyKey,
        now: () => new Date("2026-05-16T12:00:00.000Z"),
      }
    );

    expect(createProxyKey).not.toHaveBeenCalled();
  });
});

describe("managed Venice → BYOK switch helpers", () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  });

  it("builds env updates that route directly at api.venice.ai and clear the managed top-up URL", () => {
    const env = buildVeniceByokRuntimeEnvUpdates({
      apiKey: "vk_live_user_byok",
      model: "deepseek-v4-pro",
    });

    expect(env).toMatchObject({
      HERMES_INFERENCE_PROVIDER: "custom",
      OPENAI_API_KEY: "vk_live_user_byok",
      OPENAI_BASE_URL: "https://api.venice.ai/api/v1",
      VENICE_API_KEY: "vk_live_user_byok",
      VENICE_BASE_URL: "https://api.venice.ai/api/v1",
      // HERMES_MODEL scrubbed ("") not pinned: "deepseek-v4-pro" would otherwise
      // re-detect to native deepseek (keyless) and brick. config.yaml owns the model (#204).
      HERMES_MODEL: "",
      HERMES_WEBUI_DEFAULT_MODEL: "deepseek-v4-pro",
      // Empty string = remove this line from .env. Critical: without this
      // hermes-agent keeps surfacing the "top up managed credits" nudge
      // to WebUI after the switch.
      HERMES_MANAGED_VENICE_ENABLE_URL: "",
      // Provider reset baseline so a previous custom base URL never leaks
      // into the new BYOK call.
      OPENROUTER_API_KEY: "",
      ANTHROPIC_API_KEY: "",
    });
  });

  it("drops managedVenice + agentSettings.customLlmBaseUrl while preserving other config", () => {
    const currentConfig = {
      model: "old-model",
      agentSettings: {
        runtimeMode: "managed",
        customLlmBaseUrl: "https://app.hermesos.test/api/managed-venice/v1",
        tavilyApiKeyEncrypted: "enc:tavily",
      },
      managedVenice: {
        enabled: true,
        walletType: "hermesos",
        proxyKeyId: "key_123",
      },
      honcho: { enabled: false },
    };

    const nextConfig = buildVeniceByokStoredInstanceConfig(currentConfig, {
      model: "deepseek-v4-pro",
    });

    expect(nextConfig).toMatchObject({
      model: "deepseek-v4-pro",
      agentSettings: {
        runtimeMode: "managed",
        tavilyApiKeyEncrypted: "enc:tavily",
      },
      honcho: { enabled: false },
    });
    expect(nextConfig).not.toHaveProperty("managedVenice");
    expect((nextConfig.agentSettings as Record<string, unknown>)).not.toHaveProperty(
      "customLlmBaseUrl"
    );
  });

  it("writes the agent's remote config to point at direct Venice", () => {
    const remoteConfig = buildVeniceByokRemoteConfig(
      {
        model_context_length: 16384,
        toolsets: ["hermes-cli"],
        model: {
          provider: "custom",
          default: "old-model",
          base_url: "https://app.hermesos.test/api/managed-venice/v1",
        },
      },
      { model: "deepseek-v4-pro" }
    );

    expect(remoteConfig).toMatchObject({
      toolsets: ["hermes-cli"],
      model: {
        provider: "custom",
        default: "deepseek-v4-pro",
        base_url: "https://api.venice.ai/api/v1",
        context_length: 16384,
      },
    });
  });

  it("rejects a hven_live_* key as BYOK input so the user doesn't pin themselves to managed again", async () => {
    const { db } = buildHermesInstancesDb({
      id: "inst_123",
      user_id: "user_123",
      name: "Ada",
      status: "running",
      backend: "webui",
      provider: "venice",
      api_key_encrypted: encryptApiKey("hven_live_old_proxy"),
      config: {
        model: "deepseek-v4-pro",
        managedVenice: { enabled: true, walletType: "hermesos", proxyKeyId: "key_existing" },
        agentSettings: { customLlmBaseUrl: "https://app.hermesos.test/api/managed-venice/v1" },
      },
    });

    await expect(
      disableManagedVeniceForWebUIInstance(
        {
          instanceId: "inst_123",
          userId: "user_123",
          apiKey: "hven_live_user_thought_this_was_their_key",
          apply: false,
        },
        { db }
      )
    ).rejects.toMatchObject({
      status: 400,
      failureType: "managed_venice_byok_key_invalid_shape",
    } as Partial<ManagedVeniceEnableError>);
  });

  it("revokes the existing managed proxy key and persists BYOK config", async () => {
    const { db, updates } = buildHermesInstancesDb({
      id: "inst_123",
      user_id: "user_123",
      name: "Ada",
      status: "stopped",
      backend: "webui",
      provider: "venice",
      api_key_encrypted: encryptApiKey("hven_live_old_proxy"),
      config: {
        model: "deepseek-v4-pro",
        managedVenice: {
          enabled: true,
          walletType: "hermesos",
          proxyKeyId: "key_existing",
        },
        agentSettings: {
          runtimeMode: "managed",
          customLlmBaseUrl: "https://app.hermesos.test/api/managed-venice/v1",
        },
      },
    });
    const revokeProxyKey = jest.fn(async () => ({
      revoked: true,
      key: {
        id: "key_existing",
        accountId: "acct_123",
        userId: "user_123",
        name: "Ada managed Venice",
        keyPrefix: "hven_live_old",
        status: "revoked" as const,
        pausedReason: null,
        lastUsedAt: null,
        revokedAt: "2026-05-19T00:00:00.000Z",
        createdAt: "2026-05-10T00:00:00.000Z",
        updatedAt: "2026-05-19T00:00:00.000Z",
        defaultWalletType: "hermesos" as const,
      },
    }));

    const result = await disableManagedVeniceForWebUIInstance(
      {
        instanceId: "inst_123",
        userId: "user_123",
        apiKey: "vk_live_user_byok",
        apply: false,
      },
      {
        db,
        revokeProxyKey,
        now: () => new Date("2026-05-19T12:00:00.000Z"),
      }
    );

    expect(revokeProxyKey).toHaveBeenCalledWith({
      userId: "user_123",
      keyId: "key_existing",
    });
    expect(updates[0]).toMatchObject({
      provider: "venice",
      config: {
        model: "deepseek-v4-pro",
        agentSettings: { runtimeMode: "managed" },
      },
    });
    expect((updates[0].config as Record<string, unknown>)).not.toHaveProperty("managedVenice");
    expect(
      ((updates[0].config as Record<string, unknown>).agentSettings as Record<string, unknown>)
    ).not.toHaveProperty("customLlmBaseUrl");
    expect(result).toMatchObject({
      applied: false,
      // apply=false → we never tried to push to the VM, so applyError is null.
      // The runtime warning ("agent not running") only appears when apply is
      // attempted on a non-running instance.
      applyError: null,
      byokVenice: {
        enabled: true,
        previouslyManagedProxyKeyId: "key_existing",
      },
    });
  });

  it("rejects a stopped instance that was never on managed Venice", async () => {
    const { db } = buildHermesInstancesDb({
      id: "inst_123",
      user_id: "user_123",
      name: "Ada",
      status: "running",
      backend: "webui",
      provider: "venice",
      api_key_encrypted: encryptApiKey("vk_existing_byok"),
      config: { model: "deepseek-v4-pro" },
    });

    await expect(
      disableManagedVeniceForWebUIInstance(
        {
          instanceId: "inst_123",
          userId: "user_123",
          apiKey: "vk_live_user_byok",
          apply: false,
        },
        { db }
      )
    ).rejects.toMatchObject({
      status: 400,
      failureType: "managed_venice_byok_not_enabled",
    } as Partial<ManagedVeniceEnableError>);
  });

  it("releases a box pinned to managed Venice by the hven_ key with no config.managedVenice marker (the real fleet state)", async () => {
    // The customer provision path never wrote config.managedVenice (0 of 181
    // prod rows ever had it), so the marker-only gate used to reject every real
    // managed box. The off-ramp must instead detect managed state from the
    // stored hven_ proxy key (and/or the managed-proxy customLlmBaseUrl).
    const { db, updates } = buildHermesInstancesDb({
      id: "inst_777",
      user_id: "user_777",
      name: "Ada",
      status: "stopped",
      backend: "webui",
      provider: "venice",
      api_key_encrypted: encryptApiKey("hven_live_fleet_proxy_key"),
      config: {
        model: "deepseek-v4-flash",
        agentSettings: {
          customLlmBaseUrl: "https://hivra.cloud/api/managed-venice/v1",
        },
      },
    });
    const revokeProxyKey = jest.fn();

    const result = await disableManagedVeniceForWebUIInstance(
      {
        instanceId: "inst_777",
        userId: "user_777",
        apiKey: "vk_live_user_byok",
        apply: false,
      },
      { db, revokeProxyKey, now: () => new Date("2026-06-25T12:00:00.000Z") }
    );

    // No proxyKeyId recorded in config → nothing to revoke, but the off-ramp
    // must still run (re-keying the row stops the old key being looked up).
    expect(revokeProxyKey).not.toHaveBeenCalled();
    expect(updates[0]).toMatchObject({
      provider: "venice",
      config: { model: "deepseek-v4-flash" },
    });
    expect(updates[0].config as Record<string, unknown>).not.toHaveProperty("managedVenice");
    expect(
      (updates[0].config as Record<string, unknown>).agentSettings as Record<string, unknown>
    ).not.toHaveProperty("customLlmBaseUrl");
    expect(result).toMatchObject({
      applied: false,
      applyError: null,
      byokVenice: { enabled: true, previouslyManagedProxyKeyId: null },
    });
  });
});
