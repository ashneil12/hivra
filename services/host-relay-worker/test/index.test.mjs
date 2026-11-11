import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';

const SECRET = 'test-relay-secret-with-at-least-32-characters';
const HOST_A = '11111111-1111-4111-8111-111111111111';
const HOST_B = '22222222-2222-4222-8222-222222222222';
const BASE = 'https://relay.example.test';

// The formulas are restated with node:crypto on purpose: Hivra's control plane
// and the Python connector derive the same values independently.
const hmacHex = (key, message) => createHmac('sha256', key).update(message).digest('hex');
const b64url = (buffer) => Buffer.from(buffer).toString('base64url');
const connectorSecret = (id, generation) => hmacHex(SECRET, `connector|${id}|${generation}`);
const adminToken = () => hmacHex(SECRET, 'admin|v1');
const now = () => Math.floor(Date.now() / 1000);

function ticket(aud, { exp = now() + 60, jti = b64url(randomBytes(18)) } = {}) {
  const body = b64url(JSON.stringify({ aud, exp, jti }));
  const key = hmacHex(SECRET, 'client-ticket|v1');
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}

function connectorHeaders(kind, id, { stream = '', generation = 1, timestamp = now(), secret } = {}) {
  const key = secret ?? connectorSecret(id, generation);
  return {
    upgrade: 'websocket',
    'x-hivra-generation': String(generation),
    'x-hivra-timestamp': String(timestamp),
    'x-hivra-signature': hmacHex(key, `${kind}|${id}|${stream}|${timestamp}`),
  };
}

async function relay(t, bindings = { HOST_RELAY_SECRET: SECRET }) {
  const config = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const compatibilityDate = config.match(/^compatibility_date\s*=\s*"([\d-]+)"/m)[1];
  const options = convertV4MiniflareOptions({
    name: 'host-relay',
    modules: true,
    script: readFileSync(new URL('../dist/index.js', import.meta.url), 'utf8'),
    compatibilityDate,
    cf: false,
    bindings,
    durableObjects: { HOST_RELAY: { className: 'HostRelay', useSQLite: true } },
    log: new Log(LogLevel.NONE),
  });
  const mf = new Miniflare({ ...options, telemetry: { enabled: false } });
  t.after(() => mf.dispose());
  await mf.ready;
  return mf;
}

function open(response) {
  assert.equal(response.status, 101, `expected an upgrade, got ${response.status}`);
  const socket = response.webSocket;
  socket.accept();
  const messages = [];
  const waiters = [];
  let closed = null;
  socket.addEventListener('message', (event) => {
    messages.push(event.data);
    for (const waiter of waiters.splice(0)) waiter();
  });
  socket.addEventListener('close', (event) => {
    closed = { code: event.code, reason: event.reason };
    for (const waiter of waiters.splice(0)) waiter();
  });
  const until = async (check, label) => {
    const deadline = Date.now() + 5000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((resolve) => { waiters.push(resolve); setTimeout(resolve, 50); });
    }
  };
  let cursor = 0;
  return {
    socket,
    messages,
    get closed() { return closed; },
    // Read messages in order, including any that arrived before the call.
    async next(label = 'a message') {
      await until(() => messages.length > cursor, label);
      return messages[cursor++];
    },
    waitClosed: () => until(() => closed !== null, 'close'),
  };
}

const text = (data) => (typeof data === 'string' ? data : new TextDecoder().decode(data));

async function agent(mf, id = HOST_A, options = {}) {
  return open(await mf.dispatchFetch(`${BASE}/v1/hosts/${id}/agent`, { headers: connectorHeaders('agent', id, options) }));
}

test('keeps the Worker toolchain on the reviewed security floor', () => {
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(lock.packages['node_modules/sharp']?.version, '0.35.4');
  assert.equal(lock.packages['node_modules/miniflare']?.version, '5.20260918.0-alpha');
  assert.equal(lock.packages['node_modules/wrangler']?.version, '4.135.0');
});

test('fails closed without a strong secret', async (t) => {
  const mf = await relay(t, { HOST_RELAY_SECRET: 'short' });
  const health = await mf.dispatchFetch(`${BASE}/health`);
  assert.deepEqual(await health.json(), { ok: true, configured: false });
  const refused = await mf.dispatchFetch(`${BASE}/v1/hosts/${HOST_A}/agent`, { headers: connectorHeaders('agent', HOST_A) });
  assert.equal(refused.status, 503);
});

test('admits a connector only with a fresh signature from its own derived secret', async (t) => {
  const mf = await relay(t);
  const url = `${BASE}/v1/hosts/${HOST_A}/agent`;
  for (const headers of [
    connectorHeaders('agent', HOST_A, { secret: connectorSecret(HOST_B, 1) }),
    connectorHeaders('agent', HOST_A, { timestamp: now() - 600 }),
    { ...connectorHeaders('agent', HOST_A), 'x-hivra-signature': 'f'.repeat(64) },
    { upgrade: 'websocket' },
  ]) {
    assert.equal((await mf.dispatchFetch(url, { headers })).status, 401);
  }
  assert.equal((await mf.dispatchFetch(url)).status, 426);
  assert.equal((await mf.dispatchFetch(`${BASE}/v1/hosts/not-a-uuid/agent`, { headers: connectorHeaders('agent', HOST_A) })).status, 404);
  await agent(mf);
});

test('reports an offline machine before upgrading the client', async (t) => {
  const mf = await relay(t);
  const response = await mf.dispatchFetch(`${BASE}/v1/hosts/${HOST_A}/client`, {
    headers: { upgrade: 'websocket', authorization: `Bearer ${ticket(HOST_A)}` },
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'host_offline' });
});

test('pairs a client with the machine and copies bytes both ways, holding early client bytes', async (t) => {
  const mf = await relay(t);
  const control = await agent(mf);
  const client = open(await mf.dispatchFetch(`${BASE}/v1/hosts/${HOST_A}/client`, {
    headers: { upgrade: 'websocket', authorization: `Bearer ${ticket(HOST_A)}` },
  }));
  // SSH clients speak first; these bytes arrive before the machine joins.
  client.socket.send(new TextEncoder().encode('SSH-2.0-hivra\r\n'));
  const request = JSON.parse(await control.next('an open request'));
  assert.equal(request.type, 'open');
  assert.match(request.stream, /^[A-Za-z0-9_-]{16,64}$/);
  const stream = open(await mf.dispatchFetch(`${BASE}/v1/hosts/${HOST_A}/stream/${request.stream}`, {
    headers: connectorHeaders('stream', HOST_A, { stream: request.stream }),
  }));
  assert.equal(text(await stream.next('held client bytes')), 'SSH-2.0-hivra\r\n');
  stream.socket.send(new TextEncoder().encode('SSH-2.0-OpenSSH_9.6\r\n'));
  assert.equal(text(await client.next('host bytes')), 'SSH-2.0-OpenSSH_9.6\r\n');
  client.socket.send('more');
  assert.equal(text(await stream.next('more bytes')), 'more');

  // A second attach for the same stream is refused.
  const again = await mf.dispatchFetch(`${BASE}/v1/hosts/${HOST_A}/stream/${request.stream}`, {
    headers: connectorHeaders('stream', HOST_A, { stream: request.stream }),
  });
  assert.equal(again.status, 409);

  client.socket.close(1000, 'done');
  await stream.waitClosed();
});

test('rejects replayed, expired, long-lived, and foreign client tickets', async (t) => {
  const mf = await relay(t);
  await agent(mf);
  const url = `${BASE}/v1/hosts/${HOST_A}/client`;
  const reused = ticket(HOST_A);
  const first = await mf.dispatchFetch(url, { headers: { upgrade: 'websocket', authorization: `Bearer ${reused}` } });
  open(first);
  for (const value of [
    reused,
    ticket(HOST_A, { exp: now() - 1 }),
    ticket(HOST_A, { exp: now() + 3600 }),
    ticket(HOST_B),
    `${ticket(HOST_A).split('.')[0]}.${b64url(randomBytes(32))}`,
  ]) {
    const response = await mf.dispatchFetch(url, { headers: { upgrade: 'websocket', authorization: `Bearer ${value}` } });
    assert.equal(response.status, 401);
  }
});

test('never lets one connection attach to another connection\'s stream', async (t) => {
  const mf = await relay(t);
  const control = await agent(mf, HOST_A);
  await agent(mf, HOST_B);
  open(await mf.dispatchFetch(`${BASE}/v1/hosts/${HOST_A}/client`, {
    headers: { upgrade: 'websocket', authorization: `Bearer ${ticket(HOST_A)}` },
  }));
  const { stream } = JSON.parse(await control.next());
  // Host B's valid credentials, aimed at host A's stream id, reach host B's relay.
  const crossed = await mf.dispatchFetch(`${BASE}/v1/hosts/${HOST_B}/stream/${stream}`, {
    headers: connectorHeaders('stream', HOST_B, { stream }),
  });
  assert.equal(crossed.status, 404);
  // Host B's secret against host A's relay fails authentication.
  const forged = await mf.dispatchFetch(`${BASE}/v1/hosts/${HOST_A}/stream/${stream}`, {
    headers: connectorHeaders('stream', HOST_A, { stream, secret: connectorSecret(HOST_B, 1) }),
  });
  assert.equal(forged.status, 401);
});

test('revocation closes the old connector and refuses its generation afterwards', async (t) => {
  const mf = await relay(t);
  const control = await agent(mf);
  const url = `${BASE}/v1/hosts/${HOST_A}/revoke`;
  const denied = await mf.dispatchFetch(url, { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' }, body: '{"minGeneration":2}' });
  assert.equal(denied.status, 401);
  const revoked = await mf.dispatchFetch(url, { method: 'POST', headers: { authorization: `Bearer ${adminToken()}`, 'content-type': 'application/json' }, body: '{"minGeneration":2}' });
  assert.deepEqual(await revoked.json(), { minGeneration: 2 });
  assert.deepEqual(JSON.parse(await control.next('the revocation notice')), { type: 'closing', reason: 'revoked' });
  assert.equal((await mf.dispatchFetch(`${BASE}/v1/hosts/${HOST_A}/agent`, { headers: connectorHeaders('agent', HOST_A, { generation: 1 }) })).status, 401);
  await agent(mf, HOST_A, { generation: 2 });
});

test('a reconnecting connector replaces the old control socket', async (t) => {
  const mf = await relay(t);
  const first = await agent(mf);
  const second = await agent(mf);
  assert.deepEqual(JSON.parse(await first.next('the replacement notice')), { type: 'closing', reason: 'replaced' });
  open(await mf.dispatchFetch(`${BASE}/v1/hosts/${HOST_A}/client`, {
    headers: { upgrade: 'websocket', authorization: `Bearer ${ticket(HOST_A)}` },
  }));
  assert.equal(JSON.parse(await second.next()).type, 'open');
});

test('limits concurrent sessions per machine', async (t) => {
  const mf = await relay(t);
  await agent(mf);
  const url = `${BASE}/v1/hosts/${HOST_A}/client`;
  for (let index = 0; index < 8; index += 1) {
    open(await mf.dispatchFetch(url, { headers: { upgrade: 'websocket', authorization: `Bearer ${ticket(HOST_A)}` } }));
  }
  const ninth = await mf.dispatchFetch(url, { headers: { upgrade: 'websocket', authorization: `Bearer ${ticket(HOST_A)}` } });
  assert.equal(ninth.status, 429);
});

test('closes a client whose machine never joins', { timeout: 20_000 }, async (t) => {
  const mf = await relay(t);
  await agent(mf);
  const client = open(await mf.dispatchFetch(`${BASE}/v1/hosts/${HOST_A}/client`, {
    headers: { upgrade: 'websocket', authorization: `Bearer ${ticket(HOST_A)}` },
  }));
  const deadline = Date.now() + 15_000;
  while (!client.closed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(client.closed?.code, 4504);
});

test('reports whether the machine is connected, to the control plane only', async (t) => {
  const mf = await relay(t);
  const url = `${BASE}/v1/hosts/${HOST_A}/status`;
  assert.equal((await mf.dispatchFetch(url)).status, 401);
  const offline = await mf.dispatchFetch(url, { headers: { authorization: `Bearer ${adminToken()}` } });
  assert.deepEqual(await offline.json(), { online: false, generation: null, minGeneration: 1, sessions: 0 });
  await agent(mf, HOST_A, { generation: 3 });
  const online = await mf.dispatchFetch(url, { headers: { authorization: `Bearer ${adminToken()}` } });
  assert.deepEqual(await online.json(), { online: true, generation: 3, minGeneration: 1, sessions: 0 });
});

const execCall = (mf, body, token = adminToken()) => mf.dispatchFetch(`${BASE}/v1/hosts/${HOST_A}/exec`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('local bridge: forwards one exec to the machine and returns its answer, control plane only', async (t) => {
  const mf = await relay(t);
  const body = { ticket: 'ticket.value', request: { argv: ['uname', '-s'], timeoutSeconds: 5 } };
  assert.equal((await execCall(mf, body, 'nope')).status, 401);
  assert.equal((await mf.dispatchFetch(`${BASE}/v1/hosts/${HOST_A}/exec`)).status, 405);
  const offline = await execCall(mf, body);
  assert.equal(offline.status, 503);
  assert.deepEqual(await offline.json(), { error: 'host_offline' });

  const control = await agent(mf);
  assert.equal((await execCall(mf, { ticket: 3 })).status, 400);
  const pending = execCall(mf, body);
  const sent = JSON.parse(await control.next('the exec request'));
  assert.equal(sent.type, 'exec');
  assert.equal(sent.ticket, 'ticket.value');
  assert.deepEqual(sent.request, body.request);
  // A second command while one is running is refused.
  assert.equal((await execCall(mf, body)).status, 429);
  // An answer with the wrong id is ignored; the right one settles the call.
  control.socket.send(JSON.stringify({ type: 'exec_result', id: 'other', ok: true, stdout: 'nope' }));
  control.socket.send(JSON.stringify({ type: 'exec_result', id: sent.id, ok: true, stdout: 'Darwin\n', stderr: '', exitCode: 0, truncated: false, durationMs: 3 }));
  const answer = await pending;
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { ok: true, stdout: 'Darwin\n', stderr: '', exitCode: 0, truncated: false, durationMs: 3 });
});

test('local bridge: a revoked connector ends the pending exec', async (t) => {
  const mf = await relay(t);
  const control = await agent(mf);
  const pending = execCall(mf, { ticket: 'ticket.value', request: { argv: ['sleep', '5'], timeoutSeconds: 60 } });
  await control.next('the exec request');
  await mf.dispatchFetch(`${BASE}/v1/hosts/${HOST_A}/revoke`, {
    method: 'POST', headers: { authorization: `Bearer ${adminToken()}`, 'content-type': 'application/json' }, body: '{"minGeneration":2}',
  });
  assert.equal((await pending).status, 504);
});
