import { NextRequest } from 'next/server';
import { GET } from '../route';
import { auth } from '@clerk/nextjs/server';
import { getSecureUserInstance } from '@/lib/services/instance-security';
import { fetchFirstReachableGatewayResponse } from '@/lib/agent-gateway';
import { reportOpsEvent } from '@/lib/ops-events';
import { supabaseAdmin } from '@/lib/supabase';
import { makeRequest } from "@/test-utils/request";

jest.mock('@clerk/nextjs/server', () => ({
  auth: jest.fn(),
}));

jest.mock('@/lib/services/instance-security', () => ({
  getSecureUserInstance: jest.fn(),
}));

jest.mock('@/lib/agent-gateway', () => ({
  fetchFirstReachableGatewayResponse: jest.fn(),
}));

jest.mock('@/lib/ops-events', () => ({
  reportOpsEvent: jest.fn(),
  sanitizeOpsMetadata: jest.fn((metadata: Record<string, unknown> | undefined) => metadata),
}));

jest.mock('@/lib/supabase', () => {
  const eq = jest.fn().mockResolvedValue({ data: null, error: null });
  const update = jest.fn(() => ({ eq }));
  const from = jest.fn(() => ({ update }));
  return {
    supabaseAdmin: { from },
    __mocks: { from, update, eq },
  };
});

// Post-ready SOUL.md seed hook: the route schedules it when a webfree box is
// promoted to running. Stubbed — the route only depends on the call, not the
// reconcile itself.
jest.mock('@/lib/recovery/soul-seed-reconcile', () => ({
  scheduleSoulSeedReconcileAfterResponse: jest.fn(),
}));

import { scheduleSoulSeedReconcileAfterResponse } from '@/lib/recovery/soul-seed-reconcile';

const mockedScheduleSoulSeed = scheduleSoulSeedReconcileAfterResponse as jest.Mock;

const supabaseMocks = (jest.requireMock('@/lib/supabase') as {
  __mocks: { from: jest.Mock; update: jest.Mock; eq: jest.Mock };
}).__mocks;

describe('/api/instances/[id]/health', () => {
  let consoleWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: 'user-123' });
    (getSecureUserInstance as jest.Mock).mockResolvedValue({
      instance: {
        id: 'inst-123',
        status: 'running',
        gateway_url: 'https://203-0-113-11.sslip.io',
      },
      apiServerKey: 'secret-key',
      instanceIpv4: '203.0.113.11',
      error: null,
    });
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    jest.useRealTimers();
  });

  it('delegates IPv4 fallback probing to the shared gateway helper', async () => {
    (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValueOnce({
      url: 'http://203.0.113.11/v1/models',
      response: new Response(JSON.stringify({ data: [] }), { status: 200 }),
    });

    const req = makeRequest('http://localhost/api/instances/inst-123/health');

    const res = await GET(req, { params: Promise.resolve({ id: 'inst-123' }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({ isReady: true, status: 'running' });
    expect(fetchFirstReachableGatewayResponse).toHaveBeenCalledTimes(1);
    expect(fetchFirstReachableGatewayResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://203-0-113-11.sslip.io',
        pathname: '/v1/models',
        instanceIpv4: '203.0.113.11',
      })
    );
    // Already 'running' — must NOT write to the DB on every successful probe.
    expect(supabaseMocks.update).not.toHaveBeenCalled();
  });

  it('continues probing the public gateway even if tailscale metadata is present', async () => {
    (getSecureUserInstance as jest.Mock).mockResolvedValueOnce({
      instance: {
        id: 'inst-123',
        status: 'running',
        gateway_url: 'https://public-agent.example.com',
        config: {
          privateAccess: {
            tailscale: {
              enabled: true,
              hostScoped: true,
              state: 'connected',
              magicDnsName: 'atlas-agent.tail.ts.net',
            },
          },
        },
      },
      apiServerKey: 'secret-key',
      instanceIpv4: '203.0.113.11',
      error: null,
    });

    (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValueOnce({
      url: 'https://public-agent.example.com/v1/models',
      response: new Response(JSON.stringify({ data: [] }), { status: 200 }),
    });

    const req = makeRequest('http://localhost/api/instances/inst-123/health');

    const res = await GET(req, { params: Promise.resolve({ id: 'inst-123' }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({ isReady: true, status: 'running' });
    expect(fetchFirstReachableGatewayResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://public-agent.example.com',
        pathname: '/v1/models',
        instanceIpv4: '203.0.113.11',
      })
    );
  });

  it('does not expose raw gateway probe failures in JSON mode', async () => {
    (fetchFirstReachableGatewayResponse as jest.Mock).mockRejectedValueOnce(
      new Error('health-probe-secret-leak')
    );

    const req = makeRequest('http://localhost/api/instances/inst-123/health');

    const res = await GET(req, { params: Promise.resolve({ id: 'inst-123' }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({ isReady: false, status: 'running', error: 'Gateway probe failed' });
    expect(JSON.stringify(data)).not.toContain('health-probe-secret-leak');
  });

  it('does not expose raw gateway probe failures in SSE mode', async () => {
    jest.useFakeTimers();
    (fetchFirstReachableGatewayResponse as jest.Mock)
      .mockRejectedValueOnce(new Error('health-sse-secret-leak'))
      .mockResolvedValueOnce({
        url: 'https://203-0-113-11.sslip.io/v1/models',
        response: new Response(JSON.stringify({ data: [] }), { status: 200 }),
      });

    const req = new NextRequest('http://localhost/api/instances/inst-123/health', {
      method: 'GET',
      headers: {
        accept: 'text/event-stream',
      },
    });

    const res = await GET(req, { params: Promise.resolve({ id: 'inst-123' }) });
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const bodyPromise = res.text();
    await jest.advanceTimersByTimeAsync(3100);
    const body = await bodyPromise;

    expect(body).toContain('"error":"Gateway probe failed"');
    expect(body).toContain('event: ready');
    expect(body).not.toContain('health-sse-secret-leak');
    expect(consoleWarnSpy.mock.calls.flat().join(' ')).not.toContain('health-sse-secret-leak');
    expect(reportOpsEvent).not.toHaveBeenCalled();
  });

  it('stops re-arming the SSE poll loop and emits a terminal timeout after the deadline', async () => {
    jest.useFakeTimers();
    // Gateway is never ready — always returns 503. Without a deadline the loop
    // would re-arm forever; with the 5-min cap it must give up and close.
    (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValue({
      url: 'https://203-0-113-11.sslip.io/v1/models',
      response: new Response('unavailable', { status: 503 }),
    });

    const req = new NextRequest('http://localhost/api/instances/inst-123/health', {
      method: 'GET',
      headers: {
        accept: 'text/event-stream',
      },
    });

    const res = await GET(req, { params: Promise.resolve({ id: 'inst-123' }) });
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const bodyPromise = res.text();
    // Advance past the 5-minute wall-clock cap. The loop polls every 3s, so
    // this drives many iterations and then crosses the deadline.
    await jest.advanceTimersByTimeAsync(5 * 60 * 1000 + 3100);
    const body = await bodyPromise;

    // Never flips to ready, but DOES terminate with a timeout event.
    expect(body).not.toContain('event: ready');
    expect(body).toContain('event: timeout');
    expect(body).toContain('"timedOut":true');

    // Probe must have stopped firing (loop closed) — capture the count, advance
    // well past the deadline again, and confirm no further probes happen.
    const callsAfterTimeout = (fetchFirstReachableGatewayResponse as jest.Mock).mock.calls.length;
    await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect((fetchFirstReachableGatewayResponse as jest.Mock).mock.calls.length).toBe(
      callsAfterTimeout
    );
  });

  it('does not expose unexpected top-level health route failures', async () => {
    (auth as unknown as jest.Mock).mockRejectedValueOnce(new Error('health-route-secret-leak'));

    const req = makeRequest('http://localhost/api/instances/inst-123/health');

    const res = await GET(req, { params: Promise.resolve({ id: 'inst-123' }) });
    const data = await res.json();

    expect(res.status).toBe(500);
    expect(data).toEqual({ isReady: false, error: 'Internal server error' });
    expect(JSON.stringify(data)).not.toContain('health-route-secret-leak');
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Instance health route failed',
        metadata: expect.objectContaining({
          errorType: 'Error',
          failureOwner: 'hermes',
          failurePhase: 'runtime',
          failureType: 'instance_health_route_failed',
          recoveryAction: 'retry_later',
        }),
      })
    );
  });

  it('promotes a provisioning row to running when the gateway answers 200', async () => {
    (getSecureUserInstance as jest.Mock).mockResolvedValueOnce({
      instance: {
        id: 'inst-123',
        status: 'provisioning',
        gateway_url: 'https://203-0-113-11.sslip.io',
      },
      apiServerKey: 'secret-key',
      instanceIpv4: '203.0.113.11',
      error: null,
    });
    (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValueOnce({
      url: 'http://203.0.113.11/v1/models',
      response: new Response(JSON.stringify({ data: [] }), { status: 200 }),
    });

    const req = makeRequest('http://localhost/api/instances/inst-123/health');

    const res = await GET(req, { params: Promise.resolve({ id: 'inst-123' }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({ isReady: true, status: 'running' });

    // Probe MUST have fired even though the row was 'provisioning'
    expect(fetchFirstReachableGatewayResponse).toHaveBeenCalledTimes(1);

    // DB MUST have been promoted to running/active, so other consumers
    // (chat boot UI, dashboard list, etc.) stop seeing the stale state.
    expect(supabaseMocks.from).toHaveBeenCalledWith('hermes_instances');
    expect(supabaseMocks.update).toHaveBeenCalledTimes(1);
    const updateArg = supabaseMocks.update.mock.calls[0][0];
    expect(updateArg).toMatchObject({
      status: 'running',
      lifecycle_state: 'active',
    });
    expect(supabaseMocks.eq).toHaveBeenCalledWith('id', 'inst-123');
  });

  it('keeps a provisioning row stuck when the gateway is not ready', async () => {
    (getSecureUserInstance as jest.Mock).mockResolvedValueOnce({
      instance: {
        id: 'inst-123',
        status: 'provisioning',
        gateway_url: 'https://203-0-113-11.sslip.io',
      },
      apiServerKey: 'secret-key',
      instanceIpv4: '203.0.113.11',
      error: null,
    });
    (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValueOnce({
      url: 'http://203.0.113.11/v1/models',
      response: new Response('bad gateway', { status: 502 }),
    });

    const req = makeRequest('http://localhost/api/instances/inst-123/health');

    const res = await GET(req, { params: Promise.resolve({ id: 'inst-123' }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({
      isReady: false,
      status: 'provisioning',
      error: 'Gateway status: 502',
    });
    // Probe fired; DB must NOT be written.
    expect(fetchFirstReachableGatewayResponse).toHaveBeenCalledTimes(1);
    expect(supabaseMocks.update).not.toHaveBeenCalled();
  });

  it('keeps a provisioning row stuck when the gateway probe throws', async () => {
    (getSecureUserInstance as jest.Mock).mockResolvedValueOnce({
      instance: {
        id: 'inst-123',
        status: 'provisioning',
        gateway_url: 'https://203-0-113-11.sslip.io',
      },
      apiServerKey: 'secret-key',
      instanceIpv4: '203.0.113.11',
      error: null,
    });
    (fetchFirstReachableGatewayResponse as jest.Mock).mockRejectedValueOnce(
      new Error('connect ETIMEDOUT')
    );

    const req = makeRequest('http://localhost/api/instances/inst-123/health');

    const res = await GET(req, { params: Promise.resolve({ id: 'inst-123' }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({
      isReady: false,
      status: 'provisioning',
      error: 'Gateway probe failed',
    });
    expect(supabaseMocks.update).not.toHaveBeenCalled();
  });

  it('promotes a redeploying row to running when the gateway answers 200', async () => {
    (getSecureUserInstance as jest.Mock).mockResolvedValueOnce({
      instance: {
        id: 'inst-123',
        status: 'redeploying',
        gateway_url: 'https://203-0-113-11.sslip.io',
        backend: 'webui',
      },
      apiServerKey: 'secret-key',
      instanceIpv4: '203.0.113.11',
      error: null,
    });
    (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValueOnce({
      url: 'http://203.0.113.11/health',
      response: new Response(JSON.stringify({ ok: true }), { status: 200 }),
    });

    const req = makeRequest('http://localhost/api/instances/inst-123/health');

    const res = await GET(req, { params: Promise.resolve({ id: 'inst-123' }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({ isReady: true, status: 'running' });
    // WebUI uses /health, not /v1/models — make sure we still respect that
    // on transitional rows.
    expect(fetchFirstReachableGatewayResponse).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: '/health' })
    );
    expect(supabaseMocks.update).toHaveBeenCalledTimes(1);
    expect(supabaseMocks.update.mock.calls[0][0]).toMatchObject({
      status: 'running',
      lifecycle_state: 'active',
    });
  });

  it('short-circuits without probing or writing the DB when status is stopped', async () => {
    (getSecureUserInstance as jest.Mock).mockResolvedValueOnce({
      instance: {
        id: 'inst-123',
        status: 'stopped',
        gateway_url: 'https://203-0-113-11.sslip.io',
      },
      apiServerKey: 'secret-key',
      instanceIpv4: '203.0.113.11',
      error: null,
    });

    const req = makeRequest('http://localhost/api/instances/inst-123/health');

    const res = await GET(req, { params: Promise.resolve({ id: 'inst-123' }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({ isReady: false, status: 'stopped' });
    expect(fetchFirstReachableGatewayResponse).not.toHaveBeenCalled();
    expect(supabaseMocks.update).not.toHaveBeenCalled();
  });

  it('short-circuits without probing or writing the DB when status is error', async () => {
    (getSecureUserInstance as jest.Mock).mockResolvedValueOnce({
      instance: {
        id: 'inst-123',
        status: 'error',
        gateway_url: 'https://203-0-113-11.sslip.io',
      },
      apiServerKey: 'secret-key',
      instanceIpv4: '203.0.113.11',
      error: null,
    });

    const req = makeRequest('http://localhost/api/instances/inst-123/health');

    const res = await GET(req, { params: Promise.resolve({ id: 'inst-123' }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({ isReady: false, status: 'error' });
    expect(fetchFirstReachableGatewayResponse).not.toHaveBeenCalled();
    expect(supabaseMocks.update).not.toHaveBeenCalled();
  });

  it('keeps the route responsive when the DB promotion write itself fails', async () => {
    (getSecureUserInstance as jest.Mock).mockResolvedValueOnce({
      instance: {
        id: 'inst-123',
        status: 'provisioning',
        gateway_url: 'https://203-0-113-11.sslip.io',
      },
      apiServerKey: 'secret-key',
      instanceIpv4: '203.0.113.11',
      error: null,
    });
    (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValueOnce({
      url: 'http://203.0.113.11/v1/models',
      response: new Response(JSON.stringify({ data: [] }), { status: 200 }),
    });
    // Simulate DB write failure.
    (supabaseAdmin!.from as jest.Mock).mockImplementationOnce(() => ({
      update: jest.fn(() => ({
        eq: jest.fn().mockRejectedValue(new Error('db-write-secret-leak')),
      })),
    }));

    const req = makeRequest('http://localhost/api/instances/inst-123/health');

    const res = await GET(req, { params: Promise.resolve({ id: 'inst-123' }) });
    const data = await res.json();

    // Even though the persist failed, the gateway is up — the UI must
    // still receive isReady:true so the user can stop staring at the
    // "Provisioning server" spinner.
    expect(res.status).toBe(200);
    expect(data).toEqual({ isReady: true, status: 'running' });
    expect(JSON.stringify(data)).not.toContain('db-write-secret-leak');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Readiness must prove the CHAT lane on modern webfree boxes. '/health' is
  // served by the official-dashboard shell, which comes up before the gateway
  // that answers chat (measured 2026-07-10: canary run fixturecase04 8s gap, prod
  // run fixturecase05 >190s) — promoting on it opened a workspace whose first
  // message died. backend='gateway' + key → bearer-authed '/api/sessions'.
  // ───────────────────────────────────────────────────────────────────────────
  it('probes the bearer-authed chat lane (/api/sessions) for gateway-backend boxes', async () => {
    (getSecureUserInstance as jest.Mock).mockResolvedValueOnce({
      instance: {
        id: 'inst-123',
        status: 'provisioning',
        gateway_url: 'https://203-0-113-11.sslip.io',
        backend: 'gateway',
      },
      apiServerKey: 'secret-key',
      instanceIpv4: '203.0.113.11',
      error: null,
    });
    (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValueOnce({
      url: 'https://203-0-113-11.sslip.io/api/sessions',
      response: new Response(JSON.stringify([]), { status: 200 }),
    });

    const req = makeRequest('http://localhost/api/instances/inst-123/health');

    const res = await GET(req, { params: Promise.resolve({ id: 'inst-123' }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({ isReady: true, status: 'running' });
    expect(fetchFirstReachableGatewayResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: '/api/sessions',
        headers: { Authorization: 'Bearer secret-key' },
      })
    );
  });

  it('keeps the public /health probe for legacy webui-backend boxes', async () => {
    (getSecureUserInstance as jest.Mock).mockResolvedValueOnce({
      instance: {
        id: 'inst-123',
        status: 'provisioning',
        gateway_url: 'https://203-0-113-11.sslip.io',
        backend: 'webui',
      },
      apiServerKey: 'secret-key',
      instanceIpv4: '203.0.113.11',
      error: null,
    });
    (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValueOnce({
      url: 'https://203-0-113-11.sslip.io/health',
      response: new Response(JSON.stringify({ ok: true }), { status: 200 }),
    });

    const req = makeRequest('http://localhost/api/instances/inst-123/health');

    const res = await GET(req, { params: Promise.resolve({ id: 'inst-123' }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({ isReady: true, status: 'running' });
    expect(fetchFirstReachableGatewayResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: '/health',
        headers: {},
      })
    );
  });

  it('falls back to /health for a gateway-backend row whose key is missing', async () => {
    (getSecureUserInstance as jest.Mock).mockResolvedValueOnce({
      instance: {
        id: 'inst-123',
        status: 'provisioning',
        gateway_url: 'https://203-0-113-11.sslip.io',
        backend: 'gateway',
      },
      apiServerKey: null,
      instanceIpv4: '203.0.113.11',
      error: null,
    });
    (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValueOnce({
      url: 'https://203-0-113-11.sslip.io/health',
      response: new Response(JSON.stringify({ ok: true }), { status: 200 }),
    });

    const req = makeRequest('http://localhost/api/instances/inst-123/health');

    const res = await GET(req, { params: Promise.resolve({ id: 'inst-123' }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({ isReady: true, status: 'running' });
    expect(fetchFirstReachableGatewayResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: '/health',
        headers: {},
      })
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Post-ready SOUL.md seed. This route is a promotion site: whoever OBSERVES
  // readiness first owns the seed, because /api/instances/[id]'s own seed
  // branches gate on `promotedToRunning` and are already false once this route
  // has flipped the row. Without the hook here, a box first seen healthy through
  // /health keeps the factory-default SOUL.md until the 20-min cron sweep.
  // ───────────────────────────────────────────────────────────────────────────
  describe('post-ready SOUL.md seed scheduling', () => {
    const webfreeProvisioningInstance = (backend: string) => ({
      instance: {
        id: 'inst-123',
        status: 'provisioning',
        gateway_url: 'https://203-0-113-11.sslip.io',
        backend,
      },
      apiServerKey: 'secret-key',
      instanceIpv4: '203.0.113.11',
      error: null,
    });

    it.each(['gateway', 'webui'])(
      'schedules the seed when a %s-backed provisioning row is promoted',
      async (backend) => {
        (getSecureUserInstance as jest.Mock).mockResolvedValueOnce(
          webfreeProvisioningInstance(backend)
        );
        (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValueOnce({
          url: 'http://203.0.113.11/health',
          response: new Response(JSON.stringify({ ok: true }), { status: 200 }),
        });

        const req = makeRequest('http://localhost/api/instances/inst-123/health');

        const res = await GET(req, { params: Promise.resolve({ id: 'inst-123' }) });
        expect(await res.json()).toEqual({ isReady: true, status: 'running' });

        // Row genuinely flipped …
        expect(supabaseMocks.update).toHaveBeenCalledTimes(1);
        // … so the guarded, idempotent re-seed must be scheduled for that box.
        expect(mockedScheduleSoulSeed).toHaveBeenCalledTimes(1);
        expect(mockedScheduleSoulSeed).toHaveBeenCalledWith(
          expect.objectContaining({
            instanceId: 'inst-123',
            trigger: 'health_probe_promote',
          })
        );
      }
    );

    it('does NOT schedule the seed for a non-webfree promotion', async () => {
      // A non-webfree box has no /home/hermes/.hermes/SOUL.md to reconcile;
      // reconcileInstanceSoulSeed would bail 'skipped_not_webfree' anyway, so
      // the route must not pay for the round-trip. Mirrors the gate on the
      // other promote sites.
      (getSecureUserInstance as jest.Mock).mockResolvedValueOnce({
        instance: {
          id: 'inst-123',
          status: 'provisioning',
          gateway_url: 'https://203-0-113-11.sslip.io',
          backend: 'hermes-agent',
        },
        apiServerKey: 'secret-key',
        instanceIpv4: '203.0.113.11',
        error: null,
      });
      (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValueOnce({
        url: 'http://203.0.113.11/v1/models',
        response: new Response(JSON.stringify({ data: [] }), { status: 200 }),
      });

      const req = makeRequest('http://localhost/api/instances/inst-123/health');

      const res = await GET(req, { params: Promise.resolve({ id: 'inst-123' }) });
      expect(await res.json()).toEqual({ isReady: true, status: 'running' });

      // The promotion still happens — only the seed is skipped.
      expect(supabaseMocks.update).toHaveBeenCalledTimes(1);
      expect(mockedScheduleSoulSeed).not.toHaveBeenCalled();
    });

    it('does NOT schedule the seed when the row was already running', async () => {
      // No promotion → nothing newly observed → the seed belongs to whichever
      // site did promote. Otherwise every health poll of a healthy box would
      // fire an SSH round-trip.
      (getSecureUserInstance as jest.Mock).mockResolvedValueOnce({
        instance: {
          id: 'inst-123',
          status: 'running',
          gateway_url: 'https://203-0-113-11.sslip.io',
          backend: 'gateway',
        },
        apiServerKey: 'secret-key',
        instanceIpv4: '203.0.113.11',
        error: null,
      });
      (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValueOnce({
        url: 'http://203.0.113.11/health',
        response: new Response(JSON.stringify({ ok: true }), { status: 200 }),
      });

      const req = makeRequest('http://localhost/api/instances/inst-123/health');

      const res = await GET(req, { params: Promise.resolve({ id: 'inst-123' }) });
      expect(await res.json()).toEqual({ isReady: true, status: 'running' });

      expect(supabaseMocks.update).not.toHaveBeenCalled();
      expect(mockedScheduleSoulSeed).not.toHaveBeenCalled();
    });

    it('does NOT schedule the seed when the promotion write fails', async () => {
      // reconcileSoulSeedAfterReady re-asserts status='running' against a fresh
      // row, so a seed scheduled off an unpersisted promote is a guaranteed
      // no-op round-trip. The cron sweep owns that box.
      (getSecureUserInstance as jest.Mock).mockResolvedValueOnce(
        webfreeProvisioningInstance('gateway')
      );
      (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValueOnce({
        url: 'http://203.0.113.11/health',
        response: new Response(JSON.stringify({ ok: true }), { status: 200 }),
      });
      (supabaseAdmin!.from as jest.Mock).mockImplementationOnce(() => ({
        update: jest.fn(() => ({
          eq: jest.fn().mockRejectedValue(new Error('db down')),
        })),
      }));

      const req = makeRequest('http://localhost/api/instances/inst-123/health');

      const res = await GET(req, { params: Promise.resolve({ id: 'inst-123' }) });
      // Probe still reports ready — the gateway IS up.
      expect(await res.json()).toEqual({ isReady: true, status: 'running' });
      expect(mockedScheduleSoulSeed).not.toHaveBeenCalled();
    });

    it('schedules the seed exactly once across a multi-tick SSE poll', async () => {
      // The SSE loop calls probeGateway() repeatedly. `currentStatus` latches to
      // 'running' after the first successful promote, so neither the DB write
      // nor the seed may fire again on later ticks.
      jest.useFakeTimers();
      (getSecureUserInstance as jest.Mock).mockResolvedValueOnce(
        webfreeProvisioningInstance('gateway')
      );
      (fetchFirstReachableGatewayResponse as jest.Mock)
        .mockResolvedValueOnce({
          url: 'http://203.0.113.11/health',
          response: new Response('unavailable', { status: 503 }),
        })
        .mockResolvedValue({
          url: 'http://203.0.113.11/health',
          response: new Response(JSON.stringify({ ok: true }), { status: 200 }),
        });

      const req = new NextRequest('http://localhost/api/instances/inst-123/health', {
        method: 'GET',
        headers: { accept: 'text/event-stream' },
      });

      const res = await GET(req, { params: Promise.resolve({ id: 'inst-123' }) });
      const bodyPromise = res.text();
      await jest.advanceTimersByTimeAsync(3100);
      const body = await bodyPromise;

      expect(body).toContain('event: ready');
      expect(supabaseMocks.update).toHaveBeenCalledTimes(1);
      expect(mockedScheduleSoulSeed).toHaveBeenCalledTimes(1);
      expect(mockedScheduleSoulSeed).toHaveBeenCalledWith(
        expect.objectContaining({
          instanceId: 'inst-123',
          trigger: 'health_probe_promote',
        })
      );
    });
  });
});
