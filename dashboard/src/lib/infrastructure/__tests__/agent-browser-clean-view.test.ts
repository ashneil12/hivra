/** @jest-environment node */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The Browser tab streams the agent's own Chrome, so it has to open without
// Chrome's warnings: no unsupported-flag infobar (the keeper once passed
// --no-sandbox), no "Can't update Chrome" bubble or "Finish update" chip (the
// pinned build passes Chrome's eight-week outdated-build threshold, and an apt
// upgrade would replace the binary under the running browser). New computers get
// the fix from the installer; existing ones from the runtime update's guest half,
// which these tests run for real against a sandboxed root and fake commands.
// Because Chrome is held on its pin, moving the pin is deliberate: chrome-pin.json
// is the one file the installer and the runtime update both read.

const bundle = path.join(process.cwd(), "provisioner");
const read = (name: string) => readFileSync(path.join(bundle, name), "utf8");
const KEEPER = read("local-browser-keeper.py");
const INSTALLER = read("provision-claude-code-box.sh");
const GUEST = read("hivra-guest-runtime-update.sh");
const HOST = read("hivra-update-guest-runtime.sh");
const PIN_FILE = read("chrome-pin.json");
const PIN = JSON.parse(PIN_FILE) as { version: string; sha256: string; previous: { version: string; sha256: string }[] };

// Policies Chrome documents (chromeenterprise.google/policies); each only turns off
// a prompt. None changes the sandbox, site isolation or remote debugging.
const POLICY = { DefaultBrowserSettingEnabled: false, PromotionsEnabled: false, BrowserSignin: 0, SuppressUnsupportedOSWarning: true };
// A sample of Chrome's kBadFlags (chrome/browser/ui/startup/bad_flags_prompt.cc, checked
// against 157.0.8103.50, which added the Landlock and WebNN compiler sandbox switches).
const BAD_FLAGS = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu-sandbox", "--disable-seccomp-filter-sandbox",
  "--disable-landlock-sandbox", "--disable-webnn-compiler-sandbox",
  "--disable-web-security", "--single-process", "--ignore-certificate-errors", "--host-resolver-rules", "--disable-site-isolation-trials"];

const policyOf = (source: string) => {
  const match = source.match(/^\s*CHROME_POLICY_JSON='([^']+)'$/m);
  expect(match).not.toBeNull();
  return match![1];
};

describe("agent browser view", () => {
  it("launches Chrome sandboxed, with none of the flags Chrome warns about, on a plain start page", () => {
    const args = KEEPER.slice(KEEPER.indexOf("CHROME_ARGS = "), KEEPER.indexOf("\nproc = None"));
    for (const flag of BAD_FLAGS) expect(args).not.toContain(`"${flag}`);
    expect(args).toContain('"--hide-crash-restore-bubble"');
    expect(args).toContain('"--window-position=0,0"');
    expect(args).toContain('"about:blank"');
    expect(args).not.toContain("--test-type");
  });

  it("writes the same documented, prompt-only managed policy in the installer and the runtime update", () => {
    expect(JSON.parse(policyOf(INSTALLER))).toEqual(POLICY);
    expect(policyOf(GUEST)).toBe(policyOf(INSTALLER));
    for (const source of [INSTALLER, GUEST]) {
      expect(source).toContain("/etc/opt/chrome/policies/managed");
      expect(source).not.toMatch(/--test-type|--disable-background-networking/);
    }
  });

  it("keeps Chrome on its pinned build before and after the .deb installs", () => {
    const step = INSTALLER.slice(INSTALLER.indexOf('say "3/7  Google Chrome'), INSTALLER.indexOf('say "4/7'));
    const order = ['repo_add_once="false"', "apt-mark unhold google-chrome-stable", 'apt_get install -y "$CHROME_TMP"',
      "rm -f /etc/apt/sources.list.d/google-chrome.sources", "apt-mark hold google-chrome-stable"].map(text => step.indexOf(text));
    expect(order.every(index => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("carries the keeper to existing computers through both halves of the runtime update", () => {
    expect(HOST).toMatch(/TERMINAL_ASSETS=\([^)]*\blocal-browser-keeper\.py\b[^)]*\)/);
    expect(GUEST).toContain("local-browser-keeper.py");
    expect(GUEST.indexOf("agent_browser_refresh || true")).toBeGreaterThan(GUEST.indexOf("COMMITTED=1"));
    expect(readFileSync(path.join(process.cwd(), "src/lib/hivra/provider-runtime-update.ts"), "utf8")).toContain('"local-browser-keeper.py"');
  });
});

// The installer and the runtime update move Chrome to one pin, read from one shipped file.
describe("Chrome pin", () => {
  const bashOutput = (script: string) => {
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 30_000 });
    expect(result.status).toBe(0);
    return result.stdout.trim();
  };
  const functionOf = (source: string, name: string) => {
    const start = source.indexOf(`${name}() {\n`);
    expect(start).toBeGreaterThanOrEqual(0);
    return source.slice(start, source.indexOf("\n}\n", start) + 3);
  };

  it("is a Chrome .deb version and SHA-256, with the build it replaced kept for recovery", () => {
    expect(PIN.version).toMatch(/^[0-9]+(\.[0-9]+){3}-1$/);
    expect(PIN.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(PIN.version.split(".")[0])).toBeGreaterThanOrEqual(157);
    expect(PIN.previous.map(entry => entry.version)).toContain("152.0.7977.64-1");
    for (const entry of PIN.previous) {
      expect(entry.version).toMatch(/^[0-9]+(\.[0-9]+){3}-1$/);
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.version).not.toBe(PIN.version);
    }
  });

  it("is read by the installer and by the runtime update from the same file, with the same answer", () => {
    // Neither script carries a Chrome version of its own.
    for (const source of [INSTALLER, GUEST]) expect(source).not.toMatch(/\b1[0-9]{2}\.0\.[0-9]{4}\.[0-9]+-1\b/);
    expect(INSTALLER).toContain('"$SRC_DIR/chrome-pin.json"');
    expect(GUEST).toContain('"$WORK/chrome-pin.json"');
    const dir = mkdtempSync(path.join(tmpdir(), "chrome-pin-"));
    try {
      const fromInstaller = bashOutput(`SRC_DIR=${bundle}\n${functionOf(INSTALLER, "read_chrome_pin")}\nread_chrome_pin`);
      const fromUpdater = bashOutput(`WORK=${bundle}\nHIVRA_UNUSED=1\n${functionOf(GUEST, "chrome_pin")}\nchrome_pin`);
      expect(fromInstaller).toBe(`${PIN.version} ${PIN.sha256}`);
      expect(fromUpdater).toBe(fromInstaller);
      // A malformed pin is refused by both.
      writeFileSync(path.join(dir, "chrome-pin.json"), JSON.stringify({ version: "157.0.8103.50", sha256: "abc" }));
      for (const script of [`SRC_DIR=${dir}\n${functionOf(INSTALLER, "read_chrome_pin")}\nread_chrome_pin`,
        `WORK=${dir}\n${functionOf(GUEST, "chrome_pin")}\nchrome_pin`]) {
        expect(spawnSync("bash", ["-c", script], { encoding: "utf8" }).status).not.toBe(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ships to existing computers beside the keeper, in both halves of the runtime update", () => {
    expect(HOST).toMatch(/TERMINAL_ASSETS=\([^)]*\bchrome-pin\.json\b[^)]*\)/);
    expect(readFileSync(path.join(process.cwd(), "src/lib/hivra/provider-runtime-update.ts"), "utf8")).toContain('"chrome-pin.json"');
    expect(readFileSync(path.join(process.cwd(), "src/lib/infrastructure/portable-provisioner-contract.ts"), "utf8")).toContain('"chrome-pin.json"');
  });

  it("is installed from the pool over https and checked before apt sees it, in the installer and the update", () => {
    const flags = "--fail --location --proto '=https' --tlsv1.2 --retry 3 --retry-connrefused --retry-delay 3";
    const step = INSTALLER.slice(INSTALLER.indexOf('say "3/7  Google Chrome'), INSTALLER.indexOf('say "4/7'));
    expect(step).toContain(`curl ${flags}`);
    expect(GUEST).toContain(`curl ${flags}`);
    expect(INSTALLER).toContain("https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${CHROME_VERSION}_amd64.deb");
    const upgrade = GUEST.slice(GUEST.indexOf("chrome_upgrade() {"));
    expect(upgrade.indexOf("chrome_fetch")).toBeLessThan(upgrade.indexOf("chrome_install \"$new\""));
    expect(upgrade.indexOf("chrome_recovery_copy")).toBeLessThan(upgrade.indexOf("chrome_install \"$new\""));
    expect(GUEST).toContain("sha256sum -c -");
  });
});

// The guest half's browser step, run for real with its fixed root paths moved
// under a sandbox and only the system commands it calls replaced. The fakes keep
// state (the installed Chrome version, whether the package is held, how often the
// debugging port was looked at) so the tests can check what a computer ends up with.
const BLOCK = GUEST.slice(GUEST.indexOf("BROWSER_KEEPER=/opt/bux/local-browser-keeper.py"), GUEST.indexOf("agent_browser_refresh || true") + "agent_browser_refresh || true".length);
const NEW = "157.0.8103.50-1";
const OLD = "152.0.7977.64-1";
const ANCIENT = "150.0.7900.10-1";
const debOf = (version: string) => `deb:${version}\n`;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const FAKE_PIN = { version: NEW, sha256: sha(debOf(NEW)), previous: [{ version: OLD, sha256: sha(debOf(OLD)) }] };
const FAKES: Record<string, string> = {
  "dpkg-query": 'case "$*" in *Status*) echo "${FAKE_CHROME_STATUS-install ok installed}" ;; *Version*) cat "$FAKE_DIR/installed" ;; esac',
  "apt-mark": 'echo "apt-mark $*" >> "$FAKE_DIR/log"; case "$1" in hold) : > "$FAKE_DIR/held" ;; unhold) rm -f "$FAKE_DIR/held" ;; esac',
  // A held package is refused, as apt does; the version comes from the fake .deb's first line.
  "apt-get": 'echo "apt-get $*" >> "$FAKE_DIR/log"; deb="${@: -1}"; version="$(sed -n "1s/^deb://p" "$deb")"; [ -n "$version" ] || exit 100; ' +
    '[ ! -e "$FAKE_DIR/held" ] || exit 100; [ "${FAKE_APT_FAIL:-0}" = 0 ] || [ "$version" != "$FAKE_PINNED" ] || exit 100; printf "%s" "$version" > "$FAKE_DIR/installed"',
  dpkg: 'echo "dpkg $*" >> "$FAKE_DIR/log"',
  "dpkg-deb": '[ "$1" = -f ] && sed -n "1s/^deb://p" "$2"',
  df: 'printf "Filesystem 1024-blocks Used Available Capacity Mounted on\\nfake 9999999 1 %s 1%% /\\n" "${FAKE_AVAIL_KB:-9000000}"',
  systemctl: 'echo "systemctl $*" >> "$FAKE_DIR/log"; [ "$1" != is-active ] || [ "${FAKE_ACTIVE:-1}" = 1 ]',
  ss: 'n="$(cat "$FAKE_DIR/ss-count" 2>/dev/null || echo 0)"; echo $((n + 1)) > "$FAKE_DIR/ss-count"; [ "${FAKE_SS_FAIL:-0}" = 0 ] || exit 1; ' +
    '[ -z "${FAKE_SS_FROM_CALL:-}" ] || [ "$((n + 1))" -lt "$FAKE_SS_FROM_CALL" ] || { printf "ESTAB 0 0 127.0.0.1:9333 127.0.0.1:50000\\n"; exit 0; }; printf "%s" "${FAKE_SS-}"',
  curl: 'out=""; url=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; http*) url="$1"; shift ;; *) shift ;; esac; done; ' +
    'case "$url" in *google-chrome-stable_*_amd64.deb) echo "curl $url" >> "$FAKE_DIR/log"; case "$url" in *"${FAKE_DOWNLOAD_FAIL:-no-such-build}"*) exit 22 ;; esac; ' +
    'v="${url##*stable_}"; v="${v%_amd64.deb}"; if [ "${FAKE_TAMPER:-0}" = 1 ]; then printf tampered > "$out"; else printf "deb:%s\\n" "$v" > "$out"; fi ;; ' +
    '*) installed="$(cat "$FAKE_DIR/installed")"; [ "${FAKE_CDP_UP:-1}" = 1 ] || exit 7; [ "${FAKE_NEW_BROKEN:-0}" = 0 ] || [ "$installed" != "$FAKE_PINNED" ] || exit 7; ' +
    '[ "$out" = /dev/null ] || printf "{\\"Browser\\":\\"Chrome/%s.0.0.0\\"}" "${installed%%.*}" ;; esac',
  "google-chrome-stable": 'echo "Google Chrome $(cat "$FAKE_DIR/installed") "',
  pgrep: '[ "${FAKE_LEGACY:-0}" = 1 ]',
  sleep: "exit 0",
  // The sandbox is not root and has no bux account.
  install: 'args=(); while [ $# -gt 0 ]; do case "$1" in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac; done; exec /usr/bin/install "${args[@]}"',
};
const REPACK = 'v="$(cat "$FAKE_DIR/installed")"; echo "dpkg-repack $*" >> "$FAKE_DIR/log"; printf "deb:%s\\n" "$v" > "google-chrome-stable_${v}_amd64.deb"';
const PREVIOUS_KEEPER = '#!/usr/bin/env python3\nCHROME_ARGS = ["--no-sandbox"]\n';

function run(options: {
  unit?: boolean; env?: Record<string, string>; keeper?: string; policy?: boolean;
  installed?: string; repack?: boolean; pin?: boolean;
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "browser-view-"));
  try {
    for (const dir of ["bin", "etc/systemd/system", "etc/default", "etc/apt/sources.list.d", "opt/bux", "work", "fake"]) mkdirSync(path.join(root, dir), { recursive: true });
    const fakes = options.repack ? { ...FAKES, "dpkg-repack": REPACK } : FAKES;
    for (const [name, body] of Object.entries(fakes)) {
      writeFileSync(path.join(root, "bin", name), `#!/usr/bin/env bash\n${body}\n`);
      chmodSync(path.join(root, "bin", name), 0o755);
    }
    // A computer that already runs the pin, unless a test installs an older build.
    writeFileSync(path.join(root, "fake/installed"), options.installed ?? NEW);
    writeFileSync(path.join(root, "fake/held"), "");
    if (options.unit !== false) {
      writeFileSync(path.join(root, "etc/systemd/system/bux-local-browser.service"), "[Service]\nEnvironment=BUX_LOCAL_CDP_PORT=9333\n");
      writeFileSync(path.join(root, "opt/bux/local-browser-keeper.py"), options.keeper ?? PREVIOUS_KEEPER);
    }
    if (options.policy) {
      mkdirSync(path.join(root, "etc/opt/chrome/policies/managed"), { recursive: true });
      writeFileSync(path.join(root, "etc/opt/chrome/policies/managed/hivra-browser.json"), `${JSON.stringify(POLICY)}\n`);
    }
    writeFileSync(path.join(root, "etc/apt/sources.list.d/google-chrome.sources"), "Types: deb\n");
    writeFileSync(path.join(root, "work/local-browser-keeper.py"), KEEPER);
    if (options.pin !== false) writeFileSync(path.join(root, "work/chrome-pin.json"), JSON.stringify(FAKE_PIN));
    const script = `set -euo pipefail\nWORK=${root}/work\n${BLOCK.replace(/(?<=[=\s"'])\/(etc|opt)\//g, `${root}/$1/`)}\n`;
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8", timeout: 30_000,
      env: { ...process.env, PATH: `${root}/bin:/usr/bin:/bin`, FAKE_DIR: path.join(root, "fake"), FAKE_LEGACY: "0", FAKE_PINNED: NEW, ...options.env },
    });
    const file = (name: string) => (existsSync(path.join(root, name)) ? readFileSync(path.join(root, name), "utf8") : null);
    return {
      status: result.status, stdout: result.stdout, stderr: result.stderr,
      log: file("fake/log") ?? "", keeper: file("opt/bux/local-browser-keeper.py"),
      policy: file("etc/opt/chrome/policies/managed/hivra-browser.json"), defaults: file("etc/default/google-chrome"),
      source: file("etc/apt/sources.list.d/google-chrome.sources"),
      installed: file("fake/installed"), held: existsSync(path.join(root, "fake/held")),
      lines: (file("fake/log") ?? "").split("\n").filter(Boolean),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("runtime update of the agent browser", () => {
  it("replaces the legacy keeper, writes the policy, freezes Chrome and restarts an idle browser", () => {
    const result = run({ env: { FAKE_LEGACY: "1" } });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("HIVRA_AGENT_BROWSER state=restarted\n");
    expect(result.keeper).toBe(KEEPER);
    expect(JSON.parse(result.policy!)).toEqual(POLICY);
    expect(result.defaults).toBe('repo_add_once="false"\nrepo_reenable_on_distupgrade="false"\n');
    expect(result.source).toBeNull();
    expect(result.log).toContain("apt-mark hold google-chrome-stable");
    expect(result.log).toContain("systemctl restart bux-local-browser.service");
    // Chrome was already on the pin: no download, no apt install.
    expect(result.log).not.toMatch(/apt-get|curl/);
  });

  it("installs but defers the restart while an agent is attached to the debugging port", () => {
    const result = run({ env: { FAKE_LEGACY: "1", FAKE_SS: "ESTAB 0 0 127.0.0.1:9333 127.0.0.1:50000\n" } });
    expect(result.stdout).toBe("HIVRA_AGENT_BROWSER state=deferred\n");
    expect(result.keeper).toBe(KEEPER);
    expect(result.policy).not.toBeNull();
    expect(result.log).not.toContain("restart");
  });

  it("puts the previous keeper back when the browser does not return", () => {
    const result = run({ env: { FAKE_LEGACY: "1", FAKE_CDP_UP: "0" } });
    expect(result.stdout).toBe("HIVRA_AGENT_BROWSER state=restored\n");
    expect(result.keeper).toBe(PREVIOUS_KEEPER);
    expect(result.log.match(/systemctl restart bux-local-browser\.service/g)).toHaveLength(2);
  });

  it("restarts nothing when the browser is off and Chrome is on the pin, and does nothing without a browser unit", () => {
    expect(run({ env: { FAKE_ACTIVE: "0" } }).stdout).toBe("HIVRA_AGENT_BROWSER state=installed\n");
    const none = run({ unit: false, installed: OLD });
    expect(none.stdout).toBe("");
    expect(none.policy).toBeNull();
    expect(none.log).toBe("");
    expect(none.installed).toBe(OLD);
  });

  it("leaves a computer that already runs this release and the pinned Chrome alone", () => {
    const result = run({ keeper: KEEPER, policy: true });
    expect(result.stdout).toBe("HIVRA_AGENT_BROWSER state=current\n");
    expect(result.log).not.toMatch(/restart|apt-get|curl|dpkg/);
    expect(result.installed).toBe(NEW);
    expect(result.held).toBe(true);
  });

  it("still restarts a browser that runs with --no-sandbox although its files already match", () => {
    expect(run({ keeper: KEEPER, policy: true, env: { FAKE_LEGACY: "1" } }).stdout).toBe("HIVRA_AGENT_BROWSER state=restarted\n");
  });
});

describe("runtime update moves Chrome to the pin", () => {
  const index = (lines: string[], text: string) => lines.findIndex(line => line.includes(text));

  it("upgrades an idle browser: verified download, unhold, apt install, frozen again, restart, version checked", () => {
    const result = run({ keeper: KEEPER, policy: true, installed: OLD });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("HIVRA_AGENT_BROWSER state=upgraded\n");
    expect(result.installed).toBe(NEW);
    expect(result.held).toBe(true);
    expect(result.source).toBeNull();
    const { lines } = result;
    // The pinned .deb comes from Google's pool over https; the previous build's own .deb is the recovery copy.
    expect(lines).toContain(`curl https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${NEW}_amd64.deb`);
    expect(lines).toContain(`curl https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${OLD}_amd64.deb`);
    const unhold = index(lines, "apt-mark unhold google-chrome-stable");
    const install = index(lines, "apt-get ");
    const hold = lines.map((line, i) => (line === "apt-mark hold google-chrome-stable" ? i : -1)).filter(i => i > install);
    const restart = index(lines, "systemctl restart bux-local-browser.service");
    expect(unhold).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThan(unhold);
    expect(hold.length).toBeGreaterThan(0);
    expect(restart).toBeGreaterThan(hold[0]);
    expect(lines.filter(line => line.startsWith("apt-get "))).toHaveLength(1);
    expect(lines[install]).toMatch(/apt-get .*install -y --allow-downgrades .*chrome-pinned\.deb$/);
    // One restart, after the install: never a running Chrome whose binary changed.
    expect(lines.filter(line => line.includes("systemctl restart"))).toHaveLength(1);
    expect(result.keeper).toBe(KEEPER);
  });

  it("takes the keeper and the pinned Chrome in one restart when both are out of date", () => {
    const result = run({ installed: OLD, env: { FAKE_LEGACY: "1" } });
    expect(result.stdout).toBe("HIVRA_AGENT_BROWSER state=upgraded\n");
    expect(result.keeper).toBe(KEEPER);
    expect(result.installed).toBe(NEW);
    expect(result.lines.filter(line => line.includes("systemctl restart"))).toHaveLength(1);
  });

  it("upgrades a browser that is switched off without starting it", () => {
    const result = run({ keeper: KEEPER, policy: true, installed: OLD, env: { FAKE_ACTIVE: "0" } });
    expect(result.stdout).toBe("HIVRA_AGENT_BROWSER state=upgraded\n");
    expect(result.installed).toBe(NEW);
    expect(result.held).toBe(true);
    expect(result.log).not.toContain("systemctl restart");
  });

  it("uses dpkg-repack for the recovery copy when it is available, whatever build is installed", () => {
    const result = run({ keeper: KEEPER, policy: true, installed: ANCIENT, repack: true });
    expect(result.stdout).toBe("HIVRA_AGENT_BROWSER state=upgraded\n");
    expect(result.installed).toBe(NEW);
    expect(result.log).toContain("dpkg-repack google-chrome-stable");
    // The previous build was repacked, not downloaded.
    expect(result.log).not.toContain(`stable_${ANCIENT}_amd64.deb`);
  });

  it("defers and leaves Chrome alone while an agent is attached to the debugging port", () => {
    for (const env of [{ FAKE_SS: "ESTAB 0 0 127.0.0.1:9333 127.0.0.1:50000\n" }, { FAKE_SS_FAIL: "1" }] as Record<string, string>[]) {
      const result = run({ keeper: KEEPER, policy: true, installed: OLD, env });
      expect(result.stdout).toBe("HIVRA_AGENT_BROWSER state=deferred\n");
      expect(result.installed).toBe(OLD);
      expect(result.held).toBe(true);
      expect(result.log).not.toMatch(/apt-get|apt-mark unhold|restart|curl/);
    }
  });

  it("looks at the debugging port again right before it replaces Chrome, after the downloads", () => {
    const result = run({ keeper: KEEPER, policy: true, installed: OLD, env: { FAKE_SS_FROM_CALL: "2" } });
    expect(result.stdout).toBe("HIVRA_AGENT_BROWSER state=deferred\n");
    expect(result.installed).toBe(OLD);
    expect(result.held).toBe(true);
    expect(result.log).not.toMatch(/apt-get|apt-mark unhold|restart/);
    expect(result.log).toContain("curl ");
  });

  it("puts the previous Chrome back, and the previous keeper, when the new browser does not answer", () => {
    const result = run({ installed: OLD, env: { FAKE_NEW_BROKEN: "1" } });
    expect(result.stdout).toBe("HIVRA_AGENT_BROWSER state=restored\n");
    expect(result.installed).toBe(OLD);
    expect(result.held).toBe(true);
    expect(result.source).toBeNull();
    expect(result.keeper).toBe(PREVIOUS_KEEPER);
    expect(result.lines.filter(line => line.startsWith("apt-get "))).toHaveLength(2);
    expect(result.lines.filter(line => line.includes("systemctl restart"))).toHaveLength(2);
    expect(result.lines.filter(line => line.startsWith("apt-get ")).pop()).toMatch(/chrome-previous\.deb$/);
  });

  it("restores a repacked build that is not in the pin's list", () => {
    const result = run({ installed: ANCIENT, repack: true, env: { FAKE_NEW_BROKEN: "1" } });
    expect(result.stdout).toBe("HIVRA_AGENT_BROWSER state=restored\n");
    expect(result.installed).toBe(ANCIENT);
    expect(result.held).toBe(true);
  });

  it("restores when apt refuses the pinned build, and reports a build apt never changed as installed", () => {
    const result = run({ installed: OLD, env: { FAKE_APT_FAIL: "1" } });
    expect(result.stdout).toBe("HIVRA_AGENT_BROWSER state=restored\n");
    expect(result.installed).toBe(OLD);
    expect(result.held).toBe(true);
    // Nothing was replaced, so only the one failed install ran.
    expect(result.lines.filter(line => line.startsWith("apt-get "))).toHaveLength(1);
  });

  it("skips the upgrade when no recovery copy can be made: no dpkg-repack and the build is not in the pin's list", () => {
    const result = run({ keeper: KEEPER, policy: true, installed: ANCIENT });
    expect(result.stdout).toBe("HIVRA_AGENT_BROWSER state=deferred\n");
    expect(result.installed).toBe(ANCIENT);
    expect(result.held).toBe(true);
    expect(result.log).not.toMatch(/apt-get|apt-mark unhold|restart|curl/);
    expect(result.stderr).toContain("no way to put");
  });

  it("skips the upgrade when the recovery copy cannot be made after all, or the pinned build cannot be downloaded", () => {
    for (const [fails, message] of [[OLD, "no recovery copy"], [NEW, "could not be downloaded"]]) {
      const result = run({ keeper: KEEPER, policy: true, installed: OLD, env: { FAKE_DOWNLOAD_FAIL: fails } });
      expect(result.stdout).toBe("HIVRA_AGENT_BROWSER state=deferred\n");
      expect(result.installed).toBe(OLD);
      expect(result.held).toBe(true);
      expect(result.log).not.toMatch(/apt-get|apt-mark unhold|restart/);
      expect(result.stderr).toContain(message);
    }
  });

  it("installs nothing that fails its SHA-256", () => {
    const result = run({ keeper: KEEPER, policy: true, installed: OLD, env: { FAKE_TAMPER: "1" } });
    expect(result.stdout).toBe("HIVRA_AGENT_BROWSER state=deferred\n");
    expect(result.installed).toBe(OLD);
    expect(result.held).toBe(true);
    expect(result.log).not.toMatch(/apt-get|apt-mark unhold|restart/);
  });

  it("does not start when the update's time budget or the disk cannot cover an upgrade and its way back", () => {
    for (const env of [{ HIVRA_RUNTIME_UPDATE_SECONDS: "500" }, { FAKE_AVAIL_KB: "1000" }] as Record<string, string>[]) {
      const result = run({ keeper: KEEPER, policy: true, installed: OLD, env });
      expect(result.stdout).toBe("HIVRA_AGENT_BROWSER state=deferred\n");
      expect(result.installed).toBe(OLD);
      expect(result.log).not.toMatch(/apt-get|curl|apt-mark unhold/);
    }
  });

  it("leaves Chrome as installed when the pin file is missing or malformed, and still finishes the keeper step", () => {
    const result = run({ installed: OLD, pin: false, env: { FAKE_LEGACY: "1" } });
    expect(result.stdout).toBe("HIVRA_AGENT_BROWSER state=restarted\n");
    expect(result.installed).toBe(OLD);
    expect(result.stderr).toContain("chrome-pin.json");
    expect(result.log).not.toMatch(/apt-get|curl/);
  });

  it("keeps the committed update untouched: the step runs after the commit, under || true", () => {
    expect(GUEST).toContain("agent_browser_refresh || true");
    expect(GUEST.indexOf("agent_browser_refresh || true")).toBeGreaterThan(GUEST.indexOf("COMMITTED=1"));
    expect(GUEST.indexOf("agent_browser_refresh || true")).toBeLessThan(GUEST.indexOf("HIVRA_GUEST_RUNTIME_UPDATED\\n'", GUEST.indexOf("COMMITTED=1")));
    expect(GUEST).not.toMatch(/--test-type/);
  });
});
