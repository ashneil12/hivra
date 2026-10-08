import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";

import { agentWebApi } from "@/lib/agent-web-api";
import { apiError, apiSuccess } from "@/lib/api-response";
import { readHermesOAuthProxyError } from "@/lib/hermes-oauth-proxy";
import { sshExec } from "@/lib/hetzner/ssh";
import { getInstanceBackend } from "@/lib/instance-backend";
import {
  buildNousStatusCommand,
  parseNousCommandJson,
  WEBUI_HERMES_HOME,
} from "@/lib/nous-oauth";
import {
  loadUserNousVaultBundle,
  readCachedNousVaultBundle,
} from "@/lib/services/nous-runtime-auth";
import { validateConsoleAccess } from "@/lib/services/console-helpers";
import { isWebfreeBackend } from "@/lib/types/instance";

const WEBUI_EXEC_USER = "1024:1024";

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

function degradedProviderCatalog(reason: "timeout" | "unavailable") {
  return apiSuccess({
    degraded: true,
    providers: [
      {
        id: "nous",
        name: "Nous Portal",
        flow: "device_code",
        status: {
          logged_in: false,
          unavailable: true,
          reason,
        },
      },
    ],
  });
}

async function webUIProviderCatalog(instanceId: string) {
  const access = await validateConsoleAccess(Promise.resolve({ id: instanceId }));
  if (access.errorResponse) return access.errorResponse;

  const cachedBundle = readCachedNousVaultBundle(access.instance?.api_key_encrypted);
  const storedVaultSession = await loadUserNousVaultBundle(access.userId).catch(() => ({
    bundle: null,
    encryptedKey: null,
    vaultKeyId: null,
  }));
  const reusableBundle = cachedBundle || storedVaultSession.bundle;

  let status = {
    logged_in: Boolean(reusableBundle),
    source: reusableBundle ? "stored-vault" : "webui-runtime",
    source_label: reusableBundle ? "Hermes Vault" : "Agent runtime",
    has_refresh_token: Boolean(reusableBundle?.refreshToken),
    runtime: "webui",
  };

  try {
    const result = await sshExec(
      access.hostIp,
      buildNousStatusCommand(instanceId, WEBUI_EXEC_USER, WEBUI_HERMES_HOME),
      { timeoutMs: 15_000, proxmoxHostConfig: access.proxmoxHostConfig ?? null }
    );
    if (result.ok && result.stdout?.trim()) {
      const payload = parseNousCommandJson(result.stdout);
      if (payload.authenticated === true) {
        status = {
          logged_in: true,
          source: typeof payload.source === "string" ? payload.source : "webui-runtime",
          source_label: "Agent runtime",
          has_refresh_token: Boolean(payload.vaultBundle?.refreshToken),
          runtime: "webui",
        };
      }
    }
  } catch {
    // Catalog is a status hint; if live status is unavailable, keep the Vault-backed answer.
  }

  return apiSuccess({
    runtime: "webui",
    providers: [
      {
        id: "nous",
        name: "Nous Portal",
        flow: "device_code",
        cli_command: "hermes auth add nous",
        docs_url: "https://portal.nousresearch.com",
        status,
      },
    ],
  });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

    const { id } = await params;
    if (isWebfreeBackend(await getInstanceBackend(id, userId))) {
      // MUST await: an un-awaited `return webUIProviderCatalog(id)` escapes this
      // try/catch, so an unexpected validateConsoleAccess/IP rejection would leak
      // out of GET instead of being redacted to 500 (or, for timeouts, falling to
      // degradedProviderCatalog). Awaiting keeps the webfree branch under the same
      // error-redaction contract the legacy agentWebApi branch had.
      return await webUIProviderCatalog(id);
    }

    const api = await agentWebApi(id, userId);
    const response = await api.get("/api/providers/oauth", { timeout: 15_000 });

    if (!response.ok) {
      return apiError(
        await readHermesOAuthProxyError(response, "provider query"),
        response.status || 502,
        undefined,
        undefined,
        {
          route: "/api/instances/[id]/oauth/providers",
          source: "hermes-oauth-providers",
          metadata: { instanceId: id },
        }
      );
    }

    const data = await response.json();
    return apiSuccess(data);
  } catch (error) {
    if (isTimeoutLikeError(error)) {
      return degradedProviderCatalog("timeout");
    }

    return apiError(
      "Internal Server Error",
      500,
      {
        failureType: "provider_oauth_catalog_failed",
        errorName: error instanceof Error ? error.name : typeof error,
      },
      undefined,
      {
        route: "/api/instances/[id]/oauth/providers",
        source: "hermes-oauth-providers",
      }
    );
  }
}
