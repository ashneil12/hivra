/**
 * The one read-only host script behind a capacity reading, and its parser.
 *
 * It prints three lines: memory, the disk pool and the VM counts. Nothing on
 * the host is changed. A line that cannot be measured is left out, and the
 * parser reports that part as null.
 */

const MARKER = "HIVRA_CAPACITY";

export type HostCapacityProbe = {
  memTotalMb: number;
  memAvailableMb: number;
  pool: { source: "lvm" | "pvesm"; name: string; sizeMb: number; usedPercent: number } | null;
  vms: { running: number; paused: number; stopped: number } | null;
};

/**
 * The timeouts add up to 42 seconds, under the sweep's limit for one host.
 *
 * The disk pool is the thin pool that holds the most VM volumes, read the way
 * the hibernate gate reads it (`lvs` size and data_percent). A host without
 * thin volumes falls back to its largest active `pvesm` image storage.
 */
export function buildHostCapacityScript(): string {
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
exit 0
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
