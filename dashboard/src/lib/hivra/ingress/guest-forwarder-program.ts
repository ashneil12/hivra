// The guest half of host ingress: a host-only listener on the agent computer's
// port 18080 that forwards to the local web app on 127.0.0.1:8080.
//
// One python program, run as root through the VMID-bound guest exec (no SSH,
// no guest network trust), installs or removes two systemd units:
//
//   hivra-ingress.socket   ListenStream=0.0.0.0:18080, IPAddressDeny=any,
//                          IPAddressAllow=<default gateway>/32
//   hivra-ingress.service  systemd-socket-proxyd --exit-idle-time=60s
//                          127.0.0.1:8080, DynamicUser, ProtectSystem=strict
//
// Nothing new is installed in the guest. systemd-socket-proxyd ships in the
// systemd package; only when it is missing (or systemd is older than 246, which
// lacks --exit-idle-time) does the program write a small python3 stdlib
// forwarder instead and point the same service at it.
//
// The gateway is read in the guest from /proc/net/route, the same way the idle
// probe does, and must be one of the host bridge addresses the host script
// passes in. Nothing host-specific is in this file: the host script reads the
// bridge addresses at run time.
//
// Safety:
// - Idempotent. A second install with the same inputs writes nothing and
//   restarts nothing.
// - A unit file that exists with content Hivra did not write (its hash is not
//   the one recorded in /var/lib/hivra/ingress/forwarder.json) is never
//   overwritten or removed; the program refuses instead.
// - After starting, the program checks that the firewall is really enforced: a
//   connection from inside the guest to 127.0.0.1:18080 must not get through.
//   If it does (no cgroup BPF), the listener is stopped and disabled again.
// - Install never touches the guest tunnel, so any failure leaves the agent
//   reachable exactly as before.
//
// Every run prints exactly one "HIVRA_INGRESS_FWD <json>" line. Pure (no
// server imports) so the tests can run the program itself.

import { buildVmidBoundGuestExecPrelude } from "@/lib/hivra/vmid-bound-guest-exec";
import { shellQuote } from "@/lib/hivra/proxmox-target";

export const GUEST_FORWARDER_PREFIX = "HIVRA_INGRESS_FWD ";
export const GUEST_FORWARDER_REFUSED_PREFIX = "HIVRA_INGRESS_FWD_REFUSED ";
export const GUEST_FORWARDER_VERSION = 1;
/** The guest port the host proxy connects to. */
export const GUEST_FORWARDER_LISTEN_PORT = 18080;
/** The guest's local web app (hivra-chat). */
export const GUEST_FORWARDER_TARGET_PORT = 8080;
export const GUEST_FORWARDER_SOCKET_UNIT = "hivra-ingress.socket";
export const GUEST_FORWARDER_SERVICE_UNIT = "hivra-ingress.service";

/**
 * The stdlib fallback forwarder, used only where systemd-socket-proxyd is
 * missing or too old. It takes the socket-activated listener on fd 3, forwards
 * each connection to one local port, and exits after 60 s with no connection,
 * like `systemd-socket-proxyd --exit-idle-time=60s`.
 */
export const GUEST_FORWARDER_FALLBACK_SOURCE = String.raw`# Managed by Hivra (hivra-ingress v1). Fallback for systemd-socket-proxyd.
import os, socket, sys, threading, time
HOST, PORT, IDLE, MAX_CONNS = sys.argv[1], int(sys.argv[2]), 60.0, 256
if os.environ.get("LISTEN_FDS") != "1" or os.environ.get("LISTEN_PID") != str(os.getpid()): sys.exit(2)
listener = socket.socket(fileno=3)
listener.settimeout(1.0)
lock = threading.Lock()
state = {"live": 0, "last": time.monotonic()}
def pump(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data: break
            dst.sendall(data)
    except OSError: pass
    try: dst.shutdown(socket.SHUT_WR)
    except OSError: pass
def serve(conn):
    try:
        try: up = socket.create_connection((HOST, PORT), timeout=5)
        except OSError: return
        try:
            up.settimeout(None)
            back = threading.Thread(target=pump, args=(up, conn), daemon=True)
            back.start()
            pump(conn, up)
            back.join()
        finally: up.close()
    finally:
        conn.close()
        with lock:
            state["live"] -= 1
            state["last"] = time.monotonic()
while True:
    try: conn, _ = listener.accept()
    except socket.timeout:
        with lock:
            if state["live"] == 0 and time.monotonic() - state["last"] >= IDLE: sys.exit(0)
        continue
    except OSError:
        time.sleep(0.1)
        continue
    conn.settimeout(None)
    with lock:
        if state["live"] >= MAX_CONNS:
            conn.close()
            continue
        state["live"] += 1
    threading.Thread(target=serve, args=(conn,), daemon=True).start()
`;

/**
 * argv: `install <allowed gateway addresses, comma separated>` or `remove`.
 * Exits 0 with one result line for every handled outcome; an unexpected error
 * still prints one line (reason "internal") and exits 3.
 */
export const GUEST_FORWARDER_PROGRAM = String.raw`import fcntl, hashlib, ipaddress, json, os, re, signal, socket, stat, struct, subprocess, sys, time
# hivra-ingress-forwarder v1. Runs as root via the guest agent.
class _Timeout(BaseException): pass
def _alarm(*_): raise _Timeout()
signal.signal(signal.SIGALRM, _alarm)
signal.alarm(30)
T0 = time.monotonic()
PREFIX = "${GUEST_FORWARDER_PREFIX}"
UNIT_DIR = "/etc/systemd/system"
STATE_DIR = "/var/lib/hivra/ingress"
FALLBACK_DIR = "/usr/local/lib/hivra-ingress"
ROUTE_FILE = "/proc/net/route"
TCP_FILE = "/proc/net/tcp"
SYSTEMCTL = "/usr/bin/systemctl"
PROXYD = ("/usr/lib/systemd/systemd-socket-proxyd", "/lib/systemd/systemd-socket-proxyd")
PYTHON = "/usr/bin/python3"
LISTEN_PORT = ${GUEST_FORWARDER_LISTEN_PORT}
TARGET_PORT = ${GUEST_FORWARDER_TARGET_PORT}
SOCKET_UNIT = "${GUEST_FORWARDER_SOCKET_UNIT}"
SERVICE_UNIT = "${GUEST_FORWARDER_SERVICE_UNIT}"
FALLBACK_SOURCE = ${JSON.stringify(GUEST_FORWARDER_FALLBACK_SOURCE)}
SOCKET_PATH = UNIT_DIR + "/" + SOCKET_UNIT
SERVICE_PATH = UNIT_DIR + "/" + SERVICE_UNIT
FALLBACK_PATH = FALLBACK_DIR + "/forward.py"
MANIFEST = STATE_DIR + "/forwarder.json"
os.environ["PATH"] = "/usr/sbin:/usr/bin:/sbin:/bin"
OUT = {"v": ${GUEST_FORWARDER_VERSION}, "op": None, "ok": False}
def done(ok, reason=None, code=0):
    signal.alarm(0)
    OUT["ok"] = ok
    if reason: OUT["reason"] = reason
    OUT["ms"] = int((time.monotonic() - T0) * 1000)
    sys.stdout.write(PREFIX + json.dumps(OUT, sort_keys=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()
    os._exit(code)
class Refuse(Exception): pass
def run(*args):
    try:
        r = subprocess.run([SYSTEMCTL] + list(args), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                           timeout=15, check=False, env={"PATH": os.environ["PATH"], "LC_ALL": "C"})
    except (OSError, subprocess.SubprocessError): return 127, ""
    return r.returncode, r.stdout.decode("utf-8", "replace")
def systemd_version():
    rc, out = run("--version")
    m = re.match(r"systemd (\d+)", out)
    if rc != 0 or not m: raise Refuse("systemd_unknown")
    return int(m.group(1))
def read_small(path, n=1 << 20):
    try: st = os.lstat(path)
    except FileNotFoundError: return None
    if not stat.S_ISREG(st.st_mode): raise Refuse("foreign_file")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        chunks = []
        while True:
            b = os.read(fd, 65536)
            if not b: break
            chunks.append(b)
            if sum(len(c) for c in chunks) > n: raise Refuse("foreign_file")
        return b"".join(chunks)
    finally: os.close(fd)
def read_proc(path):
    with open(path, "rb") as f: return f.read(4 << 20).decode("ascii", "replace")
def sha(b): return hashlib.sha256(b).hexdigest()
# ---- the default gateway, read the same way as the idle probe ----
def gateway():
    found = set()
    for ln in read_proc(ROUTE_FILE).splitlines()[1:]:
        c = ln.split()
        try:
            if len(c) > 7 and c[1] == "00000000" and c[7] == "00000000" and int(c[3], 16) & 2: found.add(c[2])
        except ValueError: raise Refuse("gateway_invalid")
    if not found: raise Refuse("gateway_missing")
    if len(found) != 1: raise Refuse("gateway_ambiguous")
    h = found.pop()
    if not re.fullmatch(r"[0-9A-Fa-f]{8}", h): raise Refuse("gateway_invalid")
    ip = ipaddress.IPv4Address(socket.inet_ntoa(struct.pack("=I", int(h, 16))))
    if ip.is_unspecified or ip.is_loopback or ip.is_multicast or ip.is_link_local or ip.is_reserved or str(ip) == "255.255.255.255":
        raise Refuse("gateway_invalid")
    return str(ip)
def allowed_gateways(arg):
    out = set()
    for part in (arg or "").split(","):
        if not part: continue
        if not re.fullmatch(r"\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}", part): raise Refuse("gateway_unverified")
        try: out.add(str(ipaddress.IPv4Address(part)))
        except ValueError: raise Refuse("gateway_unverified")
    if not out or len(out) > 16: raise Refuse("gateway_unverified")
    return out
def listening():
    want = "00000000:%04X" % LISTEN_PORT
    for ln in read_proc(TCP_FILE).splitlines()[1:]:
        c = ln.split()
        if len(c) > 3 and c[1].upper() == want and c[3] == "0A": return True
    return False
# ---- unit text ----
HEADER = "# Managed by Hivra (hivra-ingress v1). Edits are refused: the next install will not overwrite a changed file.\n"
def socket_unit(gw):
    return (HEADER + "[Unit]\nDescription=Hivra host ingress listener\n\n[Socket]\n"
            "ListenStream=0.0.0.0:%d\nBacklog=128\nNoDelay=yes\nIPAddressDeny=any\nIPAddressAllow=%s/32\n\n"
            "[Install]\nWantedBy=sockets.target\n" % (LISTEN_PORT, gw)).encode()
def service_unit(exec_start):
    return (HEADER + "[Unit]\nDescription=Hivra host ingress forwarder\nRequires=%s\nAfter=%s\n\n[Service]\n"
            "ExecStart=%s\nDynamicUser=yes\nProtectSystem=strict\nProtectHome=yes\nPrivateTmp=yes\nPrivateDevices=yes\n"
            "NoNewPrivileges=yes\nCapabilityBoundingSet=\nAmbientCapabilities=\nRestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX\n"
            "RestrictNamespaces=yes\nRestrictRealtime=yes\nLockPersonality=yes\nMemoryDenyWriteExecute=yes\n"
            "ProtectKernelTunables=yes\nProtectKernelModules=yes\nProtectControlGroups=yes\nSystemCallArchitectures=native\n"
            "IPAddressDeny=any\nIPAddressAllow=localhost\nTasksMax=300\nMemoryMax=128M\n" % (SOCKET_UNIT, SOCKET_UNIT, exec_start)).encode()
def forwarder_kind(version):
    for p in PROXYD:
        if version >= 246 and os.path.isfile(p) and os.access(p, os.X_OK):
            return "proxyd", "%s --exit-idle-time=60s 127.0.0.1:%d" % (p, TARGET_PORT)
    if os.path.isfile(PYTHON) and os.access(PYTHON, os.X_OK):
        return "python", "%s -I -B %s 127.0.0.1 %d" % (PYTHON, FALLBACK_PATH, TARGET_PORT)
    raise Refuse("no_forwarder")
# ---- files Hivra wrote: their hashes are kept so a changed file is never overwritten ----
def load_manifest():
    try: b = read_small(MANIFEST, 65536)
    except Refuse: return {}
    if b is None: return {}
    try: m = json.loads(b.decode("utf-8"))
    except ValueError: return {}
    files = m.get("files") if isinstance(m, dict) else None
    return {k: v for k, v in files.items() if isinstance(k, str) and isinstance(v, str)} if isinstance(files, dict) else {}
def put(path, data, mode):
    d = os.path.dirname(path)
    os.makedirs(d, mode=0o755, exist_ok=True)
    tmp = path + ".hivra-tmp"
    try: os.unlink(tmp)
    except FileNotFoundError: pass
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        os.fchmod(fd, mode)
        view = memoryview(data)
        while view: view = view[os.write(fd, view):]
        os.fsync(fd)
    finally: os.close(fd)
    os.replace(tmp, path)
def save_manifest(files):
    os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
    os.chmod(STATE_DIR, 0o700)
    put(MANIFEST, json.dumps({"v": 1, "files": files}, sort_keys=True).encode(), 0o600)
def ours(path, current, manifest):
    return current is not None and manifest.get(path) == sha(current)
def stop_all():
    run("disable", "--now", SOCKET_UNIT)
    run("stop", SERVICE_UNIT)
    run("stop", SOCKET_UNIT)
def wait_listening(want, seconds):
    end = time.monotonic() + seconds
    while True:
        if listening() == want: return True
        if time.monotonic() >= end: return False
        time.sleep(0.05)
def firewall_enforced():
    # From inside the guest, loopback is not the gateway: the socket's own
    # firewall must drop this connection. Refused or timed out both mean it
    # did not get through.
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(1.0)
    try:
        s.connect(("127.0.0.1", LISTEN_PORT))
        return False
    except (socket.timeout, ConnectionRefusedError): return True
    except OSError: return True
    finally: s.close()
def install(arg):
    OUT["op"] = "install"
    allowed = allowed_gateways(arg)
    version = systemd_version()
    OUT["systemd"] = version
    if version < 235: raise Refuse("systemd_too_old")
    gw = gateway()
    if gw not in allowed: raise Refuse("gateway_mismatch")
    OUT["gateway"] = gw
    kind, exec_start = forwarder_kind(version)
    OUT["kind"] = kind
    OUT["port"] = LISTEN_PORT
    desired = {SOCKET_PATH: (socket_unit(gw), 0o644), SERVICE_PATH: (service_unit(exec_start), 0o644)}
    if kind == "python": desired[FALLBACK_PATH] = (FALLBACK_SOURCE.encode(), 0o644)
    manifest = load_manifest()
    current = {p: read_small(p) for p in desired}
    for p, (data, _) in desired.items():
        c = current[p]
        if c is not None and c != data and not ours(p, c, manifest):
            OUT["file"] = os.path.basename(p)
            raise Refuse("foreign_file")
    changed = [p for p, (data, _) in desired.items() if current[p] != data]
    stale = []
    if kind == "proxyd":
        old = read_small(FALLBACK_PATH)
        if old is not None and ours(FALLBACK_PATH, old, manifest): stale.append(FALLBACK_PATH)
    OUT["changed"] = bool(changed)
    # A listener that was already serving is left running after a failure that
    # is not a security failure: the agent may depend on it. Anything new is
    # stopped again.
    was_active = run("is-active", SOCKET_UNIT)[1].strip() == "active"
    try:
        for p in changed:
            data, mode = desired[p]
            put(p, data, mode)
        files = {p: sha(data) for p, (data, _) in desired.items()}
        save_manifest(files)
        if changed:
            if run("daemon-reload")[0] != 0: raise Refuse("daemon_reload_failed")
            run("stop", SERVICE_UNIT)
            run("stop", SOCKET_UNIT)
        if run("enable", SOCKET_UNIT)[0] != 0: raise Refuse("enable_failed")
        if run("start", SOCKET_UNIT)[0] != 0: raise Refuse("start_failed")
        if run("is-active", SOCKET_UNIT)[1].strip() != "active": raise Refuse("not_active")
        if not wait_listening(True, 3): raise Refuse("not_listening")
        if not firewall_enforced(): raise Refuse("firewall_unenforced")
    except BaseException as e:
        if not was_active or (isinstance(e, Refuse) and e.args[0] == "firewall_unenforced"):
            stop_all()
            OUT["rolledBack"] = True
        raise
    for p in stale:
        try: os.unlink(p)
        except FileNotFoundError: pass
def remove():
    OUT["op"] = "remove"
    manifest = load_manifest()
    stop_all()
    run("reset-failed", SOCKET_UNIT, SERVICE_UNIT)
    left = []
    removed = False
    for p in (SOCKET_PATH, SERVICE_PATH, FALLBACK_PATH):
        try: c = read_small(p)
        except Refuse: c = b""
        if c is None: continue
        if ours(p, c, manifest):
            os.unlink(p)
            removed = True
        else: left.append(os.path.basename(p))
    if removed and run("daemon-reload")[0] != 0: raise Refuse("daemon_reload_failed")
    OUT["removed"] = removed
    if left:
        OUT["left"] = left
        raise Refuse("foreign_file")
    try: os.unlink(MANIFEST)
    except FileNotFoundError: pass
    if not wait_listening(False, 3): raise Refuse("still_listening")
def main():
    op = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
        lock = os.open(STATE_DIR + "/lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        if op == "install" and len(sys.argv) == 3: install(sys.argv[2])
        elif op == "remove" and len(sys.argv) == 2: remove()
        else: raise Refuse("usage")
    except Refuse as e: done(False, e.args[0])
    except _Timeout: done(False, "timeout")
    except BaseException: done(False, "internal", 3)
    done(True)
main()
`;

export type GuestForwarderOp = "install" | "remove";

export type GuestForwarderResult =
  | {
    refused: false;
    v: number;
    op: GuestForwarderOp;
    ok: boolean;
    reason?: string;
    ms: number;
    kind?: "proxyd" | "python";
    gateway?: string;
    port?: number;
    systemd?: number;
    changed?: boolean;
    removed?: boolean;
    rolledBack?: boolean;
    left?: string[];
    file?: string;
  }
  | { refused: true; reason: string };

const MIN_VMID = 100;
const MAX_VMID = 999_999_999;
/** The host's own qm calls are cut off after this long. The program gives up at 30 s. */
const GUEST_FORWARDER_QM_TIMEOUT_SECONDS = 45;
const QGA_LOCK_WAIT_SECONDS = 30;

function assertTarget(vmid: number, bindingTag: string | null): string {
  if (!Number.isSafeInteger(vmid) || vmid < MIN_VMID || vmid > MAX_VMID) {
    throw new Error("Invalid guest forwarder VMID.");
  }
  if (typeof bindingTag !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(bindingTag)) {
    throw new Error("The guest forwarder needs the computer's exact binding tag.");
  }
  return bindingTag;
}

/**
 * Host script that installs or removes the guest forwarder in one exact,
 * plainly running VM. For an install it reads the VM's bridge from `net0` and
 * passes that bridge's own IPv4 addresses to the guest, which must find one of
 * them as its default gateway. Refusals print one HIVRA_INGRESS_FWD_REFUSED
 * line; otherwise the guest's one HIVRA_INGRESS_FWD line is passed through.
 * Run it with runProxmoxHostScript (the script arrives on stdin).
 */
export function buildGuestForwarderHostScript(
  target: { vmid: number; bindingTag: string | null },
  op: GuestForwarderOp,
): string {
  const tag = assertTarget(target.vmid, target.bindingTag);
  if (op !== "install" && op !== "remove") throw new Error("Invalid guest forwarder operation.");
  const gateways = op === "install" ? `NET0="$(printf '%s\\n' "$CONFIG" | sed -n 's/^net0:[[:space:]]*//p' | head -n 1)" || NET0=""
BRIDGE="$(printf '%s\\n' "$NET0" | tr ',' '\\n' | sed -n 's/^bridge=//p' | head -n 1)" || BRIDGE=""
[[ "$BRIDGE" =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || refuse bridge_unknown
GATEWAYS="$(ip -4 -o addr show dev "$BRIDGE" 2>/dev/null | awk '{ split($4, a, "/"); print a[1] }' | paste -sd, -)" || GATEWAYS=""
[[ "$GATEWAYS" =~ ^[0-9.,]{7,}$ ]] || refuse bridge_address_unknown
` : "";
  const args = op === "install" ? `install "$GATEWAYS"` : "remove";
  return `set -euo pipefail
VMID=${target.vmid}
EXPECTED_BINDING_TAG=${shellQuote(tag)}
# The host script itself arrives on stdin, so no command may read it.
qm() { command timeout -k 5 ${GUEST_FORWARDER_QM_TIMEOUT_SECONDS} qm "$@" </dev/null; }
refuse() { printf '${GUEST_FORWARDER_REFUSED_PREFIX}%s\\n' "$1"; exit 0; }
[ -n "$EXPECTED_BINDING_TAG" ] || refuse binding_missing
CONFIG="$(qm config "$VMID" 2>/dev/null)" || refuse unreachable
printf '%s\\n' "$CONFIG" | sed -n 's/^tags:[[:space:]]*//p' | tr ';' '\\n' | grep -Fx -- "$EXPECTED_BINDING_TAG" >/dev/null \\
  || refuse binding_mismatch
VERBOSE="$(qm status "$VMID" --verbose 2>/dev/null)" || refuse unreachable
STATUS="$(printf '%s\\n' "$VERBOSE" | awk '$1=="status:" {print $2; exit}')"
QMPSTATUS="$(printf '%s\\n' "$VERBOSE" | awk '$1=="qmpstatus:" {print $2; exit}')"
LOCK="$(printf '%s\\n' "$CONFIG" | awk '$1=="lock:" {print $2; exit}')"
case "$STATUS/\${QMPSTATUS:-none}/\${LOCK:-none}" in
  running/running/none) ;;
  running/paused/none|stopped/*/suspended) refuse asleep ;;
  stopped/*/none) refuse not_running ;;
  *) refuse unexpected_state ;;
esac
${gateways}PROGRAM=${shellQuote(GUEST_FORWARDER_PROGRAM)}
${buildVmidBoundGuestExecPrelude()}
qm() { command timeout -k 5 ${GUEST_FORWARDER_QM_TIMEOUT_SECONDS} qm "$@" </dev/null; }
install -d -m 0755 /run/lock
exec 7>/run/lock/hivra-qga-${target.vmid}.lock
flock -x -w ${QGA_LOCK_WAIT_SECONDS} 7 || refuse guest_busy
OUT="$(run_vmid_bound_guest_exec_stdin /usr/bin/python3 -I -B -c "$PROGRAM" ${args} 2>/dev/null)" || refuse guest_failed
printf '%s\\n' "$OUT"
`;
}

const REASON = /^[a-z_]{1,40}$/;
const FILE_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/** Strict read of a guest forwarder run. Anything but exactly one well-formed line is null. */
export function parseGuestForwarderOutput(stdout: string): GuestForwarderResult | null {
  if (typeof stdout !== "string") return null;
  const lines = stdout.split("\n").map((line) => line.replace(/\r$/, ""));
  const refused = lines.filter((line) => line.startsWith(GUEST_FORWARDER_REFUSED_PREFIX));
  const results = lines.filter((line) => line.startsWith(GUEST_FORWARDER_PREFIX));
  if (refused.length > 0) {
    const reason = refused[0].slice(GUEST_FORWARDER_REFUSED_PREFIX.length);
    return refused.length === 1 && REASON.test(reason) ? { refused: true, reason } : null;
  }
  if (results.length !== 1) return null;
  let value: unknown;
  try { value = JSON.parse(results[0].slice(GUEST_FORWARDER_PREFIX.length)); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.v !== GUEST_FORWARDER_VERSION || (v.op !== "install" && v.op !== "remove") || typeof v.ok !== "boolean") return null;
  if (!Number.isSafeInteger(v.ms) || (v.ms as number) < 0) return null;
  if (v.reason !== undefined && (typeof v.reason !== "string" || !REASON.test(v.reason))) return null;
  if (v.ok === false && v.reason === undefined) return null;
  if (v.kind !== undefined && v.kind !== "proxyd" && v.kind !== "python") return null;
  if (v.gateway !== undefined && (typeof v.gateway !== "string" || !/^\d{1,3}(\.\d{1,3}){3}$/.test(v.gateway))) return null;
  if (v.port !== undefined && v.port !== GUEST_FORWARDER_LISTEN_PORT) return null;
  if (v.systemd !== undefined && (!Number.isSafeInteger(v.systemd) || (v.systemd as number) < 0)) return null;
  for (const flag of ["changed", "removed", "rolledBack"] as const) {
    if (v[flag] !== undefined && typeof v[flag] !== "boolean") return null;
  }
  if (v.left !== undefined && (!Array.isArray(v.left) || !v.left.every((f) => typeof f === "string" && FILE_NAME.test(f)))) return null;
  if (v.file !== undefined && (typeof v.file !== "string" || !FILE_NAME.test(v.file))) return null;
  if (v.ok === true && v.op === "install" && (v.kind === undefined || v.gateway === undefined || v.port === undefined)) return null;
  const known = new Set(["v", "op", "ok", "reason", "ms", "kind", "gateway", "port", "systemd", "changed", "removed", "rolledBack", "left", "file"]);
  if (Object.keys(v).some((key) => !known.has(key))) return null;
  return { refused: false, ...(v as Omit<Extract<GuestForwarderResult, { refused: false }>, "refused">) };
}
