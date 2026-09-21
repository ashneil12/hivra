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
      env: { HOME: root, PATH: `${path.join(root, "bin")}:/usr/bin:/bin`, NODE_ENV: "test" },
    });
  }
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
  it.each(["aeon", "openclaw", "agent-zero", "linux-desktop"])("opens a login shell for the %s dashboard or computer runtime", kind => {
    expect(run(kind)).toMatchObject({ status: 0, stdout: "BOX_SHELL\n", stderr: "" });
  });
  it.each([null, "", "unknown", "codex\nclaude"])("rejects unconfigured or invalid selection %s", kind => {
    const result = run(kind);
    expect(result.status).toBe(78);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("agent runtime");
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
  it("runs both terminal services as the agent user on loopback with working native paths", () => {
    for (const [file, port, base] of [["bux-ttyd-base-path.conf", "7681", "/terminal"], ["bux-box-ttyd.service", "7682", "/box-terminal"]]) {
      const unit = readFileSync(path.join(bundle, file), "utf8");
      expect(unit).toContain("User=bux\nGroup=bux\n");
      expect(unit).toContain("WorkingDirectory=/home/bux\n");
      expect(unit).toContain("Environment=HOME=/home/bux\n");
      expect(unit).toContain("Environment=PATH=/home/bux/.npm-global/bin:/home/bux/.bun/bin:/home/bux/.local/bin:/usr/local/bin:/usr/bin:/bin\n");
      expect(unit).toContain(`ExecStart=/usr/local/bin/ttyd -i lo -p ${port} -b ${base} -W `);
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
  it("checks both native services and their exact loopback HTTP paths", () => {
    const result = executeHelper("verify_native_terminals", `
systemctl() { printf 'SERVICE %s\\n' "$*"; }
wait_for_exact_http_200() { printf 'HTTP %s\\n' "$*"; }
`);
    expect(result).toMatchObject({ status: 0, stderr: "", stdout: [
      "SERVICE is-active --quiet bux-ttyd.service", "SERVICE is-active --quiet bux-box-ttyd.service",
      "HTTP http://127.0.0.1:7681/terminal/", "HTTP http://127.0.0.1:7682/box-terminal/", "DONE", "",
    ].join("\n") });
  });
  it.each(["bux-ttyd.service", "bux-box-ttyd.service"])("requires %s even if the other service is active", unit => {
    const result = executeHelper("verify_native_terminals", `
systemctl() { [ "$3" != '${unit}' ]; }
wait_for_exact_http_200() { printf 'UNEXPECTED_HTTP\\n'; }
`);
    expect(result.status).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toContain(unit);
  });
  it.each(["7681/terminal/", "7682/box-terminal/"])("rejects a failed %s endpoint", endpoint => {
    const result = executeHelper("verify_native_terminals", `
systemctl() { return 0; }
wait_for_exact_http_200() { [ "$1" != 'http://127.0.0.1:${endpoint}' ]; }
`);
    expect(result.status).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toContain("readiness check");
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
