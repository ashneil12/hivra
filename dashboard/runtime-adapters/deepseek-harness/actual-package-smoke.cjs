'use strict';
// Run ONLY in the disposable non-root Linux test container described in README.
// This uses no provider/API credentials and does not prove model inference.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const { createNativeBroker } = require('/recipe/native-broker.cjs');
const { startRuntime } = require('/recipe/runtime-process.cjs');
const { nativeToolsSmoke } = require('/recipe/native-tools-smoke.cjs');
const runtimeDirectory = '/opt/hivra/deepseek-runtime';

async function main() {
  const publicOrigin = 'https://deepseek-smoke.invalid';
  let sessionValid = true;
  const broker = createNativeBroker({ publicOrigin, authorize: req => sessionValid && req.headers.cookie === 'hivra=smoke' });
  const server = http.createServer(broker.handleHttp);
  server.on('upgrade', broker.handleUpgrade);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let runtime;
  let webSocket;
  let events;
  const receipt = { version: '0.1.2-alpha.2', simulatedKey: true, modelReplyTested: false, browserRenderingTested: false };
  const sentinel = `not-a-real-api-key-${randomBytes(32).toString('hex')}`;
  async function request(route, args) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: route,
        method: args ? 'POST' : 'GET', headers: { host: 'deepseek-smoke.invalid', origin: publicOrigin,
          cookie: 'hivra=smoke', 'content-type': 'application/json' } }, res => {
        let body = ''; res.setEncoding('utf8'); res.on('data', bytes => { body += bytes; });
        res.on('end', () => {
          // Fail without printing raw upstream responses or credential values.
          try {
            assert.equal(body.includes(sentinel), false, 'native response must not echo key');
            assert.equal(res.headers['set-cookie'], undefined);
            resolve({ status: res.statusCode, body });
          } catch (error) { reject(error); }
        });
      });
      req.on('error', reject); req.end(args ? JSON.stringify({ type: 'client-request', rpcId: 'smoke',
        method: route.slice('/api/'.length), payload: { args } }) : undefined);
    });
  }
  try {
    assert.notEqual(process.getuid(), 0);
    assert.equal(fs.statSync(runtimeDirectory).uid, 0);
    assert.throws(() => fs.accessSync(runtimeDirectory, fs.constants.W_OK));
    receipt.nativePackageReadOnlyToAgent = true;
    Object.assign(receipt, await nativeToolsSmoke(runtimeDirectory));
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(startRuntime({ runtimeDirectory, home: '/tmp/never-created-home', broker,
      signal: cancelled.signal }), /deepseek_start_cancelled/);
    assert.equal(fs.existsSync('/tmp/never-created-home'), false);
    receipt.preCancelledLaunchHasNoSideEffects = true;
    runtime = await startRuntime({ runtimeDirectory, home: '/tmp/native-home', broker });
    await assert.rejects(startRuntime({ runtimeDirectory, home: '/tmp/native-home', broker }), /deepseek_runtime_already_owned/);
    receipt.concurrentStartRejected = true;
    assert.equal(broker.ready(), true, 'rejected second start must not revoke the running owner');
    const root = await request('/');
    assert.equal(root.status, 200); assert.match(root.body, /<base href="\/"/);
    receipt.authenticatedNativeHtml = true;
    const descriptor = await request('/api/credentials/describe', { refs: ['DEEPSEEK_API_KEY'] });
    assert.equal(descriptor.status, 200);
    const initial = JSON.parse(descriptor.body).result;
    assert.equal(initial.ok, true, 'native describe RPC must succeed');
    const written = await request('/api/credentials/set', { ref: 'DEEPSEEK_API_KEY', value: sentinel });
    assert.equal(written.status, 200); assert.equal(JSON.parse(written.body).result.ok, true);
    const configured = await request('/api/credentials/describe', { refs: ['DEEPSEEK_API_KEY'] });
    assert.equal(configured.status, 200);
    assert.match(configured.body, /"configured":true/);
    assert.match(configured.body, /"writable":true/);
    const credentialPath = '/tmp/native-home/.dsh/.credentials.yaml';
    assert.equal(fs.statSync(credentialPath).mode & 0o077, 0);
    assert.equal(fs.readFileSync(credentialPath, 'utf8').includes(sentinel), true);
    receipt.nativeCredentialWriteOnly = true;
    receipt.privateCredentialPermissions = true;
    receipt.firstStop = await runtime.stop(); runtime = undefined;
    runtime = await startRuntime({ runtimeDirectory, home: '/tmp/native-home', broker });
    const persisted = await request('/api/credentials/describe', { refs: ['DEEPSEEK_API_KEY'] });
    assert.equal(persisted.status, 200); assert.match(persisted.body, /"configured":true/);
    receipt.restartPersistence = true;
    const WebSocket = require(`${runtimeDirectory}/node_modules/ws`);
    webSocket = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/remote.mux`, {
      headers: { host: 'deepseek-smoke.invalid', origin: publicOrigin, cookie: 'hivra=smoke' }, handshakeTimeout: 5000,
    });
    await once(webSocket, 'open');
    receipt.nativeWebSocketUpgrade = true;
    events = await new Promise((resolve, reject) => {
      const req = http.get({ hostname: '127.0.0.1', port: server.address().port, path: '/plugins/events',
        headers: { host: 'deepseek-smoke.invalid', origin: publicOrigin, cookie: 'hivra=smoke' } }, resolve);
      req.on('error', reject);
    });
    events.on('error', () => {}); events.resume();
    assert.equal(events.statusCode, 200);
    assert.match(events.headers['content-type'], /text\/event-stream/);
    receipt.nativeEventStream = true;
    const disconnected = Promise.all([new Promise(resolve => webSocket.once('close', resolve)),
      new Promise(resolve => events.once('close', resolve))]);
    sessionValid = false;
    assert.equal((await request('/plugins/events')).status, 401);
    await disconnected;
    receipt.liveStreamsRevoked = true;
    receipt.publicStaticGate = true;
  } finally {
    try { if (runtime) receipt.finalStop = await runtime.stop(); }
    finally {
      webSocket?.terminate(); events?.destroy(); broker.close();
      await new Promise(resolve => server.close(resolve));
    }
  }
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
main().catch(error => { process.stderr.write(`DeepSeek package smoke failed: ${error.code || error.message}\n`); process.exitCode = 1; });
