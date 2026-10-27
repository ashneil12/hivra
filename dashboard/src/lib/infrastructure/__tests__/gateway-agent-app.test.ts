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

// The gateway's side of agent app updates (Aeon dashboard, OpenClaw, Agent
// Zero): the installed version and update progress on the authenticated
// /api/meta, when the app was last used through the gateway (which
// hivra-agent-app-update.sh waits on), and the "being updated" answer while the
// updater holds its lock. The unmodified gateway runs here with
// child_process replaced and its file paths pointed at a temporary folder.

const TOKEN = "c".repeat(64);
const SERVER_PATH = path.join(process.cwd(), "provisioner/hivra-chat/server.js");
const SERVER_SOURCE = fs.readFileSync(SERVER_PATH, "utf8");
const DIGEST = `sha256:${"b".repeat(64)}`;

describe("gateway agent app reporting and update hold", () => {
  let home: string;
  let state: string;
  const closers: Array<() => Promise<void>> = [];
  let openclawOutput: string | null;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "hivra-agent-app-gateway-"));
    state = path.join(home, "state");
    fs.mkdirSync(state);
    openclawOutput = "OpenClaw 2026.6.10 (abc123)\n";
  });
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const paths = () => ({
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
    const openclawBin = path.join(home, "openclaw");
    fs.writeFileSync(openclawBin, "");
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
        if (file.endsWith("openclaw")) {
          const output = openclawOutput;
          setImmediate(() => output === null ? callback(new Error("not found"), "") : callback(null, output));
          return;
        }
        setImmediate(() => callback(new Error(`unexpected ${file} ${args.join(" ")}`), ""));
      },
    };
    const { record: recordFile, status, lock } = paths();
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
          HIVRA_AGENT_APP_RECORD: recordFile, HIVRA_AGENT_APP_STATUS: status, HIVRA_AGENT_APP_LOCK: lock,
          OPENCLAW_BIN: openclawBin, ...env,
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

  function get(port: number, pathname: string, { auth = true, accept = "application/json" } = {}): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1", port, path: pathname, method: "GET", agent: false,
        headers: { Host: "box.hivra.test", Accept: accept, ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}) },
      }, (res) => {
        let text = ""; res.setEncoding("utf8"); res.on("data", (c) => { text += c; });
        res.once("end", () => { let json: Record<string, unknown> = {}; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode ?? 0, text, json }); });
      });
      req.once("error", reject);
      req.end();
    });
  }

  async function upstream(): Promise<{ port: number; hits: string[] }> {
    const hits: string[] = [];
    const sockets = new Set<net.Socket>();
    const app = http.createServer((req, res) => { hits.push(req.url ?? ""); res.writeHead(200, { "Content-Type": "text/plain" }); res.end("app"); });
    app.on("connection", (socket) => sockets.add(socket));
    app.on("upgrade", (_req, socket) => { socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"); });
    app.listen(0, "127.0.0.1");
    await once(app, "listening");
    closers.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((r) => app.close(() => r())); });
    return { port: (app.address() as AddressInfo).port, hits };
  }

  it("reports the recorded Agent Zero image and update progress only to the computer's bearer", async () => {
    fs.writeFileSync(paths().record, JSON.stringify({ name: "agent-zero", version: DIGEST }));
    fs.writeFileSync(paths().status, JSON.stringify({ name: "agent-zero", state: "waiting", from: null, to: DIGEST, updatedAt: "2026-10-20T10:00:00Z" }));
    const port = await boot("agent-zero");
    const meta = await get(port, "/api/meta");
    expect(meta.json.agentApp).toMatchObject({
      name: "agent-zero",
      version: DIGEST,
      update: { state: "waiting", target: DIGEST, updatedAt: "2026-10-20T10:00:00Z" },
      activity: { openConnections: 0 },
    });
    expect(typeof (meta.json.agentApp as { activity: { lastUsedAt: unknown } }).activity.lastUsedAt).toBe("string");
    expect((await get(port, "/api/meta", { auth: false })).json.agentApp).toBeUndefined();
  });

  it("reports no version for a record of another app or in the wrong form", async () => {
    fs.writeFileSync(paths().record, JSON.stringify({ name: "aeon", version: DIGEST }));
    fs.writeFileSync(paths().status, JSON.stringify({ name: "agent-zero", state: "done", to: "v2.14" }));
    const port = await boot("agent-zero");
    const app = (await get(port, "/api/meta")).json.agentApp as Record<string, unknown>;
    expect(app.version).toBeNull();
    expect(app.update).toBeUndefined();
  });

  it("asks OpenClaw for its version, and says it is still checking until the answer is in", async () => {
    const port = await boot("openclaw");
    const first = (await get(port, "/api/meta")).json.agentApp as Record<string, unknown>;
    // The probe answers on the next turn; the first reading may still be checking.
    if (first.checking === true) expect(first.version).toBeUndefined();
    await new Promise((r) => setImmediate(r));
    expect((await get(port, "/api/meta")).json.agentApp).toMatchObject({ name: "openclaw", version: "2026.6.10" });
  });

  it("gives Claude Code and Codex computers no agentApp", async () => {
    const port = await boot("codex");
    expect((await get(port, "/api/meta")).json.agentApp).toBeUndefined();
  });

  it("answers the app's surface with 'being updated' while the updater holds its lock, and counts the attempt as use", async () => {
    const port = await boot("agent-zero");
    const before = (await get(port, "/api/meta")).json.agentApp as { activity: { lastUsedAt: string } };
    fs.writeFileSync(paths().lock, "");
    await new Promise((r) => setTimeout(r, 15));
    const page = await get(port, "/agent-zero/", { accept: "text/html" });
    expect(page.status).toBe(503);
    expect(page.text).toContain("Agent Zero is being updated");
    const after = (await get(port, "/api/meta")).json.agentApp as { activity: { lastUsedAt: string } };
    expect(Date.parse(after.activity.lastUsedAt)).toBeGreaterThan(Date.parse(before.activity.lastUsedAt));
    // Unauthenticated requests are refused as always, and never count.
    expect((await get(port, "/agent-zero/", { auth: false })).status).not.toBe(503);
  });

  it("stops holding the surface once a crashed updater's lock is 30 minutes old", async () => {
    const app = await upstream();
    const port = await boot("aeon", { AEON_DASHBOARD_PORT: String(app.port) });
    fs.writeFileSync(paths().lock, "");
    const old = Date.now() / 1000 - 31 * 60;
    fs.utimesSync(paths().lock, old, old);
    const page = await get(port, "/aeon/");
    expect(page.status).toBe(200);
    expect(app.hits).toEqual(["/aeon/"]);
  });

  it("records each proxied Aeon request as use and passes it through when no update holds it", async () => {
    const app = await upstream();
    const port = await boot("aeon", { AEON_DASHBOARD_PORT: String(app.port) });
    const before = Date.parse(((await get(port, "/api/meta")).json.agentApp as { activity: { lastUsedAt: string } }).activity.lastUsedAt);
    await new Promise((r) => setTimeout(r, 15));
    expect((await get(port, "/aeon/settings")).text).toBe("app");
    const after = Date.parse(((await get(port, "/api/meta")).json.agentApp as { activity: { lastUsedAt: string } }).activity.lastUsedAt);
    expect(after).toBeGreaterThan(before);
  });

  it("counts an open app WebSocket until it closes, and refuses new ones while an update holds the app", async () => {
    const app = await upstream();
    const port = await boot("openclaw", { OPENCLAW_GATEWAY_PORT: String(app.port) });
    const socket = net.connect(port, "127.0.0.1");
    await once(socket, "connect");
    socket.write(`GET /openclaw/ws HTTP/1.1\r\nHost: box.hivra.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nAuthorization: Bearer ${TOKEN}\r\n\r\n`);
    await once(socket, "data");
    expect(((await get(port, "/api/meta")).json.agentApp as { activity: { openConnections: number } }).activity.openConnections).toBe(1);
    socket.end();
    const open = async () => ((await get(port, "/api/meta")).json.agentApp as { activity: { openConnections: number } }).activity.openConnections;
    for (let tries = 0; tries < 40 && await open() !== 0; tries += 1) await new Promise((r) => setTimeout(r, 25));
    expect(await open()).toBe(0);

    fs.writeFileSync(paths().lock, "");
    const refused = net.connect(port, "127.0.0.1");
    await once(refused, "connect");
    refused.write(`GET /openclaw/ws HTTP/1.1\r\nHost: box.hivra.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nAuthorization: Bearer ${TOKEN}\r\n\r\n`);
    const [reply] = await once(refused, "data");
    expect(String(reply)).toMatch(/^HTTP\/1\.1 503/);
    refused.destroy();
  });
});
