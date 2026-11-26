import "server-only";

import { shellQuote } from "@/lib/hivra/proxmox-target";

// Host scripts for off-host backups of Hivra computers.
//
// A backup is a short-lived Proxmox snapshot (no memory state) of an awake
// computer. Each disk of that snapshot is read raw from the host and handed to
// restic, which deduplicates, compresses, encrypts and uploads it to the cold
// storage box over the host's own `cold` SSH alias. Only changed chunks travel
// after the first copy. The snapshot is removed as soon as the disks are read.
//
// The work runs as a transient systemd unit on the host, so a long first copy
// never races a serverless time limit. The cron that starts it polls the job's
// result file on later runs.
//
// Nothing here talks to the guest. The VM is touched only by `qm snapshot` and
// `qm delsnapshot`, each behind the exact Hivra binding tag check and the
// per-VM lock the sleep and wake scripts share, so a backup never interleaves
// with a nap or a hibernate. A computer that is not plainly awake is skipped.
//
// The repository password arrives on stdin, never in a script body or argv,
// and is deleted from the host as soon as the job has read it.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BINDING_TAG_RE = /^hivra-bind-[a-f0-9]{32}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SNAPSHOT_ID_RE = /^[0-9a-f]{64}$/;
const DISK_KEY_RE = /^(scsi|virtio|sata|ide)[0-9]{1,2}$/;

export const BACKUP_JOB_ROOT = "/var/lib/hivra/computer-backups";
export const BACKUP_START_PREFIX = "HIVRA_BACKUP_START ";
export const BACKUP_JOB_PREFIX = "HIVRA_BACKUP_JOB ";
export const BACKUP_PURGE_PREFIX = "HIVRA_BACKUP_PURGE ";
/** Every Hivra computer repository lives under this folder on the storage box. */
export const BACKUP_REPO_FOLDER = "hivra-computers";
const COMPUTER_BACKUP_VM_LOCK = "/run/lock/hivra-vm-$VMID.backup.lock";
const LIST_COMPUTER_BACKUP_SNAPSHOTS = String.raw`qm listsnapshot "$VMID" </dev/null | awk '$1 ~ /->$/ && $2 ~ /^hivrabk_[0-9a-f]+$/ && length($2) == 40 {print $2}'`;

/** Take both per-VM locks before taking the host allocation lock. The lifecycle
 * lock also excludes older backup scripts while they create or remove a snapshot. */
export const COMPUTER_BACKUP_DELETE_LOCKS = `exec 7>"${COMPUTER_BACKUP_VM_LOCK}"
flock -n 7 || { echo "Backup is active for VMID $VMID; retry Delete after backup cleanup" >&2; exit 1; }
exec 9>/run/lock/hivra-vm-$VMID.lock
flock -n 9 || { echo "Lifecycle operation is active for VMID $VMID; retry Delete" >&2; exit 1; }`;

/** A snapshot left by an old or interrupted job outlives the flock. */
export const REFUSE_COMPUTER_BACKUP_SNAPSHOTS = `BACKUP_SNAPSHOTS="$(${LIST_COMPUTER_BACKUP_SNAPSHOTS})" \\
  || { echo "Could not verify backup snapshots for VMID $VMID" >&2; exit 1; }
if [ -n "$BACKUP_SNAPSHOTS" ]; then
  echo "VMID $VMID still has a backup snapshot; retry Delete after backup cleanup" >&2
  exit 1
fi`;

/**
 * `store` packs a long sleeper into the storage box and frees its disks on the
 * host; `unstore` writes them back. Both belong to the sleep ladder
 * (src/lib/hivra/sleep-storage.ts), not to the backup cron.
 */
export type BackupJobKind = "backup" | "drill" | "restore" | "store" | "unstore";

export interface BackupDisk {
  key: string;
  sha256: string;
  bytes: number;
  snapshotId: string;
}

function checkedUuid(value: string, what: string): string {
  if (!UUID_RE.test(value)) throw new Error(`Invalid ${what}`);
  return value;
}

function checkedVmid(value: number): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > 999_999_999) throw new Error("Invalid VMID");
  return value;
}

function checkedTag(value: string): string {
  if (!BINDING_TAG_RE.test(value)) throw new Error("Hivra backups require an enforced infrastructure binding tag");
  return value;
}

function checkedInt(value: number, min: number, max: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${what}`);
  return value;
}

function checkedDisks(disks: BackupDisk[]): BackupDisk[] {
  if (!Array.isArray(disks) || disks.length < 1 || disks.length > 16) throw new Error("Invalid backup disks");
  for (const disk of disks) {
    if (!DISK_KEY_RE.test(disk.key) || !SHA256_RE.test(disk.sha256) || !SNAPSHOT_ID_RE.test(disk.snapshotId)
      || !Number.isSafeInteger(disk.bytes) || disk.bytes < 1) {
      throw new Error("Invalid backup disk");
    }
  }
  return disks;
}

/** The restic repository of one computer, through the host's `cold` alias. */
export function backupRepository(agentId: string): string {
  return `sftp:cold:${BACKUP_REPO_FOLDER}/${checkedUuid(agentId, "agent id")}`;
}

export function backupUnitName(jobId: string): string {
  return `hivra-computer-backup-${checkedUuid(jobId, "job id")}`;
}

/**
 * Shared shell for every job: the result writer, the binding and state checks,
 * and the helpers that find the computer's disks. Written once into the job's
 * folder by the start script.
 */
const JOB_COMMON = String.raw`set -uo pipefail
umask 077
JOBDIR="$(cd "$(dirname "$0")" && pwd)"
. "$JOBDIR/params"
RESULT="$JOBDIR/result.json"
DISKS_JSON=""
ADDED=0
qm() { command timeout -k 5 120 qm "$@" </dev/null; }
add_disk_json() {
  [ -z "$DISKS_JSON" ] || DISKS_JSON="$DISKS_JSON,"
  DISKS_JSON="$DISKS_JSON{\"key\":\"$1\",\"sha256\":\"$2\",\"bytes\":$3,\"snapshotId\":\"$4\"}"
}
cleanup() { :; }
done_with() {
  cleanup || set -- failed snapshot_cleanup_failed
  write_result "$@"
}
write_result() {
  local tmp="$RESULT.tmp.$$"
  printf '{"job":"%s","kind":"%s","status":"%s","reason":"%s","addedBytes":%s,"disks":[%s],"finishedAt":"%s"}\n' \
    "$JOB_ID" "$KIND" "$1" "$2" "$ADDED" "$DISKS_JSON" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$tmp"
  mv -f "$tmp" "$RESULT"
  rm -f "$JOBDIR/secret"
  exit 0
}
trap 'done_with failed interrupted' INT TERM
# One backup job per host at a time.
exec 3>/run/lock/hivra-computer-backup.lock
flock -n 3 || done_with failed host_busy
[ -s "$JOBDIR/secret" ] || done_with failed no_password
set -a; . "$JOBDIR/secret"; set +a
rm -f "$JOBDIR/secret"
export RESTIC_CACHE_DIR=/var/lib/hivra/restic-cache
install -d -m 0700 "$RESTIC_CACHE_DIR"
CONFIG=""
read_config() { CONFIG="$(qm config "$VMID" 2>/dev/null)"; }
has_binding() {
  printf '%s\n' "$CONFIG" | sed -n 's/^tags:[[:space:]]*//p' | tr ';' '\n' | grep -Fxq -- "$EXPECTED_BINDING_TAG"
}
field() { printf '%s\n' "$CONFIG" | awk -v key="$1:" '$1==key {print $2; exit}'; }
# Disk keys and volume ids of a config text: no CD drives, no cloud-init drive.
disk_lines() {
  printf '%s\n' "$1" | awk -F': ' '
    $1 ~ /^(scsi|virtio|sata|ide)[0-9]+$/ {
      if ($2 ~ /media=cdrom/ || $2 ~ /cloudinit/) next
      split($2, parts, ",")
      if (parts[1] == "none" || parts[1] == "") next
      print $1, parts[1]
    }'
}
storage_type() { pvesm status --storage "$1" 2>/dev/null | awk 'NR==2 {print $2}'; }
restic_json_field() {
  python3 -I -c 'import json,sys
want=sys.argv[1]
val=""
for line in sys.stdin:
    line=line.strip()
    if not line.startswith("{"): continue
    try: row=json.loads(line)
    except ValueError: continue
    if row.get("message_type")=="summary" and want in row: val=row[want]
print(val)' "$1"
}
`;

const READ_DISK = String.raw`set -o pipefail
DEV="$1"; OUT="$2"
FIFO="$(mktemp -u /run/hivra-backup-hash.XXXXXXXX)"
mkfifo -m 0600 "$FIFO" || exit 1
sha256sum < "$FIFO" | awk '{print $1}' > "$OUT" &
HP=$!
dd if="$DEV" bs=4M iflag=direct status=none | tee "$FIFO"
RC=("$#{PIPESTATUS[@]}")
wait "$HP"; HR=$?
rm -f "$FIFO"
[ "$#{RC[0]}" = 0 ] && [ "$#{RC[1]}" = 0 ] && [ "$HR" = 0 ]
`;

const BACKUP_BODY = String.raw`SNAP="hivrabk_$(printf '%s' "$JOB_ID" | tr -d '-')"
SNAP_TAKEN=0
ACTIVE_LVS=""
cleanup() {
  local lv
  for lv in $ACTIVE_LVS; do lvchange -an "$lv" >/dev/null 2>&1 || true; done
  ACTIVE_LVS=""
  if [ "$SNAP_TAKEN" = 1 ]; then
    if { exec 9>/run/lock/hivra-vm-$VMID.lock; } && flock -x -w 60 9; then
      qm delsnapshot "$VMID" "$SNAP" >/dev/null 2>&1 && SNAP_TAKEN=0
      flock -u 9
    fi
    exec 9>&-
  fi
  return "$SNAP_TAKEN"
}
exec 7>"${COMPUTER_BACKUP_VM_LOCK}" || done_with failed backup_lock_unavailable
flock -n 7 || done_with skipped vm_busy
# The per-VM lock the sleep and wake scripts take: never snapshot beside them.
exec 9>/run/lock/hivra-vm-$VMID.lock
flock -x -w 30 9 || done_with skipped vm_busy
read_config || done_with failed unreachable
has_binding || done_with failed binding_mismatch
[ -z "$(field lock)" ] || done_with skipped locked
STATUS="$(qm status "$VMID" --verbose 2>/dev/null)" || done_with failed unreachable
[ "$(printf '%s\n' "$STATUS" | awk '$1=="status:" {print $2; exit}')" = running ] || done_with skipped not_awake
[ "$(printf '%s\n' "$STATUS" | awk '$1=="qmpstatus:" {print $2; exit}')" = running ] || done_with skipped not_awake
# A snapshot a killed run left behind goes first.
OLD_SNAPSHOTS="$(${LIST_COMPUTER_BACKUP_SNAPSHOTS})" || done_with failed snapshot_list_failed
for old in $OLD_SNAPSHOTS; do
  qm delsnapshot "$VMID" "$old" >/dev/null 2>&1 || done_with failed snapshot_cleanup_failed
done
read_config || done_with failed unreachable
while read -r key volid; do
  [ -n "$key" ] || continue
  [ "$(storage_type "$#{volid%%:*}")" = lvmthin ] || done_with skipped unsupported_storage
done <<< "$(disk_lines "$CONFIG")"
qm snapshot "$VMID" "$SNAP" --vmstate 0 --description "Hivra off-site backup in progress; removed automatically" >/dev/null 2>&1 \
  || done_with failed snapshot_failed
SNAP_TAKEN=1
flock -u 9
exec 9>&-
SNAP_CONFIG="$(qm config "$VMID" --snapshot "$SNAP" 2>/dev/null)" || done_with failed snapshot_unreadable
printf '%s\n' "$SNAP_CONFIG" | sed -E '/^(parent|snaptime|vmstate|description):/d' > "$JOBDIR/vm.conf"
if ! restic cat config >/dev/null 2>&1; then
  ssh -o BatchMode=yes cold mkdir -p "$REPO_FOLDER" >/dev/null 2>&1 || true
  restic init >/dev/null 2>&1 || done_with failed repo_init
fi
restic unlock >/dev/null 2>&1 || true
BACKUP_ARGS=(--host "hivra-$AGENT_ID" --tag hivra-computer --tag "job-$JOB_ID" --json --quiet)
[ "$UPLOAD_LIMIT_KIB" -gt 0 ] && BACKUP_ARGS+=(--limit-upload "$UPLOAD_LIMIT_KIB")
restic backup "$#{BACKUP_ARGS[@]}" --stdin-from-command --stdin-filename vm.conf -- cat "$JOBDIR/vm.conf" \
  > "$JOBDIR/conf.json" 2>"$JOBDIR/restic.err" || done_with failed upload_failed
COUNT=0
while read -r key volid; do
  [ -n "$key" ] || continue
  COUNT=$((COUNT + 1))
  volname="$#{volid#*:}"
  base="$(pvesm path "$volid" 2>/dev/null)" || done_with failed disk_path
  vg="$(basename "$(dirname "$base")")"
  lv="$vg/snap_$#{volname}_$SNAP"
  lvchange -ay -K "$lv" >/dev/null 2>&1 || done_with failed snapshot_activate
  ACTIVE_LVS="$ACTIVE_LVS $lv"
  dev="/dev/$lv"
  bytes="$(blockdev --getsize64 "$dev" 2>/dev/null)" || done_with failed disk_size
  ionice -c3 nice -n 10 restic backup "$#{BACKUP_ARGS[@]}" --stdin-from-command --stdin-filename "$key.raw" \
    -- /bin/bash "$JOBDIR/read-disk.sh" "$dev" "$JOBDIR/$key.sha256" \
    > "$JOBDIR/$key.json" 2>>"$JOBDIR/restic.err" || done_with failed upload_failed
  lvchange -an "$lv" >/dev/null 2>&1 || true
  ACTIVE_LVS="$#{ACTIVE_LVS/ $lv/}"
  sum="$(cat "$JOBDIR/$key.sha256" 2>/dev/null)"
  snap_id="$(restic_json_field snapshot_id < "$JOBDIR/$key.json")"
  added="$(restic_json_field data_added < "$JOBDIR/$key.json")"
  [[ "$sum" =~ ^[0-9a-f]{64}$ ]] || done_with failed hash_missing
  [[ "$snap_id" =~ ^[0-9a-f]{64}$ ]] || done_with failed snapshot_id_missing
  [[ "$added" =~ ^[0-9]+$ ]] || added=0
  ADDED=$((ADDED + added))
  add_disk_json "$key" "$sum" "$bytes" "$snap_id"
done <<< "$(disk_lines "$SNAP_CONFIG")"
[ "$COUNT" -gt 0 ] || done_with failed no_disks
cleanup || write_result failed snapshot_cleanup_failed
flock -u 7
exec 7>&-
restic forget --host "hivra-$AGENT_ID" --group-by host,paths \
  --keep-daily "$KEEP_DAILY" --keep-weekly "$KEEP_WEEKLY" --prune >/dev/null 2>>"$JOBDIR/restic.err" \
  || write_result succeeded retention_warning
write_result succeeded saved
`;

const DRILL_BODY = String.raw`# A drill reads every disk of one backup back from the storage box and checks
# that the bytes match the hash taken while they were read from the computer.
restic cat config >/dev/null 2>&1 || done_with failed repo_unreadable
while read -r key sum bytes snap_id; do
  [ -n "$key" ] || continue
  got="$(restic dump --quiet "$snap_id" "/$key.raw" 2>>"$JOBDIR/restic.err" | sha256sum | awk '{print $1}'; exit "$#{PIPESTATUS[0]}")" \
    || done_with failed download_failed
  [ "$got" = "$sum" ] || done_with failed hash_mismatch
  add_disk_json "$key" "$sum" "$bytes" "$snap_id"
done < "$JOBDIR/disks"
restic check --quiet >/dev/null 2>>"$JOBDIR/restic.err" || done_with failed repo_check_failed
done_with succeeded verified
`;

const RESTORE_CHECKS = String.raw`exec 9>/run/lock/hivra-vm-$VMID.lock
flock -x -w 60 9 || done_with failed vm_busy
read_config || done_with failed unreachable
has_binding || done_with failed binding_mismatch
[ -z "$(field lock)" ] || done_with failed locked
[ "$(qm status "$VMID" 2>/dev/null | awk '{print $2}')" = stopped ] || done_with failed not_stopped
`;

const RESTORE_WRITE = String.raw`restic cat config >/dev/null 2>&1 || done_with failed repo_unreadable
while read -r key sum bytes snap_id; do
  [ -n "$key" ] || continue
  volid="$(printf '%s\n' "$CONFIG" | awk -F': ' -v k="$key" '$1==k {split($2,p,","); print p[1]; exit}')"
  [ -n "$volid" ] || done_with failed disk_missing
  [ "$(storage_type "$#{volid%%:*}")" = lvmthin ] || done_with failed unsupported_storage
  dev="$(pvesm path "$volid" 2>/dev/null)" || done_with failed disk_path
  lvchange -ay "$(basename "$(dirname "$dev")")/$(basename "$dev")" >/dev/null 2>&1 || true
  size="$(blockdev --getsize64 "$dev" 2>/dev/null)" || done_with failed disk_size
  [ "$size" -ge "$bytes" ] || done_with failed disk_too_small
  blkdiscard "$dev" >/dev/null 2>&1 || done_with failed discard_failed
  FIFO="$(mktemp -u /run/hivra-backup-restore.XXXXXXXX)"
  mkfifo -m 0600 "$FIFO" || done_with failed fifo_failed
  dd if="$FIFO" of="$dev" bs=4M iflag=fullblock conv=sparse,fsync status=none &
  WRITER=$!
  got="$(restic dump --quiet "$snap_id" "/$key.raw" 2>>"$JOBDIR/restic.err" \
    | tee "$FIFO" | sha256sum | awk '{print $1}'; exit "$#{PIPESTATUS[0]}")"
  DUMP_RC=$?
  wait "$WRITER"; WRITE_RC=$?
  rm -f "$FIFO"
  [ "$DUMP_RC" = 0 ] || done_with failed download_failed
  [ "$WRITE_RC" = 0 ] || done_with failed write_failed
  [ "$got" = "$sum" ] || done_with failed hash_mismatch
  add_disk_json "$key" "$sum" "$bytes" "$snap_id"
done < "$JOBDIR/disks"
`;

const RESTORE_BODY = String.raw`# A restore writes each backed-up disk over the same disk of the stopped
# computer. The computer stays stopped; whoever asked for the restore starts it.
` + RESTORE_CHECKS + RESTORE_WRITE + "done_with succeeded restored\n";

/** The marks the sleep scripts read: `cold-` lets a wake boot the computer from its disk, `stored-` says its disks are in the storage box. */
const STORE_MARKS = String.raw`MARK_DIR=/var/lib/hivra-sleep
COLD_MARK="$MARK_DIR/cold-$VMID"
STORED_MARK="$MARK_DIR/stored-$VMID"
mark_is() { [ "$(cat "$1" 2>/dev/null || true)" = "$EXPECTED_BINDING_TAG" ]; }
is_off() { [ "$(qm status "$VMID" 2>/dev/null | awk '$1=="status:" {print $2; exit}')" = stopped ]; }
has_snapshots() { printf '%s\n' "$CONFIG" | grep -q '^\['; }
`;

const STORE_BODY = STORE_MARKS + String.raw`# Packs a long sleeper into the storage box and frees its disks on this host.
# Only a computer that is off, with its saved memory already dropped (the cold
# mark). The disks are read without holding the computer, so its owner can wake
# it at any moment; then nothing is freed and this ends as an ordinary copy.
# The disks are freed only after every byte was read back from the storage box
# and the disks on the host still hash to exactly what was uploaded.
ACTIVE_LVS=""
cleanup() {
  local lv
  for lv in $ACTIVE_LVS; do lvchange -an "$lv" >/dev/null 2>&1 || true; done
  ACTIVE_LVS=""
}
check_storable() {
  read_config || done_with failed unreachable
  has_binding || done_with failed binding_mismatch
  [ -z "$(field lock)" ] || done_with skipped locked
  is_off || done_with skipped not_stopped
  mark_is "$COLD_MARK" || done_with skipped not_dropped
  has_snapshots && done_with skipped has_snapshots
  return 0
}
exec 9>/run/lock/hivra-vm-$VMID.lock
flock -x -w 30 9 || done_with skipped vm_busy
check_storable
DISK_LINES="$(disk_lines "$CONFIG")"
while read -r key volid; do
  [ -n "$key" ] || continue
  [ "$(storage_type "$#{volid%%:*}")" = lvmthin ] || done_with skipped unsupported_storage
done <<< "$DISK_LINES"
printf '%s\n' "$CONFIG" > "$JOBDIR/vm.conf"
flock -u 9
exec 9>&-
if ! restic cat config >/dev/null 2>&1; then
  ssh -o BatchMode=yes cold mkdir -p "$REPO_FOLDER" >/dev/null 2>&1 || true
  restic init >/dev/null 2>&1 || done_with failed repo_init
fi
restic unlock >/dev/null 2>&1 || true
BACKUP_ARGS=(--host "hivra-$AGENT_ID" --tag hivra-computer --tag hivra-stored --tag "job-$JOB_ID" --json --quiet)
[ "$UPLOAD_LIMIT_KIB" -gt 0 ] && BACKUP_ARGS+=(--limit-upload "$UPLOAD_LIMIT_KIB")
restic backup "$#{BACKUP_ARGS[@]}" --stdin-from-command --stdin-filename vm.conf -- cat "$JOBDIR/vm.conf" \
  > "$JOBDIR/conf.json" 2>"$JOBDIR/restic.err" || done_with failed upload_failed
COUNT=0
: > "$JOBDIR/stored-disks"
while read -r key volid; do
  [ -n "$key" ] || continue
  COUNT=$((COUNT + 1))
  dev="$(pvesm path "$volid" 2>/dev/null)" || done_with failed disk_path
  lv="$(basename "$(dirname "$dev")")/$(basename "$dev")"
  lvchange -ay "$lv" >/dev/null 2>&1 || true
  ACTIVE_LVS="$ACTIVE_LVS $lv"
  bytes="$(blockdev --getsize64 "$dev" 2>/dev/null)" || done_with failed disk_size
  ionice -c3 nice -n 10 restic backup "$#{BACKUP_ARGS[@]}" --stdin-from-command --stdin-filename "$key.raw" \
    -- /bin/bash "$JOBDIR/read-disk.sh" "$dev" "$JOBDIR/$key.sha256" \
    > "$JOBDIR/$key.json" 2>>"$JOBDIR/restic.err" || done_with failed upload_failed
  sum="$(cat "$JOBDIR/$key.sha256" 2>/dev/null)"
  snap_id="$(restic_json_field snapshot_id < "$JOBDIR/$key.json")"
  added="$(restic_json_field data_added < "$JOBDIR/$key.json")"
  [[ "$sum" =~ ^[0-9a-f]{64}$ ]] || done_with failed hash_missing
  [[ "$snap_id" =~ ^[0-9a-f]{64}$ ]] || done_with failed snapshot_id_missing
  [[ "$added" =~ ^[0-9]+$ ]] || added=0
  ADDED=$((ADDED + added))
  add_disk_json "$key" "$sum" "$bytes" "$snap_id"
  printf '%s %s %s %s\n' "$key" "$sum" "$snap_id" "$dev" >> "$JOBDIR/stored-disks"
done <<< "$DISK_LINES"
[ "$COUNT" -gt 0 ] || done_with failed no_disks
# Read every disk back from the storage box before anything is freed.
while read -r key sum snap_id dev; do
  [ -n "$key" ] || continue
  got="$(restic dump --quiet "$snap_id" "/$key.raw" 2>>"$JOBDIR/restic.err" | sha256sum | awk '{print $1}'; exit "$#{PIPESTATUS[0]}")" \
    || done_with failed download_failed
  [ "$got" = "$sum" ] || done_with failed hash_mismatch
done < "$JOBDIR/stored-disks"
# From here the computer is held: a wake waits, then finds it stored.
exec 9>/run/lock/hivra-vm-$VMID.lock
flock -x -w 60 9 || done_with skipped vm_busy_late
check_storable
[ "$(disk_lines "$CONFIG")" = "$DISK_LINES" ] || done_with skipped changed_meanwhile
while read -r key sum snap_id dev; do
  [ -n "$key" ] || continue
  now_sum="$(dd if="$dev" bs=4M iflag=direct status=none | sha256sum | awk '{print $1}'; exit "$#{PIPESTATUS[0]}")" \
    || done_with failed reread_failed
  [ "$now_sum" = "$sum" ] || done_with skipped changed_meanwhile
done < "$JOBDIR/stored-disks"
# The stored mark goes down first: a computer whose disks are being freed must never read as bootable.
install -d -m 0700 "$MARK_DIR" || done_with failed mark_failed
printf '%s\n' "$EXPECTED_BINDING_TAG" > "$STORED_MARK" || done_with failed mark_failed
rm -f "$COLD_MARK" || { rm -f "$STORED_MARK"; done_with failed mark_failed; }
FREE_FAILED=0
while read -r key sum snap_id dev; do
  [ -n "$key" ] || continue
  blkdiscard "$dev" >/dev/null 2>&1 || FREE_FAILED=1
done < "$JOBDIR/stored-disks"
# A disk that could not be freed is half empty at worst: the copy in the storage box is the computer now.
[ "$FREE_FAILED" = 0 ] || done_with succeeded stored_free_partial
done_with succeeded stored
`;

const UNSTORE_BODY = STORE_MARKS + String.raw`# Brings a stored computer back: writes each disk from the storage box over the
# freed disk, then swaps the stored mark for the cold mark, so the wake boots it.
` + RESTORE_CHECKS + String.raw`mark_is "$STORED_MARK" || done_with failed not_stored
` + RESTORE_WRITE + String.raw`printf '%s\n' "$EXPECTED_BINDING_TAG" > "$COLD_MARK" || done_with failed mark_failed
rm -f "$STORED_MARK"
done_with succeeded restored
`;

export interface BackupStartInput {
  kind: BackupJobKind;
  jobId: string;
  agentId: string;
  vmid: number;
  bindingTag: string;
  keepDaily: number;
  keepWeekly: number;
  /** restic --limit-upload in KiB/s, 0 for none. */
  uploadLimitKiB: number;
  /** Hours the unit may run before systemd stops it. */
  maxHours: number;
  /** The backup to read back (drill) or write over the computer (restore). */
  disks?: BackupDisk[];
  /** Shell that installs the `cold` alias (from cold-storage-ssh). */
  coldStorageInstall: string;
}

function body(kind: BackupJobKind): string {
  switch (kind) {
    case "backup": return BACKUP_BODY;
    case "drill": return DRILL_BODY;
    case "restore": return RESTORE_BODY;
    case "store": return STORE_BODY;
    case "unstore": return UNSTORE_BODY;
  }
}

/** The bodies spell shell's dollar-brace as `$#{` so the template literal leaves it alone. */
function shellText(text: string): string {
  return text.replaceAll("$#{", "$" + "{");
}

/** The two files a job runs from, as the start script writes them. For tests that run a job against a fake host. */
export function backupJobFiles(kind: BackupJobKind): { run: string; readDisk: string } {
  return { run: `${shellText(JOB_COMMON)}\n${shellText(body(kind))}`, readDisk: shellText(READ_DISK) };
}

/**
 * Starts one job on the host. Reads the repository password from stdin.
 * Prints exactly one HIVRA_BACKUP_START line.
 */
export function buildBackupStartScript(input: BackupStartInput): string {
  const kind = input.kind;
  if (kind !== "backup" && kind !== "drill" && kind !== "restore" && kind !== "store" && kind !== "unstore") {
    throw new Error("Invalid backup job kind");
  }
  const jobId = checkedUuid(input.jobId, "job id");
  const agentId = checkedUuid(input.agentId, "agent id");
  const vmid = checkedVmid(input.vmid);
  const tag = checkedTag(input.bindingTag);
  const keepDaily = checkedInt(input.keepDaily, 1, 90, "daily retention");
  const keepWeekly = checkedInt(input.keepWeekly, 0, 52, "weekly retention");
  const limit = checkedInt(input.uploadLimitKiB, 0, 10_000_000, "upload limit");
  const maxHours = checkedInt(input.maxHours, 1, 24, "job time limit");
  const disks = kind === "backup" || kind === "store" ? [] : checkedDisks(input.disks ?? []);
  if (kind === "unstore" && disks.length === 0) throw new Error("A stored computer needs its disk list to come back");
  if (typeof input.coldStorageInstall !== "string" || input.coldStorageInstall.length < 1) {
    throw new Error("Cold storage install script missing");
  }
  const unit = backupUnitName(jobId);
  const jobDir = `${BACKUP_JOB_ROOT}/${jobId}`;
  const params = [
    `JOB_ID=${shellQuote(jobId)}`,
    `KIND=${shellQuote(kind)}`,
    `AGENT_ID=${shellQuote(agentId)}`,
    `VMID=${vmid}`,
    `EXPECTED_BINDING_TAG=${shellQuote(tag)}`,
    `KEEP_DAILY=${keepDaily}`,
    `KEEP_WEEKLY=${keepWeekly}`,
    `UPLOAD_LIMIT_KIB=${limit}`,
    `REPO_FOLDER=${shellQuote(BACKUP_REPO_FOLDER)}`,
  ].join("\n");
  const diskList = disks.map((d) => `${d.key} ${d.sha256} ${d.bytes} ${d.snapshotId}`).join("\n");
  return `set -euo pipefail
umask 077
finish() { printf '%s{"ok":%s,"reason":"%s","job":"%s"}\\n' ${shellQuote(BACKUP_START_PREFIX)} "$1" "$2" ${shellQuote(jobId)}; exit 0; }
IFS= read -r RESTIC_PW || true
[ "\${#RESTIC_PW}" -ge 32 ] || finish false no_password
install -d -m 0700 /etc/hivra/keys
${input.coldStorageInstall}
if ! command -v restic >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y restic >/dev/null 2>&1 || finish false restic_missing
fi
RV="$(restic version 2>/dev/null | awk '{print $2}')"
case "$RV" in 0.1[7-9].*|0.[2-9][0-9].*|[1-9]*) ;; *) finish false restic_too_old ;; esac
command -v systemd-run >/dev/null 2>&1 || finish false systemd_run_missing
systemctl is-active --quiet ${shellQuote(`${unit}.service`)} && finish false already_running
exec 3>/run/lock/hivra-computer-backup.lock
flock -n 3 || finish false host_busy
flock -u 3
exec 3>&-
install -d -m 0700 ${shellQuote(BACKUP_JOB_ROOT)}
JOBDIR=${shellQuote(jobDir)}
[ ! -e "$JOBDIR" ] || finish false job_exists
install -d -m 0700 "$JOBDIR"
cat > "$JOBDIR/params" <<'HIVRA_BACKUP_PARAMS'
${params}
HIVRA_BACKUP_PARAMS
cat > "$JOBDIR/disks" <<'HIVRA_BACKUP_DISKS'
${diskList}
HIVRA_BACKUP_DISKS
printf 'RESTIC_REPOSITORY=%s\\nRESTIC_PASSWORD=%s\\n' ${shellQuote(backupRepository(agentId))} "$RESTIC_PW" > "$JOBDIR/secret"
unset RESTIC_PW
cat > "$JOBDIR/read-disk.sh" <<'HIVRA_BACKUP_READ'
${shellText(READ_DISK)}HIVRA_BACKUP_READ
cat > "$JOBDIR/run.sh" <<'HIVRA_BACKUP_RUN'
${shellText(JOB_COMMON)}
${shellText(body(kind))}HIVRA_BACKUP_RUN
chmod 0700 "$JOBDIR/run.sh" "$JOBDIR/read-disk.sh"
systemd-run --quiet --collect --unit ${shellQuote(unit)} \\
  -p Nice=10 -p IOSchedulingClass=idle -p RuntimeMaxSec=${maxHours}h \\
  /bin/bash "$JOBDIR/run.sh" </dev/null >/dev/null 2>&1 || { rm -rf -- "$JOBDIR"; finish false start_failed; }
finish true started
`;
}

export interface BackupStartReceipt { ok: boolean; reason: string; job: string }

export function parseBackupStartReceipt(stdout: string, jobId: string): BackupStartReceipt | null {
  const lines = (stdout ?? "").split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.startsWith(BACKUP_START_PREFIX));
  if (lines.length !== 1) return null;
  try {
    const row = JSON.parse(lines[0].slice(BACKUP_START_PREFIX.length)) as Partial<BackupStartReceipt>;
    if (typeof row.ok !== "boolean" || row.job !== jobId || typeof row.reason !== "string" || !/^[a-z_]{1,40}$/.test(row.reason)) return null;
    return row as BackupStartReceipt;
  } catch {
    return null;
  }
}

/**
 * Reports each job: still running, finished (with its result), or gone.
 * Folders of finished jobs older than three days are removed.
 */
export function buildBackupPollScript(jobIds: string[]): string {
  if (!Array.isArray(jobIds) || jobIds.length > 50) throw new Error("Invalid job list");
  const ids = jobIds.map((id) => checkedUuid(id, "job id"));
  return `set -uo pipefail
ROOT=${shellQuote(BACKUP_JOB_ROOT)}
report() {
  local id="$1" dir="$ROOT/$1"
  if [ -s "$dir/result.json" ]; then
    printf '%s%s %s\\n' ${shellQuote(BACKUP_JOB_PREFIX)} "$id" "$(head -c 8192 "$dir/result.json" | tr -d '\\n')"
  elif systemctl is-active --quiet "hivra-computer-backup-$id.service"; then
    printf '%s%s running\\n' ${shellQuote(BACKUP_JOB_PREFIX)} "$id"
  else
    printf '%s%s missing\\n' ${shellQuote(BACKUP_JOB_PREFIX)} "$id"
  fi
}
${ids.map((id) => `report ${shellQuote(id)}`).join("\n")}
[ -d "$ROOT" ] && find "$ROOT" -mindepth 1 -maxdepth 1 -type d -mtime +3 -exec rm -rf -- {} + 2>/dev/null
exit 0
`;
}

export type PolledJob =
  | { jobId: string; state: "running" }
  | { jobId: string; state: "missing" }
  | {
    jobId: string;
    state: "finished";
    status: "succeeded" | "failed" | "skipped";
    reason: string;
    addedBytes: number;
    disks: BackupDisk[];
    finishedAt: string | null;
  };

export function parseBackupPoll(stdout: string): PolledJob[] {
  const out: PolledJob[] = [];
  for (const raw of (stdout ?? "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.startsWith(BACKUP_JOB_PREFIX)) continue;
    const rest = line.slice(BACKUP_JOB_PREFIX.length);
    const space = rest.indexOf(" ");
    if (space < 0) continue;
    const jobId = rest.slice(0, space);
    const value = rest.slice(space + 1).trim();
    if (!UUID_RE.test(jobId)) continue;
    if (value === "running" || value === "missing") { out.push({ jobId, state: value }); continue; }
    try {
      const row = JSON.parse(value) as Record<string, unknown>;
      const status = row.status;
      if (row.job !== jobId || (status !== "succeeded" && status !== "failed" && status !== "skipped")) continue;
      const reason = typeof row.reason === "string" && /^[a-z_]{1,40}$/.test(row.reason) ? row.reason : "unknown";
      const disks: BackupDisk[] = [];
      for (const d of Array.isArray(row.disks) ? row.disks : []) {
        const disk = d as Record<string, unknown>;
        const candidate = { key: String(disk.key), sha256: String(disk.sha256), bytes: Number(disk.bytes), snapshotId: String(disk.snapshotId) };
        try { checkedDisks([candidate]); disks.push(candidate); } catch { /* a malformed disk is dropped */ }
      }
      const added = Number(row.addedBytes);
      out.push({
        jobId,
        state: "finished",
        status,
        reason,
        addedBytes: Number.isSafeInteger(added) && added >= 0 ? added : 0,
        disks,
        finishedAt: typeof row.finishedAt === "string" && !Number.isNaN(Date.parse(row.finishedAt)) ? row.finishedAt : null,
      });
    } catch {
      /* unreadable result: reported as missing by the caller's timeout */
    }
  }
  return out;
}

/** Removes a deleted computer's whole repository from the storage box. */
export function buildBackupPurgeScript(agentId: string, coldStorageInstall: string): string {
  const id = checkedUuid(agentId, "agent id");
  const path = `${BACKUP_REPO_FOLDER}/${id}`;
  return `set -uo pipefail
finish() { printf '%s{"ok":%s,"reason":"%s"}\\n' ${shellQuote(BACKUP_PURGE_PREFIX)} "$1" "$2"; exit 0; }
install -d -m 0700 /etc/hivra/keys
${coldStorageInstall}
if ssh -o BatchMode=yes -o ConnectTimeout=20 cold ls ${shellQuote(path)} >/dev/null 2>&1; then
  ssh -o BatchMode=yes -o ConnectTimeout=20 cold rm -rf ${shellQuote(path)} >/dev/null 2>&1 || finish false remove_failed
  ssh -o BatchMode=yes -o ConnectTimeout=20 cold ls ${shellQuote(path)} >/dev/null 2>&1 && finish false still_present
  finish true removed
fi
finish true absent
`;
}

export function parseBackupPurgeReceipt(stdout: string): { ok: boolean; reason: string } | null {
  const lines = (stdout ?? "").split("\n").filter((l) => l.startsWith(BACKUP_PURGE_PREFIX));
  if (lines.length !== 1) return null;
  try {
    const row = JSON.parse(lines[0].slice(BACKUP_PURGE_PREFIX.length)) as { ok?: unknown; reason?: unknown };
    if (typeof row.ok !== "boolean" || typeof row.reason !== "string" || !/^[a-z_]{1,40}$/.test(row.reason)) return null;
    return { ok: row.ok, reason: row.reason };
  } catch {
    return null;
  }
}
