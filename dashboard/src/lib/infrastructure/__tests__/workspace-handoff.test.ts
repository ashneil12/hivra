import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

const { workspaceHandoffHtml } = createRequire(__filename)(path.resolve(process.cwd(), 'provisioner/hivra-chat/workspace-handoff.cjs'));
const origin = 'https://canary.hermesos.cloud';
const sessionId = '11111111-1111-4111-8111-111111111111', nonce = '22222222-2222-4222-8222-222222222222';
const requestId = '33333333-3333-4333-8333-333333333333';

describe('guest-origin workspace handoff document', () => {
  let handlers: Map<string, (event?: unknown) => unknown>, timers: Map<number, () => void>, serial: number;
  let parent: { postMessage: jest.Mock }, fetchFn: jest.Mock, status: { hidden: boolean; textContent: string };
  let terminal: { hidden: boolean; src: string; remove: jest.Mock; addEventListener: jest.Mock; contentDocument: unknown;
    contentWindow: { Event: typeof Event; dispatchEvent: jest.Mock } };
  const init = (surface = 'files') => ({ type: 'hivra.workspace.init.v1', nonce, sessionId, surface,
    exchangeCode: `hwe1_${'x'.repeat(43)}`, verifier: 'v'.repeat(64) });
  const send = (data: unknown, overrides = {}) => handlers.get('message')!({ source: parent, origin, data, ...overrides });
  beforeEach(() => {
    handlers = new Map(); timers = new Map(); serial = 0;
    parent = { postMessage: jest.fn() }; status = { hidden: false, textContent: '' };
    terminal = { hidden: true, src: '', remove: jest.fn(), addEventListener: jest.fn(),
      contentDocument: { contentType: 'text/html', getElementById: () => ({}) }, contentWindow: { Event, dispatchEvent: jest.fn() } };
    fetchFn = jest.fn(async (url, options) => {
      if (url === '/workspace/exchange') {
        const body = JSON.parse(options.body);
        return Response.json({ sessionId, surface: body.surface, expiresAt: Date.now() + 60000,
          path: `/workspace/sessions/${sessionId}${body.surface === 'files' ? '/api/files' : '/box-terminal/'}` });
      }
      if (url.endsWith('/api/files')) return Response.json({ path: '.', entries: [] });
      return Response.json({ path: 'note.txt', content: 'owned text' });
    });
    const html = workspaceHandoffHtml(origin);
    const script = html.match(/<script>([\s\S]*)<\/script>/)![1];
    vm.runInNewContext(script, {
      window: { parent, addEventListener: (type: string, callback: (event?: unknown) => unknown) => handlers.set(type, callback), removeEventListener: (type: string) => handlers.delete(type) },
      document: { getElementById: (id: string) => id === 'status' ? status : terminal },
      crypto: { randomUUID: () => nonce }, fetch: fetchFn, URLSearchParams, TextEncoder, TextDecoder, AbortController,
      setTimeout: (callback: () => void) => { const id = ++serial; timers.set(id, callback); return id; },
      clearTimeout: (id: number) => timers.delete(id),
    });
  });
  afterEach(() => handlers.get('pagehide')?.());
  it('announces a document nonce to only the configured parent origin', () => {
    expect(parent.postMessage).toHaveBeenCalledWith({ type: 'hivra.workspace.ready.v1', nonce }, origin);
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it('ignores wrong origin, source, nonce and injected URLs before exchanging', async () => {
    await send(init(), { origin: 'https://evil.test' }); await send(init(), { source: {} });
    await send({ ...init(), nonce: requestId }); await send({ ...init(), url: 'https://evil.test' });
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it('uses one exchange and never reflects its code/verifier or changes sessions', async () => {
    await send(init()); await send(init()); await send({ ...init(), sessionId: requestId });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[0][0]).toBe('/workspace/exchange');
    expect(fetchFn.mock.calls[0][1]).toMatchObject({ credentials: 'same-origin', redirect: 'error', referrerPolicy: 'no-referrer' });
    expect(parent.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'hivra.workspace.connected.v1', sessionId, surface: 'files', nonce }), origin);
    expect(JSON.stringify(parent.postMessage.mock.calls)).not.toMatch(/hwe1_|verifier/);
  });
  it('maps file operations to the immutable session, never a message-provided URL', async () => {
    await send(init());
    const base = { type: 'hivra.workspace.files.v1', nonce, sessionId, requestId, operation: 'read', path: 'notes/a & b.txt' };
    await send(base);
    expect(fetchFn.mock.calls[2][0]).toBe(`/workspace/sessions/${sessionId}/api/file?path=notes%2Fa+%26+b.txt`);
    expect(parent.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'hivra.workspace.result.v1', requestId, sessionId, ok: true,
      data: { path: 'note.txt', content: 'owned text' } }), origin);
    await send({ ...base, operation: 'write', content: 'updated' });
    expect(fetchFn.mock.calls[3][0]).toBe(`/workspace/sessions/${sessionId}/api/file`);
    expect(JSON.parse(fetchFn.mock.calls[3][1].body)).toEqual({ path: base.path, content: 'updated' });
    await send({ ...base, sessionId: requestId }); await send({ ...base, url: 'https://evil.test' });
    await send({ ...base, operation: 'model' });
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });
  it('keeps shell sessions separate from Files and reports only document mounting', async () => {
    await send(init('box-terminal'));
    expect(terminal.src).toBe(`/workspace/sessions/${sessionId}/box-terminal/`);
    await send({ type: 'hivra.workspace.files.v1', nonce, sessionId, requestId, operation: 'list', path: '.' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    terminal.addEventListener.mock.calls[0][1]();
    expect(terminal.hidden).toBe(false);
    expect(terminal.contentWindow.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'resize' }));
    expect(parent.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'hivra.workspace.mounted.v1' }), origin);
  });
  it('closes the terminal browsing context and aborts work when the grant expires', async () => {
    await send(init('box-terminal'));
    timers.get(serial)!();
    expect(terminal.remove).toHaveBeenCalledTimes(1);
    expect(parent.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'hivra.workspace.ended.v1', reason: 'expired' }), origin);
    await send(init()); expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it('rejects an exchange response that tries to redirect to another path', async () => {
    fetchFn.mockResolvedValue(Response.json({ sessionId, surface: 'files', expiresAt: Date.now() + 60000, path: '/api/model' }));
    await send(init()); expect(terminal.src).toBe('');
    expect(parent.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'hivra.workspace.ended.v1', reason: 'exchange-denied' }), origin);
  });
  it('tears down outstanding file requests on document exit', async () => {
    await send(init());
    fetchFn.mockImplementation((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))));
    const pending = send({ type: 'hivra.workspace.files.v1', nonce, sessionId, requestId, operation: 'read', path: 'note.txt' });
    handlers.get('pagehide')!(); await pending;
    expect(fetchFn.mock.calls[2][1].signal.aborted).toBe(true);
    expect(handlers.has('message')).toBe(false);
  });
  it('does not announce connected when the browser cannot use the cookie', async () => {
    const exchange = fetchFn.getMockImplementation()!;
    fetchFn.mockImplementation((url, options) => url === '/workspace/exchange' ? exchange(url, options)
      : Response.json({ code: 'workspace_authorization_denied' }, { status: 403 }));
    await send(init());
    expect(parent.postMessage.mock.calls.some(([data]) => data.type === 'hivra.workspace.connected.v1')).toBe(false);
    expect(parent.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'hivra.workspace.ended.v1', reason: 'files-unavailable' }), origin);
  });
  it('ends on lost authority but preserves the session for a private-file denial', async () => {
    await send(init());
    const request = { type: 'hivra.workspace.files.v1', nonce, sessionId, requestId, operation: 'read', path: '.private' };
    fetchFn.mockResolvedValueOnce(Response.json({ error: 'file access denied' }, { status: 403 }));
    await send(request);
    expect(parent.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'hivra.workspace.result.v1', ok: false, status: 403 }), origin);
    expect(terminal.remove).not.toHaveBeenCalled();
    fetchFn.mockResolvedValueOnce(Response.json({ code: 'workspace_authorization_denied' }, { status: 403 }));
    await send(request);
    expect(parent.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'hivra.workspace.ended.v1', reason: 'authorization-lost' }), origin);
  });
});
