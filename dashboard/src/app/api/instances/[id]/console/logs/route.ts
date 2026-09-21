import { NextRequest } from 'next/server';
import { apiSuccess, apiError, handleApiError } from '@/lib/api-response';
import { sshExec } from '@/lib/hetzner/ssh';
import { validateConsoleAccess, discoverContainerName } from '@/lib/services/console-helpers';
import { resolveHermesHomeDirFromConfig } from '@/lib/hermes-home';

function classifyLogsFailure(result: { stderr?: string; error?: string }) {
  const rawMessage = (result.stderr || result.error || '').trim();
  const normalized = rawMessage.toLowerCase();

  if (normalized.includes('no such container') || normalized.includes('not found')) {
    return {
      status: 404,
      message: 'Instance container not found on host. The agent may be stopped or the server misconfigured.',
    };
  }

  if (normalized.includes('timed out') || normalized.includes('timeout')) {
    return {
      status: 504,
      message: rawMessage || 'Timed out while fetching logs',
    };
  }

  if (normalized.includes('ssh connection error')) {
    return {
      status: 503,
      message: rawMessage || 'SSH connection error while fetching logs',
    };
  }

  return {
    status: 500,
    message: rawMessage || 'Failed to fetch logs',
  };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const access = await validateConsoleAccess(params);
    if (access.errorResponse) return access.errorResponse;
    const { id, hostIp, instance, proxmoxHostConfig } = access;

    const containerName = await discoverContainerName(hostIp, id, proxmoxHostConfig);
    const hermesHomeDir = resolveHermesHomeDirFromConfig(instance?.config as Record<string, unknown> | undefined);
    const escapedHermesHomeDir = JSON.stringify(hermesHomeDir);
    const escapedContainerName = JSON.stringify(containerName);
    const script = [
      'set -e',
      `CONTAINER_NAME=${escapedContainerName}`,
      `EXPECTED_HERMES_HOME=${escapedHermesHomeDir}`,
      'if output=$(docker exec -e EXPECTED_HERMES_HOME="$EXPECTED_HERMES_HOME" "$CONTAINER_NAME" sh -lc \'',
      'HERMES_HOME="${HERMES_HOME:-$EXPECTED_HERMES_HOME}"',
      'for candidate in "$HERMES_HOME/logs/agent.log" "$HERMES_HOME/logs/errors.log" "$HERMES_HOME/logs/gateway.log" "$HERMES_HOME/gateway.log" "/opt/data/logs/agent.log" "/opt/data/logs/errors.log" "/opt/data/logs/gateway.log" "/opt/data/gateway.log" "/root/.hermes/logs/agent.log" "/root/.hermes/logs/errors.log" "/root/.hermes/logs/gateway.log" "/root/.hermes/gateway.log"; do',
      '  if [ -s "$candidate" ]; then',
      '    printf "__HERMES_LOG_SOURCE__%s\\n" "$candidate"',
      '    tail -n 200 "$candidate"',
      '    exit 0',
      '  fi',
      'done',
      'exit 91',
      '\' 2>&1); then',
      '  printf "%s" "$output"',
      '  exit 0',
      'fi',
      'status=$?',
      'if [ "$status" -ne 0 ]; then',
      '  docker_out="$(docker logs --tail 200 "$CONTAINER_NAME" 2>&1 || true)"',
      '  if [ -n "$docker_out" ]; then',
      '    printf "__HERMES_LOG_SOURCE__docker-stdout\\n"',
      '    printf "%s\\n" "$docker_out"',
      '    exit 0',
      '  fi',
      `  for host_candidate in "/tmp/hermes-update-${id}.log" "/tmp/hermes-gateway-service-status.log" "/opt/hermes/instances/${id}/logs/gateway.log"; do`,
      '    if [ -s "$host_candidate" ]; then',
      '      printf "__HERMES_LOG_SOURCE__host-update-log\\n"',
      '      tail -n 200 "$host_candidate"',
      '      exit 0',
      '    fi',
      '  done',
      '  printf "__HERMES_LOG_SOURCE__docker-stdout\\n"',
      '  exit 0',
      'fi',
      'exit "$status"',
    ].join('\n');

    const result = proxmoxHostConfig
      ? await sshExec(hostIp, script, { proxmoxHostConfig })
      : await sshExec(hostIp, script);

    if (!result.ok) {
      const failure = classifyLogsFailure(result);
      return apiError(failure.message, failure.status);
    }

    const rawLogs = result.stdout || result.stderr || '';
    const lines = rawLogs.split('\n');
    let source = 'docker-stdout';

    if (lines[0]?.startsWith('__HERMES_LOG_SOURCE__')) {
      source = lines.shift()!.replace('__HERMES_LOG_SOURCE__', '').trim() || source;
    }

    const logs = lines.join('\n').trim() || 'No logs available.';

    return apiSuccess({ logs, source });

  } catch (err) {
    return handleApiError(err);
  }
}
