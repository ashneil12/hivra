import "server-only";

import { deriveWebUIBaseUrl } from "@/lib/instance-backend";
import {
  getSecureUserInstance,
  recoverAndPersistApiServerKeyFromManagedHost,
} from "@/lib/services/instance-security";
import { WebUIClient } from "@/lib/webui/client";

export type WebUIInstanceClientResult =
  | { ok: true; client: WebUIClient; baseUrl: string }
  | { ok: false; status: number; error: string };

function getInstanceErrorStatus(error: string): number {
  if (error === "Instance not found or unauthorized") {
    return 404;
  }

  if (error === "Instance is not currently running") {
    return 400;
  }

  return 503;
}

export async function resolveWebUIInstanceClient(input: {
  instanceId: string;
  userId: string;
  requireRunning?: boolean;
}): Promise<WebUIInstanceClientResult> {
  const resolved = await getSecureUserInstance({
    id: input.instanceId,
    userId: input.userId,
    requireRunning: input.requireRunning ?? true,
  });

  if (resolved.error || !resolved.instance) {
    const error = resolved.error || "Instance not found or unauthorized";
    return {
      ok: false,
      status: getInstanceErrorStatus(error),
      error,
    };
  }

  const baseUrl = deriveWebUIBaseUrl(resolved.instance.gateway_url);
  return {
    ok: true,
    baseUrl,
    client: new WebUIClient({
      baseUrl,
      // Send the API key as both `bearer` and `password`:
      //  - `bearer` adds `Authorization: Bearer <key>` to every request, which
      //    Caddy verifies at the edge so the request never reaches the
      //    Python `ThreadingHTTPServer`'s GIL-bound auth pipeline. Each
      //    auth-pipeline pass costs ~1.3s under load (see /health timings
      //    in the production network trace), so this is the largest
      //    single shave on chat-boot latency.
      //  - `password` keeps the legacy login-and-cookie fallback alive for
      //    instances still running with HERMES_WEBUI_PASSWORD set, so the
      //    rollout can be staged: deploy the dashboard first, then drop the
      //    WebUI password + tighten the Caddyfile per instance.
      bearer: resolved.apiServerKey || undefined,
      password: resolved.apiServerKey || undefined,
      instanceIpv4: resolved.instanceIpv4,
      staleBearerRecovery: {
        failureTypePrefix: "webui_instance_client",
        logCtx: {
          source: "webui-instance-client",
          instanceId: input.instanceId,
          userId: input.userId,
        },
        recover: async ({ currentBearer }) => recoverAndPersistApiServerKeyFromManagedHost(
          resolved.instance,
          { ignoreApiServerKey: currentBearer },
        ),
      },
    }),
  };
}
