/** @jest-environment node */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const bundle = path.join(process.cwd(), "provisioner");
const installer = () => readFileSync(path.join(bundle, "provision-claude-code-box.sh"), "utf8");
const host = () => readFileSync(path.join(bundle, "hivra-provision-on-host.sh"), "utf8");
const shell = () => readFileSync(path.join(bundle, "hivra-agent-shell"), "utf8");

describe("portable native terminal setup", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "hivra-native-terminal-test-"));
    mkdirSync(path.join(root, ".hivra"));
    mkdirSync(path.join(root, "bin"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    expect(existsSync(root)).toBe(false);
  });
  function run(kind: string | null, commands: string[] = ["claude", "codex"], args: string[] = []) {
    if (kind !== null) writeFileSync(path.join(root, ".hivra/agent-kind"), kind + "\n");
    for (const name of commands) {
      const file = path.join(root, "bin", name);
      writeFileSync(file, `#!/bin/sh\nprintf 'CLI ${name}\\n'\nprintf '<%s>\\n' "$@"\n`);
      chmodSync(file, 0o700);
    }
    // A dashboard runtime opens its own user's login shell, never a coding CLI.
    writeFileSync(path.join(root, ".bash_profile"), "printf 'BOX_SHELL\\n'\nexit 0\n");
    return spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", shell(), "hivra-agent-shell", ...args], {
      input: "", encoding: "utf8", timeout: 3_000,
      // A login shell reads the runner's /etc/profile before this fixture's
      // .bash_profile. Keep fixture CLIs first, but retain the minimal system
      // PATH that a real guest login has so distro profiles can call id/grep.
      env: { HOME: root, PATH: `${path.join(root, "bin")}:/usr/bin:/bin`, NODE_ENV: "test", ...managedBins() },
    });
  }
  // The shell runs the gateway's exact binaries (server.js CLAUDE_BIN/CODEX_BIN);
  // the fixtures stand in for /usr/bin/claude and ~/.npm-global/bin/codex.
  const managedBins = () => ({ CLAUDE_BIN: path.join(root, "bin", "claude"), CODEX_BIN: path.join(root, "bin", "codex") });
  it.each(["claude", "codex"])("executes the selected %s CLI with literal arguments", kind => {
    const result = run(kind, ["claude", "codex"], ["two words", "$(do-not-run)", "--flag"]);
    expect(result).toMatchObject({ status: 0, stdout: `CLI ${kind}\n<two words>\n<$(do-not-run)>\n<--flag>\n`, stderr: "" });
  });
  it.each(["claude", "codex"])("does not replace a missing %s CLI with another agent", kind => {
    const result = run(kind, [kind === "codex" ? "claude" : "codex"]);
    expect(result.status).toBe(127);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Open the box terminal");
  });
  it.each(["claude", "codex"])("runs the %s binary the chat gateway runs, never a different one earlier on PATH", kind => {
    // A vendor self-install in ~/.npm-global/bin sits ahead of /usr/bin on PATH.
    mkdirSync(path.join(root, "managed"));
    const managed = path.join(root, "managed", kind);
    writeFileSync(managed, `#!/bin/sh\nprintf 'MANAGED ${kind}\\n'\n`);
    chmodSync(managed, 0o700);
    writeFileSync(path.join(root, ".hivra/agent-kind"), kind + "\n");
    for (const name of ["claude", "codex"]) {
      writeFileSync(path.join(root, "bin", name), "#!/bin/sh\nprintf 'PATH COPY\\n'\n");
      chmodSync(path.join(root, "bin", name), 0o700);
    }
    const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", shell(), "hivra-agent-shell", "--version"], {
      input: "", encoding: "utf8", timeout: 3_000,
      env: { HOME: root, PATH: `${path.join(root, "bin")}:/usr/bin:/bin`, NODE_ENV: "test", [kind === "claude" ? "CLAUDE_BIN" : "CODEX_BIN"]: managed },
    });
    expect(result).toMatchObject({ status: 0, stdout: `MANAGED ${kind}\n`, stderr: "" });
  });
  it("finds Codex where the gateway does when no override is set", () => {
    mkdirSync(path.join(root, ".npm-global", "bin"), { recursive: true });
    writeFileSync(path.join(root, ".npm-global", "bin", "codex"), "#!/bin/sh\nprintf 'OWNER CODEX\\n'\n");
    chmodSync(path.join(root, ".npm-global", "bin", "codex"), 0o700);
    writeFileSync(path.join(root, ".hivra/agent-kind"), "codex\n");
    const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", shell(), "hivra-agent-shell", "x"], {
      input: "", encoding: "utf8", timeout: 3_000, env: { HOME: root, PATH: "/usr/bin:/bin", NODE_ENV: "test" },
    });
    expect(result).toMatchObject({ status: 0, stdout: "OWNER CODEX\n", stderr: "" });
  });
  it("never lets Claude stand in for a Codex computer whose Codex is missing", () => {
    // The exact regression: codex absent where the gateway runs it, claude present.
    const result = run("codex", ["claude"]);
    expect(result.status).toBe(127);
    expect(result.stdout).not.toContain("CLI claude");
    expect(result.stderr).toContain("The selected agent runtime is unavailable");
  });
  it.each(["aeon", "openclaw", "agent-zero", "linux-desktop"])("opens a login shell for the %s dashboard or computer runtime", kind => {
    expect(run(kind)).toMatchObject({ status: 0, stdout: "BOX_SHELL\n", stderr: "" });
  });
  it.each([null, "", "unknown", "codex\nclaude"])("rejects unconfigured or invalid selection %s", kind => {
    const result = run(kind);
    expect(result.status).toBe(78);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("agent runtime");
  });
  // ttyd starts the shell on a pseudo-terminal with no arguments. Drive it the
  // same way (python's pty) with only fixture commands on PATH.
  function runInTerminal(kind: string, commands: string[], args: string[] = []) {
    writeFileSync(path.join(root, ".hivra/agent-kind"), kind + "\n");
    for (const name of commands) {
      const file = path.join(root, "bin", name);
      writeFileSync(file, `#!/bin/sh\nprintf '${name.toUpperCase()}\\n'\nprintf '<%s>\\n' "$@"\n`);
      chmodSync(file, 0o700);
    }
    const python = spawnSync("/bin/sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
    const driver = [
      "import os, sys",
      "pid, fd = os.forkpty()",
      "if pid == 0: os.execv(sys.argv[1], sys.argv[1:])",
      "out = b''",
      "while True:",
      "  try: chunk = os.read(fd, 4096)",
      "  except OSError: break",
      "  if not chunk: break",
      "  out += chunk",
      "sys.stdout.write(out.decode())",
      "sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))",
    ].join("\n");
    const result = spawnSync(python, ["-c", driver, "/bin/bash", "--noprofile", "--norc", "-c", shell(), "hivra-agent-shell", ...args], {
      encoding: "utf8", timeout: 5_000, env: { HOME: root, PATH: path.join(root, "bin"), NODE_ENV: "test", ...managedBins() },
    });
    return { status: result.status, lines: result.stdout.replace(/\r/g, "").split("\n").filter(Boolean) };
  }
  const tmuxArgv = (lines: string[]) => lines.slice(1).map(line => line.slice(1, -1));
  it.each(["claude", "codex"])("keeps the interactive %s terminal in a persistent tmux session that a closed tab only detaches", kind => {
    for (const [args, session] of [[[], "agent-1"], [["--agent-terminal"], "agent-1"], [["--agent-terminal", "4"], "agent-4"]] as const) {
      const { status, lines } = runInTerminal(kind, ["claude", "codex", "tmux"], [...args]);
      expect(status).toBe(0);
      expect(lines[0]).toBe("TMUX");
      const argv = tmuxArgv(lines);
      // Private socket, no user config, and attach-or-create the tab's session.
      expect(argv.slice(0, 5)).toEqual(["-L", "hivra-agent", "-f", "/dev/null", "start-server"]);
      expect(argv.slice(-5)).toEqual(["new-session", "-A", "-s", session, path.join(root, "bin", kind)]);
      for (const option of [["status", "off"], ["mouse", "on"], ["escape-time", "10"]]) {
        expect(argv.join(" ")).toContain(`set-option -g ${option.join(" ")} ;`);
      }
    }
  });
  it.each(["claude", "aeon", "openclaw", "agent-zero", "linux-desktop"])("keeps every Box Terminal tab on %s computers in its own persistent login shell", kind => {
    const { status, lines } = runInTerminal(kind, ["claude", "codex", "tmux"], ["--box-terminal", "3"]);
    expect(status).toBe(0);
    const argv = tmuxArgv(lines);
    expect(argv.slice(0, 5)).toEqual(["-L", "hivra-box", "-f", "/dev/null", "start-server"]);
    // No command: tmux starts the owner's login shell.
    expect(argv.slice(-4)).toEqual(["new-session", "-A", "-s", "box-3"]);
  });
  it.each(["aeon", "openclaw", "agent-zero", "linux-desktop"])("keeps the %s agent terminal shell in a persistent session too", kind => {
    const argv = tmuxArgv(runInTerminal(kind, ["tmux"], ["--agent-terminal", "2"]).lines);
    expect(argv.slice(0, 2)).toEqual(["-L", "hivra-agent"]);
    expect(argv.slice(-4)).toEqual(["new-session", "-A", "-s", "agent-2"]);
  });
  it.each([["--box-terminal", "9"], ["--box-terminal", "1;id"], ["--agent-terminal", "--x"], ["--box-terminal", "1", "2"]])("refuses a terminal session slot the dashboard cannot send: %s %s", (...args) => {
    const { status, lines } = runInTerminal("claude", ["claude", "codex", "tmux"], args);
    expect(status).toBe(64);
    expect(lines.join("\n")).not.toContain("TMUX");
  });
  it("runs the CLI directly when tmux is not installed", () => {
    const { status, lines } = runInTerminal("claude", ["claude", "codex"]);
    expect(status).toBe(0);
    // The fixture prints "<>" once when it receives no arguments.
    expect(lines).toEqual(["CLAUDE", "<>"]);
  });
  it("owns native setup in the shared guest installer, with no Proxmox-only second pass", () => {
    expect(installer()).toContain("install_native_terminals()");
    expect(installer()).toContain("start_native_terminals()");
    expect(installer()).toContain("verify_native_terminals()");
    expect(host()).not.toContain('log "configuring terminals');
    expect(host()).not.toContain("/usr/local/bin/hivra-agent-shell");
    for (const asset of ["hivra-agent-shell", "bux-ttyd-base-path.conf", "bux-box-ttyd.service"]) {
      expect(installer()).toContain(asset);
    }
  });
  it("runs both terminal services as the agent user on owner-only unix sockets (no loopback port)", () => {
    for (const [file, socket, base] of [
      ["bux-ttyd-base-path.conf", "/run/hivra-terminal/ttyd.sock", "/terminal"],
      ["bux-box-ttyd.service", "/run/hivra-box-terminal/ttyd.sock", "/box-terminal"],
    ]) {
      const unit = readFileSync(path.join(bundle, file), "utf8");
      expect(unit).toContain("User=bux\nGroup=bux\n");
      expect(unit).toContain("WorkingDirectory=/home/bux\n");
      expect(unit).toContain("Environment=HOME=/home/bux\n");
      expect(unit).toContain("Environment=PATH=/home/bux/.npm-global/bin:/home/bux/.bun/bin:/home/bux/.local/bin:/usr/local/bin:/usr/bin:/bin\n");
      // Hivra owns CLI versions; a vendor self-update never runs from a terminal.
      expect(unit).toContain("Environment=DISABLE_AUTOUPDATER=1\n");
      // A bux-owned 0700 runtime folder, so no other local user or service can open a shell as bux.
      expect(unit).toMatch(/RuntimeDirectory=hivra-(box-)?terminal\nRuntimeDirectoryMode=0700\n/);
      expect(unit).toContain(`ExecStart=/usr/local/bin/ttyd -i ${socket} -b ${base} -a -W /usr/local/bin/hivra-agent-shell --${base === "/box-terminal" ? "box" : "agent"}-terminal\n`);
      expect(unit).not.toContain("-p 768");
      // A ttyd restart must leave the persistent sessions running.
      expect(unit).toContain("KillMode=process\n");
    }
  });
  it("moves only the Linux Desktop terminal profile into the shared Hivra workspace", () => {
    const text = installer();
    expect(text).toContain('if [ "${AGENT_KIND:-}" = "linux-desktop" ]; then');
    expect(text).toContain("sed -i 's#^WorkingDirectory=.*#WorkingDirectory=/home/bux/Hivra#'");
    expect(text).toContain("/etc/systemd/system/bux-ttyd.service.d/base-path.conf");
    expect(text).toContain("/etc/systemd/system/bux-box-ttyd.service");
  });
  function helper(name: string) {
    const text = installer(), start = text.indexOf(`${name}() {`), end = text.indexOf("\n}", start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    return text.slice(start, end + 2);
  }
  function executeHelper(name: string, fixture: string) {
    // Exercise the exact function; all OS mutation and readiness commands are
    // intercepted. No package, service, root path or network is touched.
    return spawnSync("/bin/bash", ["--noprofile", "--norc", "-s"], {
      input: `set -euo pipefail\nSRC_DIR=/fixture\ndie() { printf '%s\\n' "$*" >&2; exit 1; }\n${fixture}\n${helper(name)}\n${name}\nprintf 'DONE\\n'\n`,
      encoding: "utf8", timeout: 3_000, env: { PATH: "/usr/bin:/bin", NODE_ENV: "test" },
    });
  }
  it("installs the fixed helper and units with explicit root ownership and modes", () => {
    const result = executeHelper("install_native_terminals", `
function [ { case "$1:$2" in '-x:/usr/local/bin/ttyd') return 0;; esac; builtin [ "$@"; }
install() { printf 'INSTALL %s\\n' "$*"; }
`);
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toBe([
      "INSTALL -o root -g root -m 0755 /fixture/hivra-agent-shell /usr/local/bin/hivra-agent-shell",
      "INSTALL -d -o root -g root -m 0755 /etc/systemd/system/bux-ttyd.service.d",
      "INSTALL -o root -g root -m 0644 /fixture/bux-ttyd-base-path.conf /etc/systemd/system/bux-ttyd.service.d/base-path.conf",
      "INSTALL -o root -g root -m 0644 /fixture/bux-box-ttyd.service /etc/systemd/system/bux-box-ttyd.service",
      "DONE", "",
    ].join("\n"));
  });
  it("does not write terminal configuration if ttyd was not installed", () => {
    const result = executeHelper("install_native_terminals", `
function [ { case "$1:$2" in '-x:/usr/local/bin/ttyd') return 1;; esac; builtin [ "$@"; }
install() { printf 'UNEXPECTED_WRITE\\n'; }
`);
    expect(result.status).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toContain("ttyd is missing");
  });
  it.each([1, 2, 3, 4])("does not continue after configuration write %s fails", failure => {
    const result = executeHelper("install_native_terminals", `
function [ { case "$1:$2" in '-x:/usr/local/bin/ttyd') return 0;; esac; builtin [ "$@"; }
calls=0
install() { calls=$((calls+1)); printf 'WRITE %s\\n' "$calls"; [ "$calls" -ne ${failure} ]; }
`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("WRITE 1\n");
    expect(result.stdout.trim().split("\n")).toHaveLength(failure);
    expect(result.stdout).not.toContain("DONE");
  });
  it.each(["enable", "restart"])("propagates terminal service %s failure", failure => {
    const result = executeHelper("start_native_terminals", `systemctl() { printf 'SERVICE %s\\n' "$*"; [ "$1" != '${failure}' ]; }`);
    expect(result.status).not.toBe(0); expect(result.stdout).not.toContain("DONE");
    if (failure === "enable") expect(result.stdout).not.toContain("restart");
  });
  it("checks both native services and their exact owner-only socket HTTP paths", () => {
    const result = executeHelper("verify_native_terminals", `
systemctl() { printf 'SERVICE %s\\n' "$*"; }
wait_for_unix_http_200() { printf 'UNIX %s\\n' "$*"; }
`);
    expect(result).toMatchObject({ status: 0, stderr: "", stdout: [
      "SERVICE is-active --quiet bux-ttyd.service", "SERVICE is-active --quiet bux-box-ttyd.service",
      "UNIX /run/hivra-terminal/ttyd.sock http://localhost/terminal/",
      "UNIX /run/hivra-box-terminal/ttyd.sock http://localhost/box-terminal/", "DONE", "",
    ].join("\n") });
  });
  it.each(["bux-ttyd.service", "bux-box-ttyd.service"])("requires %s even if the other service is active", unit => {
    const result = executeHelper("verify_native_terminals", `
systemctl() { [ "$3" != '${unit}' ]; }
wait_for_exact_http_200() { printf 'UNEXPECTED_HTTP\\n'; }
`);
    expect(result.status).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toContain(unit);
  });
  it.each([
    ["/run/hivra-terminal/ttyd.sock", "http://localhost/terminal/"],
    ["/run/hivra-box-terminal/ttyd.sock", "http://localhost/box-terminal/"],
  ])("rejects a failed %s endpoint", (socket, url) => {
    const result = executeHelper("verify_native_terminals", `
systemctl() { return 0; }
wait_for_unix_http_200() { [ "$1" != '${socket}' ] || [ "$2" != '${url}' ]; }
`);
    expect(result.status).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toContain("readiness check");
  });
  describe("readiness through the gateway", () => {
    // The owner reaches both terminals only through the gateway, which uses a
    // socket only after its own owner and mode checks. Readiness must go the
    // same way: nothing listens on the old loopback ports, so a check made
    // around the gateway would pass while Terminal stayed broken.
    function gatewayCheck(meta: string, codes: Record<string, string>) {
      const dir = mkdtempSync(path.join(tmpdir(), "hivra-gateway-check-"));
      writeFileSync(path.join(dir, "api-token"), "f".repeat(64));
      const result = executeHelper("verify_terminals_through_gateway", `
AGENT_HOME=${dir}; mkdir -p ${dir}/.hivra; cp ${dir}/api-token ${dir}/.hivra/api-token
HIVRA_CHAT_PORT=8080
mktemp() { : > ${dir}/header; printf '%s\n' ${dir}/header; }
sleep() { :; }
# Two tries, not the installer's 30: each try runs python3, and 30 of them can
# outlast the 3 s bound on a loaded machine (the retry itself is still tested).
seq() { printf '%s\n' 1 2; }
curl() {
  printf 'CURL %s\n' "$*" >> ${dir}/calls
  case "$*" in
    *"/api/meta"*) printf '%s' '${meta}' ;;
    *"/box-terminal/"*) printf '%s' '${codes.box}' ;;
    *"/terminal/"*) printf '%s' '${codes.terminal}' ;;
  esac
}
`);
      const calls = existsSync(path.join(dir, "calls")) ? readFileSync(path.join(dir, "calls"), "utf8") : "";
      const headerLeft = existsSync(path.join(dir, "header"));
      rmSync(dir, { recursive: true, force: true });
      return { result, calls, headerLeft };
    }
    const SOCKETS = '{"terminals":{"terminal":"socket","boxTerminal":"socket"}}';
    it("passes only when the gateway reports both sockets and proxies both terminals", () => {
      const { result, calls, headerLeft } = gatewayCheck(SOCKETS, { terminal: "200", box: "200" });
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(result.stdout).toBe("DONE\n");
      expect(calls).toContain("http://127.0.0.1:8080/api/meta");
      expect(calls).toContain("http://127.0.0.1:8080/terminal/");
      expect(calls).toContain("http://127.0.0.1:8080/box-terminal/");
      // The bearer comes from a root-only header file, never the command line.
      expect(calls).toMatch(/-H @\S+\/header/);
      expect(calls).not.toContain("f".repeat(64));
      expect(calls).not.toContain("--unix-socket");
      expect(headerLeft).toBe(false);
    });
    it.each([
      ["the gateway would fall back to the agent terminal's loopback port", '{"terminals":{"terminal":"port","boxTerminal":"socket"}}', "200", "200"],
      ["the gateway would fall back to the computer terminal's loopback port", '{"terminals":{"terminal":"socket","boxTerminal":"port"}}', "200", "200"],
      ["the gateway reports no terminal transport (an older gateway)", '{"agentKind":"codex"}', "200", "200"],
      ["the proxied agent terminal fails", SOCKETS, "502", "200"],
      ["the proxied computer terminal fails", SOCKETS, "200", "502"],
    ])("fails when %s", (_label, meta, terminal, box) => {
      const { result, calls, headerLeft } = gatewayCheck(meta, { terminal, box });
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain("DONE");
      expect(headerLeft).toBe(false);
      // It asked again before giving up.
      expect(calls.split("\n").filter((line) => line.includes("/api/meta"))).toHaveLength(2);
    });
    it("tries the installer's 30 times, 2 seconds apart, before it gives up", () => {
      const body = helper("verify_terminals_through_gateway");
      expect(body).toContain("for _ in $(seq 1 30); do");
      expect(body).toContain("    sleep 2\n  done");
    });
    it("runs in the installer once the gateway answers, and fails the install otherwise", () => {
      const text = installer();
      const health = text.indexOf('ok "hivra-chat answering on 127.0.0.1:${HIVRA_CHAT_PORT}/healthz"');
      const check = text.indexOf("if ! verify_terminals_through_gateway; then");
      expect(health).toBeGreaterThan(0);
      expect(check).toBeGreaterThan(health);
      expect(text.slice(check, check + 400)).toContain('die "terminals did not answer through the gateway on their owner-only sockets"');
    });
    it("is what the guest runtime updater checks after it restarts idle terminals onto their sockets", () => {
      const updater = readFileSync(path.join(bundle, "hivra-update-guest-runtime.sh"), "utf8");
      const restart = updater.indexOf('if [ "$RESTART_AGENT_TTYD" = 1 ] && ! systemctl try-restart bux-ttyd.service; then rollback; exit 1; fi');
      const committed = updater.indexOf("COMMITTED=1");
      const check = updater.slice(restart, committed);
      expect(restart).toBeGreaterThan(0);
      expect(check).toContain(`-H @"$AUTH_HEADER" "http://127.0.0.1:\${CHAT_PORT}/api/meta"`);
      expect(check).toContain(`"http://127.0.0.1:\${CHAT_PORT}/terminal/"`);
      expect(check).toContain(`"http://127.0.0.1:\${CHAT_PORT}/box-terminal/"`);
      expect(check).toContain('then rollback; echo "terminals did not answer through the gateway on their owner-only sockets"');
      // Nothing restarts a terminal someone is connected to (their plain shell
      // would end): only an idle one moves onto its socket now.
      expect(updater).not.toContain("systemctl restart bux-ttyd.service bux-box-ttyd.service");
      // The transport check itself, run: a restarted terminal must be on its
      // socket; one whose restart was deferred may still be on its port.
      const marker = 'HIVRA_AGENT_SOCKET="$RESTART_AGENT_TTYD" HIVRA_BOX_SOCKET="$RESTART_BOX_TTYD" node -e \'';
      const program = check.slice(check.indexOf(marker) + marker.length, check.indexOf("'", check.indexOf(marker) + marker.length));
      const accepts = (terminals: Record<string, string>, agent: string, box: string) => spawnSync(process.execPath, ["-e", program],
        { input: JSON.stringify({ terminals }), env: { ...process.env, HIVRA_AGENT_SOCKET: agent, HIVRA_BOX_SOCKET: box }, encoding: "utf8" }).status === 0;
      expect(accepts({ terminal: "socket", boxTerminal: "socket" }, "1", "1")).toBe(true);
      expect(accepts({ terminal: "port", boxTerminal: "socket" }, "1", "1")).toBe(false);
      expect(accepts({ terminal: "port", boxTerminal: "socket" }, "0", "1")).toBe(true);
      expect(accepts({ terminal: "port", boxTerminal: "port" }, "0", "0")).toBe(true);
      expect(accepts({ terminal: "socket", boxTerminal: "port" }, "0", "1")).toBe(false);
      expect(accepts({}, "0", "0")).toBe(false);
      // No check around the gateway, and the bearer never on a command line.
      expect(updater).not.toContain("--unix-socket");
      expect(updater).not.toMatch(/curl[^\n]*Bearer/);
    });
  });
  it("checks all terminal artifacts before package installation and starts them after daemon reload", () => {
    const text = installer();
    const packageStart = text.indexOf('say "1/7  base packages"');
    for (const asset of ["hivra-agent-shell", "bux-box-ttyd.service", "bux-ttyd-base-path.conf"]) {
      expect(text.slice(0, packageStart)).toContain(asset);
    }
    expect(text).toContain("systemctl daemon-reload\nstart_native_terminals\n");
    expect(text).toContain('\nverify_native_terminals\nif [ "$WANT_BROWSER" = 1 ]; then');
  });
});
