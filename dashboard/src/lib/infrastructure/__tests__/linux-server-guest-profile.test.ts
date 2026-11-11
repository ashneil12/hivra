/** @jest-environment node */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const TOKEN = "a".repeat(64);
const sourcePath = path.resolve("provisioner/hivra-chat/server.js");
const installerPath = path.resolve("provisioner/provision-claude-code-box.sh");

describe("Linux server guest profile", () => {
  let root = "";
  let port = 0;
  let child: ChildProcess | undefined;
  const attemptedProcesses: unknown[] = [];

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "hivra-linux-server-guest-"));
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
        HIVRA_AGENT_KIND: "linux-server",
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
      const timer = setTimeout(() => reject(new Error("Linux server gateway fixture timed out")), 5_000);
      child!.once("error", error => { clearTimeout(timer); reject(error); });
      child!.once("exit", () => { clearTimeout(timer); reject(new Error(`Linux server gateway exited: ${errors}`)); });
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
      req.setTimeout(2_000, () => req.destroy(new Error("Linux server fixture request timed out")));
      req.end(options.body);
    });
  }

  it("advertises a computer rather than an agent chat runtime", async () => {
    const result = await request("/api/meta");
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      agentKind: "linux-server",
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

  it("reports no Claude app on a computer that has no desktop", async () => {
    const meta = JSON.parse((await request("/api/meta")).body);
    expect(meta.claudeApp).toBeUndefined();
    expect(meta.attachedAgents).toBe("hivra-attached-agent-v1");
    const app = await request("/api/claude-app", { authenticated: true });
    expect(app.status).toBe(404);
    expect(attemptedProcesses).toEqual([]);
  });

  it("treats a writable agent-kind file as untrusted for the root-owned computer service", async () => {
    // The gateway was started with HIVRA_AGENT_KIND=linux-server while the file says claude.
    expect(fs.readFileSync(path.join(root, ".hivra/agent-kind"), "utf8")).toBe("claude\n");
    expect(JSON.parse((await request("/api/meta")).body).agentKind).toBe("linux-server");
  });

  it("installs the same base and workspace as Linux Desktop but never the desktop capability or Claude app helper", () => {
    const server = fs.readFileSync(sourcePath, "utf8");
    const installer = fs.readFileSync(installerPath, "utf8");
    expect(server).toContain('const COMPUTER_PROFILE = AGENT_KIND === "linux-desktop" || AGENT_KIND === "linux-server";');
    expect(installer).toContain("linux-desktop|linux-server) ;;");
    expect(installer).toContain("WorkingDirectory=/home/bux/Hivra");
    // Shared base, workspace, persona strip and gateway workspace root follow both kinds.
    expect(installer).toContain("if is_linux_computer; then\n  # A plain computer must not depend");
    expect(installer).toContain("  is_linux_computer || return 0\n  local workspace=");
    expect(installer).toContain("if is_linux_computer; then\n  sed -i \"/^Environment=HIVRA_AGENT_KIND=/a Environment=HIVRA_WORKSPACE_ROOT");
    expect(installer).toContain('! is_linux_computer; then\nsay "6/7');
    expect(installer).toContain('[ "$AGENT_KIND" = "linux-server" ] && WANT_BROWSER=0');
    // The desktop capability install, its artifact check and the Claude app helper stay desktop-only.
    expect(installer).toContain('if [ "$AGENT_KIND" = "linux-desktop" ]; then\n  say "Linux Desktop capability installation"');
    expect(installer).toContain('if [ "$AGENT_KIND" = "linux-desktop" ] && [ "$PROVIDER_DESKTOP_PREPARE_ONLY" != 1 ]; then\n  install -o root -g root -m 0755 "$SRC_DIR/hivra-claude-app.py"');
    expect(installer).toContain('if [ "$AGENT_KIND" = "linux-desktop" ]; then\n  for f in remote-desktop/install-guest.py');
    // Provider-VM preparation stays a linux-desktop-only mode.
    expect(installer).toContain("1) [ \"$kind\" = linux-desktop ] && [ \"$substrate\" = provider-vm ] || return 1 ;;");
    expect(installer).toContain("RECEIPT_ARGS=(");
  });
});
