"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { Transform, pipeline } = require("node:stream");

const COOKIE = "__Host-hivra_auth";
const TERMINAL = "/terminal/";
const TOKEN = "/terminal/token";
const WS = "/terminal/ws";
const MAX_FORM = 1024;
const MAX_PAGE = 2 * 1024 * 1024;
const WAIT_MS = 5000;
const SESSION_MS = 15 * 60 * 1000;
const WS_IDLE_MS = 5 * 60 * 1000;
const PROOF_SECONDS = 60;
const PROOF = /^v1\.([1-9][0-9]{0,10})\.([a-f0-9]{32})\.([a-f0-9]{64})$/;
const digest = (value) => crypto.createHash("sha256").update(value).digest();
const nonce = () => crypto.randomBytes(32).toString("base64url");

function httpsOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || /[\s;'*"<>]/.test(value)) {
    throw new Error("Expected a canonical HTTPS origin");
  }
  return url;
}

function loadKey(filename) {
  if (!path.isAbsolute(filename)) throw new Error("Signing key path must be absolute");
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== 0 || ![0o400, 0o440, 0o600].includes(stat.mode & 0o7777)) {
      throw new Error("Signing key must be root-owned and private");
    }
    const bytes = Buffer.alloc(66);
    const size = fs.readSync(fd, bytes);
    const token = bytes.toString("latin1", 0, size);
    if (!/^[a-f0-9]{64}\n?$/.test(token)) throw new Error("Expected a 32-byte hex application key");
    return Buffer.from(token.slice(0, 64), "hex");
  } finally {
    fs.closeSync(fd);
  }
}

function checkJournal(dirname) {
  const stat = fs.lstatSync(dirname);
  if (!path.isAbsolute(dirname) || fs.realpathSync(dirname) !== dirname ||
      !stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700) {
    throw new Error("Expected a private host redemption journal directory");
  }
}

function redeem(dirname, nonce, now) {
  checkJournal(dirname);
  const marker = path.join(dirname, nonce);
  let count = 0;
  for (const name of fs.readdirSync(dirname)) {
    if (!/^[a-f0-9]{32}$/.test(name)) throw new Error("Invalid redemption journal entry");
    const file = path.join(dirname, name);
    if (fs.statSync(file).mtimeMs + (PROOF_SECONDS + 1) * 1000 <= now) fs.unlinkSync(file);
    else count++;
  }
  if (fs.existsSync(marker)) return false;
  if (count >= 256) throw responseError(429);
  try {
    fs.closeSync(fs.openSync(marker, "wx", 0o600));
  } catch (err) {
    if (err.code === "EEXIST") return false;
    throw err;
  }
  const dir = fs.openSync(dirname, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    fs.fsyncSync(dir);
  } finally {
    fs.closeSync(dir);
  }
  return true;
}

function socketIdentity(filename) {
  const folder = path.dirname(filename);
  const dir = fs.lstatSync(folder, { bigint: true });
  const socket = fs.lstatSync(filename, { bigint: true });
  const hostUser = (uid) => uid === 0n || uid === BigInt(process.getuid());
  if (!dir.isDirectory() || fs.realpathSync(folder) !== folder || !hostUser(dir.uid) || (dir.mode & 0o022n) !== 0n ||
      !socket.isSocket() || !hostUser(socket.uid) || (socket.mode & 0o002n) !== 0n) {
    throw new Error("Expected a host-controlled terminal socket");
  }
  return `${dir.dev}:${dir.ino}:${socket.dev}:${socket.ino}`;
}

function respond(res, status, body = "", headers = {}) {
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'",
    "Content-Type": "text/plain; charset=utf-8",
    ...headers,
  });
  res.end(body);
}

function responseError(status) {
  return Object.assign(new Error("Gateway request rejected"), { status });
}

async function readBody(stream, limit) {
  let bytes = 0;
  const parts = [];
  for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > limit) throw responseError(413);
    parts.push(chunk);
  }
  return Buffer.concat(parts, bytes);
}

function byteLimit(maxBytes) {
  let bytes = 0;
  return new Transform({
    transform(chunk, encoding, done) {
      bytes += chunk.length;
      if (bytes > maxBytes) return done(new Error("Terminal byte budget exhausted"));
      done(null, chunk);
    },
  });
}

function createGateway({ origin, embedOrigin, owner, sandbox, socketPath, keyFile, journalDir }, { sessionMs = SESSION_MS } = {}) {
  const publicUrl = httpsOrigin(origin);
  if (embedOrigin) httpsOrigin(embedOrigin);
  if (!/^[a-f0-9]{64}$/.test(owner || "") ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(sandbox || "")) {
    throw new Error("Expected a pinned owner hash and sandbox UUID");
  }
  if (!path.isAbsolute(socketPath) || path.normalize(socketPath) !== socketPath) throw new Error("Expected a fixed Unix socket path");
  const binding = socketIdentity(socketPath);
  const signingKey = loadKey(keyFile);
  checkJournal(journalDir);
  const bootId = nonce();
  const sessions = new Map();
  let retired = false;
  let pendingHttp = 0;
  let openWebSocket = false;
  let closeWebSocket;

  function bindingCurrent() {
    if (retired) return false;
    try {
      if (socketIdentity(socketPath) === binding) return true;
    } catch {}
    retired = true;
    sessions.clear();
    closeWebSocket?.();
    return false;
  }

  function sessionFor(req) {
    const values = (req.headers.cookie || "").split(";").map((entry) => entry.trim())
      .filter((entry) => entry.startsWith(COOKIE + "="));
    if (values.length !== 1) return;
    const value = values[0].slice(COOKIE.length + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return;
    const key = digest(value).toString("hex");
    const session = sessions.get(key);
    if (session?.expires > Date.now()) return session;
    sessions.delete(key);
  }

  async function bootstrap(req, res) {
    const source = req.headers.origin;
    if (source && source !== "null" && source !== origin && source !== embedOrigin) return respond(res, 403);
    if (!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(req.headers["content-type"] || "")) {
      return respond(res, 415);
    }
    if (Number(req.headers["content-length"]) > MAX_FORM) throw responseError(413);
    const timer = setTimeout(() => req.destroy(), WAIT_MS);
    let form;
    try {
      form = new URLSearchParams((await readBody(req, MAX_FORM)).toString("utf8"));
    } finally {
      clearTimeout(timer);
    }
    const proof = PROOF.exec(form.get("token") || "");
    const now = Date.now();
    const nowSeconds = Math.floor(now / 1000);
    if ([...form].length !== 2 || form.get("destination") !== TERMINAL || !proof ||
        Number(proof[1]) <= nowSeconds || Number(proof[1]) > nowSeconds + PROOF_SECONDS) return respond(res, 401);
    const [, expires, challenge, mac] = proof;
    const expected = crypto.createHmac("sha256", signingKey).update(`v1\n${origin}\n${owner}\n${sandbox}\n${expires}\n${challenge}`).digest();
    if (!crypto.timingSafeEqual(Buffer.from(mac, "hex"), expected)) return respond(res, 401);
    if (!bindingCurrent()) return respond(res, 503);
    for (const [key, session] of sessions) {
      if (session.expires <= now) sessions.delete(key);
    }
    if (sessions.size >= 64) return respond(res, 429);
    if (!redeem(journalDir, challenge, now)) return respond(res, 401);
    const value = nonce();
    sessions.set(digest(value).toString("hex"), { expires: now + sessionMs });
    respond(res, 303, "", {
      Location: TERMINAL,
      "Set-Cookie": `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${Math.ceil(sessionMs / 1000)}`,
      "Content-Security-Policy": `default-src 'none'; frame-ancestors 'self'${embedOrigin ? " " + embedOrigin : ""}`,
    });
  }

  async function proxyPage(res, route, session) {
    if (pendingHttp >= 8) return respond(res, 429);
    pendingHttp++;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), WAIT_MS);
    const onClose = () => abort.abort();
    res.once("close", onClose);
    const upstream = http.request({
      socketPath, path: route, agent: false, signal: abort.signal, maxHeaderSize: 8192,
      headers: { Host: publicUrl.host, "Accept-Encoding": "identity" },
    });
    try {
      const incoming = await new Promise((resolve, reject) => {
        upstream.once("response", resolve);
        upstream.on("error", reject);
        upstream.end();
      });
      if (incoming.statusCode !== 200 || (incoming.headers["content-encoding"] ?? "identity") !== "identity") {
        throw responseError(502);
      }
      const body = await readBody(incoming, route === TOKEN ? 1024 : MAX_PAGE);
      if (session.expires <= Date.now()) return respond(res, 401);
      if (!bindingCurrent()) return respond(res, 503);
      if (route === TOKEN) {
        const value = JSON.parse(body.toString("utf8"));
        if (!value || value.token !== "" || Object.keys(value).length !== 1) throw responseError(502);
        return respond(res, 200, '{"token":""}', { "Content-Type": "application/json; charset=utf-8" });
      }
      respond(res, 200, body, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": `frame-ancestors 'self'${embedOrigin ? " " + embedOrigin : ""}; base-uri 'none'; object-src 'none'`,
      });
    } catch {
      if (!res.destroyed) respond(res, abort.signal.aborted ? 504 : 502);
    } finally {
      clearTimeout(timer);
      res.off("close", onClose);
      upstream.destroy();
      pendingHttp--;
    }
  }

  async function handle(req, res) {
    if (req.headers.host !== publicUrl.host) return respond(res, 421);
    if (req.method === "POST" && req.url === "/auth/bootstrap") return bootstrap(req, res);
    if (req.method !== "GET" || req.headers["transfer-encoding"] || Number(req.headers["content-length"]) > 0) {
      return respond(res, 405, "", { Connection: "close" });
    }
    if (req.url === "/api/meta") {
      const cors = embedOrigin && req.headers.origin === embedOrigin ? { "Access-Control-Allow-Origin": embedOrigin } : {};
      return respond(res, 200, JSON.stringify({ agentKind: "claude", surfaceAuth: "post-cookie-v1", bootId }), {
        "Content-Type": "application/json; charset=utf-8", Vary: "Origin", ...cors,
      });
    }
    const route = req.url === TERMINAL || req.url === TOKEN ? req.url : null;
    if (!route) return respond(res, 404);
    const session = sessionFor(req);
    if (!session) return respond(res, 401);
    if (!bindingCurrent()) return respond(res, 503);
    return proxyPage(res, route, session);
  }

  const server = http.createServer({
    maxHeaderSize: 8192, headersTimeout: WAIT_MS, requestTimeout: WAIT_MS,
    keepAliveTimeout: WAIT_MS, connectionsCheckingInterval: 1000,
  }, (req, res) => {
    handle(req, res).catch((err) => {
      if (!res.destroyed) respond(res, err.status || 500, "", { Connection: "close" });
    });
  });
  server.setTimeout(WAIT_MS);
  server.maxConnections = 32;
  server.maxRequestsPerSocket = 32;
  server.on("connect", (_req, socket) => socket.destroy());
  for (const event of ["checkContinue", "checkExpectation"]) {
    server.on(event, (_req, res) => respond(res, 417, "", { Connection: "close" }));
  }
  server.on("upgrade", (req, client, head) => {
    const deny = (status) => client.end(
      `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => client.destroy()
    );
    client.on("error", () => client.destroy());
    if (req.headers.host !== publicUrl.host || req.headers.origin !== origin) return deny("403 Forbidden");
    if (req.method !== "GET" || req.url !== WS) return deny("404 Not Found");
    const session = sessionFor(req);
    if (!session) return deny("401 Unauthorized");
    const key = req.headers["sec-websocket-key"] || "";
    if (req.headers.upgrade?.toLowerCase() !== "websocket" || req.headers["sec-websocket-version"] !== "13" ||
        req.headers["sec-websocket-protocol"] !== "tty" || !/^[A-Za-z0-9+/]{22}==$/.test(key) ||
        req.headers["transfer-encoding"] || Number(req.headers["content-length"]) > 0) return deny("400 Bad Request");
    if (!bindingCurrent()) return deny("503 Service Unavailable");
    if (openWebSocket) return deny("429 Too Many Requests");
    openWebSocket = true;
    client.pause();

    const upstream = http.request({
      socketPath, path: WS, agent: false, maxHeaderSize: 8192,
      headers: {
        Host: publicUrl.host, Origin: origin, Connection: "Upgrade", Upgrade: "websocket",
        "Sec-WebSocket-Version": "13", "Sec-WebSocket-Protocol": "tty", "Sec-WebSocket-Key": key,
      },
    });
    let peer;
    const deadline = setTimeout(() => client.destroy(), session.expires - Date.now());
    const handshake = setTimeout(() => {
      upstream.destroy();
      deny("504 Gateway Timeout");
    }, WAIT_MS);
    closeWebSocket = () => client.destroy();
    client.once("close", () => {
      clearTimeout(handshake);
      clearTimeout(deadline);
      upstream.destroy();
      peer?.destroy();
      openWebSocket = false;
      closeWebSocket = undefined;
    });
    upstream.on("error", () => {
      if (!client.destroyed && !client.writableEnded) deny("502 Bad Gateway");
    });
    upstream.on("response", (res) => {
      res.destroy();
      deny("502 Bad Gateway");
    });
    upstream.on("upgrade", (res, socket, upstreamHead) => {
      clearTimeout(handshake);
      const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      if (client.destroyed || client.writableEnded || session.expires <= Date.now() || !bindingCurrent() ||
          res.statusCode !== 101 || res.headers.upgrade?.toLowerCase() !== "websocket" ||
          res.headers["sec-websocket-accept"] !== accept || res.headers["sec-websocket-protocol"] !== "tty" ||
          res.headers["sec-websocket-extensions"]) {
        socket.destroy();
        if (!client.destroyed && !client.writableEnded) deny("502 Bad Gateway");
        return;
      }
      peer = socket;
      client.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: tty\r\n\r\n`);
      client.setTimeout(WS_IDLE_MS, () => client.destroy());
      peer.setTimeout(WS_IDLE_MS, () => peer.destroy());
      if (head.length) client.unshift(head);
      if (upstreamHead.length) peer.unshift(upstreamHead);
      pipeline(client, byteLimit(8 * 1024 * 1024), peer, () => client.destroy());
      pipeline(peer, byteLimit(64 * 1024 * 1024), client, () => client.destroy());
    });
    upstream.end();
  });
  server.on("close", () => sessions.clear());
  return {
    listen: (port, callback) => server.listen(port, "127.0.0.1", callback),
    close: (callback) => {
      closeWebSocket?.();
      server.close(callback);
      server.closeAllConnections();
    },
  };
}

function main() {
  const env = process.env;
  try {
    const port = Number(env.HIVRA_TERMINAL_GATEWAY_PORT);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Expected a non-privileged loopback port");
    const gateway = createGateway({
      origin: env.HIVRA_TERMINAL_GATEWAY_ORIGIN,
      embedOrigin: env.HIVRA_TERMINAL_GATEWAY_EMBED_ORIGIN,
      owner: env.HIVRA_TERMINAL_GATEWAY_OWNER,
      sandbox: env.HIVRA_TERMINAL_GATEWAY_SANDBOX,
      socketPath: env.HIVRA_TERMINAL_GATEWAY_SOCKET,
      keyFile: env.HIVRA_TERMINAL_GATEWAY_KEY_FILE,
      journalDir: env.HIVRA_TERMINAL_GATEWAY_JOURNAL_DIR,
    });
    const stop = () => gateway.close(() => { process.exitCode = 0; });
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    gateway.listen(port).on("error", () => {
      console.error("Terminal gateway could not listen on loopback");
      process.exitCode = 1;
    });
  } catch {
    console.error("Terminal gateway startup rejected: check host binding, origins, signing key, journal, and port");
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { createGateway };
