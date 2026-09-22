import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import { once } from "node:events";
import { createRequire } from "node:module";
import * as path from "node:path";
import * as vm from "node:vm";
import { verifyProviderNativePublicRuntime } from "../provider-native-public-readiness";

// Real checked-in management router, bootstrap/session handling and native
// broker over loopback HTTP. Package/terminal processes, root configuration and
// the outbound DNS/TLS boundary are fixtures, not live provider/UI evidence.
it("composes the native readiness probe with the actual guest gateway and session broker", async () => {
  const origin = "https://computer.example.test", hostname = new URL(origin).hostname, management = "a".repeat(64);
  const root = path.join(process.cwd(), "provisioner"), serverPath = path.join(root, "hivra-chat/server.js");
  const realRequire = createRequire(serverPath);
  const policy = realRequire(path.join(root, "deepseek-harness/gateway-policy.cjs"));
  const { createNativeBroker } = realRequire(path.join(root, "deepseek-harness/native-broker.cjs"));
  const launchToken = randomBytes(32).toString("base64url"), peers = new Set<net.Socket>();
  const incoming: { url: string; options: RequestInit }[] = [], nativeHeaders: http.IncomingHttpHeaders[] = [];
  let fault = "clean", gateway: http.Server | undefined, broker: ReturnType<typeof createNativeBroker>;
  const track = (server: http.Server) => server.on("connection", socket => {
    peers.add(socket); socket.on("error", () => undefined); socket.on("close", () => peers.delete(socket));
  });
  const upstream = track(http.createServer((req, res) => {
    req.resume();
    if (req.url === `/?token=${launchToken}`) {
      const now = Date.now(), payload = Buffer.from(JSON.stringify({ version: 1, authority: req.headers.host,
        issuedAt: now, expiresAt: now + 60000 })).toString("base64url");
      res.writeHead(303, { location: "/", "set-cookie": `dsh-auth-${createHash("sha256").update(req.headers.host!).digest("base64url")}=v1.${payload}.${randomBytes(32).toString("base64url")}; Path=/; HttpOnly; SameSite=Strict` });
      res.end(); return;
    }
    nativeHeaders.push(req.headers);
    res.writeHead(fault === "terminal_unavailable" && req.url === "/terminal/" ? 503 : 200, { "content-type": "text/html; charset=utf-8" });
    res.end(fault === "wrong_native_html" ? "not the native document" : '<!doctype html><html><head><base href="/"></head></html>');
  }));
  try {
    upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
    const upstreamPort = (upstream.address() as net.AddressInfo).port;
    vm.runInNewContext(readFileSync(serverPath, "utf8"), {
      require(name: string) {
        if (name === "http") return { ...http,
          createServer(handler: http.RequestListener) {
            gateway = track(http.createServer(handler));
            const listen = gateway.listen.bind(gateway);
            gateway.listen = ((port: number | string, callback?: () => void) => {
              expect(Number(port)).toBe(0); return listen(0, "127.0.0.1", callback);
            }) as typeof gateway.listen;
            return gateway;
          },
          request(options: http.RequestOptions, callback?: (res: http.IncomingMessage) => void) {
            // Fixed ttyd ports are simulated; never touch a local service.
            expect(options.hostname ?? options.host).toBe("127.0.0.1"); expect([6080, 7681, 7682]).toContain(options.port);
            return http.request({ ...options, port: upstreamPort, agent: false }, callback);
          },
        };
        if (name === "fs") return { readFileSync(filename: string) {
          if (filename === "/home/bux/.hivra/api-token") return management;
          if (filename === "/home/bux/.hivra/agent-kind") return "deepseek-harness";
          throw Object.assign(new Error("fixture missing"), { code: "ENOENT" });
        } };
        if (name === "child_process") return { spawn() { throw new Error("No agent processes in gateway fixture"); }, execFile() { throw new Error("No agent processes in gateway fixture"); } };
        if (name === "./deepseek-harness/gateway-policy.cjs") return { ...policy, loadConfiguration: () => ({ publicOrigin: origin, runtimeDirectory: "/fixture-runtime", home: "/fixture-home" }) };
        if (name === "./deepseek-harness/native-broker.cjs") return { createNativeBroker(options: Record<string, unknown>) {
          broker = createNativeBroker({ ...options, upstreamPort }); return broker;
        } };
        if (name === "./deepseek-harness/runtime-process.cjs") return { startRuntime: async () => ({}) };
        if (name === "./guarded-files.cjs") return { createGuardedFiles: () => ({}) };
        if (["path", "net", "crypto", "./llm-application.js", "./agent-zero-editor.cjs"].includes(name)) return realRequire(name);
        throw new Error(`Unexpected fixture dependency ${name}`);
      },
      process: { env: { HIVRA_CHAT_PORT: "0", HIVRA_AGENT_KIND: "deepseek-harness" }, once() {}, exit() {} },
      __dirname: path.dirname(serverPath), Buffer, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
      console: { log() {}, error() {} },
    }, { filename: serverPath, timeout: 2000 });
    if (!gateway!.listening) await once(gateway!, "listening");
    const gatewayPort = (gateway!.address() as net.AddressInfo).port;
    const fetcher = async (url: string, options: RequestInit = {}): Promise<Response> => {
      expect(new URL(url).origin).toBe(origin);
      expect(options.redirect).toBe("manual");
      incoming.push({ url, options });
      return new Promise((resolve, reject) => {
        const req = http.request({ hostname: "127.0.0.1", port: gatewayPort, path: new URL(url).pathname, method: options.method,
          headers: { host: hostname, ...Object.fromEntries(new Headers(options.headers)) }, signal: options.signal ?? undefined, agent: false }, res => {
          const chunks: Buffer[] = [];
          res.on("error", reject); res.on("data", chunk => chunks.push(chunk));
          res.on("end", () => {
            const headers = new Headers();
            for (let index = 0; index < res.rawHeaders.length; index += 2) headers.append(res.rawHeaders[index], res.rawHeaders[index + 1]);
            resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers }));
          });
        });
        req.on("error", reject); req.setTimeout(2000, () => req.destroy(new Error("fixture timeout")));
        req.end(options.body);
      });
    };
    const input = { access: { mode: "cloudflare-named" as const, hostname, tunnelId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      sessionCookie: `__Host-hivra_auth=${"b".repeat(64)}` };
    expect(await verifyProviderNativePublicRuntime(input, fetcher)).toBe(false);
    expect(incoming.some(value => value.options.body)).toBe(false); // Broker not ready; no token relayed.
    expect(await broker.acceptLaunchLine(`dsh web: http://127.0.0.1:${upstreamPort}/?token=${launchToken}`)).toBe(true);
    const bootstrap = await fetcher(origin + "/auth/bootstrap", { method: "POST", redirect: "manual", headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: management, destination: "/" }).toString() });
    input.sessionCookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0];
    incoming.length = 0;
    expect(await verifyProviderNativePublicRuntime(input, fetcher)).toBe(true);
    expect(incoming).toHaveLength(11);
    expect(nativeHeaders.every(headers => !headers.cookie?.includes("__Host-hivra_auth") && !headers.authorization?.includes(management))).toBe(true);
    const nativeRequest = nativeHeaders.find(headers => headers.cookie?.startsWith("dsh-auth-"));
    expect(nativeRequest).toBeDefined(); expect(nativeRequest!.authorization).toBeUndefined();
    expect(nativeRequest!.cookie).not.toContain(management);
    expect(nativeRequest!.cookie).not.toContain("__Host-hivra_auth");
    await fetcher(origin + "/terminal/", { method: "GET", redirect: "manual",
      headers: { Cookie: input.sessionCookie + "; backend-session=keep", Authorization: "Custom backend-token", Origin: origin } });
    expect(nativeHeaders.at(-1)?.cookie).toBe("backend-session=keep");
    expect(nativeHeaders.at(-1)?.authorization).toBe("Custom backend-token");
    for (fault of ["terminal_unavailable", "wrong_native_html"]) expect(await verifyProviderNativePublicRuntime(input, fetcher)).toBe(false);
    broker.reset();
    expect(await verifyProviderNativePublicRuntime(input, fetcher)).toBe(false);
  } finally {
    broker?.close(); for (const socket of peers) socket.destroy();
    await Promise.all([gateway, upstream].filter((server): server is http.Server => Boolean(server))
      .map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }
}, 20000);
