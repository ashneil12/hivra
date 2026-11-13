// A fake Proxmox host for running the sleep and wake scripts for real: stub
// qm, flock, timeout, systemd-run, lvs and sleep binaries on PATH, a temp
// directory standing in for /run, and a fake QEMU that answers QMP and the
// guest agent on unix sockets in a temp directory standing in for
// /var/run/qemu-server. Both read and write the same state file. Test support only.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const TAG = `hivra-bind-${"a".repeat(32)}`;
export const VMID = 1234;

export interface HostState {
  status: "running" | "stopped";
  /** Empty means the line is not printed (a stopped computer). */
  qmp: string;
  lock: string;
  tags: string;
  memory: number;
  onboot: number;
  vmstate: boolean;
  /** Behaviour switches. */
  suspendFail?: boolean;
  suspendNoop?: boolean;
  hibernateFail?: boolean;
  resumeFail?: boolean;
  startFail?: boolean;
  startNoop?: boolean;
  setFail?: boolean;
  pingFail?: boolean;
  /** qm config fails, as for a VM this host does not have. */
  configFail?: boolean;
  /** QMP: refuse connections, fail or ignore a stop or a cont. */
  qmpDown?: boolean;
  qmpStopFail?: boolean;
  qmpStopNoop?: boolean;
  qmpContFail?: boolean;
  qmpContNoop?: boolean;
  /** Guest agent socket: close every connection, or stay silent for the first N connections (a guest still booting). */
  qgaDown?: boolean;
  qgaSilentConnects?: number;
  /** A guest command containing this text exits 1. */
  execFailMatch?: string;
  /** What the guest prints for the probe program. */
  probeStdout?: string;
  lvsPercent?: string;
  lvsSizeMb?: string;
  lvsMissing?: boolean;
  lvsRaw?: string;
}

export const AWAKE: HostState = {
  status: "running", qmp: "running", lock: "", tags: TAG, memory: 4096, onboot: 1, vmstate: false,
  lvsPercent: "40.00", lvsSizeMb: "100000.00",
};
export const NAPPING: HostState = { ...AWAKE, qmp: "paused" };
export const HIBERNATED: HostState = { ...AWAKE, status: "stopped", qmp: "", lock: "suspended", vmstate: true, onboot: 0 };
export const COLD: HostState = { ...AWAKE, status: "stopped", qmp: "" };

const QM = String.raw`#!/usr/bin/env python3
import json, os, sys
d = os.environ["STUB_DIR"]
p = os.path.join(d, "state.json")
s = json.load(open(p))
a = sys.argv[1:]
open(os.path.join(d, "calls.log"), "a").write("qm " + " ".join(a) + "\n")
def save(): json.dump(s, open(p, "w"))
def out(t): sys.stdout.write(t + "\n")
if a[0] == "status":
    out("status: " + s["status"])
    if "--verbose" in a and s["qmp"]: out("qmpstatus: " + s["qmp"])
elif a[0] == "config":
    if s.get("configFail"): sys.exit(2)
    out("boot: order=scsi0")
    out("cores: 2")
    out("ide2: local-lvm:vm-%s-cloudinit,media=cdrom" % a[1])
    out("memory: %d" % s["memory"])
    out("onboot: %d" % s["onboot"])
    out("scsi0: local-lvm:vm-%s-disk-0,iothread=1,size=20G" % a[1])
    out("tags: " + s["tags"])
    if s["lock"]: out("lock: " + s["lock"])
    if s["vmstate"]: out("vmstate: local-lvm:vm-%s-state-suspend" % a[1])
elif a[0] == "suspend":
    if "--todisk" in a:
        if s.get("hibernateFail"): sys.exit(1)
        s.update(status="stopped", qmp="", lock="suspended", vmstate=True)
    else:
        if s.get("suspendFail"): sys.exit(1)
        if not s.get("suspendNoop"): s["qmp"] = "paused"
    save()
elif a[0] == "resume":
    if s.get("resumeFail"): sys.exit(1)
    s["qmp"] = "running"; save()
elif a[0] == "start":
    if s.get("startFail"): sys.exit(1)
    if not s.get("startNoop"): s.update(status="running", qmp="running", lock="", vmstate=False)
    save()
elif a[0] == "set":
    if s.get("setFail"): sys.exit(1)
    if "--onboot" in a: s["onboot"] = int(a[a.index("--onboot") + 1])
    save()
elif a[0] == "guest" and a[1] == "cmd":
    sys.exit(1 if s.get("pingFail") else 0)
elif a[0] == "guest" and a[1] == "exec":
    if s.get("pingFail"): sys.exit(1)
    rest = a[a.index("--") + 1:]
    text = " ".join(rest)
    if rest[0].endswith("python3"):
        data, code = s.get("probeStdout") or "", 0 if s.get("probeStdout") is not None else 1
    else:
        data, code = "", 1 if s.get("execFailMatch") and s["execFailMatch"] in text else 0
    open(os.path.join(d, "calls.log"), "a").write("guest " + (rest[0] if rest[0].endswith("python3") else text) + "\n")
    out(json.dumps({"exited": 1, "exitcode": code, "out-data": data}))
else:
    sys.exit(2)
`;

const LVS = String.raw`#!/usr/bin/env python3
import json, os, sys
d = os.environ["STUB_DIR"]
s = json.load(open(os.path.join(d, "state.json")))
a = sys.argv[1:]
open(os.path.join(d, "calls.log"), "a").write("lvs " + " ".join(a) + "\n")
if s.get("lvsRaw") is not None: sys.stdout.write(s["lvsRaw"]); sys.exit(0)
if "vg_name,pool_lv,lv_name" in a:
    if not s.get("lvsMissing"): print("  pve|data|vm-1234-disk-0")
    print("  pve||swap")
elif "lv_size,data_percent" in a:
    print("  %s|%s" % (s["lvsSizeMb"], s["lvsPercent"]))
else: sys.exit(2)
`;

// A fake QEMU. Daemonises once both sockets are listening. The QMP side sends
// async events ahead of the replies, as the real one does.
const FAKE_QEMU = String.raw`#!/usr/bin/env python3
import json, os, socketserver, sys, threading, time
d, qdir, vmid = sys.argv[1], sys.argv[2], sys.argv[3]
SP = os.path.join(d, "state.json")
def load(): return json.load(open(SP))
def save(s): json.dump(s, open(SP, "w"))
def log(t): open(os.path.join(d, "calls.log"), "a").write(t + "\n")
conns = {"qga": 0}
lock = threading.Lock()

class Qmp(socketserver.StreamRequestHandler):
    def handle(self):
        s = load()
        if s["status"] != "running" or s.get("qmpDown"): return
        w = self.wfile
        def out(o): w.write((json.dumps(o) + "\n").encode()); w.flush()
        out({"QMP": {"version": {"qemu": {"major": 9}}, "capabilities": ["oob"]}})
        for raw in self.rfile:
            req = json.loads(raw)
            cmd, rid = req["execute"], req.get("id")
            s = load()
            def reply(o):
                if rid is not None: o["id"] = rid
                out(o)
            if cmd == "qmp_capabilities": reply({"return": {}})
            elif cmd == "query-status":
                reply({"return": {"status": s["qmp"], "running": s["qmp"] == "running", "singlestep": False}})
            elif cmd in ("stop", "cont"):
                log("qmp " + cmd)
                out({"timestamp": {"seconds": 1, "microseconds": 2}, "event": "STOP" if cmd == "stop" else "RESUME"})
                if s.get("qmpStopFail" if cmd == "stop" else "qmpContFail"):
                    reply({"error": {"class": "GenericError", "desc": "refused"}}); continue
                if not s.get("qmpStopNoop" if cmd == "stop" else "qmpContNoop"):
                    s["qmp"] = "paused" if cmd == "stop" else "running"; save(s)
                reply({"return": {}})
            else: reply({"error": {"class": "CommandNotFound", "desc": "no"}})

class Qga(socketserver.StreamRequestHandler):
    def handle(self):
        s = load()
        with lock:
            conns["qga"] += 1
            n = conns["qga"]
        if s["status"] != "running" or s.get("qgaDown"): return
        w = self.wfile
        silent = n <= s.get("qgaSilentConnects", 0)
        def out(o): w.write(b"\xff" + (json.dumps(o) + "\n").encode()); w.flush()
        polls = 0
        for raw in self.rfile:
            if silent: continue
            req = json.loads(raw)
            cmd, args = req["execute"], req.get("arguments", {})
            if cmd == "guest-sync-delimited": out({"return": args["id"]})
            elif cmd == "guest-exec":
                text = args["arg"][-1]
                log("qga exec " + text)
                code = 1 if s.get("execFailMatch") and s["execFailMatch"] in text else 0
                polls = 0
                out({"return": {"pid": 4242}})
            elif cmd == "guest-exec-status":
                polls += 1
                out({"return": {"exited": False}} if polls < 2 else {"return": {"exited": True, "exitcode": code}})
            else: out({"error": {"class": "CommandNotFound", "desc": "no"}})

class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

os.makedirs(qdir, exist_ok=True)
paths = [os.path.join(qdir, vmid + ".qmp"), os.path.join(qdir, vmid + ".qga")]
if os.fork():
    for _ in range(500):
        if all(os.path.exists(p) for p in paths): sys.exit(0)
        time.sleep(0.01)
    sys.exit(1)
os.setsid()
devnull = os.open(os.devnull, os.O_RDWR)
for fd in (0, 1, 2): os.dup2(devnull, fd)
open(os.path.join(d, "qemu.pid"), "w").write(str(os.getpid()))
a, b = Server(paths[0], Qmp), Server(paths[1], Qga)
threading.Thread(target=a.serve_forever, daemon=True).start()
b.serve_forever()
`;

const TIMEOUT = `#!/usr/bin/env bash
# stub timeout: log the limit, optionally pretend it expired, else run the command
[ "$1" = "-k" ] && shift 2
echo "timeout $1" >> "$STUB_DIR/calls.log"
dur="$1"; shift
if [ -n "\${STUB_TIMEOUT_EXPIRES:-}" ] && [ "$dur" = "\$STUB_TIMEOUT_EXPIRES" ]; then exit 124; fi
exec "$@"
`;

const FLOCK = `#!/usr/bin/env bash
echo "flock $*" >> "$STUB_DIR/calls.log"
case "$*" in
  "-x -n 9"|"-x -w 15 9") [ -z "\${STUB_FLOCK_BUSY:-}" ] || exit 1 ;;
  "-w 60 8") [ -z "\${STUB_FLOCK_TIMEOUT:-}" ] || exit 1 ;;
esac
exit 0
`;

const SYSTEMD_RUN = `#!/usr/bin/env bash
echo "systemd-run $*" >> "$STUB_DIR/calls.log"
while [ "\${1#--}" != "$1" ]; do shift; done
exec "$@"
`;

const SLEEP = "#!/usr/bin/env bash\nexit 0\n";

const ADMISSION = `#!/usr/bin/env bash
echo "admission $*" >> "$STUB_DIR/calls.log"
if [ -n "\${STUB_ADMISSION_QM:-}" ]; then
  echo "admission-qm-config $(qm config "$1" | tr '\\n' ';')" >> "$STUB_DIR/calls.log"
  echo "admission-qm-status $(qm status "$1")" >> "$STUB_DIR/calls.log"
fi
[ -z "\${STUB_ADMISSION_REFUSES:-}" ] || { echo "not enough memory" >&2; exit 1; }
exit 0
`;

export interface HostRun {
  status: number | null;
  stdout: string;
  stderr: string;
  calls: string[];
  state: HostState;
  /** Where the fake /run lives. */
  runDir: string;
}

export interface HostHarness {
  readonly dir: string;
  readonly provisionerDir: string;
  run(script: string, state: HostState, env?: Record<string, string>): HostRun;
  cleanup(): void;
}

export function makeHostHarness(): HostHarness {
  const dir = mkdtempSync(path.join(tmpdir(), "hivra-sleep-host-"));
  const bin = path.join(dir, "bin");
  const provisionerDir = path.join(dir, "provisioner");
  mkdirSync(bin);
  mkdirSync(provisionerDir);
  const put = (file: string, body: string) => { writeFileSync(file, body); chmodSync(file, 0o755); };
  const qemu = path.join(dir, "fake-qemu.py");
  put(qemu, FAKE_QEMU);
  put(path.join(bin, "qm"), QM);
  put(path.join(bin, "lvs"), LVS);
  put(path.join(bin, "timeout"), TIMEOUT);
  put(path.join(bin, "flock"), FLOCK);
  put(path.join(bin, "systemd-run"), SYSTEMD_RUN);
  put(path.join(bin, "sleep"), SLEEP);
  put(path.join(provisionerDir, "hivra-host-capacity-admission"), ADMISSION);
  return {
    dir,
    provisionerDir,
    run(script, state, env = {}) {
      const runDir = path.join(dir, "run");
      rmSync(runDir, { recursive: true, force: true });
      mkdirSync(runDir);
      writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
      writeFileSync(path.join(dir, "calls.log"), "");
      // The script writes to /run and talks to /var/run/qemu-server; point both at the temp directory.
      // The script goes in on stdin, as the real transport does.
      const qemuDir = path.join(runDir, "qemu-server");
      // "/run/lock" with no trailing slash (the host helper's lock directory) must move too, or a run
      // depends on the real /run/lock of whatever machine runs the tests.
      const local = script
        .replaceAll("/var/run/qemu-server", "@@QEMU@@")
        .replaceAll("/run/lock", "@@LOCK@@")
        .replaceAll("/var/lib/hivra-sleep", "@@MARK@@")
        .replaceAll("/etc/pve/qemu-server", "@@PVECONF@@")
        .replaceAll("/run/", `${runDir}/`)
        .replaceAll("@@QEMU@@", qemuDir)
        .replaceAll("@@LOCK@@", path.join(runDir, "lock"))
        .replaceAll("@@MARK@@", path.join(dir, "var-lib-hivra-sleep"))
        .replaceAll("@@PVECONF@@", path.join(dir, "pve-qemu-server"));
      const pidFile = path.join(dir, "qemu.pid");
      rmSync(pidFile, { force: true });
      const started = spawnSync("python3", [qemu, dir, qemuDir, String(VMID)], { stdio: "ignore", timeout: 15_000 });
      if (started.status !== 0) throw new Error("the fake QEMU did not start");
      let result;
      try {
        result = spawnSync("bash", ["-s"], {
          input: local,
          encoding: "utf8",
          env: { PATH: `${bin}:/usr/bin:/bin`, STUB_DIR: dir, LC_ALL: "C", ...env } as unknown as NodeJS.ProcessEnv,
          timeout: 60_000,
        });
      } finally {
        try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* already gone */ }
      }
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        calls: readFileSync(path.join(dir, "calls.log"), "utf8").split("\n").filter(Boolean),
        state: JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")) as HostState,
        runDir,
      };
    },
    cleanup() { rmSync(dir, { recursive: true, force: true }); },
  };
}

/** A probe answer, as the guest would print it, with overrides. */
export function probeLine(overrides: Record<string, unknown> = {}): string {
  const probe = {
    v: 1, errors: [], activeRuns: 0, cliProcesses: 0, openConnections: 0, gatewayConnections: 0,
    terminalAttached: false, terminalClients: 0, sshSessions: 0, desktopAttached: false,
    lastUsedAt: "2026-11-12T10:00:00Z", nextJobAt: null, liveChannels: [], loadavg: [0.01, 0.02, 0.0],
    cpus: 2, uptimeS: 90000, now: "2026-11-12T12:00:00Z", ms: 180, sysTimers: 12, ...overrides,
  };
  return `HIVRA_IDLE ${JSON.stringify(probe)}\n`;
}
