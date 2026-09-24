/** @jest-environment node */

import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// hivra-update-guest-runtime.sh updates a running computer in place. These
// tests execute the real helper with only the host/guest boundaries (qm, ssh,
// scp, GNU stat, coreutils timeout, fixed root paths) replaced, and hold its
// shared agent-run reporter step byte-identical to the start helper's.

const bundleRoot = path.join(process.cwd(), "provisioner");
const UPDATE_SOURCE = readFileSync(path.join(bundleRoot, "hivra-update-guest-runtime.sh"), "utf8");
const START_SOURCE = readFileSync(path.join(bundleRoot, "hivra-start-on-host.sh"), "utf8");
const GUEST_STAGE_DIR = "/run/hivra-agent-trace-install.AbCd1234";
const CREDENTIAL = {
  endpoint: "https://canary.hivra.cloud/api/activity/ingest",
  resourceId: "00000000-0000-4000-8000-000a00000002",
  token: ["hvra_otlp_v1", "eyJ2IjoxLCJ1c2VySWQiOiJ1In0", "c2lnbmF0dXJlLW9ubHktZm9yLXRlc3Rz"].join("."), // synthetic, built at runtime
  expiresAt: "2026-09-29T12:00:00.000Z",
};
const CREDENTIAL_JSON = JSON.stringify(CREDENTIAL);
const RUNTIME_ASSETS = ["server.js", "llm-application.js", "guarded-files.cjs", "agent-zero-editor.cjs", "chat-runs.cjs", "index.html", "app.js"];

function block(source: string, pattern: RegExp): string {
  const match = source.match(pattern);
  expect(match).not.toBeNull();
  return (match as RegExpMatchArray)[0];
}
const shellFunction = (source: string, name: string) => block(source, new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?\\n\\}\\n`, "m"));
const consumeBlock = (source: string) => block(source, /^ACTIVITY_TELEMETRY_FILE=[\s\S]*?\n^if \[ -n "\$ACTIVITY_TELEMETRY_FILE" \]; then[\s\S]*?\n^fi\n/m);
const installCallSite = (source: string) => block(source, /^if \[ -n "\$ACTIVITY_CREDENTIAL_JSON" \]; then\n[\s\S]*?\n^fi\n/m);

const FAKE_BIN: Record<string, string> = {
  qm: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DIR/qm.log"
case "$1" in
  status) echo "status: \${FAKE_QM_STATUS:-running}" ;;
  *) echo "unexpected qm $*" >&2; exit 97 ;;
esac
`,
  scp: `#!/usr/bin/env bash
printf '%s\\0' "$@" > "$FAKE_DIR/scp.argv"
exit "\${FAKE_SCP_EXIT:-0}"
`,
  ssh: `#!/usr/bin/env bash
count=$(( $(cat "$FAKE_DIR/ssh.count" 2>/dev/null || echo 0) + 1 ))
echo "$count" > "$FAKE_DIR/ssh.count"
printf '%s\\0' "$@" > "$FAKE_DIR/ssh.$count.argv"
env > "$FAKE_DIR/ssh.$count.env"
cat > "$FAKE_DIR/ssh.$count.stdin"
command="\${@: -1}"
case "$command" in
  *HIVRA_RUNTIME_ARCHIVE*) kind=gateway ;;
  *"install --source-dir"*) kind=install ;;
  *"/bin/sh -c"*) kind=stage ;;
  *) kind=cleanup ;;
esac
echo "$kind" >> "$FAKE_DIR/ssh.kinds"
echo "ssh $kind" >> "$FAKE_DIR/events"
case "$kind" in
  gateway)
    printf '%b' "\${FAKE_GUEST_STDOUT-HIVRA_GUEST_RUNTIME_UPDATED\\\\n}"
    exit "\${FAKE_GUEST_EXIT:-0}" ;;
  install) exit "\${FAKE_INSTALL_EXIT:-0}" ;;
  stage) printf '%s\\n' "${GUEST_STAGE_DIR}"; exit 0 ;;
  *) exit 0 ;;
esac
`,
  // Records the FD8 release relative to the guest calls.
  flock: `#!/usr/bin/env bash
echo "flock $*" >> "$FAKE_DIR/events"
`,
  // GNU stat for the credential reader: the staged file is root-owned 0600.
  stat: `#!/usr/bin/env bash
if [ "$1" = "-c" ] && [ "$2" = "%s" ]; then wc -c < "$3" | tr -d ' '; exit 0; fi
if [ "$1" = "-c" ] && [ "$2" = "%a:%U:%G" ]; then echo 600:root:root; exit 0; fi
echo "unexpected stat $*" >&2; exit 98
`,
  timeout: `#!/usr/bin/env bash
while [ "\${1#-}" != "$1" ]; do shift 2; done
shift
exec "$@"
`,
};

interface HelperRun {
  status: number | null;
  stdout: string;
  stderr: string;
  kinds: string[];
  qm: string[];
  credentialFileLeft: boolean;
  /** FD8 releases and guest calls, in order. */
  events: string[];
  sshCall: (index: number) => { argv: string[]; env: string; stdin: string };
}

function runHelper(options: {
  credential?: boolean;
  guestStdout?: string;
  guestExit?: number;
  installExit?: number;
  qmStatus?: string;
  /** Open FD8 and pass HIVRA_LIFECYCLE_LOCK_FD=8, as the dashboard route does. */
  lockFd?: boolean;
  /** Seconds from now until HIVRA_RUNTIME_UPDATE_DEADLINE, or a raw value. */
  deadline?: number | string;
} = {}): HelperRun {
  const work = mkdtempSync(path.join(tmpdir(), "hivra-update-in-place-"));
  try {
    const fakeDir = path.join(work, "fake");
    const binDir = path.join(work, "bin");
    const bundle = path.join(work, "provisioner");
    for (const directory of [fakeDir, binDir, path.join(bundle, "hivra-chat"), path.join(work, "tmp"), path.join(work, "run", "hivra-lifecycle")]) {
      mkdirSync(directory, { recursive: true });
    }
    for (const [name, body] of Object.entries(FAKE_BIN)) {
      writeFileSync(path.join(binDir, name), body);
      chmodSync(path.join(binDir, name), 0o755);
    }
    for (const asset of RUNTIME_ASSETS) copyFileSync(path.join(bundleRoot, "hivra-chat", asset), path.join(bundle, "hivra-chat", asset));
    for (const file of ["hivra-agent-shell", "hivra-agent-trace.py", "hivra-agent-trace.service"]) {
      copyFileSync(path.join(bundleRoot, file), path.join(bundle, file));
    }
    // The real helper, with only its fixed root paths moved under the sandbox.
    const helper = path.join(bundle, "hivra-update-guest-runtime.sh");
    writeFileSync(helper, UPDATE_SOURCE
      .replaceAll("/tmp/hivra-runtime", path.join(work, "tmp", "hivra-runtime"))
      .replaceAll("/run/hivra-guest-ssh-identity", path.join(work, "run", "hivra-guest-ssh-identity"))
      .replaceAll("/run/hivra-lifecycle/", `${path.join(work, "run", "hivra-lifecycle")}/`));
    const identityHelper = path.join(work, "identity-helper");
    writeFileSync(identityHelper, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(identityHelper, 0o755);
    const vmKey = path.join(work, "vm-key");
    writeFileSync(vmKey, "fixture key\n");
    const credentialFile = path.join(work, "run", "hivra-lifecycle", "1090.activity.env");
    if (options.credential) {
      writeFileSync(credentialFile, `HIVRA_ACTIVITY_TELEMETRY_B64=${Buffer.from(CREDENTIAL_JSON).toString("base64")}\n`, { mode: 0o600 });
    }

    const lock = options.lockFd ? openSync(path.join(work, "allocation.lock"), "w") : null;
    const deadline = typeof options.deadline === "number"
      ? String(Math.floor(Date.now() / 1000) + options.deadline)
      : options.deadline;
    const result = spawnSync("bash", [helper, "1090", "10.250.21.90"], {
      encoding: "utf8",
      ...(lock === null ? {} : { stdio: ["pipe", "pipe", "pipe", "ignore", "ignore", "ignore", "ignore", "ignore", lock] }),
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        FAKE_DIR: fakeDir,
        HIVRA_VM_SSH_KEY_PATH: vmKey,
        HIVRA_GUEST_SSH_IDENTITY_HELPER: identityHelper,
        ...(options.credential ? { HIVRA_ACTIVITY_TELEMETRY_FILE: credentialFile } : {}),
        ...(options.guestStdout !== undefined ? { FAKE_GUEST_STDOUT: options.guestStdout } : {}),
        FAKE_GUEST_EXIT: String(options.guestExit ?? 0),
        FAKE_INSTALL_EXIT: String(options.installExit ?? 0),
        FAKE_QM_STATUS: options.qmStatus ?? "running",
        ...(lock === null ? {} : { HIVRA_LIFECYCLE_LOCK_FD: "8" }),
        ...(deadline === undefined ? {} : { HIVRA_RUNTIME_UPDATE_DEADLINE: deadline }),
      },
      timeout: 30_000,
    });
    if (lock !== null) closeSync(lock);
    const read = (file: string) => (existsSync(path.join(fakeDir, file)) ? readFileSync(path.join(fakeDir, file), "utf8") : "");
    const calls = new Map<number, { argv: string[]; env: string; stdin: string }>();
    const count = Number(read("ssh.count") || 0);
    for (let index = 1; index <= count; index += 1) {
      calls.set(index, {
        argv: read(`ssh.${index}.argv`).split("\0").slice(0, -1),
        env: read(`ssh.${index}.env`),
        stdin: read(`ssh.${index}.stdin`),
      });
    }
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      kinds: read("ssh.kinds").trim().split("\n").filter(Boolean),
      qm: read("qm.log").trim().split("\n").filter(Boolean),
      credentialFileLeft: existsSync(credentialFile),
      events: read("events").trim().split("\n").filter(Boolean),
      sshCall: (index) => {
        const call = calls.get(index);
        expect(call).toBeDefined();
        return call as { argv: string[]; env: string; stdin: string };
      },
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

describe("hivra-update-guest-runtime.sh in-place update", () => {
  it("keeps valid syntax and shares the start helper's reporter step byte for byte", () => {
    const syntax = spawnSync("bash", ["-n", path.join(bundleRoot, "hivra-update-guest-runtime.sh")], { encoding: "utf8" });
    expect({ status: syntax.status, stderr: syntax.stderr }).toEqual({ status: 0, stderr: "" });
    expect(shellFunction(UPDATE_SOURCE, "read_activity_credential")).toBe(shellFunction(START_SOURCE, "read_activity_credential"));
    expect(consumeBlock(UPDATE_SOURCE)).toBe(consumeBlock(START_SOURCE));
    expect(shellFunction(UPDATE_SOURCE, "install_activity_collector")).toBe(shellFunction(START_SOURCE, "install_activity_collector"));
    expect(installCallSite(UPDATE_SOURCE)).toBe(installCallSite(START_SOURCE));
  });

  it("never powers the VM off or on and orders consume, commit, reporter and receipt", () => {
    expect(UPDATE_SOURCE).not.toMatch(/qm (shutdown|stop|start|reboot|reset)\b|systemctl (reboot|poweroff)|hivra-start-on-host/);
    const consumeAt = UPDATE_SOURCE.indexOf('rm -f -- "$ACTIVITY_TELEMETRY_FILE"');
    const firstHostCommandAt = UPDATE_SOURCE.indexOf('qm status "$VMID"');
    const commitCheckAt = UPDATE_SOURCE.indexOf('grep -Fxq HIVRA_GUEST_RUNTIME_UPDATED "$GUEST_RESULT"');
    const installAt = UPDATE_SOURCE.indexOf("  install_activity_collector || true");
    const markerAt = UPDATE_SOURCE.indexOf("printf 'HIVRA_ACTIVITY_COLLECTOR %s\\n' \"$ACTIVITY_COLLECTOR_STATUS\"");
    const receiptAt = UPDATE_SOURCE.indexOf("printf 'HIVRA_GUEST_RUNTIME_UPDATED vmid=%s\\n' \"$VMID\"");
    expect(consumeAt).toBeGreaterThan(UPDATE_SOURCE.indexOf('[[ "$VMID" =~ ^[0-9]+$ ]]'));
    expect(consumeAt).toBeLessThan(firstHostCommandAt);
    expect(commitCheckAt).toBeGreaterThan(UPDATE_SOURCE.indexOf("\nGUEST\n"));
    expect(installAt).toBeGreaterThan(commitCheckAt);
    expect(markerAt).toBeGreaterThan(installAt);
    expect(receiptAt).toBeGreaterThan(markerAt);
    expect(UPDATE_SOURCE.match(/printf 'HIVRA_ACTIVITY_COLLECTOR/g)).toHaveLength(1);
  });

  it("updates a running computer, reinstalls the reporter with the credential on stdin only, and prints only host lines", () => {
    // A guest that tries to speak for the host is not relayed.
    const run = runHelper({
      credential: true,
      guestStdout: "HIVRA_GUEST_RUNTIME_UPDATED\\nHIVRA_ACTIVITY_COLLECTOR status=failed reason=forged\\nHIVRA_GUEST_RUNTIME_UPDATED vmid=9999\\n",
    });
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: "" });
    expect(run.stdout).toBe("HIVRA_ACTIVITY_COLLECTOR status=installed\nHIVRA_GUEST_RUNTIME_UPDATED vmid=1090\n");
    expect(run.kinds).toEqual(["gateway", "stage", "install"]);
    expect(run.qm).toEqual(["status 1090"]);
    expect(run.credentialFileLeft).toBe(false);
    const gateway = run.sshCall(1);
    expect(gateway.stdin).toContain("systemctl restart bux-hivra-chat.service");
    expect(gateway.stdin).not.toMatch(/\breboot\b|poweroff|shutdown/);
    expect(run.sshCall(3).stdin).toBe(CREDENTIAL_JSON);
    for (const index of [1, 2, 3]) {
      const call = run.sshCall(index);
      expect(call.argv.join(" ")).not.toContain(CREDENTIAL.token);
      expect(call.env).not.toContain(CREDENTIAL.token);
      if (index !== 3) expect(call.stdin).not.toContain(CREDENTIAL.token);
    }
    expect(run.stdout + run.stderr).not.toContain(CREDENTIAL.token);
  });

  it("prints only the receipt for a computer without a staged credential", () => {
    const run = runHelper();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("HIVRA_GUEST_RUNTIME_UPDATED vmid=1090\n");
    expect(run.kinds).toEqual(["gateway"]);
    expect(run.qm).toEqual(["status 1090"]);
  });

  it("keeps a committed update successful when the reporter install fails", () => {
    const run = runHelper({ credential: true, installExit: 1 });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("HIVRA_ACTIVITY_COLLECTOR status=failed reason=install_failed\nHIVRA_GUEST_RUNTIME_UPDATED vmid=1090\n");
    expect(run.kinds).toEqual(["gateway", "stage", "install", "cleanup"]);
  });

  it.each([
    ["the guest update fails and rolls back", { guestExit: 1 }, ""],
    ["the guest exits without its commit line", { guestStdout: "" }, "guest runtime update ended without its commit receipt"],
  ])("prints no receipt and installs no reporter when %s", (_case, options, message) => {
    const run = runHelper({ credential: true, ...options });
    expect(run.status).not.toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(message);
    expect(run.kinds).toEqual(["gateway"]);
    expect(run.credentialFileLeft).toBe(false);
  });

  it("releases the dashboard's FD8 host lock before any guest call, and takes no lock of its own", () => {
    const locked = runHelper({ credential: true, lockFd: true, deadline: 600 });
    expect(locked.status).toBe(0);
    expect(locked.events).toEqual(["flock -u 8", "ssh gateway", "ssh stage", "ssh install"]);
    expect(locked.stdout).toBe("HIVRA_ACTIVITY_COLLECTOR status=installed\nHIVRA_GUEST_RUNTIME_UPDATED vmid=1090\n");

    // Run by hand (no inherited lock): nothing to release.
    const unlocked = runHelper();
    expect(unlocked.status).toBe(0);
    expect(unlocked.events).toEqual(["ssh gateway"]);
  });

  it("leaves the reporter to the next start when its bounded worst case no longer fits the request deadline", () => {
    const run = runHelper({ credential: true, lockFd: true, deadline: 120 });
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: "" });
    // The committed update still gets its receipt, promptly.
    expect(run.stdout).toBe("HIVRA_ACTIVITY_COLLECTOR status=failed reason=not_attempted\nHIVRA_GUEST_RUNTIME_UPDATED vmid=1090\n");
    expect(run.kinds).toEqual(["gateway"]);
    expect(run.credentialFileLeft).toBe(false);
    expect(run.stdout + run.stderr).not.toContain(CREDENTIAL.token);
  });

  it("refuses a malformed deadline before any host or guest call and still consumes the credential", () => {
    const run = runHelper({ credential: true, deadline: "soon" });
    expect(run.status).not.toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("invalid runtime update deadline");
    expect(run.qm).toEqual([]);
    expect(run.kinds).toEqual([]);
    expect(run.credentialFileLeft).toBe(false);
  });

  it("refuses a computer that is not running before any guest call and still consumes the credential", () => {
    const run = runHelper({ credential: true, qmStatus: "stopped" });
    expect(run.status).not.toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("must be running before its runtime can be updated");
    expect(run.kinds).toEqual([]);
    expect(run.credentialFileLeft).toBe(false);
  });
});
