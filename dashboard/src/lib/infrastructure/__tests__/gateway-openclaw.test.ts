/** @jest-environment node */
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";

// The gateway's side of an OpenClaw computer. OpenClaw's gateway (2026.11.5
// and newer) refuses a loopback request that carries forwarded-client headers
// unless gateway.trustedProxies names the proxy ("proxy_attribution_required").
// The Hivra gate is the only way in and has already authenticated the owner,
// so /openclaw reaches OpenClaw without the forwarded headers the tunnel adds,
// over HTTP and WebSocket alike. The unmodified gateway runs against a
// recording upstream.

const TOKEN = "e".repeat(64);
const SERVER_PATH = path.join(process.cwd(), "provisioner/hivra-chat/server.js");
const SERVER_SOURCE = fs.readFileSync(SERVER_PATH, "utf8");
const FORWARDED = {
  Forwarded: "for=203.0.113.9;proto=https",
  "X-Forwarded-For": "203.0.113.9",
  "X-Forwarded-Proto": "https",
  "X-Forwarded-Host": "box.hivra.test",
  "X-Forwarded-Port": "443",
  "X-Real-IP": "203.0.113.9",
};

interface Seen { url: string; headers: http.IncomingHttpHeaders }

describe("gateway OpenClaw Control UI", () => {
  let home: string;
  const closers: Array<() => Promise<void>> = [];

  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "hivra-openclaw-gateway-")); });
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  function boot(kind: string, env: Record<string, string>): Promise<number> {
    fs.mkdirSync(path.join(home, ".hivra"), { recursive: true });
    fs.writeFileSync(path.join(home, ".hivra", "api-token"), TOKEN);
    fs.writeFileSync(path.join(home, ".hivra", "agent-kind"), `${kind}\n`);
    const state = path.join(home, "state");
    fs.mkdirSync(state, { recursive: true });
    let server: http.Server | undefined;
    const sockets = new Set<net.Socket>();
    const realRequire = createRequire(SERVER_PATH);
    const fakeHttp = {
      ...http,
      createServer: (handler: http.RequestListener) => {
        server = http.createServer(handler);
        server.on("connection", (socket) => sockets.add(socket));
        return server;
      },
    };
    const childProcess = {
      spawn: () => ({ on: () => undefined, unref: () => undefined, stdout: { on: () => undefined }, stderr: { on: () => undefined } }),
      execFile: (_file: string, _args: string[], _options: unknown, callback?: (error: Error | null, stdout: string) => void) => {
        if (typeof callback === "function") setImmediate(() => callback(new Error("not available"), ""));
      },
    };
    vm.runInNewContext(SERVER_SOURCE, {
      require: (name: string) => {
        if (name === "http") return fakeHttp;
        if (name === "child_process") return childProcess;
        if (["fs", "path", "crypto", "net", "./llm-application.js", "./guarded-files.cjs", "./agent-zero-editor.cjs", "./chat-runs.cjs", "./import-state.cjs"].includes(name)) return realRequire(name);
        throw new Error(`Unexpected guest dependency: ${name}`);
      },
      process: {
        env: {
          HOME: home, HIVRA_CHAT_PORT: "0", HIVRA_AGENT_KIND: kind,
          HIVRA_AGENT_APP_RECORD: path.join(state, "agent-app.json"),
          HIVRA_AGENT_APP_STATUS: path.join(state, "agent-app-update.json"),
          HIVRA_AGENT_APP_LOCK: path.join(state, "agent-app-update.lock"),
          OPENCLAW_BIN: path.join(home, "openclaw"), ...env,
        },
        once: () => undefined,
        getuid: () => os.userInfo().uid,
      },
      __dirname: path.dirname(SERVER_PATH),
      console: { log: () => undefined, warn: () => undefined, error: () => undefined },
      Buffer, URL, URLSearchParams, setTimeout, clearTimeout, setImmediate,
    }, { filename: SERVER_PATH });
    if (!server) throw new Error("gateway did not create its HTTP server");
    const created = server;
    closers.push(async () => {
      for (const socket of sockets) socket.destroy();
      if (created.listening) await new Promise<void>((r) => created.close(() => r()));
    });
    return created.listening ? Promise.resolve((created.address() as AddressInfo).port)
      : once(created, "listening").then(() => (created.address() as AddressInfo).port);
  }

  async function upstream(): Promise<{ port: number; http: Seen[]; ws: Seen[] }> {
    const seen = { http: [] as Seen[], ws: [] as Seen[] };
    const sockets = new Set<net.Socket>();
    const app = http.createServer((req, res) => {
      seen.http.push({ url: req.url ?? "", headers: req.headers });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>OpenClaw</title>");
    });
    app.on("connection", (socket) => sockets.add(socket));
    app.on("upgrade", (req, socket) => {
      seen.ws.push({ url: req.url ?? "", headers: req.headers });
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    });
    app.listen(0, "127.0.0.1");
    await once(app, "listening");
    closers.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((r) => app.close(() => r())); });
    return { port: (app.address() as AddressInfo).port, ...seen };
  }

  function request(port: number, pathname: string, headers: Record<string, string> = {}): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path: pathname, method: "GET", agent: false,
        headers: { Host: "box.hivra.test", Authorization: `Bearer ${TOKEN}`, ...headers } }, (res) => {
        res.resume();
        res.once("end", () => resolve(res.statusCode ?? 0));
      });
      req.once("error", reject);
      req.end();
    });
  }

  async function upgrade(port: number, pathname: string, headers: Record<string, string>): Promise<string> {
    const socket = net.connect(port, "127.0.0.1");
    await once(socket, "connect");
    const lines = Object.entries({ Host: "box.hivra.test", Upgrade: "websocket", Connection: "Upgrade",
      Authorization: `Bearer ${TOKEN}`, ...headers }).map(([k, v]) => `${k}: ${v}`);
    socket.write(`GET ${pathname} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
    const reply = await new Promise<string>((resolve) => {
      socket.once("data", (chunk) => resolve(String(chunk)));
      socket.once("close", () => resolve("closed"));
      socket.once("error", () => resolve("closed"));
    });
    socket.destroy();
    return reply;
  }

  const forwardedNames = Object.keys(FORWARDED).map((name) => name.toLowerCase());

  it("drops forwarded-client headers on the Control UI page, its root assets and its WebSocket", async () => {
    const app = await upstream();
    const port = await boot("openclaw", { OPENCLAW_GATEWAY_PORT: String(app.port) });

    expect(await request(port, "/openclaw/", FORWARDED)).toBe(200);
    // A root-absolute asset requested from the Control UI is re-homed under /openclaw.
    expect(await request(port, "/assets/app.js", { ...FORWARDED, Referer: "https://box.hivra.test/openclaw/" })).toBe(200);
    expect(await upgrade(port, "/openclaw/", { ...FORWARDED, Origin: "https://box.hivra.test" })).toMatch(/^HTTP\/1\.1 101/);

    expect(app.http.map((seen) => seen.url)).toEqual(["/", "/assets/app.js"]);
    expect(app.ws.map((seen) => seen.url)).toEqual(["/"]);
    for (const seen of [...app.http, ...app.ws]) {
      for (const name of forwardedNames) expect(seen.headers[name]).toBeUndefined();
      expect(seen.headers.authorization).toBeUndefined();
    }
    // The WebSocket keeps the browser's Origin (OpenClaw's host-header origin fallback checks it).
    expect(app.ws[0].headers.origin).toBe("https://box.hivra.test");
  });

  it("keeps the /openclaw prefix when OpenClaw serves its Control UI at basePath /openclaw", async () => {
    // OpenClaw 2026.11.5 sends Referrer-Policy: no-referrer, so a launch sets
    // gateway.controlUi.basePath (OpenClaw's own reverse-proxy prefix setting)
    // and the page, its assets, routes and WebSocket all stay under /openclaw.
    fs.mkdirSync(path.join(home, ".openclaw"), { recursive: true });
    fs.writeFileSync(path.join(home, ".openclaw", "openclaw.json"),
      JSON.stringify({ gateway: { mode: "local", controlUi: { basePath: "/openclaw" } } }));
    const app = await upstream();
    const port = await boot("openclaw", { OPENCLAW_GATEWAY_PORT: String(app.port) });

    expect(await request(port, "/openclaw/", FORWARDED)).toBe(200);
    expect(await request(port, "/openclaw/assets/index.js")).toBe(200);
    expect(await request(port, "/openclaw/chat/main")).toBe(200);
    expect(await upgrade(port, "/openclaw", { Origin: "https://box.hivra.test" })).toMatch(/^HTTP\/1\.1 101/);

    expect(app.http.map((seen) => seen.url)).toEqual(["/openclaw/", "/openclaw/assets/index.js", "/openclaw/chat/main"]);
    expect(app.ws.map((seen) => seen.url)).toEqual(["/openclaw"]);
    for (const seen of app.http) for (const name of forwardedNames) expect(seen.headers[name]).toBeUndefined();
  });

  it("still refuses /openclaw without the Hivra gate", async () => {
    const app = await upstream();
    const port = await boot("openclaw", { OPENCLAW_GATEWAY_PORT: String(app.port) });
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path: "/openclaw/", agent: false, headers: { Host: "box.hivra.test" } },
        (res) => { res.resume(); res.once("end", () => resolve(res.statusCode ?? 0)); });
      req.once("error", reject);
      req.end();
    });
    expect(status).not.toBe(200);
    expect(app.http).toEqual([]);
  });
});
