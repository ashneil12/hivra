/** @jest-environment node */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const source = readFileSync(path.join(process.cwd(), "provisioner/provision-claude-code-box.sh"), "utf8");
const start = source.indexOf("read_bux_checkout_head() {");
const end = source.indexOf("\n}\n", start) + 2;
const reader = source.slice(start, end);
const pin = "f17c1b31d6688dd92e745ade650e00d46b4dc4da";

function probe(options: { owner?: string; gitOwner?: string; head?: string; failedGit?: boolean; symlink?: boolean }) {
  const fixture = mkdtempSync(path.join(tmpdir(), "hivra-bux-owner-"));
  const checkout = path.join(fixture, "checkout");
  mkdirSync(checkout);
  mkdirSync(path.join(checkout, ".git"));
  if (options.symlink) symlinkSync(checkout, path.join(fixture, "linked-checkout"));
  try {
    return spawnSync("/bin/bash", ["--noprofile", "--norc", "-s"], {
      input: `set -euo pipefail
die() { printf '%s\\n' "$*" >&2; exit 1; }
stat() { [ "$1" = -c ] && [ "$2" = %u ]; if [ "$3" = "$BUX_DIR/.git" ]; then printf '%s' "$GIT_OWNER"; else printf '%s' "$CHECKOUT_OWNER"; fi; }
id() { [ "$1" = -u ] && [ "$2" = bux ]; printf '1001'; }
git() { [ "$1" = -C ] && [ "$2" = "$BUX_DIR" ] && [ "$3" = rev-parse ] && [ "$4" = HEAD ] && [ "$#" = 4 ]; printf 'git-as:%s\\n' "\${AS_OWNER:-root}" >&2; [ "$FAIL_GIT" = 0 ] || return 128; printf '%s\\n' "$FIXTURE_HEAD"; }
sudo() { [ "$1" = -H ] && [ "$2" = -u ] && [ "$3" = bux ] && [ "$4" = -- ]; shift 4; AS_OWNER=bux "$@"; }
${reader}
BUX_HEAD="$(read_bux_checkout_head)" || die 'could not verify the existing bux checkout as its owner'
[ "$BUX_HEAD" = "$BUX_REF" ] || die 'bux pin mismatch'
printf '%s\\n' "$BUX_HEAD"
`,
      env: { PATH: "/usr/bin:/bin", NODE_ENV: "test", BUX_DIR: path.join(fixture, options.symlink ? "linked-checkout" : "checkout"), AGENT_USER: "bux", BUX_REF: pin,
        CHECKOUT_OWNER: options.owner ?? "1001", GIT_OWNER: options.gitOwner ?? options.owner ?? "1001", FIXTURE_HEAD: options.head ?? pin, FAIL_GIT: options.failedGit ? "1" : "0" },
      encoding: "utf8", timeout: 3_000,
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

it.each([["0", "root"], ["1001", "bux"]])("verifies a %s-owned checkout as %s without changing Git trust", (owner, actor) => {
  expect(start).toBeGreaterThan(0);
  const result = probe({ owner });
  expect(result).toMatchObject({ status: 0, stdout: `${pin}\n`, stderr: `git-as:${actor}\n` });
  expect(reader).not.toContain("safe.directory");
  expect(source).toContain('BUX_HEAD="$(read_bux_checkout_head)" || die');
  expect(source).toContain('[ "$BUX_HEAD" = "$BUX_REF" ] || die');
});

it.each([{ owner: "2000" }, { owner: "1001", gitOwner: "0" }, { symlink: true }])("rejects unexpected checkout ownership before Git access: %j", options => {
  const result = probe(options);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).not.toContain("git-as:");
});

it.each([{ head: "0000000000000000000000000000000000000000" }, { failedGit: true }])("does not accept an unverified commit: %j", options => {
  const result = probe(options);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
});

it("never rewrites or executes a modified existing installer, even with a matching HEAD", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "hivra-bux-tamper-"));
  const marker = path.join(fixture, "executed");
  const tampered = `#!/bin/bash\nprintf 'unexpected-root-execution' > '${marker}'\n`;
  writeFileSync(path.join(fixture, "install.sh"), tampered, { mode: 0o755 });
  const offset = source.indexOf("ensure_bux_installed() {");
  const finish = source.indexOf("\n}\n", offset) + 2;
  expect(offset).toBeGreaterThan(0);
  const implementation = source.slice(offset, finish);
  expect(implementation.indexOf('[ "$BUX_CHECKOUT_CREATED" = 1 ]')).toBeLessThan(implementation.indexOf("sed -i -E"));
  expect(source).toContain('if [ ! -e "${BUX_DIR}" ] && [ ! -L "${BUX_DIR}" ]; then');
  try {
    const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-s"], {
      input: `set -euo pipefail\ndie() { printf '%s\\n' "$*" >&2; exit 1; }\nid() { return 1; }\n${implementation}\nensure_bux_installed\n`,
      env: { PATH: "/usr/bin:/bin", NODE_ENV: "test", BUX_DIR: fixture, BUX_CHECKOUT_CREATED: "0", AGENT_USER: "bux", BUX_HEAD: pin, BUX_REF: pin },
      encoding: "utf8", timeout: 3_000,
    });
    expect(result).toMatchObject({ status: 1, stdout: "", stderr: "existing bux base is incomplete; trusted base repair is required\n" });
    expect(readFileSync(path.join(fixture, "install.sh"), "utf8")).toBe(tampered);
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
