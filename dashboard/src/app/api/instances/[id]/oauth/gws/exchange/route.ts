import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiSuccess, apiError } from '@/lib/api-response';
import { redactSensitiveCommandOutput } from '@/lib/command-output-redaction';
import { buildGoogleWorkspaceExchangeCommand } from '@/lib/google-workspace-oauth';
import { sshExec } from '@/lib/hetzner/ssh';
import { validateConsoleAccess } from '@/lib/services/console-helpers';
import { log } from '@/lib/logger';

const GoogleWorkspaceExchangeSchema = z.object({
  code: z.string().min(1),
});

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

    const parsed = GoogleWorkspaceExchangeSchema.safeParse(await request.json());
    if (!parsed.success) {
      return apiError('Missing auth code.', 400);
    }
    const { code } = parsed.data;

    // 1. Send the auth code and set up opportunistic background restart in ONE step
    // preventing the need for a secondary SSH handshake.
    const exchangeCommand = buildGoogleWorkspaceExchangeCommand(instanceId, code);
    // Defense-in-depth: instanceId is regex-validated above
    // (`[a-zA-Z0-9-]+`), so it has no shell-special characters today.
    // Wrap the inner restart in SINGLE quotes so a future regex relaxation
    // can't turn an interpolated value into command injection. Single
    // quotes can't be escaped from within single quotes; instanceId can't
    // contain a single quote, so the literal is closed at exactly the
    // boundary we expect.
    //
    // Webfree VMs run agent-<id>-gateway, not the bare agent-<id> the
    // Hetzner docker lane uses, so resolve the running container the same
    // way buildAgentContainerResolver does before restarting — otherwise
    // this no-ops on webfree and the agent never picks up the new creds.
    // The resolution stays inside the single-quoted sh -c body (no single
    // quotes introduced, so the injection guard above holds) and uses an
    // unquoted --format so it survives that single-quote boundary.
    const execCommand = `
      output=$(${exchangeCommand})
      exit_code=$?
      echo "$output"
      if [ $exit_code -eq 0 ] && ! echo "$output" | grep -q "ERROR:"; then
        nohup sh -c 'sleep 2 && c=agent-${instanceId}; docker inspect --format={{.State.Running}} "$c" 2>/dev/null | grep -q true || c=agent-${instanceId}-gateway; docker restart "$c"' >/dev/null 2>&1 &
      fi
      exit $exit_code
    `;
    
    // We increase timeout because token requests might occasionally be slow
    const result = await sshExec(hostIp, execCommand, { timeoutMs: 30000, proxmoxHostConfig: access.proxmoxHostConfig ?? null });
    const output = (result.stdout || '') + '\\n' + (result.stderr || '');

    if (!result.ok && output.includes('No such container')) {
      return apiError('Agent container is not running. Please start your instance first.', 503);
    }

    // Success requires BOTH a clean exit code AND no error token. The command
    // ends with `exit $exit_code`, so sshExec sets `result.ok === false` when
    // the exchange tool exits non-zero — gate on that too. A tool that fails
    // without printing the exact `ERROR:` token used to slip through the
    // output-only check, returning {success:true} and firing the restart over
    // creds that were never written.
    if (!result.ok || output.includes('ERROR:')) {
      log.error("exchange command reported an error", new Error("gws_exchange_command_error"), {
        source: "oauth-gws-exchange",
        route: "/api/instances/[id]/oauth/gws/exchange",
        method: "POST",
        instanceId,
        userId: access.userId,
        failureType: "gws_exchange_command_error",
        redactedOutput: redactSensitiveCommandOutput(output),
      });
      return apiError(
        'Failed to exchange Google OAuth code.',
        400
      );
    }

    return apiSuccess({
      success: true,
    });
  } catch (err: unknown) {
    return apiError('Failed to exchange Google OAuth code.', 500, {
      failureType: 'gws_exchange_unexpected_error',
      errorName: err instanceof Error ? err.name : typeof err,
    });
  }
}
