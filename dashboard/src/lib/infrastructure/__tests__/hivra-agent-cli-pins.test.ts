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
    return spawnSync("python3", ["-I", "-"], { input: fs.readFileSync(PIN_SCRIPT), encoding: "utf8", env: { HOME: home, PATH: "/usr/bin:/bin" } });
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
  async function boot(kind: string, versionReply: { error: Error | null; stdout: string }) {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hivra-agent-cli-")));
    fs.mkdirSync(path.join(home, ".hivra"), { mode: 0o700 });
    fs.writeFileSync(path.join(home, ".hivra", "api-token"), "e".repeat(64));
    fs.writeFileSync(path.join(home, ".hivra", "agent-kind"), kind + "\n");
    const probes: Array<{ bin: string; args: string[]; env: Record<string, string> }> = [];
    let server: http.Server | undefined;
    const realRequire = createRequire(SERVER_PATH);
    vm.runInNewContext(fs.readFileSync(SERVER_PATH, "utf8"), {
      require: (name: string) => {
        if (name === "http") return { ...http, createServer: (handler: http.RequestListener) => (server = http.createServer(handler)) };
        if (name === "child_process") {
          return {
            spawn: () => { throw new Error("no agent process in this test"); },
            execFile: (bin: string, args: string[], options: { env: Record<string, string> }, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
              probes.push({ bin, args, env: options.env });
              setImmediate(() => callback(versionReply.error, versionReply.stdout, ""));
            },
          };
        }
        if (["fs", "path", "net", "crypto", "./llm-application.js", "./guarded-files.cjs", "./agent-zero-editor.cjs", "./chat-runs.cjs"].includes(name)) return realRequire(name);
        throw new Error(`Unexpected guest dependency: ${name}`);
      },
      process: { env: { HOME: home, HIVRA_CHAT_PORT: "0" }, once: () => undefined },
      __dirname: path.dirname(SERVER_PATH),
      console: { log: () => undefined, warn: () => undefined, error: () => undefined },
      Buffer, URL, URLSearchParams, setTimeout, clearTimeout, setImmediate,
    }, { filename: SERVER_PATH });
    if (!server!.listening) await once(server!, "listening");
    const port = (server!.address() as net.AddressInfo).port;
    const meta = async () => JSON.parse(await new Promise<string>((resolve, reject) => {
      http.get({ hostname: "127.0.0.1", port, path: "/api/meta", agent: false }, (res) => {
        let text = ""; res.setEncoding("utf8"); res.on("data", (c) => { text += c; }); res.once("end", () => resolve(text));
      }).once("error", reject);
    }));
    const close = async () => { await new Promise<void>((resolve) => server!.close(() => resolve())); fs.rmSync(home, { recursive: true, force: true }); };
    return { probes, meta, close };
  }

  it.each([
    ["claude", "/usr/bin/claude", "2.1.246 (Claude Code)\n", "claude-code", "2.1.246"],
    ["codex", "/home/bux/.npm-global/bin/codex", "codex-cli 0.149.1\n", "codex", "0.149.1"],
  ])("reports the %s version from the binary chat runs", async (kind, bin, stdout, name, version) => {
    const box = await boot(kind, { error: null, stdout });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(box.probes).toHaveLength(1);
      expect(box.probes[0]).toMatchObject({ bin, args: ["--version"] });
      // Every CLI the gateway starts runs with the vendor self-updater off.
      expect(box.probes[0].env.DISABLE_AUTOUPDATER).toBe("1");
      expect((await box.meta()).agentCli).toEqual({ name, version });
    } finally { await box.close(); }
  });

  it("reports null when the CLI cannot report a version", async () => {
    const box = await boot("codex", { error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }), stdout: "" });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect((await box.meta()).agentCli).toEqual({ name: "codex", version: null });
    } finally { await box.close(); }
  });

  it("reports nothing for runtimes that are not a coding CLI", async () => {
    const box = await boot("openclaw", { error: null, stdout: "" });
    try {
      expect(box.probes).toEqual([]);
      expect(await box.meta()).not.toHaveProperty("agentCli");
    } finally { await box.close(); }
  });
});
