import { NextRequest } from 'next/server';
import { GET, POST, maxDuration } from '../route';
import { validateConsoleAccess } from '@/lib/services/console-helpers';
import { getSecureUserInstance } from '@/lib/services/instance-security';
import { sshExec } from '@/lib/hetzner/ssh';
import {
  AgentGatewayRequestError,
  fetchFirstReachableGatewayResponse,
} from '@/lib/agent-gateway';
import { log } from '@/lib/logger';
import { GATEWAY_SUBPROFILE_SUPERVISOR_SH } from '@/lib/services/gateway-supervisor';
import { telegramGetMe } from '@/lib/channels/telegram-api';
import { makeJsonRequest, makeRequest } from "@/test-utils/request";

jest.mock('@/lib/logger', () => ({
  log: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('@/lib/services/console-helpers', () => ({
  validateConsoleAccess: jest.fn(),
}));

jest.mock('@/lib/services/instance-security', () => ({
  getSecureUserInstance: jest.fn(),
}));

jest.mock('@/lib/hetzner/ssh', () => ({
  sshExec: jest.fn(),
}));

jest.mock('@/lib/channels/telegram-api', () => ({
  ...jest.requireActual('@/lib/channels/telegram-api'),
  telegramGetMe: jest.fn(),
}));

jest.mock('@/lib/agent-gateway', () => {
  const actual = jest.requireActual('@/lib/agent-gateway');
  return {
    ...actual,
    fetchFirstReachableGatewayResponse: jest.fn(),
  };
});

function stringifyMockCalls(spy: jest.SpyInstance): string {
  return spy.mock.calls
    .flat()
    .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
    .join(' ');
}

describe('/api/instances/[id]/integrations', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    (validateConsoleAccess as jest.Mock).mockResolvedValue({
      id: 'inst-123',
      userId: 'user-123',
      hostIp: '127.0.0.1',
      errorResponse: null,
    });

    (getSecureUserInstance as jest.Mock).mockResolvedValue({
      instance: { gateway_url: 'https://agent.example.com' },
      apiServerKey: 'secret',
      error: null,
    });

    // Default: Telegram token validation passes so existing token-save tests
    // are unaffected. Tests that exercise rejection override this.
    (telegramGetMe as jest.Mock).mockResolvedValue({
      ok: true,
      username: 'testbot',
      botId: 123,
      error: null,
    });
  });

  describe('POST', () => {
    it('rejects unsafe profile names before touching sidecar or SSH paths', async () => {
      const req = new NextRequest('http://localhost/api/instances/inst-123/integrations', {
        method: 'POST',
        body: JSON.stringify({
          platform: 'Slack',
          profile: '../prod;rm -rf /',
          credentials: { token: 'xoxb-123', appToken: 'xapp-123' },
        }),
      });

      const res = await POST(req, { params: Promise.resolve({ id: 'inst-123' }) });
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.error).toMatch(/invalid profile name format/i);
      expect(fetchFirstReachableGatewayResponse).not.toHaveBeenCalled();
      expect(sshExec).not.toHaveBeenCalled();
    });

    it('rejects Slack configuration when the app token is missing', async () => {
      const req = new NextRequest('http://localhost/api/instances/inst-123/integrations', {
        method: 'POST',
        body: JSON.stringify({
          platform: 'Slack',
          credentials: { token: 'xoxb-123' },
        }),
      });

      const res = await POST(req, { params: Promise.resolve({ id: 'inst-123' }) });
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.error).toMatch(/app token/i);
    });

    it('uses the upstream Home Assistant env keys when sending updates through the sidecar', async () => {
      (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValue({
        response: {
          ok: true,
          status: 200,
        },
      });

      const req = new NextRequest('http://localhost/api/instances/inst-123/integrations', {
        method: 'POST',
        body: JSON.stringify({
          platform: 'Home Assistant',
          credentials: {
            url: 'https://ha.example.com',
            token: 'token-123',
          },
        }),
      });

      const res = await POST(req, { params: Promise.resolve({ id: 'inst-123' }) });
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
      expect(fetchFirstReachableGatewayResponse).toHaveBeenCalledTimes(1);

      const sidecarCall = (fetchFirstReachableGatewayResponse as jest.Mock).mock.calls[0][0];
      const payload = JSON.parse(sidecarCall.body);

      expect(payload.envUpdates).toContain("HASS_URL='https://ha.example.com'");
      expect(payload.envUpdates).toContain("HASS_TOKEN='token-123'");
      expect(payload.envUpdates).not.toContain("HOME_ASSISTANT_URL='https://ha.example.com'");
      expect(payload.envUpdates).not.toContain("HOME_ASSISTANT_TOKEN='token-123'");
      expect(payload.keysToRemove).toEqual(expect.arrayContaining(['HASS_URL', 'HASS_TOKEN']));
      expect(sshExec).not.toHaveBeenCalled();
    });

    it('writes Telegram settings to the selected profile scope when a sub-profile is active', async () => {
      (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValue({
        response: {
          ok: true,
          status: 200,
        },
      });

      const req = new NextRequest('http://localhost/api/instances/inst-123/integrations', {
        method: 'POST',
        body: JSON.stringify({
          platform: 'Telegram',
          profile: 'marcus',
          credentials: {
            token: 'bot-token-123',
          },
        }),
      });

      const res = await POST(req, { params: Promise.resolve({ id: 'inst-123' }) });
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data).toMatchObject({
        status: 'configured',
        platform: 'Telegram',
        profile: 'marcus',
        restartRequired: true,
      });
      expect(data.data.message).toMatch(/telegram configured/i);
      expect(data.data.message).toMatch(/marcus profile/i);

      const sidecarCall = (fetchFirstReachableGatewayResponse as jest.Mock).mock.calls[0][0];
      const payload = JSON.parse(sidecarCall.body);

      expect(payload.profile).toBe('marcus');
      expect(payload.envUpdates).toContain("TELEGRAM_BOT_TOKEN='bot-token-123'");
      expect(payload.keysToRemove).toEqual(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USERS']);
      expect(sshExec).not.toHaveBeenCalled();
    });

    it('locks the Telegram bot to the owner by writing TELEGRAM_ALLOWED_USERS when an owner id is supplied', async () => {
      (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValue({
        response: { ok: true, status: 200 },
      });

      const req = new NextRequest('http://localhost/api/instances/inst-123/integrations', {
        method: 'POST',
        body: JSON.stringify({
          platform: 'Telegram',
          credentials: { token: 'bot-token-123', ownerId: '987654321' },
        }),
      });

      const res = await POST(req, { params: Promise.resolve({ id: 'inst-123' }) });
      expect(res.status).toBe(200);

      const sidecarCall = (fetchFirstReachableGatewayResponse as jest.Mock).mock.calls[0][0];
      const payload = JSON.parse(sidecarCall.body);
      expect(payload.envUpdates).toContain("TELEGRAM_BOT_TOKEN='bot-token-123'");
      expect(payload.envUpdates).toContain("TELEGRAM_ALLOWED_USERS='987654321'");
      expect(payload.keysToRemove).toEqual(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USERS']);
    });

    it('rejects an invalid/dead Telegram bot token before writing it (no silent failure)', async () => {
      // Telegram says the token is bad → reject loudly instead of saving a
      // non-working token that leaves the user thinking the bot is connected.
      (telegramGetMe as jest.Mock).mockResolvedValue({
        ok: false,
        username: null,
        botId: null,
        error: 'Telegram rejected that token. Double-check you copied it correctly.',
      });

      const req = new NextRequest('http://localhost/api/instances/inst-123/integrations', {
        method: 'POST',
        body: JSON.stringify({
          platform: 'Telegram',
          credentials: { token: '123456:dead-token' },
        }),
      });

      const res = await POST(req, { params: Promise.resolve({ id: 'inst-123' }) });
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.error).toMatch(/telegram rejected/i);
      // Nothing was written or applied — neither the sidecar nor SSH path ran.
      expect(fetchFirstReachableGatewayResponse).not.toHaveBeenCalled();
      expect(sshExec).not.toHaveBeenCalled();
    });

    it('token-only Telegram connect writes only the token — leaves the gateway in pair mode', async () => {
      // Modern pairing flow: no ownerId → gateway gets TELEGRAM_BOT_TOKEN but
      // no allowlist, so `_get_unauthorized_dm_behavior` returns "pair" and
      // unknown senders get an 8-char code instead of silent drop.
      (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValue({
        response: { ok: true, status: 200 },
      });

      const req = new NextRequest('http://localhost/api/instances/inst-123/integrations', {
        method: 'POST',
        body: JSON.stringify({
          platform: 'Telegram',
          credentials: { token: 'bot-token-123' },
        }),
      });

      const res = await POST(req, { params: Promise.resolve({ id: 'inst-123' }) });
      expect(res.status).toBe(200);

      const sidecarCall = (fetchFirstReachableGatewayResponse as jest.Mock).mock.calls[0][0];
      const payload = JSON.parse(sidecarCall.body);
      expect(payload.envUpdates).toContain("TELEGRAM_BOT_TOKEN='bot-token-123'");
      // Critically: ALLOWED_USERS is NOT written — but it IS cleared on the
      // way in so a prior allowlist can't linger past a fresh connect.
      const updates: string[] = payload.envUpdates;
      expect(updates.some((line) => line.startsWith('TELEGRAM_ALLOWED_USERS'))).toBe(false);
      expect(payload.keysToRemove).toEqual(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USERS']);
    });

    describe('pairing-approve action', () => {
      it('rejects a malformed code shape before touching the box', async () => {
        const req = new NextRequest('http://localhost/api/instances/inst-123/integrations', {
          method: 'POST',
          body: JSON.stringify({
            platform: 'Telegram',
            action: 'pairing-approve',
            credentials: { code: 'too-short' },
          }),
        });
        const res = await POST(req, { params: Promise.resolve({ id: 'inst-123' }) });
        const data = await res.json();
        expect(res.status).toBe(400);
        expect(data.error).toMatch(/8-character pairing code/i);
        expect(sshExec).not.toHaveBeenCalled();
      });

      it('only runs on the default profile', async () => {
        const req = new NextRequest('http://localhost/api/instances/inst-123/integrations', {
          method: 'POST',
          body: JSON.stringify({
            platform: 'Telegram',
            profile: 'marcus',
            action: 'pairing-approve',
            credentials: { code: 'ABCD2345' },
          }),
        });
        const res = await POST(req, { params: Promise.resolve({ id: 'inst-123' }) });
        const data = await res.json();
        expect(res.status).toBe(400);
        expect(data.error).toMatch(/default profile/i);
        expect(sshExec).not.toHaveBeenCalled();
      });

      it('approves a valid code by execing `hermes pairing approve` in the runtime container', async () => {
        (getSecureUserInstance as jest.Mock).mockResolvedValue({
          instance: { gateway_url: 'https://agent.example.com', backend: 'gateway' },
          apiServerKey: 'secret',
          error: null,
        });
        (sshExec as jest.Mock).mockResolvedValue({
          ok: true,
          stdout: '\n  Approved! User Ash (987654) on telegram can now use the bot~\n',
          stderr: '',
          error: null,
        });

        const req = new NextRequest('http://localhost/api/instances/inst-123/integrations', {
          method: 'POST',
          body: JSON.stringify({
            platform: 'Telegram',
            action: 'pairing-approve',
            credentials: { code: 'abcd2345' }, // lowercase — uppercased server-side
          }),
        });
        const res = await POST(req, { params: Promise.resolve({ id: 'inst-123' }) });
        const data = await res.json();
        expect(res.status).toBe(200);
        expect(data.success).toBe(true);
        expect(data.data).toMatchObject({ status: 'approved', action: 'pairing-approve' });

        // The script execs the hermes CLI, passes through the runtime compose
        // service expression, and uses the uppercased, quoted code.
        const script = (sshExec as jest.Mock).mock.calls[0][1];
        expect(script).toContain('hermes pairing approve telegram');
        expect(script).toContain("'ABCD2345'");
        expect(script).toContain('docker compose exec');
      });

      it('returns 400 when the CLI reports the code is expired / not found', async () => {
        (getSecureUserInstance as jest.Mock).mockResolvedValue({
          instance: { gateway_url: 'https://agent.example.com', backend: 'gateway' },
          apiServerKey: 'secret',
          error: null,
        });
        (sshExec as jest.Mock).mockResolvedValue({
          ok: true,
          stdout: "\n  Code 'ABCD2345' not found or expired for platform 'telegram'.\n",
          stderr: '',
          error: null,
        });

        const req = new NextRequest('http://localhost/api/instances/inst-123/integrations', {
          method: 'POST',
          body: JSON.stringify({
            platform: 'Telegram',
            action: 'pairing-approve',
            credentials: { code: 'ABCD2345' },
          }),
        });
        const res = await POST(req, { params: Promise.resolve({ id: 'inst-123' }) });
        const data = await res.json();
        expect(res.status).toBe(400);
        expect(data.error).toMatch(/expired/i);
      });

      it('returns 429 when the platform is in lockout', async () => {
        (getSecureUserInstance as jest.Mock).mockResolvedValue({
          instance: { gateway_url: 'https://agent.example.com', backend: 'gateway' },
          apiServerKey: 'secret',
          error: null,
        });
        (sshExec as jest.Mock).mockResolvedValue({
          ok: true,
          stdout: "\n  Platform 'telegram' is locked out after too many failed approval attempts.\n",
          stderr: '',
          error: null,
        });

        const req = new NextRequest('http://localhost/api/instances/inst-123/integrations', {
          method: 'POST',
          body: JSON.stringify({
            platform: 'Telegram',
            action: 'pairing-approve',
            credentials: { code: 'ABCD2345' },
          }),
        });
        const res = await POST(req, { params: Promise.resolve({ id: 'inst-123' }) });
        expect(res.status).toBe(429);
      });
    });

    it.each([
      {
        platform: 'BlueBubbles',
        credentials: {
          serverUrl: 'https://bluebubbles.example.com',
          password: 'server-password',
        },
        expectedUpdates: [
          "BLUEBUBBLES_SERVER_URL='https://bluebubbles.example.com'",
          "BLUEBUBBLES_PASSWORD='server-password'",
        ],
        keysToRemove: ['BLUEBUBBLES_SERVER_URL', 'BLUEBUBBLES_PASSWORD'],
      },
      {
        platform: 'Matrix',
        credentials: {
          homeserver: 'https://matrix.example.com',
          userId: '@hermes:example.com',
          accessToken: 'matrix-token',
        },
        expectedUpdates: [
          "MATRIX_HOMESERVER='https://matrix.example.com'",
          "MATRIX_USER_ID='@hermes:example.com'",
          "MATRIX_ACCESS_TOKEN='matrix-token'",
        ],
        keysToRemove: ['MATRIX_HOMESERVER', 'MATRIX_USER_ID', 'MATRIX_ACCESS_TOKEN'],
      },
      {
        platform: 'Mattermost',
        credentials: {
          url: 'https://mattermost.example.com',
          token: 'mattermost-token',
        },
        expectedUpdates: [
          "MATTERMOST_URL='https://mattermost.example.com'",
          "MATTERMOST_TOKEN='mattermost-token'",
        ],
        keysToRemove: ['MATTERMOST_URL', 'MATTERMOST_TOKEN'],
      },
      {
        platform: 'WeCom',
        credentials: {
          botId: 'wecom-bot-id',
          secret: 'wecom-secret',
        },
        expectedUpdates: [
          "WECOM_BOT_ID='wecom-bot-id'",
          "WECOM_SECRET='wecom-secret'",
        ],
        keysToRemove: ['WECOM_BOT_ID', 'WECOM_SECRET'],
      },
      {
        platform: 'WeChat',
        credentials: {
          accountId: 'wechat-account-id',
          token: 'wechat-secret',
        },
        expectedUpdates: [
          "WEIXIN_ACCOUNT_ID='wechat-account-id'",
          "WEIXIN_TOKEN='wechat-secret'",
        ],
        keysToRemove: ['WEIXIN_ACCOUNT_ID', 'WEIXIN_TOKEN'],
      },
      {
        platform: 'Feishu',
        credentials: {
          appId: 'cli_123',
          appSecret: 'feishu-secret',
        },
        expectedUpdates: [
          "FEISHU_APP_ID='cli_123'",
          "FEISHU_APP_SECRET='feishu-secret'",
        ],
        keysToRemove: ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'],
      },
    ])('supports %s settings through the sidecar payload', async ({ platform, credentials, expectedUpdates, keysToRemove }) => {
      (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValue({
        response: {
          ok: true,
          status: 200,
        },
      });

      const req = new NextRequest('http://localhost/api/instances/inst-123/integrations', {
        method: 'POST',
        body: JSON.stringify({
          platform,
          credentials,
        }),
      });

      const res = await POST(req, { params: Promise.resolve({ id: 'inst-123' }) });
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);

      const sidecarCall = (fetchFirstReachableGatewayResponse as jest.Mock).mock.calls[0][0];
      const payload = JSON.parse(sidecarCall.body);

      expect(payload.envUpdates).toEqual(expect.arrayContaining(expectedUpdates));
      expect(payload.keysToRemove).toEqual(expect.arrayContaining(keysToRemove));
      expect(sshExec).not.toHaveBeenCalled();
    });

    it('preserves apostrophes while stripping control characters from integration values', async () => {
      (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValue({
        response: {
          ok: true,
          status: 200,
        },
      });

      const req = new NextRequest('http://localhost/api/instances/inst-123/integrations', {
        method: 'POST',
        body: JSON.stringify({
          platform: 'Slack',
          credentials: {
            token: "xoxb-123'\nINJECT=1\r",
            appToken: "xapp-123\0SECOND=2",
          },
        }),
      });

      const res = await POST(req, { params: Promise.resolve({ id: 'inst-123' }) });
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);

      const sidecarCall = (fetchFirstReachableGatewayResponse as jest.Mock).mock.calls[0][0];
      const payload = JSON.parse(sidecarCall.body);

      expect(payload.envUpdates).toEqual(
        expect.arrayContaining([
          "SLACK_BOT_TOKEN='xoxb-123\\'INJECT=1'",
          "SLACK_APP_TOKEN='xapp-123SECOND=2'",
        ])
      );

      for (const line of payload.envUpdates) {
        expect(line).not.toMatch(/[\r\n\0]/);
      }
    });

    it('does not log or report raw sidecar rejection payloads', async () => {
      (log.error as jest.Mock).mockClear();

      (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValue({
        response: {
          ok: false,
          status: 400,
          text: jest.fn().mockResolvedValue('refresh_token=super-secret'),
        },
      });

      const req = new NextRequest('http://localhost/api/instances/inst-123/integrations', {
        method: 'POST',
        body: JSON.stringify({
          platform: 'Slack',
          credentials: {
            token: 'xoxb-123',
            appToken: 'xapp-123',
          },
        }),
      });

      const res = await POST(req, { params: Promise.resolve({ id: 'inst-123' }) });
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.error).toBe('Sidecar rejected integration payload');
      expect(log.error).toHaveBeenCalledWith(
        'integrations sidecar rejected payload',
        expect.anything(),
        expect.objectContaining({
          source: 'integrations',
          failureType: 'integrations_sidecar_rejected',
          sidecarStatus: 400,
        }),
      );
      const errorContextCalls = (log.error as jest.Mock).mock.calls.map((call) => call[2]);
      expect(JSON.stringify(errorContextCalls)).not.toContain('super-secret');
      expect(JSON.stringify(data)).not.toContain('super-secret');
    });

    it('does not log or report raw SSH fallback update failures', async () => {
      (log.error as jest.Mock).mockClear();

      (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValue({
        response: {
          ok: false,
          status: 404,
        },
      });

      (sshExec as jest.Mock).mockResolvedValue({
        ok: false,
        stdout: '',
        stderr: 'client_secret=super-secret',
        error: '',
      });

      const req = new NextRequest('http://localhost/api/instances/inst-123/integrations', {
        method: 'POST',
        body: JSON.stringify({
          platform: 'Slack',
          credentials: {
            token: 'xoxb-123',
            appToken: 'xapp-123',
          },
        }),
      });

      const res = await POST(req, { params: Promise.resolve({ id: 'inst-123' }) });
      const data = await res.json();

      expect(res.status).toBe(500);
      expect(data.error).toBe('Failed to update settings on remote node.');
      expect(log.error).toHaveBeenCalledWith(
        'integrations SSH exec failed',
        expect.anything(),
        expect.objectContaining({
          source: 'integrations',
          failureType: 'integrations_ssh_failed',
        }),
      );
      const errorContextCalls = (log.error as jest.Mock).mock.calls.map((call) => call[2]);
      expect(JSON.stringify(errorContextCalls)).not.toContain('super-secret');
    });

    it('returns a gateway-timeout response when the SSH fallback save stalls', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValue({
        response: {
          ok: false,
          status: 404,
        },
      });

      (sshExec as jest.Mock).mockResolvedValue({
        ok: false,
        stdout: '',
        stderr: '',
        error: 'SSH operation timed out after 45000ms',
      });

      const req = new NextRequest('http://localhost/api/instances/inst-123/integrations', {
        method: 'POST',
        body: JSON.stringify({
          platform: 'Telegram',
          credentials: { token: 'bot-token-123' },
        }),
      });

      const res = await POST(req, { params: Promise.resolve({ id: 'inst-123' }) });
      const data = await res.json();

      expect(res.status).toBe(504);
      expect(data.error).toBe('Timed out while updating settings on the remote node.');
      expect(stringifyMockCalls(consoleErrorSpy)).not.toContain('45000ms');
      expect(sshExec).toHaveBeenCalledWith(
        '127.0.0.1',
        expect.any(String),
        expect.objectContaining({ timeoutMs: 45000 })
      );

      consoleErrorSpy.mockRestore();
    });

    it('preserves the default env file mount when using the SSH fallback writer', async () => {
      (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValue({
        response: {
          ok: false,
          status: 404,
        },
      });

      (sshExec as jest.Mock).mockResolvedValue({
        ok: true,
        stdout: '',
        stderr: '',
      });

      const req = new NextRequest('http://localhost/api/instances/inst-123/integrations', {
        method: 'POST',
        body: JSON.stringify({
          platform: 'Telegram',
          credentials: { token: 'bot-token-123' },
        }),
      });

      const res = await POST(req, { params: Promise.resolve({ id: 'inst-123' }) });

      expect(res.status).toBe(200);

      const script = (sshExec as jest.Mock).mock.calls[0][1] as string;
      expect(script).toContain('cat $ENV_FILE.tmp > $ENV_FILE');
      expect(script).not.toContain('mv $ENV_FILE.tmp $ENV_FILE');
    });

    it('logs gateway attempts when Telegram sidecar update falls back to SSH', async () => {
      (log.info as jest.Mock).mockClear();
      (fetchFirstReachableGatewayResponse as jest.Mock).mockRejectedValueOnce(
        new AgentGatewayRequestError({
          requestId: 'req_integrations_123',
          baseUrl: 'https://agent.example.com',
          pathname: '/_sidecar/api/integrations?sig=super-secret',
          method: 'POST',
          timeoutScope: 'request',
          attempts: [
            {
              attempt: 1,
              probeIndex: 1,
              url: 'https://agent.example.com/_sidecar/api/integrations?sig=<redacted>',
              method: 'POST',
              timeoutMs: 6_000,
              timeoutScope: 'request',
              errorName: 'Error',
              errorMessage: 'dns lookup failed',
            },
          ],
        }),
      );

      (sshExec as jest.Mock).mockResolvedValue({
        ok: true,
        stdout: '',
        stderr: '',
      });

      const req = new NextRequest('http://localhost/api/instances/inst-123/integrations', {
        method: 'POST',
        body: JSON.stringify({
          platform: 'Telegram',
          credentials: { token: 'bot-token-123' },
        }),
      });

      const res = await POST(req, { params: Promise.resolve({ id: 'inst-123' }) });

      expect(res.status).toBe(200);
      expect(log.info).toHaveBeenCalledWith(
        'integrations sidecar connection failed, falling back to SSH',
        expect.objectContaining({
          source: 'integrations',
          failureType: 'integrations_sidecar_unreachable',
          gatewayAttemptCount: 1,
          gatewayRequestId: 'req_integrations_123',
          gatewayAttempts: [
            expect.objectContaining({
              url: 'https://agent.example.com/_sidecar/api/integrations?sig=<redacted>',
              errorMessage: 'dns lookup failed',
            }),
          ],
        }),
      );
      expect(sshExec).toHaveBeenCalled();
      expect(JSON.stringify((log.info as jest.Mock).mock.calls)).not.toContain('super-secret');
    });

    it('uses a sudo-tolerant WebUI SSH writer (authoritative webui-state write first) and restarts the gateway without a blocking readiness probe', async () => {
      (getSecureUserInstance as jest.Mock).mockResolvedValue({
        instance: { gateway_url: 'https://agent.example.com', backend: 'webui' },
        apiServerKey: 'secret',
        error: null,
      });

      (sshExec as jest.Mock).mockResolvedValue({
        ok: true,
        stdout: '',
        stderr: '',
      });

      const req = new NextRequest('http://localhost/api/instances/inst-123/integrations', {
        method: 'POST',
        body: JSON.stringify({
          platform: 'Telegram',
          credentials: { token: 'bot-token-123' },
        }),
      });

      const res = await POST(req, { params: Promise.resolve({ id: 'inst-123' }) });

      expect(res.status).toBe(200);
      expect(fetchFirstReachableGatewayResponse).not.toHaveBeenCalled();

      const script = (sshExec as jest.Mock).mock.calls[0][1] as string;
      expect(script).toContain('/opt/hermes/instances/inst-123/.env');
      expect(script).toContain('/home/hermes/.hermes/.env');
      // The authoritative write resolves the runtime compose service rather than
      // hard-coding `webui`: webfree has no `webui` service (it runs `gateway`),
      // so a literal `webui` exec aborted every CONNECT under `set -e`.
      expect(script).toContain('docker compose exec -T --user root "$(');
      expect(script).toContain('grep -qx gateway && echo gateway || echo webui');
      expect(script).not.toContain('--user root webui python');
      // pipefail regression guard: this CONNECT script opens with `set -euo
      // pipefail`, so a non-zero `docker compose config` exit (it can exit non-zero
      // on a deprecation/validation hiccup while STILL listing `gateway`) would
      // otherwise fail the `… | grep -qx gateway` pipeline and fall through to the
      // ABSENT `webui` service — `service "webui" is not running` on a gateway box.
      // The `{ …; || true; }` guard neutralizes the config exit code before the
      // pipe. Same mechanism as the restart_gateway incident (hermesdeploy#470).
      expect(script).toContain('set -euo pipefail');
      expect(script).toContain('|| true; } | grep -qx gateway');
      expect(script).not.toContain('config --services 2>/dev/null | grep -qx gateway');
      // Managed runtime: the gateway runs in its own supervised "gateway"
      // container. The CONNECT path writes the env, then restarts that
      // container so the supervisor re-reads .env — it must NOT try to run the
      // gateway inside the webui container (that was the v0.9.0 bug).
      //
      // Fire-and-forget restart (Fix D, 2026-07-03 telegram-connect-timeout RCA):
      // the restart is backgrounded (disowned via nohup, stdio redirected) so the
      // SSH channel closes immediately. A SYNCHRONOUS `docker compose restart
      // gateway` (SIGTERM grace + cold start) can approach/exceed the 45s SSH
      // timeout on a degraded box; sshExec then times out, isTransientSshFailure
      // classifies it transient, and the retry loop re-runs the whole 45s-blocking
      // script up to 3× (~138s). restartRequired:true is already returned and the
      // supervisor self-heals, so the SSH session need not wait for the restart.
      expect(script).toContain("nohup sh -c 'sleep 1 && docker compose restart gateway'");
      expect(script).toContain('gateway restart requested');
      // Regression guard: the restart must NOT block the SSH session (the old
      // synchronous `docker compose restart gateway 2>&1 | tail -8` form).
      expect(script).not.toContain('docker compose restart gateway 2>&1 | tail -8');
      expect(script).not.toContain('hermes gateway run --replace');
      expect(script).not.toContain('--force-recreate webui');
      expect(script).not.toContain('docker restart agent-inst-123');
      // Must NOT block on a synchronous "gateway status" readiness probe: it
      // never validated the credential and raced the SSH timeout on cold
      // restarts, returning false "failed to update" errors while the gateway
      // recovered moments later (fixture customer / fixture case).
      expect(script).not.toContain('docker compose exec -T --user 1024 gateway sh -lc');
      expect(script).not.toContain('uv run --extra messaging hermes gateway status');
      expect(script).not.toContain('Gateway is running');
      expect(script).not.toContain('did not report running');
      // Root-cause regression guard (fixture customer / fixture case): the host-side env_file is
      // provisioned root-owned but the SSH user is non-root, so the host write
      // MUST use sudo and be best-effort. Previously a plain `python3` write
      // threw PermissionError and aborted the whole CONNECT under `set -e`
      // before any credential was written.
      expect(script).toContain('sudo -n python3');
      expect(script).toContain('host env_file sync skipped (non-fatal)');
      // The authoritative webui-state write (what the gateway-supervisor reads)
      // must run BEFORE — and not be gated by — the best-effort host write.
      const webuiWriteIdx = script.indexOf('/home/hermes/.hermes/.env');
      const hostWriteIdx = script.indexOf('sudo -n python3');
      expect(webuiWriteIdx).toBeGreaterThanOrEqual(0);
      expect(hostWriteIdx).toBeGreaterThan(webuiWriteIdx);
    });

    it('uses the WebUI (webfree) SSH writer for a GATEWAY-backend box when the sidecar is unreachable (gateway ≡ webfree)', async () => {
      // Post gateway≡webfree collapse a "gateway" box runs the webfree stack, so
      // its SSH FALLBACK must use buildWebUIIntegrationSshScript (docker compose
      // restart gateway + /home/hermes/.hermes/.env), NOT the legacy
      // `docker restart agent-inst-123` branch, which no-ops against a container
      // that does not exist on the webfree topology. (The SSH-fallback script
      // selection keys on isWebfreeBackend; the sidecar fast-path below is still
      // tried first for a gateway box and works on its own.)
      (getSecureUserInstance as jest.Mock).mockResolvedValue({
        instance: { gateway_url: 'https://agent.example.com', backend: 'gateway' },
        apiServerKey: 'secret',
        error: null,
      });
      // Gateway boxes attempt the dashboard sidecar first; force it unreachable
      // (404) so we exercise the SSH fallback path.
      (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValue({
        response: { ok: false, status: 404 },
      });
      (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: '', stderr: '' });

      const req = new NextRequest('http://localhost/api/instances/inst-123/integrations', {
        method: 'POST',
        body: JSON.stringify({
          platform: 'Telegram',
          credentials: { token: 'bot-token-123' },
        }),
      });

      const res = await POST(req, { params: Promise.resolve({ id: 'inst-123' }) });

      expect(res.status).toBe(200);
      // The sidecar fast-path was attempted first (webfree gateway box)...
      expect(fetchFirstReachableGatewayResponse).toHaveBeenCalled();
      // ...then fell back to SSH using the WEBFREE writer, not the legacy script.
      const script = (sshExec as jest.Mock).mock.calls[0][1] as string;
      expect(script).toContain('docker compose restart gateway');
      expect(script).toContain('/home/hermes/.hermes/.env');
      expect(script).not.toContain('docker restart agent-inst-123');
    });

    it('preserves sub-profile env file mounts when using the SSH fallback writer', async () => {
      (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValue({
        response: {
          ok: false,
          status: 404,
        },
      });

      (sshExec as jest.Mock).mockResolvedValue({
        ok: true,
        stdout: '',
        stderr: '',
      });

      const req = new NextRequest('http://localhost/api/instances/inst-123/integrations', {
        method: 'POST',
        body: JSON.stringify({
          platform: 'Slack',
          profile: 'marcus',
          credentials: { token: 'xoxb-123', appToken: 'xapp-123' },
        }),
      });

      const res = await POST(req, { params: Promise.resolve({ id: 'inst-123' }) });

      expect(res.status).toBe(200);

      const script = (sshExec as jest.Mock).mock.calls[0][1] as string;
      expect(script).toContain('cat $ENV_FILE.tmp > $ENV_FILE');
      expect(script).not.toContain('mv $ENV_FILE.tmp $ENV_FILE');
    });

    it('loads the selected profile env before restarting a Telegram gateway through SSH fallback', async () => {
      (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValue({
        response: {
          ok: false,
          status: 404,
        },
      });

      (sshExec as jest.Mock).mockResolvedValue({
        ok: true,
        stdout: '',
        stderr: '',
      });

      const req = new NextRequest('http://localhost/api/instances/inst-123/integrations', {
        method: 'POST',
        body: JSON.stringify({
          platform: 'Telegram',
          profile: 'marcus',
          credentials: { token: 'bot-token-123' },
        }),
      });

      const res = await POST(req, { params: Promise.resolve({ id: 'inst-123' }) });

      expect(res.status).toBe(200);

      const script = (sshExec as jest.Mock).mock.calls[0][1] as string;
      expect(script).toContain('PROFILE_HOME="$BASE_HOME/profiles/marcus"');
      // The gateway runs under a self-restarting supervisor (decoded from base64),
      // not a fire-and-forget nohup; the supervisor re-sources the profile .env.
      expect(GATEWAY_SUBPROFILE_SUPERVISOR_SH).toContain('set -a; . "$PROFILE_HOME/.env"; set +a');
      expect(script).toContain('base64 -d > "$PROFILE_HOME/gateway-supervisor.sh"');
      expect(script).toContain('env HERMES_HOME="$PROFILE_HOME" nohup sh "$PROFILE_HOME/gateway-supervisor.sh"');
      expect(script).toContain('echo $! > "$SUP_PIDFILE"');
      expect(script).toContain('STATUS_FILE="$PROFILE_HOME/gateway-status.log"');
      expect(script).toContain('/opt/hermes/.venv/bin/hermes gateway status > "$STATUS_FILE" 2>&1');
      expect(script).toContain('grep -q "Gateway is running" "$STATUS_FILE"');
      expect(script).toContain('Profile integration gateway failed to report running.');
    });

    it('does not leak unexpected POST errors to the client', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      (getSecureUserInstance as jest.Mock).mockRejectedValueOnce(
        new Error('client_secret=super-secret')
      );

      const req = new NextRequest('http://localhost/api/instances/inst-123/integrations', {
        method: 'POST',
        body: JSON.stringify({
          platform: 'Slack',
          credentials: {
            token: 'xoxb-123',
            appToken: 'xapp-123',
          },
        }),
      });

      const res = await POST(req, { params: Promise.resolve({ id: 'inst-123' }) });
      const data = await res.json();

      expect(res.status).toBe(500);
      expect(data.error).toBe('Failed to update settings on remote node.');
      expect(JSON.stringify(data)).not.toContain('super-secret');
      expect(stringifyMockCalls(consoleErrorSpy)).not.toContain('super-secret');

      consoleErrorSpy.mockRestore();
    });
  });

  describe('GET', () => {
    it('reports partial status when env keys are incomplete', async () => {
      (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValue({
        url: 'http://agent.example.com/_sidecar/api/integrations?profile=default',
        response: {
          ok: false,
          status: 404,
          text: jest.fn().mockResolvedValue('missing'),
        },
      });

      (sshExec as jest.Mock).mockResolvedValue({
        ok: true,
        stdout: 'SLACK_BOT_TOKEN=xoxb-123\n',
        stderr: '',
      });

      const req = makeRequest('http://localhost/api/instances/inst-123/integrations?profile=default');

      const res = await GET(req, { params: Promise.resolve({ id: 'inst-123' }) });
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.data.statuses['Slack']).toMatchObject({
        configured: false,
        partial: true,
        missingFields: ['appToken'],
      });
    });

    it('does not log raw sidecar status errors', async () => {
      (log.warn as jest.Mock).mockClear();

      (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValue({
        response: {
          ok: false,
          status: 500,
          text: jest.fn().mockResolvedValue('access_token=super-secret'),
        },
      });

      (sshExec as jest.Mock).mockResolvedValue({
        ok: true,
        stdout: 'SLACK_BOT_TOKEN=xoxb-123\nSLACK_APP_TOKEN=xapp-123\n',
        stderr: '',
      });

      const req = makeRequest('http://localhost/api/instances/inst-123/integrations?profile=default');

      const res = await GET(req, { params: Promise.resolve({ id: 'inst-123' }) });

      expect(res.status).toBe(200);
      expect(log.warn).toHaveBeenCalledWith(
        'integrations sidecar status read failed',
        expect.objectContaining({
          source: 'integrations',
          failureType: 'integrations_sidecar_status_failed',
          sidecarStatus: 500,
        }),
      );
      const warnContextCalls = (log.warn as jest.Mock).mock.calls.map((call) => call[1]);
      expect(JSON.stringify(warnContextCalls)).not.toContain('super-secret');
    });

    it('returns a gateway-timeout response when reading integration status over SSH stalls', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValue({
        response: {
          ok: false,
          status: 404,
          text: jest.fn().mockResolvedValue('missing'),
        },
      });

      (sshExec as jest.Mock).mockResolvedValue({
        ok: false,
        stdout: '',
        stderr: '',
        error: 'SSH operation timed out after 45000ms',
      });

      const req = makeRequest('http://localhost/api/instances/inst-123/integrations?profile=default');

      const res = await GET(req, { params: Promise.resolve({ id: 'inst-123' }) });
      const data = await res.json();

      expect(res.status).toBe(504);
      expect(data.error).toBe('Timed out while reading integration status from the remote node.');
      expect(stringifyMockCalls(consoleErrorSpy)).not.toContain('45000ms');
      expect(sshExec).toHaveBeenCalledWith(
        '127.0.0.1',
        expect.any(String),
        expect.objectContaining({ timeoutMs: 45000 })
      );

      consoleErrorSpy.mockRestore();
    });

    it('does not leak unexpected GET errors to the client', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      (getSecureUserInstance as jest.Mock).mockRejectedValueOnce(
        new Error('access_token=super-secret')
      );

      const req = makeRequest('http://localhost/api/instances/inst-123/integrations?profile=default');

      const res = await GET(req, { params: Promise.resolve({ id: 'inst-123' }) });
      const data = await res.json();

      expect(res.status).toBe(500);
      expect(data.error).toBe('Failed to read integration status from the remote node.');
      expect(JSON.stringify(data)).not.toContain('super-secret');
      expect(stringifyMockCalls(consoleErrorSpy)).not.toContain('super-secret');

      consoleErrorSpy.mockRestore();
    });
  });

  it('declares a maxDuration high enough for the retried SSH apply path (regression: silent 504)', () => {
    // The SSH apply path is 45s x up to 3 attempts (~140s). Without an explicit
    // maxDuration the function can be killed under a lower default cap, 504-ing
    // the CONNECT. Guard the declared value so nobody drops it.
    expect(maxDuration).toBe(300);
  });

  describe('PVE host binding (regression: dead-IP SSH mis-resolution)', () => {
    // When an instance carries an explicit proxmoxHostConfig (resolved from its
    // config.infrastructure by validateConsoleAccess), EVERY sshExec must receive
    // it so the outer PVE host is chosen from the instance's binding — NOT by
    // re-inferring the host off the private guest IP via HERMES_PROXMOX_TARGETS,
    // which a stale/duplicate subnet entry can win and route SSH to a dead host
    // (the 2026-07-03 canary CONNECT-to-203.0.113.10 outage). If any of these
    // assertions fail, someone dropped the proxmoxHostConfig threading.
    const PVE_HOST_CONFIG = { hostSlug: 'fixturenode10', failClosed: true } as const;

    beforeEach(() => {
      (validateConsoleAccess as jest.Mock).mockResolvedValue({
        id: 'inst-123',
        userId: 'user-123',
        hostIp: '127.0.0.1',
        proxmoxHostConfig: PVE_HOST_CONFIG,
        errorResponse: null,
      });
    });

    it('threads proxmoxHostConfig into the POST env-apply SSH fallback (every attempt)', async () => {
      (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValue({
        response: { ok: false, status: 404 },
      });
      (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: '', stderr: '', error: null });

      const req = makeJsonRequest('http://localhost/api/instances/inst-123/integrations', { platform: 'Slack', credentials: { token: 'xoxb-1', appToken: 'xapp-1' } }, { method: "POST" });
      await POST(req, { params: Promise.resolve({ id: 'inst-123' }) });

      expect(sshExec).toHaveBeenCalled();
      for (const call of (sshExec as jest.Mock).mock.calls) {
        expect(call[2]).toMatchObject({ proxmoxHostConfig: PVE_HOST_CONFIG });
      }
    });

    it('threads proxmoxHostConfig into the telegram pairing-approve SSH exec', async () => {
      (getSecureUserInstance as jest.Mock).mockResolvedValue({
        instance: { gateway_url: 'https://agent.example.com', backend: 'gateway' },
        apiServerKey: 'secret',
        error: null,
      });
      (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: '\n  Approved!\n', stderr: '', error: null });

      const req = makeJsonRequest('http://localhost/api/instances/inst-123/integrations', { platform: 'Telegram', action: 'pairing-approve', credentials: { code: 'ABCD2345' } }, { method: "POST" });
      await POST(req, { params: Promise.resolve({ id: 'inst-123' }) });

      expect(sshExec).toHaveBeenCalled();
      expect((sshExec as jest.Mock).mock.calls[0][2]).toMatchObject({ proxmoxHostConfig: PVE_HOST_CONFIG });
    });

    it('threads proxmoxHostConfig into the GET status SSH fallback', async () => {
      (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValue({
        response: { ok: false, status: 404, text: jest.fn().mockResolvedValue('') },
      });
      (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: 'TELEGRAM_BOT_TOKEN=x\n', stderr: '' });

      const req = makeRequest('http://localhost/api/instances/inst-123/integrations?profile=default');
      await GET(req, { params: Promise.resolve({ id: 'inst-123' }) });

      expect(sshExec).toHaveBeenCalled();
      expect((sshExec as jest.Mock).mock.calls[0][2]).toMatchObject({ proxmoxHostConfig: PVE_HOST_CONFIG });
    });
  });
});
