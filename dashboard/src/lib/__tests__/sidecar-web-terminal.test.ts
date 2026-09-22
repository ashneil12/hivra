import crypto from "node:crypto";
import { spawn as spawnProcess, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import vm from "node:vm";

import {
  DESKTOP_TERMINAL_PROCESS_CODE, DESKTOP_TERMINAL_PTY_HELPER_CODE,
  HETZNER_BOOTSTRAP_SIDECAR_SERVER_CODE, SIDECAR_SERVER_CODE, WEBUI_HANDOFF_APPENDAGE,
} from "@/lib/services/sidecar-script";

const INSTANCE = "00000000-0000-4000-8000-000000001004";
const CID = "a".repeat(64);
const NAME = `agent-${INSTANCE}-official-dashboard`;
const KEY = "desktop-terminal-test-key-not-a-real-secret";
const ROUTE = "/api/desktop-terminal";
const AUTH = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };

class Request extends EventEmitter {
  aborted = false;
  constructor(readonly method: string, readonly url: string, readonly headers: Record<string, string>) { super(); }
}

class Response extends EventEmitter {
  statusCode = 0;
  headers: Record<string, unknown> = {};
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  body = "";
  writeHead(status: number, headers: Record<string, unknown>) {
    this.statusCode = status; this.headers = headers; this.headersSent = true;
  }
  end(chunk?: string | Buffer) {
    this.body += chunk?.toString() || "";
    this.writableEnded = true;
    this.emit("finish");
  }
  json() { return JSON.parse(this.body); }
}

type Child = EventEmitter & {
  stdout: EventEmitter; stderr: EventEmitter;
  stdin: EventEmitter & { write: jest.Mock; end: jest.Mock; writableLength: number };
  kill: jest.Mock;
};
type SpawnOptions = { env: Record<string, string>; shell?: boolean; stdio?: unknown };
type TerminalIdentity = { sessionKey: string; sessionToken: string };

class Socket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  writes: Buffer[] = [];
  write(value: string | Buffer) { this.writes.push(Buffer.from(value)); return true; }
  end() { this.emit("end"); }
  destroy() { this.destroyed = true; this.emit("close"); }
  setNoDelay() {}
  setTimeout() {}
  events() {
    return this.writes.filter((buffer) => buffer[0] === 0x81).map((buffer) => {
      const size = buffer[1] & 0x7f;
      return JSON.parse(buffer.subarray(size < 126 ? 2 : size === 126 ? 4 : 10).toString());
    });
  }
}

function clientFrame(value: unknown) {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
  header[0] = 0x81;
  if (payload.length < 126) header[1] = 0x80 | payload.length;
  else { header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
  const mask = Buffer.from([5, 8, 13, 21]);
  return Buffer.concat([header, mask, Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]))]);
}

async function flushAsync() { for (let count = 0; count < 20; count++) await Promise.resolve(); }

function harness(options: {
  inspect?: (value: Record<string, unknown>) => Record<string, unknown>;
  preflight?: Record<string, unknown>;
  upstream?: string;
  ready?: boolean;
  dockerHang?: boolean;
  cleanupFail?: boolean;
  bootstrap?: boolean;
} = {}) {
  const helpers: Child[] = [];
  const dockerChildren: Child[] = [];
  const controls: unknown[] = [];
  const spawn = jest.fn((command: string, args: string[], settings: SpawnOptions) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(),
      stdin: Object.assign(new EventEmitter(), {
        writableLength: 0,
        write: jest.fn((value: string) => { controls.push(JSON.parse(value)); return true; }),
        end: jest.fn(),
      }),
      kill: jest.fn(() => { child.emit("close", null); return true; }),
    });
    if (command === "/usr/bin/docker") {
      dockerChildren.push(child);
      Promise.resolve().then(() => {
        if (options.dockerHang) return;
        if (args[2] === "inspect") {
          const value = {
            id: CID, name: `/${NAME}`, project: INSTANCE, service: "official-dashboard",
            running: true, user: "1024:1024", image: `sha256:${"b".repeat(64)}`,
          };
          child.stdout.emit("data", Buffer.from(JSON.stringify(options.inspect?.(value) ?? value)));
        } else if (args.includes("--preflight")) {
          child.stdout.emit("data", Buffer.from(JSON.stringify(options.preflight ?? { uid: 1024, cwd: "/home/hermes", shell: "/bin/bash", pidfd: true })));
        } else if (args.includes("--cleanup")) {
          child.stdout.emit("data", Buffer.from(JSON.stringify({ clean: !options.cleanupFail })));
          child.emit("close", options.cleanupFail ? 1 : 0);
          return;
        } else {
          throw new Error(`Unexpected Docker invocation: ${args[2]}`);
        }
        child.emit("close", 0);
      });
    } else {
      helpers.push(child);
      Promise.resolve().then(() => {
        if (options.ready === false) return;
        const argv = JSON.parse(settings.env.HERMES_TERMINAL_ARGV || "[]") as string[];
        const marker = argv.find((value) => value.startsWith("HIVRA_DESKTOP_TERMINAL_ID="))?.split("=")[1];
        child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "ready", marker, pid: 201 })}\n`));
        child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "output", data: Buffer.from("prompt$ ").toString("base64") })}\n`));
      });
    }
    return child;
  });
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const server = Object.assign(new EventEmitter(), { listen: jest.fn() });
  const network = jest.fn(() => { throw new Error("Desktop terminal must not proxy native chat/TUI"); });
  const context = vm.createContext({
    require: (name: string) => {
      if (name === "http") return { createServer: (handler: unknown) => { server.on("request", handler as () => void); return server; }, request: network, STATUS_CODES: { 401: "Unauthorized", 404: "Not Found", 429: "Too Many Requests" } };
      if (name === "https") return { request: network };
      if (name === "child_process") return { spawn, exec: network };
      if (name === "fs") return fs;
      if (name === "path") return path;
      if (name === "crypto") return crypto;
      if (name === "url") return { URL };
      if (name === "string_decoder") return { StringDecoder };
      throw new Error(`Unexpected module ${name}`);
    },
    process: {
      env: { INSTANCE_ID: INSTANCE, API_SERVER_KEY: KEY,
        DASHBOARD_UPSTREAM_URL: options.upstream ?? `http://${NAME}:9119`,
        // These legacy overrides must not elevate or retarget the new surface.
        TERMINAL_EXEC_USER: "root", TERMINAL_SHELL_CWD: "/root", DOCKER_HOST: "tcp://other-tenant:2375" },
      hrtime: { bigint: () => BigInt(Date.now()) * 1000000n },
    },
    Buffer, URL, Date, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
    AbortController, AbortSignal, fetch: network, console: logger,
  });
  vm.runInContext(options.bootstrap ? HETZNER_BOOTSTRAP_SIDECAR_SERVER_CODE : SIDECAR_SERVER_CODE + WEBUI_HANDOFF_APPENDAGE, context);
  const begin = (body: unknown, headers: Record<string, string> = AUTH, url = ROUTE, method = "POST", streaming = false) => {
    const req = new Request(method, url, headers);
    const res = new Response();
    const completed = new Promise<Response>((resolve) => res.once("finish", () => resolve(res)));
    (server.listeners("request")[0] as (request: Request, response: Response) => void)(req, res);
    if (!streaming) {
      if (method !== "GET") req.emit("data", Buffer.from(typeof body === "string" ? body : JSON.stringify(body)));
      req.emit("end");
    }
    return { req, res, completed };
  };
  const call = (body: unknown, headers?: Record<string, string>, url?: string, method?: string) => begin(body, headers, url, method).completed;
  const cookie = (webui = false) => ({
    "content-type": "application/json", origin: "https://agent.example", host: "agent.example", "sec-fetch-site": "same-origin",
    cookie: `${webui ? "hermes_webui_session" : "hermes_dashboard_session"}=${vm.runInContext(webui ? "createWebuiSession().sessionId" : "createDashboardSession().sessionId", context)}`,
  });
  const connect = (webSocketPath: string) => {
    const socket = new Socket();
    const requestUrl = new URL(webSocketPath, "https://agent.example");
    requestUrl.pathname = requestUrl.pathname.replace(/^\/_sidecar/, "");
    server.emit("upgrade", new Request("GET", requestUrl.pathname + requestUrl.search, {
      upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": Buffer.from("native-test-sock").toString("base64"),
    }), socket, Buffer.alloc(0));
    return socket;
  };
  return { begin, call, connect, context, spawn, helpers, dockerChildren, controls, logger, network, cookie,
    lease: (identity: TerminalIdentity) => vm.runInContext("desktopTerminalLeases.get(" + JSON.stringify(identity.sessionKey) + ")", context),
    leaseCount: () => vm.runInContext("desktopTerminalLeases.size", context),
    session: (identity: TerminalIdentity) => vm.runInContext(`terminalSessions.get(${JSON.stringify(identity.sessionKey)})`, context),
    start: () => call({ action: "start", cols: 80, rows: 24, profile: "default" }),
  };
}

describe("native Desktop terminal sidecar boundary", () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date("2026-08-27T15:00:00Z")); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it("starts a dedicated native shell with a scoped socket capability", async () => {
    const h = harness();
    const response = await h.start();
    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result).toMatchObject({ ok: true, cwd: "/home/hermes", shell: "bash", pid: 201 });
    expect(result.sessionKey).toMatch(new RegExp(`^term:desktop:${INSTANCE}:`));
    expect(result.sessionToken).toMatch(/^[a-f0-9-]{36}$/);
    const url = new URL(result.webSocketPath, "https://agent.example");
    expect(url.pathname).toBe("/_sidecar/api/terminal/ws");
    const [payload, signature] = url.searchParams.get("token")!.split(".");
    expect(signature).toBe(crypto.createHmac("sha256", KEY).update(payload).digest("hex"));
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toMatchObject({
      type: "terminal-ws", exp: Date.now() + 90_000, sessionKey: result.sessionKey, sessionToken: result.sessionToken,
    });
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(h.network).not.toHaveBeenCalled();
    const helper = h.spawn.mock.calls.find(([command]) => command !== "/usr/bin/docker")!;
    const argv = JSON.parse(helper[2].env.HERMES_TERMINAL_ARGV);
    expect(argv.slice(0, 3)).toEqual(["/usr/bin/docker", "--host", "unix:///var/run/docker.sock"]);
    expect(argv).toContain(CID);
    expect(argv).not.toContain("--user");
    expect(JSON.stringify(helper[2].env)).not.toContain(KEY);
  });

  it.each<Record<string, string>>([{}, { authorization: "Bearer wrong" }, { "x-hermes-session-token": "wrong" }])("rejects unauthenticated requests before Docker", async (headers) => {
    const h = harness();
    expect((await h.call({ action: "start" }, headers)).statusCode).toBe(401);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it.each([false, true])("accepts an existing same-origin authenticated cookie (webui=%s)", async (webui) => {
    const h = harness();
    expect((await h.call({ action: "start" }, h.cookie(webui))).statusCode).toBe(200);
  });

  it.each([undefined, "null", "https://sibling.example", "http://agent.example"])('rejects cookie mutation with Origin "%s"', async (origin) => {
    const h = harness();
    const headers: Record<string, string> = h.cookie();
    if (origin === undefined) delete headers.origin; else headers.origin = origin;
    expect((await h.call({ action: "start" }, headers)).statusCode).toBe(403);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it.each(["target", "container", "user", "url", "mode", "sessionKey", "sessionToken", "command"])('rejects browser-selected "%s" on start', async (field) => {
    const h = harness();
    expect((await h.call({ action: "start", [field]: "untrusted" })).statusCode).toBe(400);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it.each([{ profile: "other" }, { cols: 0 }, { cols: 501 }, { rows: 1 }, { rows: 201 }, { rows: 3.5 }, { cwd: "relative" }, { cwd: "/tmp/\ninvalid" }])("rejects unsupported profile or malformed startup options %j", async (value) => {
    const h = harness();
    expect((await h.call({ action: "start", ...value })).statusCode).toBeGreaterThanOrEqual(400);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it.each([{ project: "another-instance" }, { service: "gateway" }, { name: "/other" }, { id: "not-a-cid" }, { running: false }, { user: "0:0" }, { user: "root" }, { user: "" }])("fails closed on container identity %j", async (value) => {
    const h = harness({ inspect: (record) => ({ ...record, ...value }) });
    expect((await h.start()).statusCode).toBe(409);
    expect(h.helpers).toHaveLength(0);
  });

  it("keeps simultaneous native tabs and the legacy platform shell independent", async () => {
    const h = harness();
    const first = (await h.start()).json();
    const second = (await h.start()).json();
    expect(first.sessionKey).not.toBe(second.sessionKey);
    expect(first.sessionToken).not.toBe(second.sessionToken);
    expect((await h.call({ action: "stop", sessionKey: first.sessionKey, sessionToken: second.sessionToken })).statusCode).toBe(404);
    expect(h.session(first)).toBeDefined();
    expect(h.session(second)).toBeDefined();
    vm.runInContext(`terminalSessions.set('term:sidecar:${INSTANCE}:shell', {sessionToken:${JSON.stringify(first.sessionToken)},kind:'legacy'})`, h.context);
    expect((await h.call({ action: "stop", sessionKey: `term:sidecar:${INSTANCE}:shell`, sessionToken: first.sessionToken })).statusCode).toBe(404);
    expect((await h.call({ action: "stop", sessionKey: first.sessionKey, sessionToken: first.sessionToken })).statusCode).toBe(200);
    expect(h.session(first)).toBeUndefined();
    expect(h.session(second)).toBeDefined();
  });

  it("keeps the existing generic terminal endpoint HMAC-only", async () => {
    const h = harness();
    expect((await h.call({ action: "start" }, AUTH, "/api/terminal")).statusCode).toBe(401);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("returns an explicit unsupported capability in the stripped Hetzner runtime", async () => {
    const h = harness({ bootstrap: true });
    const result = await h.start();
    expect(result.statusCode).toBe(409);
    expect(result.json().error).toContain("unsupported");
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it.each([[["input"]], [["start"]], [{}], [null], [1]])("rejects non-string actions before dispatch (case %#)", async (action) => {
    const h = harness();
    expect((await h.call({ action })).statusCode).toBe(400);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it.each(["?token=reusable-key", "?profile=other", "?profile=default&profile=default"])("rejects unsupported query %s", async (query) => {
    const h = harness();
    expect((await h.call({ action: "start" }, AUTH, ROUTE + query)).statusCode).toBeGreaterThanOrEqual(400);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it.each([{ uid: 0 }, { uid: 1025 }, { pidfd: false }, { shell: "/bin/sh" }, { cwd: "relative" }])("fails closed on preflight mismatch %j", async (mismatch) => {
    const h = harness({ preflight: { uid: 1024, cwd: "/home/hermes", shell: "/bin/bash", pidfd: true, ...mismatch } });
    expect((await h.start()).statusCode).toBe(409);
    expect(h.helpers).toHaveLength(0);
    expect(h.leaseCount()).toBe(0);
  });

  it("passes a validated cwd as one literal argv item, never shell interpolation", async () => {
    const cwd = "/tmp/owner folder;$(not-executed)";
    const h = harness({ preflight: { uid: 1024, cwd, shell: "/bin/bash", pidfd: true } });
    expect((await h.call({ action: "start", cwd })).statusCode).toBe(200);
    const preflight = h.spawn.mock.calls.find(([, args]) => args.includes("--preflight"))!;
    expect(preflight[1][preflight[1].indexOf("--workdir") + 1]).toBe(cwd);
    const helper = h.spawn.mock.calls.find(([command]) => command !== "/usr/bin/docker")!;
    const argv = JSON.parse(helper[2].env.HERMES_TERMINAL_ARGV) as string[];
    expect(argv[argv.indexOf("--workdir") + 1]).toBe(cwd);
  });

  it("bounds the body before buffering an unauthenticated upload", async () => {
    const h = harness();
    const request = h.begin(null, {}, ROUTE, "POST", true);
    request.req.emit("data", Buffer.alloc(8192));
    request.req.emit("data", Buffer.alloc(8193));
    expect((await request.completed).statusCode).toBe(413);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("bounds an incomplete body deadline without creating a session", async () => {
    const h = harness();
    const request = h.begin(null, AUTH, ROUTE, "POST", true);
    request.req.emit("data", Buffer.from("{"));
    await jest.advanceTimersByTimeAsync(5000);
    expect((await request.completed).statusCode).toBe(408);
    expect(h.leaseCount()).toBe(0);
  });

  it("reserves the concurrent cap before asynchronous target checks", async () => {
    const h = harness();
    const starts = Array.from({ length: 4 }, () => h.start());
    expect((await h.start()).statusCode).toBe(429);
    const identities = await Promise.all(starts.map(async (result) => (await result).json()));
    expect(h.helpers).toHaveLength(4);
    expect((await h.call({ action: "stop", sessionKey: identities[0].sessionKey, sessionToken: identities[0].sessionToken })).statusCode).toBe(200);
    expect((await h.start()).statusCode).toBe(200);
  });

  it("rate-limits rapidly recreated sessions independently of the active cap", async () => {
    const h = harness();
    for (let count = 0; count < 12; count++) {
      const { sessionKey, sessionToken } = (await h.start()).json();
      await h.call({ action: "stop", sessionKey, sessionToken });
    }
    expect((await h.start()).statusCode).toBe(429);
    await jest.advanceTimersByTimeAsync(60_000);
    expect((await h.start()).statusCode).toBe(200);
  });

  it.each(["http-abort", "response-close", "deadline"])("cleans up a lost start without giving the browser session keys (%s)", async (cause) => {
    const h = harness({ ready: false });
    const pending = h.begin({ action: "start" });
    await flushAsync();
    expect(h.helpers).toHaveLength(1);
    if (cause === "http-abort") { pending.req.aborted = true; pending.res.destroyed = true; pending.req.emit("aborted"); }
    if (cause === "response-close") { pending.res.destroyed = true; pending.res.emit("close"); }
    await flushAsync();
    await jest.advanceTimersByTimeAsync(10_001);
    await flushAsync();
    expect(h.leaseCount()).toBe(0);
    const cleanup = h.spawn.mock.calls.filter(([, args]) => args.includes("--cleanup"));
    expect(cleanup).toHaveLength(1);
    expect(cleanup[0][1]).toContain(CID);
    expect(pending.res.body).not.toContain("sessionToken");
    expect(h.controls).toContainEqual({ type: "stop" });
  });

  it("does not spawn a shell after its HTTP start was already abandoned", async () => {
    const h = harness();
    const pending = h.begin({ action: "start" });
    pending.res.destroyed = true;
    pending.res.emit("close");
    await flushAsync();
    expect(h.helpers).toHaveLength(0);
    expect(h.leaseCount()).toBe(0);
  });

  it("expires an unattached shell even when it keeps writing output", async () => {
    const h = harness();
    const identity = (await h.start()).json();
    await jest.advanceTimersByTimeAsync(89_000);
    h.helpers[0].stdout.emit("data", Buffer.from(JSON.stringify({ type: "output", data: Buffer.from("still running").toString("base64") }) + "\n"));
    await jest.advanceTimersByTimeAsync(1001);
    expect(h.session(identity)).toBeUndefined();
    expect(h.leaseCount()).toBe(0);
  });

  it("expires the last disconnected socket independently of output activity", async () => {
    const h = harness();
    const identity = (await h.start()).json();
    const socket = h.connect(identity.webSocketPath);
    expect(socket.writes[0].toString()).toContain("101 Switching Protocols");
    socket.destroy();
    await jest.advanceTimersByTimeAsync(9000);
    h.helpers[0].stdout.emit("data", Buffer.from(JSON.stringify({ type: "output", data: Buffer.from("still running").toString("base64") }) + "\n"));
    await jest.advanceTimersByTimeAsync(1001);
    expect(h.session(identity)).toBeUndefined();
    expect(h.leaseCount()).toBe(0);
  });

  it("holds the session cap and reports unconfirmed cleanup honestly, permitting exact-token retry", async () => {
    const options = { cleanupFail: true };
    const h = harness(options);
    const identity = (await h.start()).json();
    const socket = h.connect(identity.webSocketPath);
    const stop = { action: "stop", sessionKey: identity.sessionKey, sessionToken: identity.sessionToken };
    expect((await h.call(stop)).statusCode).toBe(502);
    expect(h.leaseCount()).toBe(1);
    expect(socket.events().find((event) => event.type === "closed")).toMatchObject({ cleanupConfirmed: false, reason: "error" });
    options.cleanupFail = false;
    expect((await h.call(stop)).statusCode).toBe(200);
    expect(h.leaseCount()).toBe(0);
    expect((await h.call(stop)).statusCode).toBe(200);
  });

  it("preserves final output, exact exit details and verified cleanup on natural exit", async () => {
    const h = harness();
    const identity = (await h.start()).json();
    const socket = h.connect(identity.webSocketPath);
    const encoded = Buffer.from("✓終").toString("base64");
    h.helpers[0].stdout.emit("data", Buffer.from(JSON.stringify({ type: "output", data: encoded }) + "\n" +
      JSON.stringify({ type: "closed", exitCode: 7, signal: null }) + "\n"));
    await flushAsync();
    expect(socket.events()).toContainEqual({ type: "output", data: "✓終" });
    expect(socket.events().find((event) => event.type === "closed")).toMatchObject({ cleanupConfirmed: true, exitCode: 7, signal: null });
    expect(h.leaseCount()).toBe(0);
  });

  it("decodes UTF-8 output split across helper frames without replacement characters", async () => {
    const h = harness();
    const identity = (await h.start()).json();
    const socket = h.connect(identity.webSocketPath);
    const value = Buffer.from("漢字");
    for (const part of [value.subarray(0, 2), value.subarray(2, 4), value.subarray(4)]) {
      h.helpers[0].stdout.emit("data", Buffer.from(JSON.stringify({ type: "output", data: part.toString("base64") }) + "\n"));
    }
    expect(socket.events().filter((event) => event.type === "output").map((event) => event.data).join("")).toBe("prompt$ 漢字");
  });

  it("uses fresh scoped attach tickets without starting another PTY", async () => {
    const h = harness();
    const identity = (await h.start()).json();
    const socket = h.connect(identity.webSocketPath);
    await jest.advanceTimersByTimeAsync(89_000);
    const attached = await h.call({ action: "attach", sessionKey: identity.sessionKey, sessionToken: identity.sessionToken });
    expect(attached.statusCode).toBe(200);
    expect(attached.json().webSocketPath).not.toBe(identity.webSocketPath);
    await jest.advanceTimersByTimeAsync(1001);
    expect(h.connect(identity.webSocketPath).writes[0].toString()).toContain("401");
    expect(h.connect(attached.json().webSocketPath).writes[0].toString()).toContain("101");
    expect(h.helpers).toHaveLength(1);
    expect(socket.destroyed).toBe(false);
  });

  it("rejects tampered socket capabilities without touching any session", async () => {
    const h = harness();
    const identity = (await h.start()).json();
    const ticket = new URL(identity.webSocketPath, "https://agent.example");
    ticket.searchParams.set("token", ticket.searchParams.get("token")!.slice(0, -1) + "z");
    expect(h.connect(ticket.pathname + ticket.search).writes[0].toString()).toContain("403");
    expect(h.leaseCount()).toBe(1);
  });

  it.each([
    { action: "input", data: "🧪".repeat(1025) },
    { action: "resize", cols: 9, rows: 24 },
    { action: "resize", cols: 80, rows: 201 },
    { action: "resize", cols: 80.5, rows: 24 },
    { action: "input", data: "ok", user: "root" },
  ])("enforces native HTTP control limits (case %#)", async (body) => {
    const h = harness();
    const { sessionKey, sessionToken } = (await h.start()).json();
    expect((await h.call({ ...body, sessionKey, sessionToken })).statusCode).toBe(400);
    expect(h.controls).toHaveLength(0);
  });

  it.each([null, [], { type: "input", data: "🧪".repeat(1025) }, { type: "resize", cols: 2, rows: 24 }, { type: "ping", user: "root" }])("does not let WS controls bypass native limits (case %#)", async (body) => {
    const h = harness();
    const identity = (await h.start()).json();
    const socket = h.connect(identity.webSocketPath);
    socket.emit("data", clientFrame(body));
    await flushAsync();
    expect(socket.writes.some((buffer) => buffer[0] === 0x88 && buffer.readUInt16BE(2) === 1008)).toBe(true);
    expect(h.controls).toHaveLength(0);
  });

  it("accepts exact-byte-boundary input and truthful live cwd without inventing a path", async () => {
    const h = harness();
    const { sessionKey, sessionToken } = (await h.start()).json();
    const data = "é".repeat(2048);
    expect((await h.call({ action: "input", sessionKey, sessionToken, data })).statusCode).toBe(200);
    expect(h.controls).toEqual([{ type: "input", data: Buffer.from(data).toString("base64") }]);
    expect((await h.call({ action: "cwd", sessionKey, sessionToken })).json()).toEqual({ ok: true, cwd: null });
  });
});

const PYTHON = process.env.HERMES_RUNTIME_TEST_PYTHON || "/usr/bin/python3";
const PROCESS_MARKER = "c".repeat(32);

function realPty(script: string) {
  const events: Array<Record<string, unknown>> = [];
  const changed = new EventEmitter();
  let lineBuffer = "";
  let output = "";
  let errors = "";
  const child = spawnProcess(PYTHON, ["-I", "-S", "-u", "-c", DESKTOP_TERMINAL_PTY_HELPER_CODE], {
    env: {
      NODE_ENV: "test",
      PATH: "/usr/bin:/bin",
      HERMES_TERMINAL_ARGV: JSON.stringify([PYTHON, "-I", "-S", "-u", "-c", [
        "import os,sys,signal,tty,fcntl,termios,struct,time",
        "signal.alarm(5)", "tty.setraw(0)",
        "os.write(1, b'\\x1eHIVRA_READY:" + PROCESS_MARKER + ":' + str(os.getpid()).encode() + b'\\x1f')",
        script,
      ].join("\n")]),
      HERMES_TERMINAL_MARKER: PROCESS_MARKER,
      HERMES_TERMINAL_COLS: "80", HERMES_TERMINAL_ROWS: "24",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    lineBuffer += chunk.toString();
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      events.push(event);
      if (event.type === "output") output += Buffer.from(event.data, "base64").toString();
    }
    changed.emit("change");
  });
  child.stderr.on("data", (chunk) => { errors += chunk.toString(); });
  const closed = new Promise<void>((resolve) => child.once("close", () => { resolve(); changed.emit("change"); }));
  const wait = async (predicate: () => boolean) => {
    if (predicate()) return;
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        if (!predicate()) return;
        clearTimeout(timer); changed.removeListener("change", done); resolve();
      };
      const timer = setTimeout(() => {
        changed.removeListener("change", done);
        reject(new Error("Native helper observation timed out: " + errors));
      }, 2500);
      changed.on("change", done);
    });
  };
  return {
    child, events, closed, wait, output: () => output,
    write: (messages: unknown[]) => child.stdin.write(messages.map((message) => JSON.stringify(message) + "\n").join("")),
    dispose: async () => {
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await closed;
    },
  };
}

describe("actual native PTY helper subprocess", () => {
  it("signals the owned Docker-client process group when its PTY size changes", async () => {
    const pty = realPty([
      "def resized(signum,frame):",
      " rows,cols,_,_=struct.unpack('HHHH',fcntl.ioctl(0,termios.TIOCGWINSZ,b'\\0'*8))",
      " os.write(1,('WINCH:'+str(rows)+'x'+str(cols)).encode())",
      "signal.signal(signal.SIGWINCH,resized)",
      "os.write(1,b'WATCHING')",
      "while True: time.sleep(0.1)",
    ].join("\n"));
    try {
      await pty.wait(() => pty.output().includes("WATCHING"));
      pty.write([{ type: "resize", cols: 123, rows: 42 }]);
      await pty.wait(() => pty.output().includes("WINCH:42x123"));
    } finally { await pty.dispose(); }
  });

  it("consumes adjacent input, resize and stop controls without buffered-stdin stalls", async () => {
    const pty = realPty([
      "received=b''",
      "while len(received)<2: received+=os.read(0,2-len(received))",
      "rows,cols,_,_=struct.unpack('HHHH',fcntl.ioctl(0,termios.TIOCGWINSZ,b'\\0'*8))",
      "os.write(1,b'RECEIVED:'+received+b':'+str(rows).encode()+b'x'+str(cols).encode())",
      "while True: time.sleep(0.1)",
    ].join("\n"));
    try {
      await pty.wait(() => pty.events.some((event) => event.type === "ready"));
      // One OS write deliberately contains multiple complete JSON lines.
      pty.write([{ type: "resize", cols: 123, rows: 37 }, { type: "input", data: "QQ==" }, { type: "input", data: "Qg==" }]);
      await pty.wait(() => pty.output().includes("RECEIVED:AB:37x123"));
      pty.write([{ type: "resize", cols: 90, rows: 30 }, { type: "stop" }]);
      await pty.wait(() => pty.events.some((event) => event.type === "closed"));
      await pty.closed;
      const pid = pty.events.find((event) => event.type === "ready")!.pid as number;
      expect(() => process.kill(pid, 0)).toThrow();
    } finally { await pty.dispose(); }
  });

  it("drains final PTY bytes before reporting the actual child exit code", async () => {
    const pty = realPty("os.write(1,b'X'*200000+b'FINAL_BYTES'); sys.exit(7)");
    try {
      await pty.wait(() => pty.events.some((event) => event.type === "closed"));
      expect(pty.output()).toBe("X".repeat(200000) + "FINAL_BYTES");
      expect(pty.events.at(-1)).toMatchObject({ type: "closed", exitCode: 7, signal: null });
    } finally { await pty.dispose(); }
  });

  it("terminates its owned local process when the control pipe reaches EOF", async () => {
    const pty = realPty("while True: time.sleep(0.1)");
    try {
      await pty.wait(() => pty.events.some((event) => event.type === "ready"));
      const pid = pty.events.find((event) => event.type === "ready")!.pid as number;
      pty.child.stdin.end();
      await pty.wait(() => pty.events.some((event) => event.type === "closed"));
      await pty.closed;
      expect(() => process.kill(pid, 0)).toThrow();
    } finally { await pty.dispose(); }
  });
});

// Execute the real cleanup program under a small process-table model. This
// exercises pidfd ownership/race/error behavior on macOS too; Linux below also
// qualifies real child/descendant teardown without Docker or privileged users.
const PIDFD_MODEL = String.raw`import builtins,io,json,os,select,signal,sys,time,types
source=os.environ["TEST_NATIVE_CODE"]
mode=os.environ["TEST_MODE"]
marker=os.environ["TEST_MARKER"]
real_sleep=time.sleep
owned=b"HIVRA_DESKTOP_TERMINAL_ID="+marker.encode()+b"\0"
processes={
 "101":{"uid":1024,"env":owned,"alive":True},
 "102":{"uid":1024,"env":owned,"alive":True},
 "103":{"uid":1024,"env":b"HIVRA_DESKTOP_TERMINAL_ID=other\0","alive":True},
 "104":{"uid":2048,"env":owned,"alive":True},
 "999":{"uid":1024,"env":b"","alive":True},
}
handles={}
events=[]
real_exit=sys.exit
os.getuid=lambda: 0 if mode=="root" else 1024
os.geteuid=os.getuid
os.getpid=lambda: 999
os.listdir=lambda path: real_sleep(10) if mode=="stalled-scan" else [name for name,process in processes.items() if process["alive"]]
os.stat=lambda path: types.SimpleNamespace(st_uid=processes[path.split("/")[2]]["uid"])
def opened(pid,flags):
 process=processes[str(pid)]
 fd=len(handles)+100
 handles[fd]=(str(pid),process)
 events.append(["open",pid])
 return fd
os.pidfd_open=opened
os.close=lambda fd: events.append(["close",fd])
select.select=lambda read,write,error,timeout: ([fd for fd in read if not handles[fd][1]["alive"]],[],[])
def read_environment(path,mode):
 pid=path.split("/")[2]
 assert any(name==pid for name,process in handles.values()), "identity must be pinned before reading /proc"
 events.append(["read",int(pid)])
 if os.environ["TEST_MODE"]=="unreadable": raise PermissionError("fixture unreadable")
 return io.BytesIO(processes[pid]["env"])
builtins.open=read_environment
def delivered(fd,signum,*args):
 pid,process=handles[fd]
 if not process["alive"]: raise ProcessLookupError()
 if not signum: return
 if mode=="reuse" and pid=="101" and process is processes["101"]:
  process["alive"]=False
  processes["101"]={"uid":1024,"env":b"HIVRA_DESKTOP_TERMINAL_ID=another-session\0","alive":True}
  raise ProcessLookupError()
 events.append(["signal",int(pid),int(signum)])
 process["alive"]=False
signal.pidfd_send_signal=delivered
def numeric_kill(*args): raise AssertionError("numeric PID kill is forbidden")
os.kill=os.killpg=numeric_kill
time.sleep=lambda seconds: None
clock=[0]
def now():
 clock[0]+=0.1
 return clock[0]
time.monotonic=now
if mode=="no-pidfd": del os.pidfd_open
sys.argv=["native-cleanup","--cleanup",("e"*32 if mode=="wrong-marker" else marker),"1024"]
status=0
try: exec(compile(source,"native-cleanup","exec"),{})
except SystemExit as error: status=error.code
print("TEST_STATE:"+json.dumps({"events":events,"alive":[int(pid) for pid,p in processes.items() if p["alive"]]}))
real_exit(status)
`;

describe("actual native process cleanup program", () => {
  function execute(mode: string) {
    const result = spawnSync(PYTHON, ["-I", "-S", "-c", PIDFD_MODEL], {
      env: { NODE_ENV: "test", PATH: "/usr/bin:/bin", TEST_NATIVE_CODE: DESKTOP_TERMINAL_PROCESS_CODE, TEST_MODE: mode, TEST_MARKER: PROCESS_MARKER },
      encoding: "utf8", timeout: 4500,
    });
    expect(result.stderr).toBe("");
    const lines = result.stdout.trim().split("\n");
    return { status: result.status, result: JSON.parse(lines[0]), state: JSON.parse(lines[1].slice("TEST_STATE:".length)) };
  }

  it("pins identity before reading ownership and signals only this marker's non-root processes", () => {
    const value = execute("normal");
    expect(value.status).toBe(0);
    expect(value.result).toEqual({ clean: true });
    expect(value.state.alive).toEqual([103, 104, 999]);
    expect(value.state.events.filter(([name]: string[]) => name === "signal").map((event: number[]) => event[1])).toEqual([101, 102]);
  });

  it("does not signal a reused numeric PID belonging to a different session", () => {
    const value = execute("reuse");
    expect(value.status).toBe(0);
    expect(value.result).toEqual({ clean: true });
    expect(value.state.alive).toEqual([101, 103, 104, 999]);
    expect(value.state.events.filter(([name]: string[]) => name === "signal").map((event: number[]) => event[1])).toEqual([102]);
  });

  it("does not touch other sessions when an ownership marker has no processes", () => {
    const value = execute("wrong-marker");
    expect(value.status).toBe(0);
    expect(value.state.alive).toEqual([101, 102, 103, 104, 999]);
  });

  it.each(["unreadable", "no-pidfd", "root", "stalled-scan"])("fails closed without numeric-kill fallback (%s)", (mode) => {
    const value = execute(mode);
    expect(value.status).toBe(1);
    expect(value.result).toEqual({ clean: false, error: "native_terminal_process_check_failed" });
    expect(value.state.alive).toEqual([101, 102, 103, 104, 999]);
  });

  const linuxNonRoot = process.platform === "linux" && process.getuid?.() !== 0 ? it : it.skip;
  linuxNonRoot("kills real tagged child and descendant processes while an unrelated process survives", () => {
    const source = `import json,os,signal,subprocess,sys,time
code=os.environ["TEST_NATIVE_CODE"]
marker=os.environ["TEST_MARKER"]
worker="import os,signal,subprocess,sys,time; signal.alarm(6); p=subprocess.Popen([sys.executable,'-I','-S','-c','import time; time.sleep(6)']); print(p.pid,flush=True); time.sleep(6)"
tagged=subprocess.Popen([sys.executable,"-I","-S","-u","-c",worker],env={"PATH":"/usr/bin:/bin","HIVRA_DESKTOP_TERMINAL_ID":marker},stdout=subprocess.PIPE,text=True)
unrelated=subprocess.Popen([sys.executable,"-I","-S","-c","import time;time.sleep(6)"])
try:
 descendant=int(tagged.stdout.readline())
 result=subprocess.run([sys.executable,"-I","-S","-c",code,"--cleanup",marker,str(os.getuid())],capture_output=True,text=True,timeout=4)
 if result.returncode!=0 or json.loads(result.stdout)["clean"] is not True:
  # The probe fails closed on any same-uid process it cannot inspect. Name
  # those processes so a host-environment cause is distinguishable from a
  # probe regression.
  blocked=[]
  for name in os.listdir("/proc"):
   if not name.isdecimal(): continue
   try:
    if os.stat("/proc/"+name).st_uid!=os.getuid(): continue
    open("/proc/"+name+"/environ","rb").close()
   except PermissionError:
    try:
     with open("/proc/"+name+"/status") as f: status=[line.strip() for line in f if line.startswith(("Name:","Uid:","Gid:"))]
    except OSError: status=[]
    blocked.append([name]+status)
   except (FileNotFoundError,ProcessLookupError): pass
  raise AssertionError(result.stdout.strip()+" self_gid="+str(os.getgid())+" uninspectable="+json.dumps(blocked))
 tagged.wait(timeout=1)
 assert unrelated.poll() is None
 try:
  with open("/proc/"+str(descendant)+"/stat") as f: assert f.read().split(") ",1)[1][0]=="Z"
 except FileNotFoundError: pass
 print("REAL_PIDFD_CLEANUP_OK")
finally:
 for process in (tagged,unrelated):
  if process.poll() is None: process.kill()
  process.wait(timeout=1)
`;
    const result = spawnSync(PYTHON, ["-I", "-S", "-c", source], {
      env: { NODE_ENV: "test", PATH: "/usr/bin:/bin", TEST_NATIVE_CODE: DESKTOP_TERMINAL_PROCESS_CODE, TEST_MARKER: PROCESS_MARKER },
      encoding: "utf8", timeout: 8000,
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("REAL_PIDFD_CLEANUP_OK");
  });
});
