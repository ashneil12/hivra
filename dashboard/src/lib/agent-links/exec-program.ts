// What runs a linked agent's command on a Proxmox computer, and how its answer
// is read. Pure (no server imports) so the tests can run the program itself.
//
// The host checks the VM (running, this computer's binding tag) and hands one
// fixed program to that VMID's guest agent; the agent's command, its stdin and
// its time limit travel only as base64 JSON on the host's stdin, never in a
// shell line. In the guest the program runs as root, picks the computer's own
// user (bux on Ubuntu, the desktop's owner elsewhere), drops to it, runs the
// command with `bash -lc` in that user's home and reports one result line.

import { buildVmidBoundGuestExecPrelude } from "@/lib/hivra/vmid-bound-guest-exec";

export const LINK_EXEC_RESULT_PREFIX = "HIVRA_LINK_EXEC ";
export const LINK_EXEC_REFUSED_PREFIX = "HIVRA_LINK_REFUSED ";
/** Each stream is cut to this many bytes; the guest agent's answer is capped at 1 MiB. */
export const LINK_EXEC_STDOUT_MAX = 256 * 1024;
export const LINK_EXEC_STDERR_MAX = 64 * 1024;
export const LINK_EXEC_STDIN_MAX = 512 * 1024;
export const LINK_EXEC_COMMAND_MAX = 16 * 1024;
export const LINK_EXEC_TIMEOUT_MAX_SECONDS = 120;

export const LINK_EXEC_GUEST_PROGRAM = String.raw`
import base64, glob, json, os, pwd, signal, subprocess, sys, threading, time
PREFIX = "HIVRA_LINK_EXEC "
def done(**fields):
    sys.stdout.write(PREFIX + json.dumps(fields, separators=(",", ":")) + "\n")
    sys.stdout.flush()
    sys.exit(0)
try:
    request = json.loads(sys.stdin.buffer.read(2 * 1024 * 1024))
    command = request["command"]
    data = base64.b64decode(request.get("stdin", ""), validate=True)
    timeout = int(request["timeout"])
    out_max = int(request["stdoutMax"])
    err_max = int(request["stderrMax"])
    assert isinstance(command, str) and command and timeout > 0
except Exception:
    done(status="refused", reason="request_invalid")
def owner():
    try:
        return pwd.getpwnam("bux")
    except KeyError:
        pass
    for entry in sorted(pwd.getpwall(), key=lambda e: e.pw_uid):
        if 1000 <= entry.pw_uid < 60000 and entry.pw_dir.startswith("/home/") \
                and not entry.pw_shell.endswith(("nologin", "false")) and os.path.isdir(entry.pw_dir):
            return entry
    return None
user = owner()
if user is None:
    done(status="refused", reason="no_user")
env = {"HOME": user.pw_dir, "USER": user.pw_name, "LOGNAME": user.pw_name, "SHELL": "/bin/bash",
       "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8", "TERM": "dumb"}
# A desktop session the user is signed in to, so GUI tools reach its screen.
runtime = "/run/user/%d" % user.pw_uid
if os.path.isdir(runtime):
    env["XDG_RUNTIME_DIR"] = runtime
    sockets = sorted(p for p in glob.glob(runtime + "/wayland-[0-9]*") if not p.endswith(".lock"))
    if sockets:
        env["WAYLAND_DISPLAY"] = os.path.basename(sockets[0])
    if os.path.exists(runtime + "/bus"):
        env["DBUS_SESSION_BUS_ADDRESS"] = "unix:path=" + runtime + "/bus"
if os.path.exists("/tmp/.X11-unix/X0"):
    env["DISPLAY"] = ":0"
def demote():
    os.setgid(user.pw_gid)
    os.initgroups(user.pw_name, user.pw_gid)
    os.setuid(user.pw_uid)
started = time.monotonic()
try:
    proc = subprocess.Popen(["/bin/bash", "-lc", command], cwd=user.pw_dir, env=env, stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, preexec_fn=demote, start_new_session=True)
except OSError:
    done(status="refused", reason="start_failed")
kept = {"out": bytearray(), "err": bytearray()}
cut = {"out": False, "err": False}
def drain(stream, key, limit):
    while True:
        chunk = stream.read(65536)
        if not chunk:
            return
        room = limit - len(kept[key])
        if room > 0:
            kept[key] += chunk[:room]
        if len(chunk) > max(room, 0):
            cut[key] = True
readers = [threading.Thread(target=drain, args=(proc.stdout, "out", out_max), daemon=True),
           threading.Thread(target=drain, args=(proc.stderr, "err", err_max), daemon=True)]
for reader in readers:
    reader.start()
def feed():
    try:
        proc.stdin.write(data)
    except OSError:
        pass
    try:
        proc.stdin.close()
    except OSError:
        pass
threading.Thread(target=feed, daemon=True).start()
timed_out = False
try:
    proc.wait(timeout=timeout)
except subprocess.TimeoutExpired:
    timed_out = True
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except OSError:
        pass
    proc.wait()
for reader in readers:
    reader.join(5)
done(status="ran", exitCode=proc.returncode if proc.returncode >= 0 else 128 - proc.returncode,
     stdout=base64.b64encode(bytes(kept["out"])).decode(), stderr=base64.b64encode(bytes(kept["err"])).decode(),
     stdoutTruncated=cut["out"], stderrTruncated=cut["err"], timedOut=timed_out, user=user.pw_name,
     durationMs=int((time.monotonic() - started) * 1000))
`;

export interface LinkExecRequest {
  command: string;
  /** Raw bytes for the command's stdin. */
  stdin?: Buffer;
  timeoutSeconds: number;
}

export interface ProxmoxExecTarget {
  vmid: number;
  bindingTag: string;
}

export type LinkExecOutcome =
  | { status: "ran"; exitCode: number; stdout: Buffer; stderr: Buffer; stdoutTruncated: boolean;
      stderrTruncated: boolean; timedOut: boolean; durationMs: number }
  | { status: "refused"; reason: string };

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export function validExecRequest(request: LinkExecRequest): boolean {
  return typeof request.command === "string" && request.command.trim().length > 0
    && Buffer.byteLength(request.command) <= LINK_EXEC_COMMAND_MAX && !request.command.includes("\0")
    && Number.isInteger(request.timeoutSeconds) && request.timeoutSeconds >= 1
    && request.timeoutSeconds <= LINK_EXEC_TIMEOUT_MAX_SECONDS
    && (request.stdin === undefined || request.stdin.length <= LINK_EXEC_STDIN_MAX);
}

/** The JSON the guest program reads, sent as the host script's stdin. */
export function buildLinkExecPayload(request: LinkExecRequest): string {
  return JSON.stringify({
    command: request.command,
    stdin: (request.stdin ?? Buffer.alloc(0)).toString("base64"),
    timeout: request.timeoutSeconds,
    stdoutMax: LINK_EXEC_STDOUT_MAX,
    stderrMax: LINK_EXEC_STDERR_MAX,
  });
}

/**
 * The host side. Only the VMID, the binding tag and the time limit (all checked
 * here) are in the script; a VM that is not running or not this computer is
 * refused by name before anything reaches the guest.
 */
export function buildLinkExecHostScript(target: ProxmoxExecTarget, timeoutSeconds: number): string {
  if (!Number.isSafeInteger(target.vmid) || target.vmid < 100 || target.vmid > 999_999_999
      || !/^hivra-bind-[a-f0-9]{32}$/.test(target.bindingTag)
      || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > LINK_EXEC_TIMEOUT_MAX_SECONDS) {
    throw new Error("Invalid link exec target.");
  }
  return `#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C
umask 077
VMID=${target.vmid}
EXPECTED_BINDING_TAG=${shellQuote(target.bindingTag)}
# The command's request is this script's stdin; only the guest exec may read it.
qm() { command timeout --kill-after=5 20 qm "$@" </dev/null; }
refuse() { printf '${LINK_EXEC_REFUSED_PREFIX}%s\\n' "$1"; exit 0; }
STATUS="$(qm status "$VMID" 2>/dev/null | awk '{print $2}')" || refuse computer_unreachable
[ "$STATUS" = running ] || refuse computer_not_running
VM_CONFIG="$(qm config "$VMID")" || refuse computer_unreachable
printf '%s\\n' "$VM_CONFIG" | sed -n 's/^tags:[[:space:]]*//p' | tr ';' '\\n' | grep -Fxq "$EXPECTED_BINDING_TAG" || refuse binding_mismatch
${buildVmidBoundGuestExecPrelude()}
qm() { command timeout --kill-after=5 ${timeoutSeconds + 30} qm "$@"; }
run_vmid_bound_guest_exec_stdin /usr/bin/python3 -I -B -c ${shellQuote(LINK_EXEC_GUEST_PROGRAM)} || refuse guest_unreachable
`;
}

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Strict parse of the one answer line; anything else is not an answer. */
export function parseLinkExecOutput(stdout: string): LinkExecOutcome | null {
  const refused = stdout.split("\n").filter((line) => line.startsWith(LINK_EXEC_REFUSED_PREFIX));
  const lines = stdout.split("\n").filter((line) => line.startsWith(LINK_EXEC_RESULT_PREFIX));
  if (lines.length === 0 && refused.length === 1) {
    const reason = refused[0].slice(LINK_EXEC_REFUSED_PREFIX.length).trim();
    return /^[a-z_]{1,40}$/.test(reason) ? { status: "refused", reason } : null;
  }
  if (lines.length !== 1) return null;
  let value: unknown;
  try { value = JSON.parse(lines[0].slice(LINK_EXEC_RESULT_PREFIX.length)); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.status === "refused") {
    return typeof row.reason === "string" && /^[a-z_]{1,40}$/.test(row.reason) ? { status: "refused", reason: row.reason } : null;
  }
  if (row.status !== "ran" || !Number.isInteger(row.exitCode) || (row.exitCode as number) < 0 || (row.exitCode as number) > 255
      || typeof row.stdout !== "string" || !B64.test(row.stdout) || typeof row.stderr !== "string" || !B64.test(row.stderr)
      || typeof row.stdoutTruncated !== "boolean" || typeof row.stderrTruncated !== "boolean" || typeof row.timedOut !== "boolean"
      || !Number.isInteger(row.durationMs)) return null;
  const out = Buffer.from(row.stdout, "base64"), err = Buffer.from(row.stderr, "base64");
  if (out.length > LINK_EXEC_STDOUT_MAX || err.length > LINK_EXEC_STDERR_MAX) return null;
  return { status: "ran", exitCode: row.exitCode as number, stdout: out, stderr: err, stdoutTruncated: row.stdoutTruncated,
    stderrTruncated: row.stderrTruncated, timedOut: row.timedOut, durationMs: row.durationMs as number };
}
