import "server-only";

import { inferProviderFromModel } from "@/lib/models";
import type { WebUIProfile } from "@/lib/webui/types";

export interface DashboardProfileFromWebUI {
  id: string;
  instance_id: string;
  user_id: string;
  name: string;
  display_name: string | null;
  avatar_url: string | null;
  model: string | null;
  provider: string | null;
  system_prompt: string | null;
  status: "stopped" | "running" | "creating" | "error";
  gateway_port: number | null;
  created_at: string;
  updated_at: string;
  config: Record<string, unknown>;
}

export function normalizeWebUIProfileName(profileName?: string | null): string {
  const trimmed = profileName?.trim();
  return trimmed && trimmed !== "main" ? trimmed : "default";
}

const WEBUI_PROVIDER_ID_MAP: Record<string, string> = {
  alibaba: "alibaba",
  bankr: "bankr",
  cometapi: "cometapi",
  codex: "openai-codex",
  deepseek: "deepseek",
  gemini: "gemini",
  groq: "groq",
  moonshot: "kimi-coding",
  nous: "nous",
  "nous-portal": "nous",
  openai: "openai",
  minimax: "minimax",
  venice: "venice",
  xiaomi: "xiaomi",
  zhipu: "zai",
  xai: "x-ai",
  "xai-oauth": "xai-oauth",
  crof: "crof",
  opengateway: "opengateway",
  surplus: "surplus",
};

const OPENROUTER_MODEL_NAMESPACE_HINTS = new Set([
  "ai21",
  "amazon",
  "anthropic",
  "arcee-ai",
  "cohere",
  "deepseek",
  "google",
  "liquid",
  "meta-llama",
  "microsoft",
  "minimax",
  "mistralai",
  "moonshotai",
  "nvidia",
  "openai",
  "perplexity",
  "qwen",
  "rekaai",
  "x-ai",
  "z-ai",
]);

export function mapDashboardProviderToWebUI(provider?: string | null): string | undefined {
  const trimmed = provider?.trim();
  if (!trimmed) return undefined;
  return WEBUI_PROVIDER_ID_MAP[trimmed] ?? trimmed;
}

export function buildWebUIDefaultModel(
  model: string,
  provider?: string | null,
  options: { supportedProviderIds?: Iterable<string> } = {}
): string {
  const trimmedModel = model.trim();
  if (!trimmedModel || trimmedModel.startsWith("@")) return trimmedModel;

  const webuiProvider = mapDashboardProviderToWebUI(provider);
  if (!webuiProvider || webuiProvider === "custom") return trimmedModel;
  if (options.supportedProviderIds) {
    const supportedProviderIds = new Set(options.supportedProviderIds);
    if (!supportedProviderIds.has(webuiProvider)) {
      return trimmedModel;
    }
  }

  return `@${webuiProvider}:${trimmedModel}`;
}

type WebUIDefaultModelProviderSource = "explicit" | "override" | "model" | "none";

function inferWebUIDashboardProviderFromModel(model?: string | null): string | null {
  const trimmed = model?.trim();
  if (!trimmed) return null;

  const prefixed = trimmed.match(/^@([^:]+):/);
  if (prefixed) {
    return mapWebUIProviderToDashboard(prefixed[1]) ?? prefixed[1];
  }

  const catalogProvider = inferProviderFromModel(trimmed);
  if (catalogProvider) return catalogProvider;

  const namespace = trimmed.match(/^([a-z0-9][a-z0-9-]*)\/[^/]+$/i)?.[1]?.toLowerCase();
  if (namespace && OPENROUTER_MODEL_NAMESPACE_HINTS.has(namespace)) {
    return "openrouter";
  }

  return null;
}

export function resolveWebUIDefaultModelProvider(input: {
  model?: string | null;
  explicitProvider?: string | null;
  currentDashboardProvider?: string | null;
}): { provider: string | null; source: WebUIDefaultModelProviderSource } {
  if (input.explicitProvider !== undefined) {
    const explicitProvider = input.explicitProvider?.trim() || null;
    return {
      provider: explicitProvider,
      source: explicitProvider ? "explicit" : "none",
    };
  }

  const currentDashboardProvider = input.currentDashboardProvider?.trim() || null;
  const inferredProvider = inferWebUIDashboardProviderFromModel(input.model);

  // "custom" is WebUI/hermes-cli's internal OpenAI-compatible fallback, not
  // a dashboard provider id. Let namespaced model ids repair older collapsed
  // state instead of preserving a value that causes OpenRouter to strip
  // `anthropic/` / `openai/` before the request leaves the box.
  if (currentDashboardProvider && currentDashboardProvider !== "custom") {
    return { provider: currentDashboardProvider, source: "override" };
  }

  if (inferredProvider) {
    return { provider: inferredProvider, source: "model" };
  }

  if (currentDashboardProvider) {
    return { provider: currentDashboardProvider, source: "override" };
  }

  return { provider: null, source: "none" };
}

function mapWebUIProviderToDashboard(provider?: string | null): string | null {
  const trimmed = provider?.trim();
  if (!trimmed) return null;

  switch (trimmed) {
    case "openai-codex":
      return "codex";
    case "kimi-coding":
      return "moonshot";
    case "zai":
      return "zhipu";
    case "x-ai":
      return "xai";
    default:
      return trimmed;
  }
}

function mapWebUIModelToDashboard(model?: string | null, provider?: string | null): string | null {
  const trimmed = model?.trim();
  if (!trimmed) return null;

  const prefix = provider?.trim() ? `@${provider.trim()}:` : "";
  if (prefix && trimmed.startsWith(prefix)) {
    return trimmed.slice(prefix.length);
  }

  return trimmed;
}

export function readWebUIRuntimeModelSettings(settings?: Record<string, unknown> | null): {
  model: string | null;
  provider: string | null;
} {
  const rawModel =
    typeof settings?.default_model === "string"
      ? settings.default_model
      : typeof settings?.model === "string"
        ? settings.model
        : null;
  const rawProvider =
    typeof settings?.active_provider === "string"
      ? settings.active_provider
      : typeof settings?.provider === "string"
        ? settings.provider
        : null;

  if (!rawModel?.trim()) {
    return {
      model: null,
      provider: mapWebUIProviderToDashboard(rawProvider),
    };
  }

  const prefixed = rawModel.trim().match(/^@([^:]+):(.+)$/);
  const provider = prefixed?.[1] || rawProvider;
  const model = prefixed?.[2] || rawModel;

  return {
    model: mapWebUIModelToDashboard(model, provider),
    provider: mapWebUIProviderToDashboard(provider),
  };
}

// Per-profile dashboard provider id stored in the dashboard-controlled
// `hermes_instances.config` JSON column. WebUI/hermes-cli only knows about
// its internal provider notion ("custom" for any OpenAI-compatible endpoint
// with a base_url override), so reading provider state back from WebUI
// loses the dashboard's specific id ("cometapi", "venice", "bankr", etc —
// all map to "custom" inside the agent). The first attempt put this into
// WebUI's settings.json sidecar but WebUI's save_settings has a strict
// _SETTINGS_ALLOWED_KEYS allowlist and silently drops unknown keys, so
// nothing persisted. The DB column is fully under the dashboard's control.
//
// Shape: instance.config.webui_profile_providers = {
//   default: "cometapi",
//   research: "anthropic",
// }
export const WEBUI_PROFILE_PROVIDERS_CONFIG_KEY = "webui_profile_providers";

export function readWebUIProfileProviderOverride(
  instanceConfig: Record<string, unknown> | null | undefined,
  webuiProfileName: string,
): string | null {
  if (!instanceConfig) return null;
  const map = instanceConfig[WEBUI_PROFILE_PROVIDERS_CONFIG_KEY];
  if (!map || typeof map !== "object" || Array.isArray(map)) return null;
  const raw = (map as Record<string, unknown>)[webuiProfileName];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

export function withWebUIProfileProviderOverride(
  instanceConfig: Record<string, unknown> | null | undefined,
  webuiProfileName: string,
  dashboardProviderId: string,
): Record<string, unknown> {
  const base: Record<string, unknown> = instanceConfig ? { ...instanceConfig } : {};
  const existingMap = base[WEBUI_PROFILE_PROVIDERS_CONFIG_KEY];
  const nextMap: Record<string, string> =
    existingMap && typeof existingMap === "object" && !Array.isArray(existingMap)
      ? { ...(existingMap as Record<string, string>) }
      : {};
  nextMap[webuiProfileName] = dashboardProviderId;
  base[WEBUI_PROFILE_PROVIDERS_CONFIG_KEY] = nextMap;
  return base;
}

export function mapWebUIProfileToDashboard(input: {
  profile: WebUIProfile;
  instanceId: string;
  userId: string;
  instanceName?: string | null;
  now?: string;
  // When set, takes precedence over whatever provider WebUI reports —
  // recovers the dashboard provider id (cometapi/venice/bankr/etc) that
  // WebUI internally collapses to "custom".
  dashboardProviderOverride?: string | null;
}): DashboardProfileFromWebUI {
  const name = normalizeWebUIProfileName(input.profile.name);
  const now = input.now ?? new Date().toISOString();
  const displayName =
    name === "default"
      ? (input.instanceName?.trim() || "Main Agent")
      : name;
  const rawProvider = typeof input.profile.provider === "string" ? input.profile.provider : null;
  const runtimeModelSettings = readWebUIRuntimeModelSettings({
    default_model: typeof input.profile.model === "string" ? input.profile.model : null,
    active_provider: rawProvider,
  });
  const overrideProvider = input.dashboardProviderOverride?.trim() || null;
  const provider = overrideProvider ?? runtimeModelSettings.provider;
  const model = runtimeModelSettings.model;

  return {
    id: `${input.instanceId}:${name}`,
    instance_id: input.instanceId,
    user_id: input.userId,
    name,
    display_name: displayName,
    avatar_url: null,
    model,
    provider,
    system_prompt: null,
    status: input.profile.is_active || input.profile.gateway_running ? "running" : "stopped",
    gateway_port: null,
    created_at: now,
    updated_at: now,
    config: {
      model: model ?? undefined,
      provider: provider ?? undefined,
      webui: {
        path: input.profile.path,
        is_default: input.profile.is_default,
        is_active: input.profile.is_active,
        gateway_running: input.profile.gateway_running,
        has_env: input.profile.has_env,
        skill_count: input.profile.skill_count,
      },
    },
  };
}
