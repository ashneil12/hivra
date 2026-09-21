'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const { mkdtempSync, readFileSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const {
  COOKIE_NAME,
  createRemoteDesktopBroker,
  handoffHtml,
} = require('../../provisioner/remote-desktop/broker.cjs');

const CONTROL = 'https://canary.example.test';
const PUBLIC = 'https://computer.example.test';
const COMPUTER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const MEDIA_ROOT = `/desktop/sessions/${SESSION_ID}`;
const GENERATION = '33333333-3333-4333-8333-333333333333';
const SESSION_TOKEN = `hrs1_${'t'.repeat(43)}`;
const EXCHANGE_CODE = 'e'.repeat(43);
const VERIFIER = 'v'.repeat(64);
const BASIC = `Basic ${Buffer.from('fixture-user:fixture-password').toString('base64')}`;
const CONTROL_BYPASS_SECRET = 'canary_control_bypass_1234567890';

async function fixture(t, {
  inputRole = 'controller',
  disconnectGraceMs = 10000,
  statePath = null,
  grantTtlMs = 240000,
  renewalLeadMs = 60000,
  authorizationGraceMs = 30000,
  renewalSucceeds = true,
  renewalDelayMs = 0,
  renewalError = null,
  renewalResponse = null,
  transientAuthorizeFailures = 0,
  controlBypassSecret = '',
  exchangeControlResponse = null,
  inputTransitionSucceeds = true,
  recheckMs = 15,
} = {}) {
  let authorizeBarrier = null;
  let inputResumeBarrier = null;
  let acceptedAuthorizeBarrier = null;
  const observed = [];
  const renewalDiagnostics = [];
  const upstreamPeers = new Set();
  const grants = new Map([[SESSION_ID, { sessionId: SESSION_ID, sessionToken: SESSION_TOKEN, active: false, revoked: false }]]);
  let nextSessionId = SESSION_ID;
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      observed.push({ kind: 'http', url: req.url, method: req.method, headers: req.headers, body });
      res.writeHead(200, {
        'content-type': 'text/html',
        'set-cookie': 'upstream=forbidden',
        'access-control-allow-origin': '*',
        'x-frame-options': 'DENY',
      });
      res.end('<title>Selkies fixture</title>');
    });
  });
  upstream.on('connection', socket => {
    upstreamPeers.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => upstreamPeers.delete(socket));
  });
  upstream.on('upgrade', (req, socket) => {
    observed.push({ kind: 'websocket', url: req.url, headers: req.headers });
    const accept = require('node:crypto').createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', bytes => socket.write(bytes));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const controlCalls = [];
  const fetchFn = async (url, init) => {
    const body = JSON.parse(init.body);
    controlCalls.push({ url, headers: init.headers, body });
    const state = url.endsWith('/exchange') ? grants.get(nextSessionId)
      : [...grants.values()].find(grant => init.headers.authorization === `Bearer ${grant.sessionToken}`);
    if (!state) return new Response('{}', { status: 401 });
    if (url.endsWith('/exchange')) {
      if (exchangeControlResponse instanceof Error) throw exchangeControlResponse;
      if (exchangeControlResponse) return new Response(exchangeControlResponse.body, {
        status: exchangeControlResponse.status,
        headers: { 'content-type': exchangeControlResponse.contentType || 'application/json' },
      });
      return new Response(JSON.stringify({ success: true, data: {
        sessionToken: state.sessionToken,
        sessionId: state.sessionId,
        computerKind: 'hivra-agent',
        computerId: COMPUTER_ID,
        capabilityGeneration: GENERATION,
        transport: 'selkies-websocket',
        inputRole,
        inputReady: false,
        audience: `hivra-computer:hivra-agent:${COMPUTER_ID}:desktop`,
        brokerOrigin: PUBLIC,
        expiresAt: new Date(Date.now() + grantTtlMs).toISOString(),
      } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/authorize')) {
      let acceptedSnapshot;
      if (acceptedAuthorizeBarrier) {
        acceptedSnapshot = !state.revoked && (!body.wantsInput || state.active);
        const pending = acceptedAuthorizeBarrier;
        acceptedAuthorizeBarrier = null;
        await pending;
      }
      if (authorizeBarrier) await authorizeBarrier;
      if (transientAuthorizeFailures > 0) {
        transientAuthorizeFailures -= 1;
        throw new Error('control_plane_timeout');
      }
      const authorized = acceptedSnapshot ?? (!state.revoked && (!body.wantsInput || state.active));
      return new Response(JSON.stringify(authorized ? { authorized: true, data: {
        sessionId: state.sessionId,
        computerKind: 'hivra-agent',
        computerId: COMPUTER_ID,
        capabilityGeneration: GENERATION,
        transport: 'selkies-websocket',
        inputRole,
        inputReady: body.wantsInput,
      } } : { authorized: false }), { status: authorized ? 200 : 401 });
    }
    if (url.endsWith('/renew') && renewalError) throw renewalError;
    if (url.endsWith('/renew') && renewalResponse) return renewalResponse;
    if (url.endsWith('/renew') && renewalDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, renewalDelayMs));
    }
    if (url.endsWith('/renew') && !renewalSucceeds) {
      return new Response(JSON.stringify({ renewed: false }), { status: 503 });
    }
    if (url.endsWith('/renew')) return new Response(JSON.stringify({ renewed: true, data: {
      sessionId: state.sessionId,
      expiresAt: new Date(Date.now() + 240000).toISOString(),
      continuousExpiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
      renewalCount: 1,
    } }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/input-transition')) {
      if (!inputTransitionSucceeds) {
        return new Response(JSON.stringify({ confirmed: false }), { status: 401 });
      }
      if (body.action === 'agent-input-suspended') state.active = true;
      if (body.action === 'agent-input-resumed') {
        if (inputResumeBarrier) await inputResumeBarrier;
        state.active = false;
      }
      return new Response(JSON.stringify({ confirmed: true }), { status: 200 });
    }
    if (url.endsWith('/terminate')) {
      state.revoked = true;
      return new Response(JSON.stringify({ revoked: true, inputState: state.active ? 'release-pending' : 'released' }), { status: 200 });
    }
    throw new Error(`unexpected control request ${url}`);
  };

  const broker = createRemoteDesktopBroker({
    controlOrigin: CONTROL,
    publicOrigin: PUBLIC,
    computerKind: 'hivra-agent',
    computerId: COMPUTER_ID,
    transport: 'selkies-websocket',
    upstreamPort: upstream.address().port,
    basicAuthorization: BASIC,
    controlBypassSecret,
    verifyInputIsolation: async () => true,
    fetchFn,
    recheckMs,
    disconnectGraceMs,
    renewalLeadMs,
    renewalDiagnostic: record => renewalDiagnostics.push(record),
    authorizationGraceMs,
    statePath,
  });
  const front = http.createServer((req, res) => { void broker.handleHttp(req, res); });
  front.on('upgrade', (req, socket, head) => { void broker.handleUpgrade(req, socket, head); });
  front.listen(0, '127.0.0.1');
  await once(front, 'listening');

  async function request(url, { method = 'GET', cookie = '', body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: front.address().port, path: url, method,
        headers: { host: 'computer.example.test', ...(cookie ? { cookie } : {}), ...headers } }, res => {
        let responseBody = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { responseBody += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: responseBody }));
      });
      req.on('error', reject);
      req.end(body);
    });
  }
  async function exchange(sessionId = SESSION_ID) {
    nextSessionId = sessionId;
    if (!grants.has(sessionId)) grants.set(sessionId, { sessionId, sessionToken: `hrs1_${sessionId.replaceAll('-', '')}${'b'.repeat(11)}`, active: false, revoked: false });
    const response = await request('/desktop/api/exchange', {
      method: 'POST',
      headers: { origin: PUBLIC, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, exchangeCode: EXCHANGE_CODE, verifier: VERIFIER }),
    });
    return { response, cookie: String(response.headers['set-cookie'] || '').split(';')[0] };
  }
  t.after(async () => {
    await broker.close();
    for (const socket of upstreamPeers) socket.destroy();
    await Promise.all([
      new Promise(resolve => front.close(resolve)),
      new Promise(resolve => upstream.close(resolve)),
    ]);
  });
  return {
    renewalDiagnostics,
    broker, front, observed, controlCalls, request, exchange, upstreamPeers,
    revoke: (sessionId = SESSION_ID) => { grants.get(sessionId).revoked = true; },
    active: (sessionId = SESSION_ID) => grants.get(sessionId).active,
    setTransientAuthorizeFailures: count => { transientAuthorizeFailures = count; },
    setAuthorizeBarrier: barrier => { authorizeBarrier = barrier; },
    setInputResumeBarrier: barrier => { inputResumeBarrier = barrier; },
    setAcceptedAuthorizeBarrier: barrier => { acceptedAuthorizeBarrier = barrier; },
  };
}

async function executeGeneratedHandoff(fetchFn, beforeValid = []) {
  const script = handoffHtml(CONTROL).match(/<script>([\s\S]*)<\/script>/)[1];
  const posts = [];
  const windowListeners = new Map();
  const parent = {
    postMessage: (message, origin) => posts.push({ message: JSON.parse(JSON.stringify(message)), origin }),
  };
  const desktop = {
    hidden: true,
    src: '',
    contentDocument: null,
    addEventListener: () => {},
  };
  const status = { hidden: false, textContent: '' };
  const window = {
    parent,
    addEventListener: (type, listener) => { windowListeners.set(type, listener); },
  };
  const document = { getElementById: id => id === 'desktop' ? desktop : status };
  let fetchInit = null;
  vm.runInNewContext(script, {
    window, document,
    fetch: async (url, init) => {
      fetchInit = { url, init };
      return fetchFn(url, init);
    },
    setTimeout: (callback) => { callback(); return 1; },
    clearTimeout: () => {},
    performance: { now: () => 0 },
    Uint8ClampedArray, JSON, Math,
  });
  const onMessage = windowListeners.get('message');
  for (const event of beforeValid) await onMessage(event({ parent }));
  await onMessage({
    origin: CONTROL,
    source: parent,
    data: { type: 'hivra.remote-desktop.handoff.v2', sessionId: SESSION_ID, exchangeCode: EXCHANGE_CODE, verifier: VERIFIER, streamingMode: 'hq' },
  });
  return { posts, desktop, status, fetchInit };
}

test('requires canonical HTTPS origins, exact identity, admitted transport and bounded bypass secret', async () => {
  const base = {
    controlOrigin: CONTROL,
    publicOrigin: PUBLIC,
    computerKind: 'hivra-agent',
    computerId: COMPUTER_ID,
    transport: 'selkies-websocket',
    upstreamPort: 8080,
    basicAuthorization: BASIC,
    verifyInputIsolation: async () => true,
  };
  assert.throws(() => createRemoteDesktopBroker({ ...base, controlOrigin: 'http://canary.test' }));
  assert.throws(() => createRemoteDesktopBroker({ ...base, publicOrigin: `${PUBLIC}/` }));
  assert.throws(() => createRemoteDesktopBroker({ ...base, computerId: 'latest' }));
  assert.throws(() => createRemoteDesktopBroker({ ...base, transport: 'selkies-webrtc' }));
  for (const nativeBrowserCursor of ['true', 1, null]) {
    assert.throws(() => createRemoteDesktopBroker({ ...base, nativeBrowserCursor }));
  }
  for (const controlBypassSecret of ['short', 'contains space 1234567890', 'a'.repeat(257), null]) {
    assert.throws(
      () => createRemoteDesktopBroker({ ...base, controlBypassSecret }),
      { message: 'remote_desktop_broker_options_invalid' },
    );
  }
  const unprotected = createRemoteDesktopBroker({ ...base, controlBypassSecret: '' });
  await unprotected.close();
});

test('handoff is an exact-origin postMessage exchange with no URL credential', () => {
  const html = handoffHtml(CONTROL);
  assert.match(html, /event\.origin!==CONTROL_ORIGIN/);
  assert.match(html, /event\.source!==window\.parent/);
  assert.match(html, /hivra\.remote-desktop\.handoff\.v2/);
  assert.match(html, /JSON\.stringify\(\{sessionId,exchangeCode:data\.exchangeCode,verifier:data\.verifier\}\)/);
  assert.match(html, /<iframe id="desktop"[^>]+hidden/);
  assert.match(html, /desktop\.src='\.\/sessions\/\'\+sessionId\+'\/'/);
  assert.doesNotMatch(html, /location\.replace/);
  assert.match(html, /requestVideoFrameCallback/);
  assert.match(html, /if\(!event\.isTrusted\)return/);
  assert.match(html, /metric:'browser-input-to-changed-frame'/);
  assert.match(html, /hivra\.remote-desktop\.telemetry\.v1/);
  assert.doesNotMatch(html, /[?&](?:token|code|verifier|session)=/i);
});

test('generated handoff reports only bounded exchange failures and rejects wrong messengers', async () => {
  let fetchCalls = 0;
  const rejected = await executeGeneratedHandoff(
    async () => { fetchCalls += 1; return { status: 400, redirected: false }; },
    [
      ({ parent }) => ({
        origin: 'https://attacker.example.test', source: parent,
        data: { type: 'hivra.remote-desktop.handoff.v2', sessionId: SESSION_ID, exchangeCode: EXCHANGE_CODE, verifier: VERIFIER, streamingMode: 'hq' },
      }),
      () => ({
        origin: CONTROL, source: {},
        data: { type: 'hivra.remote-desktop.handoff.v2', sessionId: SESSION_ID, exchangeCode: EXCHANGE_CODE, verifier: VERIFIER, streamingMode: 'hq' },
      }),
      ({ parent }) => ({
        origin: CONTROL, source: parent,
        data: { type: 'hivra.remote-desktop.handoff.v1', sessionId: SESSION_ID, exchangeCode: EXCHANGE_CODE, verifier: VERIFIER, streamingMode: 'hq' },
      }),
      ({ parent }) => ({
        origin: CONTROL, source: parent,
        data: { type: 'hivra.remote-desktop.handoff.v2', sessionId: SESSION_ID, exchangeCode: EXCHANGE_CODE, verifier: VERIFIER, streamingMode: 'maximum' },
      }),
      ({ parent }) => ({
        origin: CONTROL, source: parent,
        data: { type: 'hivra.remote-desktop.handoff.v2', sessionId: SESSION_ID, exchangeCode: EXCHANGE_CODE, verifier: VERIFIER, streamingMode: 'hq', bitrate: 1_000_000 },
      }),
    ],
  );
  assert.equal(fetchCalls, 1);
  assert.deepEqual(rejected.posts.map(item => item.message), [
    { type: 'hivra.remote-desktop.ready.v1' },
    { type: 'hivra.remote-desktop.failed.v1', sessionId: SESSION_ID, reason: 'handoff-rejected' },
  ]);
  assert.equal(rejected.status.textContent, 'Desktop connection failed.');
  assert.equal(rejected.fetchInit.url, './api/exchange');
  assert.equal(rejected.fetchInit.init.redirect, 'error');

  for (const response of [{ status: 503, redirected: false }, { status: 599, redirected: false }]) {
    let attempts = 0;
    const result = await executeGeneratedHandoff(async () => { attempts += 1; return response; });
    assert.equal(attempts, 3);
    assert.deepEqual(result.posts.at(-1).message, {
      type: 'hivra.remote-desktop.failed.v1', sessionId: SESSION_ID, reason: 'control-unreachable',
    });
  }
  let networkAttempts = 0;
  const network = await executeGeneratedHandoff(async () => { networkAttempts += 1; throw new TypeError('redirect or network failure'); });
  assert.equal(networkAttempts, 3);
  assert.deepEqual(network.posts.at(-1).message, {
    type: 'hivra.remote-desktop.failed.v1', sessionId: SESSION_ID, reason: 'control-unreachable',
  });

  let recoveredAttempts = 0;
  const recovered = await executeGeneratedHandoff(async () => {
    recoveredAttempts += 1;
    return recoveredAttempts < 3 ? { status: 503, redirected: false } : { status: 204, redirected: false };
  });
  assert.equal(recoveredAttempts, 3);
  assert.equal(recovered.desktop.src, `./sessions/${SESSION_ID}/`);

  for (const response of [
    { status: 302, redirected: true },
    { status: 401, redirected: false },
    { status: 200, redirected: false },
  ]) {
    const result = await executeGeneratedHandoff(async () => response);
    assert.deepEqual(result.posts.at(-1).message, {
      type: 'hivra.remote-desktop.failed.v1', sessionId: SESSION_ID, reason: 'handoff-rejected',
    });
  }
  const connected = await executeGeneratedHandoff(async () => ({ status: 204, redirected: false }));
  assert.equal(connected.posts.some(item => item.message.type === 'hivra.remote-desktop.connected.v1'), false);
  assert.equal(connected.desktop.src, `./sessions/${SESSION_ID}/`);
});

test('control exchange infrastructure failures become guest 503 while invalid handoffs stay 401', async t => {
  for (const exchangeControlResponse of [
    new TypeError('network failure'),
    { status: 302, body: '' },
    { status: 401, body: '<html>Vercel Authentication</html>', contentType: 'text/html' },
    { status: 503, body: JSON.stringify({ success: false }) },
  ]) {
    const f = await fixture(t, { exchangeControlResponse });
    assert.equal((await f.exchange()).response.status, 503);
  }
  for (const exchangeControlResponse of [
    { status: 400, body: JSON.stringify({ success: false }) },
    { status: 200, body: 'not-json', contentType: 'text/plain' },
    { status: 200, body: JSON.stringify({ success: false }) },
  ]) {
    const f = await fixture(t, { exchangeControlResponse });
    assert.equal((await f.exchange()).response.status, 401);
  }
});

test('generated handoff forwards display changes and strict parent viewport signals to Selkies', async () => {
  const html = handoffHtml(CONTROL);
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const windowListeners = new Map();
  const visualViewportListeners = new Map();
  const desktopListeners = new Map();
  const timers = new Map();
  const childEvents = [];
  let timerSequence = 0;
  let resizeCallback = null;
  let dprListener = null;
  let matchMediaCount = 0;
  let inputResizeCount = 0;
  let observedTarget = null;
  let observeCount = 0;
  let disconnected = false;
  class ChildEvent {
    constructor(type) { this.type = type; }
  }
  class FakeResizeObserver {
    constructor(callback) { resizeCallback = callback; }
    observe(target) { observedTarget = target; observeCount += 1; }
    disconnect() { disconnected = true; }
  }
  const desktop = {
    contentDocument: null,
    remove: () => {},
    contentWindow: {
      Event: ChildEvent,
      dispatchEvent: event => { childEvents.push(event.type); },
      webrtcInput: { resize: () => { inputResizeCount += 1; } },
      app: { videoBitRate: 8000, videoFramerate: 30 },
    },
    addEventListener: (type, listener) => { desktopListeners.set(type, listener); },
  };
  const status = { hidden: false, textContent: '' };
  const parent = { postMessage: () => {} };
  const window = {
    parent,
    devicePixelRatio: 2,
    visualViewport: {
      addEventListener: (type, listener) => { visualViewportListeners.set(type, listener); },
      removeEventListener: (type, listener) => {
        if (visualViewportListeners.get(type) === listener) visualViewportListeners.delete(type);
      },
    },
    matchMedia: () => {
      matchMediaCount += 1;
      return {
        addEventListener: (type, listener) => { if (type === 'change') dprListener = listener; },
        removeEventListener: (type, listener) => {
          if (type === 'change' && dprListener === listener) dprListener = null;
        },
      };
    },
    addEventListener: (type, listener) => { windowListeners.set(type, listener); },
    removeEventListener: (type, listener) => {
      if (windowListeners.get(type) === listener) windowListeners.delete(type);
    },
  };
  const document = { getElementById: id => id === 'desktop' ? desktop : status };
  const setTimeout = (callback, milliseconds) => {
    const id = ++timerSequence;
    timers.set(id, { callback, milliseconds });
    return id;
  };
  const clearTimeout = id => { timers.delete(id); };

  vm.runInNewContext(script, {
    window, document, ResizeObserver: FakeResizeObserver,
    fetch: async () => ({ status: 204, redirected: false }), setTimeout, clearTimeout,
    performance: { now: () => 0 }, Uint8ClampedArray, JSON, Math,
  });
  assert.equal(observedTarget, desktop);
  assert.equal(observeCount, 1);
  const initialResizeTimer = [...timers.entries()].find(([, timer]) => timer.milliseconds === 100);
  assert.ok(initialResizeTimer);
  timers.delete(initialResizeTimer[0]);
  initialResizeTimer[1].callback();
  assert.deepEqual(childEvents, ['resize']);
  assert.equal(inputResizeCount, 1);
  assert.equal(matchMediaCount, 1);

  resizeCallback();
  const firstResizeTimerId = [...timers.entries()].find(([, timer]) => timer.milliseconds === 100)[0];
  resizeCallback();
  const resizeTimers = [...timers.entries()].filter(([, timer]) => timer.milliseconds === 100);
  assert.equal(resizeTimers.length, 1);
  assert.notEqual(resizeTimers[0][0], firstResizeTimerId);
  timers.delete(resizeTimers[0][0]);
  resizeTimers[0][1].callback();
  assert.deepEqual(childEvents, ['resize', 'resize']);
  assert.equal(inputResizeCount, 2);

  await windowListeners.get('message')({ origin: CONTROL, source: parent,
    data: { type: 'hivra.remote-desktop.handoff.v2', sessionId: SESSION_ID, exchangeCode: EXCHANGE_CODE, verifier: VERIFIER, streamingMode: 'performance' } });
  desktopListeners.get('load')();
  assert.equal(desktop.contentWindow.app.videoBitRate, 12000);
  assert.equal(desktop.contentWindow.app.videoFramerate, 60);
  const loadResizeTimer = [...timers.entries()].find(([, timer]) => timer.milliseconds === 100);
  assert.ok(loadResizeTimer);
  timers.delete(loadResizeTimer[0]);
  loadResizeTimer[1].callback();
  assert.deepEqual(childEvents, ['resize', 'resize', 'resize']);
  assert.equal(inputResizeCount, 3);

  await windowListeners.get('message')({
    origin: CONTROL,
    source: parent,
    data: {
      type: 'hivra.remote-desktop.handoff.v2',
      sessionId: SESSION_ID,
      exchangeCode: EXCHANGE_CODE,
      verifier: VERIFIER,
      streamingMode: 'hq',
    },
  });
  windowListeners.get('message')({
    origin: CONTROL,
    source: parent,
    data: { type: 'hivra.remote-desktop.viewport.v1' },
  });
  const parentResizeTimer = [...timers.entries()].find(([, timer]) => timer.milliseconds === 100);
  assert.ok(parentResizeTimer);
  timers.delete(parentResizeTimer[0]);
  parentResizeTimer[1].callback();
  assert.deepEqual(childEvents, ['resize', 'resize', 'resize', 'resize']);
  assert.equal(inputResizeCount, 4);

  for (const event of [
    { origin: 'https://attacker.test', source: parent, data: { type: 'hivra.remote-desktop.viewport.v1' } },
    { origin: CONTROL, source: {}, data: { type: 'hivra.remote-desktop.viewport.v1' } },
    { origin: CONTROL, source: parent, data: { type: 'hivra.remote-desktop.viewport.v1', width: 9999 } },
  ]) windowListeners.get('message')(event);
  assert.equal([...timers.values()].some(timer => timer.milliseconds === 100), false);

  windowListeners.get('message')({
    origin: CONTROL,
    source: parent,
    data: { type: 'hivra.remote-desktop.streaming-mode.v1', mode: 'performance' },
  });
  assert.equal(desktop.contentWindow.app.videoBitRate, 12000);
  assert.equal(desktop.contentWindow.app.videoFramerate, 60);
  for (const event of [
    { origin: 'https://attacker.test', source: parent, data: { type: 'hivra.remote-desktop.streaming-mode.v1', mode: 'hq' } },
    { origin: CONTROL, source: {}, data: { type: 'hivra.remote-desktop.streaming-mode.v1', mode: 'hq' } },
    { origin: CONTROL, source: parent, data: { type: 'hivra.remote-desktop.streaming-mode.v1', mode: 'maximum' } },
    { origin: CONTROL, source: parent, data: { type: 'hivra.remote-desktop.streaming-mode.v1', mode: 'hq', bitrate: 1000000 } },
  ]) windowListeners.get('message')(event);
  assert.equal(desktop.contentWindow.app.videoBitRate, 12000);
  windowListeners.get('message')({
    origin: CONTROL,
    source: parent,
    data: { type: 'hivra.remote-desktop.streaming-mode.v1', mode: 'hq' },
  });
  assert.equal(desktop.contentWindow.app.videoBitRate, 25000);
  assert.equal(desktop.contentWindow.app.videoFramerate, 60);

  windowListeners.get('resize')();
  visualViewportListeners.get('resize')();
  assert.equal([...timers.values()].filter(timer => timer.milliseconds === 100).length, 1);
  const browserResizeTimer = [...timers.entries()].find(([, timer]) => timer.milliseconds === 100);
  timers.delete(browserResizeTimer[0]);
  browserResizeTimer[1].callback();
  assert.equal(inputResizeCount, 5);

  assert.equal(typeof dprListener, 'function');
  dprListener();
  assert.equal(matchMediaCount, 2);
  const dprResizeTimer = [...timers.entries()].find(([, timer]) => timer.milliseconds === 100);
  assert.ok(dprResizeTimer);
  timers.delete(dprResizeTimer[0]);
  dprResizeTimer[1].callback();
  assert.equal(inputResizeCount, 6);

  resizeCallback();
  windowListeners.get('pagehide')();
  assert.equal(disconnected, true);
  assert.equal(windowListeners.has('resize'), false);
  assert.equal(visualViewportListeners.has('resize'), false);
  assert.equal(dprListener, null);
  assert.equal([...timers.values()].some(timer => timer.milliseconds === 100), false);

  assert.equal(windowListeners.has('pageshow'), false);
  assert.equal(observeCount, 1);
});

test('generated handoff accepts a painted pinned Selkies canvas but rejects static canvases and non-frame signals', async () => {
  const posts = [];
  const listeners = new Map();
  const desktopListeners = new Map();
  const transportListeners = new Map();
  const timers = new Map();
  let timerId = 0;
  const parent = { postMessage: message => posts.push(message) };
  const canvas = { tagName: 'CANVAS', width: 1920, height: 1080 };
  const desktop = {
    remove: () => {},
    contentDocument: { querySelector: selector => selector === '#videoCanvas' ? canvas : null, addEventListener: () => {} },
    contentWindow: { fps: 0, postMessage: () => {}, selkiesTransport: {
      readyState: 1,
      addEventListener: (type, handler) => transportListeners.set(type, handler),
      removeEventListener: () => {},
    } },
    addEventListener: (type, handler) => desktopListeners.set(type, handler),
  };
  const window = { parent, addEventListener: (type, handler) => listeners.set(type, handler), removeEventListener: () => {} };
  vm.runInNewContext(handoffHtml(CONTROL).match(/<script>([\s\S]*)<\/script>/)[1], {
    window, document: { getElementById: id => id === 'desktop' ? desktop : {} },
    fetch: async () => ({ status: 204, redirected: false }), performance: { now: () => 100 },
    setTimeout: (callback, milliseconds) => { const id = ++timerId; timers.set(id, { callback, milliseconds }); return id; },
    clearTimeout: id => timers.delete(id), JSON, Math,
  });
  await listeners.get('message')({ origin: CONTROL, source: parent, data: {
    type: 'hivra.remote-desktop.handoff.v2', sessionId: SESSION_ID, exchangeCode: EXCHANGE_CODE, verifier: VERIFIER, streamingMode: 'hq',
  } });
  desktopListeners.get('load')();
  function probe() {
    const entry = [...timers.entries()].find(([, timer]) => timer.milliseconds === 0 || timer.milliseconds === 250);
    assert.ok(entry);
    timers.delete(entry[0]); entry[1].callback();
  }
  const connected = () => posts.filter(message => message.type === 'hivra.remote-desktop.connected.v1').length;
  probe(); assert.equal(connected(), 0); // Socket + sized static canvas is insufficient.
  for (const invalid of [NaN, Infinity, '60', -1]) {
    desktop.contentWindow.fps = invalid; probe(); assert.equal(connected(), 0);
  }
  desktop.contentWindow.fps = 60;
  canvas.width = 0; probe(); assert.equal(connected(), 0);
  canvas.width = 1920; probe(); assert.equal(connected(), 1);
  transportListeners.get('close')();
  assert.ok(posts.some(message => message.type === 'hivra.remote-desktop.disconnected.v1'));
});

for (const nativeBrowserCursor of [false, true]) test(`generated handoff script reports trusted measurements and cursor policy native=${nativeBrowserCursor}`, async () => {
  const html = handoffHtml(CONTROL);
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const posts = [];
  const windowListeners = new Map();
  const desktopListeners = new Map();
  const streamListeners = new Map();
  const frameCallbacks = [];
  const childMessages = [];
  const timers = new Map();
  let timerSequence = 0;
  let pixel = 1;
  let now = 0;
  const parent = { postMessage: (message, origin) => posts.push({ message: JSON.parse(JSON.stringify(message)), origin }) };
  const video = {
    videoWidth: 1920,
    videoHeight: 1080,
    readyState: 2,
    requestVideoFrameCallback: callback => { frameCallbacks.push(callback); },
  };
  const streamDocument = {
    querySelector: selector => selector === 'video' ? video : null,
    addEventListener: (type, listener) => { streamListeners.set(type, listener); },
  };
  const status = { hidden: false, textContent: '' };
  const desktop = {
    hidden: true,
    src: '',
    contentDocument: streamDocument,
    contentWindow: {
      postMessage: (message, origin) => childMessages.push({ message, origin }),
      selkiesTransport: { readyState: 1, addEventListener: () => {}, removeEventListener: () => {} },
    },
    addEventListener: (type, listener) => { desktopListeners.set(type, listener); },
  };
  const document = {
    getElementById: id => id === 'desktop' ? desktop : status,
    createElement: tag => {
      assert.equal(tag, 'canvas');
      return { width: 0, height: 0, getContext: () => ({
        drawImage: () => {},
        getImageData: () => {
          const data = new Uint8ClampedArray(16 * 9 * 4);
          for (let index = 0; index < data.length; index += 4) {
            data[index] = pixel; data[index + 1] = pixel; data[index + 2] = pixel; data[index + 3] = 255;
          }
          return { data };
        },
      }) };
    },
  };
  const window = { parent, addEventListener: (type, listener) => { windowListeners.set(type, listener); } };
  const setTimeout = (callback, milliseconds) => {
    const id = ++timerSequence;
    if (milliseconds === 0) callback();
    else timers.set(id, { callback, milliseconds });
    return id;
  };
  const clearTimeout = id => { timers.delete(id); };
  vm.runInNewContext(script, {
    window, document, performance: { now: () => now },
    fetch: async () => ({ status: 204, redirected: false }), setTimeout, clearTimeout,
    Uint8ClampedArray, JSON, Math,
  });
  assert.equal(posts[0].message.type, 'hivra.remote-desktop.ready.v1');
  await windowListeners.get('message')({
    origin: CONTROL,
    source: parent,
    data: { type: 'hivra.remote-desktop.handoff.v2', sessionId: SESSION_ID, exchangeCode: EXCHANGE_CODE, verifier: VERIFIER, streamingMode: 'hq' },
  });
  assert.equal(desktop.src, `./sessions/${SESSION_ID}/`);
  assert.equal(posts.some(item => item.message.type === 'hivra.remote-desktop.connected.v1'), false);
  desktopListeners.get('load')();
  assert.equal(childMessages.length, 1);
  assert.equal(childMessages[0].origin, '*');
  assert.equal(childMessages[0].message.type, 'setUseBrowserCursors');
  // false can enable the separate Selkies cursor bitmap. Never request it,
  // even when Omarchy replaces the CSS pointer with the native OS pointer.
  assert.equal(childMessages[0].message.value, true);
  assert.equal(posts.some(item => item.message.type === 'hivra.remote-desktop.connected.v1'), true);

  streamListeners.get('pointerdown')({ isTrusted: false });
  assert.equal(frameCallbacks.length, 0);
  streamListeners.get('pointerdown')({ isTrusted: true });
  assert.equal(frameCallbacks.length, 1);
  pixel = 2;
  now = 25;
  frameCallbacks.shift()();
  const changed = posts.find(item => item.message.outcome === 'changed').message;
  assert.deepEqual(changed, {
    type: 'hivra.remote-desktop.telemetry.v1', sessionId: SESSION_ID, metric: 'browser-input-to-changed-frame',
    outcome: 'changed', sequence: 1, durationMs: 25, decodedFrames: 1,
  });

  now = 30;
  streamListeners.get('keydown')({ isTrusted: true });
  const deadline = [...timers.values()].find(timer => timer.milliseconds === 2000);
  assert.ok(deadline);
  deadline.callback();
  const timeout = posts.find(item => item.message.outcome === 'timeout').message;
  assert.deepEqual(timeout, {
    type: 'hivra.remote-desktop.telemetry.v1', sessionId: SESSION_ID, metric: 'browser-input-to-changed-frame',
    outcome: 'timeout', sequence: 2, durationMs: 2000, decodedFrames: 0,
  });
});

for (const [capturedCursor, ending] of [[false, 'pagehide'], [false, 'transport-close'], [true, 'pagehide'], [true, 'transport-close'], [true, 'cursor-enable-failure']]) test(`cursor policy captured=${capturedCursor} cleans up on ${ending}`, async t => {
  const dom = new JSDOM(handoffHtml(CONTROL, capturedCursor), { url: `${PUBLIC}/desktop/handoff`, runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const window = dom.window;
  const desktop = window.document.getElementById('desktop');
  const stream = new JSDOM('<div id="overlayInput" style="cursor:url(guest.png) 12 12,auto!important"></div><video></video>',
    { url: `${PUBLIC}/desktop/sessions/${SESSION_ID}/`, runScripts: 'outside-only' });
  t.after(() => stream.window.close());
  const child = stream.window;
  // A same-origin real DOM stream document without making a network request.
  Object.defineProperty(desktop, 'contentWindow', { value: child });
  Object.defineProperty(desktop, 'contentDocument', { value: child.document });
  const messages = [];
  const transportListeners = new Map();
  const cursorControls = [];
  window.fetch = async () => ({ status: 204, redirected: false });
  window.parent.postMessage = () => {};
  let mutations = 0;
  let disconnects = 0;
  const NativeObserver = window.MutationObserver;
  window.MutationObserver = class extends NativeObserver {
    constructor(callback) { super(records => { mutations += 1; callback(records); }); }
    disconnect() { disconnects += 1; super.disconnect(); }
  };
  window.eval(window.document.querySelector('script').textContent);
  window.dispatchEvent(new window.MessageEvent('message', { origin: CONTROL, source: window.parent,
    data: { type: 'hivra.remote-desktop.handoff.v2', sessionId: SESSION_ID, exchangeCode: EXCHANGE_CODE, verifier: VERIFIER, streamingMode: 'hq' } }));
  await new Promise(resolve => setImmediate(resolve));
  const overlay = child.document.getElementById('overlayInput');
  Object.defineProperty(child.document.querySelector('video'), 'readyState', { value: 2 });
  child.postMessage = message => messages.push(JSON.parse(JSON.stringify(message)));
  child.selkiesTransport = { readyState: 1, send: message => { cursorControls.push(message); if (ending === 'cursor-enable-failure') throw new Error('closed'); },
    addEventListener: (name, listener) => transportListeners.set(name, listener), removeEventListener: () => {} };
  desktop.dispatchEvent(new window.Event('load'));
  // The handoff binds transport telemetry in a window timer after load.
  // Node's setImmediate alone need not run that jsdom timer first.
  const bindingDeadline = Date.now() + 1000;
  while (typeof transportListeners.get('close') !== 'function' && Date.now() < bindingDeadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(typeof transportListeners.get('close'), 'function', 'load must bind transport close before cleanup is exercised');
  assert.deepEqual(messages, [{ type: 'setUseBrowserCursors', value: true }]);
  assert.deepEqual(cursorControls, capturedCursor ? ['SET_NATIVE_CURSOR_RENDERING,1'] : []);
  if (ending === 'cursor-enable-failure') {
    assert.equal(desktop.isConnected, false, 'failed cursor command must not leave an invisible active pointer');
    assert.equal(overlay.style.getPropertyValue('cursor'), 'url(guest.png) 12 12,auto');
    assert.equal(disconnects, 0);
    return;
  }
  assert.equal(overlay.style.getPropertyValue('cursor'), capturedCursor ? 'none' : 'url(guest.png) 12 12,auto');
  assert.equal(overlay.style.getPropertyPriority('cursor'), 'important');
  for (const cursor of ['pointer', 'text', 'ew-resize', 'url(updated.png) 12 12, auto', 'none']) {
    const before = mutations;
    overlay.style.setProperty('cursor', cursor, 'important');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(overlay.style.getPropertyValue('cursor'), capturedCursor ? 'none' : cursor);
    assert.equal(overlay.style.getPropertyPriority('cursor'), 'important');
    assert.ok(mutations - before <= 2, 'own repair must not sustain an observer loop');
  }
  if (ending === 'pagehide') window.dispatchEvent(new window.Event('pagehide'));
  else transportListeners.get('close')();
  assert.equal(disconnects, capturedCursor ? 1 : 0);
  assert.equal(desktop.isConnected, false);
  const before = mutations;
  overlay.style.setProperty('cursor', 'none', 'important');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(mutations, before);
  assert.equal(overlay.style.getPropertyValue('cursor'), 'none');
});

test('modern Selkies receives real settings and bounded resolution messages without a legacy app', async t => {
  const dom = new JSDOM(handoffHtml(CONTROL), { url: `${PUBLIC}/desktop/handoff`, runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom;
  const desktop = window.document.getElementById('desktop');
  const child = { webrtcInput: {}, selkiesTransport: { readyState: 1 }, postMessage: (message, origin) => {
    assert.equal(origin, PUBLIC);
    messages.push(JSON.parse(JSON.stringify(message)));
  } };
  const messages = [];
  let width = 1600, height = 900;
  Object.defineProperties(desktop, {
    contentWindow: { value: child },
    clientWidth: { get: () => width }, clientHeight: { get: () => height },
  });
  window.fetch = async () => ({ status: 204 });
  window.parent.postMessage = () => {};
  window.eval(window.document.querySelector('script').textContent);
  const send = (data, origin = CONTROL, source = window.parent) => window.dispatchEvent(
    new window.MessageEvent('message', { origin, source, data }));
  send({ type: 'hivra.remote-desktop.handoff.v2', sessionId: SESSION_ID,
    exchangeCode: EXCHANGE_CODE, verifier: VERIFIER, streamingMode: 'hq' });
  await new Promise(resolve => setImmediate(resolve));
  desktop.dispatchEvent(new window.Event('load'));
  assert.equal(child.app, undefined);
  assert.deepEqual(messages.slice(-2), [
    { type: 'settings', settings: { video_bitrate: 25000, framerate: 60 } },
    { type: 'setManualResolution', width: 1920, height: 1080 },
  ]);
  for (const [mode, w, h, bitrate] of [['performance', 1280, 720, 12000], ['qhd', 2560, 1440, 40000], ['uhd', 3840, 2160, 65000]]) {
    send({ type: 'hivra.remote-desktop.streaming-mode.v1', mode });
    assert.deepEqual(messages.slice(-2), [
      { type: 'settings', settings: { video_bitrate: bitrate, framerate: 60 } },
      { type: 'setManualResolution', width: w, height: h },
    ]);
    const count = messages.length;
    send({ type: 'hivra.remote-desktop.streaming-mode.v1', mode });
    assert.equal(messages.length, count, 'do not restart capture for unchanged settings');
  }
  const count = messages.length;
  send({ type: 'hivra.remote-desktop.streaming-mode.v1', mode: 'performance' }, 'https://attacker.test');
  send({ type: 'hivra.remote-desktop.streaming-mode.v1', mode: 'performance' }, CONTROL, {});
  assert.equal(messages.length, count);
  width = 600; height = 1000;
  send({ type: 'hivra.remote-desktop.streaming-mode.v1', mode: 'uhd' });
  const portrait = messages.at(-1);
  assert.equal(portrait.type, 'setManualResolution');
  assert.ok(Math.abs(portrait.width / portrait.height - 0.6) < 0.002);
  assert.ok(portrait.width <= 4080 && portrait.height <= 4080);
  width = 5000; height = 100;
  send({ type: 'hivra.remote-desktop.streaming-mode.v1', mode: 'uhd' });
  assert.deepEqual(messages.at(-1), { type: 'setManualResolution', width: 4080, height: 1020 });
  width = height = 0;
  const beforeHidden = messages.length;
  send({ type: 'hivra.remote-desktop.streaming-mode.v1', mode: 'uhd' });
  assert.equal(messages.length, beforeHidden, 'hidden tabs must not shrink the guest');
  window.dispatchEvent(new window.Event('pagehide'));
  send({ type: 'hivra.remote-desktop.streaming-mode.v1', mode: 'hq' });
  assert.equal(messages.length, beforeHidden, 'ended sessions cannot change the stream');
});

test('one-time exchange keeps the bearer guest-side and activates isolated input', async t => {
  const f = await fixture(t);
  const handoff = await f.request('/desktop/handoff');
  assert.equal(handoff.status, 200);
  assert.equal(handoff.headers['content-security-policy'].includes(`frame-ancestors ${CONTROL}`), true);
  assert.equal(handoff.headers['content-security-policy'].includes("frame-src 'self'"), true);
  const { response, cookie } = await f.exchange();
  assert.equal(response.status, 204);
  assert.match(cookie, new RegExp(`^${COOKIE_NAME}-${SESSION_ID}=v1\\.[A-Za-z0-9_-]{43}$`));
  assert.equal(String(response.headers['set-cookie']).includes('Max-Age='), false);
  assert.equal(String(response.headers['set-cookie']).includes('Expires='), false);
  assert.equal(cookie.includes(SESSION_TOKEN), false);
  assert.equal(JSON.stringify(response).includes(SESSION_TOKEN), false);
  assert.equal(f.active(), true);
  const paths = f.controlCalls.map(call => new URL(call.url).pathname);
  assert.deepEqual(paths.slice(0, 3), [
    '/api/remote-desktop/sessions/exchange',
    '/api/remote-desktop/sessions/input-transition',
    '/api/remote-desktop/sessions/authorize',
  ]);
  // The periodic live lease check may race this assertion; any subsequent
  // control-plane request must be authorization only, never a second exchange
  // or input transition.
  assert.equal(paths.slice(3).every(pathname => pathname === '/api/remote-desktop/sessions/authorize'), true);
  assert.equal(f.controlCalls[0].headers.authorization, undefined);
  assert.equal(f.controlCalls.slice(1).every(call => call.headers.authorization === `Bearer ${SESSION_TOKEN}`), true);
  assert.equal(f.controlCalls.every(call => call.headers['x-vercel-protection-bypass'] === undefined), true);
});

test('control bypass is sent only to the control plane and never browser, Selkies or session state', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'hivra-remote-desktop-bypass-'));
  const statePath = path.join(directory, 'sessions.json');
  const f = await fixture(t, { controlBypassSecret: CONTROL_BYPASS_SECRET, statePath });
  const handoff = await f.request('/desktop/handoff');
  const { response, cookie } = await f.exchange();
  const desktop = await f.request(`${MEDIA_ROOT}/`, { cookie });

  assert.equal(response.status, 204);
  assert.equal(desktop.status, 200);
  assert.equal(f.controlCalls.length >= 4, true);
  assert.equal(f.controlCalls.every(call =>
    call.headers['x-vercel-protection-bypass'] === CONTROL_BYPASS_SECRET), true);
  assert.equal(f.controlCalls.every(call => !JSON.stringify(call.body).includes(CONTROL_BYPASS_SECRET)), true);
  assert.equal(JSON.stringify({ headers: handoff.headers, body: handoff.body }).includes(CONTROL_BYPASS_SECRET), false);
  assert.equal(JSON.stringify({ headers: response.headers, body: response.body }).includes(CONTROL_BYPASS_SECRET), false);
  assert.equal(JSON.stringify({ headers: desktop.headers, body: desktop.body }).includes(CONTROL_BYPASS_SECRET), false);
  assert.equal(f.observed.every(item => item.headers['x-vercel-protection-bypass'] === undefined), true);
  assert.equal(readFileSync(statePath, 'utf8').includes(CONTROL_BYPASS_SECRET), false);
});

test('a denied takeover never creates a browser session or cookie', async t => {
  const f = await fixture(t, { inputTransitionSucceeds: false });
  const { response } = await f.exchange();

  assert.equal(response.status, 401);
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(f.broker.sessionCount(), 0);
  assert.equal(f.active(), false);
  assert.deepEqual(f.controlCalls.map(call => new URL(call.url).pathname), [
    '/api/remote-desktop/sessions/exchange',
    '/api/remote-desktop/sessions/input-transition',
    '/api/remote-desktop/sessions/terminate',
  ]);
});

test('rejects cross-origin exchange, viewer grants and URL secrets', async t => {
  const f = await fixture(t, { inputRole: 'viewer' });
  assert.equal((await f.request('/desktop/api/exchange', {
    method: 'POST',
    headers: { origin: 'https://attacker.test', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: SESSION_ID, exchangeCode: EXCHANGE_CODE, verifier: VERIFIER }),
  })).status, 403);
  assert.equal((await f.request('/desktop/handoff?code=forbidden')).status, 400);
  assert.equal((await f.exchange()).response.status, 401);
  assert.equal(f.broker.sessionCount(), 0);
});

test('proxy strips browser authority and injects only the private upstream credential', async t => {
  const f = await fixture(t);
  const { cookie } = await f.exchange();
  const response = await f.request(`${MEDIA_ROOT}/?quality=high`, {
    cookie,
    headers: {
      origin: PUBLIC,
      authorization: 'Bearer browser-secret',
      'x-forwarded-host': 'attacker.test',
      'x-vercel-protection-bypass': 'browser-supplied-secret',
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.equal(response.headers['x-frame-options'], undefined);
  assert.equal(response.headers['content-security-policy'], `frame-ancestors 'self' ${CONTROL}`);
  const upstream = f.observed.find(item => item.kind === 'http');
  assert.equal(upstream.url, '/?quality=high');
  assert.equal(upstream.headers.authorization, BASIC);
  assert.equal(upstream.headers.cookie, undefined);
  assert.equal(upstream.headers['x-forwarded-host'], undefined);
  assert.equal(upstream.headers['x-vercel-protection-bypass'], undefined);
  assert.match(upstream.headers.origin, /^http:\/\/127\.0\.0\.1:[0-9]+$/);
});

test('live WebSocket is bearer-rechecked and revocation closes media then releases input', async t => {
  const f = await fixture(t);
  const { cookie } = await f.exchange();
  const client = net.connect(f.front.address().port, '127.0.0.1');
  t.after(() => client.destroy());
  await once(client, 'connect');
  const key = randomBytes(16).toString('base64');
  client.write(`GET ${MEDIA_ROOT}/api/websockets HTTP/1.1\r\nHost: computer.example.test\r\nOrigin: ${PUBLIC}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`);
  const [handshake] = await once(client, 'data');
  assert.match(handshake.toString(), /^HTTP\/1\.1 101/);
  const upstream = f.observed.find(item => item.kind === 'websocket');
  assert.equal(upstream.url, '/api/websockets');
  assert.equal(upstream.headers.authorization, BASIC);
  assert.equal(upstream.headers.cookie, undefined);
  client.write('media-frame');
  const [echo] = await once(client, 'data');
  assert.equal(echo.toString(), 'media-frame');
  const disconnected = once(client, 'close');
  f.revoke();
  await disconnected;
  for (let attempt = 0; attempt < 100 && f.broker.sessionCount() > 0; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(f.broker.sessionCount(), 0);
  assert.equal(f.active(), false);
  assert.equal(f.controlCalls.some(call => call.url.endsWith('/terminate')), true);
  assert.equal(f.controlCalls.some(call => call.url.endsWith('/input-transition') && call.body.action === 'agent-input-resumed'), true);
});

test('revoked document A cannot adopt a later session B cookie for HTTP or WebSocket', async t => {
  const f = await fixture(t);
  const a = await f.exchange();
  assert.equal((await f.request(`${MEDIA_ROOT}/`, { cookie: a.cookie })).status, 200);
  f.revoke();
  const idB = '44444444-4444-4444-8444-444444444444';
  const pathB = `/desktop/sessions/${idB}`;
  const b = await f.exchange(idB);
  assert.equal(b.response.status, 204);
  assert.match(String(b.response.headers['set-cookie']), new RegExp(`Path=${pathB}/; HttpOnly; Secure; SameSite=Strict`));
  const jar = `${a.cookie}; ${b.cookie}`;
  const liveB = net.connect(f.front.address().port, '127.0.0.1');
  liveB.on('error', () => {});
  const openedB = once(liveB, 'data');
  liveB.write(`GET ${pathB}/api/websockets HTTP/1.1\r\nHost: computer.example.test\r\nOrigin: ${PUBLIC}\r\nCookie: ${jar}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`);
  assert.match(String((await openedB)[0]), /^HTTP\/1.1 101/);
  const invalid = [
    [MEDIA_ROOT, b.cookie], [MEDIA_ROOT, jar], [pathB, a.cookie],
    [pathB, `${b.cookie}; ${b.cookie}`], [pathB, b.cookie.replace(`-${idB}`, '')],
    [MEDIA_ROOT, b.cookie.replace(`-${idB}`, `-${SESSION_ID}`)], ['/desktop', jar],
  ];
  for (const [root, cookie] of invalid) {
    const before = f.observed.length;
    assert.equal((await f.request(`${root}/`, { cookie })).status, 401);
    const socket = net.connect(f.front.address().port, '127.0.0.1');
    socket.on('error', () => {});
    const chunks = [];
    socket.on('data', chunk => chunks.push(chunk));
    const closed = once(socket, 'close');
    socket.write(`GET ${root}/api/websockets HTTP/1.1\r\nHost: computer.example.test\r\nOrigin: ${PUBLIC}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`);
    await closed;
    assert.match(Buffer.concat(chunks).toString(), /^HTTP\/1.1 401/);
    assert.equal(f.observed.length, before, 'rejected identity never dispatches upstream');
  }
  assert.equal((await f.request(`${pathB}/?quality=high`, { cookie: jar })).status, 200);
  assert.equal(f.active(idB), true);
  assert.equal(liveB.destroyed, false);
  const echoedB = once(liveB, 'data');
  liveB.write('B remains usable');
  assert.equal(String((await echoedB)[0]), 'B remains usable');
  const before = f.observed.length;
  assert.equal((await f.request(`${MEDIA_ROOT}/../${idB}/`, { cookie: jar })).status, 400);
  assert.equal(f.observed.length, before);
});

test('exchange rejects a requested session identity different from its actual control grant', async t => {
  const f = await fixture(t);
  const result = await f.request('/desktop/api/exchange', {
    method: 'POST', headers: { origin: PUBLIC, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: '44444444-4444-4444-8444-444444444444', exchangeCode: EXCHANGE_CODE, verifier: VERIFIER }),
  });
  assert.equal(result.status, 401);
  assert.equal(result.headers['set-cookie'], undefined);
  assert.equal(f.broker.sessionCount(), 0);
  assert.equal(f.controlCalls.some(call => call.url.endsWith('/input-transition')), false);
});

test('a transient disconnect reconnects within grace without relinquishing the controller', async t => {
  const f = await fixture(t, { disconnectGraceMs: 250 });
  const { cookie } = await f.exchange();
  const connect = async () => {
    const client = net.connect(f.front.address().port, '127.0.0.1');
    await once(client, 'connect');
    client.write(`GET ${MEDIA_ROOT}/api/websockets HTTP/1.1\r\nHost: computer.example.test\r\nOrigin: ${PUBLIC}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`);
    const [handshake] = await once(client, 'data');
    assert.match(handshake.toString(), /^HTTP\/1\.1 101/);
    return client;
  };
  const first = await connect();
  first.destroy();
  await once(first, 'close');
  await new Promise(resolve => setTimeout(resolve, 40));
  const second = await connect();
  assert.equal(f.broker.sessionCount(), 1);
  assert.equal(f.controlCalls.some(call => call.url.endsWith('/terminate')), false);
  second.destroy();
});

test('a transient control-plane authorization failure does not tear down an active stream', async t => {
  const f = await fixture(t, { authorizationGraceMs: 250 });
  const { cookie } = await f.exchange();
  f.setTransientAuthorizeFailures(1);
  const client = net.connect(f.front.address().port, '127.0.0.1');
  t.after(() => client.destroy());
  await once(client, 'connect');
  client.write(`GET ${MEDIA_ROOT}/api/websockets HTTP/1.1\r\nHost: computer.example.test\r\nOrigin: ${PUBLIC}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`);
  const [handshake] = await once(client, 'data');
  assert.match(handshake.toString(), /^HTTP\/1\.1 101/);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(client.destroyed, false);
  assert.equal(f.broker.sessionCount(), 1);
  assert.equal(f.controlCalls.some(call => call.url.endsWith('/terminate')), false);
});

async function openWatchdogSocket(t, f, cookie, sessionId = SESSION_ID) {
  const client = net.connect(f.front.address().port, '127.0.0.1');
  t.after(() => client.destroy());
  await once(client, 'connect');
  client.write(`GET /desktop/sessions/${sessionId}/api/websockets HTTP/1.1\r\nHost: computer.example.test\r\nOrigin: ${PUBLIC}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`);
  const [handshake] = await once(client, 'data');
  assert.match(handshake.toString(), /^HTTP\/1\.1 101/);
  return client;
}

test('due renewal starts before stalled authorization and watchdog shares one proof across session sockets', async t => {
  const f = await fixture(t, { grantTtlMs: 500, renewalLeadMs: 450, recheckMs: 100 });
  const { cookie } = await f.exchange();
  const clients = [await openWatchdogSocket(t, f, cookie), await openWatchdogSocket(t, f, cookie)];
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const before = f.controlCalls.length;
  f.setAuthorizeBarrier(barrier);
  for (let attempt = 0; attempt < 50 && !f.controlCalls.slice(before).some(call => call.url.endsWith('/authorize')); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const tickCalls = f.controlCalls.slice(before);
  assert.equal(tickCalls.filter(call => call.url.endsWith('/authorize')).length, 1);
  assert.equal(tickCalls[0].url.endsWith('/renew'), true);
  assert.deepEqual(f.renewalDiagnostics, [{ event: 'renew_attempt' }, { event: 'renew_succeeded', httpStatus: 200 }]);
  // Explicit denial after a pending proof still closes every session socket,
  // even though the independent renewal returned a valid extended receipt.
  const closes = clients.map(client => once(client, 'close'));
  f.revoke();
  release();
  await Promise.all(closes);
  for (let attempt = 0; attempt < 50 && f.broker.sessionCount(); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.broker.sessionCount(), 0);
  assert.equal(f.active(), false);
});

test('HTTP authorization denial closes every media socket before input resumes and the session is deleted', async t => {
  const f = await fixture(t, { grantTtlMs: 5000, recheckMs: 1000 });
  const { cookie } = await f.exchange();
  const clients = [await openWatchdogSocket(t, f, cookie), await openWatchdogSocket(t, f, cookie)];
  let resume;
  f.setInputResumeBarrier(new Promise(resolve => { resume = resolve; }));
  t.after(() => resume());
  const closes = clients.map(client => once(client, 'close'));
  f.revoke();
  const denied = f.request(`${MEDIA_ROOT}/`, { cookie });
  await Promise.all(closes);
  assert.equal(f.active(), true);
  assert.equal(f.broker.sessionCount(), 1);
  resume();
  assert.equal((await denied).status, 401);
  assert.equal(f.active(), false);
  assert.equal(f.broker.sessionCount(), 0);
  assert.equal(clients.every(client => client.destroyed), true);
  const proofs = f.controlCalls.filter(call => call.url.endsWith('/authorize')).length;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.controlCalls.filter(call => call.url.endsWith('/authorize')).length, proofs);
});

test('stalled watchdog authorization cannot delay strict expiry or resurrect a closed broker', async t => {
  const f = await fixture(t, { grantTtlMs: 250, renewalLeadMs: 200, renewalSucceeds: false, recheckMs: 100 });
  const { cookie } = await f.exchange();
  const client = await openWatchdogSocket(t, f, cookie);
  let release;
  f.setAuthorizeBarrier(new Promise(resolve => { release = resolve; }));
  t.after(() => release());
  await once(client, 'close');
  assert.equal(f.controlCalls.some(call => call.url.endsWith('/renew')), true);
  await f.broker.close();
  const callsAtClose = f.controlCalls.length;
  release();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.broker.sessionCount(), 0);
  assert.equal(f.controlCalls.length, callsAtClose);
  assert.equal(f.active(), false);
});

for (const ending of ['HTTP finalization', 'broker close']) test(`a delayed accepted upgrade cannot create media after ${ending}`, async t => {
  const f = await fixture(t, { grantTtlMs: 5000, recheckMs: 1000 });
  const { cookie } = await f.exchange();
  const existing = await openWatchdogSocket(t, f, cookie);
  let release;
  f.setAcceptedAuthorizeBarrier(new Promise(resolve => { release = resolve; }));
  t.after(() => release());
  const before = f.controlCalls.filter(call => call.url.endsWith('/authorize')).length;
  const late = net.connect(f.front.address().port, '127.0.0.1');
  t.after(() => late.destroy());
  await once(late, 'connect');
  late.write(`GET ${MEDIA_ROOT}/api/websockets HTTP/1.1\r\nHost: computer.example.test\r\nOrigin: ${PUBLIC}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`);
  for (let attempt = 0; attempt < 50 && f.controlCalls.filter(call => call.url.endsWith('/authorize')).length === before; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(f.controlCalls.filter(call => call.url.endsWith('/authorize')).length, before + 1);
  const closed = once(existing, 'close');
  if (ending === 'HTTP finalization') {
    f.revoke();
    assert.equal((await f.request(`${MEDIA_ROOT}/`, { cookie })).status, 401);
  } else await f.broker.close();
  await closed;
  assert.equal(f.broker.sessionCount(), 0);
  const upstreamBefore = f.observed.filter(record => record.kind === 'websocket').length;
  const answer = once(late, 'data');
  const rejected = once(late, 'close');
  release();
  const [bytes] = await answer;
  assert.match(bytes.toString(), /^HTTP\/1\.1 401/);
  await rejected;
  assert.equal(f.observed.filter(record => record.kind === 'websocket').length, upstreamBefore);
  assert.equal(f.broker.sessionCount(), 0);
  assert.equal(f.active(), false);
});

test('a stalled session proof does not serialize another session renewal or watchdog proof', async t => {
  const f = await fixture(t, { grantTtlMs: 500, renewalLeadMs: 450, recheckMs: 100 });
  const first = await f.exchange();
  await openWatchdogSocket(t, f, first.cookie);
  const secondId = '33333333-3333-4333-8333-333333333333';
  const second = await f.exchange(secondId);
  await openWatchdogSocket(t, f, second.cookie, secondId);
  let release;
  f.setAuthorizeBarrier(new Promise(resolve => { release = resolve; }));
  t.after(() => release());
  const before = f.controlCalls.length;
  for (let attempt = 0; attempt < 50 && f.controlCalls.slice(before).filter(call => call.url.endsWith('/authorize')).length < 2; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const calls = f.controlCalls.slice(before);
  assert.equal(calls.filter(call => call.url.endsWith('/authorize')).length, 2);
  assert.equal(calls.filter(call => call.url.endsWith('/renew')).length, 2);
  assert.equal(calls.slice(0, 2).every(call => call.url.endsWith('/renew')), true);
  release();
});

test('later intervals dispatch due leases behind a stalled four-session proof batch without reentrant proofs', async t => {
  const f = await fixture(t, { grantTtlMs: 1000, renewalLeadMs: 400, renewalDelayMs: 300, recheckMs: 100 });
  for (let index = 1; index <= 5; index++) {
    const sessionId = `${index}1111111-1111-4111-8111-111111111111`;
    const { cookie } = await f.exchange(sessionId);
    await openWatchdogSocket(t, f, cookie, sessionId);
  }
  let release;
  f.setAuthorizeBarrier(new Promise(resolve => { release = resolve; }));
  t.after(() => release());
  const before = f.controlCalls.length;
  for (let attempt = 0; attempt < 30 && f.controlCalls.slice(before).filter(call => call.url.endsWith('/authorize')).length < 4; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(f.controlCalls.slice(before).filter(call => call.url.endsWith('/authorize')).length, 4);
  assert.equal(f.controlCalls.slice(before).some(call => call.url.endsWith('/renew')), false);
  for (let attempt = 0; attempt < 80 && f.controlCalls.slice(before).filter(call => call.url.endsWith('/renew')).length < 5; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await new Promise(resolve => setTimeout(resolve, 120));
  const calls = f.controlCalls.slice(before);
  assert.equal(calls.filter(call => call.url.endsWith('/authorize')).length, 4);
  const renewals = calls.filter(call => call.url.endsWith('/renew'));
  assert.equal(renewals.length, 5);
  assert.equal(new Set(renewals.map(call => call.headers.authorization)).size, 5);
  await f.broker.close();
  const callsAtClose = f.controlCalls.length;
  release();
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(f.controlCalls.length, callsAtClose);
  assert.equal(f.broker.sessionCount(), 0);
  assert.equal(f.renewalDiagnostics.filter(record => record.event === 'renew_succeeded').length, 0);
});

test('an active media connection renews its server lease without reconnecting or exposing the bearer', async t => {
  const f = await fixture(t, { grantTtlMs: 500, renewalLeadMs: 400 });
  const { cookie } = await f.exchange();
  const client = net.connect(f.front.address().port, '127.0.0.1');
  t.after(() => client.destroy());
  await once(client, 'connect');
  client.write(`GET ${MEDIA_ROOT}/api/websockets HTTP/1.1\r\nHost: computer.example.test\r\nOrigin: ${PUBLIC}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`);
  const [handshake] = await once(client, 'data');
  assert.match(handshake.toString(), /^HTTP\/1\.1 101/);

  for (let attempt = 0; attempt < 100 && !f.controlCalls.some(call => call.url.endsWith('/renew')); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const renewal = f.controlCalls.find(call => call.url.endsWith('/renew'));
  assert.ok(renewal);
  assert.deepEqual(renewal.body, { ttlSeconds: 240 });
  assert.equal(renewal.headers.authorization, `Bearer ${SESSION_TOKEN}`);
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.equal(client.destroyed, false);
  assert.equal(f.broker.sessionCount(), 1);
  assert.deepEqual(f.renewalDiagnostics, [{ event: 'renew_attempt' }, { event: 'renew_succeeded', httpStatus: 200 }]);
});

for (const [label, config, outcome] of [
  ['abort', { renewalError: Object.assign(new Error(SESSION_TOKEN + CONTROL), { name: 'AbortError' }) },
    { event: 'renew_failed', failureClass: 'transport', transportKind: 'abort' }],
  ['other transport', { renewalError: new Error(SESSION_TOKEN + CONTROL) },
    { event: 'renew_failed', failureClass: 'transport', transportKind: 'other' }],
  ['invalid receipt', { renewalResponse: new Response(JSON.stringify({ renewed: true, data: { secret: SESSION_TOKEN } }), { status: 200 }) },
    { event: 'renew_failed', failureClass: 'invalid_receipt', httpStatus: 200 }],
]) test(`renewal diagnostics disclose only fixed ${label} classification`, async t => {
  const f = await fixture(t, { grantTtlMs: 250, renewalLeadMs: 200, ...config });
  const { cookie } = await f.exchange();
  const client = net.connect(f.front.address().port, '127.0.0.1');
  t.after(() => client.destroy());
  await once(client, 'connect');
  client.write(`GET ${MEDIA_ROOT}/api/websockets HTTP/1.1\r\nHost: computer.example.test\r\nOrigin: ${PUBLIC}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`);
  await once(client, 'data');
  await once(client, 'close');
  assert.deepEqual(f.renewalDiagnostics, [{ event: 'renew_attempt' }, outcome]);
  const output = JSON.stringify(f.renewalDiagnostics);
  for (const secret of [SESSION_TOKEN, cookie, SESSION_ID, COMPUTER_ID, CONTROL, PUBLIC, BASIC]) assert.equal(output.includes(secret), false);
});

test('a failed renewal never outlives the original lease and still releases isolated input', async t => {
  const f = await fixture(t, { grantTtlMs: 250, renewalLeadMs: 200, renewalSucceeds: false });
  const { cookie } = await f.exchange();
  const client = net.connect(f.front.address().port, '127.0.0.1');
  t.after(() => client.destroy());
  await once(client, 'connect');
  client.write(`GET ${MEDIA_ROOT}/api/websockets HTTP/1.1\r\nHost: computer.example.test\r\nOrigin: ${PUBLIC}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`);
  const [handshake] = await once(client, 'data');
  assert.match(handshake.toString(), /^HTTP\/1\.1 101/);
  await once(client, 'close');
  for (let attempt = 0; attempt < 100 && f.broker.sessionCount() > 0; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(f.controlCalls.some(call => call.url.endsWith('/renew')), true);
  assert.equal(f.broker.sessionCount(), 0);
  assert.equal(f.active(), false);
  assert.equal(f.controlCalls.some(call => call.url.endsWith('/input-transition') && call.body.action === 'agent-input-resumed'), true);
  assert.deepEqual(f.renewalDiagnostics, [{ event: 'renew_attempt' }, { event: 'renew_failed', failureClass: 'http', httpStatus: 503 }]);
});

test('a late renewal success cannot resurrect a session after its original deadline', async t => {
  const f = await fixture(t, { grantTtlMs: 250, renewalLeadMs: 200, renewalDelayMs: 300 });
  const { cookie } = await f.exchange();
  const client = net.connect(f.front.address().port, '127.0.0.1');
  t.after(() => client.destroy());
  await once(client, 'connect');
  client.write(`GET ${MEDIA_ROOT}/api/websockets HTTP/1.1\r\nHost: computer.example.test\r\nOrigin: ${PUBLIC}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`);
  const [handshake] = await once(client, 'data');
  assert.match(handshake.toString(), /^HTTP\/1\.1 101/);
  await once(client, 'close');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(f.controlCalls.some(call => call.url.endsWith('/renew')), true);
  assert.equal(f.broker.sessionCount(), 0);
  assert.equal(f.active(), false);
  assert.deepEqual(f.renewalDiagnostics, [{ event: 'renew_attempt' }, { event: 'renew_failed', failureClass: 'late_result', httpStatus: 200 }]);
});

test('persisted state is mode 0600 and contains no exchange code or verifier', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'hivra-remote-desktop-broker-'));
  const statePath = path.join(directory, 'sessions.json');
  const f = await fixture(t, { statePath });
  await f.exchange();
  assert.equal(statSync(statePath).mode & 0o777, 0o600);
  const state = readFileSync(statePath, 'utf8');
  assert.equal(state.includes(SESSION_TOKEN), true);
  assert.equal(state.includes(EXCHANGE_CODE), false);
  assert.equal(state.includes(VERIFIER), false);
});
