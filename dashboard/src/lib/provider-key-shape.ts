// Must stay word-for-word in sync with the createInstance missing-key 400 in
// src/lib/services/instance-service.ts so inline (client) validation shows the
// exact wording users would otherwise only see after the final deploy step.
export const PROVIDER_KEY_REQUIRED_MESSAGE =
  "Provider API key is required. Provide it manually or select a Vault key that contains an encrypted credential.";

export type ProviderKeyShapeFailure = {
  failureType: "provider_key_invalid_shape";
  message: string;
  provider: string;
};

export function validateProviderKeyShape(
  provider: string,
  key: string
): ProviderKeyShapeFailure | null {
  const normalizedProvider = provider.trim().toLowerCase();
  const trimmedKey = key.trim();

  if (normalizedProvider === "openrouter" && !trimmedKey.startsWith("sk-or-")) {
    return {
      failureType: "provider_key_invalid_shape",
      message: "OpenRouter API keys must start with sk-or-.",
      provider: normalizedProvider,
    };
  }

  if (normalizedProvider === "surplus" && !trimmedKey.startsWith("inf_")) {
    return {
      failureType: "provider_key_invalid_shape",
      message: "Surplus Intelligence API keys must start with inf_.",
      provider: normalizedProvider,
    };
  }

  return null;
}
