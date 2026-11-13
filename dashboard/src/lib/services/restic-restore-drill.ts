// Restore drill for the per-instance restic backups.
//
// A backup that has never been restored is a hope, not a backup. This builds the
// host script that proves one instance's latest restic snapshot comes back:
//
//   1. restore the newest snapshot's webui-state (chats, sessions, profiles,
//      config) into a scratch folder on the PVE host;
//   2. open every SQLite database in it and run PRAGMA integrity_check;
//   3. compare a handful of files that have not changed since the snapshot
//      against the live box, read through the QEMU Guest Agent (the VMID's own
//      virtio channel, so no guest SSH key is involved and no IP can be mistaken
//      for another tenant);
//   4. delete the scratch folder.
//
// Nothing is written to the guest or the database, and nothing to the restic repo
// beyond restic's own short-lived read lock. The drill shares the backup's
// per-instance host lock, refuses a restore that would not fit on the host disk
// with the floor still free, and sweeps copies a killed run left behind. The
// daily-instance-backups route runs it on demand with ?action=restore-drill.

const SAFE_INSTANCE_ID = /^[0-9a-f-]{36}$/i;

export type RestoreDrillTarget = { instanceId: string; vmid: number };

export type RestoreDrillDatabase = { path: string; ok: boolean; result: string; tables?: number };

export type RestoreDrillResult = {
  pass: boolean;
  instance: string;
  snapshot: string;
  snapshot_time: string;
  files: number;
  bytes: number;
  databases_total: number;
  databases: RestoreDrillDatabase[];
  compare: {
    status: string;
    sampled: number;
    matched: number;
    changed: number;
    missing: number;
  };
  cleanup: string;
};

const RESULT_MARKER = "RESTORE_DRILL_RESULT ";

/**
 * Build the bash that runs the drill on the PVE host that holds the instance.
 * The caller installs the cold-storage alias and exports RESTIC_PASSWORD first.
 * Both inputs are validated here and embedded only as literals.
 */
export function buildRestoreDrillScript(target: RestoreDrillTarget): string {
  if (!SAFE_INSTANCE_ID.test(target.instanceId)) {
    throw new Error("unsafe instance id");
  }
  if (!Number.isInteger(target.vmid) || target.vmid <= 0) {
    throw new Error("unsafe vmid");
  }
  const instanceId = target.instanceId.toLowerCase();
  return `INSTANCE_ID='${instanceId}'
VMID='${target.vmid}'
REPO="\${HERMES_RESTIC_REPO_OVERRIDE:-sftp:cold:restic/$INSTANCE_ID}"
export RESTIC_CACHE_DIR="\${RESTIC_CACHE_DIR:-/var/lib/hermes-restic-cache}"
MIRROR_ROOT="\${HERMES_RESTIC_MIRROR_ROOT:-/var/lib/hermes-restic-src}"
RESTORE_ROOT="\${HERMES_RESTORE_DRILL_ROOT:-/var/lib/hermes-restore}"
MIN_DISK_MB="\${HERMES_RESTORE_DRILL_MIN_DISK_MB:-8000}"
SNAPSHOT_PREFIX="$MIRROR_ROOT/$INSTANCE_ID/webui-state"
LIVE_VOL="/var/lib/docker/volumes/agent-\${INSTANCE_ID}_webui-state/_data"
STAGE=""

drill_abort() { echo "RESTORE_DRILL_ABORT reason=$1 instance=$INSTANCE_ID host=$(hostname)" >&2; exit "$2"; }
free_mb() { df -BM --output=avail "$RESTORE_ROOT" 2>/dev/null | tail -1 | tr -dc '0-9' || true; }

[ -n "\${RESTIC_PASSWORD:-}" ] || drill_abort no_restic_password 4
command -v python3 >/dev/null 2>&1 || drill_abort python3_missing 5
if ! command -v restic >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y restic >/dev/null 2>&1 || drill_abort restic_missing 5
fi
mkdir -p "$RESTORE_ROOT" "$RESTIC_CACHE_DIR"
chmod 700 "$RESTORE_ROOT"

# One run per instance at a time, shared with the backup so a drill never races
# its prune.
exec 9>"\${HERMES_RESTIC_LOCK_DIR:-/var/lock}/hermes-restic-$INSTANCE_ID.lock"
flock -n 9 || drill_abort backup_or_drill_already_running 12

# Copies left by a run that was killed (SIGKILL, reboot) hold decrypted tenant
# data: remove this instance's drill folders older than six hours.
find "$RESTORE_ROOT" -mindepth 1 -maxdepth 1 -type d -name "$INSTANCE_ID-drill-*" -mmin +360 \\
  -exec rm -rf -- {} + 2>/dev/null || true

AVAIL_MB="$(free_mb)"
if [ "$MIN_DISK_MB" -gt 0 ]; then
  [ -n "$AVAIL_MB" ] || drill_abort host_disk_unreadable 9
  [ "$AVAIL_MB" -ge "$MIN_DISK_MB" ] || drill_abort "low_host_disk_avail_mb_$AVAIL_MB" 9
fi

SNAPSHOTS_JSON="$(restic -r "$REPO" snapshots --json --latest 1 --host "$INSTANCE_ID" 2>/dev/null)" \\
  || drill_abort repo_unreadable 7
SNAP_LINE="$(printf '%s' "$SNAPSHOTS_JSON" | python3 -c '
import json, sys
try:
    snaps = json.load(sys.stdin) or []
except ValueError:
    raise SystemExit(1)
if not snaps:
    raise SystemExit(1)
latest = max(snaps, key=lambda s: s.get("time", ""))
print(latest["short_id"], latest["time"])
')" || drill_abort no_snapshot 7
SNAP_ID="\${SNAP_LINE%% *}"
SNAP_TIME="\${SNAP_LINE#* }"
case "$SNAP_ID" in ""|*[!0-9a-f]*) drill_abort bad_snapshot_id 7 ;; esac

# Refuse a restore that would not fit with the floor still free afterwards, so a
# large tenant can never fill the host root disk that every VM shares. A copy of
# each database is made too, so count the restore twice.
RESTORE_MB="$(restic -r "$REPO" stats "$SNAP_ID" --mode restore-size --json 2>/dev/null \\
  | python3 -c 'import json, sys; print(int(json.load(sys.stdin)["total_size"]) // 1048576 + 1)' 2>/dev/null)" \\
  || drill_abort restore_size_unknown 9
if [ "$MIN_DISK_MB" -gt 0 ] && [ $((RESTORE_MB * 2 + MIN_DISK_MB)) -gt "$AVAIL_MB" ]; then
  drill_abort "restore_too_large_mb_\${RESTORE_MB}_avail_mb_$AVAIL_MB" 9
fi

drill_cleanup() {
  case "$STAGE" in
    "") ;;
    "$RESTORE_ROOT"/"$INSTANCE_ID"-drill-*) rm -rf -- "$STAGE" ;;
    *) echo "RESTORE_DRILL_CLEANUP_REFUSED path=$STAGE" >&2; return 1 ;;
  esac
}
STAGE="$(mktemp -d "$RESTORE_ROOT/$INSTANCE_ID-drill-XXXXXXXX")" || { STAGE=""; drill_abort stage_create_failed 8; }
trap drill_cleanup EXIT

echo "RESTORE_DRILL_BEGIN instance=$INSTANCE_ID vmid=$VMID snapshot=$SNAP_ID snapshot_time=$SNAP_TIME restore_mb=$RESTORE_MB host=$(hostname)"
restic -r "$REPO" restore "$SNAP_ID" --target "$STAGE" --include "$SNAPSHOT_PREFIX" >/dev/null 2>&1 \\
  || drill_abort restore_failed 8
[ -d "$STAGE$SNAPSHOT_PREFIX" ] || drill_abort restored_tree_missing 8

set +e
python3 - "$STAGE$SNAPSHOT_PREFIX" "$STAGE/.check" "$LIVE_VOL" "$VMID" "$SNAP_ID" "$SNAP_TIME" "$INSTANCE_ID" > "$STAGE/.result.json" <<'HERMES_RESTORE_DRILL_PY'
import datetime, hashlib, json, os, shutil, sqlite3, subprocess, sys

restored, check_dir, live_vol, vmid, snap_id, snap_time, instance = sys.argv[1:8]
MAX_DATABASES = 50
SAMPLE = 8
SKIP_SUFFIXES = (".db", "-wal", "-shm", "-journal", ".log", ".lock", ".pid", ".sock")

def parse_time(value):
    # restic writes RFC 3339 with up to nanoseconds; Python takes microseconds.
    value = value.strip().replace("Z", "+00:00")
    main, zone, frac = value[:19], value[19:], ""
    if zone.startswith("."):
        digits = zone[1:]
        cut = len(digits) - len(digits.lstrip("0123456789"))
        frac, zone = ("." + digits[:cut][:6].ljust(6, "0")) if cut else "", digits[cut:]
    return datetime.datetime.fromisoformat(main + frac + (zone or "+00:00")).timestamp()

def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()

files, total, databases, candidates = 0, 0, [], []
snap_epoch = parse_time(snap_time)
for root, _dirs, names in os.walk(restored):
    for name in sorted(names):
        path = os.path.join(root, name)
        if os.path.islink(path) or not os.path.isfile(path):
            continue
        files += 1
        size = os.path.getsize(path)
        total += size
        rel = os.path.relpath(path, restored)
        if name.endswith(".db"):
            databases.append(rel)
        elif not name.endswith(SKIP_SUFFIXES) and 0 < size <= 5 * 1024 * 1024:
            # Only files untouched for an hour before the snapshot are expected
            # to still match the live box.
            if os.path.getmtime(path) < snap_epoch - 3600:
                candidates.append(rel)

db_results = []
os.makedirs(check_dir, mode=0o700, exist_ok=True)
for index, rel in enumerate(sorted(databases)[:MAX_DATABASES]):
    # Copy the database with its WAL so committed pages in the log are checked too.
    work = os.path.join(check_dir, str(index))
    os.makedirs(work, mode=0o700)
    base = os.path.join(work, "check.db")
    shutil.copy2(os.path.join(restored, rel), base)
    for suffix in ("-wal", "-shm"):
        side = os.path.join(restored, rel + suffix)
        if os.path.isfile(side):
            shutil.copy2(side, base + suffix)
    try:
        connection = sqlite3.connect(base, timeout=5)
        rows = connection.execute("PRAGMA integrity_check").fetchall()
        tables = connection.execute("SELECT count(*) FROM sqlite_master WHERE type = 'table'").fetchone()[0]
        connection.close()
        result = "; ".join(str(row[0]) for row in rows)[:300]
        # An empty or table-less file opens as a valid database; it is not a backup.
        if result == "ok" and tables == 0:
            result = "no tables"
        db_results.append({"path": rel, "ok": result == "ok", "result": result, "tables": tables})
    except sqlite3.Error as error:
        db_results.append({"path": rel, "ok": False, "result": str(error)[:300]})

compare = {"status": "skipped", "sampled": 0, "matched": 0, "changed": 0, "missing": 0}
sample = sorted(candidates)[:SAMPLE]
def qm(*args):
    return subprocess.run(["qm", *args], capture_output=True, text=True, timeout=90)
try:
    config = qm("config", vmid)
    status = qm("status", vmid)
    tags = next((line.split(":", 1)[1] for line in config.stdout.splitlines() if line.startswith("tags:")), "")
    agent = next((line.split(":", 1)[1].strip() for line in config.stdout.splitlines() if line.startswith("agent:")), "")
    agent_on = any(part in ("1", "on", "yes", "true", "enabled=1", "enabled=on", "enabled=yes", "enabled=true") for part in agent.split(","))
    if config.returncode != 0:
        compare["status"] = "skipped:vm_not_on_host"
    elif "hivra-bind-" in tags:
        compare["status"] = "skipped:not_a_hermes_vm"
    elif "status: running" not in status.stdout:
        compare["status"] = "skipped:vm_not_running"
    elif not agent_on:
        compare["status"] = "skipped:no_guest_agent"
    elif not sample:
        compare["status"] = "skipped:no_stable_files"
    else:
        live_paths = [os.path.join(live_vol, rel) for rel in sample]
        run = qm("guest", "exec", vmid, "--timeout", "60", "--", "sha256sum", "--", *live_paths)
        document = json.loads(run.stdout or "{}")
        live = {}
        for line in (document.get("out-data") or "").splitlines():
            digest, _, path = line.partition("  ")
            if len(digest) == 64:
                live[path] = digest
        compare["sampled"] = len(sample)
        for rel, live_path in zip(sample, live_paths):
            if live_path not in live:
                compare["missing"] += 1
            elif live[live_path] == sha256(os.path.join(restored, rel)):
                compare["matched"] += 1
            else:
                compare["changed"] += 1
        compare["status"] = "compared"
except (OSError, ValueError, subprocess.SubprocessError) as error:
    compare["status"] = "skipped:guest_exec_failed:" + type(error).__name__

# Every database must be checked and sound, and the comparison with the live box
# must run: a skipped comparison is reported, never counted as a pass. A file
# can legitimately change after the snapshot, so three in four must match.
databases_ok = bool(db_results) and len(db_results) == len(databases) and all(entry["ok"] for entry in db_results)
compare_ok = compare["status"] == "compared" and compare["matched"] * 4 >= compare["sampled"] * 3
result = {
    "pass": files > 0 and databases_ok and compare_ok,
    "databases_total": len(databases),
    "instance": instance,
    "snapshot": snap_id,
    "snapshot_time": snap_time,
    "files": files,
    "bytes": total,
    "databases": db_results,
    "compare": compare,
}
print(json.dumps(result, sort_keys=True))
raise SystemExit(0 if result["pass"] else 11)
HERMES_RESTORE_DRILL_PY
ANALYSIS_RC=$?
set -e

# Read the analysis before the stage (which holds it) is removed.
ANALYSIS_JSON="$(cat "$STAGE/.result.json" 2>/dev/null || true)"
if drill_cleanup && [ ! -e "$STAGE" ]; then CLEANUP=removed; else CLEANUP=failed; fi
trap - EXIT
RESULT="$(printf '%s' "$ANALYSIS_JSON" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except ValueError:
    data = {"pass": False, "instance": sys.argv[2]}
data["cleanup"] = sys.argv[1]
if sys.argv[1] != "removed":
    data["pass"] = False
print(json.dumps(data, sort_keys=True))
' "$CLEANUP" "$INSTANCE_ID")"
echo "${RESULT_MARKER}$RESULT"
if [ "$ANALYSIS_RC" -ne 0 ] || [ "$CLEANUP" != removed ]; then
  echo "RESTORE_DRILL_FAILED instance=$INSTANCE_ID analysis_rc=$ANALYSIS_RC cleanup=$CLEANUP" >&2
  exit 11
fi
echo "RESTORE_DRILL_OK instance=$INSTANCE_ID snapshot=$SNAP_ID cleanup=$CLEANUP"
`;
}

/**
 * Read the drill's result line from the host script's stdout. Returns null when
 * the script stopped before it got that far (the stderr ABORT line says why).
 */
export function parseRestoreDrillResult(stdout: string): RestoreDrillResult | null {
  const line = stdout
    .split("\n")
    .reverse()
    .find((candidate) => candidate.startsWith(RESULT_MARKER));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line.slice(RESULT_MARKER.length)) as RestoreDrillResult;
    return typeof parsed === "object" && parsed !== null && typeof parsed.pass === "boolean"
      ? parsed
      : null;
  } catch {
    return null;
  }
}
