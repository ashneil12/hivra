/** @jest-environment node */
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";

// The universal catalog app gateway must let an app own POST /login: the
// gateway's own connect-login handler answers 401 "this box is private" for
// every other agent kind, which broke real app logins (Grafana). Boot the
// unmodified server.js as catalog-app against a stub upstream and prove the
// app's login POST arrives, while the gateway's reserved paths stay reserved.

const TOKEN = "d".repeat(64);
const SERVER_PATH = path.join(process.cwd(), "provisioner/hivra-chat/server.js");
const SERVER_SOURCE = fs.readFileSync(SERVER_PATH, "utf8");

type Hit = { method: string; url: string; body: string };

async function freeCatalogPort(): Promise<number> {
  for (let port = 3999; port >= 3200; port--) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = http.createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error("no free catalog host port in 3200-3999");
}

describe("catalog-app gateway /login routing", () => {
  let home: string;
  let metaFile: string;
  let upstream: http.Server;
  let upstreamPort: number;
  let hits: Hit[];
  const closers: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "hivra-catalog-gw-"));
    fs.mkdirSync(path.join(home, ".hivra"), { recursive: true });
    fs.writeFileSync(path.join(home, ".hivra", "api-token"), TOKEN);
    upstreamPort = await freeCatalogPort();
    hits = [];
    upstream = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        hits.push({ method: req.method || "", url: req.url || "", body });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ upstream: true, path: req.url }));
      });
    });
    upstream.listen(upstreamPort, "127.0.0.1");
    await once(upstream, "listening");
    closers.push(async () => { if (upstream.listening) await new Promise<void>((r) => upstream.close(() => r())); });
    metaFile = path.join(home, "catalog-app.json");
    fs.writeFileSync(metaFile, JSON.stringify({
      appId: "testapp", name: "TestApp", kind: "docker-web",
      hostPort: upstreamPort, healthPath: "/", proxyMode: "standard",
    }));
  });
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  function boot(): Promise<number> {
    let server: http.Server | undefined;
    const realRequire = createRequire(SERVER_PATH);
    const fakeHttp = {
      ...http,
      createServer: (handler: http.RequestListener) => {
        server = http.createServer(handler);
        return server;
      },
    };
    vm.runInNewContext(SERVER_SOURCE, {
      require: (name: string) => {
        if (name === "http") return fakeHttp;
        if (["path", "crypto", "net", "fs", "child_process", "./llm-application.js", "./guarded-files.cjs", "./agent-zero-editor.cjs", "./chat-runs.cjs", "./import-state.cjs"].includes(name)) return realRequire(name);
        throw new Error(`Unexpected guest dependency: ${name}`);
      },
      process: { env: { HOME: home, HIVRA_CHAT_PORT: "0", HIVRA_AGENT_KIND: "catalog-app", HIVRA_CATALOG_APP_META: metaFile }, once: () => undefined, getuid: () => os.userInfo().uid },
      __dirname: path.dirname(SERVER_PATH),
      console: { log: () => undefined, warn: () => undefined, error: () => undefined },
      Buffer, URL, URLSearchParams, setTimeout, clearTimeout, setImmediate,
    }, { filename: SERVER_PATH });
    if (!server) throw new Error("gateway did not create its HTTP server");
    const created = server;
    closers.push(async () => { if (created.listening) { created.closeAllConnections?.(); await new Promise<void>((r) => created.close(() => r())); } });
    return created.listening ? Promise.resolve((created.address() as AddressInfo).port)
      : once(created, "listening").then(() => (created.address() as AddressInfo).port);
  }

  function request(port: number, method: string, pathname: string, body?: unknown, auth = true): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
      const req = http.request({
        hostname: "127.0.0.1", port, path: pathname, method, agent: false,
        headers: { Host: "box.hivra.test", ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}), ...(payload ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) } : {}) },
      }, (res) => {
        let text = ""; res.setEncoding("utf8"); res.on("data", (c) => { text += c; });
        res.once("end", () => { let json: Record<string, unknown> = {}; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode ?? 0, text, json }); });
      });
      req.once("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  it("proxies POST /login to the catalog app instead of the connect-login deny page", async () => {
    const port = await boot();
    const res = await request(port, "POST", "/login", { username: "owner", password: "secret", next: "/" });
    expect(res.status).toBe(200);
    expect(res.json.upstream).toBe(true);
    expect(hits).toEqual([{ method: "POST", url: "/login", body: JSON.stringify({ username: "owner", password: "secret", next: "/" }) }]);
  });

  it("keeps the gateway's reserved paths away from the app", async () => {
    const port = await boot();
    hits = [];
    expect((await request(port, "GET", "/healthz", undefined, false)).status).toBe(200);
    expect((await request(port, "GET", "/connect/abc:def", undefined, false)).status).toBe(401);
    expect((await request(port, "POST", "/auth/bootstrap", "token=" + TOKEN + "&destination=/", false)).status).toBe(303);
    expect((await request(port, "POST", "/connect/grant", { label: "x" })).status).toBe(400);
    expect(hits).toEqual([]);
    // Ordinary app paths still proxy through.
    expect((await request(port, "GET", "/dashboard")).json.upstream).toBe(true);
    expect(hits.map((h) => h.url)).toEqual(["/dashboard"]);
  });
});
