import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";

import { agentWebApi } from "@/lib/agent-web-api";
import { apiError, apiSuccess } from "@/lib/api-response";
import { readHermesOAuthProxyError } from "@/lib/hermes-oauth-proxy";
import { sshExec } from "@/lib/hetzner/ssh";
import { getInstanceBackend } from "@/lib/instance-backend";
import {
  buildNousPollCommand,
  parseNousCommandJson,
  WEBUI_HERMES_HOME,
} from "@/lib/nous-oauth";
import { validateConsoleAccess } from "@/lib/services/console-helpers";
import { isWebfreeBackend } from "@/lib/types/instance";

const WEBUI_EXEC_USER = "1024:1024";
const WEBUI_NOUS_POLL_TIMEOUT_MS = 30_000;

function isTimeoutLikeError(error: unknown): boolean {
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  return (
    name.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("aborted due to timeout")
  );
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; provider: string; sessionId: string }> }
) {
  let id = "";
  let provider = "";
  let sessionId = "";

  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

    ({ id, provider, sessionId } = await params);
    if (isWebfreeBackend(await getInstanceBackend(id, userId))) {
      if (provider !== "nous") {
        return apiError("This reconnect flow currently supports Nous Portal only.", 400);
      }

      const access = await validateConsoleAccess(Promise.resolve({ id }));
      if (access.errorResponse) return access.errorResponse;

      const result = await sshExec(
        access.hostIp,
        buildNousPollCommand(id, sessionId, WEBUI_EXEC_USER, WEBUI_HERMES_HOME),
        { timeoutMs: WEBUI_NOUS_POLL_TIMEOUT_MS, proxmoxHostConfig: access.proxmoxHostConfig ?? null }
      );

      if (!result.ok) {
        const raw = `${result.stderr || ""}\n${result.stdout || ""}\n${result.error || ""}`.toLowerCase();
        if (raw.includes("timed out") || raw.includes("timeout")) {
          return apiError(
            "The operation timed out while polling provider auth status",
            504,
            {
              failureType: "webui_nous_auth_poll_timeout",
              stderrPresent: Boolean(result.stderr),
              stdoutPresent: Boolean(result.stdout),
              errorPresent: Boolean(result.error),
            },
            undefined,
            {
              route: "/api/instances/[id]/oauth/providers/[provider]/poll/[sessionId]",
              source: "webui-nous-oauth-poll",
              metadata: { instanceId: id, provider, sessionId },
            }
          );
        }
        return apiError(
          "Failed to poll Nous Portal login.",
          500,
          {
            failureType: "webui_nous_auth_poll_failed",
            stderrPresent: Boolean(result.stderr),
            stdoutPresent: Boolean(result.stdout),
            errorPresent: Boolean(result.error),
          },
          undefined,
          {
            route: "/api/instances/[id]/oauth/providers/[provider]/poll/[sessionId]",
            source: "webui-nous-oauth-poll",
            metadata: { instanceId: id, provider, sessionId },
          }
        );
      }

      const data = parseNousCommandJson((result.stdout || "").trim());
      return apiSuccess({
        session_id: typeof data.session_id === "string" ? data.session_id : sessionId,
        status: typeof data.status === "string" ? data.status : "pending",
        error_message: typeof data.error_message === "string" ? data.error_message : null,
        expires_at: data.expires_at ?? null,
        runtime: "webui",
      });
    }

    const api = await agentWebApi(id, userId);
    const response = await api.get(
      `/api/providers/oauth/${encodeURIComponent(provider)}/poll/${encodeURIComponent(sessionId)}`,
      { timeout: 15_000 }
    );

    if (!response.ok) {
      return apiError(
        await readHermesOAuthProxyError(response, "poll"),
        response.status || 502,
        undefined,
        undefined,
        {
          route: "/api/instances/[id]/oauth/providers/[provider]/poll/[sessionId]",
          source: "hermes-oauth-poll",
          metadata: { instanceId: id, provider, sessionId },
        }
      );
    }

    const data = await response.json();
    return apiSuccess(data);
  } catch (error) {
    if (isTimeoutLikeError(error)) {
      return apiError(
        "The operation timed out while polling provider auth status",
        504,
        {
          failureType: "provider_auth_poll_timeout",
          errorName: error instanceof Error ? error.name : typeof error,
        },
        undefined,
        {
          route: "/api/instances/[id]/oauth/providers/[provider]/poll/[sessionId]",
          source: "hermes-oauth-poll",
          metadata: { instanceId: id || undefined, provider: provider || undefined, sessionId: sessionId || undefined },
        }
      );
    }

    return apiError(
      "Internal Server Error",
      500,
      {
        failureType: "provider_auth_poll_failed",
        errorName: error instanceof Error ? error.name : typeof error,
      },
      undefined,
      {
        route: "/api/instances/[id]/oauth/providers/[provider]/poll/[sessionId]",
        source: "hermes-oauth-poll",
        metadata: { instanceId: id || undefined, provider: provider || undefined, sessionId: sessionId || undefined },
      }
    );
  }
}
