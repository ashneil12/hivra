'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');
const { createHash, randomBytes } = require('node:crypto');
const { createNativeBroker } = require('../../provisioner/deepseek-harness/native-broker.cjs');

const PUBLIC = 'https://computer.example.test';
const HOUR = 3600000;
const DAY = 24 * HOUR;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

// Fake upstream modelled on dsh browser-auth: one launch token for the process
// lifetime, every exchange mints a fresh signed cookie, and a minted cookie
// authenticates only while issuedAt <= now < expiresAt (anything else gets 401),
// as dsh's BrowserAuth.isAuthenticated does.
async function fixture(t, { lifetime = 60000, broker: brokerOptions = {} } = {}) {
  const token = randomBytes(32).toString('base64url');
  const observed = [];
  const diagnostics = [];
  const minted = new Map();
  const parked = [];
  let revoke = false;
  let rejectNext = false;
  let exchanges = 0;
  let exchangeMode = 'mint';
  let exchangeFailures = Infinity;
  const peers = new Set();
  let cookie;
  const upstream = http.createServer((req, res) => {
    if (req.url === `/?token=${token}`) {
      exchanges += 1;
      if (exchangeMode !== 'mint' && exchangeFailures > 0) {
        exchangeFailures -= 1;
        if (exchangeMode === 'drop') { req.socket.destroy(); return; }
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('dsh web authentication required; reopen the URL printed by dsh web.\n'); return;
      }
      const now = Date.now();
      const payload = Buffer.from(JSON.stringify({ version: 1, authority: req.headers.host, issuedAt: now, expiresAt: now + lifetime })).toString('base64url');
      cookie = `dsh-auth-${createHash('sha256').update(req.headers.host).digest('base64url')}=v1.${payload}.${randomBytes(32).toString('base64url')}`;
      minted.set(cookie, { issuedAt: now, expiresAt: now + lifetime });
      res.writeHead(303, { location: '/', 'set-cookie': `${cookie}; Path=/; HttpOnly; SameSite=Strict` });
      res.end(); return;
    }
    observed.push({ url: req.url, headers: req.headers, method: req.method });
    if (rejectNext) { rejectNext = false; res.writeHead(401); res.end(); return; }
    const session = minted.get(req.headers.cookie);
    if (!session || session.issuedAt > Date.now() || session.expiresAt <= Date.now()) { res.writeHead(401); res.end(); return; }
    if (req.url === '/redirect') { res.writeHead(303, { location: `/?token=${token}` }); res.end(); return; }
    if (req.url === '/park') { parked.push(res); return; }
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
    authorize: req => !revoke && req.headers.cookie === 'hivra=private',
    onDiagnostic: code => diagnostics.push(code), ...brokerOptions });
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
  function stream(path = '/plugins/events') {
    return new Promise(resolve => http.get({ hostname: '127.0.0.1', port: front.address().port, path,
      headers: { host: 'computer.example.test', cookie: 'hivra=private' } }, resolve));
  }
  async function until(condition, message = 'condition was not reached') {
    for (let attempt = 0; attempt < 300 && !condition(); attempt++) await delay(10);
    assert.ok(condition(), message);
  }
  // Bearer material must never appear in a diagnostic.
  function assertDiagnosticsSecretFree() {
    const text = JSON.stringify(diagnostics);
    assert.equal(text.includes(token), false);
    for (const value of minted.keys()) assert.equal(text.includes(value.split('=')[1]), false);
  }
  return { broker, front, port, token, observed, diagnostics, parked, launch, request, stream, until, peers,
    assertDiagnosticsSecretFree, exchanges: () => exchanges,
    failExchanges: (mode, count = Infinity) => { exchangeMode = mode; exchangeFailures = count; },
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

test('an upstream 401 is never replayed and renews private authority exactly once', async t => {
  const f = await fixture(t); await f.launch(); f.rejectNext();
  assert.equal((await f.request('/api/settings/set', { method: 'POST', body: '{}', headers: { origin: PUBLIC } })).status, 503);
  assert.equal(f.observed.length, 1);
  // The retained launch token restores readiness without a unit restart.
  await f.until(() => f.broker.ready(), 'broker did not re-exchange after the upstream 401');
  await delay(100);
  assert.equal(f.exchanges(), 2);
  const response = await f.request('/api/settings/get');
  assert.equal(response.status, 200);
  assert.equal(f.observed.length, 2);
  assert.equal(f.observed[0].method, 'POST', 'the rejected mutation is not replayed');
  assert.notEqual(f.observed[1].headers.cookie, f.observed[0].headers.cookie);
  assert.equal(JSON.stringify(response).includes(f.token), false);
  assert.equal(await f.launch(), false, 'stdout cannot reinitialize live authority');
  assert.deepEqual(f.diagnostics, ['upstream_unauthorized', 'renewed']);
  f.assertDiagnosticsSecretFree();
});

test('a refused re-exchange fails closed after one attempt until the owner resets', async t => {
  const f = await fixture(t); await f.launch();
  f.failExchanges('refuse'); f.rejectNext();
  assert.equal((await f.request()).status, 503);
  await f.until(() => f.diagnostics.includes('renewal_refused'));
  await delay(100);
  assert.equal(f.exchanges(), 2, 'one launch exchange plus exactly one renewal attempt');
  assert.equal(f.broker.ready(), false);
  assert.equal((await f.request()).status, 503);
  assert.equal(f.observed.length, 1);
  f.failExchanges('mint', 0);
  f.broker.reset();
  assert.equal(await f.launch(), true); // Explicit owner action, not request replay.
  assert.equal((await f.request()).status, 200);
  f.assertDiagnosticsSecretFree();
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
  const response = await f.stream();
  assert.equal(response.headers['set-cookie'], undefined);
  const [bytes] = await once(response, 'data');
  assert.equal(bytes.toString(), 'data: hello\n\n');
  const disconnected = new Promise(resolve => response.once('close', resolve));
  response.on('error', () => {});
  f.revoke();
  await disconnected;
  await assertNoUpstreamPeers(f);
});

test('short-lived upstream cookies are renewed before expiry without dropping a live stream', async t => {
  const f = await fixture(t, { lifetime: 300 }); await f.launch();
  const response = await f.stream();
  const [bytes] = await once(response, 'data');
  assert.equal(bytes.toString(), 'data: hello\n\n');
  let dropped = false;
  response.on('close', () => { dropped = true; }); response.on('error', () => {});
  await delay(1000); // More than three cookie lifetimes.
  assert.equal(dropped, false, 'renewal must not interrupt a live stream');
  assert.equal(f.broker.ready(), true);
  assert.ok(f.exchanges() >= 4, `expected repeated renewal, saw ${f.exchanges()} exchanges`);
  assert.equal((await f.request('/api/settings/get')).status, 200);
  assert.ok(f.diagnostics.length > 0 && f.diagnostics.every(code => code === 'renewed'));
  f.assertDiagnosticsSecretFree();
  response.destroy();
});

test('a 30-day upstream cookie is renewed inside its last day, not before', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await fixture(t, { lifetime: 30 * DAY }); await f.launch();
  t.mock.timers.tick(29 * DAY - HOUR); // 25 hours remain.
  await delay(100);
  assert.equal(f.exchanges(), 1);
  t.mock.timers.tick(2 * HOUR); // 23 hours remain.
  await f.until(() => f.exchanges() === 2, 'broker did not renew inside the last day');
  await f.until(() => f.diagnostics.includes('renewed'));
  assert.equal(f.broker.ready(), true);
  t.mock.timers.tick(23 * HOUR + 1); // The first cookie has now expired.
  assert.equal((await f.request()).status, 200);
  assert.equal(f.exchanges(), 2);
});

// The README's live renewal check skews the guest clock into the cookie's last
// day, then restores it. Model exactly what that check must observe.
test('the operator clock-skew check sees renewed, then one 503 with upstream_unauthorized and renewed', async t => {
  const start = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const f = await fixture(t, { lifetime: 30 * DAY }); await f.launch();
  t.mock.timers.setTime(start + 29 * DAY + 12 * HOUR);
  await f.until(() => f.diagnostics.includes('renewed'), 'no proactive renewal inside the last day');
  assert.equal(f.broker.ready(), true, 'readiness never lapses before expiry');
  assert.equal((await f.request()).status, 200);
  // Clock restored: the renewed cookie now has a future issuedAt. Only upstream
  // can tell, and it refuses the cookie on the next native request.
  t.mock.timers.setTime(start + 1000);
  assert.equal(f.broker.ready(), true);
  const observedBefore = f.observed.length;
  assert.equal((await f.request()).status, 503);
  await f.until(() => f.diagnostics.length === 3, 'no re-exchange after the upstream 401');
  assert.deepEqual(f.diagnostics, ['renewed', 'upstream_unauthorized', 'renewed']);
  assert.equal((await f.request()).status, 200);
  assert.equal(f.observed.length, observedBefore + 2, 'the rejected request is not replayed');
  assert.equal(f.exchanges(), 3);
  f.assertDiagnosticsSecretFree();
});

test('a renewal retry is not postponed when the guest clock steps backwards', async t => {
  const start = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const f = await fixture(t, { lifetime: 30 * DAY, broker: { renewRetryMs: 50 } }); await f.launch();
  t.mock.timers.setTime(start + 29 * DAY + 12 * HOUR);
  await f.until(() => f.diagnostics.includes('renewed'));
  f.failExchanges('drop', 1); f.rejectNext();
  assert.equal((await f.request()).status, 503);
  await f.until(() => f.diagnostics.includes('renewal_failed'));
  // NTP (or the operator check) steps the clock back while no cookie is held.
  t.mock.timers.setTime(start + 1000);
  await f.until(() => f.diagnostics.at(-1) === 'renewed', 'the retry waited for the wall clock to catch up');
  assert.deepEqual(f.diagnostics, ['renewed', 'upstream_unauthorized', 'renewal_failed', 'renewed']);
  assert.equal((await f.request()).status, 200);
});

test('a transient renewal failure retries on the bounded schedule', async t => {
  const f = await fixture(t, { lifetime: 400, broker: { renewRetryMs: 50 } }); await f.launch();
  f.failExchanges('drop', 1);
  const response = await f.stream();
  let dropped = false;
  response.resume(); response.on('close', () => { dropped = true; }); response.on('error', () => {});
  await f.until(() => f.diagnostics.includes('renewed'), 'renewal was not retried');
  assert.deepEqual(f.diagnostics.slice(0, 2), ['renewal_failed', 'renewed']);
  assert.equal(dropped, false);
  assert.equal(f.broker.ready(), true);
  response.destroy();
});

test('a 401 for a superseded cookie does not discard renewed authority', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await fixture(t, { lifetime: 30 * DAY }); await f.launch();
  const stale = f.request('/park');
  await f.until(() => f.parked.length === 1);
  t.mock.timers.tick(29 * DAY + HOUR);
  await f.until(() => f.diagnostics.includes('renewed'));
  f.parked[0].writeHead(401); f.parked[0].end();
  assert.equal((await stale).status, 503, 'the rejected request is still not replayed');
  await delay(100);
  assert.equal(f.exchanges(), 2);
  assert.equal(f.broker.ready(), true);
  assert.equal(f.diagnostics.includes('upstream_unauthorized'), false);
  assert.equal((await f.request()).status, 200);
});

test('when renewal is refused, cookie expiry still closes an already streaming response', async t => {
  const f = await fixture(t, { lifetime: 300 }); await f.launch();
  f.failExchanges('refuse');
  const response = await f.stream();
  response.resume(); response.on('error', () => {});
  await new Promise(resolve => response.once('close', resolve));
  assert.equal(f.broker.ready(), false);
  assert.deepEqual(f.diagnostics, ['renewal_refused']);
  assert.equal(await f.launch(), false);
  f.broker.reset(); f.failExchanges('mint', 0);
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
