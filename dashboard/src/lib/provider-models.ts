export interface ProviderModelOption {
  value: string;
  label: string;
}

interface LiveModelStatusMessageOptions {
  provider: string;
  isLoading: boolean;
  hasLiveModels: boolean;
  error?: string | null;
  supportsPublicModels: boolean;
  loadingMessage?: string;
  missingKeyMessage?: string;
}

interface ProviderModelEndpointConfig {
  authenticatedUrl?: string;
  publicUrl?: string;
  authMode?: "bearer" | "googleApiKeyQuery";
}

const PROVIDER_MODEL_ENDPOINTS: Record<string, ProviderModelEndpointConfig> = {
  openai: {
    authenticatedUrl: "https://api.openai.com/v1/models",
  },
  openrouter: {
    authenticatedUrl: "https://openrouter.ai/api/v1/models/user",
    publicUrl: "https://openrouter.ai/api/v1/models",
  },
  nous: {
    authenticatedUrl: "https://inference-api.nousresearch.com/v1/models",
    publicUrl: "https://inference-api.nousresearch.com/v1/models",
  },
  "nous-portal": {
    authenticatedUrl: "https://inference-api.nousresearch.com/v1/models",
    publicUrl: "https://inference-api.nousresearch.com/v1/models",
  },
  venice: {
    authenticatedUrl: "https://api.venice.ai/api/v1/models",
    publicUrl: "https://api.venice.ai/api/v1/models",
  },
  bankr: {
    authenticatedUrl: "https://llm.bankr.bot/v1/models",
  },
  crof: {
    authenticatedUrl: "https://crof.ai/v1/models",
    publicUrl: "https://crof.ai/v1/models",
  },
  cometapi: {
    authenticatedUrl: "https://api.cometapi.com/api/models",
    publicUrl: "https://api.cometapi.com/api/models",
  },
  gemini: {
    authenticatedUrl: "https://generativelanguage.googleapis.com/v1beta/models",
    authMode: "googleApiKeyQuery",
  },
  moonshot: {
    authenticatedUrl: "https://api.moonshot.ai/v1/models",
  },
  opengateway: {
    authenticatedUrl: "https://opengateway.gitlawb.com/v1/models",
    publicUrl: "https://opengateway.gitlawb.com/v1/models",
  },
  surplus: {
    // /v1/models requires the buyer's inf_ key; no documented public catalog,
    // so the static seed shows until a key is entered.
    authenticatedUrl: "https://www.surplusintelligence.ai/api/inference/v1/models",
  },
};

export function getLiveModelDiscoveryProviders(): string[] {
  return Object.keys(PROVIDER_MODEL_ENDPOINTS);
}

export function supportsLiveModelDiscovery(provider: string): boolean {
  return normalizeProviderKey(provider) in PROVIDER_MODEL_ENDPOINTS;
}

export function supportsPublicLiveModelDiscovery(provider: string): boolean {
  const config = PROVIDER_MODEL_ENDPOINTS[normalizeProviderKey(provider)];
  return Boolean(config?.publicUrl);
}

function normalizeProviderKey(provider: string): string {
  return provider.trim().toLowerCase();
}

function isSuppressedBankrLookupError(provider: string, error?: string | null): boolean {
  if (normalizeProviderKey(provider) !== "bankr" || !error) {
    return false;
  }

  return (
    /\b402\b/.test(error) ||
    /insufficient llm gateway credits/i.test(error) ||
    /insufficient_credits/i.test(error)
  );
}

export function getLiveModelDiscoveryStatusMessage({
  provider,
  isLoading,
  hasLiveModels,
  error,
  supportsPublicModels,
  loadingMessage = "Fetching live models...",
  missingKeyMessage = "Using popular presets until a provider key is available.",
}: LiveModelStatusMessageOptions): string {
  if (isLoading) {
    return loadingMessage;
  }

  if (hasLiveModels) {
    return "Using live provider models.";
  }

  if (isSuppressedBankrLookupError(provider, error)) {
    return "Using curated Bankr model presets.";
  }

  if (error) {
    return `Live lookup failed, using presets: ${error}`;
  }

  if (supportsPublicModels) {
    return "Pinging the public model catalog automatically.";
  }

  return missingKeyMessage;
}

function extractModelArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;

  if (
    payload &&
    typeof payload === "object" &&
    "data" in payload &&
    Array.isArray((payload as { data?: unknown[] }).data)
  ) {
    return (payload as { data: unknown[] }).data;
  }

  if (
    payload &&
    typeof payload === "object" &&
    "models" in payload &&
    Array.isArray((payload as { models?: unknown[] }).models)
  ) {
    return (payload as { models: unknown[] }).models;
  }

  throw new Error("Provider did not return a models array");
}

function getStringField(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function isCometTextModelEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;

  const record = entry as Record<string, unknown>;
  return typeof record.model_type === "string" && record.model_type.trim().toLowerCase() === "text";
}

function isGeminiChatModelEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;

  const record = entry as Record<string, unknown>;
  const rawName = getStringField(record, "name", "id", "model", "modelId");
  if (!rawName) return false;

  const name = rawName.replace(/^models\//, "").toLowerCase();
  if (!name.startsWith("gemini-")) return false;
  if (/\b(embedding|image|tts|live|audio|robotics|computer-use)\b/.test(name)) {
    return false;
  }

  const methods = record.supportedGenerationMethods;
  return Array.isArray(methods) && methods.some((method) => method === "generateContent");
}

function buildProviderAwareLabel(providerName: string | null, baseLabel: string): string {
  if (!providerName) return baseLabel;

  const normalizedProvider = providerName.toLowerCase();
  const normalizedBase = baseLabel.toLowerCase();
  if (normalizedBase.startsWith(normalizedProvider)) {
    return baseLabel;
  }

  return `${providerName} · ${baseLabel}`;
}

function normalizeModelEntry(entry: unknown, provider: string): ProviderModelOption | null {
  if (!entry || typeof entry !== "object") return null;

  const record = entry as Record<string, unknown>;
  const rawId = record.id ?? record.model ?? record.modelId ?? record.name;
  const modelSpec =
    record.model_spec && typeof record.model_spec === "object"
      ? (record.model_spec as Record<string, unknown>)
      : null;
  const rawLabel = record.displayName ?? record.name ?? record.label ?? modelSpec?.name ?? rawId;
  const providerName = getStringField(record, "provider", "owned_by", "provider_code");

  if (typeof rawId !== "string" || !rawId.trim()) return null;

  const baseLabel =
    typeof rawLabel === "string" && rawLabel.trim() ? rawLabel.trim() : rawId.trim();
  const label =
    normalizeProviderKey(provider) === "cometapi"
      ? buildProviderAwareLabel(providerName, baseLabel)
      : baseLabel;

  return {
    value: rawId.trim().replace(/^models\//, ""),
    label,
  };
}

function buildLiveModelsRequest(config: ProviderModelEndpointConfig, apiKey: string): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { Accept: "application/json" };
  const authMode = config.authMode ?? "bearer";

  if (apiKey && authMode === "googleApiKeyQuery") {
    const url = new URL(config.authenticatedUrl!);
    url.searchParams.set("key", apiKey);
    return { url: url.toString(), headers };
  }

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return { url: apiKey ? config.authenticatedUrl ?? config.publicUrl! : config.publicUrl!, headers };
}

export async function fetchLiveProviderModels(
  provider: string,
  apiKey?: string | null
): Promise<ProviderModelOption[]> {
  const normalizedProvider = normalizeProviderKey(provider);
  const config = PROVIDER_MODEL_ENDPOINTS[normalizedProvider];
  if (!config) {
    throw new Error(`Live model discovery is not supported for provider: ${provider}`);
  }

  const trimmedApiKey = apiKey?.trim() || "";
  const endpoint = trimmedApiKey ? config.authenticatedUrl ?? config.publicUrl : config.publicUrl;
  if (!endpoint) {
    throw new Error(`Live model discovery requires an API key for provider: ${provider}`);
  }

  const request = buildLiveModelsRequest(config, trimmedApiKey);

  const response = await fetch(request.url, {
    cache: "no-store",
    method: "GET",
    headers: request.headers,
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`Provider returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  const models = extractModelArray(payload)
    .filter((entry) => normalizedProvider !== "cometapi" || isCometTextModelEntry(entry))
    .filter((entry) => normalizedProvider !== "gemini" || isGeminiChatModelEntry(entry))
    .map((entry) => normalizeModelEntry(entry, normalizedProvider))
    .filter((entry): entry is ProviderModelOption => Boolean(entry))
    .filter((entry, index, entries) => entries.findIndex((candidate) => candidate.value === entry.value) === index)
    .sort((left, right) =>
      normalizedProvider === "cometapi"
        ? left.label.localeCompare(right.label, undefined, { sensitivity: "base" })
        : 0
    );

  if (models.length === 0) {
    throw new Error("Provider did not return any usable models");
  }

  return models;
}
