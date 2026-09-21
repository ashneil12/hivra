import { agentWebApi, type AgentWebApiClient } from "@/lib/agent-web-api";
import { redactSensitiveCommandOutput } from "@/lib/command-output-redaction";
import { decryptApiKey, encryptApiKey } from "@/lib/crypto";
import { buildHermesWebConfigPayload } from "@/lib/hermes-web";
import { putHermesConfigWithBindMountFallback } from "@/lib/hermes-config-write";
import { resolveHermesHomeDirFromConfig } from "@/lib/hermes-home";
import { sshExec } from "@/lib/hetzner/ssh";
import { log } from "@/lib/logger";
import { formatStoredProviderSecretPreview } from "@/lib/codex-oauth";
import { buildProviderEnvResetMap } from "@/lib/services/hetzner-instance-service";
import {
  getSecureUserInstance,
  type SecureUserInstanceResult,
} from "@/lib/services/instance-security";
import { ProfileService, sanitizeDockerName } from "@/lib/services/profile-service";
import { resolveProviderBaseUrl, resolveProviderFallbackModel } from "@/lib/services/provider-config";
import { supabaseAdmin } from "@/lib/supabase";
import { getManagedVeniceProxyBaseUrl } from "@/lib/venice/managed-endpoints";
import {
  createManagedVeniceProxyKey,
  revokeManagedVeniceProxyKey,
  type ManagedVeniceProxyKeyStatus,
} from "@/lib/venice/proxy-keys";
import type { ManagedVeniceWalletType } from "@/lib/billing/managed-venice-wallets";
import { isWebfreeBackend } from "@/lib/types/instance";
import {
  isManagedVeniceProxyBaseUrl,
  isManagedVeniceProxyKey,
} from "@/lib/venice/byok-classification";

const LOG_SOURCE = "managed-venice-webui-enable";

type QueryError = { code?: string; message?: string } | null;

type DbSelectChain = {
  select: (...args: unknown[]) => DbSelectChain;
  eq: (...args: unknown[]) => DbSelectChain;
  neq: (...args: unknown[]) => DbSelectChain;
  single: <T = unknown>() => Promise<{ data: T | null; error: QueryError }>;
};

type DbUpdateChain = {
  eq: (...args: unknown[]) => DbUpdateChain;
  select: (...args: unknown[]) => {
    single: <T = unknown>() => Promise<{ data: T | null; error: QueryError }>;
  };
};

type DbTable = {
  select: (...args: unknown[]) => DbSelectChain;
  update: (...args: unknown[]) => DbUpdateChain;
};

type SupabaseLike = {
  from: (table: string) => unknown;
};

export interface ManagedVeniceEnableInstanceRow {
  id: string;
  user_id: string;
  name: string;
  status: string;
  backend?: "gateway" | "webui" | null;
  provider: string;
  gateway_url?: string | null;
  api_key_encrypted?: string | null;
  api_key_preview?: string | null;
  config?: Record<string, unknown> | null;
}

export type ManagedVeniceEnableFailureType =
  | "managed_venice_instance_not_found"
  | "managed_venice_requires_webui"
  | "managed_venice_proxy_key_create_failed"
  | "managed_venice_instance_update_failed"
  | "managed_venice_live_apply_failed"
  | "managed_venice_byok_key_missing"
  | "managed_venice_byok_key_invalid_shape"
  | "managed_venice_byok_not_enabled";

export class ManagedVeniceEnableError extends Error {
  readonly status: number;
  readonly failureType: ManagedVeniceEnableFailureType;

  constructor(
    message: string,
    opts: { status: number; failureType: ManagedVeniceEnableFailureType }
  ) {
    super(message);
    this.name = "ManagedVeniceEnableError";
    this.status = opts.status;
    this.failureType = opts.failureType;
  }
}

type CreateProxyKey = typeof createManagedVeniceProxyKey;
type GetSecureInstance = typeof getSecureUserInstance;
type AgentWebApiFactory = typeof agentWebApi;
type PutConfig = typeof putHermesConfigWithBindMountFallback;
type SshExec = typeof sshExec;

interface ManagedVeniceEnableDeps {
  db?: SupabaseLike | null;
  now?: () => Date;
  proxyBaseUrl?: string;
  dashboardEnableUrl?: string | null;
  createProxyKey?: CreateProxyKey;
  getSecureInstance?: GetSecureInstance;
  agentWebApiFactory?: AgentWebApiFactory;
  putConfig?: PutConfig;
  ssh?: SshExec;
}

function table(db: SupabaseLike, name: string): DbTable {
  return db.from(name) as DbTable;
}

function requireDb(db: SupabaseLike | null | undefined): SupabaseLike {
  if (!db) {
    throw new Error("Database not configured");
  }
  return db;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function decryptStoredApiKey(encrypted: string | null | undefined): string | null {
  if (!encrypted) return null;
  try {
    const decrypted = decryptApiKey(encrypted);
    return decrypted.trim() || null;
  } catch {
    return null;
  }
}

function readManagedVeniceConfig(config: Record<string, unknown>) {
  const managedVenice = readRecord(config.managedVenice);
  return {
    enabled: managedVenice.enabled === true,
    walletType: managedVenice.walletType === "card" ? "card" : "hermesos",
  } satisfies { enabled: boolean; walletType: ManagedVeniceWalletType };
}

function resolveManagedVeniceModel(
  requestedModel: string | null | undefined,
  config: Record<string, unknown>
) {
  const topLevelModel = readString(config.model);
  const nestedModel = readString(readRecord(config.model).default);
  return (
    readString(requestedModel) ||
    topLevelModel ||
    nestedModel ||
    resolveProviderFallbackModel("venice")
  );
}

function keyPrefix(plaintextKey: string) {
  return plaintextKey.slice(0, 14);
}

export function buildManagedVeniceStoredInstanceConfig(
  currentConfig: Record<string, unknown> | undefined | null,
  params: {
    walletType: ManagedVeniceWalletType;
    model: string;
    proxyBaseUrl: string;
    proxyKeyId: string | null;
    keyPrefix: string;
    enabledAt: string;
  }
): Record<string, unknown> {
  const current = readRecord(currentConfig);
  const currentAgentSettings = readRecord(current.agentSettings);

  return {
    ...current,
    model: params.model,
    agentSettings: {
      ...currentAgentSettings,
      customLlmBaseUrl: params.proxyBaseUrl,
    },
    managedVenice: {
      enabled: true,
      walletType: params.walletType,
      proxyBaseUrl: params.proxyBaseUrl,
      proxyKeyId: params.proxyKeyId,
      keyPrefix: params.keyPrefix,
      enabledAt: params.enabledAt,
    },
  };
}

export function buildManagedVeniceRemoteConfig(
  currentRemoteConfig: Record<string, unknown>,
  params: { model: string; proxyBaseUrl: string }
): Record<string, unknown> {
  return buildHermesWebConfigPayload(currentRemoteConfig, {
    model: params.model,
    provider: "custom",
    baseUrl: params.proxyBaseUrl,
  });
}

export function buildManagedVeniceRuntimeEnvUpdates(params: {
  proxyKey: string;
  proxyBaseUrl: string;
  model: string;
  dashboardEnableUrl?: string | null;
}): Record<string, string> {
  return {
    ...buildProviderEnvResetMap(),
    HERMES_INFERENCE_PROVIDER: "custom",
    OPENAI_API_KEY: params.proxyKey,
    OPENAI_BASE_URL: params.proxyBaseUrl,
    // Venice is reached as an OpenAI-compatible "custom" provider, but the agent's
    // credential resolver host-gates OPENAI_API_KEY to openai.com and otherwise
    // derives <VENDOR>_API_KEY from the base_url host (api.venice.ai -> VENICE_API_KEY).
    // Without these, code paths that resolve creds from env (session resume,
    // model-switch) fall back to "no-key-required" and 401. Mirror
    // buildProviderEnv()'s `venice` branch so resume works, not just new chats.
    VENICE_API_KEY: params.proxyKey,
    VENICE_BASE_URL: params.proxyBaseUrl,
    // HERMES_MODEL deliberately scrubbed ("") rather than pinned: config.yaml
    // (buildManagedVeniceRemoteConfig — provider "custom" + this model) owns the model.
    // Pinning HERMES_MODEL makes the agent's _resolve_startup_runtime re-detect the
    // provider from the model NAME (e.g. deepseek-* -> native deepseek), overriding
    // provider:custom and bricking chat with "Provider X is set but no API key". The
    // empty value makes buildEnvPatchCommand strip any legacy pin too. Mirrors #204.
    HERMES_MODEL: "",
    HERMES_WEBUI_DEFAULT_MODEL: params.model,
    ...(params.dashboardEnableUrl
      ? { HERMES_MANAGED_VENICE_ENABLE_URL: params.dashboardEnableUrl }
      : {}),
  };
}

async function loadInstanceForEnable(
  db: SupabaseLike,
  params: { instanceId: string; userId: string }
): Promise<ManagedVeniceEnableInstanceRow> {
  const { data, error } = await table(db, "hermes_instances")
    .select(
      "id, user_id, name, status, backend, provider, gateway_url, api_key_encrypted, api_key_preview, config"
    )
    .eq("id", params.instanceId)
    .eq("user_id", params.userId)
    .neq("status", "deleted")
    .single<ManagedVeniceEnableInstanceRow>();

  if (error || !data) {
    throw new ManagedVeniceEnableError("Instance not found or unauthorized.", {
      status: 404,
      failureType: "managed_venice_instance_not_found",
    });
  }

  return data;
}

async function applyManagedVeniceToRunningWebUI(params: {
  instanceId: string;
  userId: string;
  ip: string;
  proxyKey: string;
  proxyBaseUrl: string;
  model: string;
  hermesHomeDir: string;
  dashboardEnableUrl?: string | null;
  apiFactory: AgentWebApiFactory;
  putConfig: PutConfig;
  ssh: SshExec;
}) {
  const api: AgentWebApiClient = await params.apiFactory(params.instanceId, params.userId);
  const configRes = await api.get("/api/config", { timeout: 20_000 });
  if (!configRes.ok) {
    const errText = await configRes.text().catch(() => configRes.statusText);
    throw new Error(`Agent config fetch returned ${configRes.status}: ${errText}`);
  }

  const currentConfig = (await configRes.json()) as Record<string, unknown>;
  const nextConfig = buildManagedVeniceRemoteConfig(currentConfig, {
    model: params.model,
    proxyBaseUrl: params.proxyBaseUrl,
  });

  await params.putConfig({
    api,
    config: nextConfig,
    containerName: `agent-${sanitizeDockerName(params.instanceId)}`,
    hermesHomeDir: params.hermesHomeDir,
    ip: params.ip,
    instanceId: params.instanceId,
    userId: params.userId,
    timeoutMs: 20_000,
  });

  const envUpdates = buildManagedVeniceRuntimeEnvUpdates({
    proxyKey: params.proxyKey,
    proxyBaseUrl: params.proxyBaseUrl,
    model: params.model,
    dashboardEnableUrl: params.dashboardEnableUrl,
  });
  const envPatch = ProfileService.buildEnvPatchCommand(
    `/opt/hermes/instances/${params.instanceId}/.env`,
    envUpdates
  ).trim();

  const result = await params.ssh(
    params.ip,
    `set -e
${envPatch}
cd /opt/hermes/instances/${params.instanceId}
docker compose up -d --force-recreate 2>&1 | tail -5`,
    { timeoutMs: 45_000 }
  );

  if (!result.ok) {
    throw new Error(
      result.error ||
        redactSensitiveCommandOutput(result.stderr || "", 800) ||
        "Managed Venice WebUI env update failed"
    );
  }
}

export async function enableManagedVeniceForWebUIInstance(
  params: {
    instanceId: string;
    userId: string;
    walletType?: ManagedVeniceWalletType;
    model?: string | null;
    apply?: boolean;
  },
  deps: ManagedVeniceEnableDeps = {}
) {
  const db = requireDb(deps.db ?? supabaseAdmin);
  const now = deps.now ?? (() => new Date());
  const walletType = params.walletType === "card" ? "card" : "hermesos";
  const instance = await loadInstanceForEnable(db, params);
  const config = readRecord(instance.config);

  if (!isWebfreeBackend(instance.backend)) {
    throw new ManagedVeniceEnableError(
      "Managed Venice can be enabled from the dashboard for WebUI agents only.",
      {
        status: 400,
        failureType: "managed_venice_requires_webui",
      }
    );
  }

  const model = resolveManagedVeniceModel(params.model, config);
  const proxyBaseUrl = deps.proxyBaseUrl ?? getManagedVeniceProxyBaseUrl();
  const existingPlaintextKey = decryptStoredApiKey(instance.api_key_encrypted);
  const currentManagedVenice = readManagedVeniceConfig(config);
  let plaintextKey = existingPlaintextKey?.startsWith("hven_live_")
    ? existingPlaintextKey
    : null;
  let proxyKeyId: string | null = null;
  let proxyKeyStatus: ManagedVeniceProxyKeyStatus | "reused" = "reused";

  if (!plaintextKey || !currentManagedVenice.enabled || currentManagedVenice.walletType !== walletType) {
    try {
      const key = await (deps.createProxyKey ?? createManagedVeniceProxyKey)({
        userId: params.userId,
        name: `${instance.name} managed Venice`,
        defaultWalletType: walletType,
      });
      plaintextKey = key.plaintextKey;
      proxyKeyId = key.id;
      proxyKeyStatus = key.status;
    } catch (error) {
      log.error("managed Venice proxy key creation failed for existing WebUI instance", error, {
        source: LOG_SOURCE,
        failureType: "managed_venice_proxy_key_create_failed",
        userId: params.userId,
        instanceId: params.instanceId,
        walletType,
      });
      throw new ManagedVeniceEnableError(
        "Managed Venice proxy key could not be created. Please try again.",
        {
          status: 503,
          failureType: "managed_venice_proxy_key_create_failed",
        }
      );
    }
  }

  const enabledAt = now().toISOString();
  const nextConfig = buildManagedVeniceStoredInstanceConfig(config, {
    walletType,
    model,
    proxyBaseUrl,
    proxyKeyId,
    keyPrefix: keyPrefix(plaintextKey),
    enabledAt,
  });

  const { data: updated, error: updateError } = await table(db, "hermes_instances")
    .update({
      provider: "venice",
      api_key_encrypted: encryptApiKey(plaintextKey),
      api_key_preview: formatStoredProviderSecretPreview("venice", plaintextKey),
      config: nextConfig,
      updated_at: enabledAt,
    })
    .eq("id", params.instanceId)
    .eq("user_id", params.userId)
    .select("*")
    .single<ManagedVeniceEnableInstanceRow>();

  if (updateError || !updated) {
    log.error("managed Venice instance persistence failed", updateError, {
      source: LOG_SOURCE,
      failureType: "managed_venice_instance_update_failed",
      userId: params.userId,
      instanceId: params.instanceId,
    });
    throw new ManagedVeniceEnableError(
      "Managed Venice settings could not be saved.",
      {
        status: 500,
        failureType: "managed_venice_instance_update_failed",
      }
    );
  }

  let applied = false;
  let applyError: string | null = null;
  if (params.apply !== false) {
    if (instance.status !== "running") {
      applyError =
        "Managed Venice was saved, but the agent is not running so the live WebUI container was not updated yet.";
    } else {
      try {
        const secure = await (deps.getSecureInstance ?? getSecureUserInstance)({
          id: params.instanceId,
          userId: params.userId,
          requireRunning: true,
        }) as SecureUserInstanceResult;

        if (secure.error || !secure.instance || !secure.instanceIpv4) {
          throw new Error(secure.error || "Instance host address was not available");
        }

        await applyManagedVeniceToRunningWebUI({
          instanceId: params.instanceId,
          userId: params.userId,
          ip: secure.instanceIpv4,
          proxyKey: plaintextKey,
          proxyBaseUrl,
          model,
          hermesHomeDir: resolveHermesHomeDirFromConfig(config),
          dashboardEnableUrl: deps.dashboardEnableUrl,
          apiFactory: deps.agentWebApiFactory ?? agentWebApi,
          putConfig: deps.putConfig ?? putHermesConfigWithBindMountFallback,
          ssh: deps.ssh ?? sshExec,
        });
        applied = true;
      } catch (error) {
        applyError =
          error instanceof Error
            ? error.message
            : "Managed Venice settings were saved, but the live WebUI update failed.";
        log.error("managed Venice live WebUI apply failed", error, {
          source: LOG_SOURCE,
          failureType: "managed_venice_live_apply_failed",
          userId: params.userId,
          instanceId: params.instanceId,
          walletType,
        });
      }
    }
  }

  return {
    instance: updated,
    applied,
    applyError,
    managedVenice: {
      enabled: true,
      walletType,
      model,
      proxyBaseUrl,
      keyPrefix: keyPrefix(plaintextKey),
      proxyKeyId,
      proxyKeyStatus,
    },
  };
}

// ── Managed → BYOK Venice transition ──────────────────────────────────────────
// Inverse of enableManagedVeniceForWebUIInstance. Used when a user wants to
// stop routing through Hivra's managed proxy and call api.venice.ai
// directly with their own Venice API key. Without this, instances created
// with managed Venice are stuck — the VM .env keeps the original
// hven_live_ proxy key + /api/managed-venice/v1 base URL forever, and any
// "update key" attempt via WebUI Connections only touches WebUI's own
// webui.db, not hermes-agent's runtime env.

export function buildVeniceByokStoredInstanceConfig(
  currentConfig: Record<string, unknown> | undefined | null,
  params: { model: string }
): Record<string, unknown> {
  const current = readRecord(currentConfig);
  const currentAgentSettings = readRecord(current.agentSettings);
  const { customLlmBaseUrl: _droppedCustomBaseUrl, ...nextAgentSettings } = currentAgentSettings;
  void _droppedCustomBaseUrl;
  const { managedVenice: _droppedManagedVenice, ...nextWithoutManaged } = current;
  void _droppedManagedVenice;

  return {
    ...nextWithoutManaged,
    model: params.model,
    agentSettings: nextAgentSettings,
  };
}

export function buildVeniceByokRemoteConfig(
  currentRemoteConfig: Record<string, unknown>,
  params: { model: string }
): Record<string, unknown> {
  const directBaseUrl = resolveProviderBaseUrl("venice") ?? "https://api.venice.ai/api/v1";
  return buildHermesWebConfigPayload(currentRemoteConfig, {
    model: params.model,
    provider: "custom",
    baseUrl: directBaseUrl,
  });
}

export function buildVeniceByokRuntimeEnvUpdates(params: {
  apiKey: string;
  model: string;
}): Record<string, string> {
  const directBaseUrl = resolveProviderBaseUrl("venice") ?? "https://api.venice.ai/api/v1";
  return {
    ...buildProviderEnvResetMap(),
    HERMES_INFERENCE_PROVIDER: "custom",
    OPENAI_API_KEY: params.apiKey,
    OPENAI_BASE_URL: directBaseUrl,
    // See buildManagedVeniceRuntimeEnvUpdates: the resolver derives VENICE_API_KEY
    // from the venice.ai host, so set it (and base url) too — otherwise resumed
    // sessions 401 with "no-key-required" even though new chats work.
    VENICE_API_KEY: params.apiKey,
    VENICE_BASE_URL: directBaseUrl,
    // HERMES_MODEL scrubbed ("") not pinned — config.yaml (buildVeniceByokRemoteConfig)
    // owns the model; pinning it re-detects a native keyless provider from the model
    // name and bricks chat. Empty value => removed from .env by buildEnvPatchCommand,
    // healing any legacy pin on BYOK switch-back. Mirrors #204 / buildHermesEnvFile.
    HERMES_MODEL: "",
    HERMES_WEBUI_DEFAULT_MODEL: params.model,
    // Empty values are removed from .env by buildEnvPatchCommand, so this
    // strips the managed top-up nudge URL that hermes-agent surfaces to
    // WebUI when calls 402 with insufficient managed credits.
    HERMES_MANAGED_VENICE_ENABLE_URL: "",
  };
}

async function applyVeniceByokToRunningWebUI(params: {
  instanceId: string;
  userId: string;
  ip: string;
  apiKey: string;
  model: string;
  hermesHomeDir: string;
  apiFactory: AgentWebApiFactory;
  putConfig: PutConfig;
  ssh: SshExec;
}) {
  const api: AgentWebApiClient = await params.apiFactory(params.instanceId, params.userId);
  const configRes = await api.get("/api/config", { timeout: 20_000 });
  if (!configRes.ok) {
    const errText = await configRes.text().catch(() => configRes.statusText);
    throw new Error(`Agent config fetch returned ${configRes.status}: ${errText}`);
  }

  const currentConfig = (await configRes.json()) as Record<string, unknown>;
  const nextConfig = buildVeniceByokRemoteConfig(currentConfig, { model: params.model });

  await params.putConfig({
    api,
    config: nextConfig,
    containerName: `agent-${sanitizeDockerName(params.instanceId)}`,
    hermesHomeDir: params.hermesHomeDir,
    ip: params.ip,
    instanceId: params.instanceId,
    userId: params.userId,
    timeoutMs: 20_000,
  });

  const envUpdates = buildVeniceByokRuntimeEnvUpdates({
    apiKey: params.apiKey,
    model: params.model,
  });
  const envPatch = ProfileService.buildEnvPatchCommand(
    `/opt/hermes/instances/${params.instanceId}/.env`,
    envUpdates
  ).trim();

  const result = await params.ssh(
    params.ip,
    `set -e
${envPatch}
cd /opt/hermes/instances/${params.instanceId}
docker compose up -d --force-recreate 2>&1 | tail -5`,
    { timeoutMs: 45_000 }
  );

  if (!result.ok) {
    throw new Error(
      result.error ||
        redactSensitiveCommandOutput(result.stderr || "", 800) ||
        "BYOK Venice WebUI env update failed"
    );
  }
}

type RevokeProxyKey = typeof revokeManagedVeniceProxyKey;

interface ManagedVeniceDisableDeps {
  db?: SupabaseLike | null;
  now?: () => Date;
  revokeProxyKey?: RevokeProxyKey;
  getSecureInstance?: GetSecureInstance;
  agentWebApiFactory?: AgentWebApiFactory;
  putConfig?: PutConfig;
  ssh?: SshExec;
}

export async function disableManagedVeniceForWebUIInstance(
  params: {
    instanceId: string;
    userId: string;
    apiKey: string;
    model?: string | null;
    apply?: boolean;
  },
  deps: ManagedVeniceDisableDeps = {}
) {
  const trimmedKey = params.apiKey?.trim() || "";
  if (!trimmedKey) {
    throw new ManagedVeniceEnableError(
      "Provide your Venice API key to switch this agent to bring-your-own.",
      { status: 400, failureType: "managed_venice_byok_key_missing" }
    );
  }
  // Reject a managed proxy key passed as if it were the user's BYOK key.
  // Without this guard the user would land in exactly the situation we're
  // trying to fix (still routed through /api/managed-venice/v1).
  if (trimmedKey.startsWith("hven_live_")) {
    throw new ManagedVeniceEnableError(
      "That looks like a Hivra managed proxy key, not a Venice API key. Get your real key from venice.ai/settings/api.",
      { status: 400, failureType: "managed_venice_byok_key_invalid_shape" }
    );
  }

  const db = requireDb(deps.db ?? supabaseAdmin);
  const now = deps.now ?? (() => new Date());
  const instance = await loadInstanceForEnable(db, params);
  const config = readRecord(instance.config);

  if (!isWebfreeBackend(instance.backend)) {
    throw new ManagedVeniceEnableError(
      "Managed Venice can be switched off from the dashboard for WebUI agents only.",
      { status: 400, failureType: "managed_venice_requires_webui" }
    );
  }

  const currentManagedVenice = readManagedVeniceConfig(config);
  const currentManagedVeniceRecord = readRecord(config.managedVenice);
  const proxyKeyId =
    typeof currentManagedVeniceRecord.proxyKeyId === "string"
      ? currentManagedVeniceRecord.proxyKeyId.trim() || null
      : null;
  // The customer provision path never wrote the config.managedVenice marker
  // (0 of 181 prod instances ever carried it), so this gate rejected 100% of
  // genuinely-managed boxes and the off-ramp was dead on arrival. Routing
  // already treats the hven_ proxy key / managed-proxy base URL as the source
  // of truth for "this box is on managed Venice" (see resolveProviderBaseUrl).
  // Detect it the same way here so a real managed box can actually be released.
  const storedKeyIsManagedProxy = isManagedVeniceProxyKey(
    decryptStoredApiKey(instance.api_key_encrypted)
  );
  const customUrlIsManagedProxy = isManagedVeniceProxyBaseUrl(
    readRecord(config.agentSettings).customLlmBaseUrl
  );
  if (
    !currentManagedVenice.enabled &&
    !proxyKeyId &&
    !storedKeyIsManagedProxy &&
    !customUrlIsManagedProxy
  ) {
    throw new ManagedVeniceEnableError(
      "This agent is not running on managed Venice.",
      { status: 400, failureType: "managed_venice_byok_not_enabled" }
    );
  }

  const model = resolveManagedVeniceModel(params.model, config);
  const updatedAt = now().toISOString();
  const nextConfig = buildVeniceByokStoredInstanceConfig(config, { model });

  // Revoke the managed proxy key first so a stale .env (worst case: the SSH
  // patch below fails halfway) can't keep billing the user's managed wallet.
  // Revocation is idempotent for status; if it fails we still proceed —
  // the DB row gets re-keyed below, so the old key stops being looked up
  // anyway.
  if (proxyKeyId) {
    try {
      await (deps.revokeProxyKey ?? revokeManagedVeniceProxyKey)({
        userId: params.userId,
        keyId: proxyKeyId,
      });
    } catch (error) {
      log.warn("managed Venice proxy key revoke failed during BYOK switch; continuing", {
        source: LOG_SOURCE,
        failureType: "managed_venice_byok_proxy_revoke_failed",
        userId: params.userId,
        instanceId: params.instanceId,
        proxyKeyId,
      }, error);
    }
  }

  const { data: updated, error: updateError } = await table(db, "hermes_instances")
    .update({
      provider: "venice",
      api_key_encrypted: encryptApiKey(trimmedKey),
      api_key_preview: formatStoredProviderSecretPreview("venice", trimmedKey),
      config: nextConfig,
      updated_at: updatedAt,
    })
    .eq("id", params.instanceId)
    .eq("user_id", params.userId)
    .select("*")
    .single<ManagedVeniceEnableInstanceRow>();

  if (updateError || !updated) {
    log.error("managed Venice → BYOK persistence failed", updateError, {
      source: LOG_SOURCE,
      failureType: "managed_venice_instance_update_failed",
      userId: params.userId,
      instanceId: params.instanceId,
    });
    throw new ManagedVeniceEnableError(
      "BYOK Venice settings could not be saved.",
      { status: 500, failureType: "managed_venice_instance_update_failed" }
    );
  }

  let applied = false;
  let applyError: string | null = null;
  if (params.apply !== false) {
    if (instance.status !== "running") {
      applyError =
        "Switched to bring-your-own Venice, but the agent is not running so the live container was not updated yet.";
    } else {
      try {
        const secure = (await (deps.getSecureInstance ?? getSecureUserInstance)({
          id: params.instanceId,
          userId: params.userId,
          requireRunning: true,
        })) as SecureUserInstanceResult;

        if (secure.error || !secure.instance || !secure.instanceIpv4) {
          throw new Error(secure.error || "Instance host address was not available");
        }

        await applyVeniceByokToRunningWebUI({
          instanceId: params.instanceId,
          userId: params.userId,
          ip: secure.instanceIpv4,
          apiKey: trimmedKey,
          model,
          hermesHomeDir: resolveHermesHomeDirFromConfig(config),
          apiFactory: deps.agentWebApiFactory ?? agentWebApi,
          putConfig: deps.putConfig ?? putHermesConfigWithBindMountFallback,
          ssh: deps.ssh ?? sshExec,
        });
        applied = true;
      } catch (error) {
        applyError =
          error instanceof Error
            ? error.message
            : "BYOK Venice settings were saved, but the live WebUI update failed.";
        log.error("managed Venice → BYOK live WebUI apply failed", error, {
          source: LOG_SOURCE,
          failureType: "managed_venice_live_apply_failed",
          userId: params.userId,
          instanceId: params.instanceId,
        });
      }
    }
  }

  return {
    instance: updated,
    applied,
    applyError,
    byokVenice: {
      enabled: true,
      model,
      keyPrefix: keyPrefix(trimmedKey),
      previouslyManagedProxyKeyId: proxyKeyId,
    },
  };
}
