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


// The gateway's side of a Nuphos computer: Nuphos's official runtime console
// served at the ROOT of the box origin behind the Hivra token gate, with the
// box's own host and HTTPS presented so the runtime tells Nuphos the right
// address and sets its Secure console cookie. Nuphos's servers reach the
// runtime's /acp WebSocket without the Hivra gate (the runtime checks each
// team's key itself), and never with Hivra's credentials. The gateway keeps
// its own paths. The unmodified gateway runs here against a recording upstream.
// (Harness shared with gateway-openbot.test.ts.)

const TOKEN = "d".repeat(64);
const SERVER_PATH = path.join(process.cwd(), "provisioner/hivra-chat/server.js");
const SERVER_SOURCE = fs.readFileSync(SERVER_PATH, "utf8");

interface Seen { url: string; headers: http.IncomingHttpHeaders }

describe("gateway Nuphos runtime at the box root", () => {
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
    home = fs.mkdtempSync(path.join(os.tmpdir(), "hivra-nuphos-gateway-"));
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

  async function nuphos() {
    const app = await upstream({ type: "text/html; charset=utf-8", body: "<!doctype html><title>Nuphos agent</title>" });
    const port = await boot("nuphos", { NUPHOS_PORT: String(app.port) });
    return { app, port };
  }

  it("serves the runtime console at the root with the box host as HTTPS, and none of Hivra's credentials", async () => {
    const { app, port } = await nuphos();
    const page = await request(port, "/_openab/console/state", {
      Origin: "https://box.hivra.test", Cookie: "__Host-hivra_auth=x; __Host-nuphos_console=abc",
      "X-Forwarded-Host": "evil.example", "X-Forwarded-For": "203.0.113.9", Forwarded: "host=evil.example",
    });
    expect(page.status).toBe(200);
    const seen = app.http.at(-1)!;
    expect(seen.url).toBe("/_openab/console/state");
    expect(seen.headers["x-forwarded-host"]).toBe("box.hivra.test");
    expect(seen.headers["x-forwarded-proto"]).toBe("https");
    expect(seen.headers.origin).toBe("https://box.hivra.test");
    expect(seen.headers.forwarded).toBeUndefined();
    expect(seen.headers["x-forwarded-for"]).toBeUndefined();
    expect(seen.headers.authorization).toBeUndefined();
    expect(seen.headers.cookie).toBe("__Host-nuphos_console=abc");
    // The agent page embeds it: the runtime's anti-framing headers are dropped.
    expect(page.headers["x-frame-options"]).toBeUndefined();
    expect(String(page.headers["content-security-policy"])).not.toContain("frame-ancestors");
  });

  it("asks for the Hivra sign-in before the console", async () => {
    const { app, port } = await nuphos();
    const page = await request(port, "/", { Accept: "text/html" }, { auth: false });
    expect(page.status).toBe(401);
    expect(app.http).toEqual([]);
  });

  it("opens the console from /nuphos/ once the runtime answers", async () => {
    const { port } = await nuphos();
    const entry = await request(port, "/nuphos/", { Accept: "text/html" });
    expect(entry.status).toBe(303);
    expect(entry.headers.location).toBe("/");
  });

  it("shows a short wait on /nuphos/ while the runtime starts", async () => {
    const port = await boot("nuphos", { NUPHOS_PORT: String(await closedPort()) });
    const entry = await request(port, "/nuphos/", { Accept: "text/html" });
    expect(entry.status).toBe(200);
    expect(entry.text).toContain("Starting Nuphos");
    expect(entry.text).toContain("url=/nuphos/");
  });

  it("keeps its own paths", async () => {
    const { app, port } = await nuphos();
    const meta = await request(port, "/api/meta");
    expect(meta.status).toBe(200);
    expect(app.http.some((seen) => seen.url.startsWith("/api/meta"))).toBe(false);
  });

  it("passes Nuphos's /acp connection through without the Hivra gate, and drops Hivra's credentials", async () => {
    const { app, port } = await nuphos();
    const reply = await upgrade(port, "/acp", { Authorization: "Bearer team-key-from-nuphos", Cookie: "__Host-hivra_auth=x" });
    expect(reply).toContain("101 Switching Protocols");
    const seen = app.ws.at(-1)!;
    expect(seen.url).toBe("/acp");
    expect(seen.headers.authorization).toBe("Bearer team-key-from-nuphos");
    expect(seen.headers.cookie).toBeUndefined();
    expect(seen.headers.host).toBe("box.hivra.test");
    expect(seen.headers["x-forwarded-proto"]).toBe("https");
  });

  it("strips the Hivra bearer from an /acp upgrade that carries it", async () => {
    const { app, port } = await nuphos();
    await upgrade(port, "/acp", { Authorization: `Bearer ${TOKEN}` });
    expect(app.ws.at(-1)!.headers.authorization).toBeUndefined();
  });

  it("gates every other WebSocket", async () => {
    const { app, port } = await nuphos();
    expect(await upgrade(port, "/acp/x", {})).not.toContain("101");
    expect(await upgrade(port, "/_openab/console/live", {})).not.toContain("101");
    expect(app.ws).toEqual([]);
    expect(await upgrade(port, "/_openab/console/live", { Authorization: `Bearer ${TOKEN}` })).toContain("101");
  });

  it("does not open /acp without the gate on other agents", async () => {
    const app = await upstream();
    const port = await boot("openbot", { OPENBOT_PORT: String(app.port), NUPHOS_PORT: String(app.port) });
    expect(await upgrade(port, "/acp", {})).not.toContain("101");
    expect(app.ws).toEqual([]);
  });
});
