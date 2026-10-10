import { once } from "node:events";
import fs from "node:fs";
import http, { type IncomingHttpHeaders } from "node:http";
import net, { type AddressInfo } from "node:net";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

// The computer gateway forwards the owner's chat to an attached agent's own
// sandboxed instance over /agents/<id>/, and only that (design 5.4, threats
// T12-T15). The complete, unmodified gateway module runs in the computer
// profile, pointed at a fake attached instance on a unix socket. The instance's
// answers are agent-controlled, so the gateway must strip cookies/CORS and pass
// only JSON, and refuse a socket that is not exactly the one root made.

const TOKEN = "e".repeat(64);
const GATEWAY_TOKEN = "f".repeat(64);
const SERVER_PATH = path.join(process.cwd(), "provisioner/hivra-chat/server.js");
const SERVER_SOURCE = fs.readFileSync(SERVER_PATH, "utf8");
const INSTALLATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GATEWAY_GID = 4242;
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type Upstream = { headers: IncomingHttpHeaders; status: number; body: string; type: string; extra?: Record<string, string> };

describe("attached agent gateway proxy", () => {
  let root: string;
  let home: string;
  let socketPath: string;
  let instance: http.Server;
  let lastUpstream: { authorization?: string; cookie?: string; method?: string; url?: string } = {};
  let reply: Upstream;
  const gateways: Array<{ close: () => Promise<void> }> = [];

  function writeRegistry(fields: Record<string, unknown>) {
    const dir = path.join(root, "etc/hivra/attachments", INSTALLATION);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "binding.json"), JSON.stringify({ version: 1, installationId: INSTALLATION, account: "hva_x", gatewayGid: 12345, ...fields }));
    fs.writeFileSync(path.join(dir, "gateway-token"), GATEWAY_TOKEN);
    fs.chmodSync(path.join(dir, "gateway-token"), 0o440);
  }

  async function boot(): Promise<number> {
    fs.mkdirSync(path.join(home, ".hivra"), { recursive: true });
    fs.writeFileSync(path.join(home, ".hivra", "api-token"), TOKEN);
    fs.writeFileSync(path.join(home, ".hivra", "agent-kind"), "linux-desktop\n");
    let server: http.Server | undefined;
    const sockets = new Set<net.Socket>();
    const realRequire = createRequire(SERVER_PATH);
    // Redirect the gateway's absolute /etc and /run lookups into the sandbox root.
    const realFs = realRequire("fs") as typeof fs;
    const isAttachment = (p: unknown) => typeof p === "string" && (p.startsWith("/etc/hivra") || p.startsWith("/run/hivra"));
    const redirect = (p: unknown) => isAttachment(p) ? path.join(root, (p as string).replace(/^\//, "")) : p;
    // These files and folders are root-owned in production. The tests run
    // unprivileged, so report uid 0 for exactly the redirected attachment paths
    // (nothing else), leaving mode and gid — which the gateway also checks — real.
    const fsShim = new Proxy(realFs, { get(target, key) {
      const value = (target as unknown as Record<string, unknown>)[key as string];
      if (key === "lstatSync") return (p: unknown, ...rest: unknown[]) => {
        const info = realFs.lstatSync(redirect(p) as string, ...(rest as []));
        if (!isAttachment(p)) return info;
        const isFile = info.isFile(), isSocket = info.isSocket(), isDirectory = info.isDirectory();
        // The socket's real group is 0 (root) when created unprivileged; the
        // per-attachment hvc_ group is nonzero in production, so report that.
        return { uid: 0, gid: isSocket ? GATEWAY_GID : info.gid, mode: info.mode, size: info.size, isFile: () => isFile, isSocket: () => isSocket, isDirectory: () => isDirectory };
      };
      if (key === "readFileSync") return (p: unknown, ...rest: unknown[]) => realFs.readFileSync(redirect(p) as string, ...(rest as []));
      return value;
    } });
    vm.runInNewContext(SERVER_SOURCE, {
      require: (name: string) => {
        if (name === "http") {
          return {
            ...http,
            createServer: (handler: http.RequestListener) => {
              server = http.createServer(handler);
              server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
              return server;
            },
            // The gateway connects to the literal /run/hivra-attached socket; the
            // real socket lives under the sandbox root, so redirect the path only.
            request: (options: http.ClientRequestArgs, cb?: (res: http.IncomingMessage) => void) => {
              const opts = options.socketPath && options.socketPath.startsWith("/run/hivra")
                ? { ...options, socketPath: path.join(root, options.socketPath.replace(/^\//, "")) } : options;
              return http.request(opts, cb);
            },
          };
        }
        if (name === "fs") return fsShim;
        if (name === "child_process") return { spawn: () => { throw new Error("no process"); }, execFile: () => { throw new Error("no process"); } };
        if (["path", "net", "crypto", "./llm-application.js", "./guarded-files.cjs", "./agent-zero-editor.cjs", "./chat-runs.cjs"].includes(name)) return realRequire(name);
        throw new Error(`Unexpected guest dependency: ${name}`);
      },
      process: { env: { HOME: home, HIVRA_CHAT_PORT: "0", HIVRA_AGENT_KIND: "linux-desktop" }, once: () => undefined },
      __dirname: path.dirname(SERVER_PATH),
      console: { log: () => undefined, warn: () => undefined, error: () => undefined },
      Buffer, URL, URLSearchParams, setTimeout, clearTimeout, setImmediate,
    }, { filename: SERVER_PATH });
    if (!server) throw new Error("gateway did not start");
    const created = server;
    gateways.push({ close: async () => { for (const s of sockets) s.destroy(); if (created.listening) await new Promise<void>((r) => created.close(() => r())); } });
    return created.listening ? (created.address() as AddressInfo).port : once(created, "listening").then(() => (created.address() as AddressInfo).port);
  }

  function request(port: number, method: string, pathname: string, headers: Record<string, string>, body?: string): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path: pathname, method, agent: false, headers: { Host: "box.hivra.test", ...headers } }, (res) => {
        let text = ""; res.setEncoding("utf8"); res.on("data", (c) => { text += c; });
        res.once("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
      });
      req.once("error", reject);
      req.setTimeout(4000, () => req.destroy(new Error("timed out")));
      req.end(body);
    });
  }

  beforeAll(async () => {
    // AF_UNIX paths are capped near 104 bytes, so root goes under a short /tmp
    // base rather than the long os.tmpdir() path.
    root = fs.mkdtempSync("/tmp/hvg-");
    home = path.join(root, "home"); fs.mkdirSync(home);
    fs.mkdirSync(path.join(root, "run/hivra-attached"), { recursive: true, mode: 0o711 });
    socketPath = path.join(root, "run/hivra-attached", INSTALLATION + ".sock");
    instance = http.createServer((req, res) => {
      lastUpstream = { authorization: req.headers.authorization as string, cookie: req.headers.cookie as string, method: req.method, url: req.url };
      res.writeHead(reply.status, { "Content-Type": reply.type, ...(reply.extra ?? {}) });
      res.end(reply.body);
    });
    instance.listen(socketPath);
    await once(instance, "listening");
    // root:hvc_ 0660 in a root-owned 0711 folder is what the real worker makes.
    // The tests run unprivileged, so match on mode and the registry's gid.
    fs.chmodSync(socketPath, 0o660);
    writeRegistry({ gatewayGid: GATEWAY_GID });
  });
  afterAll(async () => { for (const g of gateways.splice(0)) await g.close(); await new Promise<void>((r) => instance.close(() => r())); fs.rmSync(root, { recursive: true, force: true }); });
  beforeEach(() => { reply = { status: 200, type: "application/json", body: JSON.stringify({ ok: true }), headers: {} }; lastUpstream = {}; });

  it("forwards an owner chat request to the instance, stripping the owner's cookie and adding the instance bearer (T12/T13)", async () => {
    const port = await boot();
    reply = { status: 200, type: "application/x-ndjson", body: '{"type":"result"}\n', headers: {}, extra: { "X-Hivra-Run-Id": "r1" } };
    const result = await request(port, "POST", `/agents/${INSTALLATION}/api/chat`, { Authorization: `Bearer ${TOKEN}`, Cookie: "__Host-hivra_auth=owner", "Content-Type": "application/json" }, "{}");
    expect(result.status).toBe(200);
    expect(lastUpstream.authorization).toBe(`Bearer ${GATEWAY_TOKEN}`);
    expect(lastUpstream.cookie).toBeUndefined();
    expect(lastUpstream.url).toBe("/api/chat");
    expect(result.headers["content-type"]).toBe("application/x-ndjson");
    expect(result.headers["x-hivra-run-id"]).toBe("r1");
    expect(result.headers["content-security-policy"]).toBe("sandbox; default-src 'none'");
    expect(result.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("refuses a non-JSON answer and drops Set-Cookie the instance tries to serve on the computer origin (T12)", async () => {
    const port = await boot();
    reply = { status: 200, type: "text/html", body: "<script>steal()</script>", headers: {}, extra: { "Set-Cookie": "__Host-hivra_auth=forged; Path=/" } };
    const result = await request(port, "GET", `/agents/${INSTALLATION}/api/meta`, { Authorization: `Bearer ${TOKEN}` });
    expect(result.status).toBe(502);
    expect(result.headers["set-cookie"]).toBeUndefined();
    expect(result.body).not.toContain("<script>");
  });

  it("allows only the JSON route allowlist (T14)", async () => {
    const port = await boot();
    for (const [method, route] of [["GET", "/api/files"], ["GET", "/api/git/status"], ["POST", "/api/browser/toggle"], ["GET", "/index.html"], ["GET", "/terminal/"]] as Array<[string, string]>) {
      const result = await request(port, method, `/agents/${INSTALLATION}${route}`, { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, method === "POST" ? "{}" : undefined);
      expect(result.status).toBe(404);
    }
    expect(lastUpstream.url).toBeUndefined();
  });

  it("refuses an unknown or malformed installation id without connecting (T14)", async () => {
    const port = await boot();
    for (const id of [OTHER, "not-a-uuid", "../etc"]) {
      const result = await request(port, "GET", `/agents/${encodeURIComponent(id)}/api/meta`, { Authorization: `Bearer ${TOKEN}` });
      expect(result.status).toBe(404);
    }
    expect(lastUpstream.url).toBeUndefined();
  });

  it("requires the computer's own auth; an unauthenticated request never reaches the instance", async () => {
    const port = await boot();
    const result = await request(port, "GET", `/agents/${INSTALLATION}/api/meta`, {});
    expect(result.status).toBe(401);
    expect(lastUpstream.url).toBeUndefined();
  });

  it("refuses the attached instance's own token on the computer, so neither token opens the other (T13)", async () => {
    const port = await boot();
    for (const route of [`/agents/${INSTALLATION}/api/meta`, "/api/files?path=.", "/terminal/"]) {
      const result = await request(port, "GET", route, { Authorization: `Bearer ${GATEWAY_TOKEN}` });
      expect([route, result.status]).toEqual([route, 401]);
    }
    expect(lastUpstream.url).toBeUndefined();
  });

  it("never reaches the attached agent from a Files or Terminal workspace path", async () => {
    const port = await boot();
    for (const route of [`/workspace/grant/agents/${INSTALLATION}/api/meta`, `/workspace/agents/${INSTALLATION}/api/chat`]) {
      const result = await request(port, "GET", route, { Authorization: `Bearer ${TOKEN}` });
      expect(result.status).toBe(404);
    }
    expect(lastUpstream.url).toBeUndefined();
  });

  it("refuses to forward when the socket is missing, replaced by a regular file, or has the wrong mode (T15)", async () => {
    const port = await boot();
    const good = fs.lstatSync(socketPath).mode;
    fs.chmodSync(socketPath, 0o666);
    let result = await request(port, "GET", `/agents/${INSTALLATION}/api/meta`, { Authorization: `Bearer ${TOKEN}` });
    expect(result.status).toBe(503);
    expect(lastUpstream.url).toBeUndefined();
    fs.chmodSync(socketPath, good);
    // A regular file where the socket should be: refused without connecting.
    const stray = path.join(root, "run/hivra-attached", OTHER + ".sock");
    fs.writeFileSync(stray, "");
    fs.mkdirSync(path.join(root, "etc/hivra/attachments", OTHER), { recursive: true });
    fs.writeFileSync(path.join(root, "etc/hivra/attachments", OTHER, "binding.json"), JSON.stringify({ version: 1, installationId: OTHER, account: "hva_y", gatewayGid: GATEWAY_GID }));
    fs.writeFileSync(path.join(root, "etc/hivra/attachments", OTHER, "gateway-token"), GATEWAY_TOKEN);
    fs.chmodSync(path.join(root, "etc/hivra/attachments", OTHER, "gateway-token"), 0o440);
    result = await request(port, "GET", `/agents/${OTHER}/api/meta`, { Authorization: `Bearer ${TOKEN}` });
    expect(result.status).toBe(503);
  });
});
