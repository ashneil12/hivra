import { createRequire } from 'node:module';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { POST as exchange } from '@/app/api/workspace/sessions/exchange/route';
import { POST as authorize } from '@/app/api/workspace/sessions/authorize/route';
import { supabaseAdmin } from '@/lib/supabase';

jest.mock('@/lib/supabase', () => ({ supabaseAdmin: { rpc: jest.fn() } }));
jest.mock('@/lib/rate-limit', () => ({ enforceRateLimit: () => ({ success: true }), getIP: () => '127.0.0.1' }));
const { createWorkspaceControl } = createRequire(__filename)(path.resolve(process.cwd(), 'provisioner/hivra-chat/workspace-control.cjs'));
const computerId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const publicOrigin = 'https://box.example.test', controlOrigin = 'https://canary.hermesos.cloud';
const rpc = supabaseAdmin!.rpc as jest.Mock;
const input = { sessionId, surface: 'files', exchangeCode: `hwe1_${'x'.repeat(43)}`, verifier: 'v'.repeat(64) };
const req = (cookie: string, url = '/api/files', extra = {}) => ({ method: 'GET', url,
  headers: { host: 'box.example.test', cookie: cookie.split(';')[0], ...extra } });

describe('workspace guest to control-plane integration', () => {
  let client: ReturnType<typeof createWorkspaceControl>;
  let fetchFn: jest.Mock;
  let expiresAt: number;
  beforeEach(() => {
    expiresAt = Date.now() + 60000;
    rpc.mockReset().mockImplementation(async (name, args) => ({ error: null, data: {
      status: name.startsWith('exchange') ? 'exchanged' : 'authorized', sessionId: args.p_id,
      computerId: args.p_computer, surface: args.p_surface, audience: args.p_audience,
      userId: 'owner', expiresAt: new Date(expiresAt).toISOString(),
    } }));
    // Real HTTP route validation + broker adapters, with only database/network
    // transport substituted. SQL authority is covered by its Postgres fixture.
    fetchFn = jest.fn(async (url: string, init: ConstructorParameters<typeof NextRequest>[1]) => {
      const request = new NextRequest(url, init);
      return url.endsWith('/exchange') ? exchange(request) : authorize(request);
    });
    client = createWorkspaceControl({ computerId, publicOrigin, controlOrigin, fetchFn });
  });
  afterEach(() => client.close());
  it('exchanges through real endpoints and returns only an unrelated cookie', async () => {
    const receipt = await client.exchangeAndMint(input);
    expect(receipt).toMatchObject({ sessionId, surface: 'files', expiresAt });
    expect(receipt.cookie).toMatch(/^__Host-hivra_workspace-/);
    expect(JSON.stringify(receipt)).not.toMatch(/hws1_|hwe1_|owner/);
    expect(await client.authorize(sessionId, req(receipt.cookie))).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetchFn.mock.calls) {
      expect(url.startsWith(`${controlOrigin}/api/workspace/sessions/`)).toBe(true);
      expect(init.redirect).toBe('error'); expect(init.credentials).toBe('omit');
      expect(init.headers).not.toHaveProperty('cookie'); expect(init.headers).not.toHaveProperty('origin');
    }
    expect(JSON.stringify(rpc.mock.calls)).not.toMatch(/hws1_|hwe1_/);
  });
  it('closes a shell socket when durable authorization is revoked', async () => {
    const receipt = await client.exchangeAndMint({ ...input, surface: 'box-terminal' });
    const close = jest.fn();
    expect(await client.attachSocket(sessionId, req(receipt.cookie, '/box-terminal/ws', { origin: publicOrigin, upgrade: 'websocket' }), close)).toEqual(expect.any(Function));
    rpc.mockResolvedValue({ data: { status: 'denied' }, error: null });
    await client.sweep();
    expect(close).toHaveBeenCalledTimes(1);
    expect(await client.authorize(sessionId, req(receipt.cookie, '/box-terminal/'))).toBe(false);
  });
  it.each([{ computerId }, { audience: publicOrigin }, { controlOrigin: 'https://evil.test' },
    { verifier: 'short' }, { exchangeCode: 'bad' }, { surface: 'desktop' }])('rejects browser configuration overrides or malformed handoff %j', async change => {
    expect(await client.exchangeAndMint({ ...input, ...change })).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it.each(['redirect', 'html', 'oversize', 'cookie', 'wrong-binding', 'wrong-owner', 'extended-expiry'])('fails closed on %s control responses', async kind => {
    const realFetch = fetchFn.getMockImplementation()!;
    fetchFn.mockImplementation(async (url, init) => {
      const response = await realFetch(url, init);
      if (kind === 'redirect') return new Response('', { status: 302, headers: { location: 'https://evil.test' } });
      if (kind === 'html') return new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } });
      if (kind === 'oversize') return new Response('x'.repeat(4097), { headers: { 'content-type': 'application/json' } });
      if (kind === 'cookie') response.headers.set('set-cookie', 'unexpected=1');
      if (['wrong-binding', 'wrong-owner', 'extended-expiry'].includes(kind) && url.endsWith('/authorize')) {
        const body = await response.json();
        if (kind === 'wrong-binding') body.data.computerId = sessionId;
        if (kind === 'wrong-owner') body.data.userId = 'different-owner';
        if (kind === 'extended-expiry') body.data.expiresAt += 1000;
        return Response.json(body);
      }
      return response;
    });
    expect(await client.exchangeAndMint(input)).toBeNull();
  });
  it('aborts pending network work on close and cannot mint afterwards', async () => {
    fetchFn.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const pending = client.exchangeAndMint(input);
    client.close();
    expect(await pending).toBeNull();
    expect(await client.exchangeAndMint(input)).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it('aborts an unavailable exchange at the five-second deadline', async () => {
    jest.useFakeTimers();
    try {
      fetchFn.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }));
      const pending = client.exchangeAndMint(input);
      await jest.advanceTimersByTimeAsync(5000);
      expect(await pending).toBeNull();
      expect(fetchFn.mock.calls[0][1].signal.aborted).toBe(true);
    } finally { jest.useRealTimers(); }
  });
  it('uses one deadline for response headers and a stalled response body', async () => {
    jest.useFakeTimers();
    try {
      fetchFn.mockImplementation(async (_url, init) => {
        await new Promise(resolve => setTimeout(resolve, 4000));
        return new Response(new ReadableStream({ start(controller) {
          init.signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
        } }), { headers: { 'content-type': 'application/json' } });
      });
      const pending = client.exchangeAndMint(input);
      await jest.advanceTimersByTimeAsync(4999);
      expect(fetchFn.mock.calls[0][1].signal.aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(await pending).toBeNull();
      expect(fetchFn.mock.calls[0][1].signal.aborted).toBe(true);
    } finally { jest.useRealTimers(); }
  });
});
