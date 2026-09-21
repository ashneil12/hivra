import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { apiSuccess, apiError } from '@/lib/api-response';
import { log } from '@/lib/logger';
import { sshExec } from '@/lib/hetzner/ssh';
import { isSshWarmupError } from '@/lib/ssh-warmup';
import { telegramGetMe } from '@/lib/channels/telegram-api';
import { isWebfreeBackend } from '@/lib/types/instance';
import { runtimeComposeServiceExpr } from '@/lib/services/agent-container';
import { validateConsoleAccess } from '@/lib/services/console-helpers';
import type { ProxmoxHostRoutingConfig } from '@/lib/services/proxmox-infrastructure';
import { getSecureUserInstance } from '@/lib/services/instance-security';
import {
  fetchFirstReachableGatewayResponse,
  getGatewayRequestDiagnostics,
} from '@/lib/agent-gateway';
import {
  extractEnvKeys,
  getConfiguredPlatforms,
  getIntegrationDefinition,
  getIntegrationScopeLabel,
  getIntegrationStatesFromEnvContent,
  getMissingFieldLabels,
  resolveIntegrationRuntimeProfile,
  validateIntegrationCredentials,
  validateCustomVariable,
} from '@/lib/integrations/config';
import { GATEWAY_SUBPROFILE_SUPERVISOR_SH_B64 } from '@/lib/services/gateway-supervisor';

// The SSH apply path is bounded at INTEGRATIONS_SSH_TIMEOUT_MS (45s) and retried
// up to INTEGRATIONS_APPLY_MAX_ATTEMPTS times on transient failures — a worst
// case of ~140s. Declare the function duration explicitly (matching the other
// long-running instance routes) so this can never be silently killed under a
// lower default cap. Sibling routes: instances/route.ts, send-stream/route.ts.
export const maxDuration = 300;

const SAFE_PROFILE_NAME = /^[a-zA-Z0-9_-]+$/;
const INTEGRATIONS_SIDECAR_TIMEOUT_MS = 6000;
const INTEGRATIONS_SSH_TIMEOUT_MS = 45000;
const WEBUI_HERMES_HOME = '/home/hermes/.hermes';

function buildIntegrationSuccessPayload(params: {
  platform: string;
  profile: string;
  disconnect: boolean;
  appliedVia: 'sidecar' | 'ssh';
}) {
  const status = params.disconnect ? 'disconnected' : 'configured';
  const profileLabel = params.profile === 'default'
    ? 'the default profile'
    : `the ${params.profile} profile`;

  return {
    success: true,
    platform: params.platform,
    profile: params.profile,
    status,
    restartRequired: true,
    appliedVia: params.appliedVia,
    message: `${params.platform} ${status} for ${profileLabel}. Hermes is restarting the integration gateway now.`,
  };
}

function sanitizeEnvValue(value: unknown): string {
  return String(value).replace(/[\r\n\0]/g, '');
}

function formatEnvValue(value: string): string {
  return `'${value.replace(/'/g, "\\'")}'`;
}

function appendEnvUpdate(envUpdates: string[], key: string, value: unknown) {
  const sanitized = sanitizeEnvValue(value);
  if (!sanitized) return;
  envUpdates.push(`${key}=${formatEnvValue(sanitized)}`);
}

function buildPythonEnvPatchScript(params: {
  targetPath: string;
  envUpdates: string[];
  keysToRemove: string[];
  prefixToRemove: string;
}): string {
  const payloadB64 = Buffer.from(JSON.stringify({
    envUpdates: params.envUpdates,
    keysToRemove: params.keysToRemove,
    prefixToRemove: params.prefixToRemove,
  })).toString('base64');

  return `
import base64
import json
import os
from pathlib import Path

target_path = Path(${JSON.stringify(params.targetPath)})
payload = json.loads(base64.b64decode(${JSON.stringify(payloadB64)}).decode("utf-8"))
env_updates = payload.get("envUpdates") or []
keys_to_remove = set(payload.get("keysToRemove") or [])
prefix_to_remove = payload.get("prefixToRemove") or ""

try:
    current = target_path.read_text()
except FileNotFoundError:
    current = ""

lines = current.splitlines()
if prefix_to_remove:
    lines = [line for line in lines if not line.startswith(prefix_to_remove)]

if keys_to_remove:
    filtered = []
    for line in lines:
        if "=" not in line:
            filtered.append(line)
            continue
        key = line.split("=", 1)[0].strip()
        if key not in keys_to_remove:
            filtered.append(line)
    lines = filtered

lines.extend(str(line) for line in env_updates if str(line).strip())
target_path.parent.mkdir(parents=True, exist_ok=True)
target_path.write_text("\\n".join(line for line in lines if line.strip()).strip() + "\\n")
try:
    os.chown(target_path, 1024, 1024)
    os.chmod(target_path, 0o600)
except OSError:
    pass
`;
}

function buildWebUIIntegrationSshScript(params: {
  instanceId: string;
  profileName: string;
  envUpdates: string[];
  keysToRemove: string[];
  prefixToRemove: string;
}): string {
  const isDefaultProfile = params.profileName === 'default';
  const webuiEnvPath = isDefaultProfile
    ? `${WEBUI_HERMES_HOME}/.env`
    : `${WEBUI_HERMES_HOME}/profiles/${params.profileName}/.env`;
  const webuiPatch = buildPythonEnvPatchScript({
    targetPath: webuiEnvPath,
    envUpdates: params.envUpdates,
    keysToRemove: params.keysToRemove,
    prefixToRemove: params.prefixToRemove,
  });

  // Host-side compose env_file (default profile only). On the managed runtime the
  // instance dir + .env are provisioned root-owned, but the dashboard's SSH user
  // is non-root — so a plain `python3` write throws PermissionError and, under
  // `set -e`, aborts the whole CONNECT before the authoritative write below ever
  // runs (the original "Failed to update settings on remote node" bug: the token
  // landed in neither file and the gateway was never restarted). Use `sudo -n`
  // (hermes has passwordless sudo) and treat it as strictly best-effort — it must
  // never abort the CONNECT. buildPythonEnvPatchScript chowns the file to the
  // runtime UID, so after the first success the file is no longer root-owned.
  const hostEnvPatch = isDefaultProfile
    ? `sudo -n python3 - <<'PY' || echo "[integrations] host env_file sync skipped (non-fatal)" >&2\n${buildPythonEnvPatchScript({
        targetPath: `/opt/hermes/instances/${params.instanceId}/.env`,
        envUpdates: params.envUpdates,
        keysToRemove: params.keysToRemove,
        prefixToRemove: params.prefixToRemove,
      })}\nPY`
    : '';

  return `set -euo pipefail
INSTANCE_DIR="/opt/hermes/instances/${params.instanceId}"
cd "$INSTANCE_DIR"
# 1. Authoritative write (critical): the gateway-supervisor reads THIS profile
#    .env from the shared webui-state volume to (re)start the gateway with the
#    messaging credential. Runs as root inside the runtime container, so it works
#    regardless of host-side file ownership. If this fails, the CONNECT fails.
#    Resolve the runtime compose service: webfree has no webui service (it runs
#    gateway), so hard-coding webui aborts the whole CONNECT under set -e.
docker compose exec -T --user root ${runtimeComposeServiceExpr()} python - <<'PY'
${webuiPatch}
PY
# 2. Best-effort: keep the host-side compose env_file in sync (dashboard status
#    reader + container env on next start). Root-owned on the managed runtime, so
#    it needs sudo and must never abort the CONNECT — step 1 already applied it.
${hostEnvPatch}
# 3. Restart the supervised gateway so it re-reads .env with the new credential.
#    Fire-and-forget (disowned via nohup, stdio redirected so the SSH channel
#    closes immediately), mirroring the legacy \`docker restart agent-<id>\` branch.
#    A SYNCHRONOUS \`docker compose restart gateway\` (SIGTERM grace + cold start)
#    can approach/exceed INTEGRATIONS_SSH_TIMEOUT_MS on a degraded box; sshExec
#    then returns a timeout that isTransientSshFailure classifies transient, so the
#    retry loop re-runs this whole 45s-blocking script up to
#    INTEGRATIONS_APPLY_MAX_ATTEMPTS (~138s) — a top contributor to Telegram/
#    Discord/etc. connect "times out" on degraded boxes. Safe to background: the
#    authoritative env write (step 1) already committed, the success payload
#    already returns restartRequired:true, and the supervisor self-heals. No
#    readiness probe: a synchronous "hermes gateway status" poll only raced
#    INTEGRATIONS_SSH_TIMEOUT_MS and produced false failures on cold restarts.
nohup sh -c 'sleep 1 && docker compose restart gateway' >/dev/null 2>&1 & echo "gateway restart requested"
`;
}

/** Run `hermes pairing approve telegram <code>` inside the runtime container so
 *  the gateway's PairingStore picks the approved id up live (no restart). The
 *  CLI prints "Approved!" on success and a friendly "not found or expired" /
 *  "locked out" line otherwise — exit code is 0 in both cases, so we parse
 *  stdout for the success marker.
 *
 *  Bypasses the env-writer sidecar entirely (this isn't an env write). Runs as
 *  the runtime container's default USER (uid 1024 on webfree gateway, root on
 *  the legacy single-container image) so the pairing JSON it writes is owned
 *  by the same uid that reads it from the gateway process.
 */
async function handleTelegramPairingApprove(args: {
  hostIp: string;
  instanceId: string;
  instance: { backend?: string | null } | null | undefined;
  code: string;
  userId: string;
  proxmoxHostConfig?: ProxmoxHostRoutingConfig | null;
}) {
  const { hostIp, instanceId, instance, code, userId, proxmoxHostConfig } = args;
  // Pre-validated `[A-Z0-9]{8}` upstream — wrap in single quotes anyway as
  // defense in depth.
  const script = isWebfreeBackend(instance?.backend)
    ? `set -euo pipefail
cd "/opt/hermes/instances/${instanceId}"
docker compose exec -T ${runtimeComposeServiceExpr()} /opt/hermes/.venv/bin/hermes pairing approve telegram '${code}'`
    : `set -euo pipefail
docker exec agent-${instanceId} /opt/hermes/.venv/bin/hermes pairing approve telegram '${code}'`;

  const result = await sshExec(hostIp, script, { timeoutMs: INTEGRATIONS_SSH_TIMEOUT_MS, proxmoxHostConfig });

  if (!result.ok) {
    const sshError = result.stderr || result.error || 'Failed to run pairing approval on remote node';
    log.error('telegram pairing approve SSH exec failed', new Error(sshError), {
      source: 'integrations',
      route: '/api/instances/[id]/integrations',
      method: 'POST',
      instanceId,
      userId,
      action: 'pairing-approve',
      failureType: 'pairing_approve_ssh_failed',
    });
    if (isTimeoutErrorMessage(sshError)) {
      return apiError('Timed out while approving the pairing code.', 504, {
        failureType: 'pairing_approve_failed',
        retryable: true,
      });
    }
    return apiError('Failed to approve the pairing code on the remote node.', 500, {
      failureType: 'pairing_approve_failed',
      retryable: false,
    });
  }

  const stdout = result.stdout || '';
  // The CLI prints "  Approved!" (two-space indent) on success; the failure
  // paths emit either "not found or expired" or "locked out". Match on the
  // unambiguous success marker rather than the negative space.
  if (/Approved!/.test(stdout)) {
    log.info('telegram pairing approve handled', {
      source: 'integrations',
      route: '/api/instances/[id]/integrations',
      method: 'POST',
      instanceId,
      userId,
      action: 'pairing-approve',
    });
    return apiSuccess({
      success: true,
      platform: 'Telegram',
      action: 'pairing-approve',
      status: 'approved',
      message: 'Pairing approved. Your Telegram account can now use the bot.',
    });
  }

  if (/locked out/i.test(stdout)) {
    return apiError(
      'Too many bad approval attempts — this bot is in a 1-hour lockout. Try again later.',
      429,
      { failureType: 'pairing_locked_out', retryable: false },
    );
  }

  return apiError(
    'That code isn\'t pending or has expired. Message your bot to get a fresh one.',
    400,
    { failureType: 'pairing_code_not_found', retryable: false },
  );
}

function normalizeProfileName(rawProfile: unknown): string {
  if (typeof rawProfile !== 'string' || !rawProfile.trim()) {
    return 'default';
  }

  const trimmedProfile = rawProfile.trim();
  if (!SAFE_PROFILE_NAME.test(trimmedProfile)) {
    throw new Error('Invalid profile name format');
  }

  return trimmedProfile;
}

function isTimeoutErrorMessage(value: string): boolean {
  return /timed out|ETIMEDOUT/i.test(value);
}

async function fetchSidecarIntegrationKeys(baseUrl: string, apiServerKey: string, profileName: string, instanceIpv4?: string) {
  const sidecarPath = `/_sidecar/api/integrations?profile=${encodeURIComponent(profileName)}`;
  const timestamp = Date.now().toString();
  const signature = crypto.createHmac('sha256', apiServerKey).update(timestamp).digest('hex');

  const { response } = await fetchFirstReachableGatewayResponse({
    baseUrl,
    pathname: sidecarPath,
    instanceIpv4,
    timeoutMs: INTEGRATIONS_SIDECAR_TIMEOUT_MS,
    headers: {
      Authorization: `Bearer ${apiServerKey}`,
      'X-Hermes-Timestamp': timestamp,
      'X-Hermes-Signature': signature,
    },
  });

  if (!response.ok) {
    return { ok: false, status: response.status, text: await response.text() };
  }

  const data = await response.json();
  return { ok: true, keysPresent: Array.isArray(data.keysPresent) ? data.keysPresent : [] };
}

async function fetchEnvContentViaSsh(hostIp: string, instanceId: string, profileName: string, proxmoxHostConfig?: ProxmoxHostRoutingConfig | null) {
  const isSubProfile = profileName !== 'default';
  const script = isSubProfile
    ? `docker exec agent-${instanceId} sh -c 'BASE_HOME="\${HERMES_HOME:-/root/.hermes}"; cat "$BASE_HOME/profiles/${profileName}/.env" 2>/dev/null || true'`
    : `cat /opt/hermes/instances/${instanceId}/.env 2>/dev/null || true`;

  const result = await sshExec(hostIp, script, { timeoutMs: INTEGRATIONS_SSH_TIMEOUT_MS, proxmoxHostConfig });
  if (!result.ok) {
    const failureMessage = result.stderr || result.stdout || result.error || 'Failed to read integration settings';

    if (isTimeoutErrorMessage(failureMessage)) {
      throw new Error('Timed out while reading integration status from the remote node.');
    }

    throw new Error(failureMessage);
  }

  return result.stdout || '';
}

const INTEGRATIONS_STATUS_ERROR = 'Failed to read integration status from the remote node.';
const INTEGRATIONS_UPDATE_ERROR = 'Failed to update settings on remote node.';
// When the box is briefly unreachable (booting, mid-redeploy, host blip) the
// SSH apply fails transiently. Retry a few times before giving up, and when we
// do give up tell the user it's a reachability issue they can retry — not the
// opaque, non-retryable "Failed to update settings on remote node" that made a
// token save silently land nowhere during the 2026-06-20 outage.
const INTEGRATIONS_APPLY_MAX_ATTEMPTS = 3;
const INTEGRATIONS_APPLY_RETRY_DELAY_MS = 1500;
const INTEGRATIONS_UNREACHABLE_ERROR =
  'Could not reach your agent to save this change — it may be starting up or restarting. Please try again in a moment.';

// Transient = the box was unreachable (connection refused / no route / reset /
// handshake) or the SSH call timed out — all worth a retry. Reuses the shared
// ssh-warmup classifier so this stays in sync with the provisioning path.
function isTransientSshFailure(message: string | null | undefined): boolean {
  return isSshWarmupError(message) || isTimeoutErrorMessage(message ?? '');
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const access = await validateConsoleAccess(params);
    if (access.errorResponse) return access.errorResponse;
    const { id: instanceId, hostIp, proxmoxHostConfig } = access;

    if (!/^[a-zA-Z0-9-]+$/.test(instanceId)) {
      return apiError('Invalid instance ID format', 400);
    }

    const profileName = normalizeProfileName(request.nextUrl.searchParams.get('profile'));

    const { instance, apiServerKey, instanceIpv4 } = await getSecureUserInstance({
      id: instanceId,
      userId: access.userId,
      requireRunning: false,
    });

    let envKeys: string[] | null = null;

    if (instance?.gateway_url && apiServerKey) {
      try {
        const sidecarStatus = await fetchSidecarIntegrationKeys(instance.gateway_url, apiServerKey, profileName, instanceIpv4);
        if (sidecarStatus.ok) {
          envKeys = sidecarStatus.keysPresent;
        } else if (sidecarStatus.status !== 404 && sidecarStatus.status !== 502) {
          log.warn('integrations sidecar status read failed', {
            source: 'integrations',
            route: '/api/instances/[id]/integrations',
            method: 'GET',
            instanceId,
            userId: access.userId,
            profileName,
            failureType: 'integrations_sidecar_status_failed',
            sidecarStatus: sidecarStatus.status,
          });
        }
      } catch (err) {
        log.info('integrations sidecar status fetch failed, falling back to SSH', {
          source: 'integrations',
          route: '/api/instances/[id]/integrations',
          method: 'GET',
          instanceId,
          userId: access.userId,
          profileName,
          failureType: 'integrations_sidecar_unreachable',
          errorName: err instanceof Error ? err.name : typeof err,
          ...getGatewayRequestDiagnostics(err),
        });
      }
    }

    if (!envKeys) {
      const envContent = await fetchEnvContentViaSsh(hostIp, instanceId, profileName, proxmoxHostConfig);
      envKeys = extractEnvKeys(envContent);
    }

    const statuses = getIntegrationStatesFromEnvContent(
      envKeys.map((key) => `${key}=1`).join('\n')
    );

    return apiSuccess({
      profileName,
      scopeLabel: getIntegrationScopeLabel(profileName),
      configuredPlatforms: getConfiguredPlatforms(statuses),
      statuses,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'Invalid profile name format') {
      return apiError(msg, 400);
    }
    if (isTimeoutErrorMessage(msg)) {
      return apiError(
        'Timed out while reading integration status from the remote node.',
        504,
        {
          failureType: 'integrations_status_failed',
          retryable: true,
        }
      );
    }
    return apiError(INTEGRATIONS_STATUS_ERROR, 500, {
      failureType: 'integrations_status_failed',
      retryable: false,
    });
  }
}


export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const access = await validateConsoleAccess(params);
    if (access.errorResponse) return access.errorResponse;
    // proxmoxHostConfig is resolved from the instance's own config.infrastructure
    // (its bound host slug/env prefix). Thread it into every sshExec below so the
    // outer PVE host is chosen from the instance's EXPLICIT binding, not by
    // re-inferring the host from the private guest IP. IP-inference scans
    // HERMES_PROXMOX_TARGETS for the first host whose subnet prefix matches — a
    // stale/duplicate entry sharing the 10.250.20 subnet can win and route SSH to
    // the wrong (dead) host IP, which silently breaks CONNECT for that box.
    const { id: instanceId, hostIp, proxmoxHostConfig } = access;

    // Explicit path-traversal prevention: only allow safe characters in the ID block
    if (!/^[a-zA-Z0-9-]+$/.test(instanceId)) {
      return apiError('Invalid instance ID format', 400);
    }

    const body = await request.json();
    const { platform, credentials, profile, disconnect, action } = body;

    if (!platform || (!credentials && !disconnect)) {
      return apiError('Missing required platform or credentials', 400);
    }

    if (!getIntegrationDefinition(platform)) {
      return apiError(`Integration platform ${platform} not supported yet.`, 400);
    }

    // Out-of-band action (e.g. `pairing-approve`) — runs a runtime CLI command
    // instead of writing env. Validation differs per action; skip the standard
    // credential validation, which is shaped for env writes.
    const isPairingApprove = action === 'pairing-approve';

    if (!disconnect && !isPairingApprove) {
      const validation = validateIntegrationCredentials(platform, credentials);
      if (!validation.valid) {
        const labels = getMissingFieldLabels(platform, validation.missingFields);
        return apiError(`Missing required ${platform} field${labels.length === 1 ? '' : 's'}: ${labels.join(', ')}`, 400, undefined, {
          missingFields: validation.missingFields,
        });
      }
    }

    const normalizedProfile = normalizeProfileName(
      resolveIntegrationRuntimeProfile(platform, profile)
    );

    const { instance, apiServerKey } = await getSecureUserInstance({ id: instanceId, userId: access.userId, requireRunning: true });

    // Telegram pairing-approve: run `hermes pairing approve telegram <code>`
    // inside the runtime container so the gateway's PairingStore (loaded once
    // per process) sees the approved id on its next `is_approved()` check — no
    // gateway restart needed, no env write. The bot stays in `pair` mode (no
    // TELEGRAM_ALLOWED_USERS), so unknown senders still get a code, but only
    // approved ids reach the agent.
    if (isPairingApprove) {
      if (platform.toLowerCase() !== 'telegram') {
        return apiError(`pairing-approve is not supported for ${platform}.`, 400);
      }
      if (normalizedProfile !== 'default') {
        return apiError('pairing-approve is only available on the default profile.', 400);
      }
      const rawCode = String((credentials as Record<string, unknown> | null | undefined)?.code ?? '').trim().toUpperCase();
      // Sanitize defensively to the pairing-code alphabet shape (the gateway
      // uses the unambiguous 32-char set ABCDEFGHJKLMNPQRSTUVWXYZ23456789, but
      // we accept [A-Z0-9]{8} here so future alphabet changes don't reject
      // legitimate codes — the runtime makes the authoritative call).
      if (!/^[A-Z0-9]{8}$/.test(rawCode)) {
        return apiError('That doesn\'t look like an 8-character pairing code.', 400, undefined, {
          failureType: 'pairing_code_shape_invalid',
        });
      }
      return await handleTelegramPairingApprove({
        hostIp,
        instanceId,
        instance,
        code: rawCode,
        userId: access.userId,
        proxmoxHostConfig,
      });
    }
    // RAW backend check (intentionally NOT isWebfreeBackend): this gates only the
    // sidecar fast-path below. A "webui" box skips the sidecar and writes via SSH
    // (buildWebUIIntegrationSshScript); a "gateway"/legacy box tries the dashboard
    // sidecar first — which on a webfree gateway box is present and correct. The
    // SSH FALLBACK script selection, by contrast, uses isWebfreeBackend so a
    // gateway box's fallback also uses the webfree writer (see below).
    const isWebUIBackend = instance?.backend === 'webui';

    const isSubProfile = normalizedProfile !== 'default';
    
    const envUpdates: string[] = [];
    const prefixToRemove = '';
    const keysToRemove: string[] = [];

    switch (platform.toLowerCase()) {
      case 'telegram':
        // Always clear both so a disconnect (and a reconnect) leaves no stale
        // allowlist behind.
        keysToRemove.push('TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USERS');
        if (!disconnect) {
          // Validate the token against Telegram BEFORE writing it. A dead,
          // revoked, or mistyped token used to be accepted silently and just
          // sit on the box doing nothing — the user thought their bot was
          // connected when it never was (the 2026-06-20 case: a getMe-401 token
          // saved fine and the bot never came online). getMe makes that loud:
          // reject here so a non-working token can never land.
          const tokenCheck = await telegramGetMe(String(credentials?.token ?? ''));
          if (!tokenCheck.ok) {
            return apiError(
              tokenCheck.error ?? 'Telegram rejected that bot token. Double-check it and try again.',
              400,
              { failureType: 'telegram_token_invalid', retryable: false }
            );
          }
          appendEnvUpdate(envUpdates, 'TELEGRAM_BOT_TOKEN', credentials?.token);
          // Two connect shapes:
          //   - Token-only (the default modern flow): no TELEGRAM_ALLOWED_USERS.
          //     With no allowlist, the gateway enters native `pair` mode — an
          //     unknown DM gets an 8-char one-time code, and the dashboard
          //     follows up with a separate `action: 'pairing-approve'` request
          //     to add the sender to the approved list (gateway/pairing.py).
          //   - Manual fallback (`credentials.ownerId` present): writes the
          //     allowlist directly, skipping pairing. Sanitized to id/CSV shape
          //     (defense-in-depth on top of appendEnvUpdate's escaping).
          const ownerAllow = String(credentials?.ownerId ?? '').replace(/[^0-9,]/g, '');
          if (ownerAllow) appendEnvUpdate(envUpdates, 'TELEGRAM_ALLOWED_USERS', ownerAllow);
        }
        break;
      case 'discord':
        keysToRemove.push('DISCORD_BOT_TOKEN', 'DISCORD_ALLOWED_GUILDS');
        if (!disconnect) {
          appendEnvUpdate(envUpdates, 'DISCORD_BOT_TOKEN', credentials?.token);
          appendEnvUpdate(envUpdates, 'DISCORD_ALLOWED_GUILDS', '*');
        }
        break;
      case 'slack':
        keysToRemove.push('SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN');
        if (!disconnect) {
          appendEnvUpdate(envUpdates, 'SLACK_BOT_TOKEN', credentials?.token);
          appendEnvUpdate(envUpdates, 'SLACK_APP_TOKEN', credentials?.appToken);
        }
        break;
      case 'email':
        keysToRemove.push('EMAIL_ADDRESS', 'EMAIL_PASSWORD', 'EMAIL_IMAP_HOST', 'EMAIL_SMTP_HOST');
        if (!disconnect) {
          appendEnvUpdate(envUpdates, 'EMAIL_ADDRESS', credentials?.address);
          appendEnvUpdate(envUpdates, 'EMAIL_PASSWORD', credentials?.password);
          appendEnvUpdate(envUpdates, 'EMAIL_IMAP_HOST', credentials?.imapHost);
          appendEnvUpdate(envUpdates, 'EMAIL_SMTP_HOST', credentials?.smtpHost);
        }
        break;
      case 'sms (twilio)':
        keysToRemove.push('TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN');
        if (!disconnect) {
          appendEnvUpdate(envUpdates, 'TWILIO_ACCOUNT_SID', credentials?.accountSid);
          appendEnvUpdate(envUpdates, 'TWILIO_AUTH_TOKEN', credentials?.authToken);
        }
        break;
      case 'signal':
        keysToRemove.push('SIGNAL_ACCOUNT', 'SIGNAL_HTTP_URL');
        if (!disconnect) {
          appendEnvUpdate(envUpdates, 'SIGNAL_ACCOUNT', credentials?.account);
          appendEnvUpdate(envUpdates, 'SIGNAL_HTTP_URL', credentials?.httpUrl);
        }
        break;
      case 'dingtalk':
        keysToRemove.push('DINGTALK_CLIENT_ID', 'DINGTALK_CLIENT_SECRET');
        if (!disconnect) {
          appendEnvUpdate(envUpdates, 'DINGTALK_CLIENT_ID', credentials?.clientId);
          appendEnvUpdate(envUpdates, 'DINGTALK_CLIENT_SECRET', credentials?.clientSecret);
        }
        break;
      case 'whatsapp':
        keysToRemove.push('WHATSAPP_ENABLED', 'WHATSAPP_ALLOWED_USERS');
        if (!disconnect) {
          appendEnvUpdate(envUpdates, 'WHATSAPP_ENABLED', 'true');
          appendEnvUpdate(envUpdates, 'WHATSAPP_ALLOWED_USERS', credentials?.allowedUsers);
        }
        break;
      case 'bluebubbles':
        keysToRemove.push('BLUEBUBBLES_SERVER_URL', 'BLUEBUBBLES_PASSWORD');
        if (!disconnect) {
          appendEnvUpdate(envUpdates, 'BLUEBUBBLES_SERVER_URL', credentials?.serverUrl);
          appendEnvUpdate(envUpdates, 'BLUEBUBBLES_PASSWORD', credentials?.password);
        }
        break;
      case 'matrix':
        keysToRemove.push('MATRIX_HOMESERVER', 'MATRIX_USER_ID', 'MATRIX_ACCESS_TOKEN');
        if (!disconnect) {
          appendEnvUpdate(envUpdates, 'MATRIX_HOMESERVER', credentials?.homeserver);
          appendEnvUpdate(envUpdates, 'MATRIX_USER_ID', credentials?.userId);
          appendEnvUpdate(envUpdates, 'MATRIX_ACCESS_TOKEN', credentials?.accessToken);
        }
        break;
      case 'mattermost':
        keysToRemove.push('MATTERMOST_URL', 'MATTERMOST_TOKEN');
        if (!disconnect) {
          appendEnvUpdate(envUpdates, 'MATTERMOST_URL', credentials?.url);
          appendEnvUpdate(envUpdates, 'MATTERMOST_TOKEN', credentials?.token);
        }
        break;
      case 'wecom':
        keysToRemove.push('WECOM_BOT_ID', 'WECOM_SECRET');
        if (!disconnect) {
          appendEnvUpdate(envUpdates, 'WECOM_BOT_ID', credentials?.botId);
          appendEnvUpdate(envUpdates, 'WECOM_SECRET', credentials?.secret);
        }
        break;
      case 'wechat':
        keysToRemove.push('WEIXIN_ACCOUNT_ID', 'WEIXIN_TOKEN');
        if (!disconnect) {
          appendEnvUpdate(envUpdates, 'WEIXIN_ACCOUNT_ID', credentials?.accountId);
          appendEnvUpdate(envUpdates, 'WEIXIN_TOKEN', credentials?.token);
        }
        break;
      case 'feishu':
        keysToRemove.push('FEISHU_APP_ID', 'FEISHU_APP_SECRET');
        if (!disconnect) {
          appendEnvUpdate(envUpdates, 'FEISHU_APP_ID', credentials?.appId);
          appendEnvUpdate(envUpdates, 'FEISHU_APP_SECRET', credentials?.appSecret);
        }
        break;
      case 'home assistant':
        keysToRemove.push('HASS_URL', 'HASS_TOKEN');
        if (!disconnect) {
          appendEnvUpdate(envUpdates, 'HASS_URL', credentials?.url);
          appendEnvUpdate(envUpdates, 'HASS_TOKEN', credentials?.token);
        }
        break;
      case 'github':
        keysToRemove.push('GITHUB_TOKEN');
        if (!disconnect) appendEnvUpdate(envUpdates, 'GITHUB_TOKEN', credentials?.token);
        break;
      case 'notion':
        keysToRemove.push('NOTION_API_KEY');
        if (!disconnect) appendEnvUpdate(envUpdates, 'NOTION_API_KEY', credentials?.token);
        break;
      case 'linear':
        keysToRemove.push('LINEAR_API_KEY');
        if (!disconnect) appendEnvUpdate(envUpdates, 'LINEAR_API_KEY', credentials?.token);
        break;
      case 'x (twitter)':
        keysToRemove.push('X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET');
        if (!disconnect) {
          appendEnvUpdate(envUpdates, 'X_API_KEY', credentials?.apiKey);
          appendEnvUpdate(envUpdates, 'X_API_SECRET', credentials?.apiSecret);
          appendEnvUpdate(envUpdates, 'X_ACCESS_TOKEN', credentials?.accessToken);
          appendEnvUpdate(envUpdates, 'X_ACCESS_TOKEN_SECRET', credentials?.accessSecret);
        }
        break;
      case 'custom variables': {
        if (!credentials?.customKey) {
          return apiError('Missing Variable Name (customKey)', 400);
        }

        const rawCustomKey = String(credentials.customKey);
        const customValidation = validateCustomVariable(rawCustomKey);
        if (!customValidation.valid) {
          return apiError(customValidation.error || 'Invalid Variable Name.', 400);
        }

        const safeCustomKey = rawCustomKey.replace(/[^a-zA-Z0-9_]/g, '');
        keysToRemove.push(safeCustomKey);

        if (!disconnect) {
          appendEnvUpdate(envUpdates, safeCustomKey, credentials?.customValue || '');
        }
        break;
      }
      default:
        return apiError(`Integration platform ${platform} not supported yet.`, 400);
    }

    // Try Sidecar API First (Phase 3 Architect Update)
    if (!isWebUIBackend && instance && instance.gateway_url && apiServerKey) {
      try {
         const baseUrl = instance.gateway_url.replace(/\/$/, "");
         const sidecarPath = '/_sidecar/api/integrations';

         const payloadString = JSON.stringify({
             profile: normalizedProfile,
             platform,
             envUpdates,
             keysToRemove,
             prefixToRemove
         });
         
         const timestamp = Date.now().toString();
         const signature = crypto.createHmac('sha256', apiServerKey).update(`${timestamp}.${payloadString}`).digest('hex');

         const { response: sidecarRes } = await fetchFirstReachableGatewayResponse({
           baseUrl,
           pathname: sidecarPath,
           method: 'POST',
           headers: {
             Authorization: `Bearer ${apiServerKey}`,
             'X-Hermes-Timestamp': timestamp,
             'X-Hermes-Signature': signature,
             'Content-Type': 'application/json'
           },
           body: payloadString,
           timeoutMs: INTEGRATIONS_SIDECAR_TIMEOUT_MS,
         });

         if (sidecarRes.ok) {
           log.info('integrations sidecar handled config', {
             source: 'integrations',
             route: '/api/instances/[id]/integrations',
             method: 'POST',
             instanceId,
             userId: access.userId,
             profileName: normalizedProfile,
             platform,
             isSubProfile,
             envKeysWritten: envUpdates.map((line) => line.slice(0, line.indexOf('='))),
             expectedEnvPath: isSubProfile
               ? `agent-profiles volume:/profiles/${normalizedProfile}/.env`
               : `/opt/hermes/instances/${instanceId}/.env`,
           });
           return apiSuccess(buildIntegrationSuccessPayload({
             platform,
             profile: normalizedProfile,
             disconnect: Boolean(disconnect),
             appliedVia: 'sidecar',
           }));
         } else if (sidecarRes.status !== 404 && sidecarRes.status !== 502) {
           // Not a 404 (missing sidecar), it's a legitimate processing error we shouldn't fallback mask
           await sidecarRes.text();
           log.error('integrations sidecar rejected payload', new Error(`sidecar returned ${sidecarRes.status}`), {
             source: 'integrations',
             route: '/api/instances/[id]/integrations',
             method: 'POST',
             instanceId,
             userId: access.userId,
             profileName: normalizedProfile,
             platform,
             failureType: 'integrations_sidecar_rejected',
             sidecarStatus: sidecarRes.status,
           });
           return apiError('Sidecar rejected integration payload', sidecarRes.status, {
             failureType: 'integrations_sidecar_rejected',
             sidecarStatus: sidecarRes.status,
           });
         } else {
           log.info('integrations sidecar unavailable, falling back to SSH', {
             source: 'integrations',
             route: '/api/instances/[id]/integrations',
             method: 'POST',
             instanceId,
             userId: access.userId,
             profileName: normalizedProfile,
             platform,
             sidecarStatus: sidecarRes.status,
           });
         }
      } catch (err) {
         log.info('integrations sidecar connection failed, falling back to SSH', {
           source: 'integrations',
           route: '/api/instances/[id]/integrations',
           method: 'POST',
           instanceId,
           userId: access.userId,
           profileName: normalizedProfile,
           platform,
           failureType: 'integrations_sidecar_unreachable',
           errorName: err instanceof Error ? err.name : typeof err,
           ...getGatewayRequestDiagnostics(err),
         });
      }
    }

    // FALLBACK: Build a bash script to safely update the .env file and restart the container via SSH
    // We base64 encode the env updates to prevent ANY shell injection on the remote.
    const b64Updates = envUpdates.map((line) => Buffer.from(line).toString('base64'));
    
    // We conditionally apply the script to either the main instance or the specific sub-profile using docker exec.
    // SSH-fallback script selection keys on isWebfreeBackend (NOT the raw isWebUIBackend used for the sidecar
    // gate above): post gateway≡webfree collapse a "gateway" box runs the webfree stack (no `agent-${id}`
    // container; HERMES_HOME under /home/hermes as uid 1024), so its fallback MUST use the webfree writer
    // (docker compose exec + `docker compose restart gateway`), not the legacy `docker restart agent-${id}`
    // branch which would no-op against a non-existent container and write to the wrong path.
    const script = isWebfreeBackend(instance?.backend)
      ? buildWebUIIntegrationSshScript({
          instanceId,
          profileName: normalizedProfile,
          envUpdates,
          keysToRemove,
          prefixToRemove,
        })
      : isSubProfile ? `
docker exec agent-${instanceId} sh -c '
  BASE_HOME="\${HERMES_HOME:-/root/.hermes}"
  PROFILE_HOME="$BASE_HOME/profiles/${normalizedProfile}"
  ENV_FILE="$PROFILE_HOME/.env"
  touch $ENV_FILE
  
  if [ -n "${prefixToRemove}" ]; then
    grep -v "^${prefixToRemove}" $ENV_FILE > $ENV_FILE.tmp
  else
    cp $ENV_FILE $ENV_FILE.tmp
  fi
  ${keysToRemove && keysToRemove.length > 0 ? keysToRemove.map((key) => `grep -v "^${key}=" $ENV_FILE.tmp > $ENV_FILE.tmp2 && mv $ENV_FILE.tmp2 $ENV_FILE.tmp`).join('; ') + ';' : ''}
  
  # Append new keys safely
  ${b64Updates.map((b64) => `echo "${b64}" | base64 -d >> $ENV_FILE.tmp; echo "" >> $ENV_FILE.tmp`).join('; ')}
  
  cat $ENV_FILE.tmp > $ENV_FILE
  rm -f $ENV_FILE.tmp
  
  # Restart this profile's gateway under a self-restarting supervisor so a crash
  # or transient provider error doesn't leave it dead until the next CONNECT.
  # (The container restart policy only covers the PID-1 default-profile gateway.)
  SUP_PIDFILE="$PROFILE_HOME/gateway-supervisor.pid"
  if [ -f "$SUP_PIDFILE" ]; then
    SUP_PID=$(tr -dc 0-9 < "$SUP_PIDFILE" 2>/dev/null)
    if [ -n "$SUP_PID" ]; then kill -SIGTERM "$SUP_PID" 2>/dev/null || true; fi
  fi
  if [ -f "$PROFILE_HOME/gateway.pid" ]; then
    PID=$(python3 -c "import json, sys; d=sys.stdin.read().strip(); print(json.loads(d).get(\\"pid\\", \\"\\")) if d.startswith(\\"{\\") else print(d)" < "$PROFILE_HOME/gateway.pid" 2>/dev/null)
    if [ -n "$PID" ]; then kill -SIGTERM "$PID" 2>/dev/null || true; fi
  fi
  sleep 1
  echo "${GATEWAY_SUBPROFILE_SUPERVISOR_SH_B64}" | base64 -d > "$PROFILE_HOME/gateway-supervisor.sh"
  env HERMES_HOME="$PROFILE_HOME" nohup sh "$PROFILE_HOME/gateway-supervisor.sh" </dev/null >> "$PROFILE_HOME/gateway.log" 2>&1 &
  echo $! > "$SUP_PIDFILE"
  STATUS_FILE="$PROFILE_HOME/gateway-status.log"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    HERMES_HOME="$PROFILE_HOME" /opt/hermes/.venv/bin/hermes gateway status > "$STATUS_FILE" 2>&1 || true
    if grep -q "Gateway is running" "$STATUS_FILE"; then
      cat "$STATUS_FILE"
      exit 0
    fi
  done
  echo "Profile integration gateway failed to report running." >&2
  cat "$STATUS_FILE" >&2 || true
  tail -n 80 "$PROFILE_HOME/gateway.log" >&2 || true
  exit 1
'
` : `
ENV_FILE="/opt/hermes/instances/${instanceId}/.env"
touch $ENV_FILE

if [ -n "${prefixToRemove}" ]; then
  grep -v "^${prefixToRemove}" $ENV_FILE > $ENV_FILE.tmp
else
  cp $ENV_FILE $ENV_FILE.tmp
fi
${keysToRemove && keysToRemove.length > 0 ? keysToRemove.map((key) => `grep -v "^${key}=" $ENV_FILE.tmp > $ENV_FILE.tmp2 && mv $ENV_FILE.tmp2 $ENV_FILE.tmp`).join('\n') + '\n' : ''}

# Append new keys safely via base64 decoding
${b64Updates.map((b64) => `echo "${b64}" | base64 -d >> $ENV_FILE.tmp; echo "" >> $ENV_FILE.tmp`).join('\n')}

# Update the mounted env file in place so sidecars keep the same bind-mounted inode.
cat $ENV_FILE.tmp > $ENV_FILE
rm -f $ENV_FILE.tmp

# Silently restart the complete container in the background
nohup sh -c "sleep 2 && docker restart agent-${instanceId}" >/dev/null 2>&1 &
`;

    // Retry transient SSH failures: a single attempt is exactly what let a
    // token save silently land nowhere when the box was momentarily
    // unreachable during the 2026-06-20 outage.
    let result = await sshExec(hostIp, script, { timeoutMs: INTEGRATIONS_SSH_TIMEOUT_MS, proxmoxHostConfig });
    let attempts = 1;
    while (
      !result.ok &&
      attempts < INTEGRATIONS_APPLY_MAX_ATTEMPTS &&
      isTransientSshFailure(result.stderr || result.error)
    ) {
      attempts += 1;
      await new Promise((resolve) => setTimeout(resolve, INTEGRATIONS_APPLY_RETRY_DELAY_MS));
      result = await sshExec(hostIp, script, { timeoutMs: INTEGRATIONS_SSH_TIMEOUT_MS, proxmoxHostConfig });
    }

    if (!result.ok) {
      const sshError = result.stderr || result.error || 'Failed to update settings on remote node';
      log.error('integrations SSH exec failed', new Error(sshError), {
        source: 'integrations',
        route: '/api/instances/[id]/integrations',
        method: 'POST',
        instanceId,
        userId: access.userId,
        profileName: normalizedProfile,
        platform,
        attempts,
        failureType: 'integrations_ssh_failed',
      });

      if (isTimeoutErrorMessage(sshError)) {
        return apiError('Timed out while updating settings on the remote node.', 504, {
          failureType: 'integrations_update_failed',
          retryable: true,
        });
      }

      // Box unreachable → actionable, retryable message instead of the opaque
      // "Failed to update settings on remote node" with retryable:false.
      if (isSshWarmupError(sshError)) {
        return apiError(INTEGRATIONS_UNREACHABLE_ERROR, 503, {
          failureType: 'integrations_update_unreachable',
          retryable: true,
        });
      }

      return apiError(INTEGRATIONS_UPDATE_ERROR, 500, {
        failureType: 'integrations_update_failed',
        retryable: false,
      });
    }

    log.info('integrations SSH fallback handled config', {
      source: 'integrations',
      route: '/api/instances/[id]/integrations',
      method: 'POST',
      instanceId,
      userId: access.userId,
      profileName: normalizedProfile,
      platform,
      isSubProfile,
      envKeysWritten: envUpdates.map((line) => line.slice(0, line.indexOf('='))),
      expectedEnvPath: isSubProfile
        ? `agent-profiles volume:/root/.hermes/profiles/${normalizedProfile}/.env`
        : `/opt/hermes/instances/${instanceId}/.env`,
    });

    return apiSuccess(buildIntegrationSuccessPayload({
      platform,
      profile: normalizedProfile,
      disconnect: Boolean(disconnect),
      appliedVia: 'ssh',
    }));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'Invalid profile name format') {
      return apiError(msg, 400);
    }
    return apiError(INTEGRATIONS_UPDATE_ERROR, 500, {
      failureType: 'integrations_update_failed',
      retryable: false,
    });
  }
}
