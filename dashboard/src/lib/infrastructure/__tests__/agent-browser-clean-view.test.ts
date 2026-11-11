/** @jest-environment node */

import { spawnSync } from "node:child_process";
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

const bundle = path.join(process.cwd(), "provisioner");
const read = (name: string) => readFileSync(path.join(bundle, name), "utf8");
const KEEPER = read("local-browser-keeper.py");
const INSTALLER = read("provision-claude-code-box.sh");
const GUEST = read("hivra-guest-runtime-update.sh");
const HOST = read("hivra-update-guest-runtime.sh");

// Policies Chrome documents (chromeenterprise.google/policies); each only turns off
// a prompt. None changes the sandbox, site isolation or remote debugging.
const POLICY = { DefaultBrowserSettingEnabled: false, PromotionsEnabled: false, BrowserSignin: 0, SuppressUnsupportedOSWarning: true };
// A sample of Chrome's kBadFlags (chrome/browser/ui/startup/bad_flags_prompt.cc).
const BAD_FLAGS = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu-sandbox", "--disable-seccomp-filter-sandbox",
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
    expect(args).toContain('"about:blank"');
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

// The guest half's browser step, run for real with its fixed root paths moved
// under a sandbox and only the system commands it calls replaced.
const BLOCK = GUEST.slice(GUEST.indexOf("BROWSER_KEEPER=/opt/bux/local-browser-keeper.py"), GUEST.indexOf("agent_browser_refresh || true") + "agent_browser_refresh || true".length);
const FAKES: Record<string, string> = {
  "dpkg-query": 'echo "${FAKE_CHROME_STATUS-install ok installed}"',
  "apt-mark": 'echo "apt-mark $*" >> "$FAKE_DIR/log"',
  systemctl: 'echo "systemctl $*" >> "$FAKE_DIR/log"; [ "$1" != is-active ] || [ "${FAKE_ACTIVE:-1}" = 1 ]',
  ss: 'printf "%s" "${FAKE_SS-}"',
  curl: '[ "${FAKE_CDP_UP:-1}" = 1 ]',
  pgrep: '[ "${FAKE_LEGACY:-0}" = 1 ]',
  sleep: "exit 0",
  // The sandbox is not root and has no bux account.
  install: 'args=(); while [ $# -gt 0 ]; do case "$1" in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac; done; exec /usr/bin/install "${args[@]}"',
};
const PREVIOUS_KEEPER = '#!/usr/bin/env python3\nCHROME_ARGS = ["--no-sandbox"]\n';

function run(options: { unit?: boolean; env?: Record<string, string>; keeper?: string; policy?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "browser-view-"));
  try {
    for (const dir of ["bin", "etc/systemd/system", "etc/default", "etc/apt/sources.list.d", "opt/bux", "work", "fake"]) mkdirSync(path.join(root, dir), { recursive: true });
    for (const [name, body] of Object.entries(FAKES)) {
      writeFileSync(path.join(root, "bin", name), `#!/usr/bin/env bash\n${body}\n`);
      chmodSync(path.join(root, "bin", name), 0o755);
    }
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
    const script = `set -euo pipefail\nWORK=${root}/work\n${BLOCK.replace(/(?<=[=\s"'])\/(etc|opt)\//g, `${root}/$1/`)}\n`;
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8", timeout: 30_000,
      env: { ...process.env, PATH: `${root}/bin:/usr/bin:/bin`, FAKE_DIR: path.join(root, "fake"), FAKE_LEGACY: "0", ...options.env },
    });
    const file = (name: string) => (existsSync(path.join(root, name)) ? readFileSync(path.join(root, name), "utf8") : null);
    return {
      status: result.status, stdout: result.stdout, stderr: result.stderr,
      log: file("fake/log") ?? "", keeper: file("opt/bux/local-browser-keeper.py"),
      policy: file("etc/opt/chrome/policies/managed/hivra-browser.json"), defaults: file("etc/default/google-chrome"),
      source: file("etc/apt/sources.list.d/google-chrome.sources"),
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

  it("restarts nothing when the browser is off, and does nothing without a browser unit", () => {
    expect(run({ env: { FAKE_ACTIVE: "0" } }).stdout).toBe("HIVRA_AGENT_BROWSER state=installed\n");
    const none = run({ unit: false });
    expect(none.stdout).toBe("");
    expect(none.policy).toBeNull();
    expect(none.log).toBe("");
  });

  it("leaves a computer that already runs this release alone", () => {
    const result = run({ keeper: KEEPER, policy: true });
    expect(result.stdout).toBe("HIVRA_AGENT_BROWSER state=current\n");
    expect(result.log).not.toContain("restart");
  });

  it("still restarts a browser that runs with --no-sandbox although its files already match", () => {
    expect(run({ keeper: KEEPER, policy: true, env: { FAKE_LEGACY: "1" } }).stdout).toBe("HIVRA_AGENT_BROWSER state=restarted\n");
  });
});
