const MANAGED_VENICE_PROXY_KEY_PREFIX = "hven_live_";
const MANAGED_VENICE_PROXY_PATH_MARKER = "/api/managed-venice/";

export function isVeniceProvider(provider: string | undefined | null): boolean {
  return provider?.trim().toLowerCase() === "venice";
}

export function isManagedVeniceProxyKey(apiKey: string | undefined | null): boolean {
  return apiKey?.trim().startsWith(MANAGED_VENICE_PROXY_KEY_PREFIX) === true;
}

export function isRealVeniceByokKey(
  provider: string | undefined | null,
  apiKey: string | undefined | null
): boolean {
  const trimmedApiKey = apiKey?.trim();
  return Boolean(isVeniceProvider(provider) && trimmedApiKey && !isManagedVeniceProxyKey(trimmedApiKey));
}

export function isManagedVeniceProxyBaseUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return false;

  try {
    const url = new URL(trimmed);
    return url.pathname.includes(MANAGED_VENICE_PROXY_PATH_MARKER);
  } catch {
    return trimmed.includes(MANAGED_VENICE_PROXY_PATH_MARKER);
  }
}

export function stripManagedVeniceProxyBaseUrl<T extends Record<string, unknown> | undefined>(
  agentSettings: T
): T {
  if (!agentSettings || !isManagedVeniceProxyBaseUrl(agentSettings.customLlmBaseUrl)) {
    return agentSettings;
  }

  const rest = { ...agentSettings };
  delete rest.customLlmBaseUrl;
  return rest as T;
}
