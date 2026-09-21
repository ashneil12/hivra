import {
  resolveCodexDeploymentSecret,
  type CodexVaultBundle,
} from "@/lib/codex-oauth";
import {
  resolveNousDeploymentSecret,
  type NousVaultBundle,
} from "@/lib/nous-oauth";
import {
  isCodexAuthProvider,
  isNousAuthProvider,
  supportsHermesAuthProvider,
} from "@/lib/provider-auth";

export type ProviderDeploymentSecret = {
  apiKey: string;
  authBundle?: CodexVaultBundle | NousVaultBundle;
};

export function resolveProviderDeploymentSecret(
  provider: string | null | undefined,
  rawSecret: string
): ProviderDeploymentSecret {
  if (isCodexAuthProvider(provider)) {
    return resolveCodexDeploymentSecret(rawSecret);
  }

  if (isNousAuthProvider(provider)) {
    return resolveNousDeploymentSecret(rawSecret);
  }

  return { apiKey: rawSecret.trim() };
}

export function resolveDeploymentApiKey(
  rawSecret: string,
  resolvedSecret: ProviderDeploymentSecret
): string {
  return resolvedSecret.apiKey || (resolvedSecret.authBundle ? "" : rawSecret.trim());
}

export { isCodexAuthProvider, isNousAuthProvider, supportsHermesAuthProvider };
