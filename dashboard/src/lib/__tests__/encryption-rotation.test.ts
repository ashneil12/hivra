type RotationStoreModule = typeof import("@/lib/encryption-rotation");
type CryptoModule = typeof import("@/lib/crypto");
type ChatCryptoModule = typeof import("@/lib/chat-crypto");

const OLD_SECRET_KEY = "1".repeat(64);
const NEW_SECRET_KEY = "2".repeat(64);
const NEW_CHAT_KEY = "3".repeat(64);
type AdditionalSurface = "hivra_agents_llm" | "infrastructure_capacity_orders_bootstrap"
  | "bankr_deposit_wallet_credentials_key" | "instance_bankr_wallets_key";

type TestRowCollections = {
  vaultKeys: Array<{ id: string; encrypted_key: string }>;
  infrastructureSecrets?: Array<{
    connection_id: string;
    encrypted_bundle: string;
    key_version: number;
  }>;
  instances: Array<{
    id: string;
    api_key_encrypted: string | null;
    api_server_key_encrypted: string | null;
    honcho_api_key_encrypted: string | null;
    config: Record<string, unknown>;
  }>;
  conversations: Array<{ id: string; title: string | null }>;
  messages: Array<{
    id: string;
    content: string | null;
    tool_calls: unknown;
    attachments: unknown;
    artifacts: unknown;
    metadata: unknown;
  }>;
  additionalSecrets?: Partial<Record<AdditionalSurface, Array<{id:string;encrypted_value:string|null}>>>;
  chatStreamJobs?: Array<{id:string;stream_request:unknown;fallback_request:unknown}>;
};

function makePagedStore(rows: TestRowCollections) {
  const updates = {
    vaultKeys: [] as Array<{ id: string; patch: Record<string, unknown> }>,
    infrastructureSecrets: [] as Array<{
      id: string;
      expected: string;
      patch: Record<string, unknown>;
    }>,
    instances: [] as Array<{ id: string; patch: Record<string, unknown> }>,
    conversations: [] as Array<{ id: string; patch: Record<string, unknown> }>,
    messages: [] as Array<{ id: string; patch: Record<string, unknown> }>,
    additionalSecrets: [] as Array<{ surface: AdditionalSurface; id: string; encryptedValue: string }>,
    chatStreamJobs: [] as Array<{ id: string; patch: Record<string, unknown> }>,
  };

  const pageRows = <T extends { id?: string; connection_id?: string }>(items: T[], afterId: string | null, limit: number) =>
    items.filter(item => (item.id ?? item.connection_id ?? "") > (afterId ?? "")).slice(0, limit)
      .map(item => structuredClone(item));

  return {
    rows,
    updates,
    store: {
      async countUnhandledValues() { return 0; },
      async listVaultKeys(afterId: string | null, limit: number) {
        return pageRows(rows.vaultKeys, afterId, limit);
      },
      async updateVaultKey(expected: TestRowCollections["vaultKeys"][number], patch: Record<string, unknown>) {
        updates.vaultKeys.push({ id: expected.id, patch });
        const row = rows.vaultKeys.find((item) => item.id === expected.id);
        if (!row || JSON.stringify(row) !== JSON.stringify(expected)) return false;
        Object.assign(row, patch); return true;
      },
      async listInfrastructureConnectionSecrets(afterId: string | null, limit: number) {
        return pageRows(rows.infrastructureSecrets ?? [], afterId, limit);
      },
      async updateInfrastructureConnectionSecret(
        id: string,
        expected: string,
        patch: Record<string, unknown>,
      ) {
        updates.infrastructureSecrets.push({ id, expected, patch });
        const row = rows.infrastructureSecrets?.find((item) => item.connection_id === id);
        if (!row || row.encrypted_bundle !== expected) return false;
        Object.assign(row, patch);
        return true;
      },
      async listInstances(afterId: string | null, limit: number) {
        return pageRows(rows.instances, afterId, limit);
      },
      async updateInstance(expected: TestRowCollections["instances"][number], patch: Record<string, unknown>) {
        updates.instances.push({ id: expected.id, patch });
        const row = rows.instances.find((item) => item.id === expected.id);
        if (!row || JSON.stringify(row) !== JSON.stringify(expected)) return false;
        Object.assign(row, patch); return true;
      },
      async listAdditionalSecrets(surface: AdditionalSurface, afterId: string | null, limit: number) {
        return pageRows(rows.additionalSecrets?.[surface] ?? [], afterId, limit);
      },
      async updateAdditionalSecret(surface: AdditionalSurface, expected: {id:string;encrypted_value:string|null}, encryptedValue: string) {
        updates.additionalSecrets.push({ surface, id: expected.id, encryptedValue });
        const row = rows.additionalSecrets?.[surface]?.find(item => item.id === expected.id);
        if (!row || JSON.stringify(row) !== JSON.stringify(expected)) return false;
        row.encrypted_value = encryptedValue; return true;
      },
      async listConversations(afterId: string | null, limit: number) {
        return pageRows(rows.conversations, afterId, limit);
      },
      async updateConversation(expected: TestRowCollections["conversations"][number], patch: Record<string, unknown>) {
        updates.conversations.push({ id: expected.id, patch });
        const row = rows.conversations.find((item) => item.id === expected.id);
        if (!row || JSON.stringify(row) !== JSON.stringify(expected)) return false;
        Object.assign(row, patch); return true;
      },
      async listMessages(afterId: string | null, limit: number) {
        return pageRows(rows.messages, afterId, limit);
      },
      async updateMessage(expected: TestRowCollections["messages"][number], patch: Record<string, unknown>) {
        updates.messages.push({ id: expected.id, patch });
        const row = rows.messages.find((item) => item.id === expected.id);
        if (!row || JSON.stringify(row) !== JSON.stringify(expected)) return false;
        Object.assign(row, patch); return true;
      },
      async listChatStreamJobs(afterId: string | null, limit: number) {
        return pageRows(rows.chatStreamJobs ?? [], afterId, limit);
      },
      async updateChatStreamJob(expected: {id:string;stream_request:unknown;fallback_request:unknown}, patch: Record<string, unknown>) {
        updates.chatStreamJobs.push({ id: expected.id, patch });
        const row = rows.chatStreamJobs?.find(item => item.id === expected.id);
        if (!row || JSON.stringify(row) !== JSON.stringify(expected)) return false;
        Object.assign(row, patch); return true;
      },
    },
  };
}

describe("encryption rotation runner", () => {
  let cryptoModule: CryptoModule;
  let chatCryptoModule: ChatCryptoModule;
  let rotationModule: RotationStoreModule;

  beforeEach(async () => {
    jest.resetModules();
    process.env.ENCRYPTION_KEY = OLD_SECRET_KEY;
    delete process.env.ENCRYPTION_KEY_LEGACY;
    delete process.env.CHAT_ENCRYPTION_KEY;
    delete process.env.CHAT_ENCRYPTION_KEY_LEGACY;

    cryptoModule = await import("@/lib/crypto");
    chatCryptoModule = await import("@/lib/chat-crypto");
    rotationModule = await import("@/lib/encryption-rotation");
  });

  afterEach(() => {
    delete process.env.ENCRYPTION_KEY_LEGACY;
    delete process.env.CHAT_ENCRYPTION_KEY;
    delete process.env.CHAT_ENCRYPTION_KEY_LEGACY;
  });

  it("defaults to a read-only inspection when no options are supplied", async () => {
    const encrypted = cryptoModule.encryptSecret("synthetic-existing-secret");
    process.env.ENCRYPTION_KEY = NEW_SECRET_KEY;
    process.env.ENCRYPTION_KEY_LEGACY = OLD_SECRET_KEY;
    const paged = makePagedStore({
      vaultKeys: [{ id: "vault-default", encrypted_key: encrypted }],
      instances: [], conversations: [], messages: [],
    });

    const summary = await rotationModule.runEncryptionKeyRotation(paged.store);

    expect(summary.dryRun).toBe(true);
    expect(summary.updatesApplied).toBe(0);
    expect(paged.updates.vaultKeys).toEqual([]);
    expect(paged.rows.vaultKeys[0].encrypted_key).toBe(encrypted);
    expect(rotationModule.formatRotationSummary(summary)).not.toContain("Completed encryption rotation");
  });

  it("reports migration counts in dry-run mode without writing", async () => {
    const legacyVaultKey = cryptoModule.encryptApiKey("vault-secret");
    const legacyInfrastructureSecret = cryptoModule.encryptSecret("infrastructure-secret");
    const legacyInstanceKey = cryptoModule.encryptApiKey("instance-secret");
    const legacyGatewayKey = cryptoModule.encryptApiKey("gateway-secret");
    const legacyHonchoKey = cryptoModule.encryptApiKey("honcho-secret");
    const legacyTavilyKey = cryptoModule.encryptApiKey("tvly-secret");
    const legacyMemoryKey = cryptoModule.encryptApiKey("memory-secret");
    const legacyTitle = chatCryptoModule.encryptStoredChatText("Existing chat");
    const legacyMessage = chatCryptoModule.encryptStoredChatText("Encrypted message");
    const legacyMetadata = chatCryptoModule.encryptStoredChatJson({ hidden: true });

    process.env.ENCRYPTION_KEY = NEW_SECRET_KEY;
    process.env.ENCRYPTION_KEY_LEGACY = OLD_SECRET_KEY;
    process.env.CHAT_ENCRYPTION_KEY = NEW_CHAT_KEY;
    process.env.CHAT_ENCRYPTION_KEY_LEGACY = OLD_SECRET_KEY;

    const { store, updates } = makePagedStore({
      vaultKeys: [{ id: "vault-1", encrypted_key: legacyVaultKey }],
      infrastructureSecrets: [
        {
          connection_id: "connection-1",
          encrypted_bundle: legacyInfrastructureSecret,
          key_version: 1,
        },
      ],
      instances: [
        {
          id: "inst-1",
          api_key_encrypted: legacyInstanceKey,
          api_server_key_encrypted: legacyGatewayKey,
          honcho_api_key_encrypted: legacyHonchoKey,
          config: {
            agentSettings: {
              tavilyApiKeyEncrypted: legacyTavilyKey,
            },
            memorySystem: {
              provider: "honcho",
              honchoApiKeyEncrypted: legacyMemoryKey,
            },
          },
        },
      ],
      conversations: [{ id: "conv-1", title: legacyTitle }],
      messages: [
        {
          id: "msg-1",
          content: legacyMessage,
          tool_calls: null,
          attachments: [],
          artifacts: [],
          metadata: legacyMetadata,
        },
      ],
    });

    const summary = await rotationModule.runEncryptionKeyRotation(store, {
      dryRun: true,
      batchSize: 1,
    });

    expect(summary.surfaces.userApiKeys.migratedLegacy).toBe(1);
    expect(summary.surfaces.infrastructureConnectionSecrets.migratedLegacy).toBe(1);
    expect(summary.surfaces.instanceApiKeys.migratedLegacy).toBe(1);
    expect(summary.surfaces.instanceApiServerKeys.migratedLegacy).toBe(1);
    expect(summary.surfaces.instanceHonchoKeys.migratedLegacy).toBe(1);
    expect(summary.surfaces.instanceAgentSettings.migratedLegacy).toBe(1);
    expect(summary.surfaces.instanceMemorySystem.migratedLegacy).toBe(1);
    expect(summary.surfaces.conversationTitles.migratedLegacy).toBe(1);
    expect(summary.surfaces.messageContent.migratedLegacy).toBe(1);
    expect(summary.surfaces.messageMetadata.migratedLegacy).toBe(1);
    expect(summary.surfaces.messageAttachments.plaintextEncrypted).toBe(1);
    expect(summary.surfaces.messageArtifacts.plaintextEncrypted).toBe(1);
    expect(summary.updatesApplied).toBe(0);
    expect(updates.vaultKeys).toHaveLength(0);
    expect(updates.infrastructureSecrets).toHaveLength(0);
    expect(updates.instances).toHaveLength(0);
    expect(updates.conversations).toHaveLength(0);
    expect(updates.messages).toHaveLength(0);
  });

  it("migrates legacy rows once and is idempotent on the second pass", async () => {
    const legacyVaultKey = cryptoModule.encryptApiKey("vault-secret");
    const legacyInfrastructureSecret = cryptoModule.encryptSecret("infrastructure-secret");
    const legacyInstanceKey = cryptoModule.encryptApiKey("instance-secret");
    const legacyGatewayKey = cryptoModule.encryptApiKey("gateway-secret");
    const legacyHonchoKey = cryptoModule.encryptApiKey("honcho-secret");
    const legacyTavilyKey = cryptoModule.encryptApiKey("tvly-secret");
    const legacyMemoryKey = cryptoModule.encryptApiKey("memory-secret");
    const legacyTitle = chatCryptoModule.encryptStoredChatText("Existing chat");
    const legacyMessage = chatCryptoModule.encryptStoredChatText("Encrypted message");
    const legacyMetadata = chatCryptoModule.encryptStoredChatJson({ hidden: true });

    process.env.ENCRYPTION_KEY = NEW_SECRET_KEY;
    process.env.ENCRYPTION_KEY_LEGACY = OLD_SECRET_KEY;
    process.env.CHAT_ENCRYPTION_KEY = NEW_CHAT_KEY;
    process.env.CHAT_ENCRYPTION_KEY_LEGACY = OLD_SECRET_KEY;

    const paged = makePagedStore({
      vaultKeys: [{ id: "vault-1", encrypted_key: legacyVaultKey }],
      infrastructureSecrets: [
        {
          connection_id: "connection-1",
          encrypted_bundle: legacyInfrastructureSecret,
          key_version: 1,
        },
      ],
      instances: [
        {
          id: "inst-1",
          api_key_encrypted: legacyInstanceKey,
          api_server_key_encrypted: legacyGatewayKey,
          honcho_api_key_encrypted: legacyHonchoKey,
          config: {
            agentSettings: {
              tavilyApiKeyEncrypted: legacyTavilyKey,
            },
            memorySystem: {
              provider: "honcho",
              honchoApiKeyEncrypted: legacyMemoryKey,
            },
          },
        },
      ],
      conversations: [{ id: "conv-1", title: legacyTitle }],
      messages: [
        {
          id: "msg-1",
          content: "Legacy plaintext content",
          tool_calls: null,
          attachments: [{ name: "brief.md" }],
          artifacts: [{ id: "artifact-1" }],
          metadata: legacyMetadata,
        },
        {
          id: "msg-2",
          content: legacyMessage,
          tool_calls: [{ id: "tool-1" }],
          attachments: [],
          artifacts: [],
          metadata: { usage: { total_tokens: 42 } },
        },
      ],
    });

    const firstRun = await rotationModule.runEncryptionKeyRotation(paged.store, {
      dryRun: false,
      batchSize: 1,
    });

    expect(firstRun.updatesApplied).toBeGreaterThan(0);
    expect(firstRun.surfaces.messageContent.plaintextEncrypted).toBe(1);
    expect(firstRun.surfaces.messageContent.migratedLegacy).toBe(1);
    expect(firstRun.surfaces.messageToolCalls.plaintextEncrypted).toBe(1);
    expect(firstRun.surfaces.messageAttachments.plaintextEncrypted).toBe(2);
    expect(firstRun.surfaces.messageArtifacts.plaintextEncrypted).toBe(2);
    expect(firstRun.surfaces.messageMetadata.plaintextEncrypted).toBe(1);
    expect(firstRun.surfaces.messageMetadata.migratedLegacy).toBe(1);

    const secondRun = await rotationModule.runEncryptionKeyRotation(paged.store, {
      dryRun: false,
      batchSize: 1,
    });

    expect(secondRun.surfaces.userApiKeys.migratedLegacy).toBe(0);
    expect(secondRun.surfaces.userApiKeys.alreadyPrimary).toBe(1);
    expect(secondRun.surfaces.infrastructureConnectionSecrets.alreadyPrimary).toBe(1);
    expect(secondRun.surfaces.instanceApiKeys.alreadyPrimary).toBe(1);
    expect(secondRun.surfaces.instanceAgentSettings.alreadyPrimary).toBe(1);
    expect(secondRun.surfaces.conversationTitles.alreadyPrimary).toBe(1);
    expect(secondRun.surfaces.messageContent.alreadyPrimary).toBe(2);
    expect(secondRun.surfaces.messageToolCalls.alreadyPrimary).toBe(1);
    expect(secondRun.surfaces.messageMetadata.alreadyPrimary).toBe(2);
    expect(secondRun.updatesApplied).toBe(0);
  });

  it("rewraps stable agent, provider, wallet and stream-job custody", async () => {
    const sealed = (value: string) => cryptoModule.encryptSecret(value);
    const legacySecrets = {
      agent: sealed("agent-key"), bootstrap: sealed("bootstrap"),
      deposit: sealed("deposit-key"), wallet: sealed("wallet-key"),
    };
    const stream = chatCryptoModule.encryptStoredChatJson({ prompt: "legacy-stream" });
    process.env.ENCRYPTION_KEY = NEW_SECRET_KEY;
    process.env.ENCRYPTION_KEY_LEGACY = OLD_SECRET_KEY;
    process.env.CHAT_ENCRYPTION_KEY = NEW_CHAT_KEY;
    process.env.CHAT_ENCRYPTION_KEY_LEGACY = OLD_SECRET_KEY;
    const paged = makePagedStore({
      vaultKeys: [], instances: [], conversations: [], messages: [],
      additionalSecrets: {
        hivra_agents_llm: [{ id: "agent-1", encrypted_value: legacySecrets.agent }],
        infrastructure_capacity_orders_bootstrap: [{ id: "order-1", encrypted_value: legacySecrets.bootstrap }],
        bankr_deposit_wallet_credentials_key: [{ id: "deposit-1", encrypted_value: legacySecrets.deposit }],
        instance_bankr_wallets_key: [{ id: "wallet-1", encrypted_value: legacySecrets.wallet }],
      },
      chatStreamJobs: [{ id: "job-1", stream_request: stream, fallback_request: { prompt: "plaintext-fallback" } }],
    });

    const first = await rotationModule.runEncryptionKeyRotation(paged.store, { dryRun: false, batchSize: 1 });
    expect(first.surfaces.agentLlmKeys.migratedLegacy).toBe(1);
    expect(first.surfaces.capacityBootstrapBundles.migratedLegacy).toBe(1);
    expect(first.surfaces.bankrDepositKeys.migratedLegacy).toBe(1);
    expect(first.surfaces.instanceBankrKeys.migratedLegacy).toBe(1);
    expect(first.surfaces.streamJobRequests.migratedLegacy).toBe(1);
    expect(first.surfaces.streamJobFallbackRequests.plaintextEncrypted).toBe(1);
    expect(paged.updates.additionalSecrets).toHaveLength(4);
    expect(paged.updates.chatStreamJobs).toHaveLength(1);
    expect(cryptoModule.decryptSecret(paged.rows.additionalSecrets!.hivra_agents_llm![0].encrypted_value!)).toBe("agent-key");
    expect(chatCryptoModule.decryptStoredChatJson(paged.rows.chatStreamJobs![0].fallback_request))
      .toEqual({ prompt: "plaintext-fallback" });

    const second = await rotationModule.runEncryptionKeyRotation(paged.store, { dryRun: false, batchSize: 1 });
    expect(second.updatesApplied).toBe(0);
    expect(second.surfaces.agentLlmKeys.alreadyPrimary).toBe(1);
    expect(second.surfaces.streamJobRequests.alreadyPrimary).toBe(1);
  });

  it("uses compare-and-swap so rotation cannot overwrite a concurrently replaced credential", async () => {
    const legacyInfrastructureSecret = cryptoModule.encryptSecret("old-infrastructure-secret");
    process.env.ENCRYPTION_KEY = NEW_SECRET_KEY;
    process.env.ENCRYPTION_KEY_LEGACY = OLD_SECRET_KEY;

    const paged = makePagedStore({
      vaultKeys: [],
      infrastructureSecrets: [{
        connection_id: "connection-race",
        encrypted_bundle: legacyInfrastructureSecret,
        key_version: 1,
      }],
      instances: [],
      conversations: [],
      messages: [],
    });
    const originalUpdate = paged.store.updateInfrastructureConnectionSecret;
    paged.store.updateInfrastructureConnectionSecret = async (id, expected, patch) => {
      const row = paged.rows.infrastructureSecrets?.[0];
      if (row) row.encrypted_bundle = cryptoModule.encryptSecret("new-user-key");
      return originalUpdate(id, expected, patch);
    };

    const summary = await rotationModule.runEncryptionKeyRotation(paged.store, {
      dryRun: false,
      batchSize: 1,
    });

    expect(summary.updatesApplied).toBe(0);
    expect(summary.surfaces.infrastructureConnectionSecrets.failures).toBe(1);
    expect(summary.surfaces.infrastructureConnectionSecrets.migratedLegacy).toBe(1);
    expect(summary.failures[0]?.message).toContain("credential changed concurrently");
    expect(
      cryptoModule.decryptSecret(paged.rows.infrastructureSecrets?.[0].encrypted_bundle ?? ""),
    ).toBe("new-user-key");
  });

  it("does not overwrite a concurrent vault edit or instance configuration change", async () => {
    const oldVault = cryptoModule.encryptSecret("old-vault");
    const oldSetting = cryptoModule.encryptSecret("old-setting");
    process.env.ENCRYPTION_KEY = NEW_SECRET_KEY;
    process.env.ENCRYPTION_KEY_LEGACY = OLD_SECRET_KEY;
    const paged = makePagedStore({ vaultKeys: [{ id: "a", encrypted_key: oldVault }],
      instances: [{ id: "b", api_key_encrypted: null, api_server_key_encrypted: null,
        honcho_api_key_encrypted: null, config: { agentSettings: { tavilyApiKeyEncrypted: oldSetting } } }],
      conversations: [], messages: [] });
    const vaultUpdate = paged.store.updateVaultKey, instanceUpdate = paged.store.updateInstance;
    paged.store.updateVaultKey = async (expected, patch) => {
      paged.rows.vaultKeys[0].encrypted_key = cryptoModule.encryptSecret("concurrent-vault");
      return vaultUpdate(expected, patch);
    };
    paged.store.updateInstance = async (expected, patch) => {
      paged.rows.instances[0].config.preference = "concurrent-preference";
      return instanceUpdate(expected, patch);
    };

    const summary = await rotationModule.runEncryptionKeyRotation(paged.store, { dryRun: false });

    expect(summary.updatesApplied).toBe(0);
    expect(summary.failures).toHaveLength(2);
    expect(summary.surfaces.userApiKeys.migratedLegacy).toBe(1);
    expect(summary.surfaces.instanceAgentSettings.migratedLegacy).toBe(1);
    expect(summary.surfaces.userApiKeys.failures).toBe(1);
    expect(summary.surfaces.instanceAgentSettings.failures).toBe(1);
    expect(cryptoModule.decryptSecret(paged.rows.vaultKeys[0].encrypted_key)).toBe("concurrent-vault");
    expect(paged.rows.instances[0].config.preference).toBe("concurrent-preference");
  });

  it("does not skip a later identity when an earlier row disappears between pages", async () => {
    const values = ["a", "b", "c"].map(id => ({ id, encrypted_key: cryptoModule.encryptSecret(id) }));
    process.env.ENCRYPTION_KEY = NEW_SECRET_KEY;
    process.env.ENCRYPTION_KEY_LEGACY = OLD_SECRET_KEY;
    const paged = makePagedStore({ vaultKeys: values, instances: [], conversations: [], messages: [] });
    const list = paged.store.listVaultKeys;
    let calls = 0;
    paged.store.listVaultKeys = async (afterId, limit) => {
      calls += 1;
      if (calls === 2) paged.rows.vaultKeys.splice(0, 1);
      return list(afterId, limit);
    };

    const summary = await rotationModule.runEncryptionKeyRotation(paged.store, { dryRun: false, batchSize: 1 });

    expect(summary.updatesApplied).toBe(3);
    expect(paged.rows.vaultKeys.map(row => cryptoModule.decryptSecret(row.encrypted_key))).toEqual(["b", "c"]);
  });

  it("preserves the provider credential schema version when rewrapping its key", async () => {
    const encrypted = cryptoModule.encryptSecret("synthetic-v2-provider-bundle");
    process.env.ENCRYPTION_KEY = NEW_SECRET_KEY;
    process.env.ENCRYPTION_KEY_LEGACY = OLD_SECRET_KEY;
    const paged = makePagedStore({
      vaultKeys: [], instances: [], conversations: [], messages: [],
      infrastructureSecrets: [{ connection_id: "connection-v2", encrypted_bundle: encrypted, key_version: 2 }],
    });

    await rotationModule.runEncryptionKeyRotation(paged.store, { dryRun: false });

    expect(paged.updates.infrastructureSecrets[0].patch.key_version).toBe(2);
    expect(cryptoModule.decryptSecret(paged.rows.infrastructureSecrets![0].encrypted_bundle))
      .toBe("synthetic-v2-provider-bundle");
  });

  it("blocks every write if an unhandled key dependency is present or unknown", async () => {
    const encrypted = cryptoModule.encryptSecret("legacy");
    process.env.ENCRYPTION_KEY = NEW_SECRET_KEY;
    process.env.ENCRYPTION_KEY_LEGACY = OLD_SECRET_KEY;
    for (const count of [1, Number.NaN]) {
      const paged = makePagedStore({ vaultKeys: [{id:"a",encrypted_key:encrypted}],
        instances: [], conversations: [], messages: [] });
      paged.store.countUnhandledValues = async () => count;
      const summary = await rotationModule.runEncryptionKeyRotation(paged.store,{dryRun:false});
      expect(summary.coverage.blocksApply).toBe(true);
      expect(summary.updatesApplied).toBe(0);
      expect(paged.updates.vaultKeys).toEqual([]);
    }
  });
});
