import "server-only";

import { WebUIError } from "@/lib/webui/client";

// The client-calling wrappers (readWebUIRuntimeSettings / saveWebUIRuntimeSettings
// / setWebUIDefaultModel / setWebUIProviderKey) have been RETIRED — they targeted
// the legacy hermes-webui /api/settings, /api/default-model and /api/providers
// endpoints, none of which the fleet agent image serves (they 404). Their only
// callers (agent-config + the profiles routes) are gone. Only the pure error
// mapper survives, still used by the canary-only connectors-sync route.

export type WebUIRuntimeErrorMetadata = {
  message: string;
  status: number;
  failureType: "webui_runtime_request_failed";
  retryable: false;
  upstreamStatus: number;
};

export function mapWebUIRuntimeError(
  error: unknown,
  fallbackMessage: string,
): WebUIRuntimeErrorMetadata {
  const upstreamStatus =
    error instanceof WebUIError && error.status > 0 ? error.status : 502;

  return {
    message: fallbackMessage,
    status: upstreamStatus,
    failureType: "webui_runtime_request_failed",
    retryable: false,
    upstreamStatus,
  };
}
