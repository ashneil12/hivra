import { createRequire } from 'node:module';
import path from 'node:path';

const { createWorkspaceSessions } = createRequire(__filename)(path.resolve(process.cwd(), 'provisioner/hivra-chat/workspace-sessions.cjs'));
const computerId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const origin = 'https://box.example.test';

describe('guest workspace session adapter', () => {
  let clock: number;
  let verify: jest.Mock;
  let store: ReturnType<typeof createWorkspaceSessions>;
  const grant = (surface = 'files') => ({ sessionId, computerId, userId: 'owner', audience: origin, surface, expiresAt: clock + 60_000 });
  const req = (cookie: string, url = '/api/files', method = 'GET', extra = {}) => ({ url, method,
    headers: { host: 'box.example.test', cookie: cookie.split(';')[0], ...extra } });
  beforeEach(() => {
    clock = 1_000_000;
    verify = jest.fn().mockResolvedValue(true);
    store = createWorkspaceSessions({ computerId, publicOrigin: origin, authorizeGrant: verify, now: () => clock });
  });
  afterEach(() => store.close());

  it('issues an opaque HttpOnly cookie, not the original grant or owner', async () => {
    const result = await store.mint(grant());
    expect(result.cookie).toMatch(/^__Host-hivra_workspace-22222222-2222-4222-8222-222222222222=[a-f0-9]{64}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=60$/);
    expect(result.cookie).not.toContain('owner');
    expect(result.sessionId).toBe(sessionId);
    expect(await store.authorize(sessionId, req(result.cookie))).toBe(true);
    expect(verify).toHaveBeenCalledTimes(2);
  });
  it.each([
    { computerId: sessionId }, { audience: 'https://other.test' }, { userId: '' }, { surface: 'all' },
    { sessionId: 'invalid' }, { expiresAt: 1_000_000 }, { expiresAt: 1_240_001 }, { expiresAt: Infinity },
  ])('rejects invalid or mismatched binding %j', async change => {
    expect(await store.mint({ ...grant(), ...change })).toBeNull();
    expect(verify).not.toHaveBeenCalled();
  });
  it('denies failed or unavailable authority before minting', async () => {
    verify.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('unavailable'));
    expect(await store.mint(grant())).toBeNull();
    expect(await store.mint(grant())).toBeNull();
  });
  it('does not reuse the same exchanged grant in parallel sessions', async () => {
    const results = await Promise.all([store.mint(grant()), store.mint(grant())]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
  it('cannot cross surface, host, cookie or mutation-origin boundaries', async () => {
    const { cookie } = await store.mint(grant());
    for (const attempt of [req(cookie, '/box-terminal/'), req(cookie, '/api/model'),
      req(cookie, '/api/files', 'GET', { host: 'other.test' }),
      req(cookie, '/api/file', 'POST'), req(cookie, '/api/file', 'POST', { origin: 'https://evil.test' }),
      req(cookie, '/api/files', 'GET', { cookie: cookie.split(';')[0] + '; ' + cookie.split(';')[0] })]) {
      expect(await store.authorize(sessionId, attempt)).toBe(false);
    }
    expect(await store.authorize(sessionId, req(cookie, '/api/file', 'POST', { origin }))).toBe(true);
  });
  it('rejects expiry crossed during a remote authorization', async () => {
    const { cookie } = await store.mint(grant());
    verify.mockImplementationOnce(async () => { clock += 60_000; return true; });
    expect(await store.authorize(sessionId, req(cookie))).toBe(false);
  });
  it('rejects minting across expiry or shutdown', async () => {
    verify.mockImplementationOnce(async () => { clock += 60_000; return true; });
    expect(await store.mint(grant())).toBeNull();
    verify.mockImplementationOnce(async () => { store.close(); return true; });
    expect(await store.mint(grant())).toBeNull();
  });
  it('closes existing sockets when the original grant is revoked', async () => {
    const { cookie } = await store.mint(grant('box-terminal'));
    const close = jest.fn();
    expect(await store.attachSocket(sessionId, req(cookie, '/box-terminal/ws', 'GET', { origin, upgrade: 'websocket' }), close)).toEqual(expect.any(Function));
    verify.mockResolvedValue(false);
    await store.sweep();
    expect(close).toHaveBeenCalledTimes(1);
    expect(await store.authorize(sessionId, req(cookie, '/box-terminal/'))).toBe(false);
  });
  it('expires and shuts down attached sockets without extending the grant', async () => {
    const { cookie } = await store.mint(grant('box-terminal'));
    const close = jest.fn();
    await store.attachSocket(sessionId, req(cookie, '/box-terminal/ws', 'GET', { origin, upgrade: 'websocket' }), close);
    clock += 60_000;
    await store.sweep();
    store.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('does not close detached sockets', async () => {
    const { cookie } = await store.mint(grant('box-terminal'));
    const close = jest.fn();
    const detach = await store.attachSocket(sessionId, req(cookie, '/box-terminal/ws', 'GET', { origin, upgrade: 'websocket' }), close);
    detach(); store.close();
    expect(close).not.toHaveBeenCalled();
  });
  it('bounds session allocation without evicting active authority', async () => {
    store.close();
    store = createWorkspaceSessions({ computerId, publicOrigin: origin, authorizeGrant: verify, now: () => clock, maxSessions: 1 });
    const { cookie } = await store.mint(grant());
    expect(await store.mint({ ...grant(), sessionId: '33333333-3333-4333-8333-333333333333' })).toBeNull();
    expect(await store.authorize(sessionId, req(cookie))).toBe(true);
  });
  it('does not let a revoked document adopt a new same-browser shell session', async () => {
    const old = await store.mint(grant('box-terminal'));
    verify.mockResolvedValue(false);
    await store.sweep();
    verify.mockResolvedValue(true);
    const nextId = '33333333-3333-4333-8333-333333333333';
    const next = await store.mint({ ...grant('box-terminal'), sessionId: nextId });
    const jar = old.cookie.split(';')[0] + '; ' + next.cookie.split(';')[0];
    const reconnect = req(jar, '/box-terminal/ws', 'GET', { cookie: jar, origin, upgrade: 'websocket' });
    expect(await store.authorize(sessionId, reconnect)).toBe(false);
    expect(await store.authorize(nextId, reconnect)).toBe(true);
    const substituted = next.cookie.split(';')[0].replace(nextId, sessionId);
    expect(await store.authorize(sessionId, req(substituted, '/box-terminal/'))).toBe(false);
  });
  it('retains independent files and terminal sessions in the same cookie jar', async () => {
    const files = await store.mint(grant());
    const shellId = '33333333-3333-4333-8333-333333333333';
    const shell = await store.mint({ ...grant('box-terminal'), sessionId: shellId });
    const jar = files.cookie.split(';')[0] + '; ' + shell.cookie.split(';')[0];
    expect(await store.authorize(sessionId, req(jar, '/api/files', 'GET', { cookie: jar }))).toBe(true);
    expect(await store.authorize(shellId, req(jar, '/box-terminal/', 'GET', { cookie: jar }))).toBe(true);
    expect(await store.authorize(sessionId, req(jar, '/box-terminal/', 'GET', { cookie: jar }))).toBe(false);
  });
  it('bounds a hung grant check and aborts its transport', async () => {
    store.close();
    jest.useFakeTimers();
    try {
      store = createWorkspaceSessions({ computerId, publicOrigin: origin, authorizeGrant: verify, now: () => clock });
      let signal: AbortSignal | undefined;
      verify.mockImplementationOnce((_grant, abortSignal) => { signal = abortSignal; return new Promise(() => {}); });
      const pending = store.mint(grant());
      await jest.advanceTimersByTimeAsync(5000);
      expect(await pending).toBeNull();
      expect(signal?.aborted).toBe(true);
    } finally { store.close(); jest.useRealTimers(); }
  });
  it('automatically closes expired sockets even without an explicit sweep', async () => {
    store.close();
    jest.useFakeTimers();
    try {
      store = createWorkspaceSessions({ computerId, publicOrigin: origin, authorizeGrant: verify, now: () => clock });
      const { cookie } = await store.mint({ ...grant('box-terminal'), expiresAt: clock + 1000 });
      const close = jest.fn();
      await store.attachSocket(sessionId, req(cookie, '/box-terminal/ws', 'GET', { origin, upgrade: 'websocket' }), close);
      await jest.advanceTimersByTimeAsync(1000);
      expect(close).toHaveBeenCalledTimes(1);
      expect(await store.authorize(sessionId, req(cookie, '/box-terminal/'))).toBe(false);
    } finally { store.close(); jest.useRealTimers(); }
  });
});
