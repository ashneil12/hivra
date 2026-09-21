/** @jest-environment node */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const TOKEN = "a".repeat(64);
const sourcePath = path.resolve("provisioner/hivra-chat/server.js");
const installerPath = path.resolve("provisioner/provision-claude-code-box.sh");

describe("Linux Desktop guest profile", () => {
  let root = "";
  let port = 0;
  let child: ChildProcess | undefined;
  const attemptedProcesses: unknown[] = [];

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "hivra-linux-desktop-guest-"));
    fs.mkdirSync(path.join(root, ".hivra"), { mode: 0o700 });
    fs.mkdirSync(path.join(root, "Hivra"), { mode: 0o755 });
    fs.writeFileSync(path.join(root, ".hivra/api-token"), TOKEN, { mode: 0o600 });
    fs.writeFileSync(path.join(root, ".hivra/agent-kind"), "claude\n", { mode: 0o600 });
    const launcher = `
      const http = require("node:http");
      const create = http.createServer;
      http.createServer = (...args) => {
        const server = create(...args);
        server.once("listening", () => process.send({port: server.address().port}));
        return server;
      };
      const processes = require("node:child_process");
      const reject = (...args) => { process.send({attemptedProcess: args.slice(0, 2)}); throw Error("computer profile must not start an agent process"); };
      processes.execFile = reject;
      processes.spawn = reject;
      require(${JSON.stringify(sourcePath)});
    `;
    child = spawn(process.execPath, ["-e", launcher], {
      env: {
        NODE_ENV: "test",
        HOME: root,
        HIVRA_CHAT_PORT: "0",
        HIVRA_AGENT_KIND: "linux-desktop",
        HIVRA_WORKSPACE_ROOT: path.join(root, "Hivra"),
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    child.on("message", (message: { attemptedProcess?: unknown }) => {
      if (message.attemptedProcess) attemptedProcesses.push(message.attemptedProcess);
    });
    let errors = "";
    child.stderr?.on("data", chunk => { errors = (errors + String(chunk)).slice(-2048); });
    port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Linux Desktop gateway fixture timed out")), 5_000);
      child!.once("error", error => { clearTimeout(timer); reject(error); });
      child!.once("exit", () => { clearTimeout(timer); reject(new Error(`Linux Desktop gateway exited: ${errors}`)); });
      child!.on("message", (message: { port?: number }) => {
        if (message.port) { clearTimeout(timer); resolve(message.port); }
      });
    });
  });

  afterAll(async () => {
    const running = child;
    child = undefined;
    if (running && running.exitCode === null && running.signalCode === null) {
      await new Promise<void>(resolve => {
        const timeout = setTimeout(() => {
          if (running.exitCode === null && running.signalCode === null) running.kill("SIGKILL");
          resolve();
        }, 2_000);
        running.once("exit", () => { clearTimeout(timeout); resolve(); });
        running.kill("SIGTERM");
      });
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  function request(route: string, options: { method?: string; body?: string; authenticated?: boolean } = {}) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port,
        path: route,
        method: options.method ?? "GET",
        agent: false,
        headers: {
          Host: "computer.hivra.test",
          ...(options.authenticated ? { Authorization: `Bearer ${TOKEN}` } : {}),
          ...(options.body ? { "Content-Type": "application/json" } : {}),
        },
      }, res => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", chunk => { body += chunk; });
        res.once("error", reject);
        res.once("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.once("error", reject);
      req.setTimeout(2_000, () => req.destroy(new Error("Linux Desktop fixture request timed out")));
      req.end(options.body);
    });
  }

  it("advertises a computer rather than an agent chat runtime", async () => {
    const result = await request("/api/meta");
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      agentKind: "linux-desktop",
      resourceKind: "computer",
      chatAvailable: false,
      loginAvailable: false,
      workspace: "Hivra",
    });
    expect(JSON.parse(result.body).llmApplication).toBeUndefined();
  });

  it("closes chat, agent sessions and account-login routes without starting a process", async () => {
    const chat = await request("/api/chat", { method: "POST", authenticated: true, body: JSON.stringify({ message: "do not run" }) });
    const status = await request("/api/login/status", { authenticated: true });
    const start = await request("/api/login/start", { method: "POST", authenticated: true });
    const complete = await request("/api/login/complete", { method: "POST", authenticated: true });
    const sessions = await request("/api/sessions", { authenticated: true });
    const rootSurface = await request("/");
    expect(chat.status).toBe(409);
    expect(JSON.parse(status.body)).toEqual({ loggedIn: false, available: false, reason: "not-applicable" });
    expect([start.status, complete.status, sessions.status]).toEqual([409, 409, 409]);
    expect(rootSurface.status).toBe(404);
    expect(attemptedProcesses).toEqual([]);
  });

  it("binds Files and native terminals to the Hivra workspace and installs desktop before its receipt", () => {
    const server = fs.readFileSync(sourcePath, "utf8");
    const installer = fs.readFileSync(installerPath, "utf8");
    expect(server).toContain("const GUARDED_FILES = createGuardedFiles(WORKSPACE_ROOT);");
    expect(server).toContain('COMPUTER_PROFILE ? path.join(HOME, "Hivra") : HOME');
    expect(installer).toContain("WorkingDirectory=/home/bux/Hivra");
    expect(installer).toContain('rm -rf "${AGENT_HOME}/.claude" "${AGENT_HOME}/.agents"');
    expect(installer).toContain(`[[ "$REMOTE_DESKTOP_RESULT" != *$'\\n'* ]]`);
    const desktopInstall = installer.indexOf('remote-desktop/install-guest.py"');
    const runtimeReceipt = installer.indexOf('RECEIPT_RESULT="$(python3 "$SRC_DIR/hivra-runtime-receipt.py"');
    expect(desktopInstall).toBeGreaterThan(0);
    expect(runtimeReceipt).toBeGreaterThan(desktopInstall);
  });
});
