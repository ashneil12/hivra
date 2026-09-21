import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";

import { agentWebApi } from "@/lib/agent-web-api";
import { apiError, apiSuccess } from "@/lib/api-response";
import { redactSensitiveCommandOutput } from "@/lib/command-output-redaction";
import { readHermesOAuthProxyError } from "@/lib/hermes-oauth-proxy";
import { sshExec } from "@/lib/hetzner/ssh";
import { getInstanceBackend } from "@/lib/instance-backend";
import {
  buildNousStartCommand,
  parseNousCommandJson,
  WEBUI_HERMES_HOME,
} from "@/lib/nous-oauth";
import { validateConsoleAccess } from "@/lib/services/console-helpers";
import { isSshWarmupError, SSH_WARMUP_MESSAGE } from "@/lib/ssh-warmup";
import { isWebfreeBackend } from "@/lib/types/instance";

const WEBUI_EXEC_USER = "1024:1024";
const WEBUI_NOUS_START_TIMEOUT_MS = 30_000;
const NOUS_OAUTH_START_ERROR = "Failed to start Nous Portal login.";
const NOUS_OAUTH_START_RUNTIME_HELPER_ERROR =
  "Nous Portal auth support is unavailable in this Hermes runtime. Update or restart the instance, then try again.";

type SshCommandResult = Awaited<ReturnType<typeof sshExec>>;

function readStructuredNousStartError(result: SshCommandResult): string | null {
  for (const output of [result.stdout, result.stderr]) {
    if (!output?.trim()) continue;

    try {
      const payload = parseNousCommandJson(output);
      if (typeof payload.error_message === "string" && payload.error_message.trim()) {
        return payload.error_message.trim();
      }
    } catch {
      continue;
    }
  }

  return null;
}

function buildWebUINousStartFailureDetails(result: SshCommandResult) {
  const rawMessage = (
    readStructuredNousStartError(result) ||
    result.stderr ||
    result.error ||
    result.stdout ||
    ""
  ).trim();
  const normalized = rawMessage.toLowerCase();
  const commandExitMatch = rawMessage.match(/command exited with code\s+(\d+)/i);
  let failureCategory = "unknown";

  if (normalized.includes("no such container") || normalized.includes("is not running")) {
    failureCategory = "container_unavailable";
  } else if (
    normalized.includes("no module named 'hermes_cli'") ||
    normalized.includes("no module named hermes_cli")
  ) {
    failureCategory = "nous_auth_module_missing";
  } else if (
    normalized.includes("cannot import name '_request_device_code'") ||
    normalized.includes("module 'hermes_cli.auth' has no attribute") ||
    normalized.includes("module hermes_cli.auth has no attribute") ||
    normalized.includes("provider_registry")
  ) {
    failureCategory = "nous_auth_helper_unavailable";
  } else if (normalized.includes("permission denied")) {
    failureCategory = "permission_denied";
  } else if (normalized.includes("no space left on device")) {
    failureCategory = "disk_full";
  } else if (commandExitMatch) {
    failureCategory = `command_exit_${commandExitMatch[1]}`;
  }

  return {
    failureType: "webui_nous_oauth_start_failed",
    failureCategory,
    stderrPresent: Boolean(result.stderr),
    stdoutPresent: Boolean(result.stdout),
    errorPresent: Boolean(result.error),
    stderrLength: result.stderr?.length ?? 0,
    stdoutLength: result.stdout?.length ?? 0,
    errorLength: result.error?.length ?? 0,
    redactedError: rawMessage ? redactSensitiveCommandOutput(rawMessage, 600) : undefined,
  };
}

function classifyWebUINousStartFailure(result: SshCommandResult) {
  const details = buildWebUINousStartFailureDetails(result);
  const rawTransportMessage = `${result.stderr || ""}\n${result.error || ""}\n${result.stdout || ""}`;

  if (isSshWarmupError(rawTransportMessage)) {
    return {
      status: 409,
      message: SSH_WARMUP_MESSAGE,
      details,
    };
  }

  if (details.failureCategory === "container_unavailable") {
    return {
      status: 503,
      message: "The agent runtime is not running. Please start your instance first.",
      details,
    };
  }

  if (
    details.failureCategory === "nous_auth_module_missing" ||
    details.failureCategory === "nous_auth_helper_unavailable"
  ) {
    return {
      status: 503,
      message: NOUS_OAUTH_START_RUNTIME_HELPER_ERROR,
      details: {
        ...details,
        redactedError: undefined,
      },
    };
  }

  if (details.redactedError) {
    return {
      status: 502,
      message: details.redactedError,
      details,
    };
  }

  return {
    status: 500,
    message: NOUS_OAUTH_START_ERROR,
    details,
  };
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; provider: string }> }
) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

    const { id, provider } = await params;
    if (isWebfreeBackend(await getInstanceBackend(id, userId))) {
      if (provider !== "nous") {
        return apiError("This reconnect flow currently supports Nous Portal only.", 400);
      }

      const access = await validateConsoleAccess(Promise.resolve({ id }));
      if (access.errorResponse) return access.errorResponse;

      const result = await sshExec(
        access.hostIp,
        buildNousStartCommand(id, WEBUI_EXEC_USER, WEBUI_HERMES_HOME),
        { timeoutMs: WEBUI_NOUS_START_TIMEOUT_MS }
      );

      if (!result.ok) {
        const failure = classifyWebUINousStartFailure(result);
        return apiError(
          failure.message,
          failure.status,
          failure.details,
          undefined,
          {
            route: "/api/instances/[id]/oauth/providers/[provider]/start",
            source: "webui-nous-oauth-start",
            metadata: { instanceId: id, provider },
          }
        );
      }

      const output = (result.stdout || "").trim();
      const data = parseNousCommandJson(output);
      if (
        typeof data.session_id !== "string" ||
        typeof data.user_code !== "string" ||
        typeof data.verification_url !== "string"
      ) {
        return apiError("The agent runtime did not return a usable Nous Portal device-code session.", 500);
      }

      return apiSuccess({
        session_id: data.session_id,
        flow: data.flow || "device_code",
        user_code: data.user_code,
        verification_url: data.verification_url,
        expires_in: typeof data.expires_in === "number" ? data.expires_in : undefined,
        poll_interval: typeof data.poll_interval === "number" ? data.poll_interval : undefined,
        runtime: "webui",
      });
    }

    const api = await agentWebApi(id, userId);
    const response = await api.post(`/api/providers/oauth/${encodeURIComponent(provider)}/start`, undefined, {
      timeout: 20_000,
    });

    if (!response.ok) {
      return apiError(
        await readHermesOAuthProxyError(response, "login start"),
        response.status || 502,
        undefined,
        undefined,
        {
          route: "/api/instances/[id]/oauth/providers/[provider]/start",
          source: "hermes-oauth-start",
          metadata: { instanceId: id, provider },
        }
      );
    }

    const data = await response.json();
    return apiSuccess(data);
  } catch (error) {
    return apiError(
      "Internal Server Error",
      500,
      {
        failureType: "provider_oauth_start_failed",
        errorName: error instanceof Error ? error.name : typeof error,
        redactedError: error instanceof Error
          ? redactSensitiveCommandOutput(error.message, 600)
          : redactSensitiveCommandOutput(String(error), 600),
      },
      undefined,
      {
        route: "/api/instances/[id]/oauth/providers/[provider]/start",
        source: "hermes-oauth-start",
      }
    );
  }
}
