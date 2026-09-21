import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import {
  HETZNER_BOOTSTRAP_SIDECAR_SERVER_CODE,
  SIDECAR_SERVER_CODE,
  WEBUI_HANDOFF_APPENDAGE,
} from "@/lib/services/sidecar-script";

const INSTANCE = "00000000-0000-4000-8000-000000001036";
const NAME = `agent-${INSTANCE}-gateway`;
const CID = "a".repeat(64);
const IMAGE = `sha256:${"b".repeat(64)}`;
const API_KEY = "test-only-key-never-log";
const RESTART = "/api/gateway/restart";
const STATUS = "/api/actions/gateway-restart/status?lines=180";
const BEARER = { authorization: `Bearer ${API_KEY}` };
const BEFORE = "2026-08-27T08:00:00.000000000Z";
const AFTER = "2026-08-27T09:00:00.000000000Z";

class Request extends EventEmitter {
  constructor(
    readonly method: string,
    readonly url: string,
    readonly headers: Record<string, string>,
  ) { super(); }
}

class Response extends EventEmitter {
  statusCode = 0;
  headers: Record<string, unknown> = {};
  headersSent = false;
  body = "";
  writeHead(statusCode: number, headers: Record<string, unknown>) {
    this.statusCode = statusCode;
    this.headers = headers;
    this.headersSent = true;
  }
  end(chunk?: string | Buffer) {
    this.body += chunk?.toString() || "";
    this.emit("finish");
  }
  json() { return JSON.parse(this.body); }
}

type Handler = (req: Request, res: Response) => Promise<void>;
type Child = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: jest.Mock };
type Container = {
  id: string; name: string; image: string; project: string; service: string;
  running: boolean; startedAt: string; ip: string;
};

const healthy = () => ({
  status: "ok", gateway_state: "running",
  readiness: { status: "ok", checks: { gateway: { status: "ok" } } },
});

function harness(options: {
  docker?: (args: string[], child: Child) => boolean;
  inspect?: (value: Container, count: number) => unknown;
  health?: () => { status?: number; body?: unknown; raw?: string; hang?: boolean };
  upstream?: string;
  bootstrap?: boolean;
} = {}) {
  let restarted = false;
  let inspectCount = 0;
  const children: Child[] = [];
  const requests: (EventEmitter & { destroy: jest.Mock })[] = [];
  const exec = jest.fn();
  const spawn = jest.fn((_command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), kill: jest.fn(),
    });
    children.push(child);
    Promise.resolve().then(() => {
      if (options.docker?.(args, child)) return;
      if (args[2] === "inspect") {
        inspectCount += 1;
        const value: Container = {
          id: CID, name: `/${NAME}`, image: IMAGE, project: INSTANCE, service: "gateway",
          running: true, startedAt: restarted ? AFTER : BEFORE, ip: "172.18.0.3",
        };
        child.stdout.emit("data", Buffer.from(JSON.stringify(options.inspect?.(value, inspectCount) ?? value)));
      } else if (args[2] === "restart") {
        restarted = true;
        child.stdout.emit("data", Buffer.from(CID));
      } else {
        throw new Error(`Unexpected Docker subcommand ${args[2]}`);
      }
      child.emit("close", 0);
    });
    return child;
  });
  const request = jest.fn((_target: unknown, callback: (res: EventEmitter & { statusCode: number }) => void) => {
    const req = Object.assign(new EventEmitter(), {
      destroy: jest.fn(),
      end: () => {
        Promise.resolve().then(() => {
          const result = options.health?.() ?? { body: healthy() };
          if (result.hang) return;
          const response = Object.assign(new EventEmitter(), { statusCode: result.status ?? 200 });
          callback(response);
          response.emit("data", Buffer.from(result.raw ?? JSON.stringify(result.body ?? healthy())));
          response.emit("end");
        });
      },
    });
    requests.push(req);
    return req;
  });
  const fetch = jest.fn(() => { throw new Error("Must not proxy this action to the native dashboard"); });
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const server = new EventEmitter() as EventEmitter & { listen: jest.Mock };
  server.listen = jest.fn();
  const context = vm.createContext({
    require: (name: string) => {
      if (name === "http") return { createServer: (next: Handler) => { server.on("request", next); return server; }, request };
      if (name === "https") return { request };
      if (name === "child_process") return { exec, spawn };
      if (name === "fs") return fs;
      if (name === "path") return path;
      if (name === "crypto") return crypto;
      if (name === "url") return { URL };
      throw new Error(`Unexpected module ${name}`);
    },
    process: {
      env: {
        INSTANCE_ID: INSTANCE, API_SERVER_KEY: API_KEY, DASHBOARD_BASIC_AUTH_USERNAME: "hermes",
        DASHBOARD_UPSTREAM_URL: options.upstream ?? `http://agent-${INSTANCE}-official-dashboard:9119`,
      },
      hrtime: { bigint: () => BigInt(Date.now()) * 1000000n },
    },
    Buffer, URL, Date, setTimeout, clearTimeout, setImmediate, fetch, console: logger,
    AbortController, AbortSignal,
  });
  vm.runInContext(options.bootstrap ? HETZNER_BOOTSTRAP_SIDECAR_SERVER_CODE : SIDECAR_SERVER_CODE + WEBUI_HANDOFF_APPENDAGE, context);
  const call = async (url = RESTART, method = "POST", headers: Record<string, string> = BEARER, body = "") => {
    const req = new Request(method, url, headers);
    const res = new Response();
    // The appendage wraps the actual listener just as in deployed sidecars.
    const listener = server.listeners("request")[0] as Handler;
    const done = listener(req, res);
    if (body) req.emit("data", Buffer.from(body));
    req.emit("end");
    await done;
    return res;
  };
  return {
    call, spawn, exec, request, fetch, logger, children, requests, context,
    issueCookie: (webui = false) => {
      const id = vm.runInContext(webui ? "createWebuiSession().sessionId" : "createDashboardSession().sessionId", context);
      return { cookie: `${webui ? "hermes_webui_session" : "hermes_dashboard_session"}=${id}` };
    },
    async status() { const result = call(STATUS, "GET"); await jest.advanceTimersByTimeAsync(0); return result; },
  };
}

describe("managed native gateway Restart bridge", () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date("2026-08-27T09:00:00Z")); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it.each([RESTART, STATUS])("requires authentication before inspecting or forwarding %s", async (url) => {
    const h = harness();
    const response = await h.call(url, url === RESTART ? "POST" : "GET", {});
    expect(response.statusCode).toBe(401);
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
  });

  it.each(["bearer", "session-header", "query-token", "hmac", "dashboard-cookie", "webui-cookie"])("preserves %s authentication", async (mode) => {
    const h = harness();
    let headers: Record<string, string> = BEARER;
    let url = RESTART;
    if (mode === "session-header") headers = { "x-hermes-session-token": API_KEY };
    if (mode === "query-token") { headers = {}; url += `?token=${API_KEY}`; }
    if (mode === "hmac") {
      const timestamp = String(Date.now());
      headers = { "x-hermes-timestamp": timestamp, "x-hermes-signature": crypto.createHmac("sha256", API_KEY).update(timestamp).digest("hex") };
    }
    if (mode.endsWith("-cookie")) headers = h.issueCookie(mode === "webui-cookie");
    expect((await h.call(url, "POST", headers)).statusCode).toBe(202);
    await jest.advanceTimersByTimeAsync(0);
    expect((await h.status()).json()).toMatchObject({ running: false, exit_code: 0 });
  });

  it("denies cross-site cookie mutations without weakening token clients", async () => {
    const h = harness();
    const response = await h.call(RESTART, "POST", {
      ...h.issueCookie(), origin: "https://attacker.invalid", host: "agent.example", "sec-fetch-site": "cross-site",
    });
    expect(response.statusCode).toBe(403);
    expect(h.spawn).not.toHaveBeenCalled();
    expect((await h.call(RESTART, "POST", {
      ...h.issueCookie(), origin: "https://agent.example", host: "agent.example", "sec-fetch-site": "same-origin",
    })).statusCode).toBe(202);
    await jest.advanceTimersByTimeAsync(0);
    expect((await h.status()).json().exit_code).toBe(0);
  });

  it("accepts the action, restarts only the pinned own CID, then reports authenticated readiness", async () => {
    const h = harness();
    const accepted = await h.call(`${RESTART}?profile=default`);
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({ accepted: true, name: "gateway-restart", pid: null });
    expect(accepted.json()).not.toHaveProperty("exit_code");
    await jest.advanceTimersByTimeAsync(0);
    expect((await h.status()).json()).toMatchObject({ name: "gateway-restart", running: false, exit_code: 0, pid: null });
    expect(h.spawn.mock.calls.filter(([, args]) => args[2] === "restart")).toEqual([
      ["/usr/bin/docker", ["--host", "unix:///var/run/docker.sock", "restart", "--time", "20", CID], {
        shell: false, stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" },
      }],
    ]);
    for (const [, args] of h.spawn.mock.calls) if (args[2] === "inspect") {
      expect(args.at(-1)).toBe(NAME);
      expect(args.join(" ")).not.toMatch(/\.Env|\.Cmd|\.Mounts/);
    }
    expect(h.request).toHaveBeenCalledWith({
      hostname: "172.18.0.3", port: 8642, path: "/health/detailed", method: "GET",
      headers: { Authorization: `Bearer ${API_KEY}`, Accept: "application/json" },
    }, expect.any(Function));
    expect(h.exec).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it.each([`${RESTART}/`, "/api/gateway/%72estart", "/api/%67ateway/restart"])("does not let native redirect/decoding bypass the bridge: %s", async (url) => {
    const h = harness();
    expect((await h.call(url)).statusCode).toBe(202);
    await jest.advanceTimersByTimeAsync(0);
    expect((await h.status()).json().exit_code).toBe(0);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("recovers an existing stopped own container without creating or replacing it", async () => {
    const h = harness({ inspect: (container, count) => count === 1
      ? { ...container, running: false, ip: "" }
      : container });
    expect((await h.call()).statusCode).toBe(202);
    await jest.advanceTimersByTimeAsync(0);
    expect((await h.status()).json()).toMatchObject({ running: false, exit_code: 0 });
    expect(h.spawn.mock.calls.filter(([, args]) => args[2] === "restart")).toHaveLength(1);
    expect(h.spawn.mock.calls.every(([, args]) => ["inspect", "restart"].includes(args[2]))).toBe(true);
    expect(h.request.mock.calls[0][0]).toMatchObject({ hostname: "172.18.0.3", path: "/health/detailed" });
  });

  it("still requires a valid network address after a stopped container starts", async () => {
    const h = harness({ inspect: (container, count) => ({ ...container, running: count !== 1, ip: "" }) });
    await h.call();
    await jest.advanceTimersByTimeAsync(0);
    expect((await h.status()).json()).toMatchObject({ running: false, exit_code: 1 });
    expect(h.request).not.toHaveBeenCalled();
  });

  it("does not create or fall back when the exact container does not exist", async () => {
    const h = harness({ docker: (_args, child) => { child.emit("close", 1); return true; } });
    await h.call();
    await jest.advanceTimersByTimeAsync(0);
    expect((await h.status()).json()).toMatchObject({ running: false, exit_code: 1 });
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.spawn.mock.calls[0][1][2]).toBe("inspect");
    expect(h.exec).not.toHaveBeenCalled();
  });

  it.each([
    ["?profile=work", 409], ["?profile=../work", 400], ["?profile=%2F", 400],
    ["?profile=default&profile=work", 400],
  ])("rejects unsupported/ambiguous profile %s before any action", async (query, status) => {
    const h = harness();
    expect((await h.call(RESTART + query)).statusCode).toBe(status);
    expect((await h.call("/api/actions/gateway-restart/status" + query, "GET")).statusCode).toBe(status);
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it.each(["GET", "DELETE", "PUT"])("rejects unsupported restart method %s", async (method) => {
    const h = harness();
    expect((await h.call(RESTART, method)).statusCode).toBe(405);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("rejects command overrides and unqualified topology without a legacy fallback", async () => {
    const h = harness();
    expect((await h.call(RESTART, "POST", BEARER, '{"container":"other","command":"restart"}')).statusCode).toBe(400);
    expect(h.spawn).not.toHaveBeenCalled();
    const legacy = harness({ upstream: "http://agent-other-web:9119" });
    expect((await legacy.call()).statusCode).toBe(409);
    expect(legacy.spawn).not.toHaveBeenCalled();
    expect(legacy.fetch).not.toHaveBeenCalled();
  });

  it.each(["project", "service", "name", "id", "image", "ip"])("fails closed on mismatched container %s", async (field) => {
    const h = harness({ inspect: (container) => ({ ...container, [field]: "other" }) });
    await h.call();
    await jest.advanceTimersByTimeAsync(0);
    expect((await h.status()).json()).toMatchObject({ running: false, exit_code: 1 });
    expect(h.spawn.mock.calls.filter(([, args]) => args[2] === "restart")).toHaveLength(0);
  });

  it("coalesces clicks while starting and never reports zero before readiness", async () => {
    let ready = false;
    const h = harness({ health: () => ({ body: ready ? healthy() : { status: "ok", gateway_state: "starting" } }) });
    await h.call();
    expect((await h.call()).json().already_running).toBe(true);
    const pendingStatus = h.call(STATUS, "GET");
    await jest.advanceTimersByTimeAsync(10000);
    expect((await pendingStatus).json()).toMatchObject({ running: true, exit_code: null });
    ready = true;
    await jest.advanceTimersByTimeAsync(2000);
    expect((await h.status()).json()).toMatchObject({ running: false, exit_code: 0 });
    expect(h.spawn.mock.calls.filter(([, args]) => args[2] === "restart")).toHaveLength(1);
  });

  it("fails readiness within the absolute deadline when StartedAt never changes", async () => {
    const h = harness({ inspect: (container) => ({ ...container, startedAt: BEFORE }) });
    await h.call();
    await jest.advanceTimersByTimeAsync(180000);
    expect((await h.status()).json()).toMatchObject({ running: false, exit_code: 1 });
    expect(h.request).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(["id", "image", "startedAt", "ip"])("does not accept readiness if %s changes during its final identity check", async (field) => {
    const h = harness({ inspect: (container, count) => count === 3 ? ({ ...container, [field]: {
      id: "c".repeat(64), image: `sha256:${"d".repeat(64)}`, startedAt: "2026-08-27T09:00:05Z", ip: "172.18.0.4",
    }[field] }) : container });
    await h.call();
    await jest.advanceTimersByTimeAsync(0);
    expect((await h.status()).json()).toMatchObject({ running: false, exit_code: 1 });
  });

  it("bounds a hung Docker mutation, stops only its CLI, and refuses uncertain retries", async () => {
    const h = harness({ docker: (args) => args[2] === "restart" });
    await h.call();
    await jest.advanceTimersByTimeAsync(30000);
    const result = (await h.status()).json();
    expect(result).toMatchObject({ running: false, exit_code: 1 });
    expect(result.lines.join(" ")).toContain("gateway_docker_timeout");
    expect(h.children[1].kill).toHaveBeenCalledWith("SIGKILL");
    expect(h.children[0].kill).not.toHaveBeenCalled();
    expect((await h.call()).statusCode).toBe(409);
    expect(h.spawn.mock.calls.filter(([, args]) => args[2] === "restart")).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("bounds a hung preflight without ever starting a restart", async () => {
    const h = harness({ docker: () => true });
    await h.call();
    await jest.advanceTimersByTimeAsync(5000);
    expect((await h.status()).json()).toMatchObject({ running: false, exit_code: 1 });
    expect(h.children[0].kill).toHaveBeenCalledWith("SIGKILL");
    expect(h.spawn.mock.calls.filter(([, args]) => args[2] === "restart")).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("bounds Docker output and does not include it in the failure receipt", async () => {
    const h = harness({ docker: (args, child) => {
      if (args[2] !== "restart") return false;
      child.stderr.emit("data", Buffer.from(API_KEY.repeat(4000)));
      return true;
    } });
    await h.call();
    await jest.advanceTimersByTimeAsync(0);
    const response = await h.status();
    expect(response.json().exit_code).toBe(1);
    expect(response.body).toContain("gateway_docker_output_limit");
    expect(response.body).not.toContain(API_KEY);
    expect(h.children[1].kill).toHaveBeenCalledWith("SIGKILL");
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([401, 403])("reports authenticated-health rejection %i as failure", async (status) => {
    const h = harness({ health: () => ({ status }) });
    await h.call();
    await jest.advanceTimersByTimeAsync(0);
    expect((await h.status()).json()).toMatchObject({ running: false, exit_code: 1 });
  });

  it("bounds unresponsive health requests and the overall readiness wait", async () => {
    const h = harness({ health: () => ({ hang: true }) });
    await h.call();
    await jest.advanceTimersByTimeAsync(180000);
    expect((await h.status()).json()).toMatchObject({ running: false, exit_code: 1 });
    expect(h.requests.length).toBeGreaterThan(0);
    expect(h.requests.every((request) => request.destroy.mock.calls.length === 1)).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([
    { status: "ok", gateway_state: "running" },
    { ...healthy(), readiness: { status: "degraded", checks: { gateway: { status: "ok" } } } },
    { ...healthy(), gateway_state: "draining" },
    { ...healthy(), readiness: { status: "ok", checks: {} } },
  ])("does not equate HTTP200 with full readiness: %j", async (body) => {
    const h = harness({ health: () => ({ body }) });
    await h.call();
    await jest.advanceTimersByTimeAsync(180000);
    expect((await h.status()).json()).toMatchObject({ running: false, exit_code: 1 });
    expect(jest.getTimerCount()).toBe(0);
  });

  it("destroys oversized health responses and never calls them ready", async () => {
    const h = harness({ health: () => ({ raw: "x".repeat(32769) }) });
    await h.call();
    await jest.advanceTimersByTimeAsync(180000);
    expect((await h.status()).json().exit_code).toBe(1);
    expect(h.requests.every((request) => request.destroy.mock.calls.length === 1)).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("reports bounded Docker errors without echoing stderr or credentials", async () => {
    const h = harness({ docker: (args, child) => {
      if (args[2] !== "restart") return false;
      child.stderr.emit("data", Buffer.from(`denied secret=${API_KEY}`));
      child.emit("close", 17);
      return true;
    } });
    await h.call();
    await jest.advanceTimersByTimeAsync(0);
    const response = await h.status();
    expect(response.json().exit_code).toBe(1);
    expect(response.body).toContain("gateway_docker_exit_17");
    expect(response.body + JSON.stringify(h.logger.error.mock.calls)).not.toContain(API_KEY);
  });

  it("rejects a missing action result instead of returning a false successful native status", async () => {
    const h = harness();
    expect((await h.call(STATUS, "GET")).statusCode).toBe(404);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("keeps unrelated native actions on the existing proxy and strips the bridge from legacy bootstrap", async () => {
    const h = harness();
    // Isolate the untouched proxy seam; only the new endpoint should intercept.
    const proxy = jest.fn((_req, res: Response) => res.end("native action"));
    Object.assign(h.context, { testProxy: proxy });
    vm.runInContext("handleGatedDashboardRequest = testProxy", h.context);
    expect((await h.call("/api/actions/hermes-update/status", "GET")).body).toBe("native action");
    expect(proxy).toHaveBeenCalledTimes(1);
    const legacy = harness({ bootstrap: true });
    expect(vm.runInContext("typeof handleManagedGatewayAction", legacy.context)).toBe("undefined");
  });
});
