import { SettingsValidationError } from "@/lib/api-errors";
import { decryptApiKey, encryptApiKey } from "@/lib/crypto";
import type { AgentSettings, HonchoSettings } from "@/lib/services/hetzner-instance-service";
import { normalizeModelValue } from "@/lib/models";
import { getPublicTailscaleConfig, type TailscaleConfig } from "@/lib/private-access/tailscale";
import { checkOutboundUrlSafety } from "@/lib/url-safety";

// ─── Terminal Backend ────────────────────────────────────────────────────────

/**
 * Where the agent's shell tool executes commands.
 *
 *  - `local`   — in the agent container (default; the box is already an isolated VM)
 *  - `docker`  — a throwaway container per command via the host docker socket.
 *                Requires root mode (that's what mounts the socket + runs as
 *                root); docker-cli is bundled in the agent image.
 *  - `modal`   — managed Modal cloud sandbox via the Nous tool gateway (no root,
 *                no BYO key; needs the gateway reachable).
 *  - `daytona` — Daytona cloud sandbox (no root; BYO DAYTONA_API_KEY).
 *
 * A backend that can't start degrades to `local` with a warning rather than
 * disabling the shell (agent-side never-brick fallback), so selecting one is safe.
 */
export const TERMINAL_BACKENDS = ["local", "docker", "modal", "daytona"] as const;
export type TerminalBackend = (typeof TERMINAL_BACKENDS)[number];

/** Coerce any input to a valid backend, defaulting to the safe `local`. */
function normalizeTerminalBackend(value: unknown): TerminalBackend {
  return TERMINAL_BACKENDS.includes(value as TerminalBackend)
    ? (value as TerminalBackend)
    : "local";
}

// ─── Context engine ──────────────────────────────────────────────────────────
// The agent's context-management engine. "compressor" is the batch summarization
// default; "sliding" is the new streaming engine that leans on the cheap
// auxiliary.compression model. Emitted to the box config.yaml as context.engine.
export const CONTEXT_ENGINES = ["compressor", "sliding"] as const;
export type ContextEngine = (typeof CONTEXT_ENGINES)[number];

/** Coerce input to a valid context engine, or undefined to leave it unset. */
export function normalizeContextEngine(value: unknown): ContextEngine | undefined {
  return CONTEXT_ENGINES.includes(value as ContextEngine)
    ? (value as ContextEngine)
    : undefined;
}

// ─── Memory System Types ─────────────────────────────────────────────────────

type MemorySystemType =
  | "holographic"
  | "honcho"
  | "mem0"
  | "hindsight"
  | "openviking"
  | "retaindb"
  | "byterover"
  | "supermemory";

/**
 * Unified config for all 8 pluggable memory providers.
 * Each provider only uses its own fields — the rest are ignored at deploy time.
 * Secret fields are encrypted at rest (see buildStoredInstanceConfig).
 */
export interface MemorySystemConfig {
  provider: MemorySystemType;

  // ── Honcho ──────────────────────────────────────────────────────────────────
  honchoApiKey?: string;
  honchoApiKeyEncrypted?: string;
  honchoBaseUrl?: string;
  honchoMemoryMode?: string;
  honchoRecallMode?: string;
  honchoHeartbeatModel?: string;
  honchoEnabled?: boolean;
  hasHonchoApiKey?: boolean;

  // ── Mem0 ────────────────────────────────────────────────────────────────────
  mem0ApiKey?: string;
  mem0ApiKeyEncrypted?: string;
  mem0UserId?: string;
  mem0AgentId?: string;
  hasMem0ApiKey?: boolean;

  // ── Hindsight ────────────────────────────────────────────────────────────────
  hindsightMode?: "cloud" | "local";
  hindsightApiKey?: string;
  hindsightApiKeyEncrypted?: string;
  hindsightBankId?: string;
  hindsightBudget?: "low" | "mid" | "high";
  hindsightLlmApiKey?: string;
  hindsightLlmApiKeyEncrypted?: string;
  hindsightLlmProvider?: string;
  hindsightLlmModel?: string;
  hindsightLlmBaseUrl?: string;
  hasHindsightApiKey?: boolean;
  hasHindsightLlmApiKey?: boolean;

  // ── OpenViking ───────────────────────────────────────────────────────────────
  openVikingEndpoint?: string;
  openVikingApiKey?: string;
  openVikingApiKeyEncrypted?: string;
  hasOpenVikingApiKey?: boolean;

  // ── RetainDB ─────────────────────────────────────────────────────────────────
  retaindbApiKey?: string;
  retaindbApiKeyEncrypted?: string;
  retaindbBaseUrl?: string;
  retaindbProject?: string;
  hasRetaindbApiKey?: boolean;

  // ── ByteRover ────────────────────────────────────────────────────────────────
  brvApiKey?: string;
  brvApiKeyEncrypted?: string;
  hasBrvApiKey?: boolean;

  // ── Supermemory ──────────────────────────────────────────────────────────────
  supermemoryApiKey?: string;
  supermemoryApiKeyEncrypted?: string;
  supermemoryContainerTag?: string;
  hasSupermemoryApiKey?: boolean;

  // ── Holographic (local SQLite — no API keys) ─────────────────────────────────
  holographicAutoExtract?: boolean;
  holographicDefaultTrust?: number;
}

// ─── Internal stored shapes ──────────────────────────────────────────────────

type StoredAgentSettings = Omit<
  AgentSettings,
  "browserbaseApiKey" | "browserUseApiKey" | "tavilyApiKey" | "exaApiKey" | "firecrawlApiKey" | "subagentApiKey" | "daytonaApiKey"
> & {
  runtimeMode?: "managed" | "developer";
  systemPrompt?: string;
  browserbaseApiKey?: string;
  browserbaseApiKeyEncrypted?: string;
  browserUseApiKey?: string;
  browserUseApiKeyEncrypted?: string;
  tavilyApiKey?: string;
  tavilyApiKeyEncrypted?: string;
  exaApiKey?: string;
  exaApiKeyEncrypted?: string;
  firecrawlApiKey?: string;
  firecrawlApiKeyEncrypted?: string;
  subagentApiKey?: string;
  subagentApiKeyEncrypted?: string;
  subagentProvider?: string;
  fallbackModels?: string;
  hasBrowserbaseApiKey?: boolean;
  hasBrowserUseApiKey?: boolean;
  hasTavilyApiKey?: boolean;
  hasExaApiKey?: boolean;
  hasFirecrawlApiKey?: boolean;
  hasSubagentApiKey?: boolean;
  enableRootAccess?: boolean;
  // Terminal execution backend for the agent's shell tool. See TERMINAL_BACKENDS.
  terminalBackend?: TerminalBackend;
  // Daytona cloud-sandbox API key (BYO — from daytona.io). Stored encrypted at
  // rest like every other instance secret; surfaced to the UI only as the
  // hasDaytonaApiKey boolean, and emitted to the box .env as DAYTONA_API_KEY.
  daytonaApiKey?: string;
  daytonaApiKeyEncrypted?: string;
  hasDaytonaApiKey?: boolean;
  // Proxy fields
  browserProxyHost?: string;
  browserProxyPort?: string;
  browserProxyUsername?: string;
  browserProxyPassword?: string;
  browserProxyPasswordEncrypted?: string;
  hasBrowserProxyPassword?: boolean;
  customLlmBaseUrl?: string;
};

type StoredHonchoSettings = Omit<HonchoSettings, "apiKey">;

type SecretOps = {
  clearBrowserbaseApiKey?: boolean;
  clearBrowserUseApiKey?: boolean;
  clearTavilyApiKey?: boolean;
  clearExaApiKey?: boolean;
  clearFirecrawlApiKey?: boolean;
  clearSubagentApiKey?: boolean;
  clearBrowserProxyPassword?: boolean;
  clearDaytonaApiKey?: boolean;
};

export type A2ASettings = {
  enableAcp?: boolean;
  enableMcp?: boolean;
};

export interface AutoUpdateConfig {
  enabled?: boolean;
  time?: string;
}

type ConfigPatch = {
  model?: string;
  honcho?: Partial<StoredHonchoSettings>;
  agentSettings?: Partial<AgentSettings> & SecretOps;
  secretOps?: SecretOps;
  a2a?: A2ASettings;
  autoUpdate?: AutoUpdateConfig;
  memorySystem?: Partial<MemorySystemConfig>;
};

type StoredConfig = {
  model?: string;
  honcho?: StoredHonchoSettings;
  agentSettings?: StoredAgentSettings;
  a2a?: A2ASettings;
  autoUpdate?: AutoUpdateConfig;
  memorySystem?: MemorySystemConfig;
  privateAccess?: {
    tailscale?: TailscaleConfig;
  };
  [key: string]: unknown;
};

// ─── Defaults ────────────────────────────────────────────────────────────────

function defaultAgentSettings(): AgentSettings {
  return {
    runtimeMode: "managed",
    maxIterations: 60,
    toolProgressMode: "all",
    compressionThreshold: 0.85,
    sessionResetMode: "both",
    fastMode: false,
    gatewayTimeoutMins: 15,
    showInterimAssistantMessages: true,
    showToolCallsInChat: false,
    autoApproveToolCalls: false,
    browserProvider: "local",
    webUseGateway: false,
    imageGenUseGateway: false,
    ttsUseGateway: false,
    browserUseGateway: false,
    enableRootAccess: false,
    terminalBackend: "local",
  };
}

function defaultHonchoSettings(): StoredHonchoSettings {
  return {
    enabled: true,
    memoryMode: "hybrid",
    recallMode: "hybrid",
  };
}

export const DEFAULT_AUTO_UPDATE_ENABLED = true;
export const DEFAULT_AUTO_UPDATE_TIME = "06:00";
const AUTO_UPDATE_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

// ─── Crypto helpers ───────────────────────────────────────────────────────────

function decryptOptionalSecret(
  encryptedValue?: string,
  legacyPlaintextValue?: string
): string | undefined {
  if (encryptedValue) {
    try {
      return decryptApiKey(encryptedValue);
    } catch {
      return undefined;
    }
  }

  return typeof legacyPlaintextValue === "string" && legacyPlaintextValue.trim()
    ? legacyPlaintextValue.trim()
    : undefined;
}

// ─── Resolve helpers ──────────────────────────────────────────────────────────

function resolveStoredAgentSettings(config: Record<string, unknown> | undefined): StoredAgentSettings {
  const raw = (typeof config?.agentSettings === "object" && config.agentSettings
    ? config.agentSettings
    : {}) as StoredAgentSettings;

  const inferredRuntimeMode =
    raw.runtimeMode === "developer" ||
    raw.mountPersistentSource === true
      ? "developer"
      : "managed";

  return {
    ...defaultAgentSettings(),
    ...raw,
    runtimeMode: inferredRuntimeMode,
    mountPersistentSource: Boolean(raw.mountPersistentSource),
    enableRootAccess: Boolean(raw.enableRootAccess),
    // Advanced Cloud Access historically persisted only enableRootAccess. Those
    // rows gained the VM's Docker socket but kept the platform's implicit local
    // terminal override, which overruled a native `hermes config set
    // terminal.backend docker`. Treat only the missing legacy value as Docker;
    // an explicit local/modal/daytona choice remains authoritative.
    terminalBackend:
      raw.terminalBackend === undefined && raw.enableRootAccess === true
        ? "docker"
        : normalizeTerminalBackend(raw.terminalBackend),
  };
}

function resolveStoredHonchoSettings(config: Record<string, unknown> | undefined): StoredHonchoSettings {
  const raw = (typeof config?.honcho === "object" && config.honcho
    ? config.honcho
    : {}) as StoredHonchoSettings;

  return {
    ...defaultHonchoSettings(),
    ...raw,
  };
}

function resolveStoredMemorySystem(config: Record<string, unknown> | undefined): MemorySystemConfig | undefined {
  if (typeof config?.memorySystem !== "object" || !config.memorySystem) return undefined;
  return config.memorySystem as MemorySystemConfig;
}

export function normalizeAutoUpdateTime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return AUTO_UPDATE_TIME_PATTERN.test(trimmed) ? trimmed : undefined;
}

function resolveStoredAutoUpdate(config: Record<string, unknown> | undefined): AutoUpdateConfig | undefined {
  if (typeof config?.autoUpdate !== "object" || !config.autoUpdate) return undefined;

  const raw = config.autoUpdate as AutoUpdateConfig;
  return {
    enabled:
      typeof raw.enabled === "boolean"
        ? raw.enabled
        : DEFAULT_AUTO_UPDATE_ENABLED,
    time: normalizeAutoUpdateTime(raw.time) ?? DEFAULT_AUTO_UPDATE_TIME,
  };
}

export function getAutoUpdateConfig(config: Record<string, unknown> | undefined): AutoUpdateConfig {
  const stored = resolveStoredAutoUpdate(config);
  return {
    enabled: stored?.enabled ?? DEFAULT_AUTO_UPDATE_ENABLED,
    time: stored?.time ?? DEFAULT_AUTO_UPDATE_TIME,
  };
}

// ─── Custom LLM base URL safety ──────────────────────────────────────────────

/**
 * Trim and SSRF-validate a user-supplied custom LLM base URL before it gets
 * persisted to instance config. Empty / unset values are passed through —
 * the field is optional. Anything that points at loopback, link-local, or
 * cloud-metadata is rejected hard so the dashboard's outbound provider
 * fetches never end up at AWS IMDS / 127.0.0.1 / etc.
 *
 * Localhost is intentionally rejected: if a customer wants to point at a
 * local Ollama from their browser, they configure their machine, not a
 * server-side proxy. The platform's default Ollama URL
 * (resolveProviderBaseUrl("custom_llm")) keeps "http://localhost:11434/v1"
 * for local-dev unit tests; production overrides go through this checker.
 */
function validateCustomLlmBaseUrl(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) return "";

  const result = checkOutboundUrlSafety(trimmed);
  if (!result.ok) {
    throw new SettingsValidationError(
      `Custom LLM base URL is not allowed (${result.reason}). Use an https:// URL on a publicly reachable host.`
    );
  }
  return trimmed;
}

// ─── Memory system secrets to encrypt at rest ─────────────────────────────────

type MemorySecretKey = {
  plain: keyof MemorySystemConfig;
  encrypted: keyof MemorySystemConfig;
};

const MEMORY_SECRET_KEYS: MemorySecretKey[] = [
  { plain: "honchoApiKey",        encrypted: "honchoApiKeyEncrypted" },
  { plain: "mem0ApiKey",          encrypted: "mem0ApiKeyEncrypted" },
  { plain: "hindsightApiKey",     encrypted: "hindsightApiKeyEncrypted" },
  { plain: "hindsightLlmApiKey",  encrypted: "hindsightLlmApiKeyEncrypted" },
  { plain: "openVikingApiKey",    encrypted: "openVikingApiKeyEncrypted" },
  { plain: "retaindbApiKey",      encrypted: "retaindbApiKeyEncrypted" },
  { plain: "brvApiKey",           encrypted: "brvApiKeyEncrypted" },
  { plain: "supermemoryApiKey",   encrypted: "supermemoryApiKeyEncrypted" },
];

// Type alias used only inside these helpers to allow dynamic key writes.
// The cast is safe: we only set keys that are declared in MemorySystemConfig.
type MutableMemory = Record<string, unknown> & Pick<MemorySystemConfig, "provider">;

function encryptMemorySystemSecrets(
  current: MemorySystemConfig | undefined,
  patch: Partial<MemorySystemConfig>
): MemorySystemConfig {
  const merged = {
    ...(current || { provider: "honcho" as MemorySystemType }),
    ...patch,
  } as MutableMemory;

  for (const { plain, encrypted } of MEMORY_SECRET_KEYS) {
    const patchIncludesKey = Object.prototype.hasOwnProperty.call(patch, plain);
    const patchVal = patch[plain];
    if (patchIncludesKey && typeof patchVal === "string" && !patchVal.trim()) {
      delete merged[plain as string];
      delete merged[encrypted as string];
      continue;
    }

    const val = merged[plain as string];
    if (typeof val === "string" && val.trim()) {
      merged[encrypted as string] = encryptApiKey(val.trim());
      delete merged[plain as string];
    }
  }

  return merged as unknown as MemorySystemConfig;
}

/**
 * Decrypt all memory system secrets, returning the runtime-ready config.
 * Strips encrypted fields; callers receive plaintext keys ready to inject as env vars.
 */
export function decryptMemorySystemSecrets(
  stored: MemorySystemConfig | undefined
): MemorySystemConfig | undefined {
  if (!stored) return undefined;

  const result = { ...stored } as MutableMemory;

  for (const { plain, encrypted } of MEMORY_SECRET_KEYS) {
    const decrypted = decryptOptionalSecret(
      result[encrypted as string] as string | undefined,
      result[plain as string] as string | undefined
    );
    if (decrypted) {
      result[plain as string] = decrypted;
    }
    delete result[encrypted as string];
  }

  return result as unknown as MemorySystemConfig;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function buildAdvancedInstanceConfigPayload(
  currentConfig: Record<string, unknown> | undefined,
  patchDto: ConfigPatch & Record<string, unknown>
): StoredConfig {
  const { model, honcho, agentSettings, a2a, autoUpdate, memorySystem, configMode, heartbeatModel } = patchDto;

  const normalizedFallbackModels = typeof agentSettings?.fallbackModels === "string"
    ? (() => {
        try {
          const parsed = JSON.parse(agentSettings.fallbackModels);
          if (!Array.isArray(parsed)) return agentSettings.fallbackModels;
          return JSON.stringify(
            parsed.map((item: { provider?: string; model?: string; apiKey?: string }) => ({
              ...item,
              ...(typeof item.model === "string"
                ? { model: normalizeModelValue(item.model, item.provider || "openrouter") }
                : {}),
            }))
          );
        } catch {
          return agentSettings.fallbackModels;
        }
      })()
    : undefined;

  const normalizedSubagentModel = typeof agentSettings?.subagentModel === "string"
    ? (() => {
        const raw = agentSettings.subagentModel.trim();
        if (!raw) return raw;
        const separatorIndex = raw.indexOf(":");
        if (separatorIndex === -1) {
          return normalizeModelValue(raw, agentSettings.subagentProvider);
        }
        const subagentProvider = agentSettings.subagentProvider || raw.slice(0, separatorIndex);
        const subagentModel = raw.slice(separatorIndex + 1);
        return `${subagentProvider}:${normalizeModelValue(subagentModel, subagentProvider)}`;
      })()
    : undefined;

  // Auxiliary compression model. A bare model id (no provider prefix) — the
  // provider is carried separately in compressionProvider. An empty string is a
  // valid "clear back to inherit-main" signal (mirrors systemPrompt), so we keep
  // it a string rather than dropping it.
  const normalizedCompressionModel = typeof agentSettings?.compressionModel === "string"
    ? (() => {
        const raw = agentSettings.compressionModel.trim();
        if (!raw) return raw;
        return normalizeModelValue(raw, agentSettings.compressionProvider);
      })()
    : undefined;

  const honchoPatch = honcho ? {
    ...(typeof honcho.enabled === "boolean" ? { enabled: honcho.enabled } : {}),
    ...(typeof honcho.baseUrl === "string" ? { baseUrl: honcho.baseUrl.trim() } : {}),
    ...(typeof honcho.peerName === "string" ? { peerName: honcho.peerName.trim() } : {}),
    ...(typeof honcho.aiPeer === "string" ? { aiPeer: honcho.aiPeer.trim() } : {}),
    ...(honcho.memoryMode ? { memoryMode: honcho.memoryMode } : {}),
    ...(honcho.recallMode ? { recallMode: honcho.recallMode } : {}),
    configMode: (configMode || (currentConfig?.honcho as Record<string, unknown>)?.configMode || "simple") as "simple" | "advanced",
    heartbeatModel: (heartbeatModel || (currentConfig?.honcho as Record<string, unknown>)?.heartbeatModel) as string | undefined,
  } : undefined;

  const agentSettingsPatch = agentSettings ? {
    ...(agentSettings.runtimeMode ? { runtimeMode: agentSettings.runtimeMode } : {}),
    ...(typeof agentSettings.maxIterations === "number" ? { maxIterations: agentSettings.maxIterations } : {}),
    ...(agentSettings.toolProgressMode ? { toolProgressMode: agentSettings.toolProgressMode } : {}),
    ...(typeof agentSettings.compressionThreshold === "number" ? { compressionThreshold: agentSettings.compressionThreshold } : {}),
    ...(agentSettings.sessionResetMode ? { sessionResetMode: agentSettings.sessionResetMode } : {}),
    ...(typeof agentSettings.fastMode === "boolean" ? { fastMode: agentSettings.fastMode } : {}),
    ...(typeof agentSettings.gatewayTimeoutMins === "number" ? { gatewayTimeoutMins: agentSettings.gatewayTimeoutMins } : {}),
    ...(typeof agentSettings.showInterimAssistantMessages === "boolean" ? { showInterimAssistantMessages: agentSettings.showInterimAssistantMessages } : {}),
    ...(typeof agentSettings.showToolCallsInChat === "boolean" ? { showToolCallsInChat: agentSettings.showToolCallsInChat } : {}),
    ...(typeof agentSettings.autoApproveToolCalls === "boolean" ? { autoApproveToolCalls: agentSettings.autoApproveToolCalls } : {}),
    // Carry the welcome-flow / settings system prompt through to stored config so
    // getRuntimeAgentSettings can hand it to the builder (→ SOUL.md). Passed through
    // verbatim (no trim): it's freeform multi-line text, and an empty string is a
    // valid "clear the prompt" signal, matching the typeof guard used by other fields.
    ...(typeof agentSettings.systemPrompt === "string" ? { systemPrompt: agentSettings.systemPrompt } : {}),
    ...(agentSettings.browserProvider ? { browserProvider: agentSettings.browserProvider } : {}),
    ...(typeof agentSettings.browserSidecarEnabled === "boolean" ? { browserSidecarEnabled: agentSettings.browserSidecarEnabled } : {}),
    ...(typeof agentSettings.enableSearxng === "boolean" ? { enableSearxng: agentSettings.enableSearxng } : {}),
    ...(typeof agentSettings.browserbaseProjectId === "string" ? { browserbaseProjectId: agentSettings.browserbaseProjectId.trim() } : {}),
    ...(typeof agentSettings.browserbaseApiKey === "string" ? { browserbaseApiKey: agentSettings.browserbaseApiKey } : {}),
    ...(typeof agentSettings.browserUseApiKey === "string" ? { browserUseApiKey: agentSettings.browserUseApiKey } : {}),
    ...(typeof agentSettings.tavilyApiKey === "string" ? { tavilyApiKey: agentSettings.tavilyApiKey } : {}),
    ...(typeof agentSettings.exaApiKey === "string" ? { exaApiKey: agentSettings.exaApiKey } : {}),
    ...(typeof agentSettings.firecrawlApiKey === "string" ? { firecrawlApiKey: agentSettings.firecrawlApiKey } : {}),
    // Pass verbatim (no .trim()) — the API_KEYS loop in buildStoredInstanceConfig
    // trims + encrypts. This allowlist is explicit: without this line the key is
    // dropped here and never reaches that loop, so the save would "succeed" while
    // silently doing nothing.
    ...(typeof agentSettings.daytonaApiKey === "string" ? { daytonaApiKey: agentSettings.daytonaApiKey } : {}),
    ...(typeof agentSettings.webUseGateway === "boolean" ? { webUseGateway: agentSettings.webUseGateway } : {}),
    ...(typeof agentSettings.imageGenUseGateway === "boolean" ? { imageGenUseGateway: agentSettings.imageGenUseGateway } : {}),
    ...(typeof agentSettings.ttsUseGateway === "boolean" ? { ttsUseGateway: agentSettings.ttsUseGateway } : {}),
    ...(typeof agentSettings.browserUseGateway === "boolean" ? { browserUseGateway: agentSettings.browserUseGateway } : {}),
    ...(typeof normalizedFallbackModels === "string" ? { fallbackModels: normalizedFallbackModels } : {}),
    ...(typeof agentSettings.subagentProvider === "string" ? { subagentProvider: agentSettings.subagentProvider.trim() } : {}),
    ...(typeof normalizedSubagentModel === "string" ? { subagentModel: normalizedSubagentModel } : {}),
    ...(typeof agentSettings.subagentApiKey === "string" ? { subagentApiKey: agentSettings.subagentApiKey } : {}),
    // Auxiliary compression model + context engine. Non-secret, so they ride the
    // plain allowlist (no encrypt loop). An empty compressionProvider/Model is a
    // valid "inherit main" signal, so trim-and-store rather than drop.
    ...(typeof agentSettings.compressionProvider === "string" ? { compressionProvider: agentSettings.compressionProvider.trim() } : {}),
    ...(typeof normalizedCompressionModel === "string" ? { compressionModel: normalizedCompressionModel } : {}),
    ...(normalizeContextEngine(agentSettings.contextEngine) ? { contextEngine: normalizeContextEngine(agentSettings.contextEngine) } : {}),
    ...(typeof agentSettings.mountPersistentSource === "boolean" ? { mountPersistentSource: agentSettings.mountPersistentSource } : {}),
    ...(typeof agentSettings.enableRootAccess === "boolean" ? { enableRootAccess: agentSettings.enableRootAccess } : {}),
    ...(TERMINAL_BACKENDS.includes(agentSettings.terminalBackend as TerminalBackend) ? { terminalBackend: agentSettings.terminalBackend } : {}),
    ...(typeof agentSettings.browserProxyHost === "string" ? { browserProxyHost: agentSettings.browserProxyHost.trim() } : {}),
    ...(typeof agentSettings.browserProxyPort === "string" ? { browserProxyPort: agentSettings.browserProxyPort.trim() } : {}),
    ...(typeof agentSettings.browserProxyUsername === "string" ? { browserProxyUsername: agentSettings.browserProxyUsername.trim() } : {}),
    ...(typeof agentSettings.browserProxyPassword === "string" ? { browserProxyPassword: agentSettings.browserProxyPassword } : {}),
    ...(typeof agentSettings.customLlmBaseUrl === "string" ? { customLlmBaseUrl: validateCustomLlmBaseUrl(agentSettings.customLlmBaseUrl) } : {}),
  } : undefined;

  const secretOps = agentSettings ? {
    clearBrowserbaseApiKey: agentSettings.clearBrowserbaseApiKey,
    clearBrowserUseApiKey: agentSettings.clearBrowserUseApiKey,
    clearTavilyApiKey: agentSettings.clearTavilyApiKey,
    clearExaApiKey: agentSettings.clearExaApiKey,
    clearFirecrawlApiKey: agentSettings.clearFirecrawlApiKey,
    clearDaytonaApiKey: agentSettings.clearDaytonaApiKey,
    clearSubagentApiKey: agentSettings.clearSubagentApiKey,
    clearBrowserProxyPassword: agentSettings.clearBrowserProxyPassword,
  } : undefined;

  const a2aPatch = a2a ? {
    ...(typeof a2a.enableAcp === "boolean" ? { enableAcp: a2a.enableAcp } : {}),
    ...(typeof a2a.enableMcp === "boolean" ? { enableMcp: a2a.enableMcp } : {}),
  } : undefined;

  const autoUpdatePatch = autoUpdate ? {
    ...(typeof autoUpdate.enabled === "boolean" ? { enabled: autoUpdate.enabled } : {}),
    ...(typeof autoUpdate.time === "string"
      ? { time: normalizeAutoUpdateTime(autoUpdate.time) ?? DEFAULT_AUTO_UPDATE_TIME }
      : {}),
  } : undefined;

  return buildStoredInstanceConfig(currentConfig, {
    ...(typeof model === "string" ? { model: normalizeModelValue(model) } : {}),
    ...(memorySystem ? { memorySystem: memorySystem as Record<string, unknown> } : {}),
    honcho: honchoPatch,
    agentSettings: agentSettingsPatch,
    secretOps,
    a2a: a2aPatch,
    autoUpdate: autoUpdatePatch,
  });
}

export function buildStoredInstanceConfig(
  currentConfig: Record<string, unknown> | undefined,
  patch: ConfigPatch
): StoredConfig {
  const currentAgentSettings = resolveStoredAgentSettings(currentConfig);
  const currentHonchoSettings = resolveStoredHonchoSettings(currentConfig);
  const currentAutoUpdate = resolveStoredAutoUpdate(currentConfig);
  const currentMemorySystem = resolveStoredMemorySystem(currentConfig);

  const nextAgentSettings: StoredAgentSettings = {
    ...currentAgentSettings,
    ...(patch.agentSettings || {}),
  };

  if (patch.agentSettings?.runtimeMode === "managed") {
    nextAgentSettings.runtimeMode = "managed";
    nextAgentSettings.mountPersistentSource = false;
  } else if (patch.agentSettings?.runtimeMode === "developer") {
    nextAgentSettings.runtimeMode = "developer";
  } else {
    nextAgentSettings.runtimeMode = nextAgentSettings.mountPersistentSource
      ? "developer"
      : "managed";
  }

  nextAgentSettings.enableRootAccess = Boolean(nextAgentSettings.enableRootAccess);
  nextAgentSettings.terminalBackend = normalizeTerminalBackend(nextAgentSettings.terminalBackend);

  const secretOps = patch.secretOps || {};

  const API_KEYS = ["browserbaseApiKey", "browserUseApiKey", "tavilyApiKey", "exaApiKey", "firecrawlApiKey", "subagentApiKey", "browserProxyPassword", "daytonaApiKey"] as const;
  for (const key of API_KEYS) {
    const val = patch.agentSettings?.[key];
    const encryptedKey = `${key}Encrypted` as keyof StoredAgentSettings;
    const clearFlag = `clear${key.charAt(0).toUpperCase()}${key.slice(1)}` as keyof SecretOps;

    if (typeof val === "string" && val.trim()) {
      (nextAgentSettings as Record<string, unknown>)[encryptedKey] = encryptApiKey(val.trim());
      delete nextAgentSettings[key];
    } else if (secretOps[clearFlag]) {
      delete nextAgentSettings[key];
      delete nextAgentSettings[encryptedKey];
    }
  }

  // Build next memory system config (encrypt secrets)
  const nextMemorySystem: MemorySystemConfig | undefined = patch.memorySystem
    ? encryptMemorySystemSecrets(currentMemorySystem, patch.memorySystem)
    : currentMemorySystem;
  const nextAutoUpdate = patch.autoUpdate
    ? {
        enabled:
          patch.autoUpdate.enabled ??
          currentAutoUpdate?.enabled ??
          DEFAULT_AUTO_UPDATE_ENABLED,
        time:
          normalizeAutoUpdateTime(patch.autoUpdate.time) ??
          currentAutoUpdate?.time ??
          DEFAULT_AUTO_UPDATE_TIME,
      }
    : currentAutoUpdate;

  const mergedConfig: StoredConfig = {
    ...(currentConfig || {}),
    ...(typeof patch.model === "string" ? { model: patch.model.trim() || undefined } : {}),
    honcho: {
      ...currentHonchoSettings,
      ...(patch.honcho || {}),
    },
    agentSettings: nextAgentSettings,
    ...(patch.a2a ? { a2a: { ...(currentConfig?.a2a as A2ASettings || {}), ...patch.a2a } } : {}),
    ...(nextAutoUpdate ? { autoUpdate: nextAutoUpdate } : {}),
    ...(nextMemorySystem ? { memorySystem: nextMemorySystem } : {}),
  };

  return mergedConfig;
}

export function getRuntimeAgentSettings(config: Record<string, unknown> | undefined): AgentSettings {
  const stored = resolveStoredAgentSettings(config);

  return {
    runtimeMode: stored.runtimeMode,
    maxIterations: stored.maxIterations,
    toolProgressMode: stored.toolProgressMode,
    compressionThreshold: stored.compressionThreshold,
    sessionResetMode: stored.sessionResetMode,
    fastMode: stored.fastMode ?? false,
    gatewayTimeoutMins: stored.gatewayTimeoutMins,
    showInterimAssistantMessages: stored.showInterimAssistantMessages ?? true,
    showToolCallsInChat: stored.showToolCallsInChat ?? false,
    autoApproveToolCalls: stored.autoApproveToolCalls ?? false,
    systemPrompt: stored.systemPrompt,
    browserProvider: stored.browserProvider,
    browserSidecarEnabled: stored.browserSidecarEnabled,
    enableSearxng: stored.enableSearxng,
    browserbaseProjectId: stored.browserbaseProjectId,
    subagentModel: stored.subagentModel,
    browserbaseApiKey: decryptOptionalSecret(
      stored.browserbaseApiKeyEncrypted,
      stored.browserbaseApiKey
    ),
    browserUseApiKey: decryptOptionalSecret(
      stored.browserUseApiKeyEncrypted,
      stored.browserUseApiKey
    ),
    tavilyApiKey: decryptOptionalSecret(
      stored.tavilyApiKeyEncrypted,
      stored.tavilyApiKey
    ),
    exaApiKey: decryptOptionalSecret(
      stored.exaApiKeyEncrypted,
      stored.exaApiKey
    ),
    firecrawlApiKey: decryptOptionalSecret(
      stored.firecrawlApiKeyEncrypted,
      stored.firecrawlApiKey
    ),
    webUseGateway: stored.webUseGateway ?? false,
    imageGenUseGateway: stored.imageGenUseGateway ?? false,
    ttsUseGateway: stored.ttsUseGateway ?? false,
    browserUseGateway: stored.browserUseGateway ?? false,
    subagentProvider: stored.subagentProvider,
    subagentApiKey: decryptOptionalSecret(
      stored.subagentApiKeyEncrypted,
      stored.subagentApiKey
    ),
    // Auxiliary compression model + context engine — plain (non-secret) fields
    // handed to the box config builder verbatim.
    compressionProvider: stored.compressionProvider,
    compressionModel: stored.compressionModel,
    contextEngine: stored.contextEngine,
    fallbackModels: stored.fallbackModels,
    mountPersistentSource: stored.mountPersistentSource,
    enableRootAccess: stored.enableRootAccess,
    terminalBackend: stored.terminalBackend,
    daytonaApiKey: decryptOptionalSecret(
      stored.daytonaApiKeyEncrypted,
      stored.daytonaApiKey
    ),
    // Proxy fields — password decrypted from encrypted storage
    browserProxyHost: stored.browserProxyHost,
    browserProxyPort: stored.browserProxyPort,
    browserProxyUsername: stored.browserProxyUsername,
    browserProxyPassword: decryptOptionalSecret(
      stored.browserProxyPasswordEncrypted,
      stored.browserProxyPassword
    ),
    customLlmBaseUrl: stored.customLlmBaseUrl,
  };
}

export function getPublicInstanceConfig(config: Record<string, unknown> | undefined): StoredConfig {
  const stored = buildStoredInstanceConfig(config, {});
  const agentSettings = resolveStoredAgentSettings(stored);
  const memorySystem = resolveStoredMemorySystem(stored);
  const publicTailscaleConfig = getPublicTailscaleConfig(stored.privateAccess?.tailscale);

  // Build a public-safe (no plaintext secrets) memory system config with has* flags
  let publicMemorySystem: MemorySystemConfig | undefined;
  if (memorySystem) {
    const safe = { ...memorySystem } as MutableMemory;
    const secretHasMap: Array<{ plain: string; encrypted: string; has: string }> = [
      { plain: "honchoApiKey",       encrypted: "honchoApiKeyEncrypted",        has: "hasHonchoApiKey" },
      { plain: "mem0ApiKey",         encrypted: "mem0ApiKeyEncrypted",          has: "hasMem0ApiKey" },
      { plain: "hindsightApiKey",    encrypted: "hindsightApiKeyEncrypted",     has: "hasHindsightApiKey" },
      { plain: "hindsightLlmApiKey", encrypted: "hindsightLlmApiKeyEncrypted",  has: "hasHindsightLlmApiKey" },
      { plain: "openVikingApiKey",   encrypted: "openVikingApiKeyEncrypted",    has: "hasOpenVikingApiKey" },
      { plain: "retaindbApiKey",     encrypted: "retaindbApiKeyEncrypted",      has: "hasRetaindbApiKey" },
      { plain: "brvApiKey",          encrypted: "brvApiKeyEncrypted",           has: "hasBrvApiKey" },
      { plain: "supermemoryApiKey",  encrypted: "supermemoryApiKeyEncrypted",   has: "hasSupermemoryApiKey" },
    ];
    for (const { plain, encrypted, has } of secretHasMap) {
      safe[has] = Boolean(safe[encrypted] || safe[plain]);
      delete safe[plain];
      delete safe[encrypted];
    }
    publicMemorySystem = safe as unknown as MemorySystemConfig;
  }

  return {
    ...stored,
    agentSettings: {
      ...agentSettings,
      hasBrowserbaseApiKey: Boolean(
        agentSettings.browserbaseApiKeyEncrypted || agentSettings.browserbaseApiKey
      ),
      hasBrowserUseApiKey: Boolean(
        agentSettings.browserUseApiKeyEncrypted || agentSettings.browserUseApiKey
      ),
      hasTavilyApiKey: Boolean(
        agentSettings.tavilyApiKeyEncrypted || agentSettings.tavilyApiKey
      ),
      hasExaApiKey: Boolean(
        agentSettings.exaApiKeyEncrypted || agentSettings.exaApiKey
      ),
      hasFirecrawlApiKey: Boolean(
        agentSettings.firecrawlApiKeyEncrypted || agentSettings.firecrawlApiKey
      ),
      hasSubagentApiKey: Boolean(
        agentSettings.subagentApiKeyEncrypted || agentSettings.subagentApiKey
      ),
      hasBrowserProxyPassword: Boolean(
        agentSettings.browserProxyPasswordEncrypted || agentSettings.browserProxyPassword
      ),
      hasDaytonaApiKey: Boolean(
        agentSettings.daytonaApiKeyEncrypted || agentSettings.daytonaApiKey
      ),
      browserbaseApiKey: undefined,
      browserbaseApiKeyEncrypted: undefined,
      browserUseApiKey: undefined,
      browserUseApiKeyEncrypted: undefined,
      tavilyApiKey: undefined,
      tavilyApiKeyEncrypted: undefined,
      exaApiKey: undefined,
      exaApiKeyEncrypted: undefined,
      firecrawlApiKey: undefined,
      firecrawlApiKeyEncrypted: undefined,
      subagentApiKey: undefined,
      subagentApiKeyEncrypted: undefined,
      browserProxyPassword: undefined,
      browserProxyPasswordEncrypted: undefined,
      daytonaApiKey: undefined,
      daytonaApiKeyEncrypted: undefined,
    },
    ...(publicMemorySystem ? { memorySystem: publicMemorySystem } : {}),
    ...(publicTailscaleConfig
      ? {
          privateAccess: {
            ...(typeof stored.privateAccess === "object" && stored.privateAccess
              ? stored.privateAccess
              : {}),
            tailscale: publicTailscaleConfig,
          },
        }
      : {}),
  };
}

export type GlobalHermesSettings = {
  sessionExpiryHours?: number;
  memoryContextLimit?: number;
  userContextLimit?: number;
};

export function extractGlobalHermesSettings(userPublicMetadata: Record<string, unknown> | undefined | null): GlobalHermesSettings {
  if (!userPublicMetadata) return {};
  
  const rawSettings = (userPublicMetadata.hermesSettings as Record<string, unknown>) || {};
  
  return {
    sessionExpiryHours: typeof rawSettings.sessionExpiryHours === "number" ? rawSettings.sessionExpiryHours : undefined,
    memoryContextLimit: typeof rawSettings.memoryContextLimit === "number" ? rawSettings.memoryContextLimit : undefined,
    userContextLimit: typeof rawSettings.userContextLimit === "number" ? rawSettings.userContextLimit : undefined,
  };
}
