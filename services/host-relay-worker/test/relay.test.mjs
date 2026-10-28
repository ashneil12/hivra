// SEC-09: the client-ticket jti check-and-set used to be two separate storage
// awaits, so two concurrent WebSocket upgrades presenting the same ticket
// could both pass `storage.get(replayKey)` before either `put` landed. The
// consumption now runs inside blockConcurrencyWhile; this test fires both
// upgrades at once and requires exactly one 101 and one 401.
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';

const SECRET = 'test-relay-secret-with-at-least-32-characters';
const HOST_A = '11111111-1111-4111-8111-111111111111';
const BASE = 'https://relay.example.test';

// The formulas are restated with node:crypto on purpose: Hivra's control plane
// and the Python connector derive the same values independently.
const hmacHex = (key, message) => createHmac('sha256', key).update(message).digest('hex');
const b64url = (buffer) => Buffer.from(buffer).toString('base64url');
const connectorSecret = (id, generation) => hmacHex(SECRET, `connector|${id}|${generation}`);
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
    async next(label = 'a message') {
      await until(() => messages.length > cursor, label);
      return messages[cursor++];
    },
    waitClosed: () => until(() => closed !== null, 'close'),
  };
}

async function agent(mf, id = HOST_A, options = {}) {
  return open(await mf.dispatchFetch(`${BASE}/v1/hosts/${id}/agent`, { headers: connectorHeaders('agent', id, options) }));
}

test('two concurrent client upgrades bearing the same jti cannot both connect', async (t) => {
  const mf = await relay(t);
  await agent(mf);
  const url = `${BASE}/v1/hosts/${HOST_A}/client`;
  const same = ticket(HOST_A);
  const headers = { upgrade: 'websocket', authorization: `Bearer ${same}` };
  const [first, second] = await Promise.all([
    mf.dispatchFetch(url, { headers }),
    mf.dispatchFetch(url, { headers }),
  ]);
  assert.deepEqual([first.status, second.status].sort((a, b) => a - b), [101, 401]);
  open(first.status === 101 ? first : second);
  // The ticket is spent for good: a later retry is refused as well.
  const retry = await mf.dispatchFetch(url, { headers });
  assert.equal(retry.status, 401);
});
