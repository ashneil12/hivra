function normalizeProvider(provider?: string | null): string | null {
  const trimmed = provider?.trim();
  if (!trimmed) return null;

  switch (trimmed) {
    case "openai-codex":
      return "codex";
    case "grok-oauth":
    case "x-ai-oauth":
    case "xai-grok-oauth":
      return "xai-oauth";
    default:
      return trimmed;
  }
}

export function isCodexAuthProvider(provider?: string | null): boolean {
  return normalizeProvider(provider) === "codex";
}

export function isNousAuthProvider(provider?: string | null): boolean {
  const normalized = normalizeProvider(provider);
  return normalized === "nous" || normalized === "nous-portal";
}

export function isXaiOAuthProvider(provider?: string | null): boolean {
  return normalizeProvider(provider) === "xai-oauth";
}

export function supportsHermesAuthProvider(
  provider?: string | null
): boolean {
  return (
    isCodexAuthProvider(provider) ||
    isNousAuthProvider(provider) ||
    isXaiOAuthProvider(provider)
  );
}

export function allowsProviderDeployWithoutApiKey(
  provider?: string | null
): boolean {
  const normalized = normalizeProvider(provider);
  return (
    normalized === "custom_llm" ||
    normalized === "opengateway" ||
    supportsHermesAuthProvider(normalized)
  );
}
