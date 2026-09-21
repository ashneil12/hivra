'use strict';

// Experimental native runtime; public catalog enablement requires acceptance.
// Upstream login authority never crosses this module's private closure.
const http = require('node:http');
const { createHash } = require('node:crypto');

const REQUEST_HEADERS = ['accept', 'accept-language', 'accept-encoding', 'content-type', 'content-length', 'range'];
const RESPONSE_HEADERS = ['content-type', 'content-length', 'content-encoding', 'content-disposition', 'content-range', 'accept-ranges'];
const WS_PATH = '/api/remote.mux';

function canonicalOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) {
    throw new Error('deepseek_public_origin_invalid');
  }
  return url;
}

function requestTarget(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || /[\\\s\x00-\x1f\x7f]/.test(raw)) return null;
  const url = new URL(raw, 'http://native.invalid');
  if (url.hash || url.searchParams.has('token')) return null;
  return url;
}

function copyHeaders(source, allowed) {
  const nominated = new Set(String(source.connection || '').toLowerCase().split(',').map(value => value.trim()));
  const result = {};
  for (const key of allowed) {
    if (!nominated.has(key) && typeof source[key] === 'string') result[key] = source[key];
  }
  return result;
}

function safeResponseHeaders(source) {
  return {
    ...copyHeaders(source, RESPONSE_HEADERS),
    'cache-control': 'private, no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  };
}

/**
 * The caller must supply the canonical per-computer HTTPS origin and a
 * synchronous, re-checkable Hivra session authorizer. Authentication remains
 * required for ALL native routes, including public upstream static/SSE routes.
 * Lifecycle owner calls reset() on child termination, close() on teardown.
 */
function createNativeBroker({ publicOrigin, authorize, upstreamPort = 3080, headerTimeoutMs = 30000, recheckMs = 1000 }) {
  const origin = canonicalOrigin(publicOrigin);
  if (typeof authorize !== 'function' || !Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535
    || !Number.isInteger(headerTimeoutMs) || headerTimeoutMs < 1 || !Number.isInteger(recheckMs) || recheckMs < 1) {
    throw new Error('deepseek_broker_options_invalid');
  }
  const authority = `127.0.0.1:${upstreamPort}`;
  const upstreamOrigin = `http://${authority}`;
  const cookieName = `dsh-auth-${createHash('sha256').update(authority).digest('base64url')}`;
  let cookie = null;
  let expiresAt = 0;
  let generation = 0;
  let closed = false;
  let exchanging = false;
  const connections = new Set();
  const exchanges = new Set();
  const rejectedSockets = new Set();

  function authorized(req) {
    try { return authorize(req) === true; } catch { return false; }
  }

  function ready() { return !closed && cookie !== null && expiresAt > Date.now(); }

  function reset() {
    generation += 1;
    cookie = null;
    expiresAt = 0;
    exchanging = false;
    for (const exchange of exchanges) exchange.destroy();
    for (const socket of rejectedSockets) socket.destroy();
    for (const connection of [...connections]) connection.stop();
  }

  const timer = setInterval(() => {
    for (const connection of [...connections]) {
      if (!ready() || !authorized(connection.req)) connection.stop();
    }
  }, recheckMs);
  timer.unref();

  // Host is checked against configured authority, never merely against Origin.
  function gate(req, websocket) {
    if (!authorized(req)) return 401;
    if (req.headers.host !== origin.host) return 403;
    const target = requestTarget(req.url);
    if (!target) return 400;
    const read = req.method === 'GET' || req.method === 'HEAD';
    const suppliedOrigin = req.headers.origin;
    if (suppliedOrigin !== undefined && suppliedOrigin !== origin.origin) return 403;
    if ((!read || websocket) && suppliedOrigin !== origin.origin) return 403;
    const site = req.headers['sec-fetch-site'];
    // A cross-origin Hivra bootstrap POST -> 303 can legitimately load the
    // authenticated root document. It must not authorize cross-site API reads.
    const initialDocument = !websocket && read && (target.pathname === '/' || target.pathname === '/index.html')
      && req.headers['sec-fetch-mode'] === 'navigate'
      && ['document', 'iframe'].includes(req.headers['sec-fetch-dest']);
    if (site !== undefined && site !== 'same-origin' && site !== 'none' && !initialDocument) return 403;
    if (websocket && (req.method !== 'GET' || target.pathname !== WS_PATH || target.search)) return 404;
    if (!ready()) return 503;
    return 0;
  }

  function outgoingHeaders(req, websocket = false) {
    const headers = {
      ...copyHeaders(req.headers, REQUEST_HEADERS),
      host: authority,
      origin: upstreamOrigin,
      cookie,
      'sec-fetch-site': 'same-origin',
    };
    if (websocket) {
      Object.assign(headers, copyHeaders(req.headers, ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol']));
      headers.connection = 'Upgrade';
      headers.upgrade = 'websocket';
    }
    return headers;
  }

  function error(res, code) {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(code, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    res.end(`Native surface unavailable (${code}).`);
  }

  // Accept ONLY a bounded, complete line from the owned child's stdout. The
  // destination is fixed; a printed URL cannot redirect this broker elsewhere.
  async function acceptLaunchLine(line) {
    if (closed || exchanging || cookie !== null || typeof line !== 'string' || line.length > 256) return false;
    const prefix = `dsh web: ${upstreamOrigin}/?token=`;
    if (!line.startsWith(prefix)) return false;
    const token = line.slice(prefix.length);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, 'base64url').toString('base64url') !== token) return false;
    const ownedGeneration = generation;
    exchanging = true;
    try {
      return await new Promise(resolve => {
        const exchange = http.get({ hostname: '127.0.0.1', port: upstreamPort, path: `/?token=${token}`, agent: false,
          headers: { host: authority }, maxHeaderSize: 8192 }, response => {
          response.resume();
          if (closed || generation !== ownedGeneration || response.statusCode !== 303 || response.headers.location !== '/') {
            resolve(false); return;
          }
          const cookies = response.headers['set-cookie'];
          if (!Array.isArray(cookies) || cookies.length !== 1 || cookies[0].length > 2048) { resolve(false); return; }
          const pair = cookies[0].split(';')[0];
          const match = pair.match(/^([^=]+)=v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/);
          if (!match || match[1] !== cookieName) { resolve(false); return; }
          try {
            // Trust comes from the owned loopback process, not decoding this
            // payload. Check audience/lifetime so stale readiness fails closed.
            const payload = JSON.parse(Buffer.from(match[2], 'base64url').toString('utf8'));
            const now = Date.now();
            if (payload.version !== 1 || payload.authority !== authority || !Number.isSafeInteger(payload.issuedAt)
              || !Number.isSafeInteger(payload.expiresAt) || payload.issuedAt > now || payload.expiresAt <= now
              || payload.expiresAt <= payload.issuedAt || payload.expiresAt - payload.issuedAt > 31 * 86400000) {
              resolve(false); return;
            }
            cookie = pair;
            expiresAt = payload.expiresAt;
            resolve(true);
          } catch { resolve(false); }
        });
        exchanges.add(exchange);
        const deadline = setTimeout(() => exchange.destroy(), headerTimeoutMs);
        exchange.on('error', () => resolve(false));
        exchange.on('close', () => { clearTimeout(deadline); exchanges.delete(exchange); });
      });
    } finally { if (generation === ownedGeneration) exchanging = false; }
  }

  function handleHttp(req, res) {
    // The guest's management router may have set wildcard CORS before dispatch.
    for (const name of res.getHeaderNames()) {
      if (name.toLowerCase().startsWith('access-control-')) res.removeHeader(name);
    }
    const rejection = gate(req, false);
    if (rejection) { error(res, rejection); return; }
    const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method,
      headers: outgoingHeaders(req), agent: false, maxHeaderSize: 16384 });
    const connection = { req, stop: () => { upstream.destroy(); res.destroy(); connections.delete(connection); } };
    connections.add(connection);
    const deadline = setTimeout(() => upstream.destroy(), headerTimeoutMs);
    upstream.on('response', response => {
      clearTimeout(deadline); // SSE must remain streaming after response headers.
      if (!ready() || !authorized(req)) { connection.stop(); return; }
      if (response.statusCode === 401) {
        // Never replay a mutation after losing native authority.
        response.resume();
        connections.delete(connection);
        error(res, 503);
        reset();
        return;
      }
      const headers = safeResponseHeaders(response.headers);
      if (response.headers.location !== undefined) {
        const target = requestTarget(response.headers.location);
        if (!target) { response.destroy(); error(res, 502); return; }
        headers.location = response.headers.location;
      }
      res.writeHead(response.statusCode, headers);
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    upstream.on('error', () => { clearTimeout(deadline); error(res, 502); });
    res.on('close', () => { clearTimeout(deadline); upstream.destroy(); connections.delete(connection); });
    req.on('aborted', connection.stop);
    req.pipe(upstream);
  }

  function handleUpgrade(req, socket, head) {
    const rejection = gate(req, true);
    const key = req.headers['sec-websocket-key'];
    if (rejection || req.headers.upgrade?.toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13'
      || typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key) || Buffer.from(key, 'base64').toString('base64') !== key) {
      // end() alone leaves a half-open upgraded socket alive if the peer never
      // sends FIN. Own rejected sockets too, including under backpressure.
      rejectedSockets.add(socket);
      const deadline = setTimeout(() => socket.destroy(), 1000);
      socket.on('error', () => socket.destroy());
      socket.once('close', () => { clearTimeout(deadline); rejectedSockets.delete(socket); });
      socket.end(`HTTP/1.1 ${rejection || 400} Rejected\r\nConnection: close\r\n\r\n`);
      socket.destroySoon();
      return;
    }
    const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort, path: WS_PATH,
      headers: outgoingHeaders(req, true), agent: false, maxHeaderSize: 16384 });
    let peer;
    const connection = { req, stop: () => {
      // Revocation is an abort, not a graceful WebSocket close handshake. RST
      // prevents a half-open upstream from retaining its side after our FIN.
      if (peer && !peer.destroyed) peer.resetAndDestroy();
      upstream.destroy(); socket.destroy(); connections.delete(connection);
    } };
    connections.add(connection);
    const deadline = setTimeout(connection.stop, headerTimeoutMs);
    upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
      peer = upstreamSocket;
      clearTimeout(deadline);
      const expected = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      const protocol = response.headers['sec-websocket-protocol'];
      const offered = String(req.headers['sec-websocket-protocol'] || '').split(',').map(value => value.trim());
      if (!ready() || !authorized(req) || response.statusCode !== 101 || response.headers['sec-websocket-accept'] !== expected
        || response.headers.upgrade?.toLowerCase() !== 'websocket' || (protocol !== undefined && !offered.includes(protocol))) {
        connection.stop(); return;
      }
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${expected}\r\n${protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : ''}Cache-Control: no-store\r\n\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) peer.write(head);
      peer.on('error', connection.stop);
      peer.on('close', connection.stop);
      socket.pipe(peer).pipe(socket);
    });
    upstream.on('response', response => {
      response.resume();
      if (response.statusCode === 401) reset();
      connection.stop();
    });
    upstream.on('error', connection.stop);
    socket.on('error', connection.stop);
    socket.on('close', () => { clearTimeout(deadline); connection.stop(); });
    upstream.end();
  }

  return Object.freeze({ acceptLaunchLine, handleHttp, handleUpgrade, ready, reset,
    close() { closed = true; reset(); clearInterval(timer); } });
}

module.exports = { createNativeBroker };
