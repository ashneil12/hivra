// A fake Proxmox host for running the sleep and wake scripts for real: stub
// qm, flock, timeout, systemd-run, lvs and sleep binaries on PATH, plus a
// temp directory standing in for /run. Test support only.

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
  "-x -n 9") [ -z "\${STUB_FLOCK_BUSY:-}" ] || exit 1 ;;
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
      // The script writes to /run; point it at the temp directory. The script goes in on stdin, as the real transport does.
      const local = script.replaceAll("/run/", `${runDir}/`);
      const result = spawnSync("bash", ["-s"], {
        input: local,
        encoding: "utf8",
        env: { PATH: `${bin}:/usr/bin:/bin`, STUB_DIR: dir, LC_ALL: "C", ...env },
        timeout: 60_000,
      });
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
