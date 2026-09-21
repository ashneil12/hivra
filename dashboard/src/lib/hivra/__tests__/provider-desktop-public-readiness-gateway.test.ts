/** @jest-environment node */
import { readFileSync } from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import { once } from "node:events";
import { createRequire } from "node:module";
import * as path from "node:path";
import * as vm from "node:vm";
import { verifyProviderDesktopPublicRuntime } from "../provider-desktop-public-readiness";

// Real gateway and broker HTTP composition. DNS/TLS, private root config and
// guest processes are substituted; no live computer or desktop session exists.
it("preserves broker framing authority through the public desktop gateway", async () => {
  const origin = "https://computer.example.test", hostname = new URL(origin).hostname;
  const controlOrigin = "https://canary.hermesos.cloud", root = path.join(process.cwd(), "provisioner");
  const serverPath = path.join(root, "hivra-chat/server.js"), realRequire = createRequire(serverPath);
  const { createRemoteDesktopBroker } = realRequire(path.join(root, "remote-desktop/broker.cjs"));
  const forbidden = jest.fn(async () => { throw new Error("No control-plane or guest requests permitted"); });
  const broker = createRemoteDesktopBroker({ controlOrigin, publicOrigin: origin, computerKind: "hivra-agent",
    computerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", transport: "selkies-websocket", upstreamPort: 1,
    basicAuthorization: "Basic " + Buffer.from("fixture:never-used").toString("base64"), verifyInputIsolation: forbidden, fetchFn: forbidden });
  const peers = new Set<net.Socket>(); let gateway: http.Server | undefined;
  const track = (server: http.Server) => server.on("connection", socket => {
    peers.add(socket); socket.on("error", () => undefined); socket.on("close", () => peers.delete(socket));
  });
  const upstream = track(http.createServer(broker.handleHttp));
  try {
    upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
    const upstreamPort = (upstream.address() as net.AddressInfo).port;
    vm.runInNewContext(readFileSync(serverPath, "utf8"), {
      require(name: string) {
        if (name === "http") return { ...http, createServer(handler: http.RequestListener) {
          gateway = track(http.createServer(handler)); return gateway;
        }, request(options: http.RequestOptions, callback?: (res: http.IncomingMessage) => void) {
          expect(options.host).toBe("127.0.0.1"); expect(options.port).toBe(upstreamPort);
          return http.request({ ...options, agent: false }, callback);
        } };
        if (name === "fs") return { readFileSync(filename: string) {
          if (filename === "/home/bux/.hivra/api-token") return "a".repeat(64);
          throw Object.assign(new Error("fixture missing"), { code: "ENOENT" });
        } };
        if (name === "child_process") return { spawn() { throw new Error("No child processes"); }, execFile() { throw new Error("No child processes"); } };
        if (name === "./guarded-files.cjs") return { createGuardedFiles: () => ({}) };
        if (name === "./agent-zero-editor.cjs") return { SOURCES: {}, rewriteNativeEditorAsset: (_path: string, body: Buffer) => body };
        if (["path", "net", "crypto", "./llm-application.js"].includes(name)) return realRequire(name);
        throw new Error(`Unexpected dependency ${name}`);
      },
      process: { env: { HIVRA_CHAT_PORT: "0", HIVRA_AGENT_KIND: "linux-desktop", HIVRA_REMOTE_DESKTOP_BROKER_PORT: String(upstreamPort) }, once() {}, exit() {} },
      __dirname: path.dirname(serverPath), Buffer, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
      console: { log() {}, error() {} },
    }, { filename: serverPath, timeout: 2000 });
    if (!gateway!.listening) await once(gateway!, "listening");
    const gatewayPort = (gateway!.address() as net.AddressInfo).port;
    const fetcher = async (url: string, options: RequestInit = {}): Promise<Response> => {
      expect(new URL(url).origin).toBe(origin);
      return new Promise((resolve, reject) => {
        const req = http.request({ hostname: "127.0.0.1", port: gatewayPort, path: new URL(url).pathname,
          method: options.method ?? "GET", headers: { host: hostname }, signal: options.signal ?? undefined, agent: false }, res => {
          const chunks: Buffer[] = [];
          res.on("error", reject); res.on("data", chunk => chunks.push(chunk));
          res.on("end", () => {
            const headers = new Headers();
            for (let index = 0; index < res.rawHeaders.length; index += 2) headers.append(res.rawHeaders[index], res.rawHeaders[index + 1]);
            resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers }));
          });
        });
        req.on("error", reject); req.setTimeout(2000, () => req.destroy(new Error("fixture timeout"))); req.end();
      });
    };
    expect(await (await fetcher(origin + "/healthz")).text()).toBe("ok");
    expect((await fetcher(origin + "/")).status).toBe(404);
    const handoff = await fetcher(origin + "/desktop/handoff");
    expect(handoff.status).toBe(200);
    expect(handoff.headers.get("content-security-policy")).toBe(
      `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; frame-ancestors ${controlOrigin}`);
    expect(await verifyProviderDesktopPublicRuntime({ access: { mode: "cloudflare-named", hostname,
      tunnelId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, controlOrigin }, fetcher)).toBe(true);
    expect(forbidden).not.toHaveBeenCalled();
  } finally {
    broker.close(); for (const socket of peers) socket.destroy();
    await Promise.all([gateway, upstream].filter((server): server is http.Server => Boolean(server))
      .map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }
}, 15000);
