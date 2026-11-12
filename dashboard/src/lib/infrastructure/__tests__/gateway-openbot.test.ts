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

// RFC 6455's sample nonce, built at run time so it never reads as a credential.
const WS_NONCE = Buffer.from("the sample nonce").toString("base64");

// The gateway's side of an OpenBot computer: CopilotKit's OpenBot served at
// the ROOT of the box origin behind the Hivra token gate (OpenBot has no base
// path), HTTP and WebSocket, presenting OpenBot's own loopback Host and, for a
// request from the box's own origin, Origin. The gateway keeps its own paths.
// /openbot/ asks once for the CopilotKit Intelligence key OpenBot needs before
// it starts. The unmodified gateway runs here against a recording upstream.
//
// (Harness shared with gateway-hermes.test.ts.) The gateway's side of a Hermes computer: Hermes's own web UI mounted under
// /hermes behind the Hivra token gate, for HTTP and for its WebSockets
// (/api/ws, /api/pty), with the headers Hermes needs (its own loopback Host
// and Origin, the path prefix in X-Forwarded-Prefix) and nothing the browser
// sent that could change its idea of its public address. /hermes is the
// Webapp (Hermes's Desktop workspace in a browser) when Hermes's gateway
// serves it, entered through Hermes's own one-use sign-in link, and the
// dashboard otherwise. The unmodified gateway runs here against recording
// upstreams.

const TOKEN = "d".repeat(64);
const SERVER_PATH = path.join(process.cwd(), "provisioner/hivra-chat/server.js");
const SERVER_SOURCE = fs.readFileSync(SERVER_PATH, "utf8");

interface Seen { url: string; headers: http.IncomingHttpHeaders }

describe("gateway OpenBot at the box root", () => {
  let home: string;
  let state: string;
  const closers: Array<() => Promise<void>> = [];
  let hermesOutput: string | null;
  let webappOutput: string | null;
  let hermesCalls: string[][];
  // Hermes's own config, as `hermes config get/set` sees it.
  let hermesConfig: Record<string, string>;
  let hermesConfigSetFails: boolean;
  let sudoCalls: string[][];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "hivra-openbot-gateway-"));
    state = path.join(home, "state");
    fs.mkdirSync(state);
    hermesOutput = "Hermes Agent v0.23.1 (2026.11.1)\nInstall directory: /home/bux/.hermes/hermes-agent\n";
    webappOutput = `→ Reusing Hermes Webapp renderer\nOpen the Webapp with this one-use link (valid for 60 seconds):\n  http://127.0.0.1:9120/webapp/launch#ticket=${"T".repeat(43)}\n`;
    hermesCalls = [];
    hermesConfig = { "model.default": "deepseek-v4-1-flash", "model.base_url": "https://hivra.test/api/managed-venice/v1", "model.provider": "custom" };
    hermesConfigSetFails = false;
    sudoCalls = [];
  });
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const files = () => ({
    record: path.join(state, "agent-app.json"),
    status: path.join(state, "agent-app-update.json"),
    lock: path.join(state, "agent-app-update.lock"),
  });

  function boot(kind: string, env: Record<string, string> = {}): Promise<number> {
    fs.mkdirSync(path.join(home, ".hivra"), { recursive: true });
    fs.writeFileSync(path.join(home, ".hivra", "api-token"), TOKEN);
    fs.writeFileSync(path.join(home, ".hivra", "agent-kind"), `${kind}\n`);
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
      execFile: (file: string, args: string[], _options: unknown, callback?: (error: Error | null, stdout: string) => void) => {
        if (typeof callback !== "function") return;
        if (file.endsWith("hermes")) {
          hermesCalls.push(args);
          if (args[0] === "config" && args[1] === "get") {
            const value = hermesConfig[args[2]];
            setImmediate(() => value === undefined ? callback(new Error(`Config key not set: ${args[2]}`), "") : callback(null, `${value}\n`));
            return;
          }
          if (args[0] === "config" && args[1] === "set") {
            if (!hermesConfigSetFails) hermesConfig[args[2]] = args[3];
            setImmediate(() => callback(hermesConfigSetFails ? new Error("exit 1") : null, ""));
            return;
          }
          const output = args[0] === "webapp" ? webappOutput : hermesOutput;
          setImmediate(() => output === null ? callback(new Error("not found"), "") : callback(null, output));
          return;
        }
        if (file === "sudo") { sudoCalls.push(args); setImmediate(() => callback(null, "")); return; }
        setImmediate(() => callback(new Error(`unexpected ${file}`), ""));
      },
    };
    const { record, status, lock } = files();
    vm.runInNewContext(SERVER_SOURCE, {
      require: (name: string) => {
        if (name === "http") return fakeHttp;
        if (name === "child_process") return childProcess;
        if (["fs", "path", "crypto", "net", "./llm-application.js", "./guarded-files.cjs", "./agent-zero-editor.cjs", "./chat-runs.cjs"].includes(name)) return realRequire(name);
        throw new Error(`Unexpected guest dependency: ${name}`);
      },
      process: {
        env: {
          HOME: home, HIVRA_CHAT_PORT: "0", HIVRA_AGENT_KIND: kind,
          HIVRA_AGENT_APP_RECORD: record, HIVRA_AGENT_APP_STATUS: status, HIVRA_AGENT_APP_LOCK: lock,
          HERMES_BIN: path.join(home, "hermes"), ...env,
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

  async function upstream(page = { type: "text/plain", body: "hermes" }): Promise<{ port: number; http: Seen[]; ws: Seen[] }> {
    const seen = { http: [] as Seen[], ws: [] as Seen[] };
    const sockets = new Set<net.Socket>();
    const app = http.createServer((req, res) => {
      seen.http.push({ url: req.url ?? "", headers: req.headers });
      res.writeHead(200, { "Content-Type": page.type, "X-Frame-Options": "DENY",
        "Content-Security-Policy": "default-src 'none'; script-src 'self'; frame-ancestors 'none'" });
      res.end(page.body);
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

  // Nothing listens here: a computer whose Hermes gateway does not serve the Webapp.
  async function closedPort(): Promise<number> {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    return port;
  }

  async function webapp() {
    return upstream({ type: "text/html; charset=utf-8", body: "<!doctype html><title>Hermes</title>" });
  }

  function request(port: number, pathname: string, headers: Record<string, string> = {}, { auth = true, method = "GET", body = "" } = {}): Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders; json: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1", port, path: pathname, method, agent: false,
        headers: { Host: "box.hivra.test", Accept: "application/json", ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}), ...headers },
      }, (res) => {
        let text = ""; res.setEncoding("utf8"); res.on("data", (c) => { text += c; });
        res.once("end", () => { let json: Record<string, unknown> = {}; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode ?? 0, text, headers: res.headers, json }); });
      });
      req.once("error", reject);
      req.end(body);
    });
  }

  // The gateway checks the Webapp at start and follows it within seconds; wait
  // until /hermes reaches the expected upstream.
  async function settle(port: number, target: { http: Seen[] }) {
    for (let tries = 0; tries < 80; tries += 1) {
      const before = target.http.length;
      await request(port, "/hermes/.probe");
      if (target.http.slice(before).some((seen) => seen.url === "/.probe")) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("/hermes never reached the expected upstream");
  }

  async function upgrade(port: number, pathname: string, headers: Record<string, string>): Promise<string> {
    const socket = net.connect(port, "127.0.0.1");
    await once(socket, "connect");
    const lines = Object.entries({ Host: "box.hivra.test", Upgrade: "websocket", Connection: "Upgrade", ...headers }).map(([k, v]) => `${k}: ${v}`);
    socket.write(`GET ${pathname} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
    // A refused upgrade is answered or simply closed.
    const reply = await new Promise<string>((resolve) => {
      socket.once("data", (chunk) => resolve(String(chunk)));
      socket.once("close", () => resolve("closed"));
      socket.once("error", () => resolve("closed"));
    });
    socket.destroy();
    return reply;
  }

  const KEY = "cpk-test_project.key-123";
  const keyFile = () => path.join(home, ".hivra", "openbot-intelligence-key");
  async function withKey() {
    const app = await upstream({ type: "text/html; charset=utf-8", body: "<!doctype html><title>OpenBot</title>" });
    const port = await boot("openbot", { OPENBOT_PORT: String(app.port) });
    fs.writeFileSync(keyFile(), `${KEY}\n`, { mode: 0o600 });
    return { app, port };
  }

  it("serves OpenBot at the root with its own loopback Host and Origin, and none of Hivra's credentials", async () => {
    const { app, port } = await withKey();
    const page = await request(port, "/channels/abc?x=1", {
      Accept: "text/html", Origin: "https://box.hivra.test",
      "X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "https", "X-Forwarded-For": "203.0.113.9", Forwarded: "host=evil.example",
      Cookie: "__Host-hivra_auth=secret; openbot_theme=dark",
    });
    expect(page.status).toBe(200);
    expect(page.text).toContain("<title>OpenBot</title>");
    // The agent page embeds it: the gate, not OpenBot, decides who may frame it.
    expect(page.headers["x-frame-options"]).toBeUndefined();
    expect(page.headers["content-security-policy"]).toBe("default-src 'none'; script-src 'self'");
    const seen = app.http[app.http.length - 1];
    expect(seen.url).toBe("/channels/abc?x=1");
    expect(seen.headers.host).toBe(`127.0.0.1:${app.port}`);
    expect(seen.headers.origin).toBe(`http://127.0.0.1:${app.port}`);
    for (const dropped of ["x-forwarded-host", "x-forwarded-proto", "x-forwarded-for", "forwarded"]) expect(seen.headers[dropped]).toBeUndefined();
    expect(seen.headers.authorization).toBeUndefined();
    expect(seen.headers.cookie).toBe("openbot_theme=dark");
  });

  it("passes another site's Origin on unchanged, so OpenBot refuses it itself", async () => {
    const { app, port } = await withKey();
    await request(port, "/api/settings", { Origin: "https://evil.example" });
    expect(app.http[app.http.length - 1].headers.origin).toBe("https://evil.example");
    await request(port, "/api/me");
    expect(app.http[app.http.length - 1].headers.origin).toBeUndefined();
  });

  it("keeps the gateway's own paths, and gives OpenBot its /api/browser", async () => {
    const { app, port } = await withKey();
    const meta = await request(port, "/api/meta");
    expect(meta.status).toBe(200);
    expect(meta.json.agentKind).toBe("openbot");
    expect((await request(port, "/healthz")).text).toBe("ok");
    await request(port, "/api/browser/status");
    expect(app.http.map((seen) => seen.url)).toEqual(["/api/browser/status"]);
  });

  it("refuses OpenBot without the Hivra token, HTTP and WebSocket", async () => {
    const { app, port } = await withKey();
    expect((await request(port, "/", { Accept: "text/html" }, { auth: false })).status).toBe(401);
    expect((await request(port, "/api/channels", {}, { auth: false })).status).toBe(401);
    expect(await upgrade(port, "/api/channels/events", {})).toMatch(/^HTTP\/1\.1 401/);
    expect(app.http).toEqual([]);
    expect(app.ws).toEqual([]);
  });

  it("proxies OpenBot's WebSockets at the root with its own Host and Origin", async () => {
    const { app, port } = await withKey();
    const reply = await upgrade(port, "/api/channels/events", {
      Authorization: `Bearer ${TOKEN}`, Origin: "https://box.hivra.test", "X-Forwarded-Host": "evil.example",
      Cookie: "__Host-hivra_auth=secret; openbot_theme=dark", "Sec-WebSocket-Key": WS_NONCE, "Sec-WebSocket-Version": "13",
    });
    expect(reply).toMatch(/^HTTP\/1\.1 101/);
    const seen = app.ws[0];
    expect(seen.url).toBe("/api/channels/events");
    expect(seen.headers.host).toBe(`127.0.0.1:${app.port}`);
    expect(seen.headers.origin).toBe(`http://127.0.0.1:${app.port}`);
    expect(seen.headers["x-forwarded-host"]).toBeUndefined();
    expect(seen.headers.authorization).toBeUndefined();
    expect(seen.headers.cookie).toBe("openbot_theme=dark");
  });

  it("asks for the Intelligence key at /openbot/ until one is saved, and sends a page load there meanwhile", async () => {
    const app = await upstream();
    const port = await boot("openbot", { OPENBOT_PORT: String(app.port) });
    const entry = await request(port, "/openbot/", { Accept: "text/html" });
    expect(entry.status).toBe(200);
    expect(entry.text).toContain("CopilotKit Intelligence");
    expect(entry.text).toContain('action="/openbot/setup"');
    // A form post under no-referrer would carry Origin: null, which the gate refuses.
    expect(entry.headers["referrer-policy"]).toBe("same-origin");
    expect(entry.headers["content-security-policy"]).toContain("default-src 'none'");
    const root = await request(port, "/", { Accept: "text/html" });
    expect(root.status).toBe(303);
    expect(root.headers.location).toBe("/openbot/");
    expect(app.http).toEqual([]);
  });

  it("saves a valid key owner-only, restarts OpenBot through its helper, and rejects anything else", async () => {
    const app = await upstream();
    const port = await boot("openbot", { OPENBOT_PORT: String(app.port) });
    const form = { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" };
    const bad = await request(port, "/openbot/setup", form, { method: "POST", body: "key=" + encodeURIComponent("bad key\nPORT=1") });
    expect(bad.status).toBe(400);
    expect(fs.existsSync(keyFile())).toBe(false);
    expect((await request(port, "/openbot/setup", form, { method: "POST", body: `key=${KEY}`, auth: false })).status).toBe(401);
    expect(fs.existsSync(keyFile())).toBe(false);
    const saved = await request(port, "/openbot/setup", form, { method: "POST", body: `key=${encodeURIComponent(` ${KEY} `)}` });
    expect(saved.status).toBe(303);
    expect(saved.headers.location).toBe("/openbot/");
    expect(fs.readFileSync(keyFile(), "utf8")).toBe(`${KEY}\n`);
    expect(fs.statSync(keyFile()).mode & 0o777).toBe(0o600);
    await new Promise((r) => setTimeout(r, 20));
    expect(sudoCalls).toEqual([["-n", "/usr/local/bin/hivra-openbot-apply", "restart"]]);
  });

  it("opens OpenBot from /openbot/ once it answers, and says it is starting until then", async () => {
    const { port } = await withKey();
    const ready = await request(port, "/openbot/", { Accept: "text/html" });
    expect(ready.status).toBe(303);
    expect(ready.headers.location).toBe("/");
    // /openbot/setup always shows the form, to replace the key.
    expect((await request(port, "/openbot/setup", { Accept: "text/html" })).text).toContain('name="key"');

    const down = await boot("openbot", { OPENBOT_PORT: String(await closedPort()) });
    const starting = await request(down, "/openbot/", { Accept: "text/html" });
    expect(starting.status).toBe(200);
    expect(starting.text).toContain("Starting OpenBot");
    expect(starting.text).toContain('http-equiv="refresh"');
  });

  it("reports OpenBot's recorded release and its latest-only update", async () => {
    const { port } = await withKey();
    const { record, status } = files();
    fs.writeFileSync(record, JSON.stringify({ name: "openbot", version: "1.0.2" }));
    fs.writeFileSync(status, JSON.stringify({ name: "openbot", state: "waiting", from: "1.0.2", to: "latest", updatedAt: "2026-11-12T15:00:00Z" }));
    const meta = await request(port, "/api/meta");
    const app = meta.json.agentApp as { name: string; version: string; update: { state: string; target: string } };
    expect(app.name).toBe("openbot");
    expect(app.version).toBe("1.0.2");
    expect(app.update).toMatchObject({ state: "waiting", target: "latest" });
  });
});
