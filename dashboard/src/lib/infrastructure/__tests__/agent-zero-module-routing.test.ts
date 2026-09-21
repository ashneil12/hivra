import crypto from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net, { type AddressInfo, type Socket } from "node:net";
import path from "node:path";
import vm from "node:vm";
import WebSocket, { WebSocketServer } from "ws";

const TOKEN = "b".repeat(64);
const ORIGIN = "https://agent-zero.hivra.test";
const RUNTIME_ID = "0123456789abcdef";
const CSRF_TOKEN = "c".repeat(43);
const NATIVE_COOKIE = `session_${RUNTIME_ID}=rotated-csrf`;
const PRIVATE_COOKIE = `${NATIVE_COOKIE}; csrf_token_${RUNTIME_ID}=${CSRF_TOKEN}`;
const EDITOR_ROOT = "/components/modals/file-editor/";
const EDITOR_FIXTURES = Object.fromEntries(["file-editor-store.js", "file-edit-modal.html"].map(name =>
  [EDITOR_ROOT + name, readFileSync(path.join(process.cwd(), "runtime-adapters/agent-zero-native/fixtures", name))]));
const { rewriteNativeEditorAsset } = createRequire(path.join(process.cwd(), "provisioner/hivra-chat/server.js"))("./agent-zero-editor.cjs");
const ENTRY_HTML = '<!doctype html><title>Native fixture</title><!-- <script type="module" src="index.js"></script> -->'
  + '<script>globalThis.untouchedExample = \'<script type="module" src="index.js">\';</script>'
  + '<script type="module" src="index.js"></script><script type="module" src="js/initFw.js"></script>'
  + '<script src="other.js"></script><a href="index.js">unchanged link</a><p>Native café</p>';
const MODULES: Record<string, string> = {
  "/index.js": 'import "./js/components.js"; globalThis.entryRuns = (globalThis.entryRuns || 0) + 1; export const identity = {}; (globalThis.identities ||= []).push(identity);',
  "/js/components.js": 'import "/index.js"; globalThis.componentRuns = (globalThis.componentRuns || 0) + 1;',
  "/js/initFw.js": 'import "/js/components.js"; globalThis.frameworkRuns = (globalThis.frameworkRuns || 0) + 1; const blob = URL.createObjectURL(new Blob([`import { identity } from "${location.origin}/index.js"; globalThis.blobIdentity = identity;`], {type:"text/javascript"})); await import(blob); URL.revokeObjectURL(blob); await import("/extensions/webui/json_api_call_after/cache_reset.js"); globalThis.graphReady = true;',
  "/extensions/webui/json_api_call_after/cache_reset.js": 'import "/index.js"; globalThis.extensionRuns = (globalThis.extensionRuns || 0) + 1;',
};

describe("Agent Zero mounted module graph", () => {
  let gateway: http.Server;
  let upstream: http.Server;
  let port: number;
  let moduleGraph = false;
  let requireNativeCsrf = false;
  let editorRedirect = false;
  const wsServer = new WebSocketServer({ noServer: true });
  let csrfFixture = { mode: "valid", runtimeId: RUNTIME_ID, token: CSRF_TOKEN, session: "rotated-csrf" };
  let loginFixture: "absent" | "held" | "delayed" | "ready" = "absent";
  let releaseCsrf: (() => void) | undefined;
  let csrfHeld: (() => void) | undefined;
  const warnings: string[] = [];
  const upgrades: { path: string; headers: http.IncomingHttpHeaders }[] = [];
  const sockets = new Set<Socket>();
  const dispatched: { method: string; path: string; body: string; cookie?: string; authorization?: string; headers: http.IncomingHttpHeaders }[] = [];
  const track = (server: http.Server) => server.on("connection", socket => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
  });

  async function request(url: string, options: { ref?: string; method?: string; body?: string; auth?: boolean; cookie?: string; headers?: http.OutgoingHttpHeaders; timeoutMs?: number } = {}) {
    return new Promise<{ status: number; location?: string; cache?: string; body: string; cookies?: string[]; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path: url,
        method: options.method ?? "GET", agent: false,
        headers: { Host: "agent-zero.hivra.test", ...(options.auth === false ? {} : { Authorization: `Bearer ${TOKEN}` }),
          ...(options.ref ? { Referer: ORIGIN + options.ref } : {}), ...(options.cookie ? { Cookie: options.cookie } : {}), ...options.headers } }, res => {
        let body = ""; res.setEncoding("utf8"); res.on("data", chunk => { body += chunk; });
        res.once("end", () => resolve({ status: res.statusCode!, location: res.headers.location,
          cache: res.headers["cache-control"], body, cookies: res.headers["set-cookie"], headers: res.headers }));
      });
      req.once("error", reject); req.setTimeout(options.timeoutMs ?? 2000, () => req.destroy(new Error("Request timed out")));
      req.end(options.body);
    });
  }

  async function upgrade(url: string, headers: http.OutgoingHttpHeaders) {
    return new Promise<number>((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path: url, agent: false,
        headers: { Host: "agent-zero.hivra.test", Connection: "Upgrade", Upgrade: "websocket",
          "Sec-WebSocket-Key": Buffer.alloc(16, 1).toString("base64"), "Sec-WebSocket-Version": "13", ...headers } });
      req.once("upgrade", (res, socket) => { socket.destroy(); resolve(res.statusCode!); });
      req.once("response", res => { res.resume(); res.once("end", () => resolve(res.statusCode!)); });
      req.once("error", error => (error as NodeJS.ErrnoException).code === "ECONNRESET" ? resolve(0) : reject(error));
      req.setTimeout(2000, () => req.destroy(new Error("Fixture upgrade timed out")));
      req.end();
    });
  }

  async function sessionCookie() {
    const result = await request("/auth/bootstrap", { method: "POST", auth: false,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: TOKEN, destination: "/agent-zero/" }).toString() });
    expect(result.status).toBe(303);
    return result.cookies![0].split(";")[0];
  }

  async function nativeActivation(clientToken = csrfFixture.token) {
    requireNativeCsrf = true;
    return new Promise<{ activated: string[]; error: string | null }>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`, {
        headers: { Host: "agent-zero.hivra.test", Origin: ORIGIN, Authorization: `Bearer ${TOKEN}`, Cookie: "session=untrusted; csrf_token_attacker=untrusted" },
      });
      const timeout = setTimeout(() => { socket.terminate(); reject(new Error("Native activation fixture timed out")); }, 2000);
      socket.once("open", () => socket.send(JSON.stringify({ event: "state_request", handlers: ["ws_webui"], csrf_token: clientToken })));
      socket.once("message", body => { clearTimeout(timeout); socket.terminate(); requireNativeCsrf = false; resolve(JSON.parse(body.toString())); });
      socket.once("error", error => { clearTimeout(timeout); requireNativeCsrf = false; reject(error); });
    });
  }

  async function resetNativeCsrf() {
    await request("/agent-zero/fixture/clear-session");
    csrfFixture = { mode: "valid", runtimeId: RUNTIME_ID, token: CSRF_TOKEN, session: "rotated-csrf" };
    releaseCsrf = undefined; csrfHeld = undefined;
  }

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      let body = ""; req.setEncoding("utf8"); req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        dispatched.push({ method: req.method!, path: req.url!, body, headers: req.headers,
          ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
          ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) });
        const nativeUrl = new URL(req.url!, ORIGIN);
        const variant = nativeUrl.searchParams.get("fixture");
        if (EDITOR_FIXTURES[nativeUrl.pathname]) {
          if (editorRedirect) {
            editorRedirect = false;
            res.writeHead(302, { Location: "/login?next=editor" });
            return res.end();
          }
          let source = EDITOR_FIXTURES[nativeUrl.pathname];
          if (variant === "drift") source = Buffer.concat([source, Buffer.from("\n")]);
          if (variant === "oversize") source = Buffer.alloc(65537);
          if (variant === "timeout-headers") return;
          res.writeHead(variant === "status" ? 304 : 200, {
            "Content-Type": variant === "mime" ? "text/plain" : nativeUrl.pathname.endsWith(".html") ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8",
            "Content-Encoding": variant === "encoding" ? "gzip" : "identity",
            ...(variant === "chunked-oversize" || variant === "timeout-body" ? {} : { "Content-Length": source.length }),
            ETag: '"original-editor"', "Last-Modified": "Fri, 04 Sep 2026 10:00:00 GMT", "Content-Digest": "original",
            "Cache-Control": "public, max-age=3600", "Set-Cookie": "editor_expired=; Max-Age=0; Path=/; HttpOnly",
          });
          if (variant === "timeout-body") { res.flushHeaders(); return; }
          if (variant === "chunked-oversize") { res.write(source); return res.end(Buffer.alloc(65537)); }
          return res.end(req.method === "HEAD" ? undefined : source);
        }
        if (nativeUrl.pathname === "/login") {
          if (loginFixture === "held") return;
          const timer = setTimeout(() => {
            res.writeHead(302, { Location: "/", "Set-Cookie": `session_${csrfFixture.runtimeId}=${csrfFixture.session}; Path=/; HttpOnly` });
            res.end();
          }, loginFixture === "delayed" ? 2800 : 0);
          res.once("close", () => clearTimeout(timer));
          return;
        }
        if (["/", "/index.html", "/other.html"].includes(nativeUrl.pathname)) {
          let html = ENTRY_HTML;
          if (variant === "missing") html = html.replace('<script type="module" src="js/initFw.js"></script>', "");
          if (variant === "duplicate") html += '<script type="module" src="index.js"></script>';
          if (variant === "oversize") html += "x".repeat(1024 * 1024);
          if (variant === "chunked-oversize") {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.write(html); return res.end("x".repeat(1024 * 1024));
          }
          res.writeHead(200, { "Content-Type": variant === "plain" ? "text/plain" : "text/html; charset=utf-8",
            "Content-Length": Buffer.byteLength(html), ETag: '"native-original"', "Last-Modified": "Fri, 04 Sep 2026 10:00:00 GMT",
            "Content-Encoding": variant === "encoded" ? "gzip" : "identity", "Content-MD5": "original-digest",
            Digest: "sha-256=original", "Accept-Ranges": "bytes", "Cache-Control": "public, max-age=3600" });
          return res.end(req.method === "HEAD" ? undefined : html);
        }
        if (["/api/csrf_token", "/fixture/csrf-lookalike"].includes(nativeUrl.pathname)) {
          const current = { ...csrfFixture };
          if (current.mode === "login-redirect") {
            csrfFixture.mode = "valid";
            res.writeHead(302, { Location: "/login?next=/api/csrf_token" });
            return res.end();
          }
          let json = JSON.stringify({ ok: true, token: current.token, runtime_id: current.runtimeId });
          if (current.mode === "json") json = "{malformed";
          if (current.mode === "contract") json = JSON.stringify({ ok: true, token: "unsafe; cookie=injection", runtime_id: current.runtimeId });
          if (current.mode === "runtime") json = JSON.stringify({ ok: true, token: current.token, runtime_id: "bad;runtime" });
          if (current.mode === "runtime-mismatch") json = JSON.stringify({ ok: true, token: current.token, runtime_id: "fedcba9876543210" });
          if (current.mode === "oversize") json += " ".repeat(16 * 1024);
          const respond = () => {
            res.writeHead(current.mode === "status" ? 503 : 200, { "Content-Type": current.mode === "mime" ? "text/plain" : "application/json",
              "Content-Encoding": current.mode === "encoding" ? "gzip" : "identity", ETag: '"native-csrf"',
              ...(["chunked-oversize", "trickle", "delayed-trickle"].includes(current.mode) ? {} : { "Content-Length": Buffer.byteLength(json) }),
              "Set-Cookie": current.mode === "no-session" ? [] : [`session_${current.runtimeId}=${current.session}; Path=/; HttpOnly`, "native_aux=retained; Path=/"] });
            if (current.mode === "timeout" || current.mode === "held-body") { res.flushHeaders(); releaseCsrf = () => res.end(json); csrfHeld?.(); return; }
            if (current.mode === "chunked-oversize") { res.write(json); return res.end(" ".repeat(16 * 1024)); }
            if (current.mode === "trickle" || current.mode === "delayed-trickle") {
              res.write(json.slice(0, 1));
              const interval = setInterval(() => res.write(" "), 400);
              const timer = setTimeout(() => res.end(json.slice(1)), 3000);
              res.once("close", () => { clearInterval(interval); clearTimeout(timer); });
              return;
            }
            res.end(req.method === "HEAD" ? undefined : json);
          };
          if (current.mode === "held-headers" || current.mode === "timeout-headers") { releaseCsrf = respond; csrfHeld?.(); return; }
          if (current.mode === "delayed-trickle") {
            const timer = setTimeout(respond, 2800);
            res.once("close", () => clearTimeout(timer));
            return;
          }
          return respond();
        }
        if (nativeUrl.pathname === "/fixture/clear-all") {
          res.writeHead(200, { "Set-Cookie": [`session_${RUNTIME_ID}=; Max-Age=0; Path=/`, "session_fedcba9876543210=; Max-Age=0; Path=/", "native_aux=; Max-Age=0; Path=/"] });
          return res.end("cleared");
        }
        if (nativeUrl.pathname === "/fixture/clear-session") {
          res.writeHead(200, { "Set-Cookie": `session_${csrfFixture.runtimeId}=; Max-Age=0; Path=/` }); return res.end("cleared");
        }
        if (nativeUrl.pathname === "/fixture/session") {
          res.writeHead(200, { "Set-Cookie": `session_${csrfFixture.runtimeId}=${csrfFixture.session}; Path=/` }); return res.end("session changed");
        }
        if (nativeUrl.pathname === "/fixture/expire-old-session") {
          res.writeHead(200, { "Set-Cookie": `session_${RUNTIME_ID}=; Max-Age=0; Path=/` }); return res.end("old session cleared");
        }
        if (nativeUrl.pathname === "/fixture/aux") {
          res.writeHead(200, { "Set-Cookie": "native_aux=changed; Path=/" }); return res.end("aux changed");
        }
        if (nativeUrl.pathname === "/fixture/csrf-cookie-only") {
          res.writeHead(200, { "Set-Cookie": `csrf_token_${csrfFixture.runtimeId}=untrusted; Path=/` }); return res.end("cookie only");
        }
        if (req.url === "/api/load_webui_extensions") {
          const valid = req.headers.cookie === `${NATIVE_COOKIE}; native_aux=retained; csrf_token_${RUNTIME_ID}=${CSRF_TOKEN}`;
          res.writeHead(valid ? 200 : 403, { "Content-Type": "application/json", "Set-Cookie": "native_aux=; Max-Age=0; Path=/" });
          return res.end(valid ? '{"extensions":[]}' : '{"error":"invalid native session"}');
        }
        res.writeHead(200, { "Content-Type": "text/javascript" });
        if (nativeUrl.pathname === "/other.js") return res.end("globalThis.classicUnchanged = true;");
        if (moduleGraph && MODULES[nativeUrl.pathname]) return res.end(MODULES[nativeUrl.pathname]);
        res.end(req.url === "/js/first.js" ? 'import "./second.js";' : "export const ready = true;");
      });
    });
    upstream.on("upgrade", (req, socket) => {
      upgrades.push({ path: req.url!, headers: req.headers });
      if (requireNativeCsrf) return wsServer.handleUpgrade(req, socket, Buffer.alloc(0), client => {
        client.once("message", raw => {
          const auth = JSON.parse(raw.toString());
          const cookies = new Map(String(req.headers.cookie || "").split(/;\s*/).map(pair => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));
          const activated = auth.handlers?.includes("ws_webui") && auth.csrf_token === csrfFixture.token
            && cookies.get(`session_${csrfFixture.runtimeId}`) === csrfFixture.session
            && cookies.get(`csrf_token_${csrfFixture.runtimeId}`) === csrfFixture.token;
          client.send(JSON.stringify({ activated: activated ? ["ws_webui"] : [], error: activated ? null : "NO_HANDLERS" }));
        });
      });
      const accept = crypto.createHash("sha1").update(String(req.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
    });
    track(upstream); upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
    const serverPath = path.join(process.cwd(), "provisioner/hivra-chat/server.js");
    const realRequire = createRequire(serverPath);
    const denyProcess = () => { throw new Error("Fixture must not execute a process"); };
    vm.runInNewContext(readFileSync(serverPath, "utf8"), {
      require: (name: string) => {
        if (name === "http") return { ...http, createServer: (handler: http.RequestListener) => {
          gateway = http.createServer(handler); track(gateway); return gateway;
        } };
        if (name === "fs") return { readFileSync: (filename: string) => {
          if (filename === "/home/bux/.hivra/api-token") return TOKEN;
          if (filename === "/home/bux/.hivra/agent-zero-login" && loginFixture !== "absent") return "AUTH_LOGIN=fixture-login\nAUTH_PASSWORD=fixture-password\n";
          throw Object.assign(new Error("Fixture file absent"), { code: "ENOENT" });
        } };
        if (name === "child_process") return { spawn: denyProcess, execFile: denyProcess };
        if (name === "path") return path;
        if (name === "net") return net;
        if (name === "crypto") return crypto;
        if (["./llm-application.js", "./guarded-files.cjs", "./agent-zero-editor.cjs"].includes(name)) return realRequire(name);
        throw new Error(`Unexpected dependency ${name}`);
      },
      process: { env: { HIVRA_CHAT_PORT: "0", HIVRA_AGENT_KIND: "agent-zero",
        AGENT_ZERO_PORT: String((upstream.address() as AddressInfo).port) } },
      __dirname: path.dirname(serverPath), Buffer, URL, URLSearchParams, setTimeout, clearTimeout,
      console: { log() {}, warn(...values: unknown[]) { warnings.push(values.join(" ")); }, error() {} },
    }, { filename: serverPath, timeout: 2000 });
    if (!gateway.listening) await once(gateway, "listening");
    port = (gateway.address() as AddressInfo).port;
  });

  afterAll(async () => {
    for (const client of wsServer.clients) client.terminate();
    wsServer.close();
    for (const socket of sockets) socket.destroy();
    await Promise.all([gateway, upstream].map(server => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    })));
  });

  it("directly serves root imports so nested relative imports retain canonical root identities", async () => {
    const first = await request("/js/first.js?v=1", { ref: "/agent-zero/index.js" });
    expect(first).toMatchObject({ status: 200, location: undefined });
    expect(dispatched.at(-1)?.path).toBe("/js/first.js?v=1");
    const secondUrl = new URL("./second.js", ORIGIN + "/js/first.js?v=1").pathname;
    expect(secondUrl).toBe("/js/second.js");
    expect(await request(secondUrl, { ref: "/js/first.js" })).toMatchObject({ status: 200, body: "export const ready = true;" });
  });

  it.each(Object.keys(EDITOR_FIXTURES))("transforms only the pinned native editor at root and mounted paths: %s", async asset => {
    for (const prefix of ["", "/agent-zero"]) {
      const before = dispatched.length;
      expect(await request(prefix + asset, { auth: false })).toMatchObject({ status: 401 });
      expect(dispatched).toHaveLength(before);
      const expected = rewriteNativeEditorAsset(asset, EDITOR_FIXTURES[asset]);
      const result = await request(prefix + asset + "?v=fixture", {
        headers: { "Accept-Encoding": "gzip", Range: "bytes=0-10", "If-None-Match": '"original-editor"' },
      });
      expect(result).toMatchObject({ status: 200, body: expected.toString(), cache: "no-store" });
      expect(result.cookies).toBeUndefined();
      expect(result.headers["content-length"]).toBe(String(expected.length));
      for (const name of ["etag", "last-modified", "content-digest", "content-encoding"]) expect(result.headers[name]).toBeUndefined();
      expect(dispatched.at(-1)?.headers).toMatchObject({ "accept-encoding": "identity" });
      expect(dispatched.at(-1)?.headers.range).toBeUndefined();
      expect(dispatched.at(-1)?.headers["if-none-match"]).toBeUndefined();
      expect(dispatched.at(-1)?.authorization).toBeUndefined();
      const head = await request(prefix + asset, { method: "HEAD" });
      expect(head).toMatchObject({ status: 200, body: "", cache: "no-store" });
      expect(head.headers["content-length"]).toBe(String(expected.length));
      expect(dispatched.at(-1)?.method).toBe("GET");
    }
  });

  it.each(["drift", "mime", "status", "encoding", "oversize", "chunked-oversize"])("rejects invalid native editor responses rather than serving mixed sources: %s", async variant => {
    for (const method of ["GET", "HEAD"]) {
      const result = await request(EDITOR_ROOT + "file-editor-store.js?fixture=" + variant, { method });
      expect(result).toMatchObject({ status: 502, cache: "no-store", body: method === "HEAD" ? "" : "native editor asset unavailable" });
    }
  });

  it.each(["timeout-headers", "timeout-body"])("bounds the native editor request including %s", async variant => {
    const started = Date.now();
    const result = await request(EDITOR_ROOT + "file-editor-store.js?fixture=" + variant, { timeoutMs: 12000 });
    expect(result).toMatchObject({ status: 502, cache: "no-store", body: "native editor asset unavailable" });
    expect(Date.now() - started).toBeLessThan(11500);
  }, 15000);

  it("also canonicalizes root imports from an already-mounted dependency", async () => {
    expect(await request("/components/state.js", { ref: "/agent-zero/js/first.js" }))
      .toMatchObject({ status: 200, location: undefined });
  });

  it("does not redirect or dispatch native assets without owner authentication", async () => {
    const before = dispatched.length;
    const result = await request("/js/first.js", { ref: "/agent-zero/index.js", auth: false });
    expect(result.status).toBe(401); expect(result.location).toBeUndefined(); expect(dispatched).toHaveLength(before);
  });

  it("does not capture dashboard management requests", async () => {
    expect(await request("/api/meta")).toMatchObject({ status: 200 });
    expect(await request("/api/settings", { ref: "/dashboard/agent/fixture" })).toMatchObject({ status: 404 });
  });

  it("keeps writes on one original proxy dispatch with their body intact", async () => {
    const before = dispatched.length;
    expect(await request("/settings_set", { ref: "/agent-zero/", method: "POST", body: '{"fixture":true}' }))
      .toMatchObject({ status: 200 });
    expect(dispatched.slice(before)).toEqual([expect.objectContaining({ method: "POST", path: "/settings_set", body: '{"fixture":true}' })]);
  });

  it.each(["components", "plugins", "vendor", "js", "extensions/webui"])("routes authenticated %s imports from blob modules without a Referer", async namespace => {
    expect(await request(`/${namespace}/fixture.js`)).toMatchObject({ status: 200, location: undefined });
    expect(await request(`/${namespace}/fixture.js`, { auth: false })).toMatchObject({ status: 401, location: undefined });
  });

  it("limits extensions to the webui static namespace and GET/HEAD without a Referer", async () => {
    const before = dispatched.length;
    const exact = "/extensions/webui/json_api_call_after/cache_reset.js";
    expect(await request(exact, { method: "HEAD" })).toMatchObject({ status: 200, body: "", location: undefined });
    expect(await request(exact, { method: "HEAD", auth: false })).toMatchObject({ status: 401 });
    for (const url of ["/extensions", "/extensions/private.js", "/extensions/webui", "/extensions/webui-other/file.js"])
      expect(await request(url)).toMatchObject({ status: 404 });
    expect(await request(exact, { method: "POST", body: "{}" })).toMatchObject({ status: 404 });
    expect(dispatched.slice(before)).toEqual([expect.objectContaining({ method: "HEAD", path: exact })]);
  });

  it.each(["GET", "HEAD"])("routes only the exact native entry module without a Referer for %s", async method => {
    const before = dispatched.length;
    const alias = await request("/index.js?v=fixture", { method });
    expect(alias).toMatchObject({ status: 200, location: undefined, body: method === "HEAD" ? "" : "export const ready = true;" });
    expect(dispatched.slice(before)).toEqual([expect.objectContaining({ method, path: "/index.js?v=fixture" })]);
    expect(await request("/index.js", { method, auth: false })).toMatchObject({ status: 401, location: undefined });
    expect(await request("/index.js/other", { method })).toMatchObject({ status: 404 });
    expect(await request("/other.js", { method })).toMatchObject({ status: 404 });
    expect(dispatched).toHaveLength(before + 1);
  });

  it.each(["/agent-zero/", "/agent-zero/index.html?v=1"])("canonicalizes only the two native entry tags at %s", async url => {
    const result = await request(url, { headers: { "Accept-Encoding": "gzip, br", "If-None-Match": '"old"', "If-Modified-Since": "yesterday", "If-Match": '"old"', "If-Unmodified-Since": "yesterday", Range: "bytes=0-10", "If-Range": '"old"' } });
    const expected = ENTRY_HTML.replace('<script type="module" src="index.js"></script><script type="module" src="js/initFw.js"></script>',
      '<script type="module" src="/index.js"></script><script type="module" src="/js/initFw.js"></script>');
    expect(result).toMatchObject({ status: 200, body: expected, cache: "no-store" });
    expect(result.headers["content-length"]).toBe(String(Buffer.byteLength(expected)));
    for (const name of ["content-encoding", "transfer-encoding", "etag", "last-modified", "content-md5", "digest", "accept-ranges"]) expect(result.headers[name]).toBeUndefined();
    expect(dispatched.at(-1)?.headers["accept-encoding"]).toBe("identity");
    for (const name of ["if-none-match", "if-modified-since", "if-match", "if-unmodified-since", "range", "if-range"]) expect(dispatched.at(-1)?.headers[name]).toBeUndefined();
  });

  it("keeps HEAD bodyless and upstream HEAD without stale representation metadata", async () => {
    const result = await request("/agent-zero/", { method: "HEAD" });
    expect(result).toMatchObject({ status: 200, body: "", cache: "no-store" });
    expect(dispatched.at(-1)?.method).toBe("HEAD");
    for (const name of ["content-length", "content-encoding", "etag", "last-modified", "digest", "content-md5"]) expect(result.headers[name]).toBeUndefined();
  });

  it.each(["encoded", "missing", "duplicate", "oversize", "chunked-oversize"])("fails closed for an unsafe %s entry document", async variant => {
    expect(await request(`/agent-zero/?fixture=${variant}`)).toMatchObject({ status: 502, body: "native entry document unavailable", cache: "no-store" });
    const reason = variant === "encoded" ? "unexpected-encoding" : variant.includes("oversize") ? "size-limit" : "entry-contract";
    expect(warnings.at(-1)).toBe(`Agent Zero native entry document rejected: ${reason}`);
  });

  it.each(["encoded", "oversize"])("also rejects known unsafe %s headers for HEAD", async variant => {
    expect(await request(`/agent-zero/?fixture=${variant}`, { method: "HEAD" })).toMatchObject({ status: 502, body: "", cache: "no-store" });
  });

  it("leaves other HTML routes, non-HTML responses and writes untouched", async () => {
    for (const [url, method] of [["/agent-zero/other.html", "GET"], ["/agent-zero/?fixture=plain", "GET"], ["/agent-zero/", "POST"]]) {
      const result = await request(url, { method });
      expect(result).toMatchObject({ status: 200, body: ENTRY_HTML });
      expect(result.headers.etag).toBe('"native-original"');
    }
  });

  // Opt in for the focused runtime gate; ordinary unit CI does not download a browser.
  (process.env.HIVRA_A0_BROWSER_TEST === "1" ? it : it.skip)("initializes the real browser ModuleMap only once through the actual gateway", async () => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    moduleGraph = true;
    try {
      const context = await browser.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${TOKEN}` } });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${port}/agent-zero/`);
      await page.waitForFunction(() => (globalThis as typeof globalThis & { graphReady?: boolean }).graphReady === true);
      const result = await page.evaluate(() => {
        const state = globalThis as typeof globalThis & { entryRuns: number; componentRuns: number; frameworkRuns: number; extensionRuns: number; identities: unknown[]; blobIdentity: unknown; classicUnchanged: boolean };
        return { entry: state.entryRuns, components: state.componentRuns, framework: state.frameworkRuns, extensions: state.extensionRuns,
          identities: state.identities.length, blobSharesEntry: state.blobIdentity === state.identities[0], classicUnchanged: state.classicUnchanged };
      });
      expect(errors).toEqual([]);
      expect(result).toEqual({ entry: 1, components: 1, framework: 1, extensions: 1, identities: 1, blobSharesEntry: true, classicUnchanged: true });
    } finally { moduleGraph = false; await browser.close(); }
  }, 20000);

  it("does not rehome no-Referer APIs or writes as static imports", async () => {
    const before = dispatched.length;
    expect(await request("/api/load_webui_extensions", { method: "POST", body: "{}" })).toMatchObject({ status: 404 });
    expect(await request("/components/fixture.js", { method: "POST", body: "{}" })).toMatchObject({ status: 404 });
    expect(await request("/index.js", { method: "POST", body: "{}" })).toMatchObject({ status: 404 });
    expect(dispatched).toHaveLength(before);
  });

  it("never forwards browser backend cookies or management bearer on a native upgrade without a cached session", async () => {
    expect(await upgrade("/socket.io/?EIO=4&transport=websocket", { Authorization: `Bearer ${TOKEN}`, Cookie: "session=untrusted" })).toBe(101);
    expect(upgrades.at(-1)?.headers.cookie).toBeUndefined();
    expect(upgrades.at(-1)?.headers.authorization).toBeUndefined();
  });

  it("retains rotated backend sessions privately so the next native CSRF request works", async () => {
    const csrf = await request("/agent-zero/api/csrf_token", { cookie: "browser_backend=untrusted" });
    expect(csrf.status).toBe(200); expect(csrf.cookies).toBeUndefined();
    expect(dispatched.at(-1)?.cookie).toBeUndefined();
    const extensions = await request("/api/load_webui_extensions", { ref: "/agent-zero/", method: "POST", body: "{}", cookie: "session=stale-browser" });
    expect(extensions).toMatchObject({ status: 200, body: '{"extensions":[]}' });
    expect(extensions.cookies).toBeUndefined();
    await request("/agent-zero/js/second.js");
    expect(dispatched.at(-1)?.cookie).toBe(PRIVATE_COOKIE);
  });

  it("does not forward the Hivra management bearer into the native backend", async () => {
    const before = dispatched.length;
    await request("/agent-zero/js/second.js");
    const upstreamRequests = dispatched.slice(before);
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0].authorization).toBeUndefined();
    expect(JSON.stringify(upstreamRequests)).not.toContain(TOKEN);
  });

  it.each(["GET", "POST"])("routes exact root Socket.IO polling %s with its original query/body and private backend session", async method => {
    const before = dispatched.length;
    const url = "/socket.io/?EIO=4&transport=polling&sid=fixture";
    expect(await request(url, { method, ...(method === "POST" ? { body: "fixture-packet" } : {}), cookie: "session=untrusted" }))
      .toMatchObject({ status: 200, location: undefined });
    expect(dispatched.slice(before)).toEqual([expect.objectContaining({ method, path: url,
      body: method === "POST" ? "fixture-packet" : "", cookie: PRIVATE_COOKIE })]);
    expect(dispatched.at(-1)?.authorization).toBeUndefined();
    expect(await request(url, { method, auth: false })).toMatchObject({ status: 401 });
  });

  it("retains the cookie Origin gate for root polling POST without capturing neighboring paths or methods", async () => {
    const cookie = await sessionCookie();
    const before = dispatched.length;
    const url = "/socket.io/?EIO=4&transport=polling&sid=fixture";
    expect(await request(url, { auth: false, cookie })).toMatchObject({ status: 200 });
    for (const origin of [undefined, "https://other.hivra.test"])
      expect(await request(url, { method: "POST", auth: false, cookie, headers: origin ? { Origin: origin } : {} })).toMatchObject({ status: 401 });
    expect(await request(url, { method: "POST", auth: false, cookie, headers: { Origin: ORIGIN }, body: "fixture-packet" })).toMatchObject({ status: 200 });
    for (const path of ["/socket.io", "/socket.io/other", "/socket.io-other/", "/ws"])
      expect(await request(path)).toMatchObject({ status: 404 });
    expect(await request(url, { method: "PUT", body: "fixture-packet" })).toMatchObject({ status: 404 });
    expect(dispatched).toHaveLength(before + 2);
  });

  it("upgrades only the exact root Socket.IO endpoint with owner session and same-box Origin", async () => {
    const cookie = await sessionCookie();
    const url = "/socket.io/?EIO=4&transport=websocket";
    const before = upgrades.length;
    for (const headers of [{}, { Cookie: cookie }, { Cookie: cookie, Origin: "https://other.hivra.test" }])
      expect(await upgrade(url, headers)).toBe(401);
    expect(await upgrade(url, { Cookie: cookie + "; session=untrusted", Origin: ORIGIN })).toBe(101);
    expect(upgrades.slice(before)).toEqual([expect.objectContaining({ path: url })]);
    expect(upgrades.at(-1)?.headers.cookie).toBe(PRIVATE_COOKIE);
    expect(upgrades.at(-1)?.headers.authorization).toBeUndefined();
    for (const path of ["/socket.io", "/socket.io/other", "/socket.io-other/", "/ws", "/api/socket"])
      expect(await upgrade(path, { Authorization: `Bearer ${TOKEN}` })).toBe(0);
    expect(upgrades).toHaveLength(before + 1);
  });

  it("activates a native WebSocket handler only after binding the exact CSRF JSON to its private session", async () => {
    await resetNativeCsrf();
    expect(await nativeActivation()).toEqual({ activated: [], error: "NO_HANDLERS" });
    const result = await request("/api/csrf_token", { ref: "/agent-zero/", headers: { "Accept-Encoding": "gzip", "If-None-Match": '"stale"' } });
    // The existing document-origin GET redirect stays intact; capture occurs at
    // the exact native endpoint, not at a new unauthenticated root whitelist.
    expect(result.status).toBe(307);
    const csrf = await request(result.location!, { headers: { "Accept-Encoding": "gzip", "If-None-Match": '"stale"' } });
    expect(await nativeActivation()).toEqual({ activated: ["ws_webui"], error: null });
    expect(csrf).toMatchObject({ status: 200, cache: "no-store", cookies: undefined });
    expect(JSON.parse(csrf.body)).toEqual({ ok: true, token: CSRF_TOKEN, runtime_id: RUNTIME_ID });
    expect(csrf.headers.etag).toBeUndefined();
    expect(dispatched.at(-1)?.headers["accept-encoding"]).toBe("identity");
    expect(dispatched.at(-1)?.headers["if-none-match"]).toBeUndefined();
    expect(await nativeActivation("wrong-client-token")).toEqual({ activated: [], error: "NO_HANDLERS" });
    expect(upgrades.at(-1)?.headers.cookie).toBe(`${NATIVE_COOKIE}; native_aux=retained; csrf_token_${RUNTIME_ID}=${CSRF_TOKEN}`);
    expect(upgrades.at(-1)?.headers.authorization).toBeUndefined();
  });

  it("preserves the binding across auxiliary cookies but never derives it from a Set-Cookie alone", async () => {
    await resetNativeCsrf();
    await request("/agent-zero/fixture/csrf-cookie-only");
    expect(await nativeActivation()).toEqual({ activated: [], error: "NO_HANDLERS" });
    await request("/agent-zero/api/csrf_token");
    await request("/agent-zero/fixture/aux");
    await request("/agent-zero/fixture/csrf-cookie-only");
    expect(await nativeActivation()).toEqual({ activated: ["ws_webui"], error: null });
    expect(upgrades.at(-1)?.headers.cookie).not.toContain("untrusted");
    expect(await request("/agent-zero/api/csrf_token", { auth: false })).toMatchObject({ status: 401 });
    expect(await nativeActivation()).toEqual({ activated: ["ws_webui"], error: null });
  });

  it.each(["session", "runtime"])("invalidates and refreshes the private CSRF binding after %s rotation", async rotation => {
    await resetNativeCsrf();
    await request("/agent-zero/api/csrf_token");
    if (rotation === "runtime") csrfFixture.runtimeId = "fedcba9876543210";
    csrfFixture.session = "next-private-session";
    csrfFixture.token = "d".repeat(43);
    await request("/agent-zero/fixture/session");
    expect(await nativeActivation()).toEqual({ activated: [], error: "NO_HANDLERS" });
    expect(upgrades.at(-1)?.headers.cookie).not.toContain("csrf_token_");
    await request("/agent-zero/api/csrf_token");
    expect(await nativeActivation()).toEqual({ activated: ["ws_webui"], error: null });
    expect(upgrades.at(-1)?.headers.cookie?.split("csrf_token_")).toHaveLength(2);
    expect(upgrades.at(-1)?.headers.cookie).toContain(`csrf_token_${csrfFixture.runtimeId}=${csrfFixture.token}`);
    if (rotation === "runtime") {
      await request("/agent-zero/fixture/expire-old-session");
      expect(await nativeActivation()).toEqual({ activated: ["ws_webui"], error: null });
    }
  });

  it.each(["held-headers", "held-body"])("does not publish a stale %s CSRF response after the private session changes", async mode => {
    await resetNativeCsrf();
    await request("/agent-zero/api/csrf_token");
    csrfFixture.mode = mode;
    const held = new Promise<void>(resolve => { csrfHeld = resolve; });
    const pending = request("/agent-zero/api/csrf_token");
    await held;
    csrfFixture.session = "next-private-session";
    await request("/agent-zero/fixture/session");
    releaseCsrf!();
    expect(await pending).toMatchObject({ status: 502, body: "native CSRF response unavailable" });
    expect(await nativeActivation()).toEqual({ activated: [], error: "NO_HANDLERS" });
    expect(upgrades.at(-1)?.headers.cookie).toContain(`session_${RUNTIME_ID}=next-private-session`);
    expect(upgrades.at(-1)?.headers.cookie).not.toContain("csrf_token_");
    csrfFixture.mode = "valid";
    await request("/agent-zero/api/csrf_token");
    expect(await nativeActivation()).toEqual({ activated: ["ws_webui"], error: null });
  });

  it("does not let an older CSRF attempt replace or invalidate a newer valid binding", async () => {
    await resetNativeCsrf();
    csrfFixture.mode = "held-body";
    const held = new Promise<void>(resolve => { csrfHeld = resolve; });
    const pending = request("/agent-zero/api/csrf_token");
    await held;
    const releaseOlder = releaseCsrf!;
    csrfFixture.mode = "valid";
    await request("/agent-zero/api/csrf_token");
    releaseOlder();
    expect(await pending).toMatchObject({ status: 502 });
    expect(await nativeActivation()).toEqual({ activated: ["ws_webui"], error: null });
  });

  it.each(["json", "contract", "runtime", "runtime-mismatch", "oversize", "chunked-oversize", "status", "mime", "encoding"])("fails closed without a stale binding or token logs for %s CSRF responses", async mode => {
    await resetNativeCsrf();
    await request("/agent-zero/api/csrf_token");
    csrfFixture.mode = mode;
    const before = warnings.length;
    const result = await request("/agent-zero/api/csrf_token");
    expect(result).toMatchObject({ status: 502, body: "native CSRF response unavailable", cache: "no-store", cookies: undefined });
    expect(await nativeActivation()).toEqual({ activated: [], error: "NO_HANDLERS" });
    expect(warnings.slice(before)).toHaveLength(1);
    expect(warnings.at(-1)).toMatch(/^Agent Zero native CSRF response rejected: (json|contract|session-changed|size-limit|status|representation)$/);
    expect(warnings.slice(before).join(" ")).not.toContain(CSRF_TOKEN);
    expect(warnings.slice(before).join(" ")).not.toContain(TOKEN);
  });

  it("rejects CSRF JSON without the matching private native session cookie", async () => {
    await resetNativeCsrf();
    csrfFixture.mode = "no-session";
    expect(await request("/agent-zero/api/csrf_token")).toMatchObject({ status: 502 });
    expect(await nativeActivation()).toEqual({ activated: [], error: "NO_HANDLERS" });
  });

  it.each([["/agent-zero/fixture/csrf-lookalike", "GET"], ["/agent-zero/api/csrf_token", "POST"], ["/agent-zero/api/csrf_token", "HEAD"]])("does not derive a binding from %s %s", async (url, method) => {
    await resetNativeCsrf();
    expect(await request(url, { method })).toMatchObject({ status: 200 });
    expect(await nativeActivation()).toEqual({ activated: [], error: "NO_HANDLERS" });
  });

  it.each(["timeout", "timeout-headers"])("fails closed on a CSRF %s with no remaining binding", async mode => {
    await resetNativeCsrf();
    await request("/agent-zero/api/csrf_token");
    csrfFixture.mode = mode;
    expect(await request("/agent-zero/api/csrf_token", { timeoutMs: 7000 })).toMatchObject({ status: 502, body: "native CSRF response unavailable" });
    expect(await nativeActivation()).toEqual({ activated: [], error: "NO_HANDLERS" });
    expect(warnings.at(-1)).toBe("Agent Zero native CSRF response rejected: timeout");
  }, 10000);

  it("bounds a hung native login before any CSRF endpoint dispatch", async () => {
    await resetNativeCsrf();
    await request("/agent-zero/fixture/clear-all");
    const before = dispatched.length;
    loginFixture = "held";
    try {
      const started = Date.now();
      expect(await request("/agent-zero/api/csrf_token", { timeoutMs: 7000 })).toMatchObject({ status: 502, body: "native CSRF response unavailable" });
      expect(Date.now() - started).toBeLessThan(6500);
      expect(dispatched.slice(before).map(value => value.path)).toEqual(["/login"]);
      expect(await nativeActivation()).toEqual({ activated: [], error: "NO_HANDLERS" });
    } finally { loginFixture = "absent"; }
  }, 10000);

  it("preserves the same CSRF attempt through the existing one-login redirect retry", async () => {
    await resetNativeCsrf();
    await request("/agent-zero/api/csrf_token");
    csrfFixture.mode = "login-redirect";
    loginFixture = "ready";
    const before = dispatched.length;
    try {
      expect(await request("/agent-zero/api/csrf_token")).toMatchObject({ status: 200 });
      expect(dispatched.slice(before).map(value => value.path)).toEqual(["/api/csrf_token", "/login", "/api/csrf_token"]);
      expect(await nativeActivation()).toEqual({ activated: ["ws_webui"], error: null });
    } finally { loginFixture = "absent"; }
  });

  it.each(["login", "headers"])("uses one total deadline across delayed %s and a trickling CSRF body", async delay => {
    await resetNativeCsrf();
    if (delay === "login") {
      await request("/agent-zero/fixture/clear-all");
      loginFixture = "delayed";
      csrfFixture.mode = "trickle";
    } else {
      await request("/agent-zero/api/csrf_token");
      csrfFixture.mode = "delayed-trickle";
    }
    try {
      const started = Date.now();
      expect(await request("/agent-zero/api/csrf_token", { timeoutMs: 7000 })).toMatchObject({ status: 502, body: "native CSRF response unavailable" });
      expect(Date.now() - started).toBeLessThan(6500);
      expect(await nativeActivation()).toEqual({ activated: [], error: "NO_HANDLERS" });
      expect(warnings.at(-1)).toBe("Agent Zero native CSRF response rejected: timeout");
    } finally { loginFixture = "absent"; }
  }, 10000);

  it.each(["GET", "HEAD"])("refreshes an expired native editor session once for %s without losing source validation", async method => {
    await resetNativeCsrf();
    await request("/agent-zero/api/csrf_token");
    loginFixture = "ready"; editorRedirect = true;
    const asset = EDITOR_ROOT + "file-editor-store.js";
    const before = dispatched.length;
    try {
      expect(await request(asset, { method })).toMatchObject({ status: 200, cache: "no-store" });
      expect(dispatched.slice(before).map(row => [row.method, row.path])).toEqual([["GET", asset], ["POST", "/login"], ["GET", asset]]);
    } finally { loginFixture = "absent"; editorRedirect = false; }
  });

  it("bounds a hung native login before dispatching editor assets", async () => {
    await request("/agent-zero/fixture/clear-all");
    loginFixture = "held";
    const before = dispatched.length;
    try {
      expect(await request(EDITOR_ROOT + "file-editor-store.js", { timeoutMs: 12000 }))
        .toMatchObject({ status: 502, cache: "no-store", body: "native editor asset unavailable" });
      expect(dispatched.slice(before).map(row => row.path)).toEqual(["/login"]);
    } finally { loginFixture = "absent"; }
  }, 15000);
});
