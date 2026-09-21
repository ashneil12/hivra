import { NextRequest } from 'next/server';
import { apiSuccess, apiError, type ApiErrorOptions } from '@/lib/api-response';
import { buildCodexStartCommand, parseCodexCommandJson } from '@/lib/codex-oauth';
import { redactSensitiveCommandOutput } from '@/lib/command-output-redaction';
import { resolveHermesExecUserFromConfig, resolveHermesHomeDirFromConfig } from '@/lib/hermes-home';
import { sshExec } from '@/lib/hetzner/ssh';
import { INVALID_PROFILE_NAME_ERROR, normalizeProfileName } from '@/lib/profile-name';
import { isSshWarmupError, SSH_WARMUP_MESSAGE } from '@/lib/ssh-warmup';
import { validateConsoleAccess } from '@/lib/services/console-helpers';
import { log } from '@/lib/logger';
import { isWebfreeBackend } from '@/lib/types/instance';

const CODEX_OAUTH_SSH_READY_TIMEOUT_MS = 8_000;
const CODEX_OAUTH_START_TIMEOUT_MS = 30_000;
const CODEX_OAUTH_START_CONNECT_ERROR = 'Failed to connect to the instance over SSH.';
const CODEX_OAUTH_START_ERROR = 'Failed to start the Hermes Codex device flow.';
const CODEX_OAUTH_START_RUNTIME_HELPER_ERROR =
  'Codex auth support is unavailable in this Hermes runtime. Update or restart the instance, then try again.';
const WEBUI_EXEC_USER = "1024:1024";
const WEBUI_HERMES_HOME = "/home/hermes/.hermes";
// Row states in which the agent container is definitively NOT reachable —
// the codex device flow is refused up front (409 instance_off) instead of
// burning the SSH timeouts. Transitional states (provisioning/redeploying)
// are deliberately absent: they fall through to the SSH warmup handling.
const CODEX_START_OFF_STATUSES = new Set([
  'stopped',
  'paused',
  'suspended',
  'archived',
  'error',
  'failed',
  'deleted',
]);
const CODEX_START_OFF_LIFECYCLES = new Set([
  'paused',
  'suspended',
  'cold_archived',
  'pending_deletion',
  'deleting',
  'deleted',
  'failed',
]);

function buildCodexStartCommandFailureDetails(result: {
  stdout?: string;
  stderr?: string;
  error?: string;
}) {
  const rawMessage = (result.stderr || result.error || result.stdout || '').trim();
  const normalized = rawMessage.toLowerCase();
  const commandExitMatch = rawMessage.match(/command exited with code\s+(\d+)/i);
  let failureCategory = 'unknown';

  if (normalized.includes('no such container') || normalized.includes('is not running')) {
    failureCategory = 'container_unavailable';
  } else if (
    normalized.includes("no module named 'hermes_cli'") ||
    normalized.includes('no module named hermes_cli')
  ) {
    failureCategory = 'codex_auth_module_missing';
  } else if (
    normalized.includes("module 'hermes_cli.auth' has no attribute") ||
    normalized.includes('module hermes_cli.auth has no attribute') ||
    normalized.includes('codex_oauth_client_id is unavailable')
  ) {
    failureCategory = 'codex_auth_helper_unavailable';
  } else if (normalized.includes('permission denied')) {
    failureCategory = 'permission_denied';
  } else if (normalized.includes('no space left on device')) {
    failureCategory = 'disk_full';
  } else if (commandExitMatch) {
    failureCategory = `command_exit_${commandExitMatch[1]}`;
  }

  return {
    failureType: 'codex_start_command_failed',
    failureCategory,
    stderrPresent: Boolean(result.stderr),
    errorPresent: Boolean(result.error),
    stdoutPresent: Boolean(result.stdout),
    stderrLength: result.stderr?.length ?? 0,
    errorLength: result.error?.length ?? 0,
    stdoutLength: result.stdout?.length ?? 0,
    redactedError: rawMessage ? redactSensitiveCommandOutput(rawMessage, 600) : undefined,
  };
}

function classifyCodexStartFailure(result: {
  stdout?: string;
  stderr?: string;
  error?: string;
}) {
  const details = buildCodexStartCommandFailureDetails(result);

  if (details.failureCategory === 'container_unavailable') {
    return {
      status: 503,
      message: 'Agent container is not running. Please start your instance first.',
      details,
    };
  }

  if (
    details.failureCategory === 'codex_auth_module_missing' ||
    details.failureCategory === 'codex_auth_helper_unavailable'
  ) {
    return {
      status: 503,
      message: CODEX_OAUTH_START_RUNTIME_HELPER_ERROR,
      details: {
        ...details,
        redactedError: undefined,
      },
    };
  }

  return null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let errorOptions: ApiErrorOptions = {
    source: 'codex-oauth-start',
    route: '/api/instances/[id]/oauth/codex/start',
  };

  try {
    const access = await validateConsoleAccess(params);
    if (access.errorResponse) return access.errorResponse;
    const { id: instanceId, hostIp } = access;
    const instanceConfig =
      access.instance?.config && typeof access.instance.config === 'object'
        ? access.instance.config as Record<string, unknown>
        : undefined;
    const isWebUIBackend = isWebfreeBackend(access.instance?.backend);
    const hermesExecUser = isWebUIBackend
      ? WEBUI_EXEC_USER
      : resolveHermesExecUserFromConfig(instanceConfig);
    const hermesHomeDir = isWebUIBackend
      ? WEBUI_HERMES_HOME
      : resolveHermesHomeDirFromConfig(instanceConfig);
    let profileName = 'default';
    try {
      profileName = normalizeProfileName(request.nextUrl.searchParams.get('profile'));
    } catch (err) {
      const message = err instanceof Error ? err.message : INVALID_PROFILE_NAME_ERROR;
      return apiError(message, 400);
    }
    errorOptions = {
      ...errorOptions,
      instanceId,
      userId: access.userId,
      profileName,
      metadata: {
        hostIp,
      },
    };
    const targetHermesHomeDir =
      !isWebUIBackend && profileName !== 'default'
        ? `${hermesHomeDir}/profiles/${profileName}`
        : hermesHomeDir;

    if (!/^[a-zA-Z0-9-]+$/.test(instanceId)) {
      return apiError('Invalid instance ID format', 400);
    }

    // Fast precondition check BEFORE any SSH work: the device flow runs a
    // command inside the agent container, which cannot succeed on a box that
    // is stopped/paused/archived. Waiting for the SSH timeouts here burned
    // ~38s per attempt and surfaced as a generic failure; answer immediately
    // with a machine-readable 409 the client maps to "start your agent first".
    // Affirmative-off detection only — an unknown/transitional status falls
    // through to the SSH path, which keeps its own warmup handling.
    const rowStatus =
      typeof (access.instance as { status?: unknown } | undefined)?.status === 'string'
        ? (access.instance as { status: string }).status
        : null;
    const rowLifecycle =
      typeof (access.instance as { lifecycle_state?: unknown } | undefined)?.lifecycle_state === 'string'
        ? (access.instance as { lifecycle_state: string }).lifecycle_state
        : null;
    const instanceIsOff =
      (rowStatus !== null && CODEX_START_OFF_STATUSES.has(rowStatus)) ||
      (rowLifecycle !== null && CODEX_START_OFF_LIFECYCLES.has(rowLifecycle));
    if (instanceIsOff) {
      return apiError(
        'instance_off',
        409,
        {
          failureType: 'codex_start_instance_off',
          instanceStatus: rowStatus,
          lifecycleState: rowLifecycle,
        },
        undefined,
        // Expected control flow (parked box) — keep it out of error dashboards.
        { ...errorOptions, failureType: 'codex_start_instance_off', logLevel: 'info' }
      );
    }

    const sshReadyResult = await sshExec(hostIp, 'true', {
      timeoutMs: CODEX_OAUTH_SSH_READY_TIMEOUT_MS,
    });

    if (!sshReadyResult.ok) {
      const sshReadyMessage = sshReadyResult.stderr?.trim() || sshReadyResult.error || 'Failed to connect to the instance over SSH.';
      if (isSshWarmupError(sshReadyMessage)) {
        return apiError(SSH_WARMUP_MESSAGE, 409);
      }

      return apiError(
        CODEX_OAUTH_START_CONNECT_ERROR,
        500,
        {
          failureType: 'codex_start_ssh_ready_failed',
          redactedError: redactSensitiveCommandOutput(sshReadyMessage, 600),
        },
        undefined,
        errorOptions
      );
    }

    const pollResult = await sshExec(
      hostIp,
      buildCodexStartCommand(instanceId, hermesExecUser, targetHermesHomeDir),
      {
      timeoutMs: CODEX_OAUTH_START_TIMEOUT_MS,
      }
    );
    if (!pollResult.ok && isSshWarmupError(pollResult.error || pollResult.stderr || '')) {
      return apiError(SSH_WARMUP_MESSAGE, 409);
    }
    if (!pollResult.ok) {
      const failure = classifyCodexStartFailure(pollResult);
      if (failure) {
        return apiError(failure.message, failure.status, failure.details, undefined, errorOptions);
      }
      return apiError(
        CODEX_OAUTH_START_ERROR,
        500,
        buildCodexStartCommandFailureDetails(pollResult),
        undefined,
        errorOptions
      );
    }

    const output = (pollResult.stdout || '').trim();
    if (!output) {
      return apiError('Codex start command did not return a device URL.', 500);
    }

    let payload: { url?: unknown; code?: unknown };
    try {
      payload = parseCodexCommandJson(output);
    } catch (err) {
      const redactedMessage = err instanceof Error
        ? redactSensitiveCommandOutput(err.message)
        : String(err);
      log.error("failed to parse device flow output", err, {
        source: "oauth-codex-start",
        route: "/api/instances/[id]/oauth/codex/start",
        method: "POST",
        instanceId,
        userId: access.userId,
        profileName,
        failureType: "codex_device_flow_parse_failed",
        redactedMessage,
        redactedOutput: redactSensitiveCommandOutput(output),
      });
      return apiError(
        'Codex start command returned an unreadable device flow payload.',
        500,
        undefined,
        undefined,
        errorOptions
      );
    }

    if (typeof payload.url !== 'string' || !payload.url.trim()) {
      log.error("device URL missing from parsed payload", new Error("codex_device_url_missing"), {
        source: "oauth-codex-start",
        route: "/api/instances/[id]/oauth/codex/start",
        method: "POST",
        instanceId,
        userId: access.userId,
        profileName,
        failureType: "codex_device_url_missing",
        redactedOutput: redactSensitiveCommandOutput(output),
      });
      return apiError(
        'Codex started but the device URL could not be parsed.',
        500,
        undefined,
        undefined,
        errorOptions
      );
    }

    return apiSuccess({
      url: payload.url.trim(),
      code: typeof payload.code === 'string' && payload.code.trim() ? payload.code.trim() : null,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return apiError(
      CODEX_OAUTH_START_ERROR,
      500,
      {
        failureType: 'codex_start_unexpected_error',
        errorName: err instanceof Error ? err.name : typeof err,
        redactedError: redactSensitiveCommandOutput(msg, 600),
      },
      undefined,
      errorOptions
    );
  }
}
