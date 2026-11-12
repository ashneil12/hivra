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

// The gateway's side of a Hermes computer: Hermes's own web UI mounted under
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

describe("gateway Hermes mount", () => {
  let home: string;
  let state: string;
  const closers: Array<() => Promise<void>> = [];
  let hermesOutput: string | null;
  let webappOutput: string | null;
  let hermesCalls: string[][];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "hivra-hermes-gateway-"));
    state = path.join(home, "state");
    fs.mkdirSync(state);
    hermesOutput = "Hermes Agent v0.23.1 (2026.11.1)\nInstall directory: /home/bux/.hermes/hermes-agent\n";
    webappOutput = `→ Reusing Hermes Webapp renderer\nOpen the Webapp with this one-use link (valid for 60 seconds):\n  http://127.0.0.1:9120/webapp/launch#ticket=${"T".repeat(43)}\n`;
    hermesCalls = [];
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
          const output = args[0] === "webapp" ? webappOutput : hermesOutput;
          setImmediate(() => output === null ? callback(new Error("not found"), "") : callback(null, output));
          return;
        }
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

  it("strips /hermes, presents Hermes's own loopback Host and Origin, and announces the prefix", async () => {
    const app = await upstream();
    const port = await boot("hermes", { HERMES_DASHBOARD_PORT: String(app.port), HERMES_WEBAPP_PORT: String(await closedPort()) });
    const page = await request(port, "/hermes/sessions?x=1", {
      Origin: "https://box.hivra.test",
      "X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "https", "X-Forwarded-For": "203.0.113.9",
      Forwarded: "host=evil.example", "X-Forwarded-Prefix": "/evil",
      Cookie: "__Host-hivra_auth=secret; hermes_session=keep",
    });
    expect(page.status).toBe(200);
    expect(page.text).toBe("hermes");
    // The gate, not Hermes, is the access boundary: framing is allowed.
    expect(page.headers["x-frame-options"]).toBeUndefined();
    const seen = app.http[0];
    expect(seen.url).toBe("/sessions?x=1");
    expect(seen.headers.host).toBe(`127.0.0.1:${app.port}`);
    expect(seen.headers.origin).toBe(`http://127.0.0.1:${app.port}`);
    expect(seen.headers["x-forwarded-prefix"]).toBe("/hermes");
    for (const dropped of ["x-forwarded-host", "x-forwarded-proto", "x-forwarded-for", "forwarded"]) expect(seen.headers[dropped]).toBeUndefined();
    // Hivra's own credential never reaches Hermes; Hermes's own cookie does.
    expect(seen.headers.authorization).toBeUndefined();
    expect(seen.headers.cookie).toBe("hermes_session=keep");
  });

  it("serves the bare mount as the root and sends no Origin Hermes did not get", async () => {
    const app = await upstream();
    const port = await boot("hermes", { HERMES_DASHBOARD_PORT: String(app.port), HERMES_WEBAPP_PORT: String(await closedPort()) });
    await request(port, "/hermes");
    await request(port, "/hermes/");
    expect(app.http.map((seen) => seen.url)).toEqual(["/", "/"]);
    expect(app.http[0].headers.origin).toBeUndefined();
  });

  it("refuses everything under /hermes without the Hivra token, HTTP and WebSocket", async () => {
    const app = await upstream();
    const port = await boot("hermes", { HERMES_DASHBOARD_PORT: String(app.port), HERMES_WEBAPP_PORT: String(await closedPort()) });
    expect((await request(port, "/hermes/", {}, { auth: false })).status).not.toBe(200);
    expect(await upgrade(port, "/hermes/api/ws", {})).toMatch(/^HTTP\/1\.1 401/);
    expect(await upgrade(port, "/hermes/api/pty", { Authorization: "Bearer nope" })).toMatch(/^HTTP\/1\.1 401/);
    expect(app.http).toEqual([]);
    expect(app.ws).toEqual([]);
  });

  it.each(["/hermes/api/ws?channel=a", "/hermes/api/pty"])("proxies the WebSocket %s with Hermes's own Host and Origin", async (pathname) => {
    const app = await upstream();
    const port = await boot("hermes", { HERMES_DASHBOARD_PORT: String(app.port), HERMES_WEBAPP_PORT: String(await closedPort()) });
    const reply = await upgrade(port, pathname, {
      Authorization: `Bearer ${TOKEN}`, Origin: "https://box.hivra.test",
      Cookie: `__Host-hivra_auth=secret; hermes_session=keep`, "X-Forwarded-Host": "evil.example", "X-Forwarded-Prefix": "/evil",
      "Sec-WebSocket-Key": WS_NONCE, "Sec-WebSocket-Version": "13",
    });
    expect(reply).toMatch(/^HTTP\/1\.1 101/);
    const seen = app.ws[0];
    expect(seen.url).toBe(pathname.slice("/hermes".length));
    expect(seen.headers.host).toBe(`127.0.0.1:${app.port}`);
    expect(seen.headers.origin).toBe(`http://127.0.0.1:${app.port}`);
    expect(seen.headers["x-forwarded-prefix"]).toBe("/hermes");
    expect(seen.headers["x-forwarded-host"]).toBeUndefined();
    expect(seen.headers.authorization).toBeUndefined();
    expect(seen.headers.cookie).toBe("hermes_session=keep");
    expect(seen.headers["sec-websocket-key"]).toBe("dGhlIHNhbXBsZSBub25jZQ==");
  });

  it("shows the Webapp at /hermes once Hermes's gateway serves it, with the Webapp's own loopback Host and Origin", async () => {
    const dashboard = await upstream();
    const desk = await webapp();
    const port = await boot("hermes", { HERMES_DASHBOARD_PORT: String(dashboard.port), HERMES_WEBAPP_PORT: String(desk.port) });
    await settle(port, desk);
    const page = await request(port, "/hermes/sessions/1?x=1", { Origin: "https://box.hivra.test", "X-Forwarded-Prefix": "/evil" });
    expect(page.status).toBe(200);
    expect(page.text).toContain("<title>Hermes</title>");
    // The agent page embeds it: the gate, not Hermes, decides who may frame it.
    expect(page.headers["x-frame-options"]).toBeUndefined();
    expect(page.headers["content-security-policy"]).toBe("default-src 'none'; script-src 'self'");
    const seen = desk.http[desk.http.length - 1];
    expect(seen.url).toBe("/sessions/1?x=1");
    expect(seen.headers.host).toBe(`127.0.0.1:${desk.port}`);
    expect(seen.headers.origin).toBe(`http://127.0.0.1:${desk.port}`);
    expect(seen.headers["x-forwarded-prefix"]).toBe("/hermes");
    expect(dashboard.http.filter((s) => s.url !== "/.probe")).toEqual([]);

    const reply = await upgrade(port, "/hermes/api/ws", { Authorization: `Bearer ${TOKEN}`, Origin: "https://box.hivra.test",
      "Sec-WebSocket-Key": WS_NONCE, "Sec-WebSocket-Version": "13" });
    expect(reply).toMatch(/^HTTP\/1\.1 101/);
    expect(desk.ws[0].url).toBe("/api/ws");
    expect(desk.ws[0].headers.host).toBe(`127.0.0.1:${desk.port}`);
    expect(desk.ws[0].headers.origin).toBe(`http://127.0.0.1:${desk.port}`);
  });

  it("signs the owner in to the Webapp through Hermes's own one-use link, carried only in the fragment", async () => {
    const desk = await webapp();
    const port = await boot("hermes", { HERMES_DASHBOARD_PORT: String(await closedPort()), HERMES_WEBAPP_PORT: String(desk.port) });
    const signIn = await request(port, "/hermes-sign-in", { Accept: "text/html" });
    expect(signIn.status).toBe(303);
    expect(signIn.headers.location).toBe(`/hermes/webapp/launch#ticket=${"T".repeat(43)}`);
    expect(signIn.headers["cache-control"]).toBe("no-store");
    expect(signIn.headers["referrer-policy"]).toBe("no-referrer");
    expect(hermesCalls).toContainEqual(["webapp", "--no-open", "--skip-build"]);
    // A profile choice rides along in the fragment as Hermes wrote it.
    webappOutput = `  http://127.0.0.1:9120/webapp/launch#ticket=${"a".repeat(43)}&query=%3Fprofile%3Dwork\n`;
    expect((await request(port, "/hermes-sign-in")).headers.location).toBe(`/hermes/webapp/launch#ticket=${"a".repeat(43)}&query=%3Fprofile%3Dwork`);
  });

  it("opens the dashboard instead when the Webapp is not served or Hermes gives no link", async () => {
    const dashboard = await upstream();
    const port = await boot("hermes", { HERMES_DASHBOARD_PORT: String(dashboard.port), HERMES_WEBAPP_PORT: String(await closedPort()) });
    expect((await request(port, "/hermes-sign-in")).headers.location).toBe("/hermes/");
    expect(hermesCalls.some((args) => args[0] === "webapp")).toBe(false);
    await request(port, "/hermes/");
    expect(dashboard.http.map((seen) => seen.url)).toContain("/");

    const desk = await webapp();
    const other = await boot("hermes", { HERMES_DASHBOARD_PORT: String(dashboard.port), HERMES_WEBAPP_PORT: String(desk.port) });
    webappOutput = "The Webapp is off.\n";
    expect((await request(other, "/hermes-sign-in")).headers.location).toBe("/hermes/");
    webappOutput = null;
    expect((await request(other, "/hermes-sign-in")).headers.location).toBe("/hermes/");
  });

  it("sends a Hermes entry from the surface bootstrap through the sign-in, and refuses the sign-in without the token", async () => {
    const port = await boot("hermes", { HERMES_WEBAPP_PORT: String(await closedPort()) });
    const form = (destination: string) => new URLSearchParams({ token: TOKEN, destination }).toString();
    const post = (destination: string) => request(port, "/auth/bootstrap", { "Content-Type": "application/x-www-form-urlencoded" }, { auth: false, method: "POST", body: form(destination) });
    expect((await post("/hermes/")).headers.location).toBe("/hermes-sign-in");
    expect((await post("/hermes")).headers.location).toBe("/hermes-sign-in");
    expect((await post("/hermes/sessions/2")).headers.location).toBe("/hermes/sessions/2");
    expect((await request(port, "/hermes-sign-in", {}, { auth: false })).status).toBe(401);
    expect(hermesCalls.some((args) => args[0] === "webapp")).toBe(false);

    const openclaw = await boot("openclaw");
    const openclawPost = await request(openclaw, "/auth/bootstrap", { "Content-Type": "application/x-www-form-urlencoded" }, { auth: false, method: "POST", body: form("/hermes/") });
    expect(openclawPost.headers.location).toBe("/hermes/");
  });

  it("does not mount /hermes on a computer that does not run Hermes", async () => {
    const app = await upstream();
    const port = await boot("openclaw", { HERMES_DASHBOARD_PORT: String(app.port) });
    expect((await request(port, "/hermes/")).status).toBe(404);
    expect(await upgrade(port, "/hermes/api/ws", { Authorization: `Bearer ${TOKEN}` })).toBe("closed");
    expect(app.http).toEqual([]);
  });

  it("has no chat or login surface of its own: the owner works in Hermes's UI", async () => {
    const port = await boot("hermes");
    expect((await request(port, "/api/login/status")).json).toMatchObject({ loggedIn: true });
  });

  it("reports the version Hermes states, and its update progress toward 'latest'", async () => {
    fs.writeFileSync(files().status, JSON.stringify({ name: "hermes", state: "failed", from: "0.23.1", to: "latest", reason: "local_changes", updatedAt: "2026-11-11T10:00:00Z" }));
    const port = await boot("hermes");
    const first = (await request(port, "/api/meta")).json.agentApp as Record<string, unknown>;
    if (first.checking === true) expect(first.version).toBeUndefined();
    await new Promise((r) => setImmediate(r));
    expect((await request(port, "/api/meta")).json.agentApp).toMatchObject({
      name: "hermes", version: "0.23.1",
      update: { state: "failed", target: "latest", reason: "local_changes", updatedAt: "2026-11-11T10:00:00Z" },
      activity: { openConnections: 0 },
    });
    expect((await request(port, "/api/meta", {}, { auth: false })).json.agentApp).toBeUndefined();
  });

  it("reports no version when Hermes does not answer, and ignores a target that is not 'latest'", async () => {
    hermesOutput = null;
    fs.writeFileSync(files().status, JSON.stringify({ name: "hermes", state: "done", to: "0.99.0" }));
    const port = await boot("hermes");
    await new Promise((r) => setImmediate(r));
    const app = (await request(port, "/api/meta")).json.agentApp as Record<string, unknown>;
    expect(app.version).toBeNull();
    expect(app.update).toBeUndefined();
  });

  it("answers 'being updated' while the updater holds its lock, for HTTP and WebSocket, and counts open sockets", async () => {
    const app = await upstream();
    const port = await boot("hermes", { HERMES_DASHBOARD_PORT: String(app.port), HERMES_WEBAPP_PORT: String(await closedPort()) });
    const open = async () => ((await request(port, "/api/meta")).json.agentApp as { activity: { openConnections: number } }).activity.openConnections;
    const socket = net.connect(port, "127.0.0.1");
    await once(socket, "connect");
    socket.write(`GET /hermes/api/ws HTTP/1.1\r\nHost: box.hivra.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nAuthorization: Bearer ${TOKEN}\r\n\r\n`);
    await once(socket, "data");
    expect(await open()).toBe(1);
    socket.destroy();
    for (let tries = 0; tries < 40 && await open() !== 0; tries += 1) await new Promise((r) => setTimeout(r, 25));
    expect(await open()).toBe(0);

    fs.writeFileSync(files().lock, "");
    const page = await request(port, "/hermes/", { Accept: "text/html" });
    expect(page.status).toBe(503);
    expect(page.text).toContain("Hermes is being updated");
    expect(await upgrade(port, "/hermes/api/ws", { Authorization: `Bearer ${TOKEN}` })).toMatch(/^HTTP\/1\.1 503/);
  });
});
