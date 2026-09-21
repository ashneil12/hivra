'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const policy = require('../../provisioner/deepseek-harness/gateway-policy.cjs');
const { createNativeBroker } = require('../../provisioner/deepseek-harness/native-broker.cjs');
const ORIGIN = 'https://computer.example.test';
const HOST = new URL(ORIGIN).host;
const MANAGEMENT = 'a'.repeat(64);

test('configuration accepts only canonical DNS HTTPS origins', () => {
  assert.equal(policy.canonicalOrigin(ORIGIN), true);
  assert.equal(policy.canonicalOrigin('https://203-0-113-10.sslip.io'), true);
  for (const origin of ['http://computer.test', `${ORIGIN}/`, `${ORIGIN}:443`, `${ORIGIN}:8443`,
    'https://user:pass@computer.test', 'https://Computer.test', 'https://computer.test.', 'https://a..test',
    'https://127.1', 'https://0177.0.0.1', 'https://example.123', 'https://xn--a.example',
    'https://-a.test', 'https://a_.test', 'https://localhost', `${ORIGIN}?key=x`, `${ORIGIN}#x`, {}, null]) {
    assert.equal(policy.canonicalOrigin(origin), false);
  }
});

test('method and exact path distinguish management, native RPC and computer surfaces', () => {
  assert.equal(policy.routeKind('GET', '/api/skills'), 'unsupported');
  assert.equal(policy.routeKind('POST', '/api/skills/list'), 'native');
  assert.equal(policy.routeKind('GET', '/api/remote.mux'), 'native');
  assert.equal(policy.routeKind('POST', '/api/session/prompt'), 'native');
  assert.equal(policy.routeKind('GET', '/api/file'), 'computer');
  assert.equal(policy.routeKind('GET', '/api/git/diff'), 'unsupported');
  assert.equal(policy.routeKind('GET', '/terminal-other'), 'native');
  assert.equal(policy.routeKind('GET', '/terminal/ws'), 'surface');
});

test('complete gateway separates native cookies from Hivra management, routing and readiness', async t => {
  const launchToken = crypto.randomBytes(32).toString('base64url');
  const observations = [];
  const peers = new Set();
  let gateway, broker, launched, stopped;
  const upstream = http.createServer((req, res) => {
    if (req.url === `/?token=${launchToken}`) {
      const now = Date.now();
      const payload = Buffer.from(JSON.stringify({ version: 1, authority: req.headers.host, issuedAt: now, expiresAt: now + 60000 })).toString('base64url');
      const cookie = `dsh-auth-${crypto.createHash('sha256').update(req.headers.host).digest('base64url')}=v1.${payload}.${crypto.randomBytes(32).toString('base64url')}`;
      res.writeHead(303, { location: '/', 'set-cookie': `${cookie}; Path=/; HttpOnly; SameSite=Strict` }); res.end(); return;
    }
    observations.push({ url: req.url, method: req.method, headers: req.headers });
    req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('native fixture'); });
  });
  upstream.on('upgrade', (req, socket) => {
    observations.push({ url: req.url, method: req.method, headers: req.headers });
    socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  });
  const track = server => server.on('connection', socket => { peers.add(socket); socket.on('error', () => {}); socket.on('close', () => peers.delete(socket)); });
  track(upstream);
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const serverPath = path.resolve(__dirname, '../../provisioner/hivra-chat/server.js');
  const realRequire = createRequire(serverPath);
  const rejectProcess = () => { throw new Error('No real agent process is allowed in routing fixtures'); };
  const eventHandlers = {};
  vm.runInNewContext(fs.readFileSync(serverPath, 'utf8'), {
    require(name) {
      if (name === 'http') return { ...http, createServer(handler) { gateway = http.createServer(handler); track(gateway); return gateway; } };
      if (name === 'net') return { ...net, connect(port, host, callback) {
        assert.ok([6080, 7681, 7682].includes(port)); return net.connect(upstream.address().port, host, callback);
      } };
      if (name === 'fs') return { readFileSync(filename) {
        if (filename === '/home/bux/.hivra/api-token') return MANAGEMENT;
        if (filename === '/home/bux/.hivra/agent-kind') return 'claude'; // Stale/user-edited marker must not change the owned native service.
        throw Object.assign(new Error('fixture missing'), { code: 'ENOENT' });
      } };
      if (name === 'child_process') return { spawn: rejectProcess, execFile: rejectProcess };
      if (name === 'path') return path;
      if (name === 'crypto') return crypto;
      if (name === './deepseek-harness/gateway-policy.cjs') return { ...policy, loadConfiguration: () => ({ publicOrigin: ORIGIN, runtimeDirectory: '/owned-runtime', home: '/owned-private-home' }) };
      if (name === './deepseek-harness/native-broker.cjs') return { createNativeBroker(options) {
        broker = createNativeBroker({ ...options, upstreamPort: upstream.address().port }); return broker;
      } };
      if (name === './deepseek-harness/runtime-process.cjs') return { async startRuntime(options) { launched = options; return {}; } };
      if (name === './guarded-files.cjs') return { createGuardedFiles: () => ({ read: () => ({ content: 'management-only fixture' }) }) };
      if (name === './llm-application.js' || name === './agent-zero-editor.cjs') return realRequire(name);
      throw new Error(`Unexpected fixture dependency: ${name}`);
    },
    process: { env: { HIVRA_CHAT_PORT: '0', HIVRA_AGENT_KIND: 'deepseek-harness' }, once: (event, callback) => { eventHandlers[event] = callback; }, exit: code => { stopped = code; } },
    __dirname: path.dirname(serverPath), Buffer, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    console: { log() {}, error() {} },
  }, { filename: serverPath, timeout: 2000 });
  t.after(async () => {
    broker.close(); for (const peer of peers) peer.destroy();
    await Promise.all([new Promise(resolve => gateway.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  });
  if (!gateway.listening) await once(gateway, 'listening');
  function request(url, options = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: gateway.address().port, path: url,
        method: options.method || 'GET', headers: { host: HOST, ...options.headers }, agent: false }, res => {
        let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on('error', reject); req.setTimeout(2000, () => req.destroy(new Error('fixture timeout'))); req.end(options.body);
    });
  }
  assert.equal((await request('/healthz')).status, 503);
  assert.equal(JSON.parse((await request('/api/meta')).body).nativeReady, false);
  assert.equal((await request('/')).status, 401);
  assert.equal((await request('/auth/bootstrap', { method: 'POST', headers: { host: 'other.test' }, body: new URLSearchParams({ token: MANAGEMENT, destination: '/' }).toString() })).status, 401);
  const boot = await request('/auth/bootstrap', { method: 'POST', headers: { origin: 'https://dashboard.example.test' }, body: new URLSearchParams({ token: MANAGEMENT, destination: '/' }).toString() });
  assert.equal(boot.status, 303);
  const cookie = boot.headers['set-cookie'][0].split(';')[0];
  const nativeHeaders = { cookie, origin: ORIGIN, 'sec-fetch-site': 'same-origin' };
  for (const [method, url] of [['GET', '/api/file'], ['POST', '/api/file'], ['GET', '/api/model'], ['POST', '/api/chat'], ['GET', '/api/git/diff'], ['DELETE', '/api/skills/x']]) {
    assert.equal((await request(url, { method, headers: nativeHeaders })).status, 401, `${method} ${url}`);
  }
  assert.equal((await request('/api/file', { headers: { authorization: `Bearer ${MANAGEMENT}` } })).status, 200);
  assert.equal((await request('/api/chat', { method: 'POST', headers: { authorization: `Bearer ${MANAGEMENT}` } })).status, 409);
  assert.equal((await request('/api/file', { method: 'OPTIONS', headers: { origin: 'https://dashboard.example.test', 'access-control-request-method': 'GET' } })).status, 204);
  assert.equal((await request('/api/credentials/set', { method: 'OPTIONS' })).status, 401);
  assert.equal(await broker.acceptLaunchLine(`dsh web: http://127.0.0.1:${upstream.address().port}/?token=${launchToken}`), true);
  assert.equal((await request('/healthz')).status, 200);
  assert.equal(JSON.parse((await request('/api/meta')).body).nativeReady, true);
  const root = await request('/', { headers: { cookie, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' } });
  assert.equal(root.status, 200); assert.equal(root.body, 'native fixture');
  assert.equal(root.headers['access-control-allow-origin'], undefined);
  await new Promise((resolve, reject) => {
    const socket = net.connect(gateway.address().port, '127.0.0.1', () => socket.write(
      `GET /terminal/ws HTTP/1.1\r\nHost: ${HOST}\r\nOrigin: ${ORIGIN}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nCookie: backend-session=keep; ${cookie}\r\nAuthorization: Bearer ${MANAGEMENT}\r\n\r\n`));
    let raw = ''; socket.on('data', chunk => { raw += chunk; }); socket.on('error', reject);
    socket.on('close', () => { try { assert.match(raw, /^HTTP\/1\.1 101/); resolve(); } catch (error) { reject(error); } });
  });
  assert.equal(observations.at(-1).url, '/terminal/ws');
  assert.equal(observations.at(-1).headers.cookie, 'backend-session=keep');
  assert.equal(observations.at(-1).headers.authorization, undefined);
  assert.equal((await request('/api/skills/list', { method: 'POST', headers: { ...nativeHeaders, authorization: `Bearer ${MANAGEMENT}` }, body: '{}' })).status, 200);
  assert.equal(observations.at(-1).url, '/api/skills/list');
  assert.equal(observations.at(-1).headers.authorization, undefined);
  assert.notEqual(observations.at(-1).headers.cookie, cookie);
  assert.equal((await request('/api/skills/list', { method: 'POST', headers: { ...nativeHeaders, host: 'wrong.test' } })).status, 403);
  assert.equal((await request('/terminal/', { headers: { ...nativeHeaders, origin: 'https://wrong.test' } })).status, 401);
  assert.equal((await request('/', { headers: { authorization: `Bearer ${MANAGEMENT}` } })).status, 401, 'management bearer does not become native ambient authority');
  assert.equal(launched.runtimeDirectory, '/owned-runtime');
  assert.equal(launched.home, '/owned-private-home');
  assert.equal(launched.signal.aborted, false);
  launched.onUnexpectedExit();
  assert.equal(stopped, 1); assert.equal(launched.signal.aborted, true); assert.equal(broker.ready(), false);
  eventHandlers.SIGTERM(); assert.equal(stopped, 1, 'shutdown is idempotent');
});
