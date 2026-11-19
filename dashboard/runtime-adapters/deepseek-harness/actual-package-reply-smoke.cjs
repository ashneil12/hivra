'use strict';
const assert = require('node:assert/strict');
const { execFile, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { once, on } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { createNativeBroker } = require('../../provisioner/deepseek-harness/native-broker.cjs');
const { startRuntime, VERSION } = require('../../provisioner/deepseek-harness/runtime-process.cjs');

const recipe = path.resolve(__dirname, '../../provisioner/deepseek-harness');
const host = 'deepseek-reply.invalid';
const origin = `https://${host}`;
const syntheticKey = 'fixture-model-credential';
const model = 'deepseek-v4-1-flash';
const webPrompt = 'Return the browser fixture response';
const cliPrompt = 'Reply with exactly the word pong';
const replies = new Map([[webPrompt, 'offline browser reply'], [cliPrompt, 'pong']]);

function createModelFixture() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      const body = JSON.parse(await new Response(req).text());
      const userMessages = body.messages?.filter(message => message.role === 'user').map(({ content }) =>
        typeof content === 'string' ? content : content.map(part => part.text).join(''));
      const prompt = userMessages?.find(text => replies.has(text));
      const title = userMessages?.some(text => text.startsWith('Generate the session title from this JSON array of human messages:'));
      requests.push({ method: req.method, url: req.url, authenticated: req.headers.authorization === `Bearer ${syntheticKey}`,
        model: body.model, stream: body.stream, prompt, title });
      const reply = title ? 'Fixture session' : replies.get(prompt);
      if (!reply) { res.writeHead(400).end(); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [delta, finish_reason] of [[{ role: 'assistant', content: reply.slice(0, 2) }, null],
        [{ content: reply.slice(2) }, null], [{}, 'stop']]) {
        const chunk = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model,
          choices: [{ index: 0, delta, finish_reason }] };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    } catch { res.writeHead(400).end(); }
  });
  return { server, requests };
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

async function browserReply(port, WebSocket, signal) {
  const headers = { host, origin, 'content-type': 'application/json', cookie: 'hivra=fixture' };
  async function rpc(method, request) {
    // Use http.request so the broker sees the public computer's Host header.
    const rpcId = randomUUID();
    const result = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: `/api/${method}`, method: 'POST', headers, signal }, async res => {
        try {
          assert.equal(res.statusCode, 200, method);
          assert.equal(res.headers['set-cookie'], undefined);
          resolve(JSON.parse(await new Response(res).text()));
        } catch (error) { reject(error); }
      });
      req.on('error', reject);
      req.end(JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: { request } } }));
    });
    assert.equal(result.rpcId, rpcId);
    assert.equal(result.result.ok, true, `${method}: ${result.result.error?.code}`);
    return result.result.value;
  }
  const { sessionId } = await rpc('session/create', {});
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/remote.mux`, { headers, handshakeTimeout: 5000 });
  try {
    await once(socket, 'open', { signal });
    const streamId = randomUUID();
    const frames = on(socket, 'message', { signal, close: ['close'] });
    socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId } } } } }));
    let reply;
    for await (const [bytes] of frames) {
      const frame = JSON.parse(bytes);
      assert.equal(frame.streamId, streamId);
      assert.equal(frame.type, 'item', frame.error?.code);
      const { type, event } = frame.value;
      if (type === 'snapshot') {
        const result = await rpc('session/prompt', { sessionId, requestId: randomUUID(), mode: 'queue',
          content: [{ type: 'text', text: webPrompt }] });
        assert.equal(result.accepted, true);
      } else if (event?.type === 'assistant/message') {
        assert.notEqual(event.data.interrupted, true);
        reply = event.data.message.content.filter(part => part.type === 'text').map(part => part.text).join('');
      } else if (event?.type === 'turn/end') {
        assert.equal(event.data.reason.kind, 'completed', event.data.reason.error?.code);
        assert.equal(reply, 'offline browser reply');
        return;
      }
    }
    assert.fail('native stream closed before a completed reply');
  } finally { socket.terminate(); }
}

async function main() {
  assert.notEqual(process.getuid(), 0, 'run the fixture as a non-root user');
  const interfaces = fs.readFileSync('/proc/net/dev', 'utf8').trim().split('\n').slice(2).map(line => line.split(':')[0].trim());
  assert.deepEqual(interfaces, ['lo'], 'the fixture requires a loopback-only Linux network namespace');
  const [runtimeDirectory] = process.argv.slice(2);
  assert.ok(runtimeDirectory, 'pass the directory containing the locked npm install');
  const accountHome = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-reply-'));
  const home = path.join(accountHome, '.hivra/deepseek');
  const dshHome = path.join(home, '.dsh');
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, DSH_HOME: dshHome, LANG: 'C.UTF-8',
    TERM: 'dumb', NO_COLOR: '1', DSH_TELEMETRY_DISABLED: '1' };
  const modelFixture = createModelFixture();
  const broker = createNativeBroker({ publicOrigin: origin, authorize: req => req.headers.cookie === 'hivra=fixture' });
  const front = http.createServer(broker.handleHttp).on('upgrade', broker.handleUpgrade);
  let runtime;
  try {
    const modelPort = await listen(modelFixture.server);
    const seed = `
import runpy, sys
from pathlib import Path
seed = runpy.run_path(sys.argv[1])['seed_model']
seed.__globals__.update(AGENT_ACCOUNT=None, HOME=Path(sys.argv[2]))
seed((sys.stdin.read(), sys.argv[3], sys.argv[4]))
`;
    const seedProcess = spawnSync('/usr/bin/python3', ['-I', '-B', '-c', seed,
      path.join(recipe, 'install-guest.py'), accountHome, `http://127.0.0.1:${modelPort}/v1`, model],
    { env, input: syntheticKey, timeout: 5000 });
    assert.equal(seedProcess.status, 0, 'guest model seed failed');
    const port = await listen(front);
    runtime = await startRuntime({ runtimeDirectory, home, broker, startupTimeoutMs: 15000 });
    const WebSocket = require(require.resolve('ws', { paths: [path.resolve(runtimeDirectory)] }));
    await browserReply(port, WebSocket, AbortSignal.timeout(15000));
    await runtime.stop(); runtime = undefined;
    const cli = path.resolve(runtimeDirectory, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
    const { stdout } = await promisify(execFile)(process.execPath, ['--expose-internals', cli, '--profile', 'headless', cliPrompt],
      { cwd: home, env: { ...env, TMPDIR: accountHome }, timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 65536 });
    assert.equal(stdout.trim(), 'pong');
    for (const { prompt, title, ...request } of modelFixture.requests) {
      assert.deepEqual(request, { method: 'POST', url: '/v1/chat/completions', authenticated: true, model, stream: true });
      assert.ok(title || replies.has(prompt), 'unexpected model request');
    }
    assert.deepEqual(modelFixture.requests.filter(request => !request.title).map(request => request.prompt), [webPrompt, cliPrompt]);
    process.stdout.write(`${JSON.stringify({ version: VERSION, nativeReplyFromFixture: true, headlessReplyFromFixture: true,
      realInferenceTested: false, publicPathTested: false })}\n`);
  } finally {
    try { if (runtime) await runtime.stop(); }
    finally {
      broker.close();
      await Promise.all([close(front), close(modelFixture.server)]);
      fs.rmSync(accountHome, { recursive: true, force: true });
    }
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
