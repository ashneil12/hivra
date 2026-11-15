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
  let upstreamPort = 0;
  let upstreamUpgradeCount = 0;
  const sockets = new Set<Socket>();
  // Every evaluation of the guest module is one gateway process lifetime.
  const extraGateways: http.Server[] = [];

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

  // Evaluate the complete, unmodified guest module. Only filesystem and
  // process creation are isolated; requests, routing, crypto, cookies, and
  // WebSocket handshakes exercise the real server on ephemeral loopback ports.
  // Do not inherit process.env or read the developer's HOME/credentials.
  // The fixture offers no sign-in store the gateway can trust (no user id, no
  // ~/.hivra), so sign-ins live in each evaluation only: the fallback a real
  // gateway uses when its store cannot be saved. Restarts with a saved store
  // run real processes in hivra-surface-session-store.test.ts.
  async function evaluateGuest(env: Record<string, string> = {}): Promise<http.Server> {
    const serverPath = path.join(process.cwd(), "provisioner/hivra-chat/server.js");
    const source = readFileSync(serverPath, "utf8");
    const fixtureFs = {
      readFileSync: (filename: string) => {
        if (filename === "/home/bux/.hivra/api-token") return FIXTURE_TOKEN;
        throw Object.assign(new Error("Fixture file does not exist"), { code: "ENOENT" });
      },
    };
    const rejectProcess = () => { throw new Error("Auth tests must not start a real agent or shell"); };
    let created: http.Server | undefined;
    vm.runInNewContext(source, {
      require: (name: string) => {
        switch (name) {
          case "http":
            return {
              ...http,
              createServer: (handler: http.RequestListener) => {
                created = http.createServer(handler);
                trackSockets(created);
                return created;
              },
            };
          case "fs": return fixtureFs;
          case "path": return path;
          case "child_process": return { spawn: rejectProcess, execFile: rejectProcess };
          case "net": return net;
          case "crypto": return crypto;
          case "./llm-application.js": return createRequire(serverPath)(name);
          case "./guarded-files.cjs":
          case "./agent-zero-editor.cjs":
          // Loaded for chat runtimes; it touches the disk only when a run starts.
          case "./chat-runs.cjs": return createRequire(serverPath)(name);
          default: throw new Error(`Unexpected guest dependency: ${name}`);
        }
      },
      process: {
        env: {
          HIVRA_CHAT_PORT: "0",
          HIVRA_AGENT_KIND: "generic",
          AEON_DASHBOARD_PORT: String(upstreamPort),
          ...env,
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
    if (!created) throw new Error("Guest did not create its HTTP server");
    if (!created.listening) await once(created, "listening");
    return created;
  }

  function request(
    pathname: string,
    options: { method?: string; headers?: OutgoingHttpHeaders; body?: string; port?: number } = {},
  ): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port: options.port ?? gatewayPort,
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

  function bootstrap(destination = "/aeon/?view=compact", token = FIXTURE_TOKEN, port?: number) {
    return request("/auth/bootstrap", {
      port,
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
    upstreamPort = await listen(upstream);
    gateway = await evaluateGuest();
    gatewayPort = (gateway.address() as AddressInfo).port;
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([close(gateway), close(upstream), ...extraGateways.map(close)]);
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

  it("advertises one stable, uncached bootId (the sign-in epoch) while the gateway runs", async () => {
    const first = await request("/api/meta");
    const second = await request("/api/meta");
    const bootId = JSON.parse(first.body).bootId;
    expect(bootId).toMatch(/^[a-f0-9]{32}$/);
    expect(JSON.parse(second.body).bootId).toBe(bootId);
    expect(first.headers["cache-control"]).toBe("no-store");
    // Public metadata: the identity is not the bearer and not a session.
    expect(FIXTURE_TOKEN).not.toContain(bootId);
    const cookie = await sessionCookie();
    expect(cookie).not.toContain(bootId);
  });

  it("changes bootId on restart when the sign-ins could not be saved and are gone", async () => {
    const before = JSON.parse((await request("/api/meta")).body).bootId;
    const cookie = await sessionCookie();
    expect((await request("/aeon/", { headers: { Cookie: cookie } })).status).toBe(200);

    // Re-evaluating the module is a fresh gateway process (systemd restart)
    // with nothing saved from the previous one.
    const restarted = await evaluateGuest();
    extraGateways.push(restarted);
    const port = (restarted.address() as AddressInfo).port;
    const after = JSON.parse((await request("/api/meta", { port })).body).bootId;
    expect(after).toMatch(/^[a-f0-9]{32}$/);
    expect(after).not.toBe(before);
    // This is the failure the dashboard watches bootId for: the frame's old
    // cookie is now a 401 until it re-submits its bootstrap form.
    expect((await request("/aeon/", { port, headers: { Cookie: cookie } })).status).toBe(401);
    const renewed = await bootstrap("/aeon/", FIXTURE_TOKEN, port);
    expect(renewed.status).toBe(303);
    const renewedCookie = renewed.headers["set-cookie"]![0].split(";")[0];
    expect((await request("/aeon/", { port, headers: { Cookie: renewedCookie } })).status).toBe(200);
    expect(JSON.parse((await request("/api/meta", { port })).body).bootId).toBe(after);
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

  it("mints a connect grant only for the management bearer, never for a surface cookie", async () => {
    const cookie = await sessionCookie();
    const body = JSON.stringify({ username: "hivra", password: "b".repeat(64), destination: "/aeon/" });
    const headers = { "Content-Type": "application/json" };
    expect((await request("/connect/grant", { method: "POST", headers, body })).status).toBe(401);
    expect((await request("/connect/grant", { method: "POST", headers: { ...headers, Cookie: cookie }, body })).status).toBe(401);
    const granted = await request("/connect/grant", {
      method: "POST",
      headers: { ...headers, Authorization: `Bearer ${FIXTURE_TOKEN}` },
      body,
    });
    expect(granted.status).toBe(200);
    const parsed = JSON.parse(granted.body);
    expect(parsed.ok).toBe(true);
    expect(parsed.expiresAt).toBeGreaterThan(Date.now());
    expect(JSON.stringify(granted.headers)).not.toContain("b".repeat(64));
  });

  it.each([
    { username: "hivra", password: "not-hex", destination: "/aeon/" },
    { username: "bad user!", password: "b".repeat(64), destination: "/aeon/" },
    { username: "hivra", password: "b".repeat(64), destination: "https://attacker.example/" },
    { username: "hivra", password: "b".repeat(64), destination: "//attacker.example/" },
    { username: "hivra", password: "b".repeat(64), destination: "/aeon/\r\nX-Injected: yes" },
  ])("rejects a malformed or unsafe connect grant %j", async (payload) => {
    const result = await request("/connect/grant", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${FIXTURE_TOKEN}` },
      body: JSON.stringify(payload),
    });
    expect(result.status).toBe(400);
  });

  it("clamps a connect grant's lifetime into its bounds", async () => {
    const granted = await request("/connect/grant", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${FIXTURE_TOKEN}` },
      body: JSON.stringify({ username: "hivra", password: "c".repeat(64), destination: "/aeon/", ttlMs: 1 }),
    });
    expect(granted.status).toBe(200);
    const expiresAt = JSON.parse(granted.body).expiresAt;
    expect(expiresAt).toBeGreaterThanOrEqual(Date.now() + 59_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 61_000);
  });

  it("redeems a connect link into the same surface cookie the dashboard bootstrap mints", async () => {
    const username = "hivra";
    const password = "d".repeat(64);
    const granted = await request("/connect/grant", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${FIXTURE_TOKEN}` },
      body: JSON.stringify({ username, password, destination: "/aeon/" }),
    });
    expect(granted.status).toBe(200);

    const redeem = await request(`/connect/${username}:${password}`);
    expect(redeem.status).toBe(303);
    expect(redeem.headers.location).toBe("/aeon/");
    const cookie = redeem.headers["set-cookie"]?.[0] ?? "";
    expect(cookie).toMatch(new RegExp(`^${AUTH_COOKIE}=[a-f0-9]{64};`));
    expect(cookie).toContain("; HttpOnly");
    expect(cookie).toContain("; Secure");
    expect(cookie).toContain("; SameSite=None");
    expect(cookie).toContain("; Partitioned");

    const surface = await request("/aeon/", { headers: { Cookie: cookie.split(";")[0] } });
    expect(surface.status).toBe(200);
    expect(surface.body).toBe("fixture surface reached");
  });

  it.each([
    "/connect/hivra:wrong-password",
    "/connect/hivra:not-hex-at-all",
    "/connect/unknown-user:" + "e".repeat(64),
    "/connect/no-separator",
    "/connect/",
  ])("denies an unredeemable connect link %j without a cookie or redirect", async (pathname) => {
    const result = await request(pathname);
    expect(result.status).toBe(401);
    expect(result.headers["set-cookie"]).toBeUndefined();
    expect(result.headers.location).toBeUndefined();
  });

  it("redeems Agent Zero's native sign-in form against the same grant", async () => {
    const username = "hivra";
    const password = "f".repeat(64);
    await request("/connect/grant", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${FIXTURE_TOKEN}` },
      body: JSON.stringify({ username, password, destination: "/agent-zero/" }),
    });

    // The A0 desktop app's remote-instance client POSTs exactly this shape.
    const login = await request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username, password, next: "/agent-zero" }).toString(),
    });
    expect(login.status).toBe(303);
    expect(login.headers.location).toBe("/agent-zero");
    const cookie = login.headers["set-cookie"]?.[0] ?? "";
    expect(cookie).toMatch(new RegExp(`^${AUTH_COOKIE}=[a-f0-9]{64};`));

    // A0's default next="/" means "the surface the grant was minted for".
    const defaulted = await request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username, password, next: "/" }).toString(),
    });
    expect(defaulted.status).toBe(303);
    expect(defaulted.headers.location).toBe("/agent-zero/");
  });

  it("rejects a sign-in form with the wrong password or an unsafe next", async () => {
    const username = "hivra";
    const password = "0".repeat(64);
    await request("/connect/grant", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${FIXTURE_TOKEN}` },
      body: JSON.stringify({ username, password, destination: "/aeon/" }),
    });
    const wrong = await request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username, password: "9".repeat(64), next: "/aeon/" }).toString(),
    });
    expect(wrong.status).toBe(401);
    expect(wrong.headers["set-cookie"]).toBeUndefined();
    // next is never trusted over the box's own path rules.
    const unsafe = await request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username, password, next: "https://attacker.example/" }).toString(),
    });
    expect(unsafe.status).toBe(303);
    expect(unsafe.headers.location).toBe("/aeon/");
  });

  it("revokes every connect grant on DELETE /connect/grant", async () => {
    const username = "hivra";
    const password = "1".repeat(64);
    await request("/connect/grant", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${FIXTURE_TOKEN}` },
      body: JSON.stringify({ username, password, destination: "/aeon/" }),
    });
    expect((await request(`/connect/${username}:${password}`)).status).toBe(303);

    // Revocation itself needs the management bearer.
    expect((await request("/connect/grant", { method: "DELETE" })).status).toBe(401);
    const revoked = await request("/connect/grant", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${FIXTURE_TOKEN}` },
    });
    expect(revoked.status).toBe(200);
    expect((await request(`/connect/${username}:${password}`)).status).toBe(401);
    const login = await request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username, password, next: "/aeon/" }).toString(),
    });
    expect(login.status).toBe(401);
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

  // Agent Zero changed its / document from the app shell (v2.2) to a splash
  // bootstrap that installs the real document from /ui/index (v2.15+). The
  // gateway must keep serving the pinned app document on both layouts.
  const A0_APP_DOC = [
    "<!doctype html><html><body>",
    '<script type="module" src="index.js"></script>',
    '<script type="module" src="js/initFw.js"></script>',
    "</body></html>",
  ].join("");
  const A0_SPLASH_DOC =
    '<!doctype html><html><body><script>const APP_DOCUMENT_PATH = "/ui/index"</script></body></html>';

  function a0Upstream(layout: "splash" | "direct", seen: string[]) {
    return http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      if (req.method === "POST" && req.url === "/login") {
        res.writeHead(303, { "Set-Cookie": "session=a0-session", Location: "/" });
        return res.end();
      }
      if (req.method === "GET" && (req.url === "/index.html" || (layout === "direct" && req.url === "/"))) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(A0_APP_DOC);
      }
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(A0_SPLASH_DOC);
      }
      res.writeHead(404);
      res.end();
    });
  }

  async function agentZeroGateway(layout: "splash" | "direct", seen: string[]) {
    const a0 = a0Upstream(layout, seen);
    trackSockets(a0);
    const a0Port = await listen(a0);
    const a0Gateway = await evaluateGuest({
      HIVRA_AGENT_KIND: "agent-zero",
      AGENT_ZERO_PORT: String(a0Port),
    });
    extraGateways.push(a0Gateway);
    const port = (a0Gateway.address() as AddressInfo).port;
    const signin = await bootstrap("/agent-zero/", FIXTURE_TOKEN, port);
    expect(signin.status).toBe(303);
    const cookie = signin.headers["set-cookie"]![0].split(";")[0];
    return { a0, port, cookie };
  }

  it("serves the pinned Agent Zero document through the newer splash layout", async () => {
    const seen: string[] = [];
    const { a0, port, cookie } = await agentZeroGateway("splash", seen);
    const result = await request("/agent-zero/", { port, headers: { Cookie: cookie } });
    expect(result.status).toBe(200);
    expect(result.body).toContain('src="/index.js"');
    expect(result.body).toContain('src="/js/initFw.js"');
    expect(result.body).not.toContain("APP_DOCUMENT_PATH");
    // The splash at / failed the pinned contract, so the canonical document
    // path was fetched instead.
    expect(seen).toContain("GET /index.html");
    await close(a0);
  });

  it("still serves the pinned Agent Zero document directly on the older layout", async () => {
    const seen: string[] = [];
    const { a0, port, cookie } = await agentZeroGateway("direct", seen);
    const result = await request("/agent-zero/", { port, headers: { Cookie: cookie } });
    expect(result.status).toBe(200);
    expect(result.body).toContain('src="/index.js"');
    expect(result.body).toContain('src="/js/initFw.js"');
    // The document at / satisfied the contract; no fallback fetch happened.
    expect(seen).not.toContain("GET /index.html");
    await close(a0);
  });

  it("rejects the Agent Zero document when neither entry path satisfies the contract", async () => {
    const a0 = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<!doctype html><html><body>unrecognized</body></html>");
    });
    trackSockets(a0);
    const a0Port = await listen(a0);
    const a0Gateway = await evaluateGuest({
      HIVRA_AGENT_KIND: "agent-zero",
      AGENT_ZERO_PORT: String(a0Port),
    });
    extraGateways.push(a0Gateway);
    const port = (a0Gateway.address() as AddressInfo).port;
    const signin = await bootstrap("/agent-zero/", FIXTURE_TOKEN, port);
    const cookie = signin.headers["set-cookie"]![0].split(";")[0];
    const result = await request("/agent-zero/", { port, headers: { Cookie: cookie } });
    expect(result.status).toBe(502);
    expect(result.body).toBe("native entry document unavailable");
    await close(a0);
  });

  it("redirects a direct hit on the newer bootstrap document path back to the mount root", async () => {
    const seen: string[] = [];
    const { a0, port, cookie } = await agentZeroGateway("splash", seen);
    const result = await request("/agent-zero/ui/index", { port, headers: { Cookie: cookie } });
    expect(result.status).toBe(302);
    expect(result.headers.location).toBe("/agent-zero/");
    // Nothing was forwarded upstream for the redirected request.
    expect(seen.filter((entry) => entry === "GET /ui/index")).toHaveLength(0);
    await close(a0);
  });
});
