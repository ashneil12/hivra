import { reencryptApiKey } from "@/lib/crypto";
import {
  reencryptStoredChatJson,
  reencryptStoredChatText,
  type ChatKeySource,
} from "@/lib/chat-crypto";
import {
  formatRotationCoverage,
  inspectRotationCoverage,
  type RotationCoverage,
  type RotationDependency,
} from "@/lib/encryption-rotation-coverage";

const AGENT_SETTINGS_SECRET_KEYS = [
  "browserbaseApiKeyEncrypted",
  "browserUseApiKeyEncrypted",
  "tavilyApiKeyEncrypted",
  "exaApiKeyEncrypted",
  "firecrawlApiKeyEncrypted",
  "daytonaApiKeyEncrypted",
  "subagentApiKeyEncrypted",
  "browserProxyPasswordEncrypted",
] as const;

const MEMORY_SYSTEM_SECRET_KEYS = [
  "honchoApiKeyEncrypted",
  "mem0ApiKeyEncrypted",
  "hindsightApiKeyEncrypted",
  "hindsightLlmApiKeyEncrypted",
  "openVikingApiKeyEncrypted",
  "retaindbApiKeyEncrypted",
  "brvApiKeyEncrypted",
  "supermemoryApiKeyEncrypted",
] as const;

export type RotationSurface =
  | "userApiKeys"
  | "infrastructureConnectionSecrets"
  | "instanceApiKeys"
  | "instanceApiServerKeys"
  | "instanceHonchoKeys"
  | "instanceAgentSettings"
  | "instanceMemorySystem"
  | "agentLlmKeys"
  | "capacityBootstrapBundles"
  | "bankrDepositKeys"
  | "instanceBankrKeys"
  | "conversationTitles"
  | "messageContent"
  | "messageToolCalls"
  | "messageAttachments"
  | "messageArtifacts"
  | "messageMetadata"
  | "streamJobRequests"
  | "streamJobFallbackRequests";

export type RotationSurfaceSummary = {
  alreadyPrimary: number;
  migratedLegacy: number;
  plaintextEncrypted: number;
  skipped: number;
  failures: number;
};

type RotationFailure = {
  surface: RotationSurface;
  rowId: string;
  message: string;
};

export type RotationSummary = {
  dryRun: boolean;
  updatesApplied: number;
  coverage: RotationCoverage;
  surfaces: Record<RotationSurface, RotationSurfaceSummary>;
  failures: RotationFailure[];
};

export type VaultKeyRow = {
  id: string;
  encrypted_key: string | null;
};

export type InfrastructureConnectionSecretRow = {
  connection_id: string;
  encrypted_bundle: string | null;
  key_version: number;
};

export type HermesInstanceRow = {
  id: string;
  api_key_encrypted: string | null;
  api_server_key_encrypted: string | null;
  honcho_api_key_encrypted: string | null;
  config: Record<string, unknown> | null;
};

export type ConversationRow = {
  id: string;
  title: string | null;
};

export type MessageRow = {
  id: string;
  content: string | null;
  tool_calls: unknown;
  attachments: unknown;
  artifacts: unknown;
  metadata: unknown;
};

export type AdditionalSecretSurface =
  | "hivra_agents_llm"
  | "infrastructure_capacity_orders_bootstrap"
  | "bankr_deposit_wallet_credentials_key"
  | "instance_bankr_wallets_key";

export type AdditionalSecretRow = {
  id: string;
  encrypted_value: string | null;
};

export type ChatStreamJobRow = {
  id: string;
  stream_request: unknown;
  fallback_request: unknown;
};

export interface EncryptionRotationStore {
  countUnhandledValues(dependency: RotationDependency): Promise<number>;
  listVaultKeys(afterId: string | null, limit: number): Promise<VaultKeyRow[]>;
  updateVaultKey(expected: VaultKeyRow, patch: Partial<VaultKeyRow>): Promise<boolean>;
  listInfrastructureConnectionSecrets(
    afterId: string | null,
    limit: number,
  ): Promise<InfrastructureConnectionSecretRow[]>;
  updateInfrastructureConnectionSecret(
    connectionId: string,
    expectedEncryptedBundle: string,
    patch: Partial<InfrastructureConnectionSecretRow>,
  ): Promise<boolean>;
  listInstances(afterId: string | null, limit: number): Promise<HermesInstanceRow[]>;
  updateInstance(expected: HermesInstanceRow, patch: Partial<HermesInstanceRow>): Promise<boolean>;
  listAdditionalSecrets(surface: AdditionalSecretSurface, afterId: string | null, limit: number): Promise<AdditionalSecretRow[]>;
  updateAdditionalSecret(surface: AdditionalSecretSurface, expected: AdditionalSecretRow, encryptedValue: string): Promise<boolean>;
  listConversations(afterId: string | null, limit: number): Promise<ConversationRow[]>;
  updateConversation(expected: ConversationRow, patch: Partial<ConversationRow>): Promise<boolean>;
  listMessages(afterId: string | null, limit: number): Promise<MessageRow[]>;
  updateMessage(expected: MessageRow, patch: Partial<MessageRow>): Promise<boolean>;
  listChatStreamJobs(afterId: string | null, limit: number): Promise<ChatStreamJobRow[]>;
  updateChatStreamJob(expected: ChatStreamJobRow, patch: Partial<ChatStreamJobRow>): Promise<boolean>;
}

type RotationOptions = {
  dryRun?: boolean;
  batchSize?: number;
  logger?: (line: string) => void;
};

type RotationClassification = "alreadyPrimary" | "migratedLegacy" | "plaintextEncrypted" | "skipped";

function createSurfaceSummary(): RotationSurfaceSummary {
  return {
    alreadyPrimary: 0,
    migratedLegacy: 0,
    plaintextEncrypted: 0,
    skipped: 0,
    failures: 0,
  };
}

function createSummary(dryRun: boolean, coverage: RotationCoverage): RotationSummary {
  return {
    dryRun,
    updatesApplied: 0,
    coverage,
    failures: [],
    surfaces: {
      userApiKeys: createSurfaceSummary(),
      infrastructureConnectionSecrets: createSurfaceSummary(),
      instanceApiKeys: createSurfaceSummary(),
      instanceApiServerKeys: createSurfaceSummary(),
      instanceHonchoKeys: createSurfaceSummary(),
      instanceAgentSettings: createSurfaceSummary(),
      instanceMemorySystem: createSurfaceSummary(),
      agentLlmKeys: createSurfaceSummary(),
      capacityBootstrapBundles: createSurfaceSummary(),
      bankrDepositKeys: createSurfaceSummary(),
      instanceBankrKeys: createSurfaceSummary(),
      conversationTitles: createSurfaceSummary(),
      messageContent: createSurfaceSummary(),
      messageToolCalls: createSurfaceSummary(),
      messageAttachments: createSurfaceSummary(),
      messageArtifacts: createSurfaceSummary(),
      messageMetadata: createSurfaceSummary(),
      streamJobRequests: createSurfaceSummary(),
      streamJobFallbackRequests: createSurfaceSummary(),
    },
  };
}

function incrementSurface(summary: RotationSummary, surface: RotationSurface, classification: RotationClassification) {
  summary.surfaces[surface][classification] += 1;
}

function recordFailure(summary: RotationSummary, surface: RotationSurface, rowId: string, error: unknown) {
  summary.surfaces[surface].failures += 1;
  summary.failures.push({
    surface,
    rowId,
    message: error instanceof Error && error.message === "credential changed concurrently; rerun rotation"
      ? error.message : "Unable to inspect or rewrap this value; retain its recovery key.",
  });
}

function classifySecretValue(summary: RotationSummary, surface: RotationSurface, rowId: string, value: string | null | undefined) {
  if (!value) {
    incrementSurface(summary, surface, "skipped");
    return { changed: false, nextValue: value };
  }

  try {
    const result = reencryptApiKey(value);
    if (result.changed) {
      incrementSurface(summary, surface, "migratedLegacy");
    } else {
      incrementSurface(summary, surface, "alreadyPrimary");
    }

    return {
      changed: result.changed,
      nextValue: result.value,
    };
  } catch (error) {
    recordFailure(summary, surface, rowId, error);
    return { changed: false, nextValue: value };
  }
}

function classifyChatChange(source: ChatKeySource, changed: boolean): RotationClassification {
  if (!changed) {
    return "alreadyPrimary";
  }

  if (source === "plaintext") {
    return "plaintextEncrypted";
  }

  return "migratedLegacy";
}

function classifyChatTextValue(
  summary: RotationSummary,
  surface: RotationSurface,
  rowId: string,
  value: string | null | undefined
) {
  if (value == null) {
    incrementSurface(summary, surface, "skipped");
    return { changed: false, nextValue: value };
  }

  try {
    const result = reencryptStoredChatText(value);
    incrementSurface(summary, surface, classifyChatChange(result.keySource, result.changed));
    return {
      changed: result.changed,
      nextValue: result.value,
    };
  } catch (error) {
    recordFailure(summary, surface, rowId, error);
    return { changed: false, nextValue: value };
  }
}

function classifyChatJsonValue<T>(
  summary: RotationSummary,
  surface: RotationSurface,
  rowId: string,
  value: T
) {
  if (value == null) {
    incrementSurface(summary, surface, "skipped");
    return { changed: false, nextValue: value };
  }

  try {
    const result = reencryptStoredChatJson(value);
    incrementSurface(summary, surface, classifyChatChange(result.keySource, result.changed));
    return {
      changed: result.changed,
      nextValue: result.value,
    };
  } catch (error) {
    recordFailure(summary, surface, rowId, error);
    return { changed: false, nextValue: value };
  }
}

function rotateInstanceConfig(
  summary: RotationSummary,
  rowId: string,
  config: Record<string, unknown> | null
): {
  changed: boolean;
  nextConfig: Record<string, unknown>;
  changedSurfaces: RotationSurface[];
} {
  const nextConfig = config ? { ...config } : {};
  let changed = false;
  const changedSurfaces = new Set<RotationSurface>();

  const currentAgentSettings =
    nextConfig.agentSettings && typeof nextConfig.agentSettings === "object"
      ? { ...(nextConfig.agentSettings as Record<string, unknown>) }
      : undefined;
  const currentMemorySystem =
    nextConfig.memorySystem && typeof nextConfig.memorySystem === "object"
      ? { ...(nextConfig.memorySystem as Record<string, unknown>) }
      : undefined;

  if (currentAgentSettings) {
    for (const key of AGENT_SETTINGS_SECRET_KEYS) {
      const result = classifySecretValue(
        summary,
        "instanceAgentSettings",
        rowId,
        typeof currentAgentSettings[key] === "string" ? (currentAgentSettings[key] as string) : null
      );
      if (result.changed) {
        currentAgentSettings[key] = result.nextValue;
        changed = true;
        changedSurfaces.add("instanceAgentSettings");
      }
    }

    nextConfig.agentSettings = currentAgentSettings;
  } else {
    incrementSurface(summary, "instanceAgentSettings", "skipped");
  }

  if (currentMemorySystem) {
    for (const key of MEMORY_SYSTEM_SECRET_KEYS) {
      const result = classifySecretValue(
        summary,
        "instanceMemorySystem",
        rowId,
        typeof currentMemorySystem[key] === "string" ? (currentMemorySystem[key] as string) : null
      );
      if (result.changed) {
        currentMemorySystem[key] = result.nextValue;
        changed = true;
        changedSurfaces.add("instanceMemorySystem");
      }
    }

    nextConfig.memorySystem = currentMemorySystem;
  } else {
    incrementSurface(summary, "instanceMemorySystem", "skipped");
  }

  return {
    changed,
    nextConfig,
    changedSurfaces: [...changedSurfaces],
  };
}

async function processBatches<T>(
  listRows: (afterId: string | null, limit: number) => Promise<T[]>,
  batchSize: number,
  identity: (row: T) => string,
  handleRows: (rows: T[]) => Promise<void>
) {
  let afterId: string | null = null;

  while (true) {
    const rows = await listRows(afterId, batchSize);
    if (!rows.length) {
      break;
    }

    if (rows.length > batchSize) throw new Error("Unexpected rotation page size");
    for (const row of rows) {
      const id = identity(row);
      if (typeof id !== "string" || !id || (afterId !== null && id <= afterId)) {
        throw new Error("Rotation scan did not advance in identity order");
      }
      afterId = id;
    }
    await handleRows(rows);
  }
}

function recordConflict(summary: RotationSummary, surface: RotationSurface, rowId: string) {
  recordFailure(summary, surface, rowId, new Error("credential changed concurrently; rerun rotation"));
}

export async function runEncryptionKeyRotation(
  store: EncryptionRotationStore,
  options: RotationOptions = {}
): Promise<RotationSummary> {
  const dryRun = options.dryRun !== false;
  const batchSize = options.batchSize ?? 100;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new Error("Batch size must be an integer from 1 to 1000");
  }
  const logger = options.logger ?? (() => undefined);
  const coverage = await inspectRotationCoverage((dependency) => store.countUnhandledValues(dependency));
  const summary = createSummary(dryRun, coverage);

  // Never begin partial writes when known, unhandled custody exists. This is
  // not a transaction with concurrent application writers or a retirement gate.
  if (!dryRun && coverage.blocksApply) return summary;

  logger(`${dryRun ? "Inspecting" : "Rewrapping"} legacy encryption surfaces with batch size ${batchSize}`);

  await processBatches(store.listVaultKeys.bind(store), batchSize, (row) => row.id, async (rows) => {
    for (const row of rows) {
      const result = classifySecretValue(summary, "userApiKeys", row.id, row.encrypted_key);
      if (!result.changed || dryRun) {
        continue;
      }

      if (!await store.updateVaultKey(row, { encrypted_key: result.nextValue ?? null })) {
        recordConflict(summary, "userApiKeys", row.id);
        continue;
      }
      summary.updatesApplied += 1;
    }
  });

  await processBatches(
    store.listInfrastructureConnectionSecrets.bind(store),
    batchSize,
    (row) => row.connection_id,
    async (rows) => {
      for (const row of rows) {
        const result = classifySecretValue(
          summary,
          "infrastructureConnectionSecrets",
          row.connection_id,
          row.encrypted_bundle,
        );
        if (!result.changed || dryRun) {
          continue;
        }

        const updated = await store.updateInfrastructureConnectionSecret(
          row.connection_id,
          row.encrypted_bundle as string,
          {
            encrypted_bundle: result.nextValue ?? null,
            // This describes the provider bundle schema, not the AES key epoch.
            key_version: row.key_version,
          },
        );
        if (!updated) {
          recordFailure(
            summary,
            "infrastructureConnectionSecrets",
            row.connection_id,
            new Error("credential changed concurrently; rerun rotation"),
          );
          continue;
        }
        summary.updatesApplied += 1;
      }
    },
  );

  await processBatches(store.listInstances.bind(store), batchSize, (row) => row.id, async (rows) => {
    for (const row of rows) {
      const patch: Partial<HermesInstanceRow> = {};
      const changedSurfaces = new Set<RotationSurface>();

      const apiKey = classifySecretValue(summary, "instanceApiKeys", row.id, row.api_key_encrypted);
      if (apiKey.changed) {
        patch.api_key_encrypted = apiKey.nextValue ?? null;
        changedSurfaces.add("instanceApiKeys");
      }

      const apiServerKey = classifySecretValue(
        summary,
        "instanceApiServerKeys",
        row.id,
        row.api_server_key_encrypted
      );
      if (apiServerKey.changed) {
        patch.api_server_key_encrypted = apiServerKey.nextValue ?? null;
        changedSurfaces.add("instanceApiServerKeys");
      }

      const honchoKey = classifySecretValue(
        summary,
        "instanceHonchoKeys",
        row.id,
        row.honcho_api_key_encrypted
      );
      if (honchoKey.changed) {
        patch.honcho_api_key_encrypted = honchoKey.nextValue ?? null;
        changedSurfaces.add("instanceHonchoKeys");
      }

      const configRotation = rotateInstanceConfig(summary, row.id, row.config);
      if (configRotation.changed) {
        patch.config = configRotation.nextConfig;
        for (const surface of configRotation.changedSurfaces) changedSurfaces.add(surface);
      }

      if (!Object.keys(patch).length || dryRun) {
        continue;
      }

      if (!await store.updateInstance(row, patch)) {
        for (const surface of changedSurfaces) recordConflict(summary, surface, row.id);
        continue;
      }
      summary.updatesApplied += 1;
    }
  });

  const additionalSecretSurfaces: Array<{
    storeSurface: AdditionalSecretSurface;
    summarySurface: RotationSurface;
  }> = [
    { storeSurface: "hivra_agents_llm", summarySurface: "agentLlmKeys" },
    { storeSurface: "infrastructure_capacity_orders_bootstrap", summarySurface: "capacityBootstrapBundles" },
    { storeSurface: "bankr_deposit_wallet_credentials_key", summarySurface: "bankrDepositKeys" },
    { storeSurface: "instance_bankr_wallets_key", summarySurface: "instanceBankrKeys" },
  ];
  for (const { storeSurface, summarySurface } of additionalSecretSurfaces) {
    await processBatches(
      (afterId, limit) => store.listAdditionalSecrets(storeSurface, afterId, limit),
      batchSize,
      (row) => row.id,
      async (rows) => {
        for (const row of rows) {
          const result = classifySecretValue(summary, summarySurface, row.id, row.encrypted_value);
          if (!result.changed || dryRun) continue;
          if (!await store.updateAdditionalSecret(storeSurface, row, result.nextValue as string)) {
            recordConflict(summary, summarySurface, row.id);
            continue;
          }
          summary.updatesApplied += 1;
        }
      },
    );
  }

  await processBatches(store.listConversations.bind(store), batchSize, (row) => row.id, async (rows) => {
    for (const row of rows) {
      const result = classifyChatTextValue(summary, "conversationTitles", row.id, row.title);
      if (!result.changed || dryRun) {
        continue;
      }

      if (!await store.updateConversation(row, { title: result.nextValue })) {
        recordConflict(summary, "conversationTitles", row.id);
        continue;
      }
      summary.updatesApplied += 1;
    }
  });

  await processBatches(store.listMessages.bind(store), batchSize, (row) => row.id, async (rows) => {
    for (const row of rows) {
      const patch: Partial<MessageRow> = {};
      const changedSurfaces = new Set<RotationSurface>();

      const content = classifyChatTextValue(summary, "messageContent", row.id, row.content);
      if (content.changed) {
        patch.content = content.nextValue;
        changedSurfaces.add("messageContent");
      }

      const toolCalls = classifyChatJsonValue(summary, "messageToolCalls", row.id, row.tool_calls);
      if (toolCalls.changed) {
        patch.tool_calls = toolCalls.nextValue;
        changedSurfaces.add("messageToolCalls");
      }

      const attachments = classifyChatJsonValue(summary, "messageAttachments", row.id, row.attachments);
      if (attachments.changed) {
        patch.attachments = attachments.nextValue;
        changedSurfaces.add("messageAttachments");
      }

      const artifacts = classifyChatJsonValue(summary, "messageArtifacts", row.id, row.artifacts);
      if (artifacts.changed) {
        patch.artifacts = artifacts.nextValue;
        changedSurfaces.add("messageArtifacts");
      }

      const metadata = classifyChatJsonValue(summary, "messageMetadata", row.id, row.metadata);
      if (metadata.changed) {
        patch.metadata = metadata.nextValue;
        changedSurfaces.add("messageMetadata");
      }

      if (!Object.keys(patch).length || dryRun) {
        continue;
      }

      if (!await store.updateMessage(row, patch)) {
        for (const surface of changedSurfaces) recordConflict(summary, surface, row.id);
        continue;
      }
      summary.updatesApplied += 1;
    }
  });

  await processBatches(store.listChatStreamJobs.bind(store), batchSize, (row) => row.id, async (rows) => {
    for (const row of rows) {
      const patch: Partial<ChatStreamJobRow> = {};
      const changedSurfaces = new Set<RotationSurface>();
      const streamRequest = classifyChatJsonValue(summary, "streamJobRequests", row.id, row.stream_request);
      if (streamRequest.changed) {
        patch.stream_request = streamRequest.nextValue;
        changedSurfaces.add("streamJobRequests");
      }
      const fallbackRequest = classifyChatJsonValue(summary, "streamJobFallbackRequests", row.id, row.fallback_request);
      if (fallbackRequest.changed) {
        patch.fallback_request = fallbackRequest.nextValue;
        changedSurfaces.add("streamJobFallbackRequests");
      }
      if (!Object.keys(patch).length || dryRun) continue;
      if (!await store.updateChatStreamJob(row, patch)) {
        for (const surface of changedSurfaces) recordConflict(summary, surface, row.id);
        continue;
      }
      summary.updatesApplied += 1;
    }
  });

  return summary;
}

export function formatRotationSummary(summary: RotationSummary): string {
  const lines = [
    `${summary.dryRun ? "Read-only inspection" : summary.coverage.blocksApply ? "Blocked" : "Legacy rewrap pass"} — not complete key rotation`,
    `Updates applied: ${summary.updatesApplied}`,
    formatRotationCoverage(summary.coverage),
  ];

  for (const [surface, counts] of Object.entries(summary.surfaces) as Array<
    [RotationSurface, RotationSurfaceSummary]
  >) {
    lines.push(
      `${surface}: observed-primary=${counts.alreadyPrimary}, legacy-candidates=${counts.migratedLegacy}, plaintext-candidates=${counts.plaintextEncrypted}, skipped=${counts.skipped}, failures=${counts.failures}`
    );
  }

  if (summary.failures.length) {
    lines.push("Failures:");
    for (const failure of summary.failures) {
      lines.push(`- ${failure.surface} ${failure.rowId}: ${failure.message}`);
    }
  }

  return lines.join("\n");
}
