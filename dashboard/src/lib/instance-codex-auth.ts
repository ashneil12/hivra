import { CODEX_DISCONNECTED_PREVIEW } from "@/lib/codex-oauth";
import { isCodexAuthProvider } from "@/lib/provider-auth";

interface CodexAuthInstanceSnapshot {
  provider?: string | null;
  api_key_preview?: string | null;
}

export function shouldAutoOpenCodexOAuth(
  instance: CodexAuthInstanceSnapshot | null | undefined
): boolean {
  return Boolean(
    instance &&
    isCodexAuthProvider(instance.provider) &&
    instance.api_key_preview === CODEX_DISCONNECTED_PREVIEW
  );
}
