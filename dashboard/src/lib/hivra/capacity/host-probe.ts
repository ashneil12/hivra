/**
 * The one read-only host script behind a capacity reading, and its parser.
 *
 * It prints three lines: memory, the disk pool and the VM counts. Nothing on
 * the host is changed. A line that cannot be measured is left out, and the
 * parser reports that part as null.
 */

import { shellQuote } from "@/lib/hivra/proxmox-target";

const MARKER = "HIVRA_CAPACITY";

/** One running VM's memory as its own kernel reports it to the host, without its file cache. */
export type VmMemorySample = { vmid: number; totalMb: number; usedMb: number };

/** The per-VM memory read gets this long on the host, and stops asking new VMs a little earlier. */
const VM_MEMORY_TIMEOUT_SECONDS = 8;
const VM_MEMORY_DEADLINE_SECONDS = 6;
/** Balloon statistics older than this are not a reading of now (a paused VM keeps its last ones). */
const VM_MEMORY_MAX_AGE_SECONDS = 120;

/**
 * Asks every running VM's monitor socket for the balloon driver's statistics
 * (the guest refreshes them every few seconds). Read only: three queries per
 * VM, no guest command. Used memory is total minus available, which is what
 * the guest itself calls used without cache. A VM that is paused, has stale
 * statistics, or does not answer in time prints nothing.
 */
export const VM_MEMORY_PROGRAM = String.raw`import glob, json, os, socket, time
DEADLINE = time.time() + ${VM_MEMORY_DEADLINE_SECONDS}
def call(sock, stream, command, arguments=None):
    message = {"execute": command}
    if arguments:
        message["arguments"] = arguments
    sock.sendall((json.dumps(message) + "\n").encode())
    while True:
        line = stream.readline()
        if not line:
            raise OSError("closed")
        answer = json.loads(line)
        if "return" in answer or "error" in answer:
            return answer.get("return") or {}
def whole(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 < value < 2 ** 50 else None
for path in sorted(glob.glob(os.environ.get("HIVRA_QEMU_RUN_DIR", "/var/run/qemu-server") + "/*.qmp")):
    if time.time() > DEADLINE:
        break
    vmid = os.path.basename(path)[:-4]
    if not vmid.isdigit() or len(vmid) > 9:
        continue
    sock = None
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(1.5)
        sock.connect(path)
        stream = sock.makefile("r")
        stream.readline()
        call(sock, stream, "qmp_capabilities")
        if call(sock, stream, "query-status").get("status") != "running":
            continue
        answer = call(sock, stream, "qom-get", {"path": "/machine/peripheral/balloon0", "property": "guest-stats"})
        stats = answer.get("stats") if isinstance(answer, dict) else None
        if not isinstance(stats, dict):
            continue
        total = whole(stats.get("stat-total-memory"))
        available = whole(stats.get("stat-available-memory"))
        updated = whole(answer.get("last-update"))
        if total is None or available is None or updated is None or available > total:
            continue
        age = time.time() - updated
        if age < -${VM_MEMORY_MAX_AGE_SECONDS} or age > ${VM_MEMORY_MAX_AGE_SECONDS}:
            continue
        print("${MARKER} vm id=%s total_mb=%d available_mb=%d" % (vmid, total // 1048576, available // 1048576))
    except Exception:
        pass
    finally:
        if sock is not None:
            try:
                sock.close()
            except Exception:
                pass
`;

export type HostCapacityProbe = {
  memTotalMb: number;
  memAvailableMb: number;
  pool: { source: "lvm" | "pvesm"; name: string; sizeMb: number; usedPercent: number } | null;
  vms: { running: number; paused: number; stopped: number } | null;
};

/**
 * The timeouts add up to 42 seconds (50 with vmMemory), under the sweep's limit for one host.
 *
 * The disk pool is the thin pool that holds the most VM volumes, read the way
 * the hibernate gate reads it (`lvs` size and data_percent). A host without
 * thin volumes falls back to its largest active `pvesm` image storage.
 */
export function buildHostCapacityScript(options: { vmMemory?: boolean } = {}): string {
  return `set -u
export LC_ALL=C
awk '$1=="MemTotal:" {t=int($2/1024)} $1=="MemAvailable:" {a=int($2/1024)} END {if (t > 0 && a != "") printf "${MARKER} mem total_mb=%d available_mb=%d\\n", t, a}' /proc/meminfo

POOL="$(command timeout 8 lvs --noheadings --separator '|' -o vg_name,pool_lv,lv_name </dev/null 2>/dev/null \\
  | awk -F'|' '{ for (i = 1; i <= 3; i++) gsub(/[[:space:]]/, "", $i) } $3 ~ /^vm-[0-9]+-/ && $2 != "" { n[$1 "/" $2]++ }
      END { best = ""; for (k in n) if (best == "" || n[k] > n[best] || (n[k] == n[best] && k < best)) best = k; print best }')"
POOL_LINE=""
if [[ "$POOL" =~ ^[A-Za-z0-9_.+-]+/[A-Za-z0-9_.+-]+$ ]]; then
  POOL_LINE="$(command timeout 8 lvs --noheadings --nosuffix --units m --separator '|' -o lv_size,data_percent "$POOL" </dev/null 2>/dev/null \\
    | awk -F'|' -v name="$POOL" '{ for (i = 1; i <= 2; i++) gsub(/[[:space:]]/, "", $i) }
        $1 ~ /^[0-9]+([.][0-9]+)?$/ && $2 ~ /^[0-9]+([.][0-9]+)?$/ { printf "${MARKER} pool source=lvm name=%s size_mb=%d used_percent=%.1f\\n", name, $1, $2; exit }')"
fi
if [ -z "$POOL_LINE" ]; then
  POOL_LINE="$(command timeout 8 pvesm status --content images </dev/null 2>/dev/null \\
    | awk 'NR > 1 && $3 == "active" && $4 ~ /^[0-9]+$/ && $5 ~ /^[0-9]+$/ && $4 > best && $1 ~ /^[A-Za-z0-9_.-]+$/ { best = $4; name = $1; used = $5 }
        END { if (best > 0) printf "${MARKER} pool source=pvesm name=%s size_mb=%d used_percent=%.1f\\n", name, best / 1024, used * 100 / best }')"
fi
[ -n "$POOL_LINE" ] && printf '%s\\n' "$POOL_LINE"

# A napping VM reads as paused, a hibernated one as stopped. Only the full
# listing asks each running VM for its state: the short one shows a paused VM
# as running, and is used only when the full one gives nothing.
VMS="$(command timeout 12 qm list --full 1 </dev/null 2>/dev/null)"
[ -n "$VMS" ] || VMS="$(command timeout 6 qm list </dev/null 2>/dev/null)"
printf '%s\\n' "$VMS" \\
  | awk 'NR > 1 && $1 ~ /^[0-9]+$/ { n[$3]++; seen = 1 } END { if (seen) printf "${MARKER} vms running=%d paused=%d stopped=%d\\n", n["running"], n["paused"], n["stopped"] }'
${options.vmMemory === true ? `# Each running VM's own view of its memory. A host without python3 simply prints none.
command timeout -k 2 ${VM_MEMORY_TIMEOUT_SECONDS} python3 -I -B -c ${shellQuote(VM_MEMORY_PROGRAM)} </dev/null 2>/dev/null || true
` : ""}exit 0
`;
}

function fields(stdout: string, kind: string): Record<string, string> | null {
  const line = stdout.split("\n").map((l) => l.trim()).find((l) => l.startsWith(`${MARKER} ${kind} `));
  if (!line) return null;
  const out: Record<string, string> = {};
  for (const token of line.split(/\s+/).slice(2)) {
    const eq = token.indexOf("=");
    if (eq > 0) out[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return out;
}

function count(value: string | undefined): number | null {
  return value !== undefined && /^\d{1,12}$/.test(value) ? Number.parseInt(value, 10) : null;
}

/** Null when memory could not be read: without it there is no reading at all. */
export function parseHostCapacityOutput(stdout: string): HostCapacityProbe | null {
  const mem = fields(stdout ?? "", "mem");
  const memTotalMb = count(mem?.total_mb);
  const memAvailableMb = count(mem?.available_mb);
  if (memTotalMb === null || memAvailableMb === null || memTotalMb <= 0 || memAvailableMb > memTotalMb) return null;

  let pool: HostCapacityProbe["pool"] = null;
  const p = fields(stdout, "pool");
  const sizeMb = count(p?.size_mb);
  const usedPercent = p?.used_percent !== undefined && /^\d{1,3}(\.\d+)?$/.test(p.used_percent) ? Number(p.used_percent) : null;
  if (p && (p.source === "lvm" || p.source === "pvesm") && /^[A-Za-z0-9_.+/-]{1,128}$/.test(p.name ?? "")
    && sizeMb !== null && sizeMb > 0 && usedPercent !== null && usedPercent <= 100) {
    pool = { source: p.source, name: p.name, sizeMb, usedPercent };
  }

  let vms: HostCapacityProbe["vms"] = null;
  const v = fields(stdout, "vms");
  const running = count(v?.running);
  const paused = count(v?.paused);
  const stopped = count(v?.stopped);
  if (running !== null && paused !== null && stopped !== null) vms = { running, paused, stopped };

  return { memTotalMb, memAvailableMb, pool, vms };
}

/** Every valid per-VM line. A VM printed twice, or with numbers that cannot be right, is left out. */
export function parseVmMemoryLines(stdout: string): VmMemorySample[] {
  const byVmid = new Map<number, VmMemorySample | null>();
  for (const raw of (stdout ?? "").split("\n")) {
    const line = raw.trim();
    if (!line.startsWith(`${MARKER} vm `)) continue;
    const f = fields(line, "vm");
    const vmid = count(f?.id);
    const totalMb = count(f?.total_mb);
    const availableMb = count(f?.available_mb);
    if (vmid === null || vmid < 100 || vmid > 999_999_999) continue;
    if (byVmid.has(vmid)) { byVmid.set(vmid, null); continue; }
    if (totalMb === null || availableMb === null || totalMb <= 0 || totalMb > 4_194_304 || availableMb > totalMb) {
      byVmid.set(vmid, null);
      continue;
    }
    byVmid.set(vmid, { vmid, totalMb, usedMb: totalMb - availableMb });
  }
  return [...byVmid.values()].filter((sample): sample is VmMemorySample => sample !== null);
}
