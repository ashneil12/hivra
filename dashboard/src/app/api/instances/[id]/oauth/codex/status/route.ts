import { NextRequest } from 'next/server';
import { apiSuccess, apiError } from '@/lib/api-response';
import { encryptApiKey } from '@/lib/crypto';
import { redactSensitiveCommandOutput } from '@/lib/command-output-redaction';
import {
  buildCodexStatusCommand,
  CODEX_VAULT_KEY_NAME,
  CODEX_VAULT_KEY_PREVIEW,
  parseCodexCommandJson,
  serializeCodexVaultBundle,
  type CodexVaultBundle,
} from '@/lib/codex-oauth';
import { sshExec } from '@/lib/hetzner/ssh';
import { resolveHermesExecUserFromConfig, resolveHermesHomeDirFromConfig } from '@/lib/hermes-home';
import {
  hasCodexBundleChanged,
  loadUserCodexVaultBundle,
  readCachedCodexVaultBundle,
  restartCodexGateway,
  syncCodexRuntimeAuthStore,
} from '@/lib/services/codex-runtime-auth';
import { validateConsoleAccess } from '@/lib/services/console-helpers';
import { INVALID_PROFILE_NAME_ERROR, normalizeProfileName } from '@/lib/profile-name';
import { isCodexAuthProvider } from '@/lib/provider-auth';
import { ProfileService } from '@/lib/services/profile-service';
import { supabaseAdmin } from '@/lib/supabase';
import { log } from '@/lib/logger';
import { isWebfreeBackend } from '@/lib/types/instance';
import { GUEST_IDENTITY_REFUSED_MESSAGE, GUEST_SSH_REFUSED_MARKER } from "@/lib/proxmox/hermes-guest-ssh";

const SAFE_VAULT_PERSISTENCE_ERROR =
  'Unable to save the reusable Vault session. Please try again or contact support.';
const CODEX_STATUS_ERROR = 'Failed to check the Hermes Codex auth status.';
const CODEX_STATUS_PARSE_ERROR = 'Codex status command returned an unreadable status payload.';
const CODEX_STATUS_RUNTIME_HELPER_ERROR =
  'Codex auth support is unavailable in this Hermes runtime. Update or restart the instance, then try again.';
const WEBUI_EXEC_USER = "1024:1024";
const WEBUI_HERMES_HOME = "/home/hermes/.hermes";

function buildCodexVaultSessionName(now = new Date()): string {
  return `${CODEX_VAULT_KEY_NAME} ${now.toISOString().replace(/\.\d{3}Z$/, 'Z')}`;
}

async function createCodexVaultSession(userId: string, bundle: CodexVaultBundle): Promise<string | null> {
  if (!supabaseAdmin) {
    throw new Error('Database not configured');
  }

  const payload = {
    user_id: userId,
    name: buildCodexVaultSessionName(),
    provider: 'codex',
    encrypted_key: encryptApiKey(serializeCodexVaultBundle(bundle)),
    key_preview: CODEX_VAULT_KEY_PREVIEW,
    is_active: true,
    updated_at: new Date().toISOString(),
  };

  const query = supabaseAdmin.from('user_api_keys');
  const insertQuery = query
    .insert(payload)
    .select('id') as unknown as {
      single?: () => Promise<{ data?: { id?: string } | null; error?: { message?: string } | null }>;
      maybeSingle?: () => Promise<{ data?: { id?: string } | null; error?: { message?: string } | null }>;
    };
  const { data: inserted, error: insertError } =
    typeof insertQuery.single === 'function'
      ? await insertQuery.single()
      : await insertQuery.maybeSingle!();

  if (insertError) {
    throw new Error(`Failed to store Codex Vault session: ${insertError.message}`);
  }

  return inserted?.id ?? null;
}

async function persistCodexSessionToInstance(
  instanceId: string,
  userId: string,
  bundle: CodexVaultBundle,
  provider = 'codex'
): Promise<void> {
  if (!supabaseAdmin) {
    throw new Error('Database not configured');
  }

  const { error } = await supabaseAdmin
    .from('hermes_instances')
    .update({
      api_key_encrypted: encryptApiKey(serializeCodexVaultBundle(bundle)),
      api_key_preview: CODEX_VAULT_KEY_PREVIEW,
      updated_at: new Date().toISOString(),
    })
    .eq('id', instanceId)
    .eq('user_id', userId)
    .eq('provider', provider);

  if (error) {
    throw new Error(`Failed to persist Codex session to instance: ${error.message}`);
  }
}

function buildCachedCodexStatusResponse(
  bundle: CodexVaultBundle,
  sourceHint?: string,
  options?: {
    vaultKeyId?: string | null;
    persistenceError?: string;
    gatewayRestartTriggered?: boolean;
    gatewayRestartRequired?: boolean;
    runtime?: "webui";
  }
) {
  return apiSuccess({
    authenticated: true,
    source: sourceHint || bundle.source || 'stored-vault',
    expired: false,
    vaultKeyId: options?.vaultKeyId ?? null,
    persistenceError: options?.persistenceError,
    gatewayRestartTriggered: options?.gatewayRestartTriggered ?? false,
    gatewayRestartRequired: options?.gatewayRestartRequired ?? false,
    cached: true,
    degraded: true,
    ...(options?.runtime ? { runtime: options.runtime } : {}),
  });
}

function classifyCodexStatusFailure(result: {
  stdout?: string;
  stderr?: string;
  error?: string;
}) {
  const rawMessage = (result.stderr || result.error || result.stdout || '').trim();
  const normalized = rawMessage.toLowerCase();
  const presence = buildCodexStatusCommandFailureDetails(result);

  // Checked first: a refused guest identity check can follow a guest agent
  // error such as "QEMU guest agent is not running", which is not the runtime.
  if (`${result.stderr || ''}\n${result.error || ''}`.includes(GUEST_SSH_REFUSED_MARKER)) {
    return { status: 503, message: GUEST_IDENTITY_REFUSED_MESSAGE };
  }

  if (
    normalized.includes('no such container') ||
    normalized.includes('is not running') ||
    normalized.includes('command exited with code 128') ||
    normalized.includes('command exited with code 137')
  ) {
    return {
      status: 503,
      message: 'Agent container is not running. Please start your instance first.',
    };
  }

  if (normalized.includes('timed out') || normalized.includes('timeout')) {
    return {
      status: 504,
      message: 'Timed out while checking the Hermes Codex auth status. Try again in a moment.',
    };
  }

  if (
    normalized.includes('ssh connection error') ||
    normalized.includes('econnreset') ||
    normalized.includes('econnrefused') ||
    normalized.includes('handshake failed')
  ) {
    return {
      status: 503,
      message: 'Unable to reach the Hermes runtime right now. Try again in a moment.',
    };
  }

  if (
    normalized.includes("no module named 'hermes_cli'") ||
    normalized.includes('no module named hermes_cli') ||
    normalized.includes("module 'hermes_cli.auth' has no attribute") ||
    normalized.includes('module hermes_cli.auth has no attribute')
  ) {
    return {
      status: 503,
      message: CODEX_STATUS_RUNTIME_HELPER_ERROR,
      details: {
        ...presence,
        failureCategory: normalized.includes('has no attribute')
          ? 'codex_auth_private_helper_missing'
          : 'codex_auth_module_missing',
      },
    };
  }

  // Codex CLI binary missing in agent container — common when the user
  // has never opened the Codex tab on this instance and the CLI was never
  // installed. UI should show "not authenticated" instead of an error.
  if (
    normalized.includes('command not found') ||
    normalized.includes('executable file not found') ||
    normalized.includes('command exited with code 127')
  ) {
    return {
      status: 503,
      message: 'Codex CLI is not installed on this agent yet.',
      details: { ...presence, failureCategory: 'codex_cli_missing' },
    };
  }

  return null;
}

function buildCodexStatusCommandFailureDetails(result: {
  stdout?: string;
  stderr?: string;
  error?: string;
}) {
  const rawMessage = (result.stderr || result.error || result.stdout || '').trim();
  const normalized = rawMessage.toLowerCase();
  const commandExitMatch = rawMessage.match(/command exited with code\s+(\d+)/i);
  let failureCategory = 'unknown';

  if (normalized.includes('permission denied')) {
    failureCategory = 'permission_denied';
  } else if (normalized.includes('read-only file system')) {
    failureCategory = 'read_only_filesystem';
  } else if (normalized.includes('no space left on device')) {
    failureCategory = 'disk_full';
  } else if (normalized.includes('modulenotfounderror')) {
    failureCategory = 'python_module_missing';
  } else if (normalized.includes('attributeerror')) {
    failureCategory = 'python_attribute_error';
  } else if (commandExitMatch) {
    failureCategory = `command_exit_${commandExitMatch[1]}`;
  }

  return {
    failureType: 'codex_status_command_failed',
    failureCategory,
    stderrPresent: Boolean(result.stderr),
    errorPresent: Boolean(result.error),
    stdoutPresent: Boolean(result.stdout),
    stderrLength: result.stderr?.length ?? 0,
    errorLength: result.error?.length ?? 0,
    stdoutLength: result.stdout?.length ?? 0,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const access = await validateConsoleAccess(params);
    if (access.errorResponse) return access.errorResponse;
    const { id: instanceId, hostIp } = access;
    let profileName = 'default';
    try {
      profileName = normalizeProfileName(request.nextUrl.searchParams.get('profile'));
    } catch (err) {
      const message = err instanceof Error ? err.message : INVALID_PROFILE_NAME_ERROR;
      return apiError(message, 400);
    }
    const errorOptions = {
      source: 'codex-oauth-status',
      route: '/api/instances/[id]/oauth/codex/status',
      instanceId,
      userId: access.userId,
      profileName,
      metadata: {
        hostIp,
      },
    } as const;
    const instanceConfig =
      access.instance?.config && typeof access.instance.config === 'object'
        ? access.instance.config as Record<string, unknown>
        : undefined;
    const instanceProvider = access.instance?.provider || null;
    const isInstanceCodexProvider = isCodexAuthProvider(instanceProvider);
    const cachedBundle = readCachedCodexVaultBundle(access.instance?.api_key_encrypted);
    const isWebUIBackend = isWebfreeBackend(access.instance?.backend);
    const applyRuntimeChanges = request.nextUrl.searchParams.get('apply') === '1';
    const hermesHomeDir = isWebUIBackend
      ? WEBUI_HERMES_HOME
      : resolveHermesHomeDirFromConfig(instanceConfig);
    const hermesExecUser = isWebUIBackend
      ? WEBUI_EXEC_USER
      : resolveHermesExecUserFromConfig(instanceConfig);
    const targetHermesHomeDir =
      !isWebUIBackend && profileName !== 'default'
        ? `${hermesHomeDir}/profiles/${profileName}`
        : hermesHomeDir;

    if (!/^[a-zA-Z0-9-]+$/.test(instanceId)) {
      return apiError('Invalid instance ID format', 400);
    }

    // SSH dominates wall-clock here. Fire it immediately and run the DB lookups
    // (profile provider + stored vault session) in parallel. The vault-bundle
    // lookup is speculative — we keep the result only when effectiveProvider
    // resolves to 'codex'.
    const sshPromise = sshExec(
      hostIp,
      buildCodexStatusCommand(instanceId, hermesExecUser, targetHermesHomeDir),
      { proxmoxHostConfig: access.proxmoxHostConfig ?? null }
    );
    const profileProviderPromise = profileName !== 'default'
      ? ProfileService.getProfileProvider(access.id, access.userId, profileName).catch(() => null)
      : Promise.resolve(null);
    const mightBeCodex = isInstanceCodexProvider || profileName !== 'default';
    const speculativeVaultPromise = mightBeCodex
      ? loadUserCodexVaultBundle(access.userId).catch(() => ({
          bundle: null,
          encryptedKey: null,
          vaultKeyId: null,
        }))
      : Promise.resolve({ bundle: null, encryptedKey: null, vaultKeyId: null });

    const [result, profileProvider, speculativeVault] = await Promise.all([
      sshPromise,
      profileProviderPromise,
      speculativeVaultPromise,
    ]);
    const effectiveProvider = profileProvider || instanceProvider;
    const isEffectiveCodexProvider = isCodexAuthProvider(effectiveProvider);
    const storedVaultSession = isEffectiveCodexProvider
      ? speculativeVault
      : { bundle: null, encryptedKey: null, vaultKeyId: null };
    const reusableBundle = cachedBundle || storedVaultSession.bundle;
    const isProfileCodexTarget = profileName !== 'default' && isEffectiveCodexProvider;

    const syncSelectedProfileBundle = async (
      bundle: CodexVaultBundle,
      options?: { forceRestart?: boolean }
    ) => {
      let persistenceError: string | undefined;
      let gatewayRestartTriggered = false;
      let gatewayRestartRequired = false;

      try {
        const runtimeSync = await syncCodexRuntimeAuthStore(
          access.id,
          access.hostIp,
          access.proxmoxHostConfig ?? null,
          bundle,
          targetHermesHomeDir
        );
        const runtimeNeedsRestart = runtimeSync.changed || options?.forceRestart === true;
        gatewayRestartRequired = runtimeNeedsRestart;

        if (isWebUIBackend && runtimeNeedsRestart && applyRuntimeChanges) {
          log.info("restarting WebUI after explicit Codex OAuth apply", {
            source: "oauth-codex-status",
            route: "/api/instances/[id]/oauth/codex/status",
            method: "GET",
            instanceId: access.id,
            userId: access.userId,
            profileName,
            runtimeSyncChanged: runtimeSync.changed,
            forceRestart: options?.forceRestart === true,
            applyRuntimeChanges,
            failureType: "codex_oauth_runtime_restart_apply",
          });
          gatewayRestartTriggered = await restartCodexGateway(access.id, access.hostIp, access.proxmoxHostConfig ?? null);
        } else if (!isWebUIBackend && runtimeNeedsRestart && applyRuntimeChanges) {
          await ProfileService.stopProfileGateway(access.id, access.userId, profileName);
          await ProfileService.startProfileGateway(access.id, access.userId, profileName);
          gatewayRestartTriggered = true;
        } else if (runtimeNeedsRestart) {
          log.info("deferred Codex runtime restart during passive status poll", {
            source: "oauth-codex-status",
            route: "/api/instances/[id]/oauth/codex/status",
            method: "GET",
            instanceId: access.id,
            userId: access.userId,
            profileName,
            backend: isWebUIBackend ? "webui" : "gateway",
            runtimeSyncChanged: runtimeSync.changed,
            forceRestart: options?.forceRestart === true,
            applyRuntimeChanges,
            failureType: "codex_oauth_runtime_restart_deferred",
          });
        }
        gatewayRestartRequired = runtimeNeedsRestart && !gatewayRestartTriggered;
      } catch (err) {
        const rawError = err instanceof Error ? err.message : String(err);
        persistenceError = SAFE_VAULT_PERSISTENCE_ERROR;
        log.error("profile runtime sync failed", err, {
          source: "oauth-codex-status",
          route: "/api/instances/[id]/oauth/codex/status",
          method: "GET",
          instanceId: access.id,
          userId: access.userId,
          profileName,
          failureType: "codex_profile_runtime_sync_failed",
          redactedError: redactSensitiveCommandOutput(rawError, 600),
        });
      }

      return {
        persistenceError,
        gatewayRestartTriggered,
        gatewayRestartRequired,
      };
    };

    const buildReusableBundleFallbackResponse = async (options?: { syncRuntime?: boolean }) => {
      if (!reusableBundle) {
        return null;
      }

      let profileSyncResult = {
        persistenceError: undefined as string | undefined,
        gatewayRestartTriggered: false,
        gatewayRestartRequired: false,
      };
      if (isProfileCodexTarget) {
        profileSyncResult = await syncSelectedProfileBundle(reusableBundle);
      } else if (options?.syncRuntime && isInstanceCodexProvider) {
        try {
          const runtimeSync = await syncCodexRuntimeAuthStore(
            access.id,
            access.hostIp,
            access.proxmoxHostConfig ?? null,
            reusableBundle,
            targetHermesHomeDir
          );
          if (runtimeSync.changed && applyRuntimeChanges) {
            log.info("restarting Codex runtime after explicit stored Vault apply", {
              source: "oauth-codex-status",
              route: "/api/instances/[id]/oauth/codex/status",
              method: "GET",
              instanceId: access.id,
              userId: access.userId,
              profileName,
              backend: isWebUIBackend ? "webui" : "gateway",
              applyRuntimeChanges,
              failureType: "codex_stored_vault_runtime_restart_apply",
            });
            profileSyncResult.gatewayRestartTriggered = await restartCodexGateway(access.id, access.hostIp, access.proxmoxHostConfig ?? null);
          } else if (runtimeSync.changed) {
            profileSyncResult.gatewayRestartRequired = true;
            log.info("deferred stored Vault runtime restart during passive status poll", {
              source: "oauth-codex-status",
              route: "/api/instances/[id]/oauth/codex/status",
              method: "GET",
              instanceId: access.id,
              userId: access.userId,
              profileName,
              backend: isWebUIBackend ? "webui" : "gateway",
              applyRuntimeChanges,
              failureType: "codex_stored_vault_runtime_restart_deferred",
            });
          }
        } catch (err) {
          const rawError = err instanceof Error ? err.message : String(err);
          profileSyncResult.persistenceError = SAFE_VAULT_PERSISTENCE_ERROR;
          log.error("runtime sync from stored Vault session failed", err, {
            source: "oauth-codex-status",
            route: "/api/instances/[id]/oauth/codex/status",
            method: "GET",
            instanceId: access.id,
            userId: access.userId,
            profileName,
            failureType: "codex_stored_vault_runtime_sync_failed",
            redactedError: redactSensitiveCommandOutput(rawError, 600),
          });
        }
      }

      return buildCachedCodexStatusResponse(reusableBundle, 'stored-vault', {
        vaultKeyId: storedVaultSession.vaultKeyId,
        persistenceError: profileSyncResult.persistenceError,
        gatewayRestartTriggered: profileSyncResult.gatewayRestartTriggered,
        gatewayRestartRequired: profileSyncResult.gatewayRestartRequired,
        runtime: isWebUIBackend ? 'webui' : undefined,
      });
    };

    if (!result.ok) {
      const failure = classifyCodexStatusFailure(result);
      const fallbackResponse = await buildReusableBundleFallbackResponse();
      if (fallbackResponse) {
        return fallbackResponse;
      }
      if (failure) {
        return apiError(failure.message, failure.status, failure.details, undefined, errorOptions);
      }
      // Default to 503 (transient unavailability) rather than 500 — an
      // SSH command that exits non-zero is "this VM can't answer right
      // now," not an internal server bug. 500-spam from a polling UI
      // looks like an outage even when the underlying instance is fine.
      return apiError(
        CODEX_STATUS_ERROR,
        503,
        buildCodexStatusCommandFailureDetails(result),
        undefined,
        errorOptions
      );
    }

    const output = (result.stdout || '').trim();
    if (!output) {
      const fallbackResponse = await buildReusableBundleFallbackResponse();
      if (fallbackResponse) {
        return fallbackResponse;
      }
      return apiError('Codex status command did not return a status payload.', 500);
    }

    let payload: {
      authenticated?: unknown;
      source?: unknown;
      expired?: unknown;
      pendingDeviceFlow?: unknown;
      vaultBundle?: CodexVaultBundle;
    };
    try {
      payload = parseCodexCommandJson(output);
    } catch (err) {
      const fallbackResponse = await buildReusableBundleFallbackResponse();
      if (fallbackResponse) {
        return fallbackResponse;
      }
      return apiError(
        CODEX_STATUS_PARSE_ERROR,
        500,
        {
          failureType: 'codex_status_parse_failed',
          errorName: err instanceof Error ? err.name : typeof err,
          outputLength: output.length,
        },
        undefined,
        errorOptions
      );
    }

    let vaultKeyId: string | null = null;
    let persistenceError: string | undefined;
    let gatewayRestartTriggered = false;
    let gatewayRestartRequired = false;
    let runtimeAuthStoreChanged = false;
    const authSource = typeof payload.source === 'string' ? payload.source : undefined;
    const authCompletedInThisPoll = authSource === 'device-code';
    const pendingDeviceFlow = payload.pendingDeviceFlow === true;
    const shouldReloadGateway =
      payload.authenticated === true &&
      payload.vaultBundle &&
      isInstanceCodexProvider &&
      authCompletedInThisPoll &&
      hasCodexBundleChanged(access.instance?.api_key_encrypted, payload.vaultBundle);

    if (payload.authenticated === true && payload.vaultBundle) {
      try {
        vaultKeyId = authCompletedInThisPoll
          ? await createCodexVaultSession(access.userId, payload.vaultBundle)
          : storedVaultSession.vaultKeyId;
        if (isProfileCodexTarget) {
          const profileSyncResult = await syncSelectedProfileBundle(payload.vaultBundle, {
            forceRestart: authCompletedInThisPoll,
          });
          persistenceError = profileSyncResult.persistenceError;
          gatewayRestartTriggered = profileSyncResult.gatewayRestartTriggered;
        } else if (isInstanceCodexProvider) {
          await persistCodexSessionToInstance(access.id, access.userId, payload.vaultBundle, instanceProvider || 'codex');
          if (authCompletedInThisPoll) {
            const runtimeSync = await syncCodexRuntimeAuthStore(
              access.id,
              access.hostIp,
              access.proxmoxHostConfig ?? null,
              payload.vaultBundle,
              targetHermesHomeDir
            );
            runtimeAuthStoreChanged = runtimeSync.changed;
          }
          if (shouldReloadGateway || runtimeAuthStoreChanged) {
            if (applyRuntimeChanges) {
              log.info("restarting Codex runtime after explicit OAuth completion apply", {
                source: "oauth-codex-status",
                route: "/api/instances/[id]/oauth/codex/status",
                method: "GET",
                instanceId: access.id,
                userId: access.userId,
                profileName,
                backend: isWebUIBackend ? "webui" : "gateway",
                shouldReloadGateway,
                runtimeAuthStoreChanged,
                applyRuntimeChanges,
                failureType: "codex_oauth_completion_runtime_restart_apply",
              });
              gatewayRestartTriggered = await restartCodexGateway(access.id, access.hostIp, access.proxmoxHostConfig ?? null);
            } else {
              gatewayRestartRequired = true;
              log.info("deferred OAuth completion runtime restart during passive status poll", {
                source: "oauth-codex-status",
                route: "/api/instances/[id]/oauth/codex/status",
                method: "GET",
                instanceId: access.id,
                userId: access.userId,
                profileName,
                backend: isWebUIBackend ? "webui" : "gateway",
                shouldReloadGateway,
                runtimeAuthStoreChanged,
                applyRuntimeChanges,
                failureType: "codex_oauth_completion_runtime_restart_deferred",
              });
            }
          }
        }
      } catch (err) {
        const rawError = err instanceof Error ? err.message : String(err);
        persistenceError = SAFE_VAULT_PERSISTENCE_ERROR;
        log.error("vault persistence failed", err, {
          source: "oauth-codex-status",
          route: "/api/instances/[id]/oauth/codex/status",
          method: "GET",
          instanceId: access.id,
          userId: access.userId,
          profileName,
          failureType: "codex_vault_persistence_failed",
          redactedError: redactSensitiveCommandOutput(rawError, 600),
        });
      }
    }

    if (payload.authenticated !== true && !pendingDeviceFlow && payload.expired !== true) {
      const fallbackResponse = await buildReusableBundleFallbackResponse({ syncRuntime: true });
      if (fallbackResponse) {
        return fallbackResponse;
      }
    }

    return apiSuccess({
      authenticated: payload.authenticated === true,
      source: authSource,
      expired: payload.expired === true,
      pendingDeviceFlow,
      vaultKeyId,
      persistenceError,
      gatewayRestartTriggered,
      gatewayRestartRequired,
      ...(isWebUIBackend ? { runtime: 'webui' } : {}),
    });
  } catch (err: unknown) {
    return apiError(
      CODEX_STATUS_ERROR,
      500,
      {
        failureType: 'codex_status_unexpected_error',
        errorName: err instanceof Error ? err.name : typeof err,
      },
      undefined,
      {
        source: 'codex-oauth-status',
        route: '/api/instances/[id]/oauth/codex/status',
      }
    );
  }
}
