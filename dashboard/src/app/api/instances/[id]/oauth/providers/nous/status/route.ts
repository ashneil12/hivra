import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { encryptApiKey } from "@/lib/crypto";
import { redactSensitiveCommandOutput } from "@/lib/command-output-redaction";
import {
  buildNousStatusCommand,
  NOUS_VAULT_KEY_NAME,
  NOUS_VAULT_KEY_PREVIEW,
  parseNousCommandJson,
  serializeNousVaultBundle,
  WEBUI_HERMES_HOME,
  type NousVaultBundle,
} from "@/lib/nous-oauth";
import { sshExec } from "@/lib/hetzner/ssh";
import {
  resolveHermesExecUserFromConfig,
  resolveHermesHomeDirFromConfig,
} from "@/lib/hermes-home";
import {
  loadUserNousVaultBundle,
  readCachedNousVaultBundle,
  syncNousRuntimeAuthStore,
} from "@/lib/services/nous-runtime-auth";
import { validateConsoleAccess } from "@/lib/services/console-helpers";
import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { isWebfreeBackend } from "@/lib/types/instance";

const SAFE_VAULT_PERSISTENCE_ERROR =
  "Unable to save the reusable Vault session. Please try again or contact support.";
const NOUS_STATUS_ERROR = "Failed to read Nous Portal auth state.";
const WEBUI_EXEC_USER = "1024:1024";

async function upsertNousVaultSession(
  userId: string,
  bundle: NousVaultBundle
): Promise<string | null> {
  if (!supabaseAdmin) {
    throw new Error("Database not configured");
  }

  const payload = {
    user_id: userId,
    name: NOUS_VAULT_KEY_NAME,
    provider: "nous",
    encrypted_key: encryptApiKey(serializeNousVaultBundle(bundle)),
    key_preview: NOUS_VAULT_KEY_PREVIEW,
    is_active: true,
    updated_at: new Date().toISOString(),
  };

  const query = supabaseAdmin.from("user_api_keys");
  const { data: existing, error: lookupError } = await query
    .select("id")
    .eq("user_id", userId)
    .eq("provider", "nous")
    .eq("name", NOUS_VAULT_KEY_NAME)
    .maybeSingle();

  if (lookupError) {
    throw new Error(`Failed to look up existing Nous Vault session: ${lookupError.message}`);
  }

  if (existing?.id) {
    const { error: updateError } = await query
      .update(payload)
      .eq("id", existing.id)
      .eq("user_id", userId);

    if (updateError) {
      throw new Error(`Failed to update Nous Vault session: ${updateError.message}`);
    }

    return existing.id;
  }

  const { data: inserted, error: insertError } = await query
    .insert(payload)
    .select("id")
    .single();

  if (insertError) {
    throw new Error(`Failed to store Nous Vault session: ${insertError.message}`);
  }

  return inserted?.id ?? null;
}

async function persistNousSessionToInstance(
  instanceId: string,
  userId: string,
  bundle: NousVaultBundle
): Promise<void> {
  if (!supabaseAdmin) {
    throw new Error("Database not configured");
  }

  const { error } = await supabaseAdmin
    .from("hermes_instances")
    .update({
      api_key_encrypted: encryptApiKey(serializeNousVaultBundle(bundle)),
      api_key_preview: NOUS_VAULT_KEY_PREVIEW,
      updated_at: new Date().toISOString(),
    })
    .eq("id", instanceId)
    .eq("user_id", userId)
    .eq("provider", "nous");

  if (error) {
    throw new Error(`Failed to persist Nous session to instance: ${error.message}`);
  }
}

function buildCachedNousStatusResponse(
  bundle: NousVaultBundle,
  sourceHint?: string,
  options?: {
    vaultKeyId?: string | null;
    persistenceError?: string;
    runtime?: "webui";
    runtimeSyncChanged?: boolean;
  }
) {
  return apiSuccess({
    authenticated: true,
    source: sourceHint || bundle.source || "stored-vault",
    expired: false,
    vaultKeyId: options?.vaultKeyId ?? null,
    persistenceError: options?.persistenceError,
    cached: true,
    degraded: true,
    runtime: options?.runtime,
    runtimeSyncChanged: options?.runtimeSyncChanged,
  });
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const errorOptions = {
    source: "nous-oauth-status",
    route: "/api/instances/[id]/oauth/providers/nous/status",
  } as const;

  try {
    const access = await validateConsoleAccess(params);
    if (access.errorResponse) return access.errorResponse;
    const { id: instanceId, hostIp } = access;

    if (!/^[a-zA-Z0-9-]+$/.test(instanceId)) {
      return apiError("Invalid instance ID format", 400);
    }

    const instanceConfig =
      access.instance?.config && typeof access.instance.config === "object"
        ? (access.instance.config as Record<string, unknown>)
        : undefined;
    const isWebUIBackend = isWebfreeBackend(access.instance?.backend);
    const hermesHomeDir = isWebUIBackend
      ? WEBUI_HERMES_HOME
      : resolveHermesHomeDirFromConfig(instanceConfig);
    const hermesExecUser = isWebUIBackend
      ? WEBUI_EXEC_USER
      : resolveHermesExecUserFromConfig(instanceConfig);

    const cachedBundle = readCachedNousVaultBundle(access.instance?.api_key_encrypted);
    const storedVaultSession = await loadUserNousVaultBundle(access.userId).catch(() => ({
      bundle: null,
      encryptedKey: null,
      vaultKeyId: null,
    }));
    const reusableBundle = cachedBundle || storedVaultSession.bundle;
    let webUIRuntimeSyncChanged = false;

    if (isWebUIBackend && reusableBundle) {
      try {
        const syncResult = await syncNousRuntimeAuthStore(
          access.id,
          access.hostIp,
          reusableBundle,
          hermesHomeDir
        );
        webUIRuntimeSyncChanged = syncResult.changed;
      } catch (error) {
        const rawError = error instanceof Error ? error.message : String(error);
        log.error("WebUI runtime sync from stored session failed", error, {
          source: "nous-oauth-status",
          route: "/api/instances/[id]/oauth/providers/nous/status",
          method: "GET",
          instanceId: access.id,
          userId: access.userId,
          failureType: "nous_webui_runtime_sync_failed",
          redactedError: redactSensitiveCommandOutput(rawError, 600),
        });
      }
    }

    const result = await sshExec(
      hostIp,
      buildNousStatusCommand(instanceId, hermesExecUser, hermesHomeDir)
    );

    if (
      !result.ok &&
      (result.stderr?.includes("No such container") ||
        result.stdout?.includes("No such container"))
    ) {
      if (reusableBundle) {
        return buildCachedNousStatusResponse(reusableBundle, "stored-vault", {
          vaultKeyId: storedVaultSession.vaultKeyId,
          runtime: isWebUIBackend ? "webui" : undefined,
          runtimeSyncChanged: webUIRuntimeSyncChanged,
        });
      }
      return apiError("Agent container is not running. Please start your instance first.", 503);
    }

    if (!result.ok) {
      if (reusableBundle) {
        return buildCachedNousStatusResponse(reusableBundle, "stored-vault", {
          vaultKeyId: storedVaultSession.vaultKeyId,
          runtime: isWebUIBackend ? "webui" : undefined,
          runtimeSyncChanged: webUIRuntimeSyncChanged,
        });
      }
      return apiError(
        NOUS_STATUS_ERROR,
        500,
        {
          failureType: "nous_status_command_failed",
          stderrPresent: Boolean(result.stderr),
          errorPresent: Boolean(result.error),
          stdoutPresent: Boolean(result.stdout),
        },
        undefined,
        errorOptions
      );
    }

    const output = (result.stdout || "").trim();
    if (!output) {
      if (reusableBundle) {
        return buildCachedNousStatusResponse(reusableBundle, "stored-vault", {
          vaultKeyId: storedVaultSession.vaultKeyId,
          runtime: isWebUIBackend ? "webui" : undefined,
          runtimeSyncChanged: webUIRuntimeSyncChanged,
        });
      }
      return apiError("Nous status command did not return a status payload.", 500);
    }

    const payload = parseNousCommandJson(output);
    if (payload.authenticated !== true || !payload.vaultBundle) {
      if (reusableBundle) {
        return buildCachedNousStatusResponse(reusableBundle, "stored-vault", {
          vaultKeyId: storedVaultSession.vaultKeyId,
          runtime: isWebUIBackend ? "webui" : undefined,
          runtimeSyncChanged: webUIRuntimeSyncChanged,
        });
      }
      return apiSuccess({
        authenticated: false,
        source: typeof payload.source === "string" ? payload.source : undefined,
        expired: payload.expired === true,
        vaultKeyId: null,
        runtime: isWebUIBackend ? "webui" : undefined,
        runtimeSyncChanged: webUIRuntimeSyncChanged,
      });
    }

    let vaultKeyId: string | null = null;

    try {
      vaultKeyId = await upsertNousVaultSession(access.userId, payload.vaultBundle);
      if (access.instance?.provider === "nous") {
        await persistNousSessionToInstance(access.id, access.userId, payload.vaultBundle);
      }
    } catch (error) {
      // The live auth read succeeded, but we could NOT durably store the
      // reusable Vault session. Do not report this as a success — a consumer
      // that only checks `success`/`authenticated` would believe the
      // credential was saved when it was not, leaving the user "connected"
      // with nothing persisted. Surface the failure honestly (non-2xx +
      // success:false) so the client knows to retry.
      const rawError = error instanceof Error ? error.message : String(error);
      return apiError(
        SAFE_VAULT_PERSISTENCE_ERROR,
        502,
        {
          failureType: "nous_vault_persistence_failed",
          redactedError: redactSensitiveCommandOutput(rawError, 600),
        },
        {
          authenticated: true,
          persisted: false,
          source: typeof payload.source === "string" ? payload.source : undefined,
          expired: payload.expired === true,
          runtime: isWebUIBackend ? "webui" : undefined,
          runtimeSyncChanged: webUIRuntimeSyncChanged,
        },
        {
          ...errorOptions,
          method: "GET",
          instanceId: access.id,
          userId: access.userId,
          cause: error,
          failureType: "nous_vault_persistence_failed",
        }
      );
    }

    return apiSuccess({
      authenticated: true,
      persisted: true,
      source: typeof payload.source === "string" ? payload.source : undefined,
      expired: payload.expired === true,
      vaultKeyId,
      runtime: isWebUIBackend ? "webui" : undefined,
      runtimeSyncChanged: webUIRuntimeSyncChanged,
    });
  } catch (error: unknown) {
    return apiError(
      NOUS_STATUS_ERROR,
      500,
      {
        failureType: "nous_status_unexpected_error",
        errorName: error instanceof Error ? error.name : typeof error,
      },
      undefined,
      errorOptions
    );
  }
}
