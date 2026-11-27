/** @jest-environment node */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = readFileSync(join(process.cwd(), "provisioner/hivra-provision-on-host.sh"), "utf8");
const timingStart = source.indexOf("launch_stage() {");
const timingEnd = source.indexOf('\n}\n', timingStart) + 2;
if (timingStart < 0 || timingEnd <= timingStart) throw new Error("Hermes stage logger not found");
const stageLogger = source.slice(timingStart, timingEnd);
const start = source.indexOf("wait_for_guest_cloud_init() {");
const end = source.indexOf("# The package and generated SSH host key now live on the guest disk.", start);
if (start < 0 || end < 0) throw new Error("Guest boot gate not found");
const gate = source.slice(start, end).replace('log "waiting for guest', `
guest_boot_uptime() { cat "$FIXTURE_DIR/clock"; }
log "waiting for guest`);

const attestStart = source.indexOf("prepare_guest_ssh_identity() {");
const pause = source.slice(source.indexOf("guest_probe_pause() {"), attestStart);
const attest = source.slice(attestStart, source.indexOf('log "attesting guest SSH'));
const qgaCloudInit = source.split("<<'HIVRA_QGA_VENDOR_DATA'\n")[1].split("\nHIVRA_QGA_VENDOR_DATA")[0]
  .split("  - |\n")[1].replace(/^    /gm, "").replace("/usr/sbin/qemu-ga", "$FIXTURE_BINARY");

describe("QEMU Guest Agent boot path", () => {
  it.each([
    ["prepared", "installed", 0, ["systemctl"]],
    ["stock", "absent", 0, ["apt-get", "apt-get", "systemctl"]],
    ["stock", "unpacked", 0, ["apt-get", "apt-get", "systemctl"]],
    ["stock", "absent", 1, ["apt-get"]],
  ])("installs QGA only when needed (%s, %s, apt exits %s)", (image, state, failure, calls) => {
    const result = spawnSync("bash", ["--noprofile", "--norc", "-s"], {
      input: `
FIXTURE_BINARY=${image === "prepared" || state === "unpacked" ? "/bin/bash" : "/does-not-exist"}
dpkg-query() { printf '%s' "${state}"; }
apt-get() { echo apt-get; return ${failure}; }
systemctl() { echo systemctl; }
${qgaCloudInit}
`,
      encoding: "utf8",
    });
    expect(result.status).toBe(failure);
    expect(result.stdout.trim().split("\n")).toEqual(calls);
  });

  it.each([["ready", 0, 2], ["late", 1, 601], ["foreign", 1, 0], ["wrong-ip", 1, 0]])(
    "accepts only a correctly owned, timely attestation (%s)", (outcome, exitCode, elapsed) => {
      const fixture = mkdtempSync(join(tmpdir(), "hivra-qga-"));
      try {
        writeFileSync(join(fixture, "clock"), "0");
        const hostKey = Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020", "hex"), Buffer.alloc(32, 5)]).toString("base64");
        const result = spawnSync("bash", ["--noprofile", "--norc", "-s"], {
          input: `set -euo pipefail
VMID=1100
IP=192.0.2.1
vm_owned_by_operation() { [ "$CASE" != foreign ]; }
fail() { echo "$*" >&2; exit 1; }
guest_boot_uptime() { cat "$FIXTURE_DIR/clock"; }
sleep() { echo "$(($1 + $(guest_boot_uptime)))" > "$FIXTURE_DIR/clock"; }
mktemp() { mkdir "$FIXTURE_DIR/key"; echo "$FIXTURE_DIR/key"; }
timeout() { [ "$1" = --kill-after=2s ] && [ "$2" = 8s ] || exit 125; shift 2; "$@"; }
qm() {
  case "$1" in
    config) if [ "$CASE" = wrong-ip ]; then echo 'ipconfig0: ip=192x0x2x1/24'; else echo 'ipconfig0: ip=192.0.2.1/24'; fi ;;
    guest)
      [ "$3" = "$VMID" ] || exit 1
      if [ "$CASE" = late ]; then echo 601 > "$FIXTURE_DIR/clock"; fi
      if [ "$(guest_boot_uptime)" = 0 ]; then echo '{"exited":1,"exitcode":0,"out-data":"ssh-ed25519 invalid"}'; return; fi
      echo '{"exited":1,"exitcode":0,"out-data":"ssh-ed25519 ${hostKey}"}'
      ;;
    *) exit 1 ;;
  esac
}
${pause}
${attest}
prepare_guest_ssh_identity
cat "$GUEST_SSH_KNOWN_HOSTS"
`,
          env: { PATH: "/usr/bin:/bin", CASE: outcome, FIXTURE_DIR: fixture, NODE_ENV: "test" },
          encoding: "utf8", timeout: 10_000,
        });
        expect(result.status).toBe(exitCode);
        expect(Number(readFileSync(join(fixture, "clock"), "utf8"))).toBe(elapsed);
        expect(result.stdout.trim()).toBe(exitCode === 0 ? `hivra-vmid-1100 ssh-ed25519 ${hostKey}` : "");
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    },
  );
});

function boot(steps: string[], kind = "hermes") {
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
  timeout) printf '%s' "$((clock + PROBE_BUDGET))" > "$FIXTURE_DIR/clock"; exit 124 ;;
  killed) printf '%s' "$((clock + PROBE_BUDGET + 2))" > "$FIXTURE_DIR/clock"; exit 137 ;;
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
    diag) printf 'status: error\\nPRIVATE_DIAGNOSTIC\\n' ;;
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
export PROBE_BUDGET="$budget"
shift 2
exec "$@"
`, { mode: 0o700 });
    const result = spawnSync("bash", ["--noprofile", "--norc", "-s"], {
      input: `set -euo pipefail
VM_KEY=/unused-fixture-key
IP=192.0.2.1
VMID=1100
AGENT_KIND="$FIXTURE_KIND"
OPERATION_ID=12345678-1234-4234-8234-123456789abc
LAUNCH_STAGE_CLOCK=0
CLOUD_INIT_KEEP_DIR="$FIXTURE_DIR"
GSSH=(ssh)
log() { printf '%s\\n' "$*" >&2; }
fail() { log "$*"; exit 1; }
sleep() {
  clock="$(cat "$FIXTURE_DIR/clock")"
  printf '%s' "$((clock + $1))" > "$FIXTURE_DIR/clock"
}
${stageLogger}
${pause}
${gate}
printf 'INSTALL_NEXT\\n'
`,
      env: { PATH: `${fixture}:/usr/bin:/bin`, FIXTURE_DIR: fixture, FIXTURE_KIND: kind, NODE_ENV: "test" },
      encoding: "utf8", timeout: 10_000,
    });
    return { ...result,
      attempts: Number(readFileSync(join(fixture, "attempts"), "utf8")),
      elapsed: Number(readFileSync(join(fixture, "clock"), "utf8")),
      budgets: readFileSync(join(fixture, "timeouts"), "utf8").trim().split("\n").filter(Boolean),
      kept: existsSync(join(fixture, "hivra-prov-1100.cloud-init.txt"))
        ? { text: readFileSync(join(fixture, "hivra-prov-1100.cloud-init.txt"), "utf8"), mode: statSync(join(fixture, "hivra-prov-1100.cloud-init.txt")).mode & 0o777 }
        : null,
    };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

describe("guest boot gate", () => {
  it("continues only after clean completion, including normal early boot states", () => {
    const result = boot(["transport", "not-run", "running", "done"]);
    expect(result).toMatchObject({ status: 0, attempts: 4, elapsed: 6, stdout: "INSTALL_NEXT\n" });
    expect(result.budgets).toHaveLength(4);
    expect(result.stderr).toContain("guest cloud-init completed");
    expect(result.stderr).toMatch(/^HIVRA_HERMES_STAGE cloud_init_ready \d+$/m);
  });

  it("emits boot stage timings for non-Hermes launches without guest output", () => {
    const result = boot(["done"], "codex");
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/^HIVRA_LAUNCH_STAGE 12345678-1234-4234-8234-123456789abc cloud_init_ready \d+$/m);
    expect(result.stderr).not.toContain("HIVRA_HERMES_STAGE");
  });

  it.each(["disabled", "unknown", "malformed", "empty"])(
    "stops immediately on %s without copying, installing or leaking guest diagnostics", (step) => {
      const result = boot([step, "done"]);
      expect(result.status).toBe(1);
      expect(result.attempts).toBe(1);
      expect(result.stdout).not.toContain("INSTALL_NEXT");
      expect(result.stdout + result.stderr).not.toContain("PRIVATE_DIAGNOSTIC");
      expect(result.stderr).toContain("cloud-init");
      expect(result.kept).toBeNull();
    },
  );

  it.each(["error", "degraded", "sudo-denied", "missing"])(
    "stops on %s, keeps cloud-init's details only in a root-only host file, and never logs them", (step) => {
      const result = boot([step, "diag"]);
      expect(result.status).toBe(1);
      expect(result.attempts).toBe(2);
      expect(result.stdout).not.toContain("INSTALL_NEXT");
      expect(result.stdout + result.stderr).not.toContain("PRIVATE_DIAGNOSTIC");
      expect(result.stderr).toContain("guest cloud-init check failed");
      expect(result.stderr).toContain("hivra-prov-1100.cloud-init.txt (root only)");
      expect(result.kept).toMatchObject({ mode: 0o600 });
      expect(result.kept!.text).toContain("PRIVATE_DIAGNOSTIC");
      expect(result.budgets.at(-1)).toBe("--kill-after=2s 20s");
    },
  );

  it("drops details kept from an earlier failed launch on the same VMID once the guest boots cleanly", () => {
    const result = boot(["error", "diag"]);
    expect(result.kept).not.toBeNull();
    // A later clean run starts by removing the earlier file.
    expect(source).toContain('rm -f -- "${CLOUD_INIT_KEEP_DIR:-/root}/hivra-prov-${VMID}.cloud-init.txt"');
  });

  it.each(["transport", "running", "not-run", "timeout", "killed"])(
    "fails when %s never resolves, with no fall-through to installation", (step) => {
      const result = boot([step]);
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain("INSTALL_NEXT");
      expect(result.elapsed).toBeLessThanOrEqual(600);
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
