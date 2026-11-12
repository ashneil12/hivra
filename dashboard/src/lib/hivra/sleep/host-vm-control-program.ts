// The host-side helper for fast nap and wake. One stdlib python3 program, run
// on the Proxmox host as `python3 -I -B -c "$PROGRAM" <op> <vmid> ...` by the
// scripts in ../agent-sleep-scripts.ts. Pure (no server imports) so the tests
// can run the program itself against fake QMP and guest agent sockets.
//
// Why it exists: `qm suspend`, `qm resume` and `qm guest exec` each spend about
// 0.6 s starting the qm CLI. QMP straight on /var/run/qemu-server/<vmid>.qmp
// takes milliseconds, and the guest agent socket next to it answers a guest exec
// in about 100 ms. Measured on a real host: a nap wake through these sockets
// takes about 1 s, against 2 to 3 s through the CLI.
//
// Ops (each prints exactly one line, "HIVRA_VM_CTL <json>", and exits 0):
//   qmp <vmid> stop|cont|status [timeout_s]
//       QMP greeting, qmp_capabilities, then the command, then query-status to
//       confirm (stop must end paused, cont must end running). Async events are
//       skipped by name, and every wait has a deadline.
//   fixup <vmid> <agent_wait_s>
//       The guest fixups after any wake, in ONE guest exec over the guest agent
//       socket: set the clock from the host (the guest cannot reach NTP and its
//       clock froze), hard-kill the tunnel (cloudflared never reconnects by
//       itself) and restart it. The host epoch is taken right before the exec is
//       sent. A guest that has not answered yet (just restored from disk) is
//       retried until the deadline. A socket failure falls back to a
//       timeout-wrapped `qm guest exec`. Access is serialised with a per-VM
//       flock, and every socket is closed in a finally.
//
// The receipt carries ok, a reason (lower case words), the QMP status where it
// applies, how the fixup ran (via), the number of tries, and step timings in
// ms. It never carries guest output.

export const HOST_VM_CONTROL_PREFIX = "HIVRA_VM_CTL ";

/** The one guest command for a wake. The epoch is filled in right before it is sent. */
export const WAKE_FIXUP_COMMAND_TEMPLATE =
  "date -s @<epoch> >/dev/null; systemctl kill -s SIGKILL hivra-cf-tunnel; systemctl restart hivra-cf-tunnel";

export const HOST_VM_CONTROL_PROGRAM = String.raw`import errno, fcntl, json, os, random, re, socket, subprocess, sys, time
# hivra-host-vm-control v1. Runs as root on the host. Never prints guest output.
QEMU_DIR = "/var/run/qemu-server"
LOCK_DIR = "/run/lock"
PREFIX = "HIVRA_VM_CTL "
FIXUP_TEMPLATE = "date -s @%s >/dev/null; systemctl kill -s SIGKILL hivra-cf-tunnel; systemctl restart hivra-cf-tunnel"
MAX_LINE = 4 * 1024 * 1024
SYNC_TIMEOUT = 1.0
CALL_TIMEOUT = 5.0
EXEC_TIMEOUT = 12.0
LOCK_WAIT = 5.0
FALLBACK_TIMEOUT = 12
RETRY_DELAY = 0.15
mono = time.monotonic


class Fail(Exception):
    def __init__(self, reason, terminal=False):
        Exception.__init__(self, reason)
        self.reason = reason
        self.terminal = terminal


def ms_since(t):
    return int((mono() - t) * 1000)


class Chan(object):
    """Line reader on a raw socket. Every wait is bounded by an absolute deadline."""

    def __init__(self, sock):
        self.sock = sock
        self.buf = b""

    def send(self, obj, deadline):
        data = (json.dumps(obj) + "\n").encode("utf-8")
        try:
            self.sock.settimeout(max(0.05, deadline - mono()))
            self.sock.sendall(data)
        except socket.timeout:
            raise Fail("timeout")
        except OSError:
            raise Fail("socket_error")

    def line(self, deadline):
        while b"\n" not in self.buf:
            left = deadline - mono()
            if left <= 0:
                raise Fail("timeout")
            try:
                self.sock.settimeout(left)
                chunk = self.sock.recv(65536)
            except socket.timeout:
                raise Fail("timeout")
            except OSError:
                raise Fail("socket_error")
            if not chunk:
                raise Fail("eof")
            self.buf += chunk
            if len(self.buf) > MAX_LINE:
                raise Fail("too_large")
        line, _, self.buf = self.buf.partition(b"\n")
        return line


def connect(path, deadline, retry):
    """Connects a unix socket. A missing socket is final; a busy one is retried when asked."""
    while True:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            s.settimeout(max(0.05, min(2.0, deadline - mono())))
            s.connect(path)
            return s
        except OSError as e:
            s.close()
            if e.errno in (errno.ENOENT, errno.ENOTDIR):
                raise Fail("socket_missing")
            transient = e.errno in (errno.ECONNREFUSED, errno.EAGAIN, errno.ECONNRESET, errno.EINTR) or isinstance(e, socket.timeout)
            if not (retry and transient) or mono() + RETRY_DELAY >= deadline:
                raise Fail("socket_error")
        time.sleep(RETRY_DELAY)


def loads(raw):
    try:
        value = json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        raise Fail("protocol")
    if not isinstance(value, dict):
        raise Fail("protocol")
    return value


# ---------------------------------------------------------------- QMP

def qmp_read(ch, deadline, want_id):
    """Next reply to our command. Async events are skipped by name, never by accident."""
    while True:
        msg = loads(ch.line(deadline))
        if "event" in msg:
            continue
        if "return" in msg or "error" in msg:
            if "id" in msg and msg["id"] != want_id:
                continue
            return msg
        raise Fail("protocol")


def qmp_run(ch, command, deadline, seq):
    want = "hivra-%d" % seq
    ch.send({"execute": command, "id": want}, deadline)
    msg = qmp_read(ch, deadline, want)
    if "error" in msg:
        raise Fail("qmp_error")
    return msg["return"]


def qmp_status(ch, deadline, seq):
    ret = qmp_run(ch, "query-status", deadline, seq)
    status = ret.get("status") if isinstance(ret, dict) else None
    if not isinstance(status, str) or not re.match(r"^[a-z_-]{1,24}$", status):
        raise Fail("protocol")
    return status


def op_qmp(vmid, action, timeout_s, rec):
    expected = {"stop": "paused", "cont": "running", "status": None}
    if action not in expected:
        raise Fail("usage")
    t0 = mono()
    deadline = t0 + timeout_s
    s = connect("%s/%s.qmp" % (QEMU_DIR, vmid), deadline, retry=(action != "status"))
    try:
        ch = Chan(s)
        greeting = loads(ch.line(deadline))
        if "QMP" not in greeting:
            raise Fail("protocol")
        rec["steps"]["connect"] = ms_since(t0)
        qmp_run(ch, "qmp_capabilities", deadline, 0)
        if action != "status":
            t1 = mono()
            qmp_run(ch, action, deadline, 1)
            rec["steps"]["command"] = ms_since(t1)
        t2 = mono()
        rec["status"] = qmp_status(ch, deadline, 2)
        rec["steps"]["query"] = ms_since(t2)
    finally:
        s.close()
    if expected[action] is not None and rec["status"] != expected[action]:
        raise Fail("unconfirmed")


# ---------------------------------------------------------------- guest agent

def sync(ch, deadline):
    sid = random.randint(1, 2 ** 31 - 1)
    ch.send({"execute": "guest-sync-delimited", "arguments": {"id": sid}}, deadline)
    while True:
        raw = ch.line(deadline).lstrip(b"\xff").strip()
        if not raw:
            continue
        try:
            msg = json.loads(raw.decode("utf-8", "replace"))
        except ValueError:
            continue  # stale bytes from an earlier session: discarded until our sync answer
        if isinstance(msg, dict) and msg.get("return") == sid:
            return


def qga_call(ch, payload, deadline):
    ch.send(payload, deadline)
    while True:
        raw = ch.line(deadline).lstrip(b"\xff").strip()
        if not raw:
            continue
        msg = loads(raw)
        if "return" in msg or "error" in msg:
            if "error" in msg:
                raise Fail("guest_error")
            return msg["return"]
        raise Fail("protocol")


def host_epoch():
    sec, nsec = divmod(time.time_ns(), 10 ** 9)
    return "%d.%09d" % (sec, nsec)


def qga_attempt(vmid, agent_deadline, rec):
    s = connect("%s/%s.qga" % (QEMU_DIR, vmid), agent_deadline, retry=False)
    try:
        ch = Chan(s)
        sync(ch, min(agent_deadline, mono() + SYNC_TIMEOUT))
        if "agent" not in rec["steps"]:
            rec["steps"]["agent"] = ms_since(rec["_t_agent"])
        rec["synced"] = True
        t1 = mono()
        # The clock the guest is given is the host's, read as late as possible.
        cmd = FIXUP_TEMPLATE % host_epoch()
        pid = qga_call(ch, {"execute": "guest-exec", "arguments": {
            "path": "/bin/sh", "arg": ["-c", cmd], "capture-output": False}}, mono() + CALL_TIMEOUT)
        if not isinstance(pid, dict) or not isinstance(pid.get("pid"), int):
            raise Fail("protocol")
        exec_deadline = mono() + EXEC_TIMEOUT
        delay = 0.02
        while True:
            # Once the command has been sent it may be running: a late answer is final, never a reason to send it again.
            if mono() >= exec_deadline:
                raise Fail("exec_timeout", terminal=True)
            try:
                st = qga_call(ch, {"execute": "guest-exec-status", "arguments": {"pid": pid["pid"]}},
                              min(exec_deadline, mono() + CALL_TIMEOUT))
            except Fail as e:
                if mono() >= exec_deadline:
                    raise Fail("exec_timeout", terminal=True)
                raise
            if isinstance(st, dict) and st.get("exited"):
                break
            time.sleep(delay)
            delay = min(0.1, delay * 1.5)
        rec["steps"]["exec"] = ms_since(t1)
        code = st.get("exitcode")
        rec["exitcode"] = code if isinstance(code, int) and not isinstance(code, bool) else None
        return rec["exitcode"] == 0
    finally:
        s.close()


def qm_fallback(vmid, rec):
    t1 = mono()
    cmd = FIXUP_TEMPLATE % host_epoch()
    argv = ["timeout", "-k", "2", str(FALLBACK_TIMEOUT + 3), "qm", "guest", "exec", vmid,
            "--timeout", str(FALLBACK_TIMEOUT), "--", "/bin/sh", "-c", cmd]
    try:
        p = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                           timeout=FALLBACK_TIMEOUT + 8)
        doc = json.loads(p.stdout.decode("utf-8", "replace"))
    except (OSError, ValueError, subprocess.SubprocessError):
        raise Fail("fixup_failed")
    finally:
        rec["steps"]["fallback"] = ms_since(t1)
    code = doc.get("exitcode") if isinstance(doc, dict) else None
    if not (isinstance(doc, dict) and doc.get("exited") and isinstance(code, int) and not isinstance(code, bool)):
        raise Fail("fixup_failed")
    rec["exitcode"] = code
    return code == 0


def take_lock(vmid):
    try:
        os.makedirs(LOCK_DIR, exist_ok=True)
        fd = os.open("%s/hivra-qga-%s.lock" % (LOCK_DIR, vmid), os.O_RDWR | os.O_CREAT, 0o600)
    except OSError:
        raise Fail("qga_lock_failed")
    end = mono() + LOCK_WAIT
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return fd
        except OSError:
            if mono() >= end:
                os.close(fd)
                raise Fail("qga_lock_busy")
            time.sleep(0.05)


def op_fixup(vmid, wait_s, rec):
    rec["via"] = "none"
    rec["tries"] = 0
    t_lock = mono()
    fd = take_lock(vmid)
    try:
        rec["steps"]["lock"] = ms_since(t_lock)
        rec["_t_agent"] = mono()
        agent_deadline = rec["_t_agent"] + wait_s
        while True:
            rec["tries"] += 1
            try:
                ok = qga_attempt(vmid, agent_deadline, rec)
                rec["via"] = "socket"
                if not ok:
                    raise Fail("tunnel_failed")
                return
            except Fail as e:
                if e.terminal or e.reason == "tunnel_failed":
                    raise
                if mono() + RETRY_DELAY >= agent_deadline:
                    break
            time.sleep(RETRY_DELAY)
        # The socket path did not work. The CLI uses the same agent, so it gets one try.
        try:
            ok = qm_fallback(vmid, rec)
        except Fail:
            raise Fail("fixup_failed" if rec.get("synced") else "agent_timeout")
        rec["via"] = "qm"
        if not ok:
            raise Fail("tunnel_failed")
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def main(argv):
    t0 = mono()
    op = argv[0] if argv else ""
    rec = {"op": op if re.match(r"^[a-z]{1,12}$", op) else "unknown", "steps": {}}
    reason = "ok"
    try:
        if len(argv) < 2 or not re.match(r"^[0-9]{3,9}$", argv[1]):
            raise Fail("usage")
        vmid = argv[1]
        if op == "qmp" and len(argv) in (3, 4):
            timeout_s = float(argv[3]) if len(argv) == 4 else 5.0
            if not 0.2 <= timeout_s <= 60:
                raise Fail("usage")
            rec["action"] = argv[2]
            op_qmp(vmid, argv[2], timeout_s, rec)
        elif op == "fixup" and len(argv) == 3:
            wait_s = float(argv[2])
            if not 0.2 <= wait_s <= 120:
                raise Fail("usage")
            op_fixup(vmid, wait_s, rec)
        else:
            raise Fail("usage")
    except Fail as e:
        reason = e.reason
    except ValueError:
        reason = "usage"
    except Exception:
        reason = "internal_error"
    rec.pop("_t_agent", None)
    rec.pop("synced", None)
    rec["ok"] = reason == "ok"
    rec["reason"] = reason
    rec["ms"] = ms_since(t0)
    sys.stdout.write(PREFIX + json.dumps(rec, separators=(",", ":"), sort_keys=True) + "\n")
    sys.stdout.flush()


main(sys.argv[1:])
`;

export type VmControlOp = "qmp" | "fixup";

export interface VmControlReceipt {
  op: string;
  ok: boolean;
  reason: string;
  ms: number;
  steps: Record<string, number>;
  /** QMP status after a qmp op. */
  status: string | null;
  /** How a fixup ran. */
  via: "socket" | "qm" | "none" | null;
  tries: number | null;
  exitcode: number | null;
}

const REASON = /^[a-z_]{1,40}$/;
const NAME = /^[a-z_]{1,24}$/;
const MS_MAX = 24 * 60 * 60 * 1000;

/** Strict read of the helper's one line: exactly one prefixed line holding one valid object, else null. */
export function parseVmControlReceipt(stdout: string): VmControlReceipt | null {
  if (typeof stdout !== "string") return null;
  const lines = stdout.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.startsWith(HOST_VM_CONTROL_PREFIX));
  if (lines.length !== 1) return null;
  let row: unknown;
  try { row = JSON.parse(lines[0].slice(HOST_VM_CONTROL_PREFIX.length)); } catch { return null; }
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const r = row as Record<string, unknown>;
  if (typeof r.ok !== "boolean" || typeof r.reason !== "string" || !REASON.test(r.reason)) return null;
  if (typeof r.op !== "string" || !NAME.test(r.op)) return null;
  if (!Number.isInteger(r.ms) || (r.ms as number) < 0 || (r.ms as number) > MS_MAX) return null;
  const steps = r.steps;
  if (!steps || typeof steps !== "object" || Array.isArray(steps)) return null;
  const timings: Record<string, number> = {};
  for (const [name, value] of Object.entries(steps as Record<string, unknown>)) {
    if (!NAME.test(name) || !Number.isInteger(value) || (value as number) < 0 || (value as number) > MS_MAX) return null;
    timings[name] = value as number;
  }
  const status = r.status === undefined ? null : r.status;
  if (status !== null && (typeof status !== "string" || !/^[a-z_-]{1,24}$/.test(status))) return null;
  const via = r.via === undefined ? null : r.via;
  if (via !== null && via !== "socket" && via !== "qm" && via !== "none") return null;
  const tries = r.tries === undefined ? null : r.tries;
  if (tries !== null && (!Number.isInteger(tries) || (tries as number) < 0 || (tries as number) > 100_000)) return null;
  const exitcode = r.exitcode === undefined || r.exitcode === null ? null : r.exitcode;
  if (exitcode !== null && (!Number.isInteger(exitcode) || (exitcode as number) < 0 || (exitcode as number) > 255)) return null;
  return {
    op: r.op, ok: r.ok, reason: r.reason, ms: r.ms as number, steps: timings,
    status: status as string | null, via: via as VmControlReceipt["via"], tries: tries as number | null,
    exitcode: exitcode as number | null,
  };
}
