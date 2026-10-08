'use strict';

const http = require('node:http');
const { Readable } = require('node:stream');
const { createHash } = require('node:crypto');
const { createWorkspaceControl } = require('./workspace-control.cjs');
const { workspaceRequestAllowed } = require('./workspace-access-policy.cjs');
const { workspaceHandoffHtml } = require('./workspace-handoff.cjs');
const SESSION = /^\/workspace\/sessions\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(\/.*)$/;

function sessionTarget(raw) {
  if (typeof raw !== 'string' || raw.length > 8192 || /[\\\s\x00-\x1f\x7f#]/.test(raw)) return null;
  const match = SESSION.exec(raw);
  if (!match) return null;
  const target = new URL(raw, 'http://workspace.invalid');
  if (target.pathname !== raw.split('?')[0]) return null;
  return { sessionId: match[1], url: match[2] };
}

function createWorkspaceRouter(options, { terminalRequest = http.request } = {}) {
  const publicUrl = new URL(options.publicOrigin), controlUrl = new URL(options.controlOrigin);
  if (publicUrl.protocol !== 'https:' || publicUrl.origin !== options.publicOrigin
    || controlUrl.protocol !== 'https:' || controlUrl.origin !== options.controlOrigin
    || !['list', 'read', 'write'].every(key => typeof options.files?.[key] === 'function')) throw new Error('workspace_router_configuration_invalid');
  const control = createWorkspaceControl(options);
  // The computer's shell listens on a bux-owned unix socket when its terminal
  // unit is from the socket release; older units keep the loopback port.
  // null while a socket-release terminal restarts: never fall back to the port.
  const boxTerminal = () => {
    const target = typeof options.boxTerminal === 'function' ? options.boxTerminal() : null;
    if (target && target.unavailable) return null;
    return target && typeof target.socketPath === 'string' ? { socketPath: target.socketPath } : { host: '127.0.0.1', port: 7682 };
  };
  let closed = false, pending = 0;
  const sockets = new Set(), upstreams = new Set();
  const headers = { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff', 'content-security-policy': `frame-ancestors 'self' ${controlUrl.origin}` };
  function reply(res, status, body) {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(status, { ...headers, 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }
  const deny = res => reply(res, 403, { error: 'Workspace access denied', code: 'workspace_authorization_denied' });
  function authority(req) {
    return !closed && req.headers.host === publicUrl.host && !req.headers.authorization;
  }
  async function readBody(req, limit = 2048, timeout = 5000) {
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')
      || req.headers['content-encoding']) throw new Error('invalid_body');
    const timer = setTimeout(() => req.destroy(), timeout);
    let size = 0; const chunks = [];
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw new Error('invalid_body');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } finally { clearTimeout(timer); }
  }
  // Only fixed ttyd routes reach this proxy. Neither management credentials nor
  // workspace cookies/forwarded browser authority are passed to the terminal.
  function terminalHttp(req, res, url) {
    const terminal = boxTerminal();
    if (!terminal) return reply(res, 503, { error: 'Terminal restarting' });
    const upstream = terminalRequest({ ...terminal, method: 'GET', path: url,
      headers: { accept: typeof req.headers.accept === 'string' ? req.headers.accept : '*/*' } });
    upstreams.add(upstream);
    const timer = setTimeout(() => upstream.destroy(), 15000);
    const finish = () => { clearTimeout(timer); upstreams.delete(upstream); };
    res.once('close', () => { upstream.destroy(); finish(); });
    upstream.once('error', () => { finish(); reply(res, 502, { error: 'Terminal unavailable' }); });
    upstream.once('response', response => {
      if (response.statusCode !== 200) { response.destroy(); upstream.destroy(); finish(); return reply(res, 502, { error: 'Terminal unavailable' }); }
      const type = response.headers['content-type'];
      if (typeof type !== 'string' || !/^(text\/html|application\/json)(?:;|$)/i.test(type)) {
        response.destroy(); upstream.destroy(); finish(); return reply(res, 502, { error: 'Terminal unavailable' });
      }
      res.writeHead(200, { ...headers, 'content-type': type });
      let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 4 * 1024 * 1024) { response.destroy(); res.destroy(); } });
      response.once('error', () => res.destroy());
      response.once('end', finish);
      response.pipe(res);
    });
    upstream.end();
  }
  async function handleHttp(req, res) {
    if (!authority(req)) return deny(res);
    if (req.url === '/workspace/handoff' && req.method === 'GET') {
      res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8',
        'content-security-policy': `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self' ${controlUrl.origin}` });
      return res.end(workspaceHandoffHtml(controlUrl.origin));
    }
    if (pending >= 16) return reply(res, 429, { error: 'Workspace busy' });
    pending++;
    try {
      if (req.url === '/workspace/exchange' && req.method === 'POST') {
        if (req.headers.origin !== publicUrl.origin) return deny(res);
        const receipt = await control.exchangeAndMint(JSON.parse((await readBody(req)).toString('utf8')));
        if (!receipt || closed || res.destroyed) return deny(res);
        res.setHeader('set-cookie', receipt.cookie);
        return reply(res, 200, { sessionId: receipt.sessionId, surface: receipt.surface, expiresAt: receipt.expiresAt,
          path: `/workspace/sessions/${receipt.sessionId}${receipt.surface === 'files' ? '/api/files' : '/box-terminal/'}` });
      }
      const target = sessionTarget(req.url);
      if (!target) return reply(res, 404, { error: 'Workspace route unavailable' });
      const scoped = { method: req.method, url: target.url, headers: req.headers };
      if (!await control.authorize(target.sessionId, scoped) || closed || res.destroyed) return deny(res);
      for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
      if (workspaceRequestAllowed('box-terminal', scoped)) return terminalHttp(req, res, target.url);
      const url = new URL(target.url, publicUrl.origin);
      if (req.method === 'GET') return url.pathname === '/api/files'
        ? options.files.list(res, url.searchParams) : options.files.read(res, url.searchParams);
      // Buffer a bounded upload, then recheck authority before dispatching the
      // existing guarded writer. A slow upload must not outlive its grant.
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')
        || req.headers['content-encoding']) return reply(res, 415, { error: 'JSON required' });
      const body = await readBody(req, Math.floor(512 * 1024 * 1.4), 15000);
      if (!await control.authorize(target.sessionId, scoped) || closed || res.destroyed) return deny(res);
      const replay = Object.assign(Readable.from([body]), { method: 'POST', url: target.url,
        headers: { 'content-type': 'application/json', 'content-length': String(body.length) } });
      return options.files.write(replay, res);
    } catch { return reply(res, 400, { error: 'Workspace request unavailable' }); }
    finally { pending--; }
  }
  async function handleUpgrade(req, socket, head) {
    let release, upstream, peer;
    const close = () => { release?.(); socket.destroy(); peer?.destroy(); upstream?.destroy(); sockets.delete(close); };
    try {
      const target = sessionTarget(req.url);
      if (!authority(req) || !target || head.length > 65536) return close();
      const scoped = { method: req.method, url: target.url, headers: req.headers };
      const key = req.headers['sec-websocket-key'];
      if (!workspaceRequestAllowed('box-terminal', scoped) || req.headers['sec-websocket-version'] !== '13'
        || typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key)
        || req.headers['sec-websocket-protocol'] !== 'tty') return close();
      release = await control.attachSocket(target.sessionId, scoped, close);
      if (!release || closed || socket.destroyed) return close();
      sockets.add(close); socket.once('close', close); socket.once('error', close);
      const terminal = boxTerminal();
      if (!terminal) return close();
      upstream = terminalRequest({ ...terminal, method: 'GET', path: target.url,
        headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13',
          'sec-websocket-key': key, 'sec-websocket-protocol': 'tty' } });
      const timer = setTimeout(close, 5000);
      upstream.once('close', () => clearTimeout(timer));
      upstream.once('response', close); upstream.once('error', close);
      upstream.once('upgrade', (response, stream, buffered) => {
        clearTimeout(timer); peer = stream;
        const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        if (closed || socket.destroyed || response.statusCode !== 101 || response.headers['sec-websocket-accept'] !== accept
          || response.headers['sec-websocket-protocol'] !== 'tty') return close();
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: tty\r\n\r\n`);
        stream.once('error', close); stream.once('close', close);
        if (head.length) stream.write(head);
        if (buffered.length) socket.write(buffered);
        stream.pipe(socket); socket.pipe(stream);
      });
      upstream.end();
    } catch { close(); }
  }
  function close() { closed = true; control.close(); for (const stop of sockets) stop(); for (const upstream of upstreams) upstream.destroy(); }
  return { handleHttp, handleUpgrade, close };
}

module.exports = { createWorkspaceRouter, sessionTarget };
