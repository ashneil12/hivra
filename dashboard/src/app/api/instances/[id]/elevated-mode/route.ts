import { NextRequest } from 'next/server';
import { apiSuccess, apiError } from '@/lib/api-response';
import { log } from '@/lib/logger';
import { sshExec } from '@/lib/hetzner/ssh';
import { validateConsoleAccess } from '@/lib/services/console-helpers';
import {
  buildElevatedModeApplyScript,
  buildElevatedModeReadScript,
  isElevatedFromReadOutput,
} from './elevated-mode-script';

// Recreate (+ first-boot dependency install) can take longer than a plain
// restart, so allow more headroom than the integrations route's 45s.
const ELEVATED_APPLY_TIMEOUT_MS = 90_000;
const ELEVATED_READ_TIMEOUT_MS = 30_000;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const access = await validateConsoleAccess(params);
    if (access.errorResponse) return access.errorResponse;
    const { id: instanceId, hostIp } = access;

    if (!/^[a-zA-Z0-9-]+$/.test(instanceId)) {
      return apiError('Invalid instance ID format', 400);
    }

    const result = await sshExec(hostIp, buildElevatedModeReadScript(instanceId), {
      timeoutMs: ELEVATED_READ_TIMEOUT_MS,
      proxmoxHostConfig: access.proxmoxHostConfig ?? null,
    });
    if (!result.ok) {
      log.warn('elevated-mode read failed', {
        source: 'elevated-mode',
        route: '/api/instances/[id]/elevated-mode',
        method: 'GET',
        instanceId,
        userId: access.userId,
        failureType: 'elevated_mode_read_failed',
        stderr: (result.stderr || result.error || '').slice(0, 400),
      });
      return apiError('Failed to read elevated-mode state from the remote node.', 502);
    }
    return apiSuccess({ enabled: isElevatedFromReadOutput(result.stdout) });
  } catch (err) {
    log.error('elevated-mode read errored', err, {
      source: 'elevated-mode',
      route: '/api/instances/[id]/elevated-mode',
      method: 'GET',
      failureType: 'elevated_mode_read_error',
    });
    return apiError('Failed to read elevated-mode state from the remote node.', 500);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const access = await validateConsoleAccess(params);
    if (access.errorResponse) return access.errorResponse;
    const { id: instanceId, hostIp } = access;

    if (!/^[a-zA-Z0-9-]+$/.test(instanceId)) {
      return apiError('Invalid instance ID format', 400);
    }

    const body = await request.json().catch(() => ({}));
    if (typeof body?.enabled !== 'boolean') {
      return apiError('Request body must include a boolean "enabled" field.', 400);
    }
    const enabled: boolean = body.enabled;

    const result = await sshExec(hostIp, buildElevatedModeApplyScript(instanceId, enabled), {
      timeoutMs: ELEVATED_APPLY_TIMEOUT_MS,
      proxmoxHostConfig: access.proxmoxHostConfig ?? null,
    });
    if (!result.ok) {
      log.warn('elevated-mode apply failed', {
        source: 'elevated-mode',
        route: '/api/instances/[id]/elevated-mode',
        method: 'POST',
        instanceId,
        userId: access.userId,
        enabled,
        failureType: 'elevated_mode_apply_failed',
        stderr: (result.stderr || result.error || '').slice(0, 400),
      });
      return apiError('Failed to apply elevated mode on the remote node.', 502);
    }

    log.info('elevated-mode applied', {
      source: 'elevated-mode',
      route: '/api/instances/[id]/elevated-mode',
      method: 'POST',
      instanceId,
      userId: access.userId,
      enabled,
    });

    return apiSuccess({
      enabled,
      restartRequired: true,
      message: enabled
        ? 'Agent elevated mode ENABLED — the agent now has passwordless sudo (root) inside its container. Restarting it now.'
        : 'Agent elevated mode disabled — sudo access revoked. Restarting the agent now.',
    });
  } catch {
    return apiError('Failed to apply elevated mode on the remote node.', 500);
  }
}
