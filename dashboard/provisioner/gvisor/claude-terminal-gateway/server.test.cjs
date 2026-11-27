"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const { test } = require("node:test");
const { createGateway } = require("./server.cjs");

const origin = "https://terminal.qa.example";
const embedOrigin = "https://dashboard.qa.example";
const host = new URL(origin).host;
const wsHeaders = {
  Origin: origin, Connection: "Upgrade", Upgrade: "websocket",
  "Sec-WebSocket-Version": "13", "Sec-WebSocket-Protocol": "tty",
  "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"),
};

async function fixture(t, options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-gateway-"));
  const socketPath = path.join(dir, "tty.sock");
  const keyFile = path.join(dir, "key");
  const journalDir = path.join(dir, "journal");
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, key.toString("hex"), { mode: 0o600 });
  fs.mkdirSync(journalDir, 0o700);
  let tokenBody = '{"token":""}';
  const seen = [];
  const wsSockets = new Set();
  const upstream = http.createServer((req, res) => {
    seen.push(req);
    res.setHeader("Set-Cookie", "test-upstream=not-forwarded");
    res.setHeader("X-Upstream-Header", "not-forwarded");
    res.end(req.url === "/terminal/token" ? tokenBody : "<!doctype html><title>Terminal fixture</title>");
  });
  upstream.on("upgrade", (req, socket) => {
    seen.push(req);
    wsSockets.add(socket);
    socket.once("close", () => wsSockets.delete(socket));
    const accept = crypto.createHash("sha1")
      .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(Buffer.concat([
      Buffer.from("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: tty\r\nSet-Cookie: not-forwarded=1\r\n\r\n`),
      Buffer.from([0x82, 0x02, 0x30, 0x41]),
    ]));
    socket.on("data", (data) => {
      const payload = Buffer.from(data.subarray(6));
      for (let i = 0; i < payload.length; i++) payload[i] ^= data[2 + i % 4];
      socket.write(Buffer.concat([Buffer.from([0x82, payload.length]), payload]));
    });
  });
  await new Promise((resolve) => upstream.listen(socketPath, resolve));
  fs.chmodSync(socketPath, 0o600);
  const config = { origin, embedOrigin, owner: "b".repeat(64), sandbox: "22222222-2222-4222-8222-222222222222", socketPath, keyFile, journalDir };
  let gateway;
  let port;
  const closeGateway = async () => {
    if (gateway) await new Promise((resolve) => gateway.close(resolve));
    gateway = null;
  };
  t.after(async () => {
    await closeGateway();
    for (const socket of wsSockets) socket.destroy();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function restart() {
    await closeGateway();
    gateway = createGateway(config, options);
    const listener = gateway.listen(0);
    await once(listener, "listening");
    port = listener.address().port;
    assert.equal(listener.address().address, "127.0.0.1");
  }
  await restart();
  function request(route, { headers, body, method = body === undefined ? "GET" : "POST" } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1", port, path: route, method, agent: false, headers: { Host: host, ...headers },
      }, async (res) => {
        try {
          const parts = [];
          for await (const part of res) parts.push(part);
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString() });
        } catch (err) { reject(err); }
      });
      req.on("upgrade", (res, socket, head) => resolve({ status: res.statusCode, headers: res.headers, socket, head }));
      req.on("error", reject);
      req.end(body);
    });
  }
  function mint({ expiry = Math.floor(Date.now() / 1000) + 30, audience = origin, sandbox = config.sandbox } = {}) {
    const nonce = crypto.randomBytes(16).toString("hex");
    const mac = crypto.createHmac("sha256", key).update(`v1\n${audience}\n${config.owner}\n${sandbox}\n${expiry}\n${nonce}`).digest("hex");
    return `v1.${expiry}.${nonce}.${mac}`;
  }
  function signIn({ token = mint(), destination = "/terminal/", source = embedOrigin } = {}) {
    return request("/auth/bootstrap", {
      headers: { Origin: source, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, destination }).toString(),
    });
  }
  return { config, request, mint, signIn, restart, seen, setTokenBody: (body) => { tokenBody = body; } };
}

const cookieFrom = (res) => res.headers["set-cookie"][0].split(";", 1)[0];

test("browser bootstrap and credential-free HTTP proxy", async (t) => {
  const { request, mint, signIn, seen, setTokenBody } = await fixture(t);
  const meta = await request("/api/meta", { headers: { Origin: embedOrigin } });
  const data = JSON.parse(meta.body);
  assert.equal(meta.status, 200);
  assert.equal(meta.headers["access-control-allow-origin"], embedOrigin);
  assert.equal(meta.headers["cache-control"], "no-store");
  assert.equal(data.surfaceAuth, "post-cookie-v1");
  assert.equal(data.agentKind, "claude");
  assert.match(data.bootId, /^[A-Za-z0-9_-]{43}$/);
  const proof = mint();
  const signed = await signIn({ token: proof });
  assert.equal(signed.status, 303);
  assert.equal(signed.headers.location, "/terminal/");
  assert.equal(signed.body, "");
  assert.match(signed.headers["set-cookie"][0], /^__Host-hivra_auth=[\w-]+; Path=\/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=900$/);
  const headers = { Cookie: cookieFrom(signed) + "; other=not-forwarded", Authorization: "Bearer test-only", "X-Forwarded-For": "192.0.2.1" };
  const html = await request("/terminal/", { headers });
  assert.equal(html.status, 200);
  assert.match(html.body, /Terminal fixture/);
  assert.match(html.headers["content-security-policy"], /frame-ancestors 'self' https:\/\/dashboard.qa.example/);
  assert.equal(html.headers["set-cookie"], undefined);
  assert.equal(html.headers["x-upstream-header"], undefined);
  const token = await request("/terminal/token", { headers });
  assert.equal(token.status, 200);
  assert.deepEqual(JSON.parse(token.body), { token: "" });
  assert.deepEqual(seen.map((req) => req.url), ["/terminal/", "/terminal/token"]);
  for (const req of seen) {
    for (const header of ["authorization", "cookie", "x-forwarded-for"]) assert.equal(req.headers[header], undefined);
  }
  setTokenBody('{"token":"fixture-native-credential"}');
  const unexpected = await request("/terminal/token", { headers });
  assert.equal(unexpected.status, 502);
  assert.equal(unexpected.body, "");
});

test("denies nonterminal routes, wrong host and origins, and invalid proofs", async (t) => {
  const { request, mint, signIn, seen } = await fixture(t);
  assert.equal((await request("/api/meta", { headers: { Host: "wrong.qa.example" } })).status, 421);
  assert.equal((await request("/api/meta", { headers: { Origin: "https://unapproved.qa.example" } })).headers["access-control-allow-origin"], undefined);
  assert.equal((await request("/terminal/")).status, 401);
  assert.equal((await request("/terminal/token", { headers: { Authorization: "Bearer test-only" } })).status, 401);
  assert.equal((await signIn({ source: "https://unapproved.qa.example" })).status, 403);
  assert.equal((await signIn({ token: "not-a-bootstrap-proof" })).status, 401);
  assert.equal((await signIn({ token: mint({ audience: embedOrigin }) })).status, 401);
  assert.equal((await signIn({ token: mint({ sandbox: "33333333-3333-4333-8333-333333333333" }) })).status, 401);
  assert.equal((await signIn({ token: mint({ expiry: Math.floor(Date.now() / 1000) - 1 }) })).status, 401);
  assert.equal((await signIn({ token: mint({ expiry: Math.floor(Date.now() / 1000) + 70 }) })).status, 401);
  assert.equal((await signIn({ destination: "/box-terminal/" })).status, 401);
  assert.equal((await signIn({ token: "a".repeat(1024) })).status, 413);
  const headers = { Cookie: cookieFrom(await signIn({ source: "null" })) };
  for (const route of ["/terminal", "/terminal/ws", "/api/chat", "/box-terminal/", "/terminal/token?arg=1"]) {
    assert.equal((await request(route, { headers })).status, 404);
  }
  assert.equal((await request("/terminal/", { method: "POST", headers })).status, 405);
  assert.equal(seen.length, 0);
});

test("a proof is one-use even after restart and the old cookie is invalid", async (t) => {
  const { request, mint, signIn, restart } = await fixture(t);
  const boot = JSON.parse((await request("/api/meta")).body).bootId;
  const token = mint();
  const pair = await Promise.all([signIn({ token }), signIn({ token })]);
  assert.deepEqual(pair.map((res) => res.status).sort(), [303, 401]);
  const headers = { Cookie: cookieFrom(pair.find((res) => res.status === 303)) };
  await restart();
  assert.notEqual(JSON.parse((await request("/api/meta")).body).bootId, boot);
  assert.equal((await signIn({ token })).status, 401);
  assert.equal((await request("/terminal/", { headers })).status, 401);
  assert.equal((await signIn()).status, 303);
});

test("the pinned upstream cannot be repointed mid-process", async (t) => {
  const { config, request, signIn, seen } = await fixture(t);
  const headers = { Cookie: cookieFrom(await signIn()) };
  fs.renameSync(config.socketPath, config.socketPath + ".old");
  assert.equal((await request("/terminal/", { headers })).status, 503);
  fs.renameSync(config.socketPath + ".old", config.socketPath);
  assert.equal((await request("/terminal/", { headers })).status, 401);
  assert.equal((await signIn()).status, 503);
  assert.equal(seen.length, 0);
});

test("only a same-origin WebSocket with a valid cookie carries tty frames", async (t) => {
  const { request, signIn, seen } = await fixture(t);
  const upgrade = (headers, route = "/terminal/ws") => request(route, {
    headers: Object.fromEntries(Object.entries({ ...wsHeaders, ...headers }).filter(([, value]) => value !== undefined)),
  });
  assert.equal((await upgrade()).status, 401);
  const Cookie = cookieFrom(await signIn());
  assert.equal((await upgrade({ Cookie, Origin: embedOrigin })).status, 403);
  assert.equal((await upgrade({ Cookie, Origin: undefined })).status, 403);
  assert.equal((await upgrade({ Cookie }, "/terminal/")).status, 404);
  const ws = await upgrade({ Cookie, Authorization: "Bearer test-only", "Sec-WebSocket-Extensions": "permessage-deflate" });
  assert.equal(ws.status, 101);
  assert.equal(ws.headers["sec-websocket-protocol"], "tty");
  assert.equal(ws.headers["sec-websocket-extensions"], undefined);
  assert.equal(ws.headers["set-cookie"], undefined);
  assert.equal((await upgrade({ Cookie })).status, 429);
  assert.deepEqual(ws.head.length ? ws.head : (await once(ws.socket, "data"))[0], Buffer.from([0x82, 0x02, 0x30, 0x41]));
  const message = once(ws.socket, "data");
  ws.socket.write(Buffer.from([0x82, 0x82, 0x12, 0x34, 0x56, 0x78, 0x30 ^ 0x12, 0x42 ^ 0x34]));
  assert.deepEqual((await message)[0], Buffer.from([0x82, 0x02, 0x30, 0x42]));
  const [req] = seen;
  assert.equal(seen.length, 1);
  assert.equal(req.headers.host, host);
  assert.equal(req.headers.origin, origin);
  for (const header of ["authorization", "cookie", "sec-websocket-extensions"]) assert.equal(req.headers[header], undefined);
  ws.socket.destroy();
});

test("cookie expiry rejects HTTP, closes the active socket, and denies reconnect", async (t) => {
  const { request, signIn } = await fixture(t, { sessionMs: 500 });
  const Cookie = cookieFrom(await signIn());
  const ws = await request("/terminal/ws", { headers: { ...wsHeaders, Cookie } });
  assert.equal(ws.status, 101);
  ws.socket.resume();
  const closed = once(ws.socket, "close");
  await Promise.race([closed, delay(2000, undefined, { ref: false }).then(() => { throw new Error("WebSocket did not close on expiry"); })]);
  assert.equal((await request("/terminal/", { headers: { Cookie } })).status, 401);
  assert.equal((await request("/terminal/ws", { headers: { ...wsHeaders, Cookie } })).status, 401);
});
