/** @jest-environment node */
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";

// The computer gateway's /api/claude-app/* routes. The unmodified gateway runs
// here with child_process replaced, so each test asserts the exact command the
// gateway would hand the root helper (always `sudo -n <helper> <fixed verb>`)
// and nothing a request body could add to it.

const TOKEN = "c".repeat(64);
const SERVER_PATH = path.join(process.cwd(), "provisioner/hivra-chat/server.js");
const SERVER_SOURCE = fs.readFileSync(SERVER_PATH, "utf8");
const HELPER = "/usr/local/bin/hivra-claude-app";

type Call = { file: string; args: string[]; detached?: boolean; stdin?: string };

describe("gateway Claude app routes", () => {
  let home: string;
  const closers: Array<() => Promise<void>> = [];
  let calls: Call[];
  let helperOutput: string;
  let helperFails: boolean;
  let helperPresent: boolean;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "hivra-claude-app-gateway-"));
    calls = [];
    helperOutput = JSON.stringify({ protocol: "hivra-claude-app-v1", enabled: false });
    helperFails = false;
    helperPresent = true;
  });
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  function boot(kind: string): Promise<number> {
    fs.mkdirSync(path.join(home, ".hivra"), { recursive: true });
    fs.writeFileSync(path.join(home, ".hivra", "api-token"), TOKEN);
    fs.writeFileSync(path.join(home, ".hivra", "agent-kind"), `${kind}\n`);
    let server: http.Server | undefined;
    const realRequire = createRequire(SERVER_PATH);
    const realFs = realRequire("fs") as typeof fs;
    const fakeFs = {
      ...realFs,
      statSync: (p: fs.PathLike, ...rest: unknown[]) => {
        if (p === HELPER) {
          if (!helperPresent) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          return realFs.statSync(__filename);
        }
        return (realFs.statSync as (...a: unknown[]) => fs.Stats)(p, ...rest);
      },
    };
    const fakeHttp = {
      ...http,
      createServer: (handler: http.RequestListener) => {
        server = http.createServer(handler);
        return server;
      },
    };
    const childProcess = {
      spawn: (file: string, args: string[], options: { detached?: boolean; stdio?: unknown }) => {
        const call: Call = { file, args, detached: options?.detached };
        calls.push(call);
        // A piped child (clipboard paste): record what is written to its stdin,
        // then answer on stdout and close, like the helper would.
        const listeners: Record<string, Array<(value?: unknown) => void>> = {};
        const stdoutListeners: Array<(chunk: string) => void> = [];
        const child = {
          on: (event: string, listener: (value?: unknown) => void) => { (listeners[event] ||= []).push(listener); return child; },
          unref: () => undefined,
          kill: () => undefined,
          stdout: { on: (_event: string, listener: (chunk: string) => void) => { stdoutListeners.push(listener); } },
          stderr: { on: () => undefined },
          stdin: {
            on: () => undefined,
            end: (data: Buffer) => {
              call.stdin = Buffer.from(data).toString("utf8");
              setImmediate(() => {
                for (const listener of stdoutListeners) listener(helperOutput + "\n");
                for (const listener of listeners.close || []) listener(helperFails ? 1 : 0);
              });
            },
          },
        };
        return child;
      },
      execFile: (file: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
        calls.push({ file, args });
        if (typeof callback !== "function") return;
        // Like Node, a helper that exits non-zero still hands back what it printed.
        setImmediate(() => helperFails ? callback(new Error("helper failed"), helperOutput + "\n") : callback(null, helperOutput + "\n"));
      },
    };
    vm.runInNewContext(SERVER_SOURCE, {
      require: (name: string) => {
        if (name === "http") return fakeHttp;
        if (name === "fs") return fakeFs;
        if (name === "child_process") return childProcess;
        if (["path", "crypto", "net", "./llm-application.js", "./guarded-files.cjs", "./agent-zero-editor.cjs", "./chat-runs.cjs"].includes(name)) return realRequire(name);
        throw new Error(`Unexpected guest dependency: ${name}`);
      },
      process: { env: { HOME: home, HIVRA_CHAT_PORT: "0", HIVRA_AGENT_KIND: kind }, once: () => undefined, getuid: () => os.userInfo().uid },
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

  function request(port: number, method: string, pathname: string, body?: unknown, auth = true): Promise<{ status: number; json: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({
        hostname: "127.0.0.1", port, path: pathname, method, agent: false,
        headers: { Host: "box.hivra.test", ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}), ...(payload ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) } : {}) },
      }, (res) => {
        let text = ""; res.setEncoding("utf8"); res.on("data", (c) => { text += c; });
        res.once("end", () => { let json: Record<string, unknown> = {}; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode ?? 0, json }); });
      });
      req.once("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
  const sudo = (...verb: string[]): Call => ({ file: "sudo", args: ["-n", HELPER, ...verb] });
  // The gateway also probes the agent CLI for /api/meta; only helper calls matter here.
  const helperCalls = () => calls.filter((call) => call.file === "sudo");

  it("advertises the Claude app in /api/meta only on a computer whose helper is installed", async () => {
    const port = await boot("linux-desktop");
    expect((await request(port, "GET", "/api/meta")).json.claudeApp).toBe("hivra-claude-app-v1");
    helperPresent = false;
    expect((await request(port, "GET", "/api/meta")).json.claudeApp).toBeUndefined();
  });

  it("is absent from every agent that is not an Ubuntu Desktop computer", async () => {
    const port = await boot("claude");
    expect((await request(port, "GET", "/api/meta")).json.claudeApp).toBeUndefined();
    for (const [method, route, body] of [["GET", "/api/claude-app/status"], ["POST", "/api/claude-app/install"], ["POST", "/api/claude-app/mode", { mode: "app" }], ["POST", "/api/claude-app/remove", { confirm: true }]] as const) {
      expect((await request(port, method, route, body)).status).toBe(404);
    }
    expect(helperCalls()).toEqual([]);
  });

  it("answers 401 to every route without the box token and runs nothing", async () => {
    const port = await boot("linux-desktop");
    for (const [method, route, body] of [["GET", "/api/claude-app/status"], ["POST", "/api/claude-app/install"], ["POST", "/api/claude-app/mode", { mode: "app" }], ["POST", "/api/claude-app/remove", { confirm: true }]] as const) {
      expect((await request(port, method, route, body, false)).status).toBe(401);
    }
    expect(calls).toEqual([]);
  });

  it("reports the helper's status, and refuses an answer that is not its protocol", async () => {
    const port = await boot("linux-desktop");
    const ok = await request(port, "GET", "/api/claude-app/status");
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ protocol: "hivra-claude-app-v1", enabled: false });
    expect(helperCalls()).toEqual([sudo("status")]);
    helperOutput = JSON.stringify({ protocol: "something-else" });
    expect((await request(port, "GET", "/api/claude-app/status")).status).toBe(502);
    helperFails = true;
    expect((await request(port, "GET", "/api/claude-app/status")).status).toBe(502);
  });

  it("starts an install detached and answers at once, running exactly the install verb", async () => {
    const port = await boot("linux-desktop");
    const response = await request(port, "POST", "/api/claude-app/install", { extra: "--force; rm -rf /" });
    expect(response.status).toBe(202);
    expect(response.json).toMatchObject({ ok: true, installing: true });
    expect(helperCalls()).toEqual([{ ...sudo("install"), detached: true }]);
  });

  it("switches only between the two named views and passes nothing else to the helper", async () => {
    const port = await boot("linux-desktop");
    helperOutput = JSON.stringify({ ok: true, mode: "desktop", applied: true });
    const ok = await request(port, "POST", "/api/claude-app/mode", { mode: "desktop", extra: "x" });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ ok: true, mode: "desktop", applied: true });
    expect(helperCalls()).toEqual([sudo("mode", "desktop")]);
    calls.length = 0;
    for (const mode of ["fullscreen", "app; reboot", "", undefined, ["app"]]) {
      expect((await request(port, "POST", "/api/claude-app/mode", { mode })).status).toBe(400);
    }
    expect(helperCalls()).toEqual([]);
  });

  it("tells the owner the app is not added yet instead of pretending a view was applied", async () => {
    const port = await boot("linux-desktop");
    helperOutput = JSON.stringify({ ok: false, error: "not_installed" });
    const response = await request(port, "POST", "/api/claude-app/mode", { mode: "app" });
    expect(response.status).toBe(409);
    expect(String(response.json.error)).toContain("not added");
  });

  it("removes the app only when the request confirms it", async () => {
    const port = await boot("linux-desktop");
    expect((await request(port, "POST", "/api/claude-app/remove", {})).status).toBe(400);
    expect((await request(port, "POST", "/api/claude-app/remove", { confirm: "yes" })).status).toBe(400);
    expect(helperCalls()).toEqual([]);
    helperOutput = JSON.stringify({ ok: true, removed: true });
    expect((await request(port, "POST", "/api/claude-app/remove", { confirm: true })).status).toBe(200);
    expect(helperCalls()).toEqual([sudo("remove")]);
  });

  it("turns the clipboard switch on and off with only a boolean", async () => {
    const port = await boot("linux-desktop");
    helperOutput = JSON.stringify({ ok: true, clipboard: true });
    const on = await request(port, "POST", "/api/claude-app/clipboard", { enabled: true, extra: "x" });
    expect(on.status).toBe(200);
    expect(on.json).toEqual({ ok: true, clipboard: true });
    helperOutput = JSON.stringify({ ok: true, clipboard: false });
    expect((await request(port, "POST", "/api/claude-app/clipboard", { enabled: false })).json).toEqual({ ok: true, clipboard: false });
    expect(helperCalls()).toEqual([sudo("clipboard", "on"), sudo("clipboard", "off")]);
    calls.length = 0;
    for (const enabled of ["true", 1, null, undefined]) {
      expect((await request(port, "POST", "/api/claude-app/clipboard", { enabled })).status).toBe(400);
    }
    expect(helperCalls()).toEqual([]);
  });

  it("pastes text into the desktop through the helper's stdin, never its arguments", async () => {
    const port = await boot("linux-desktop");
    helperOutput = JSON.stringify({ ok: true, bytes: 13 });
    const text = "rm -rf / ; héllo";
    const response = await request(port, "POST", "/api/claude-app/clipboard/paste", { text });
    expect(response.status).toBe(200);
    expect(helperCalls()).toEqual([{ ...sudo("clipboard-put"), detached: undefined, stdin: text }]);
    calls.length = 0;
    expect((await request(port, "POST", "/api/claude-app/clipboard/paste", { text: 5 })).status).toBe(400);
    expect((await request(port, "POST", "/api/claude-app/clipboard/paste", { text: "a".repeat(256 * 1024 + 1) })).status).toBe(413);
    expect(helperCalls()).toEqual([]);
  });

  it("says plainly when the switch is off instead of pasting or copying", async () => {
    const port = await boot("linux-desktop");
    helperOutput = JSON.stringify({ ok: false, error: "clipboard_off" });
    const paste = await request(port, "POST", "/api/claude-app/clipboard/paste", { text: "x" });
    expect(paste.status).toBe(409);
    expect(String(paste.json.error)).toContain("clipboard is off");
    helperFails = true;
    const copy = await request(port, "POST", "/api/claude-app/clipboard/copy");
    expect(copy.status).toBe(409);
  });

  it("copies the desktop clipboard out as text", async () => {
    const port = await boot("linux-desktop");
    helperOutput = JSON.stringify({ ok: true, text: "from the desktop" });
    const response = await request(port, "POST", "/api/claude-app/clipboard/copy", { anything: "ignored" });
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ ok: true, text: "from the desktop" });
    expect(helperCalls()).toEqual([sudo("clipboard-get")]);
  });

  it("keeps the clipboard routes behind the box token and off other computers", async () => {
    let port = await boot("linux-desktop");
    for (const [route, body] of [["/api/claude-app/clipboard", { enabled: true }], ["/api/claude-app/clipboard/paste", { text: "x" }], ["/api/claude-app/clipboard/copy", {}]] as const) {
      expect((await request(port, "POST", route, body, false)).status).toBe(401);
    }
    expect(calls).toEqual([]);
    for (const close of closers.splice(0)) await close();
    port = await boot("claude");
    for (const [route, body] of [["/api/claude-app/clipboard", { enabled: true }], ["/api/claude-app/clipboard/paste", { text: "x" }], ["/api/claude-app/clipboard/copy", {}]] as const) {
      expect((await request(port, "POST", route, body)).status).toBe(404);
    }
    expect(helperCalls()).toEqual([]);
  });

  it("matches the exact sudoers grant the installer writes", () => {
    const grant = fs.readFileSync(path.join(process.cwd(), "provisioner/provision-claude-code-box.sh"), "utf8");
    const granted = [...grant.matchAll(/hivra-claude-app (status|install|remove|mode (?:app|desktop)|clipboard (?:on|off)|clipboard-put|clipboard-get)/g)].map((match) => match[1]);
    expect([...new Set(granted)].sort()).toEqual(["clipboard off", "clipboard on", "clipboard-get", "clipboard-put", "install", "mode app", "mode desktop", "remove", "status"]);
    expect(SERVER_SOURCE).toContain('["clipboard", enabled ? "on" : "off"]');
    expect(SERVER_SOURCE).toContain('"clipboard-put"');
    expect(SERVER_SOURCE).toContain('"clipboard-get"');
    for (const verb of ["status", "install", "remove"]) expect(SERVER_SOURCE).toContain(`"${verb}"`);
    expect(SERVER_SOURCE).toContain('["mode", mode]');
  });
});
