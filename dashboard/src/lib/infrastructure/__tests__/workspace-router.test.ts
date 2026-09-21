import { createRequire } from 'node:module';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';

const { createWorkspaceRouter, sessionTarget } = createRequire(__filename)(path.resolve(process.cwd(), 'provisioner/hivra-chat/workspace-router.cjs'));
const computerId = '11111111-1111-4111-8111-111111111111', sessionId = '22222222-2222-4222-8222-222222222222';
const publicOrigin = 'https://box.example.test', controlOrigin = 'https://canary.hermesos.cloud';
const prefix = `/workspace/sessions/${sessionId}`;
const key = 'dGhlIHNhbXBsZSBub25jZQ==';

describe('workspace gateway HTTP and socket routing', () => {
  let router: ReturnType<typeof createWorkspaceRouter>, server: http.Server, terminal: http.Server;
  let denied: boolean, expiresAt: number, port: number, terminalPort: number;
  let files: { list: jest.Mock; read: jest.Mock; write: jest.Mock }, terminalRequest: jest.Mock;
  let observed: http.IncomingHttpHeaders;
  let clockOffset: number, authorizationObserved: () => void;
  const send = (url: string, method = 'GET', headers: http.OutgoingHttpHeaders = {}, body = '') => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: url, method,
      headers: { host: 'box.example.test', ...headers } }, response => {
      let result = ''; response.on('data', chunk => { result += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: result }));
    });
    request.on('error', reject); request.end(body);
  });
  const mint = async (surface = 'files') => {
    const response = await send('/workspace/exchange', 'POST', { origin: publicOrigin, 'content-type': 'application/json' }, JSON.stringify({
      sessionId, surface, exchangeCode: `hwe1_${'x'.repeat(43)}`, verifier: 'v'.repeat(64),
    }));
    expect(response.status).toBe(200);
    return response.headers['set-cookie']![0].split(';')[0];
  };
  beforeEach(async () => {
    denied = false; expiresAt = Date.now() + 60000; clockOffset = 0; authorizationObserved = () => {};
    const json = (res: http.ServerResponse, data: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)); };
    files = { list: jest.fn((res, query) => json(res, { path: query.get('path') || '.' })),
      read: jest.fn((res, query) => json(res, { path: query.get('path') })),
      write: jest.fn((req, res) => { let body = ''; req.on('data', (chunk: Buffer) => { body += chunk; }); req.on('end', () => json(res, JSON.parse(body))); }) };
    terminal = http.createServer((req, res) => {
      observed = req.headers;
      res.writeHead(200, { 'content-type': req.url?.endsWith('/token') ? 'application/json' : 'text/html',
        'set-cookie': 'unsafe=1', 'access-control-allow-origin': '*', location: 'https://elsewhere.test' });
      res.end(req.url?.endsWith('/token') ? '{}' : '<html>terminal fixture</html>');
    });
    terminal.on('upgrade', (req, socket) => {
      observed = req.headers;
      const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: tty\r\nSet-Cookie: unsafe=1\r\n\r\n`);
      socket.on('data', chunk => socket.write(chunk)); socket.on('error', () => {});
      // An upgraded raw Node socket is half-open: model the terminal closing
      // its side after the broker disconnects rather than retaining a fixture.
      socket.on('end', () => socket.end());
    });
    await new Promise<void>(resolve => terminal.listen(0, '127.0.0.1', resolve));
    terminalPort = (terminal.address() as AddressInfo).port;
    terminalRequest = jest.fn(options => {
      expect(options.host).toBe('127.0.0.1'); expect(options.port).toBe(7682);
      return http.request({ ...options, port: terminalPort });
    });
    router = createWorkspaceRouter({ computerId, publicOrigin, controlOrigin, files, now: () => Date.now() + clockOffset,
      fetchFn: async (url: string, init: RequestInit) => {
        if (url.endsWith('/authorize')) authorizationObserved();
        if (denied) return Response.json({ authorized: false }, { status: 403 });
        const body = JSON.parse(init.body as string);
        const data = { sessionId: body.sessionId, computerId, surface: body.surface, audience: publicOrigin, userId: 'owner', expiresAt };
        return Response.json(url.endsWith('/exchange') ? { success: true, data: { ...data, sessionToken: `hws1_${'t'.repeat(43)}` } } : { authorized: true, data });
      },
    }, { terminalRequest });
    server = http.createServer((req, res) => { void router.handleHttp(req, res); });
    server.on('upgrade', (req, socket, head) => { void router.handleUpgrade(req, socket, head); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    router.close();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => terminal.close(() => resolve()))]);
  });
  it('dispatches file reads/writes only through the selected immutable session path', async () => {
    const cookie = await mint();
    expect((await send(prefix + '/api/files?path=notes', 'GET', { cookie })).body).toBe('{"path":"notes"}');
    expect((await send(prefix + '/api/file?path=notes/a.txt', 'GET', { cookie })).status).toBe(200);
    const result = await send(prefix + '/api/file', 'POST', { cookie, origin: publicOrigin, 'content-type': 'application/json' }, '{"path":"note.txt","content":"test"}');
    expect(result.status).toBe(200); expect(files.write).toHaveBeenCalledTimes(1);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('serves a non-authorizing handoff document with a configured framing policy', async () => {
    const result = await send('/workspace/handoff');
    expect(result.status).toBe(200); expect(result.body).toContain('hivra.workspace.ready.v1');
    expect(result.headers['set-cookie']).toBeUndefined();
    expect(result.headers['content-security-policy']).toContain(`frame-ancestors 'self' ${controlOrigin}`);
    expect(result.headers['content-security-policy']).toContain("connect-src 'self'");
    expect((await send('/workspace/handoff?token=bad')).status).toBe(404);
    expect(files.list).not.toHaveBeenCalled(); expect(terminalRequest).not.toHaveBeenCalled();
  });
  it.each(['/api/model', '/terminal/', '/desktop/', '/api/files?path=x&path=y', '/api/file?secret=x'])('cannot route a file grant to %s', async route => {
    expect((await send(prefix + route, 'GET', { cookie: await mint() })).status).toBe(403);
    expect(files.list).not.toHaveBeenCalled(); expect(files.read).not.toHaveBeenCalled(); expect(terminalRequest).not.toHaveBeenCalled();
  });
  it('rejects wrong Host, cross-origin writes, management bearer and another session ID', async () => {
    const cookie = await mint();
    for (const headers of [{ cookie, host: 'evil.test' }, { cookie, authorization: 'Bearer management' }]) {
      expect((await send(prefix + '/api/files', 'GET', headers)).status).toBe(403);
    }
    expect((await send(prefix.replace(sessionId, computerId) + '/api/files', 'GET', { cookie })).status).toBe(403);
    expect((await send(prefix + '/api/file', 'POST', { cookie, origin: controlOrigin, 'content-type': 'application/json' }, '{}')).status).toBe(403);
    expect(files.write).not.toHaveBeenCalled();
  });
  it('strips cookies, authorization and unsafe response headers from terminal HTTP', async () => {
    const cookie = await mint('box-terminal');
    const result = await send(prefix + '/box-terminal/', 'GET', { cookie, 'x-forwarded-host': 'evil.test' });
    expect(result.status).toBe(200); expect(result.body).toContain('terminal fixture');
    expect(observed.cookie).toBeUndefined(); expect(observed.authorization).toBeUndefined(); expect(observed['x-forwarded-host']).toBeUndefined();
    for (const header of ['set-cookie', 'location', 'access-control-allow-origin']) expect(result.headers[header]).toBeUndefined();
    expect(result.headers['content-security-policy']).toBe(`frame-ancestors 'self' ${controlOrigin}`);
  });
  it.each(['revoked', 'expired'])('does not write a body completed after authority becomes %s', async reason => {
    const cookie = await mint();
    const admitted = new Promise<void>(resolve => { authorizationObserved = resolve; });
    let request: http.ClientRequest;
    const result = new Promise<number>((resolve, reject) => {
      request = http.request({ host: '127.0.0.1', port, path: prefix + '/api/file', method: 'POST', headers: {
        host: 'box.example.test', cookie, origin: publicOrigin, 'content-type': 'application/json',
      } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode!)); });
      request.on('error', reject); request.write('{"path":"note.txt",');
    });
    await admitted;
    if (reason === 'revoked') denied = true; else clockOffset = 60001;
    request!.end('"content":"must not write"}');
    expect(await result).toBe(403); expect(files.write).not.toHaveBeenCalled();
  });
  it('carries an owned terminal socket and closes both sides on router shutdown', async () => {
    const cookie = await mint('box-terminal');
    const result = await new Promise<{ socket: import('node:stream').Duplex; response: http.IncomingMessage }>((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port, path: prefix + '/box-terminal/ws', headers: {
        host: 'box.example.test', origin: publicOrigin, cookie, connection: 'Upgrade', upgrade: 'websocket',
        'sec-websocket-key': key, 'sec-websocket-version': '13', 'sec-websocket-protocol': 'tty',
      } });
      request.on('error', reject); request.on('upgrade', (response, socket) => resolve({ response, socket })); request.end();
    });
    expect(result.response.headers['set-cookie']).toBeUndefined(); expect(observed.cookie).toBeUndefined();
    const echoed = new Promise<string>(resolve => result.socket.once('data', chunk => resolve(chunk.toString())));
    result.socket.write('owned-transport-frame'); expect(await echoed).toBe('owned-transport-frame');
    const stopped = new Promise<void>(resolve => result.socket.once('close', () => resolve()));
    router.close(); await stopped;
  });
  it.each([prefix + '/../api/files', prefix + '/%2e%2e/api/files', prefix + '/api/files#fragment', '//workspace/sessions/' + sessionId + '/api/files'])('rejects noncanonical session routing %s', value => {
    expect(sessionTarget(value)).toBeNull();
  });
});
