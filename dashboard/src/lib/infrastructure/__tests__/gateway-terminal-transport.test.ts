/** @jest-environment node */
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

// Both terminals listen on owner-only unix sockets. The gateway uses a socket
// only when its folder and the socket itself belong to the gateway's own user
// and nobody else can write them; otherwise it falls back to the loopback port,
// where nothing listens on a current computer. The guest updater and the
// installer therefore check readiness through the gateway (its meta and a
// proxied request), never around it. The unmodified gateway runs here with the
// fixed /run paths mapped onto a temporary folder and a fake ttyd on each
// socket.

const TOKEN = "e".repeat(64);
const SERVER_PATH = path.join(process.cwd(), "provisioner/hivra-chat/server.js");
const SERVER_SOURCE = fs.readFileSync(SERVER_PATH, "utf8");
const UID = os.userInfo().uid;

describe("gateway terminal transport", () => {
  let home: string;
  let run: string;
  const closers: Array<() => Promise<void>> = [];

  const mapped = (value: unknown) => typeof value === "string" && value.startsWith("/run/hivra-")
    ? path.join(run, value.slice("/run/".length)) : value;

  function boot(uid = UID): Promise<number> {
    fs.mkdirSync(path.join(home, ".hivra"), { recursive: true });
    fs.writeFileSync(path.join(home, ".hivra", "api-token"), TOKEN);
    fs.writeFileSync(path.join(home, ".hivra", "agent-kind"), "linux-desktop\n");
    let server: http.Server | undefined;
    const sockets = new Set<net.Socket>();
    const realRequire = createRequire(SERVER_PATH);
    const realFs = realRequire("fs") as typeof fs;
    const fakeFs = { ...realFs, lstatSync: (p: fs.PathLike, ...rest: unknown[]) => (realFs.lstatSync as (...a: unknown[]) => fs.Stats)(mapped(p), ...rest) };
    const fakeHttp = {
      ...http,
      createServer: (handler: http.RequestListener) => {
        server = http.createServer(handler);
        server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
        return server;
      },
      request: (options: http.RequestOptions, callback?: (res: http.IncomingMessage) => void) =>
        http.request({ ...options, ...(options.socketPath ? { socketPath: mapped(options.socketPath) as string } : {}) }, callback),
    };
    const fakeNet = {
      ...net,
      connect: (first: unknown, ...rest: unknown[]) => (net.connect as (...a: unknown[]) => net.Socket)(
        first && typeof first === "object" && "path" in first ? { ...first, path: mapped((first as { path: string }).path) } : first, ...rest),
    };
    vm.runInNewContext(SERVER_SOURCE, {
      require: (name: string) => {
        if (name === "http") return fakeHttp;
        if (name === "fs") return fakeFs;
        if (name === "net") return fakeNet;
        if (name === "child_process") return { spawn: () => { throw new Error("no process"); }, execFile: () => { throw new Error("no process"); } };
        if (["path", "crypto", "./llm-application.js", "./guarded-files.cjs", "./agent-zero-editor.cjs", "./chat-runs.cjs"].includes(name)) return realRequire(name);
        throw new Error(`Unexpected guest dependency: ${name}`);
      },
      process: { env: { HOME: home, HIVRA_CHAT_PORT: "0", HIVRA_AGENT_KIND: "linux-desktop" }, once: () => undefined, getuid: () => uid },
      __dirname: path.dirname(SERVER_PATH),
      console: { log: () => undefined, warn: () => undefined, error: () => undefined },
      Buffer, URL, URLSearchParams, setTimeout, clearTimeout, setImmediate,
    }, { filename: SERVER_PATH });
    if (!server) throw new Error("gateway did not create its HTTP server");
    const created = server;
    closers.push(async () => { for (const socket of sockets) socket.destroy(); if (created.listening) await new Promise<void>((r) => created.close(() => r())); });
    return created.listening ? Promise.resolve((created.address() as AddressInfo).port)
      : once(created, "listening").then(() => (created.address() as AddressInfo).port);
  }

  // A fake ttyd on the mapped socket: answers HTTP and a websocket upgrade and
  // records the headers it received, so the test can see the gateway's bearer
  // never reaches the terminal.
  async function ttyd(folder: string, label: string, folderMode = 0o700) {
    const dir = path.join(run, folder);
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, folderMode);
    const seen: http.IncomingHttpHeaders[] = [];
    const server = http.createServer((req, res) => { seen.push(req.headers); res.writeHead(200, { "Content-Type": "text/plain" }); res.end(`${label} ${req.url}`); });
    server.on("upgrade", (req, socket) => {
      seen.push(req.headers);
      socket.end(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Ttyd: ${label}\r\n\r\n`);
    });
    const socketPath = path.join(dir, "ttyd.sock");
    server.listen(socketPath);
    await once(server, "listening");
    closers.push(() => new Promise<void>((r) => server.close(() => r())));
    return { socketPath, seen };
  }

  function request(port: number, pathname: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path: pathname, agent: false, headers: { Host: "box.hivra.test", ...headers } }, (res) => {
        let text = ""; res.setEncoding("utf8"); res.on("data", (c) => { text += c; });
        res.once("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      });
      req.once("error", reject);
      req.setTimeout(4000, () => req.destroy(new Error("timed out")));
      req.end();
    });
  }

  function upgrade(port: number, pathname: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        const nonce = Buffer.alloc(16, 7).toString("base64");
        socket.write(`GET ${pathname} HTTP/1.1\r\nHost: box.hivra.test\r\nAuthorization: Bearer ${TOKEN}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
          `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${nonce}\r\n\r\n`);
      });
      let text = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => { text += chunk; });
      socket.once("close", () => resolve(text));
      socket.once("error", reject);
      socket.setTimeout(4000, () => socket.destroy());
    });
  }

  const meta = async (port: number, headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }) =>
    JSON.parse((await request(port, "/api/meta", headers)).body) as { terminals?: Record<string, string> };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "hivra-terminal-home-"));
    // A short folder keeps socket paths under the unix path length limit.
    run = fs.mkdtempSync(path.join("/tmp", "hvt-"));
  });
  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(run, { recursive: true, force: true });
  });

  it("reports and uses both owner-only sockets, and strips its bearer before the terminal", async () => {
    const terminal = await ttyd("hivra-terminal", "AGENT");
    const box = await ttyd("hivra-box-terminal", "BOX");
    const port = await boot();
    expect((await meta(port)).terminals).toEqual({ terminal: "socket", boxTerminal: "socket" });
    expect(await request(port, "/terminal/", { Authorization: `Bearer ${TOKEN}` })).toEqual({ status: 200, body: "AGENT /terminal/" });
    expect(await request(port, "/box-terminal/", { Authorization: `Bearer ${TOKEN}` })).toEqual({ status: 200, body: "BOX /box-terminal/" });
    expect(await upgrade(port, "/terminal/ws")).toContain("X-Ttyd: AGENT");
    expect(await upgrade(port, "/box-terminal/ws")).toContain("X-Ttyd: BOX");
    for (const headers of [...terminal.seen, ...box.seen]) expect(headers.authorization).toBeUndefined();
  });

  it("accepts the socket mode libwebsockets actually creates (0660, group bux), because the 0700 folder is the boundary", async () => {
    // Found on a real Ubuntu 24.04 VM: ttyd 1.7.7 creates its socket 0660. A
    // check that refused group bits sent every computer back to the dead
    // loopback port after the update.
    const terminal = await ttyd("hivra-terminal", "AGENT");
    fs.chmodSync(terminal.socketPath, 0o660);
    const box = await ttyd("hivra-box-terminal", "BOX");
    fs.chmodSync(box.socketPath, 0o660);
    const port = await boot();
    expect((await meta(port)).terminals).toEqual({ terminal: "socket", boxTerminal: "socket" });
    expect(await request(port, "/terminal/", { Authorization: `Bearer ${TOKEN}` })).toEqual({ status: 200, body: "AGENT /terminal/" });
  });

  it("shows the transport only to a bearer (the updater and installer), never to an anonymous caller", async () => {
    await ttyd("hivra-terminal", "AGENT");
    const port = await boot();
    expect((await meta(port, {})).terminals).toBeUndefined();
    expect((await meta(port, { Authorization: `Bearer ${"0".repeat(64)}` })).terminals).toBeUndefined();
    expect((await request(port, "/terminal/")).status).toBe(401);
  });

  it.each([
    ["the runtime folder is readable by others", async () => { await ttyd("hivra-terminal", "AGENT", 0o755); }],
    ["the socket is open to other users", async () => { const t = await ttyd("hivra-terminal", "AGENT"); fs.chmodSync(t.socketPath, 0o666); }],
    ["the runtime folder is group-accessible", async () => { await ttyd("hivra-terminal", "AGENT", 0o750); }],
    ["the socket path is a link to another socket", async () => {
      const elsewhere = await ttyd("elsewhere", "ELSEWHERE");
      fs.mkdirSync(path.join(run, "hivra-terminal"), { mode: 0o700 });
      fs.symlinkSync(elsewhere.socketPath, path.join(run, "hivra-terminal", "ttyd.sock"));
    }],
    ["the socket is missing", async () => { fs.mkdirSync(path.join(run, "hivra-terminal"), { mode: 0o700 }); }],
  ])("falls back to the loopback port, and says so, when %s", async (_label, arrange) => {
    await arrange();
    await ttyd("hivra-box-terminal", "BOX");
    const port = await boot();
    expect((await meta(port)).terminals).toEqual({ terminal: "port", boxTerminal: "socket" });
    // Nothing listens on the old loopback port, so the owner's Terminal fails:
    // exactly what a readiness check through the gateway must catch.
    expect((await request(port, "/terminal/", { Authorization: `Bearer ${TOKEN}` })).status).not.toBe(200);
  });

  it("refuses sockets owned by another user, as when the gateway runs as a different account", async () => {
    await ttyd("hivra-terminal", "AGENT");
    await ttyd("hivra-box-terminal", "BOX");
    const port = await boot(UID + 1);
    expect((await meta(port)).terminals).toEqual({ terminal: "port", boxTerminal: "port" });
  });
});
