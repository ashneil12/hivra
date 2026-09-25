/** @jest-environment node */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// hivra-agent-cli-update.sh moves a computer's Claude Code / Codex CLI to the
// release's vetted version. These tests run the real helper with npm, runuser
// and timeout replaced by fakes, against throwaway npm prefixes. The helper runs
// npm under env -i, so the fakes read their settings from fake.env beside them.

const HELPER = path.join(process.cwd(), "provisioner", "hivra-agent-cli-update.sh");

const FAKES: Record<string, string> = {
  // runuser -u USER -- CMD...: record the user, then run CMD as this test user.
  runuser: `#!/bin/sh
. "\${0%/*}/fake.env"
[ "$1" = -u ] && [ "$3" = -- ] || { echo "unexpected runuser $*" >&2; exit 97; }
echo "runuser $2 $4" >> "$FAKE_LOG"
shift 3
exec "$@"
`,
  timeout: `#!/bin/sh
while [ "\${1#-}" != "$1" ]; do shift 2; done
shift
exec "$@"
`,
  // npm --prefix PREFIX cache add PKG@V | install -g ... PKG@V
  npm: `#!/bin/sh
. "\${0%/*}/fake.env"
[ "$1" = --prefix ] || { echo "npm without an explicit prefix" >&2; exit 96; }
prefix="$2"; shift 2
spec=""; for arg in "$@"; do spec="$arg"; done
echo "npm $prefix $1 $spec home=$HOME lock=$([ -e "$FAKE_LOCK" ] && echo held || echo free)" >> "$FAKE_LOG"
case "$1" in
  cache) exit "\${FAKE_NPM_CACHE_EXIT:-0}" ;;
  install)
    package="\${spec%@*}"; version="\${spec##*@}"
    dir="$prefix/lib/node_modules/$package"
    if [ "\${FAKE_NPM_INSTALL_EXIT:-0}" != 0 ]; then rm -rf "$dir"; exit "$FAKE_NPM_INSTALL_EXIT"; fi
    rm -rf "$dir"; mkdir -p "$dir"
    printf '#!/bin/sh\\necho "%s"\\n' "\${FAKE_NPM_REPORTS:-$version}" > "$dir/cli.sh"; chmod 755 "$dir/cli.sh"
    exit 0 ;;
esac
exit 95
`,
};

interface Fixture { root: string; home: string; system: string; state: string; lock: string; log: string; env: NodeJS.ProcessEnv }

function fixture(): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hivra-agent-cli-update-")));
  const home = path.join(root, "home");
  const system = path.join(root, "usr");
  const bin = path.join(root, "fakes");
  for (const dir of [path.join(home, ".hivra", "chat-runs"), path.join(home, ".npm-global", "bin"), path.join(system, "bin"), bin]) fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(FAKES)) fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  const state = path.join(root, "state");
  const lock = path.join(root, "agent-cli-update.lock");
  const log = path.join(root, "log");
  fs.writeFileSync(log, "");
  installPackage(system, "@anthropic-ai/claude-code", "2.1.246 (Claude Code)", "claude");
  installPackage(path.join(home, ".npm-global"), "@openai/codex", "codex-cli 0.149.1", "codex");
  return {
    root, home, system, state, lock, log,
    env: {
      PATH: `${bin}:/usr/bin:/bin`, NODE_ENV: "test",
      HIVRA_AGENT_HOME: home, HIVRA_AGENT_CLI_STATE_DIR: state, HIVRA_AGENT_CLI_LOCK: lock,
      HIVRA_SYSTEM_NPM_PREFIX: system, HIVRA_AGENT_CLI_TEST_BIN: bin,
      HIVRA_AGENT_CLI_POLL_SECONDS: "0", HIVRA_AGENT_CLI_LOCK_SETTLE_SECONDS: "0", HIVRA_AGENT_CLI_WAIT_SECONDS: "0",
    },
  };
}
function installPackage(prefix: string, name: string, reports: string, binName: string) {
  const dir = path.join(prefix, "lib", "node_modules", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "cli.sh"), `#!/bin/sh\necho "${reports}"\n`, { mode: 0o755 });
  const link = path.join(prefix, "bin", binName);
  fs.rmSync(link, { force: true });
  fs.symlinkSync(path.relative(path.dirname(link), path.join(dir, "cli.sh")), link);
}
function run(f: Fixture, kind: string, target: string, fakeSettings: Record<string, string> = {}) {
  const settings = { FAKE_LOG: f.log, FAKE_LOCK: f.lock, ...fakeSettings };
  fs.writeFileSync(path.join(f.env.HIVRA_AGENT_CLI_TEST_BIN as string, "fake.env"),
    Object.entries(settings).map(([key, value]) => `${key}='${value}'\n`).join(""));
  const result = spawnSync("/bin/bash", [HELPER, kind, target], { encoding: "utf8", timeout: 20_000, env: f.env });
  const statusFile = path.join(f.state, "agent-cli-update.json");
  return {
    status: result.status, stderr: result.stderr,
    doc: fs.existsSync(statusFile) ? JSON.parse(fs.readFileSync(statusFile, "utf8")) : null,
    log: fs.readFileSync(f.log, "utf8").trim().split("\n").filter(Boolean),
  };
}
const version = (file: string) => spawnSync(file, ["--version"], { encoding: "utf8" }).stdout.trim();
const runStatus = (f: Fixture, id: string, doc: object) => {
  const dir = path.join(f.home, ".hivra", "chat-runs", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(doc));
};

describe("hivra-agent-cli-update.sh", () => {
  let f: Fixture;
  beforeEach(() => { f = fixture(); });
  afterEach(() => fs.rmSync(f.root, { recursive: true, force: true }));

  it("moves an idle Codex computer to the vetted version as its owner, holding new runs back only for the swap", () => {
    const result = run(f, "codex", "0.156.1");
    expect(result.status).toBe(0);
    expect(version(path.join(f.home, ".npm-global", "bin", "codex"))).toBe("0.156.1");
    expect(result.doc).toMatchObject({ name: "codex", state: "done", from: "0.149.1", to: "0.156.1" });
    const prefix = path.join(f.home, ".npm-global");
    // Download first with the lock free, then the swap under the lock.
    expect(result.log.filter(line => line.startsWith("npm "))).toEqual([
      `npm ${prefix} cache @openai/codex@0.156.1 home=${f.home} lock=free`,
      `npm ${prefix} install @openai/codex@0.156.1 home=${f.home} lock=held`,
    ]);
    // Every Codex step runs as the owner, never as root.
    expect(result.log.filter(line => line.startsWith("runuser ")).every(line => line.startsWith("runuser bux "))).toBe(true);
    expect(fs.existsSync(f.lock)).toBe(false);
    expect(fs.existsSync(path.join(f.home, ".hivra", "agent-cli-backup"))).toBe(false);
  });

  it("installs Claude Code into the system prefix it came from", () => {
    const result = run(f, "claude", "2.1.281");
    expect(result.status).toBe(0);
    expect(version(path.join(f.system, "bin", "claude"))).toBe("2.1.281");
    expect(result.doc).toMatchObject({ name: "claude-code", state: "done", from: "2.1.246", to: "2.1.281" });
    expect(result.log.filter(line => line.startsWith("npm "))).toEqual([
      `npm ${f.system} cache @anthropic-ai/claude-code@2.1.281 home=/root lock=free`,
      `npm ${f.system} install @anthropic-ai/claude-code@2.1.281 home=/root lock=held`,
    ]);
    expect(fs.existsSync(path.join(f.state, "agent-cli-backup"))).toBe(false);
  });

  it("does nothing but report when the computer already runs the vetted version", () => {
    const result = run(f, "codex", "0.149.1");
    expect(result.status).toBe(0);
    expect(result.doc).toMatchObject({ state: "done", from: "0.149.1", to: "0.149.1" });
    expect(result.log.filter(line => line.startsWith("npm "))).toEqual([]);
  });

  it("never swaps the CLI under a chat run that is still working, and gives up without touching it", () => {
    const sleeper = spawn("sleep", ["30"]);
    try {
      runStatus(f, "00000000-0000-4000-8000-000000000001", { state: "running", runnerPid: sleeper.pid });
      const result = run(f, "codex", "0.156.1");
      expect(result.status).toBe(0);
      expect(result.doc).toMatchObject({ state: "deferred", reason: "chat_run_in_flight" });
      expect(result.log.some(line => line.includes(" install "))).toBe(false);
      expect(version(path.join(f.home, ".npm-global", "bin", "codex"))).toBe("codex-cli 0.149.1");
      expect(fs.existsSync(f.lock)).toBe(false);
    } finally { sleeper.kill(); }
  });

  it("treats a run admitted a moment ago as in flight even before its runner exists", () => {
    runStatus(f, "00000000-0000-4000-8000-000000000002", { state: "starting" });
    expect(run(f, "codex", "0.156.1").doc).toMatchObject({ state: "deferred" });
  });

  it("does not wait on a run whose runner is gone or which finished", () => {
    runStatus(f, "00000000-0000-4000-8000-000000000003", { state: "running", runnerPid: 2147483646 });
    runStatus(f, "00000000-0000-4000-8000-000000000004", { state: "finished", runnerPid: process.pid });
    expect(run(f, "codex", "0.156.1").doc).toMatchObject({ state: "done" });
  });

  it("puts the previous version back when the new one does not install", () => {
    const result = run(f, "codex", "0.156.1", { FAKE_NPM_INSTALL_EXIT: "1" });
    expect(result.status).toBe(1);
    expect(result.doc).toMatchObject({ state: "rolled_back", reason: "install_failed", from: "0.149.1" });
    expect(version(path.join(f.home, ".npm-global", "bin", "codex"))).toBe("codex-cli 0.149.1");
    expect(fs.existsSync(f.lock)).toBe(false);
  });

  it("puts the previous version back when the installed binary reports another version", () => {
    const result = run(f, "claude", "2.1.281", { FAKE_NPM_REPORTS: "2.1.999" });
    expect(result.doc).toMatchObject({ state: "rolled_back" });
    expect(version(path.join(f.system, "bin", "claude"))).toBe("2.1.246 (Claude Code)");
  });

  it("stops before the swap when the download fails", () => {
    const result = run(f, "codex", "0.156.1", { FAKE_NPM_CACHE_EXIT: "1" });
    expect(result.status).toBe(1);
    expect(result.doc).toMatchObject({ state: "failed", reason: "download_failed" });
    expect(result.log.some(line => line.includes(" install "))).toBe(false);
    expect(version(path.join(f.home, ".npm-global", "bin", "codex"))).toBe("codex-cli 0.149.1");
  });

  it("finishes a swap cut short by putting its backup back first", () => {
    const backup = path.join(f.home, ".hivra", "agent-cli-backup");
    fs.mkdirSync(backup, { recursive: true });
    fs.cpSync(path.join(f.home, ".npm-global", "lib", "node_modules", "@openai", "codex"), path.join(backup, "package"), { recursive: true });
    // The interrupted install left a broken package behind.
    fs.rmSync(path.join(f.home, ".npm-global", "lib", "node_modules", "@openai", "codex"), { recursive: true });
    const result = run(f, "codex", "0.149.1");
    expect(result.doc).toMatchObject({ state: "done", from: "0.149.1" });
    expect(version(path.join(f.home, ".npm-global", "bin", "codex"))).toBe("codex-cli 0.149.1");
    expect(fs.existsSync(backup)).toBe(false);
  });

  it.each([["gemini", "1.0.0"], ["codex", "latest"], ["codex", "1.0.0;id"], ["", ""]])("refuses %s %s", (kind, target) => {
    const result = run(f, kind, target);
    expect(result.status).toBe(64);
    expect(result.log).toEqual([]);
  });
});
