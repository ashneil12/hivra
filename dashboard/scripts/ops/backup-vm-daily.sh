#!/usr/bin/env bash
# backup-vm-daily.sh — non-destructive daily VM backup for HermesOS paid tenants.
#
# Run from a PVE host. Args: <vmid> <instance-id> <tier>
#
# This is separate from archive-vm-cold.sh:
# - no lifecycle transition
# - no qm destroy
# - no dashboard DB mutation
# - intended for active paid instances
#
# It creates a Proxmox snapshot-mode vzdump archive, uploads it to the Hetzner
# Storage Box, writes the manifest last, then removes the local temporary dump.
#
# Default is dry-run. Pass --apply as the fourth arg to execute.

set -euo pipefail

VMID="${1:-}"
INSTANCE_ID="${2:-}"
TIER="${3:-}"
MODE="${4:---dry-run}"

if [ -z "$VMID" ] || [ -z "$INSTANCE_ID" ] || [ -z "$TIER" ]; then
  echo "usage: $0 <vmid> <instance-id> <tier> [--apply]" >&2
  exit 1
fi

case "$TIER" in
  operator|fleet|command|ws_cloud_pro|ws_cloud_power|credit_pro|credit_power|paid|pro|power) STORAGE_TIER="paid" ;;
  *) echo "refusing daily backup for unsupported tier: $TIER" >&2; exit 2 ;;
esac

if [ "$MODE" != "--apply" ]; then
  echo "DRY_RUN vmid=$VMID instance=$INSTANCE_ID tier=$TIER storage_tier=$STORAGE_TIER"
  echo "would run: vzdump $VMID --mode snapshot --compress zstd --dumpdir <scratch>"
  echo "would upload: daily/$STORAGE_TIER/$INSTANCE_ID/vzdump-qemu-$VMID-<ts>.vma.zst"
  echo "would write manifest last: daily-meta/$INSTANCE_ID/<ts>.json"
  exit 0
fi

if ! qm config "$VMID" >/dev/null 2>&1; then
  echo "[$VMID] no such VM on $(hostname)" >&2
  exit 3
fi

MIN_HOST_HEADROOM_MB="${HERMES_DAILY_BACKUP_MIN_HOST_HEADROOM_MB:-8192}"
MIN_SCRATCH_MB="${HERMES_DAILY_BACKUP_MIN_SCRATCH_MB:-32768}"

if ! [[ "$MIN_HOST_HEADROOM_MB" =~ ^[0-9]+$ ]]; then
  echo "invalid HERMES_DAILY_BACKUP_MIN_HOST_HEADROOM_MB=$MIN_HOST_HEADROOM_MB" >&2
  exit 5
fi
if ! [[ "$MIN_SCRATCH_MB" =~ ^[0-9]+$ ]]; then
  echo "invalid HERMES_DAILY_BACKUP_MIN_SCRATCH_MB=$MIN_SCRATCH_MB" >&2
  exit 6
fi

read -r MEM_TOTAL_KB MEM_AVAILABLE_KB SWAP_TOTAL_KB SWAP_FREE_KB < <(
  awk '
    /^MemTotal:/ { mt=$2 }
    /^MemAvailable:/ { ma=$2 }
    /^SwapTotal:/ { st=$2 }
    /^SwapFree:/ { sf=$2 }
    END { print mt+0, ma+0, st+0, sf+0 }
  ' /proc/meminfo
)
MEM_TOTAL_MB=$((MEM_TOTAL_KB / 1024))
MEM_AVAILABLE_MB=$((MEM_AVAILABLE_KB / 1024))
SWAP_TOTAL_MB=$((SWAP_TOTAL_KB / 1024))
SWAP_FREE_MB=$((SWAP_FREE_KB / 1024))
VM_STATUS="$(qm status "$VMID" 2>/dev/null || true)"
VM_MEMORY_MB="$(qm config "$VMID" 2>/dev/null | awk '/^memory:/ { print $2; exit }')"
VM_BALLOON_MB="$(qm config "$VMID" 2>/dev/null | awk '/^balloon:/ { print $2; exit }')"
VM_MEMORY_MB="${VM_MEMORY_MB:-unknown}"
VM_BALLOON_MB="${VM_BALLOON_MB:-unset}"
RUNNING_VM_MAX_MEMORY_MB=0
RUNNING_VM_EFFECTIVE_TOTAL_MB=0
while IFS= read -r RUNNING_VMID; do
  [ -n "$RUNNING_VMID" ] || continue
  RUNNING_VM_MEMORY_MB="$(qm config "$RUNNING_VMID" 2>/dev/null | awk '/^memory:/ { print $2; exit }')"
  RUNNING_VM_BALLOON_MB="$(qm config "$RUNNING_VMID" 2>/dev/null | awk '/^balloon:/ { print $2; exit }')"
  RUNNING_VM_EFFECTIVE_MEMORY_MB="$RUNNING_VM_MEMORY_MB"
  if [[ "$RUNNING_VM_BALLOON_MB" =~ ^[0-9]+$ ]] && [ "$RUNNING_VM_BALLOON_MB" -gt 0 ]; then
    RUNNING_VM_EFFECTIVE_MEMORY_MB="$RUNNING_VM_BALLOON_MB"
  fi
  if [[ "$RUNNING_VM_MEMORY_MB" =~ ^[0-9]+$ ]]; then
    RUNNING_VM_MAX_MEMORY_MB=$((RUNNING_VM_MAX_MEMORY_MB + RUNNING_VM_MEMORY_MB))
  fi
  if [[ "$RUNNING_VM_EFFECTIVE_MEMORY_MB" =~ ^[0-9]+$ ]]; then
    RUNNING_VM_EFFECTIVE_TOTAL_MB=$((RUNNING_VM_EFFECTIVE_TOTAL_MB + RUNNING_VM_EFFECTIVE_MEMORY_MB))
  fi
done < <(qm list | awk 'NR > 1 && $3 == "running" { print $1 }')
HOST_MEMORY_MARGIN_MB=$((MEM_TOTAL_MB - RUNNING_VM_EFFECTIVE_TOTAL_MB))

echo "MEMORY_PREFLIGHT vmid=$VMID status=${VM_STATUS:-unknown} host_mem_available_mb=$MEM_AVAILABLE_MB host_mem_total_mb=$MEM_TOTAL_MB host_swap_free_mb=$SWAP_FREE_MB host_swap_total_mb=$SWAP_TOTAL_MB vm_memory_mb=$VM_MEMORY_MB vm_balloon_mb=$VM_BALLOON_MB running_vm_max_memory_mb=$RUNNING_VM_MAX_MEMORY_MB running_vm_effective_memory_mb=$RUNNING_VM_EFFECTIVE_TOTAL_MB host_memory_margin_mb=$HOST_MEMORY_MARGIN_MB min_host_headroom_mb=$MIN_HOST_HEADROOM_MB"
if [ "$MEM_AVAILABLE_MB" -lt "$MIN_HOST_HEADROOM_MB" ]; then
  echo "REFUSING_BACKUP_LOW_HOST_MEMORY vmid=$VMID host_mem_available_mb=$MEM_AVAILABLE_MB min_host_headroom_mb=$MIN_HOST_HEADROOM_MB host_swap_free_mb=$SWAP_FREE_MB vm_memory_mb=$VM_MEMORY_MB vm_balloon_mb=$VM_BALLOON_MB status=${VM_STATUS:-unknown}" >&2
  exit 5
fi
if [ "$HOST_MEMORY_MARGIN_MB" -lt "$MIN_HOST_HEADROOM_MB" ]; then
  echo "REFUSING_BACKUP_UNSAFE_VM_MEMORY_FOOTPRINT vmid=$VMID host_mem_total_mb=$MEM_TOTAL_MB running_vm_max_memory_mb=$RUNNING_VM_MAX_MEMORY_MB running_vm_effective_memory_mb=$RUNNING_VM_EFFECTIVE_TOTAL_MB host_memory_margin_mb=$HOST_MEMORY_MARGIN_MB min_host_headroom_mb=$MIN_HOST_HEADROOM_MB host_mem_available_mb=$MEM_AVAILABLE_MB host_swap_free_mb=$SWAP_FREE_MB vm_memory_mb=$VM_MEMORY_MB vm_balloon_mb=$VM_BALLOON_MB status=${VM_STATUS:-unknown}" >&2
  exit 5
fi
declare -a SCRATCH_CANDIDATES=()
add_scratch_candidate() {
  local root="${1%/}"
  [ -n "$root" ] || return 0
  local existing
  for existing in "${SCRATCH_CANDIDATES[@]}"; do
    [ "$existing" = "$root" ] && return 0
  done
  SCRATCH_CANDIDATES+=("$root")
}

if [ -n "${HERMES_DAILY_BACKUP_SCRATCH_ROOTS:-}" ]; then
  IFS=',: ' read -r -a CONFIGURED_SCRATCH_ROOTS <<< "$HERMES_DAILY_BACKUP_SCRATCH_ROOTS"
  for root in "${CONFIGURED_SCRATCH_ROOTS[@]}"; do
    add_scratch_candidate "$root"
  done
else
  if command -v pvesm >/dev/null 2>&1; then
    while IFS= read -r storage_id; do
      [ -n "$storage_id" ] || continue
      storage_path="$(pvesm path "$storage_id" 2>/dev/null || true)"
      [ -n "$storage_path" ] || continue
      add_scratch_candidate "$storage_path/dump"
      add_scratch_candidate "$storage_path"
    done < <(pvesm status -content backup 2>/dev/null | awk 'NR > 1 && $3 == "active" { print $1 }')
  fi
  add_scratch_candidate "/var/lib/vz/dump"
  add_scratch_candidate "/var/tmp"
  add_scratch_candidate "/srv"
  add_scratch_candidate "/tmp"
fi

SCRATCH_ROOT=""
SCRATCH_ROOT_AVAIL_MB=0
SCRATCH_ROOT_FS="unknown"
select_scratch_root() {
  local best=""
  local best_avail=0
  local best_fs="unknown"
  local root avail fs
  for root in "${SCRATCH_CANDIDATES[@]}"; do
    mkdir -p "$root" >/dev/null 2>&1 || true
    if [ ! -d "$root" ] || [ ! -w "$root" ]; then
      echo "SCRATCH_CANDIDATE root=$root writable=no required_mb=$MIN_SCRATCH_MB"
      continue
    fi
    avail="$(df -Pm "$root" 2>/dev/null | awk 'NR == 2 { print $4+0 }')"
    fs="$(df -PT "$root" 2>/dev/null | awk 'NR == 2 { print $2 }')"
    avail="${avail:-0}"
    fs="${fs:-unknown}"
    echo "SCRATCH_CANDIDATE root=$root fs=$fs avail_mb=$avail required_mb=$MIN_SCRATCH_MB"
    if [[ "$avail" =~ ^[0-9]+$ ]] && [ "$avail" -ge "$MIN_SCRATCH_MB" ] && [ "$avail" -gt "$best_avail" ]; then
      best="$root"
      best_avail="$avail"
      best_fs="$fs"
    fi
  done
  if [ -z "$best" ]; then
    echo "REFUSING_BACKUP_NO_SCRATCH_SPACE vmid=$VMID required_mb=$MIN_SCRATCH_MB candidates=${SCRATCH_CANDIDATES[*]:-none}" >&2
    exit 6
  fi
  SCRATCH_ROOT="$best"
  SCRATCH_ROOT_AVAIL_MB="$best_avail"
  SCRATCH_ROOT_FS="$best_fs"
  echo "SCRATCH_SELECTED root=$SCRATCH_ROOT fs=$SCRATCH_ROOT_FS avail_mb=$SCRATCH_ROOT_AVAIL_MB required_mb=$MIN_SCRATCH_MB"
}
select_scratch_root

if [ "${HERMES_DAILY_BACKUP_PREFLIGHT_ONLY:-0}" = "1" ]; then
  echo "PREFLIGHT_OK vmid=$VMID host_memory_margin_mb=$HOST_MEMORY_MARGIN_MB host_mem_available_mb=$MEM_AVAILABLE_MB running_vm_effective_memory_mb=$RUNNING_VM_EFFECTIVE_TOTAL_MB running_vm_max_memory_mb=$RUNNING_VM_MAX_MEMORY_MB scratch_root=$SCRATCH_ROOT scratch_avail_mb=$SCRATCH_ROOT_AVAIL_MB scratch_required_mb=$MIN_SCRATCH_MB"
  exit 0
fi

PVE_HOST="$(hostname)"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
SCRATCH="$(mktemp -d "$SCRATCH_ROOT/hermes-daily-backup-$VMID-XXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

REMOTE_DIR="daily/$STORAGE_TIER/$INSTANCE_ID"
REMOTE_ARCHIVE="$REMOTE_DIR/vzdump-qemu-$VMID-$TS.vma.zst"
REMOTE_MANIFEST="daily-meta/$INSTANCE_ID/$TS.json"

# vzdump in snapshot mode is the key distinction from cold archive: source VM
# remains active and no application containers are deliberately stopped.
echo "═══ daily-backup VMID=$VMID PVE=$PVE_HOST instance=$INSTANCE_ID ts=$TS ═══"
vzdump "$VMID" \
  --mode snapshot \
  --compress zstd \
  --dumpdir "$SCRATCH" \
  --quiet 1

ARCHIVE="$(find "$SCRATCH" -maxdepth 1 -type f -name "vzdump-qemu-${VMID}-*.vma.zst" | head -1)"
if [ -z "$ARCHIVE" ] || [ ! -s "$ARCHIVE" ]; then
  echo "vzdump did not produce archive for VMID=$VMID" >&2
  exit 4
fi

ARCHIVE_SIZE="$(stat -c %s "$ARCHIVE" 2>/dev/null || stat -f %z "$ARCHIVE")"
ARCHIVE_SHA="$(sha256sum "$ARCHIVE" | awk '{print $1}')"

ssh cold "mkdir -p $REMOTE_DIR daily-meta/$INSTANCE_ID" >/dev/null
rsync -a --inplace --partial -e ssh "$ARCHIVE" "cold:$REMOTE_ARCHIVE"

MANIFEST="$SCRATCH/manifest-$TS.json"
cat > "$MANIFEST" <<JSON
{
  "schema_version": 2,
  "kind": "daily_vm_backup",
  "backed_up_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "instance_id": "$INSTANCE_ID",
  "vmid": $VMID,
  "pve_host": "$PVE_HOST",
  "tier": "$STORAGE_TIER",
  "backup_path": "$REMOTE_ARCHIVE",
  "backup_size_bytes": $ARCHIVE_SIZE,
  "backup_sha256": "$ARCHIVE_SHA",
  "mode": "vzdump_snapshot",
  "source_destroyed": false,
  "retention": {
    "daily_keep": 7
  }
}
JSON
rsync -a -e ssh "$MANIFEST" "cold:$REMOTE_MANIFEST"

# Keep a rolling 7-day set per paid instance. The manifest is the source of truth
# and is written last, so retention only runs after the new backup is durable.
RETENTION_META="$SCRATCH/retention-meta"
mkdir -p "$RETENTION_META"
rsync -a -e ssh "cold:daily-meta/$INSTANCE_ID/" "$RETENTION_META/" >/dev/null 2>&1 || true
mapfile -t RETENTION_MANIFESTS < <(find "$RETENTION_META" -maxdepth 1 -type f -name '*.json' | sort)
RETENTION_TOTAL="${#RETENTION_MANIFESTS[@]}"
RETENTION_KEEP=7
if [ "$RETENTION_TOTAL" -gt "$RETENTION_KEEP" ]; then
  RETENTION_DELETE_COUNT=$((RETENTION_TOTAL - RETENTION_KEEP))
  for OLD_MANIFEST_LOCAL in "${RETENTION_MANIFESTS[@]:0:$RETENTION_DELETE_COUNT}"; do
    OLD_MANIFEST_NAME="$(basename "$OLD_MANIFEST_LOCAL")"
    OLD_BACKUP_PATH="$(python3 - "$OLD_MANIFEST_LOCAL" "$INSTANCE_ID" <<'PY'
import json, re, sys
path=sys.argv[1]
instance_id=sys.argv[2]
try:
    data=json.load(open(path))
    backup=str(data.get('backup_path',''))
except Exception:
    sys.exit(0)
expected=f"daily/paid/{instance_id}/"
if not backup.startswith(expected):
    sys.exit(0)
if not re.match(r"^daily/paid/[0-9a-f-]{36}/vzdump-qemu-[0-9]+-[0-9]{8}T[0-9]{6}Z\.vma\.zst$", backup):
    sys.exit(0)
print(backup)
PY
)"
    if [ -n "$OLD_BACKUP_PATH" ]; then
      ssh cold "rm -f -- '$OLD_BACKUP_PATH' 'daily-meta/$INSTANCE_ID/$OLD_MANIFEST_NAME'" >/dev/null
      echo "RETENTION_DELETED manifest=daily-meta/$INSTANCE_ID/$OLD_MANIFEST_NAME archive=$OLD_BACKUP_PATH"
    else
      echo "RETENTION_SKIPPED unsafe_or_unreadable_manifest=$OLD_MANIFEST_NAME" >&2
    fi
  done
fi

echo "═══ done: $INSTANCE_ID → cold:$REMOTE_ARCHIVE ═══"
echo "BACKUP sha256=$ARCHIVE_SHA size=$ARCHIVE_SIZE iid=$INSTANCE_ID ts=$TS vmid=$VMID host=$PVE_HOST path=$REMOTE_ARCHIVE manifest=$REMOTE_MANIFEST"
