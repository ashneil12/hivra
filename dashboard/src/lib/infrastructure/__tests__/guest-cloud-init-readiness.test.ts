/** @jest-environment node */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = readFileSync(join(process.cwd(), "provisioner/hivra-provision-on-host.sh"), "utf8");
const start = source.indexOf("wait_for_guest_cloud_init() {");
const end = source.indexOf("# The package and generated SSH host key now live on the guest disk.", start);
if (start < 0 || end < 0) throw new Error("Guest boot gate not found");
const gate = source.slice(start, end).replace('log "waiting for guest', `
guest_boot_uptime() { cat "$FIXTURE_DIR/clock"; }
log "waiting for guest`);

function boot(steps: string[]) {
  const fixture = mkdtempSync(join(tmpdir(), "hivra-cloud-init-gate-"));
  try {
    writeFileSync(join(fixture, "steps"), steps.join("\n") + "\n");
    writeFileSync(join(fixture, "clock"), "0");
    writeFileSync(join(fixture, "attempts"), "0");
    writeFileSync(join(fixture, "timeouts"), "");
    writeFileSync(join(fixture, "ssh"), `#!/usr/bin/env bash
set -eu
n="$(cat "$FIXTURE_DIR/attempts")"; n=$((n + 1))
printf '%s' "$n" > "$FIXTURE_DIR/attempts"
step="$(sed -n "\${n}p" "$FIXTURE_DIR/steps")"
[ -n "$step" ] || step="$(tail -1 "$FIXTURE_DIR/steps")"
clock="$(cat "$FIXTURE_DIR/clock")"
case "$step" in
  transport) exit 255 ;;
  timeout) printf '%s' "$((clock + 22))" > "$FIXTURE_DIR/clock"; exit 124 ;;
  killed) printf '%s' "$((clock + 22))" > "$FIXTURE_DIR/clock"; exit 137 ;;
  late) printf '601' > "$FIXTURE_DIR/clock" ;;
  late-transport) printf '601' > "$FIXTURE_DIR/clock"; exit 255 ;;
esac
sudo() {
  if [ "$step" = sudo-denied ]; then echo 'PRIVATE_DIAGNOSTIC' >&2; return 1; fi
  [ "$1" != -n ] || shift
  "$@"
}
cloud-init() {
  case "$step" in
    done|late) printf 'status: done\\n' ;;
    running) printf 'status: running\\n' ;;
    not-run) printf 'status: not run\\n' ;;
    disabled) printf 'status: disabled\\n' ;;
    error) printf 'status: error\\nPRIVATE_DIAGNOSTIC\\n'; return 1 ;;
    degraded) printf 'status: done\\nPRIVATE_DIAGNOSTIC\\n'; return 2 ;;
    missing) echo 'PRIVATE_DIAGNOSTIC' >&2; return 127 ;;
    unknown) printf 'status: unknown\\nPRIVATE_DIAGNOSTIC\\n' ;;
    malformed) printf 'status: done\\nPRIVATE_DIAGNOSTIC\\n' ;;
    empty) : ;;
    *) return 1 ;;
  esac
}
eval "\${!#}"
`, { mode: 0o700 });
    // Exercise the actual gate without a network connection or GNU coreutils
    // dependency on macOS. Record each killable command's budget; the SSH
    // fixture explicitly simulates timeout and late-completion outcomes.
    writeFileSync(join(fixture, "timeout"), `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$1 $2" >> "$FIXTURE_DIR/timeouts"
[ "$1" = --kill-after=2s ] || exit 125
budget="\${2%s}"; [ "$budget" -ge 1 ] && [ "$budget" -le 20 ] || exit 125
shift 2
exec "$@"
`, { mode: 0o700 });
    const result = spawnSync("bash", ["--noprofile", "--norc", "-s"], {
      input: `set -euo pipefail
VM_KEY=/unused-fixture-key
IP=192.0.2.1
GSSH=(ssh)
log() { printf '%s\\n' "$*" >&2; }
fail() { log "$*"; exit 1; }
sleep() {
  clock="$(cat "$FIXTURE_DIR/clock")"
  printf '%s' "$((clock + $1))" > "$FIXTURE_DIR/clock"
}
${gate}
printf 'INSTALL_NEXT\\n'
`,
      env: { PATH: `${fixture}:/usr/bin:/bin`, FIXTURE_DIR: fixture, NODE_ENV: "test" },
      encoding: "utf8", timeout: 10_000,
    });
    return { ...result,
      attempts: Number(readFileSync(join(fixture, "attempts"), "utf8")),
      elapsed: Number(readFileSync(join(fixture, "clock"), "utf8")),
      budgets: readFileSync(join(fixture, "timeouts"), "utf8").trim().split("\n").filter(Boolean),
    };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

describe("guest boot gate", () => {
  it("continues only after clean completion, including normal early boot states", () => {
    const result = boot(["transport", "not-run", "running", "done"]);
    expect(result).toMatchObject({ status: 0, attempts: 4, stdout: "INSTALL_NEXT\n" });
    expect(result.budgets).toHaveLength(4);
    expect(result.stderr).toContain("guest cloud-init completed");
  });

  it.each(["error", "degraded", "sudo-denied", "missing", "disabled", "unknown", "malformed", "empty"])(
    "stops immediately on %s without copying, installing or leaking guest diagnostics", (step) => {
      const result = boot([step, "done"]);
      expect(result.status).toBe(1);
      expect(result.attempts).toBe(1);
      expect(result.stdout).not.toContain("INSTALL_NEXT");
      expect(result.stdout + result.stderr).not.toContain("PRIVATE_DIAGNOSTIC");
      expect(result.stderr).toContain("cloud-init");
    },
  );

  it.each(["transport", "running", "not-run", "timeout", "killed"])(
    "fails when %s never resolves, with no fall-through to installation", (step) => {
      const result = boot([step]);
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain("INSTALL_NEXT");
      expect(result.attempts).toBeLessThanOrEqual(60);
      expect(result.budgets).toHaveLength(result.attempts);
      expect(result.stderr).toContain("guest boot timed out");
    },
  );

  it.each(["late", "late-transport"])("rejects a %s result after the monotonic deadline", (step) => {
    const result = boot([step, "done"]);
    expect(result).toMatchObject({ status: 1, attempts: 1 });
    expect(result.stdout).not.toContain("INSTALL_NEXT");
    expect(result.stderr).toContain("guest boot timed out");
  });

  it("uses noninteractive bounded probes rather than an unbounded remote --wait", () => {
    expect(gate).toContain("sudo -n cloud-init status");
    expect(gate).not.toContain("status --wait");
    expect(gate).not.toContain("echo ok");
    expect(gate).toContain("BatchMode=yes");
    expect(gate).toContain("ConnectionAttempts=1");
    expect(source).toContain("/proc/uptime");
    expect(source.indexOf('command -v timeout')).toBeLessThan(source.indexOf('qm create "$VMID"'));
    expect(source).toContain('trap cleanup EXIT');
  });
});
