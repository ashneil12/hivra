import crypto from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import http, { type IncomingHttpHeaders, type OutgoingHttpHeaders } from "node:http";
import net, { type AddressInfo, type Socket } from "node:net";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const FIXTURE_TOKEN = "a".repeat(64);
const BOX_HOST = "box.hivra.test";
const BOX_ORIGIN = `https://${BOX_HOST}`;
const DASHBOARD_ORIGIN = "https://canary.hivra.test";
const AUTH_COOKIE = "__Host-hivra_auth";

type HttpResult = {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
};

describe("Hivra guest surface authentication runtime", () => {
  let gateway: http.Server | undefined;
  let upstream: http.Server | undefined;
  let gatewayPort = 0;
  let upstreamUpgradeCount = 0;
  const sockets = new Set<Socket>();

  function trackSockets(server: http.Server) {
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
  }

  async function listen(server: http.Server): Promise<number> {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return (server.address() as AddressInfo).port;
  }

  async function close(server: http.Server | undefined): Promise<void> {
    if (!server?.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  function request(
    pathname: string,
    options: { method?: string; headers?: OutgoingHttpHeaders; body?: string } = {},
  ): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port: gatewayPort,
        path: pathname,
        method: options.method ?? "GET",
        agent: false,
        headers: { Host: BOX_HOST, ...options.headers },
      }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.once("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        res.once("error", reject);
      });
      req.once("error", reject);
      req.setTimeout(2_000, () => req.destroy(new Error("Guest auth request timed out")));
      req.end(options.body);
    });
  }

  function upgrade(pathname: string, headers: OutgoingHttpHeaders): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port: gatewayPort,
        path: pathname,
        agent: false,
        headers: {
          Host: BOX_HOST,
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": Buffer.alloc(16, 1).toString("base64"),
          "Sec-WebSocket-Version": "13",
          ...headers,
        },
      });
      req.once("upgrade", (res, socket) => {
        socket.destroy();
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: "" });
      });
      req.once("response", (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.once("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        res.once("error", reject);
      });
      req.once("error", reject);
      req.setTimeout(2_000, () => req.destroy(new Error("Guest auth WebSocket request timed out")));
      req.end();
    });
  }

  function bootstrap(destination = "/aeon/?view=compact", token = FIXTURE_TOKEN) {
    return request("/auth/bootstrap", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: DASHBOARD_ORIGIN,
      },
      body: new URLSearchParams({ token, destination }).toString(),
    });
  }

  async function sessionCookie(): Promise<string> {
    const result = await bootstrap();
    expect(result.status).toBe(303);
    const cookie = result.headers["set-cookie"]?.[0];
    expect(cookie).toBeDefined();
    return cookie!.split(";")[0];
  }

  beforeAll(async () => {
    // A harmless loopback surface lets the actual HTTP/WS proxy demonstrate
    // successful cookie auth without needing ttyd, Chrome, a VM, or an agent CLI.
    upstream = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("fixture surface reached");
    });
    trackSockets(upstream);
    upstream.on("upgrade", (req, socket) => {
      upstreamUpgradeCount += 1;
      const accept = crypto.createHash("sha1")
        .update(String(req.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
    });
    const upstreamPort = await listen(upstream);
    const serverPath = path.join(process.cwd(), "provisioner/hivra-chat/server.js");
    const source = readFileSync(serverPath, "utf8");
    const fixtureFs = {
      readFileSync: (filename: string) => {
        if (filename === "/home/bux/.hivra/api-token") return FIXTURE_TOKEN;
        throw Object.assign(new Error("Fixture file does not exist"), { code: "ENOENT" });
      },
    };
    const rejectProcess = () => { throw new Error("Auth tests must not start a real agent or shell"); };

    // Evaluate the complete, unmodified guest module. Only filesystem and
    // process creation are isolated; requests, routing, crypto, cookies, and
    // WebSocket handshakes exercise the real server on ephemeral loopback ports.
    // Do not inherit process.env or read the developer's HOME/credentials.
    vm.runInNewContext(source, {
      require: (name: string) => {
        switch (name) {
          case "http":
            return {
              ...http,
              createServer: (handler: http.RequestListener) => {
                gateway = http.createServer(handler);
                trackSockets(gateway);
                return gateway;
              },
            };
          case "fs": return fixtureFs;
          case "path": return path;
          case "child_process": return { spawn: rejectProcess, execFile: rejectProcess };
          case "net": return net;
          case "crypto": return crypto;
          case "./llm-application.js": return createRequire(serverPath)(name);
          case "./guarded-files.cjs":
          case "./agent-zero-editor.cjs": return createRequire(serverPath)(name);
          default: throw new Error(`Unexpected guest dependency: ${name}`);
        }
      },
      process: {
        env: {
          HIVRA_CHAT_PORT: "0",
          HIVRA_AGENT_KIND: "generic",
          AEON_DASHBOARD_PORT: String(upstreamPort),
        },
      },
      __dirname: path.dirname(serverPath),
      console: { log: () => undefined, warn: () => undefined, error: () => undefined },
      Buffer,
      URL,
      URLSearchParams,
      setTimeout,
      clearTimeout,
    }, { filename: serverPath, timeout: 2_000 });

    if (!gateway) throw new Error("Guest did not create its HTTP server");
    if (!gateway.listening) await once(gateway, "listening");
    gatewayPort = (gateway.address() as AddressInfo).port;
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([close(gateway), close(upstream)]);
  });

  it("advertises POST-cookie surface auth on the public capability endpoint", async () => {
    const result = await request("/api/meta");
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      agentKind: "generic",
      surfaceAuth: "post-cookie-v1",
    });
    expect(result.headers["access-control-allow-origin"]).toBe("*");
    expect(result.body).not.toContain(FIXTURE_TOKEN);
  });

  it("rejects a long-lived bearer in a terminal URL without minting a cookie", async () => {
    const result = await request(`/terminal/?token=${FIXTURE_TOKEN}`);
    expect(result.status).toBe(401);
    expect(result.headers["set-cookie"]).toBeUndefined();
    expect(result.headers.location).toBeUndefined();
    expect(result.body).not.toContain(FIXTURE_TOKEN);
  });

  it("bootstraps a cross-origin form into an opaque host-scoped cookie and a clean local redirect", async () => {
    const destination = "/aeon/?view=compact";
    const result = await bootstrap(destination);
    expect(result.status).toBe(303);
    expect(result.headers.location).toBe(destination);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.headers["referrer-policy"]).toBe("no-referrer");
    const cookie = result.headers["set-cookie"]?.[0] ?? "";
    expect(cookie).toMatch(new RegExp(`^${AUTH_COOKIE}=[a-f0-9]{64};`));
    expect(cookie).not.toContain(FIXTURE_TOKEN);
    expect(cookie).toContain("; Path=/");
    expect(cookie).toContain("; HttpOnly");
    expect(cookie).toContain("; Secure");
    expect(cookie).toContain("; SameSite=None");
    expect(cookie).toContain("; Partitioned");
    expect(cookie).toContain("; Max-Age=43200");
    expect(cookie.toLowerCase()).not.toContain("domain=");
    expect(JSON.stringify(result.headers)).not.toContain(FIXTURE_TOKEN);

    const surface = await request(destination, { headers: { Cookie: cookie.split(";")[0] } });
    expect(surface.status).toBe(200);
    expect(surface.body).toBe("fixture surface reached");
  });

  it("requires the body bearer to bootstrap, even when an existing session cookie is supplied", async () => {
    const cookie = await sessionCookie();
    const result = await request("/auth/bootstrap", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "incorrect", destination: "/aeon/" }).toString(),
    });
    expect(result.status).toBe(401);
    expect(result.headers["set-cookie"]).toBeUndefined();
    expect(result.headers.location).toBeUndefined();
  });

  it.each([
    "https://attacker.example/",
    "//attacker.example/",
    "/\\attacker.example/",
    "/aeon/\r\nX-Injected: yes",
    "",
  ])("rejects an unsafe bootstrap destination %j", async (destination) => {
    const result = await bootstrap(destination);
    expect(result.status).toBe(401);
    expect(result.headers["set-cookie"]).toBeUndefined();
    expect(result.headers.location).toBeUndefined();
  });

  it.each([undefined, "http://box.hivra.test", DASHBOARD_ORIGIN, "https://sibling.hivra.test"])(
    "rejects cookie-authenticated mutations from an absent or foreign origin %j",
    async (origin) => {
      const cookie = await sessionCookie();
      const result = await request("/api/login/complete", {
        method: "POST",
        headers: { Cookie: cookie, ...(origin ? { Origin: origin } : {}) },
      });
      expect(result.status).toBe(401);
    },
  );

  it("allows a cookie-authenticated mutation from the box's own HTTPS origin", async () => {
    const cookie = await sessionCookie();
    const result = await request("/api/login/complete", {
      method: "POST",
      headers: { Cookie: cookie, Origin: BOX_ORIGIN },
    });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ ok: true });
  });

  it("keeps explicit bearer-header API calls working across dashboard origins", async () => {
    const result = await request("/api/login/complete", {
      method: "POST",
      headers: { Authorization: `Bearer ${FIXTURE_TOKEN}`, Origin: DASHBOARD_ORIGIN },
    });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ ok: true });
  });

  it("does not accept a raw bearer value as a session cookie", async () => {
    const result = await request("/api/login/status", {
      headers: { Cookie: `${AUTH_COOKIE}=${FIXTURE_TOKEN}` },
    });
    expect(result.status).toBe(401);
  });

  it("rejects query-token and cross-origin cookie WebSockets before reaching the surface", async () => {
    const before = upstreamUpgradeCount;
    const cookie = await sessionCookie();
    const attempts = [
      await upgrade(`/aeon/ws?token=${FIXTURE_TOKEN}`, { Origin: BOX_ORIGIN }),
      await upgrade("/aeon/ws", { Cookie: cookie }),
      await upgrade("/aeon/ws", { Cookie: cookie, Origin: DASHBOARD_ORIGIN }),
    ];
    expect(attempts.map((result) => result.status)).toEqual([401, 401, 401]);
    expect(upstreamUpgradeCount).toBe(before);
  });

  it("allows the embedded surface's own-origin cookie WebSocket", async () => {
    const before = upstreamUpgradeCount;
    const cookie = await sessionCookie();
    const result = await upgrade("/aeon/ws", { Cookie: cookie, Origin: BOX_ORIGIN });
    expect(result.status).toBe(101);
    expect(result.headers.upgrade).toBe("websocket");
    expect(upstreamUpgradeCount).toBe(before + 1);
  });

  it("does not expose Agent Zero root extension or Socket.IO aliases on another runtime", async () => {
    const headers = { Authorization: `Bearer ${FIXTURE_TOKEN}` };
    for (const [pathname, method] of [["/extensions/webui/fixture.js", "GET"], ["/socket.io/?EIO=4&transport=polling", "GET"], ["/socket.io/?EIO=4&transport=polling", "POST"]]) {
      expect((await request(pathname, { method, headers })).status).toBe(404);
    }
    const before = upstreamUpgradeCount;
    await expect(upgrade("/socket.io/?EIO=4&transport=websocket", headers)).rejects.toMatchObject({ code: "ECONNRESET" });
    expect(upstreamUpgradeCount).toBe(before);
  });
});
