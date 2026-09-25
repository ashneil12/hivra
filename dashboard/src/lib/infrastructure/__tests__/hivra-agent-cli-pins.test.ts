/** @jest-environment node */
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

import { AGENT_CLI_VERSIONS } from "../portable-provisioner-contract";

// Hivra owns the Claude Code / Codex versions on its computers: the pins ship
// as bundle data, vendor self-updaters stay off, and the gateway reports the
// installed version so the dashboard can offer the vetted one.

const bundle = path.join(process.cwd(), "provisioner");
const PIN_SCRIPT = path.join(bundle, "hivra-codex-config-pin.py");
const SERVER_PATH = path.join(bundle, "hivra-chat/server.js");

describe("vetted agent CLI pins", () => {
  it("exports the same pins the guest installer reads", () => {
    const pins = JSON.parse(fs.readFileSync(path.join(bundle, "agent-cli-versions.json"), "utf8"));
    expect(AGENT_CLI_VERSIONS).toEqual(pins);
    expect(Object.keys(pins).sort()).toEqual(["claude-code", "codex"]);
    for (const version of Object.values(pins)) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    const installer = fs.readFileSync(path.join(bundle, "provision-claude-code-box.sh"), "utf8");
    expect(installer).not.toMatch(/CLAUDE_CODE_VERSION="\$\{CLAUDE_CODE_VERSION:-\d/);
    expect(installer).toContain('CLAUDE_CODE_VERSION="$(read_agent_cli_pin claude-code)"');
    expect(installer).toContain('CODEX_CLI_VERSION="$(read_agent_cli_pin codex)"');
  });
});

describe("Codex startup update check", () => {
  let home: string;
  beforeEach(() => { home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hivra-codex-pin-"))); });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = () => path.join(home, ".codex", "config.toml");
  function pin() {
    return spawnSync("python3", ["-I", "-"], { input: fs.readFileSync(PIN_SCRIPT), encoding: "utf8", env: { HOME: home, PATH: "/usr/bin:/bin", NODE_ENV: "test" } });
  }

  it("turns the check off for a computer with no Codex config yet", () => {
    expect(pin()).toMatchObject({ status: 0, stdout: "HIVRA_CODEX_UPDATE_CHECK off\n" });
    expect(fs.readFileSync(config(), "utf8")).toMatch(/^# .*\ncheck_for_update_on_startup = false\n$/);
    expect(fs.statSync(config()).mode & 0o777).toBe(0o600);
  });

  it("adds a top-level key ahead of every table and keeps the owner's config byte for byte", () => {
    fs.mkdirSync(path.dirname(config()));
    const owner = 'model = "gpt-5"\n\n[mcp_servers.docs]\ncommand = "npx"\n';
    fs.writeFileSync(config(), owner, { mode: 0o640 });
    expect(pin().status).toBe(0);
    const text = fs.readFileSync(config(), "utf8");
    expect(text.endsWith(owner)).toBe(true);
    expect(text.indexOf("check_for_update_on_startup = false")).toBeLessThan(text.indexOf("[mcp_servers.docs]"));
    expect(fs.statSync(config()).mode & 0o777).toBe(0o640);
    // Idempotent: a second run changes nothing.
    expect(pin().stdout).toBe("HIVRA_CODEX_UPDATE_CHECK kept\n");
    expect(fs.readFileSync(config(), "utf8")).toBe(text);
  });

  it("keeps an owner's explicit top-level choice", () => {
    fs.mkdirSync(path.dirname(config()));
    fs.writeFileSync(config(), "check_for_update_on_startup = true\n[profiles.x]\nmodel = \"o\"\n");
    expect(pin().stdout).toBe("HIVRA_CODEX_UPDATE_CHECK kept\n");
    expect(fs.readFileSync(config(), "utf8")).toBe("check_for_update_on_startup = true\n[profiles.x]\nmodel = \"o\"\n");
  });

  it("does not mistake a table's key for the top-level one", () => {
    fs.mkdirSync(path.dirname(config()));
    fs.writeFileSync(config(), "[profiles.x]\ncheck_for_update_on_startup = true\n");
    expect(pin().stdout).toBe("HIVRA_CODEX_UPDATE_CHECK off\n");
    expect(fs.readFileSync(config(), "utf8")).toMatch(/^# .*\ncheck_for_update_on_startup = false\n\[profiles\.x\]\n/);
  });

  it("replaces a symlinked config instead of writing through it", () => {
    fs.mkdirSync(path.dirname(config()));
    const elsewhere = path.join(home, "elsewhere.txt");
    fs.writeFileSync(elsewhere, "untouched\n");
    fs.symlinkSync(elsewhere, config());
    expect(pin().status).toBe(0);
    expect(fs.readFileSync(elsewhere, "utf8")).toBe("untouched\n");
    expect(fs.lstatSync(config()).isSymbolicLink()).toBe(false);
  });

  it("runs from the guest installer as the owner, only for Codex computers", () => {
    const installer = fs.readFileSync(path.join(bundle, "provision-claude-code-box.sh"), "utf8");
    expect(installer).toContain('sudo -u "${AGENT_USER}" env HOME="${AGENT_HOME}" python3 -I - < "$SRC_DIR/hivra-codex-config-pin.py"');
    const codexBlock = installer.slice(installer.indexOf('if [ "$AGENT_KIND" = "codex" ]; then\n  if sudo -iu'));
    expect(codexBlock.slice(0, codexBlock.indexOf("\nfi\n"))).toContain("hivra-codex-config-pin.py");
  });
});

describe("gateway agent CLI report", () => {
  const TOKEN = "e".repeat(64);
  type Box = Awaited<ReturnType<typeof boot>>;
  async function boot(kind: string, versionReply: { error: Error | null; stdout: string }) {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hivra-agent-cli-")));
    fs.mkdirSync(path.join(home, ".hivra"), { mode: 0o700 });
    fs.writeFileSync(path.join(home, ".hivra", "api-token"), TOKEN);
    fs.writeFileSync(path.join(home, ".hivra", "agent-kind"), kind + "\n");
    // Stand-ins for /usr/bin/claude and ~/.npm-global/bin/codex that exit at once.
    const bin = path.join(home, "cli");
    fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const lock = path.join(home, "agent-cli-update.lock");
    const status = path.join(home, "agent-cli-update.json");
    const probes: Array<{ bin: string; args: string[]; env: Record<string, string> }> = [];
    let server: http.Server | undefined;
    const realRequire = createRequire(SERVER_PATH);
    vm.runInNewContext(fs.readFileSync(SERVER_PATH, "utf8"), {
      require: (name: string) => {
        if (name === "http") return { ...http, createServer: (handler: http.RequestListener) => (server = http.createServer(handler)) };
        if (name === "child_process") {
          return {
            spawn: () => { throw new Error("no agent process in this test"); },
            execFile: (file: string, args: string[], options: { env: Record<string, string> }, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
              probes.push({ bin: file, args, env: options.env });
              setImmediate(() => callback(versionReply.error, versionReply.stdout, ""));
            },
          };
        }
        if (["fs", "path", "net", "crypto", "./llm-application.js", "./guarded-files.cjs", "./agent-zero-editor.cjs", "./chat-runs.cjs"].includes(name)) return realRequire(name);
        throw new Error(`Unexpected guest dependency: ${name}`);
      },
      process: { env: { HOME: home, HIVRA_CHAT_PORT: "0", CLAUDE_BIN: bin, CODEX_BIN: bin, HIVRA_AGENT_CLI_LOCK: lock, HIVRA_AGENT_CLI_STATUS: status }, once: () => undefined },
      __dirname: path.dirname(SERVER_PATH),
      console: { log: () => undefined, warn: () => undefined, error: () => undefined },
      Buffer, URL, URLSearchParams, setTimeout, clearTimeout, setImmediate,
    }, { filename: SERVER_PATH });
    if (!server!.listening) await once(server!, "listening");
    const port = (server!.address() as net.AddressInfo).port;
    const call = (method: string, route: string, body?: unknown, auth = true) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path: route, method, agent: false,
        headers: { ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}), "Content-Type": "application/json" } }, (res) => {
        let text = ""; res.setEncoding("utf8"); res.on("data", (c) => { text += c; }); res.once("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      });
      req.once("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const meta = async (auth = true) => JSON.parse((await call("GET", "/api/meta", undefined, auth)).body);
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    const close = async () => { await new Promise<void>((resolve) => server!.close(() => resolve())); fs.rmSync(home, { recursive: true, force: true }); };
    return { home, bin, lock, status, probes, call, meta, settle, close };
  }
  async function withBox(kind: string, reply: { error: Error | null; stdout: string }, test: (box: Box) => Promise<void>) {
    const box = await boot(kind, reply);
    try { await box.settle(); await test(box); } finally { await box.close(); }
  }

  it.each([
    ["claude", "2.1.246 (Claude Code)\n", "claude-code", "2.1.246"],
    ["codex", "codex-cli 0.149.1\n", "codex", "0.149.1"],
  ])("reports the %s version from the binary chat runs, to the dashboard only", (kind, stdout, name, version) => withBox(kind, { error: null, stdout }, async (box) => {
    expect(box.probes).toHaveLength(1);
    expect(box.probes[0]).toMatchObject({ bin: box.bin, args: ["--version"] });
    // Every CLI the gateway starts runs with the vendor self-updater off.
    expect(box.probes[0].env.DISABLE_AUTOUPDATER).toBe("1");
    expect((await box.meta()).agentCli).toEqual({ name, version });
    // The public metadata a signed-out visitor sees carries no version.
    expect(await box.meta(false)).not.toHaveProperty("agentCli");
  }));

  it("reports null when the CLI cannot report a version", () => withBox("codex", { error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }), stdout: "" }, async (box) => {
    expect((await box.meta()).agentCli).toEqual({ name: "codex", version: null });
  }));

  it("probes again only after the binary changes on disk", () => withBox("claude", { error: null, stdout: "2.1.246\n" }, async (box) => {
    await box.meta(); await box.meta();
    expect(box.probes).toHaveLength(1);
    fs.writeFileSync(box.bin, "#!/bin/sh\n# a newer package\nexit 0\n");
    await box.meta(); await box.settle();
    expect(box.probes).toHaveLength(2);
  }));

  it("reports the updater's progress and ignores anything malformed", () => withBox("codex", { error: null, stdout: "codex-cli 0.149.1\n" }, async (box) => {
    fs.writeFileSync(box.status, JSON.stringify({ name: "codex", state: "waiting", from: "0.149.1", to: "0.156.1", updatedAt: "2026-09-24T18:00:00Z" }));
    expect((await box.meta()).agentCli).toEqual({ name: "codex", version: "0.149.1", update: { state: "waiting", target: "0.156.1", updatedAt: "2026-09-24T18:00:00Z" } });
    fs.writeFileSync(box.status, JSON.stringify({ name: "codex", state: "rolled_back", to: "0.156.1", updatedAt: "2026-09-24T18:05:00Z", reason: "install_failed" }));
    expect((await box.meta()).agentCli.update).toEqual({ state: "rolled_back", target: "0.156.1", updatedAt: "2026-09-24T18:05:00Z", reason: "install_failed" });
    for (const bad of [{ name: "claude-code", state: "done", to: "2.1.246" }, { name: "codex", state: "<b>", to: "0.156.1" }, { name: "codex", state: "done", to: "latest" }, "not json"]) {
      fs.writeFileSync(box.status, typeof bad === "string" ? bad : JSON.stringify(bad));
      expect((await box.meta()).agentCli).toEqual({ name: "codex", version: "0.149.1" });
    }
  }));

  it("holds a new chat run back while the CLI package is being swapped, but never a re-attach", () => withBox("claude", { error: null, stdout: "2.1.246\n" }, async (box) => {
    fs.writeFileSync(box.lock, "");
    const refused = await box.call("POST", "/api/chat", { message: "hello", runId: "00000000-0000-4000-8000-000000000001", detach: true });
    expect(refused.status).toBe(503);
    expect(JSON.parse(refused.body)).toMatchObject({ code: "agent_updating" });
    expect(fs.existsSync(path.join(box.home, ".hivra", "chat-runs", "00000000-0000-4000-8000-000000000001"))).toBe(false);
  }));

  it("reports nothing for runtimes that are not a coding CLI", () => withBox("openclaw", { error: null, stdout: "" }, async (box) => {
    expect(box.probes).toEqual([]);
    expect(await box.meta()).not.toHaveProperty("agentCli");
  }));
});

describe("chat run admission", () => {
  it("lets the caller refuse a new run but always re-attaches an existing one", () => {
    const { createChatRunStore, ChatRunError } = createRequire(SERVER_PATH)("./chat-runs.cjs");
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hivra-chat-admit-")));
    try {
      let spawned = 0;
      const store = createChatRunStore({ root, spawn: () => { spawned += 1; return { on: () => undefined, unref: () => undefined, pid: 4242 }; } });
      const input = { runId: "00000000-0000-4000-8000-000000000002", bin: "/bin/true", args: [], cwd: root, env: {}, stdinText: "hi" };
      const refusal = { code: "agent_updating", status: 503, message: "later" };
      expect(() => store.start({ ...input, admit: () => refusal })).toThrow(ChatRunError);
      expect(spawned).toBe(0);
      expect(store.start({ ...input, admit: () => null }).created).toBe(true);
      expect(spawned).toBe(1);
      expect(store.start({ ...input, admit: () => refusal }).created).toBe(false);
      expect(spawned).toBe(1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
