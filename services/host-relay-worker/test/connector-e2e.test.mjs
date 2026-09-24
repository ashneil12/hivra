// End to end on one machine: the real Python connector, the bundled relay in
// workerd, and a local TCP server standing in for sshd. A WebSocket client
// with a Hivra ticket must reach that server's bytes through the relay, and a
// revocation must stop the connector for good (exit status 3).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import WebSocket from 'ws';

const SECRET = 'test-relay-secret-with-at-least-32-characters';
const HOST = '33333333-3333-4333-8333-333333333333';
const CONNECTOR = fileURLToPath(new URL('../../host-connector/hivra_connector.py', import.meta.url));
const hmacHex = (key, message) => createHmac('sha256', key).update(message).digest('hex');
const python = spawnSync('python3', ['--version']).status === 0;

function ticket() {
  const body = Buffer.from(JSON.stringify({ aud: HOST, exp: Math.floor(Date.now() / 1000) + 60, jti: randomBytes(18).toString('base64url') })).toString('base64url');
  return `${body}.${createHmac('sha256', hmacHex(SECRET, 'client-ticket|v1')).update(body).digest('base64url')}`;
}

async function until(check, label, ms = 10_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

test('a client reaches the machine\'s local SSH port through the real connector, and revocation stops it', { skip: !python && 'python3 is not installed', timeout: 60_000 }, async (t) => {
  const config = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const mf = new Miniflare({
    ...convertV4MiniflareOptions({
      name: 'host-relay-e2e',
      modules: true,
      script: readFileSync(new URL('../dist/index.js', import.meta.url), 'utf8'),
      compatibilityDate: config.match(/^compatibility_date\s*=\s*"([\d-]+)"/m)[1],
      cf: false,
      host: '127.0.0.1',
      port: 0,
      bindings: { HOST_RELAY_SECRET: SECRET },
      durableObjects: { HOST_RELAY: { className: 'HostRelay', useSQLite: true } },
      log: new Log(LogLevel.NONE),
    }),
    telemetry: { enabled: false },
  });
  t.after(() => mf.dispose());
  const relayUrl = (await mf.ready).toString().replace(/^http/, 'ws').replace(/\/$/, '');

  // Stand-in sshd: greets like OpenSSH, then echoes.
  const sshd = createServer((socket) => {
    socket.write('SSH-2.0-OpenSSH_9.6 stand-in\r\n');
    socket.on('data', (data) => socket.write(data));
  });
  await new Promise((resolve) => sshd.listen(0, '127.0.0.1', resolve));
  t.after(() => sshd.close());

  const dir = mkdtempSync(path.join(tmpdir(), 'hivra-connector-'));
  const configPath = path.join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    relay: relayUrl,
    connectionId: HOST,
    generation: 1,
    secret: hmacHex(SECRET, `connector|${HOST}|1`),
    target: { host: '192.0.2.10', port: sshd.address().port },
  }));
  const connector = spawn('python3', [CONNECTOR, 'run', '--config', configPath], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  connector.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => connector.on('exit', (code) => resolve(code)));
  t.after(() => connector.kill());
  await until(() => stderr.includes('connected to Hivra'), `connector to connect (${stderr})`);

  const client = new WebSocket(`${relayUrl}/v1/hosts/${HOST}/client`, { headers: { authorization: `Bearer ${ticket()}` } });
  const received = [];
  client.on('message', (data) => received.push(Buffer.from(data).toString()));
  await new Promise((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
  client.send(Buffer.from('ping through the relay\n'));
  await until(() => received.join('').includes('SSH-2.0-OpenSSH_9.6 stand-in') && received.join('').includes('ping through the relay'), `bytes back (${received.join('')})`);

  // A 300 KB burst crosses intact in both directions (bigger than one frame buffer).
  const burst = randomBytes(150 * 1024).toString('hex');
  received.length = 0;
  client.send(Buffer.from(burst));
  await until(() => received.join('').length >= burst.length, 'the burst to echo back');
  assert.equal(received.join(''), burst);
  client.close();

  const revoked = await fetch(`${relayUrl.replace(/^ws/, 'http')}/v1/hosts/${HOST}/revoke`, {
    method: 'POST',
    headers: { authorization: `Bearer ${hmacHex(SECRET, 'admin|v1')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ minGeneration: 2 }),
  });
  assert.equal(revoked.status, 200);
  assert.equal(await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve('still running'), 10_000))]), 3);
});
