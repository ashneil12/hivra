import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiSuccess, apiError } from '@/lib/api-response';
import { redactSensitiveCommandOutput } from '@/lib/command-output-redaction';
import { buildGoogleWorkspaceSetupCommand } from '@/lib/google-workspace-oauth';
import { sshExec } from '@/lib/hetzner/ssh';
import { validateConsoleAccess } from '@/lib/services/console-helpers';
import { log } from '@/lib/logger';

const GoogleWorkspaceSetupSchema = z.object({
  credentialsJson: z.string().min(1),
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

    const parsed = GoogleWorkspaceSetupSchema.safeParse(await request.json());
    if (!parsed.success) {
      return apiError('Missing credentials JSON string.', 400);
    }
    const { credentialsJson } = parsed.data;

    // Attempt to validate JSON to prevent absolute failure on remote node
    try {
      JSON.parse(credentialsJson);
    } catch {
      return apiError('Invalid JSON format provided.', 400);
    }

    // 1. Pipe the JSON file securely into the container
    // 2. Instruct the Hermes workspace skill to store the client_secret
    // 3. Request the auth-url
    const execCommand = buildGoogleWorkspaceSetupCommand(instanceId, credentialsJson);
    
    // We increase timeout because setup might install dependencies if it's the first time
    const result = await sshExec(hostIp, execCommand, { timeoutMs: 60000, proxmoxHostConfig: access.proxmoxHostConfig ?? null });
    const output = (result.stdout || '') + '\\n' + (result.stderr || '');

    if (!result.ok && output.includes('No such container')) {
      return apiError('Agent container is not running. Please start your instance first.', 503);
    }

    // Extract the verification URL from the output
    // The setup script prints the URL on its own line or within text.
    const urlMatch = output.match(/https?:\/\/[^\s\n"']+/);

    if (!urlMatch) {
      log.error("authorization URL missing from command output", new Error("gws_setup_url_missing"), {
        source: "oauth-gws-setup",
        route: "/api/instances/[id]/oauth/gws/setup",
        method: "POST",
        instanceId,
        userId: access.userId,
        failureType: "gws_setup_url_missing",
        redactedOutput: redactSensitiveCommandOutput(output),
      });
      return apiError(
        'Google Workspace OAuth started but the authorization URL could not be parsed.',
        500
      );
    }

    return apiSuccess({
      url: urlMatch[0].replace(/[.,)]+$/, ''), // strip trailing punctuation
    });
  } catch (err: unknown) {
    return apiError('Failed to initialize Google OAuth.', 500, {
      failureType: 'gws_setup_unexpected_error',
      errorName: err instanceof Error ? err.name : typeof err,
    });
  }
}
