import type { AuditConfig } from '../e2e/first-run-audit/config';
import {
  AUDIT_DESKTOP_SESSIONS_PATH,
  AUDIT_DESKTOP_WS_PATH,
  probeAgentChatOverWs,
} from '../e2e/first-run-audit/agent-chat';

describe('first-run audit agent chat surface', () => {
  it('drives the same /desktop remote-gateway route as Hermes Desktop Web', async () => {
    const evaluate = jest.fn().mockResolvedValue({
      ok: true,
      terminal: 'message.complete',
      text: 'ping',
      chars: 4,
      auth: 'token',
      waited_ms: 5,
      log: ['ws_path=/desktop/api/ws', 'ws_open', 'gateway_ready'],
    });
    const page = {
      goto: jest.fn().mockResolvedValue(undefined),
      url: jest.fn().mockReturnValue('https://box.test/webchat'),
      evaluate,
      close: jest.fn().mockResolvedValue(undefined),
    };
    const response = {
      status: jest.fn().mockReturnValue(200),
      json: jest.fn().mockResolvedValue({
        url: `https://box.test/_sidecar/handoff?next=${encodeURIComponent(
          'https://box.test/webchat#iframe_token=test-secret',
        )}`,
      }),
    };
    const context = {
      request: { get: jest.fn().mockResolvedValue(response) },
      newPage: jest.fn().mockResolvedValue(page),
    };
    const cfg = {
      baseUrl: 'https://canary.test',
      agentReplyTimeoutMs: 30_000,
    } as AuditConfig;

    const result = await probeAgentChatOverWs(context as never, cfg, 'instance-1');

    expect(result).toMatchObject({ ok: true, text: 'ping', auth: 'token' });
    expect(evaluate).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        wsPath: AUDIT_DESKTOP_WS_PATH,
        sessionsPath: AUDIT_DESKTOP_SESSIONS_PATH,
        token: 'test-secret',
      }),
    );
    expect(AUDIT_DESKTOP_WS_PATH).toBe('/desktop/api/ws');
    expect(AUDIT_DESKTOP_SESSIONS_PATH).toBe('/desktop/api/sessions');
  });
});
