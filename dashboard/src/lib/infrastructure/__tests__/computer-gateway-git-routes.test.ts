import { once } from "node:events";
import fs from "node:fs";
import http, { type IncomingHttpHeaders } from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

// The computer profile answers /api/git/* with 404 before any process starts,
// so a repository the attached agent planted in ~/Hivra can never make Hivra's
// own gateway run its core.fsmonitor, hooks or filters as the owner (5.3.2,
// threat T10). The generic profile still reaches Git. The complete, unmodified
// gateway module runs with a recording Git stub, so "no process started" is
// proven by the stub never being called.

const TOKEN = "d".repeat(64);
const SERVER_PATH = path.join(process.cwd(), "provisioner/hivra-chat/server.js");
const SERVER_SOURCE = fs.readFileSync(SERVER_PATH, "utf8");

describe("computer profile Git routes", () => {
  let home: string;
  const gateways: Array<{ close: () => Promise<void> }> = [];
  let gitCalls: string[][];

  function boot(kind: "linux-desktop" | "generic"): Promise<number> {
    fs.mkdirSync(path.join(home, ".hivra"), { recursive: true });
    fs.writeFileSync(path.join(home, ".hivra", "api-token"), TOKEN);
    fs.writeFileSync(path.join(home, ".hivra", "agent-kind"), kind + "\n");
    let server: http.Server | undefined;
    const sockets = new Set<net.Socket>();
    const realRequire = createRequire(SERVER_PATH);
    vm.runInNewContext(SERVER_SOURCE, {
      require: (name: string) => {
        if (name === "http") {
          return { ...http, createServer: (handler: http.RequestListener) => {
            server = http.createServer(handler);
            server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
            return server;
          } };
        }
        if (name === "child_process") {
          return {
            spawn: () => { throw new Error("No process may start for a computer Git route"); },
            execFile: (bin: string, args: string[], _opts: unknown, cb: (e: unknown, o: string) => void) => {
              gitCalls.push([bin, ...args]);
              cb(null, "should-never-run");
            },
          };
        }
        if (["fs", "path", "net", "crypto", "./llm-application.js", "./guarded-files.cjs", "./agent-zero-editor.cjs", "./chat-runs.cjs"].includes(name)) {
          return realRequire(name);
        }
        throw new Error(`Unexpected guest dependency: ${name}`);
      },
      process: { env: { HOME: home, HIVRA_CHAT_PORT: "0", HIVRA_AGENT_KIND: kind }, once: () => undefined },
      __dirname: path.dirname(SERVER_PATH),
      console: { log: () => undefined, warn: () => undefined, error: () => undefined },
      Buffer, URL, URLSearchParams, setTimeout, clearTimeout, setImmediate,
    }, { filename: SERVER_PATH });
    if (!server) throw new Error("gateway did not create its HTTP server");
    const created = server;
    gateways.push({ close: async () => { for (const socket of sockets) socket.destroy(); if (created.listening) await new Promise<void>((r) => created.close(() => r())); } });
    return created.listening ? Promise.resolve((created.address() as AddressInfo).port) : once(created, "listening").then(() => (created.address() as AddressInfo).port);
  }

  function bootstrapCookie(port: number, host: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path: "/auth/bootstrap", method: "POST", agent: false,
        headers: { Host: host, Origin: `https://${host}`, "Content-Type": "application/x-www-form-urlencoded" } }, (res) => {
        res.resume();
        res.once("end", () => resolve((res.headers["set-cookie"]?.[0] ?? "").split(";")[0]));
      });
      req.once("error", reject);
      req.end(new URLSearchParams({ token: TOKEN, destination: "/" }).toString());
    });
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

  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "hivra-git-routes-")); gitCalls = []; });
  afterEach(async () => { for (const g of gateways.splice(0)) await g.close(); fs.rmSync(home, { recursive: true, force: true }); });

  const GIT_ROUTES: Array<[string, string]> = [
    ["GET", "/api/git/status?dir=repo"],
    ["GET", "/api/git/diff?dir=repo&path=work.txt"],
    ["POST", "/api/git/commit"],
    ["POST", "/api/git/checkout"],
  ];

  it("answers every Git route with 404 and starts no process, for a bearer and for a cookie session", async () => {
    const port = await boot("linux-desktop");
    const cookie = await bootstrapCookie(port, "box.hivra.test");
    expect(cookie).toMatch(/^__Host-hivra_auth=[a-f0-9]{64}$/);
    for (const [method, route] of GIT_ROUTES) {
      const bearer = await request(port, method, route, { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(method === "POST" ? {} : {}) }, method === "POST" ? "{}" : undefined);
      expect(bearer.status).toBe(404);
      expect(JSON.parse(bearer.body)).toEqual({ error: "git_unavailable_on_computer" });
      const withCookie = await request(port, method, route, { Cookie: cookie, Origin: "https://box.hivra.test", "Content-Type": "application/json" }, method === "POST" ? "{}" : undefined);
      expect(withCookie.status).toBe(404);
      expect(JSON.parse(withCookie.body)).toEqual({ error: "git_unavailable_on_computer" });
    }
    expect(gitCalls).toEqual([]);
    const meta = await request(port, "GET", "/api/meta", {});
    expect(JSON.parse(meta.body)).toMatchObject({ resourceKind: "computer", gitRoutes: false });
  });

  it("still reaches Git on the generic profile (the routes only close on a computer)", async () => {
    const port = await boot("generic");
    const status = await request(port, "GET", "/api/git/status?dir=repo", { Authorization: `Bearer ${TOKEN}` });
    // The generic gateway resolves the repo (rev-parse) through the recording
    // stub, so Git is reachable there; the point is only that it was called.
    expect(status.status).not.toBe(404);
    expect(gitCalls.some((call) => call.includes("rev-parse") || call.includes("status"))).toBe(true);
  });

  it("refuses the Git routes before authentication too, so an unauthenticated planted-repo probe starts nothing", async () => {
    const port = await boot("linux-desktop");
    const anon = await request(port, "GET", "/api/git/status?dir=repo", {});
    expect(anon.status).toBe(404);
    expect(gitCalls).toEqual([]);
  });
});
