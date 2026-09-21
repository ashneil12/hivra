'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');
const { createHash, randomBytes } = require('node:crypto');
const { createNativeBroker } = require('../../provisioner/deepseek-harness/native-broker.cjs');

const PUBLIC = 'https://computer.example.test';
async function fixture(t, { lifetime = 60000 } = {}) {
  const token = randomBytes(32).toString('base64url');
  const observed = [];
  let revoke = false;
  let rejectNext = false;
  const peers = new Set();
  let cookie;
  const upstream = http.createServer((req, res) => {
    if (req.url === `/?token=${token}`) {
      const now = Date.now();
      const payload = Buffer.from(JSON.stringify({ version: 1, authority: req.headers.host, issuedAt: now, expiresAt: now + lifetime })).toString('base64url');
      cookie = `dsh-auth-${createHash('sha256').update(req.headers.host).digest('base64url')}=v1.${payload}.${randomBytes(32).toString('base64url')}`;
      res.writeHead(303, { location: '/', 'set-cookie': `${cookie}; Path=/; HttpOnly; SameSite=Strict` });
      res.end(); return;
    }
    observed.push({ url: req.url, headers: req.headers, method: req.method });
    if (rejectNext) { rejectNext = false; res.writeHead(401); res.end(); return; }
    assert.equal(req.headers.cookie, cookie);
    if (req.url === '/redirect') { res.writeHead(303, { location: `/?token=${token}` }); res.end(); return; }
    if (req.url === '/plugins/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'set-cookie': cookie });
      res.write('data: hello\n\n'); return;
    }
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': cookie, 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ native: true }));
    });
  });
  upstream.on('connection', socket => { peers.add(socket); socket.on('error', () => {}); socket.on('close', () => peers.delete(socket)); });
  upstream.on('upgrade', (req, socket) => {
    observed.push({ url: req.url, headers: req.headers, method: req.method });
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\nSet-Cookie: ${cookie}\r\n\r\n`);
    socket.on('data', bytes => socket.write(bytes));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const port = upstream.address().port;
  const broker = createNativeBroker({ publicOrigin: PUBLIC, upstreamPort: port, recheckMs: 15,
    authorize: req => !revoke && req.headers.cookie === 'hivra=private' });
  const front = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization');
    broker.handleHttp(req, res);
  });
  front.on('upgrade', broker.handleUpgrade);
  front.listen(0, '127.0.0.1'); await once(front, 'listening');
  t.after(async () => {
    broker.close();
    for (const peer of peers) peer.destroy();
    await Promise.all([new Promise(resolve => front.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  });
  const launch = () => broker.acceptLaunchLine(`dsh web: http://127.0.0.1:${port}/?token=${token}`);
  async function request(path = '/', options = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: front.address().port, path, method: options.method || 'GET',
        headers: { host: 'computer.example.test', cookie: 'hivra=private', 'sec-fetch-site': 'same-origin', ...options.headers } }, res => {
        let body = ''; res.setEncoding('utf8'); res.on('data', data => { body += data; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on('error', reject); req.end(options.body);
    });
  }
  return { broker, front, port, token, observed, launch, request, peers,
    revoke: () => { revoke = true; }, rejectNext: () => { rejectNext = true; } };
}

async function assertNoUpstreamPeers(f) {
  for (let attempt = 0; attempt < 100 && f.peers.size > 0; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(f.peers.size, 0, 'upstream connections must close before fixture cleanup');
}

test('explicit origin configuration and loopback port are required', () => {
  for (const publicOrigin of ['http://computer.test', 'https://computer.test/', 'https://u:p@computer.test']) {
    assert.throws(() => createNativeBroker({ publicOrigin, authorize: () => true }));
  }
  assert.throws(() => createNativeBroker({ publicOrigin: PUBLIC, authorize: () => true, upstreamPort: 0 }));
});

test('only the canonical owned launch line can initialize private authority', async t => {
  const f = await fixture(t);
  for (const line of [
    `dsh web: http://localhost:${f.port}/?token=${f.token}`,
    `dsh web: http://127.0.0.1:${f.port}/?token=${f.token}&extra=1`,
    `dsh web: http://127.0.0.1:${f.port}/?token=${f.token}\n`,
    `dsh web: http://evil.test/?token=${f.token}`, 'x'.repeat(257),
  ]) assert.equal(await f.broker.acceptLaunchLine(line), false);
  assert.equal((await f.request()).status, 503);
  assert.equal(await f.launch(), true);
  assert.equal(await f.launch(), false);
  const response = await f.request();
  assert.equal(response.status, 200);
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.equal(response.headers['access-control-allow-headers'], undefined);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(JSON.stringify(response).includes(f.token), false);
});

test('gates ALL native paths, original authority and mutation Origin before forwarding', async t => {
  const f = await fixture(t); await f.launch();
  for (const path of ['/', '/plugins/events', '/assets/index.js', '/api/settings/get']) {
    assert.equal((await f.request(path, { headers: { cookie: '' } })).status, 401);
    assert.equal((await f.request(path, { headers: { host: 'other.example.test', origin: 'https://other.example.test' } })).status, 403);
    assert.equal((await f.request(path, { headers: { origin: 'null' } })).status, 403);
    assert.equal((await f.request(path, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  }
  assert.equal((await f.request('/api/settings/set', { method: 'POST' })).status, 403);
  assert.equal((await f.request('/api/settings/set', { method: 'POST', headers: { origin: `${PUBLIC}/` } })).status, 403);
  assert.equal((await f.request('/?token=secret')).status, 400);
  assert.equal(f.observed.length, 0);
});

test('authenticated bootstrap document navigation is allowed, not API navigation', async t => {
  const f = await fixture(t); await f.launch();
  const headers = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' };
  assert.equal((await f.request('/', { headers })).status, 200);
  assert.equal((await f.request('/api/settings/get', { headers })).status, 403);
  assert.equal((await f.request('/', { headers: { ...headers, origin: 'https://attacker.test' } })).status, 403);
});

test('strips user credentials, forwarding and nominated headers; uses only private upstream authority', async t => {
  const f = await fixture(t); await f.launch();
  const response = await f.request('/api/settings/set', { method: 'POST', body: '{}', headers: {
    origin: PUBLIC, authorization: 'Bearer Hivra-management-secret', forwarded: 'host=attacker',
    'x-forwarded-host': 'attacker', 'x-forwarded-for': 'attacker', 'x-private-key': 'secret',
    connection: 'accept-language', 'accept-language': 'private', 'content-type': 'application/json',
  } });
  assert.equal(response.status, 200);
  const headers = f.observed[0].headers;
  for (const key of ['authorization', 'forwarded', 'x-forwarded-host', 'x-forwarded-for', 'x-private-key', 'accept-language']) assert.equal(headers[key], undefined);
  assert.equal(headers.host, `127.0.0.1:${f.port}`);
  assert.equal(headers.origin, `http://127.0.0.1:${f.port}`);
  assert.match(headers.cookie, /^dsh-auth-/);
  assert.equal(headers.cookie.includes('hivra='), false);
});

test('native authority failure clears readiness and never replays the request', async t => {
  const f = await fixture(t); await f.launch(); f.rejectNext();
  assert.equal((await f.request('/api/settings/set', { method: 'POST', body: '{}', headers: { origin: PUBLIC } })).status, 503);
  assert.equal(f.observed.length, 1);
  assert.equal(f.broker.ready(), false);
  assert.equal((await f.request()).status, 503);
  assert.equal(await f.launch(), true); // Explicit owner action, not request replay.
});

test('native token redirects are not exposed', async t => {
  const f = await fixture(t); await f.launch();
  const response = await f.request('/redirect');
  assert.equal(response.status, 502);
  assert.equal(response.headers.location, undefined);
  assert.equal(JSON.stringify(response).includes(f.token), false);
});

test('SSE streams incrementally and revocation closes both connections', async t => {
  const f = await fixture(t); await f.launch();
  const response = await new Promise(resolve => http.get({ hostname: '127.0.0.1', port: f.front.address().port, path: '/plugins/events',
    headers: { host: 'computer.example.test', cookie: 'hivra=private' } }, resolve));
  assert.equal(response.headers['set-cookie'], undefined);
  const [bytes] = await once(response, 'data');
  assert.equal(bytes.toString(), 'data: hello\n\n');
  const disconnected = new Promise(resolve => response.once('close', resolve));
  response.on('error', () => {});
  f.revoke();
  await disconnected;
  await assertNoUpstreamPeers(f);
});

test('upstream cookie expiry closes an already streaming response', async t => {
  const f = await fixture(t, { lifetime: 100 }); await f.launch();
  const response = await new Promise(resolve => http.get({ hostname: '127.0.0.1', port: f.front.address().port, path: '/plugins/events',
    headers: { host: 'computer.example.test', cookie: 'hivra=private' } }, resolve));
  response.resume(); response.on('error', () => {});
  await new Promise(resolve => response.once('close', resolve));
  assert.equal(f.broker.ready(), false);
  assert.equal(await f.launch(), false);
  f.broker.reset();
  assert.equal(await f.launch(), true);
  await assertNoUpstreamPeers(f);
});

test('WebSocket upgrades strip authority and remain owned through revocation', async t => {
  const f = await fixture(t); await f.launch();
  const client = net.connect(f.front.address().port, '127.0.0.1');
  t.after(() => client.destroy());
  await once(client, 'connect');
  client.write(`GET /api/remote.mux HTTP/1.1\r\nHost: computer.example.test\r\nOrigin: ${PUBLIC}\r\nCookie: hivra=private\r\nAuthorization: Bearer forbidden\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`);
  const [handshake] = await once(client, 'data');
  assert.match(handshake.toString(), /^HTTP\/1.1 101/);
  assert.doesNotMatch(handshake.toString(), /set-cookie|dsh-auth/i);
  assert.equal(f.observed[0].headers.authorization, undefined);
  client.write('stream-proof');
  const [echo] = await once(client, 'data'); assert.equal(echo.toString(), 'stream-proof');
  const disconnected = once(client, 'close');
  f.revoke(); await disconnected;
  await assertNoUpstreamPeers(f);
});

test('wrong-origin WebSocket never reaches upstream', async t => {
  const f = await fixture(t); await f.launch();
  const client = net.connect(f.front.address().port, '127.0.0.1');
  t.after(() => client.destroy()); await once(client, 'connect');
  client.write(`GET /api/remote.mux HTTP/1.1\r\nHost: computer.example.test\r\nOrigin: https://other.test\r\nCookie: hivra=private\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`);
  const [reply] = await once(client, 'data'); assert.match(reply.toString(), /^HTTP\/1.1 403/);
  assert.equal(f.observed.length, 0);
});

test('close forbids reinitialization and is idempotent', async t => {
  const f = await fixture(t); await f.launch();
  f.broker.close(); f.broker.close();
  assert.equal(f.broker.ready(), false);
  assert.equal(await f.launch(), false);
});

test('rejected half-open WebSocket cannot pin a socket past broker teardown', async t => {
  const f = await fixture(t); await f.launch();
  const client = net.connect({ port: f.front.address().port, host: '127.0.0.1', allowHalfOpen: true });
  t.after(() => client.destroy()); await once(client, 'connect');
  client.write('GET /api/remote.mux HTTP/1.1\r\nHost: computer.example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  const [reply] = await once(client, 'data'); assert.match(reply.toString(), /^HTTP\/1.1 401/);
  f.broker.close();
  await new Promise(resolve => setImmediate(resolve));
  const remaining = await new Promise((resolve, reject) => f.front.getConnections((error, count) => error ? reject(error) : resolve(count)));
  assert.equal(remaining, 0);
});
