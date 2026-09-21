#!/usr/bin/env bash
# backup-vm-restic.sh — granular per-instance data backup for HermesOS tenants.
#
# Run from a PVE host. Args: <vmid> <instance-id> <tier> [guest-ip] [--apply]
#
# Unlike backup-vm-daily.sh (whole-VM vzdump), this backs up only the tenant's
# *data* volumes with file-level granularity, so a single chat/file is restorable:
#   - webui-state     (/home/hermes/.hermes)  minus regenerable caches
#   - webui-workspace (/workspace)
# It does NOT snapshot the whole disk, so it needs no host RAM headroom and is
# immune to the live-vzdump OOM/preflight fragility.
#
# Flow: the host reads the guest's Docker volumes via `sudo rsync` into a per-instance
# mirror, then `restic` dedups+encrypts the mirror to the Hetzner Storage Box.
# The Storage Box SSH key lives ONLY on the PVE host (installed by the caller) and is
# never placed on a guest VM — tenant isolation is preserved.
#
# restic repo: sftp:cold:restic/<instance-id>  (one repo per instance)
# RESTIC_PASSWORD must be provided in the environment by the caller (the cron route
# derives it per-instance: HMAC(HERMES_RESTIC_MASTER_KEY, instance_id)).
#
# Default is dry-run. Pass --apply to execute.

set -euo pipefail

VMID="${1:-}"
INSTANCE_ID="${2:-}"
TIER="${3:-}"

GUEST_IP=""
MODE="--dry-run"
shift 3 2>/dev/null || true
for a in "$@"; do
  case "$a" in
    --apply) MODE="--apply" ;;
    --dry-run) MODE="--dry-run" ;;
    "") ;;
    *) GUEST_IP="$a" ;;
  esac
done

if [ -z "$VMID" ] || [ -z "$INSTANCE_ID" ] || [ -z "$TIER" ]; then
  echo "usage: $0 <vmid> <instance-id> <tier> [guest-ip] [--apply]" >&2
  exit 1
fi

# Keep a universal restore safety net, including the base credit tier. Unknown
# tiers are still refused so a caller typo cannot silently select a policy.
case "$TIER" in
  operator|fleet|command|ws_cloud_pro|ws_cloud_power|credit_base|credit_pro|credit_power|paid|pro|power) : ;;
  *) echo "refusing restic backup for unsupported tier: $TIER" >&2; exit 2 ;;
esac

# Defense-in-depth: validate instance id shape (the caller also validates).
if ! [[ "$INSTANCE_ID" =~ ^[0-9a-f-]{36}$ ]]; then
  echo "unsafe instance id: $INSTANCE_ID" >&2; exit 1
fi

VM_SSH_KEY="${HERMES_VM_ORCHESTRATOR_KEY:-/etc/hivra/keys/vm-orchestrator}"
MIRROR_ROOT="${HERMES_RESTIC_MIRROR_ROOT:-/var/lib/hermes-restic-src}"
SRC="$MIRROR_ROOT/$INSTANCE_ID"
REPO="${HERMES_RESTIC_REPO_OVERRIDE:-sftp:cold:restic/$INSTANCE_ID}"
export RESTIC_CACHE_DIR="${RESTIC_CACHE_DIR:-/var/lib/hermes-restic-cache}"
KEEP_DAILY="${HERMES_RESTIC_KEEP_DAILY:-7}"
KEEP_WEEKLY="${HERMES_RESTIC_KEEP_WEEKLY:-4}"
KEEP_MONTHLY="${HERMES_RESTIC_KEEP_MONTHLY:-3}"

# Cache / regenerable dirs excluded from webui-state (relative to the volume root).
# Keep chats/sessions/journals/profiles/config/agent-memory; drop model + pkg caches.
WEBUI_STATE_EXCLUDES=(
  "home/.cache" "home/.npm" "home/.local/share/uv" "home/.local/share/pnpm"
  "**/node_modules" "**/__pycache__" "**/.venv" "**/*.tmp"
)
WORKSPACE_EXCLUDES=(
  "**/node_modules" "**/.venv" "**/__pycache__" "**/.git/objects"
  "**/target/debug" "**/target/release"
)

# SSH options as a plain whitespace-delimited string (no value contains a space),
# safe for both rsync -e and direct ssh invocation.
SSH_OPTS="-i $VM_SSH_KEY -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4"

# Derive the guest IP from the host's authoritative qm config if not supplied.
if [ -z "$GUEST_IP" ]; then
  GUEST_IP="$(qm config "$VMID" 2>/dev/null | sed -n 's#^ipconfig0:.*[^0-9]ip=\([0-9][0-9.]\{6,\}\).*#\1#p' | head -1)"
fi
if [ -z "$GUEST_IP" ]; then
  echo "REFUSING_BACKUP_NO_GUEST_IP vmid=$VMID instance=$INSTANCE_ID" >&2; exit 3
fi

WEBUI_STATE_VOL="/var/lib/docker/volumes/agent-${INSTANCE_ID}_webui-state/_data"
WORKSPACE_VOL="/var/lib/docker/volumes/agent-${INSTANCE_ID}_webui-workspace/_data"

echo "RESTIC_BACKUP_BEGIN vmid=$VMID instance=$INSTANCE_ID tier=$TIER guest_ip=$GUEST_IP repo=$REPO mode=$MODE host=$(hostname)"

if [ "$MODE" != "--apply" ]; then
  echo "DRY_RUN would rsync $WEBUI_STATE_VOL + $WORKSPACE_VOL from $GUEST_IP into $SRC, then restic backup -> $REPO"
  echo "DRY_RUN retention: --keep-daily $KEEP_DAILY --keep-weekly $KEEP_WEEKLY --keep-monthly $KEEP_MONTHLY"
  exit 0
fi

# A mirror is temporary staging on the PVE root disk. Refuse to begin a new
# staging copy when the host is already short on space; a successful snapshot
# removes its mirror below.
mkdir -p "$MIRROR_ROOT"
MIN_HOST_DISK_MB="${HERMES_RESTIC_MIN_DISK_FLOOR_MB:-8000}"
AVAIL_MB="$(df -BM --output=avail "$MIRROR_ROOT" 2>/dev/null | tail -1 | tr -dc '0-9')"
if [ -n "$AVAIL_MB" ] && [ "$AVAIL_MB" -lt "$MIN_HOST_DISK_MB" ]; then
  echo "REFUSING_BACKUP_LOW_HOST_DISK avail_mb=$AVAIL_MB floor_mb=$MIN_HOST_DISK_MB root=$MIRROR_ROOT vmid=$VMID instance=$INSTANCE_ID host=$(hostname)" >&2
  exit 9
fi

if [ -z "${RESTIC_PASSWORD:-}" ]; then
  echo "REFUSING_BACKUP_NO_RESTIC_PASSWORD vmid=$VMID instance=$INSTANCE_ID" >&2; exit 4
fi
if ! command -v restic >/dev/null 2>&1; then
  echo "restic not installed; attempting apt-get install" >&2
  DEBIAN_FRONTEND=noninteractive apt-get install -y restic >/dev/null 2>&1 || { echo "RESTIC_INSTALL_FAILED" >&2; exit 5; }
fi

# Serialize per-instance runs on this host.
LOCK="/var/lock/hermes-restic-$INSTANCE_ID.lock"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "ALREADY_RUNNING instance=$INSTANCE_ID" >&2; exit 0
fi

mkdir -p "$SRC/webui-state" "$SRC/webui-workspace" "$RESTIC_CACHE_DIR"

# --- rsync the guest volumes into the host mirror. `sudo rsync` on the guest reads
#     root-owned Docker volume data; retry to ride out transient guest reboots / net blips. ---
rsync_pull() {
  local remote="$1" dest="$2"; shift 2
  local excludes=("$@")
  local args=(-a --delete --partial --timeout=180 --rsync-path="sudo rsync" -e "ssh $SSH_OPTS")
  local e; for e in "${excludes[@]}"; do args+=(--exclude "$e"); done
  local attempt
  for attempt in 1 2 3; do
    if ionice -c2 -n7 nice -n10 rsync "${args[@]}" "hermes@$GUEST_IP:$remote/" "$dest/"; then
      echo "RSYNC_OK src=$remote attempt=$attempt"
      return 0
    fi
    echo "RSYNC_RETRY src=$remote attempt=$attempt" >&2
    sleep $((attempt * 10))
  done
  echo "RSYNC_FAILED src=$remote" >&2
  return 1
}

# webui-state is required; workspace is best-effort (large, and may be huge/absent).
rsync_pull "$WEBUI_STATE_VOL" "$SRC/webui-state" "${WEBUI_STATE_EXCLUDES[@]}" \
  || { echo "RESTIC_BACKUP_ABORT reason=webui_state_rsync_failed" >&2; exit 6; }
WORKSPACE_OK=1
if ssh $SSH_OPTS "hermes@$GUEST_IP" "sudo test -d $WORKSPACE_VOL" 2>/dev/null; then
  rsync_pull "$WORKSPACE_VOL" "$SRC/webui-workspace" "${WORKSPACE_EXCLUDES[@]}" || WORKSPACE_OK=0
else
  echo "WORKSPACE_ABSENT vol=$WORKSPACE_VOL"
fi

# --- restic: init-if-needed, clear stale locks, snapshot, prune ---
if ! restic -r "$REPO" cat config >/dev/null 2>&1; then
  echo "RESTIC_INIT repo=$REPO"
  restic -r "$REPO" init >/dev/null 2>&1 || { echo "RESTIC_INIT_FAILED repo=$REPO" >&2; exit 7; }
fi
restic -r "$REPO" unlock >/dev/null 2>&1 || true

BACKUP_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
set +e
BACKUP_OUT="$(ionice -c2 -n7 nice -n10 restic -r "$REPO" backup \
  --tag hermes-daily --tag "instance:$INSTANCE_ID" \
  --host "$INSTANCE_ID" \
  "$SRC/webui-state" "$SRC/webui-workspace" 2>&1)"
BACKUP_RC=$?
set -e
echo "$BACKUP_OUT" | tail -12
if [ "$BACKUP_RC" -ne 0 ]; then
  echo "RESTIC_BACKUP_FAILED rc=$BACKUP_RC instance=$INSTANCE_ID" >&2
  exit 8
fi

SNAP_ID="$(restic -r "$REPO" snapshots --json --latest 1 2>/dev/null | sed -n 's/.*"short_id":"\([0-9a-f]*\)".*/\1/p' | tail -1)"
if [ -z "$SNAP_ID" ]; then
  echo "RESTIC_SNAPSHOT_VERIFY_FAILED instance=$INSTANCE_ID; preserving mirror=$SRC" >&2
  exit 8
fi

# Retention: prune old restore points (cheap thanks to dedup).
restic -r "$REPO" forget \
  --keep-daily "$KEEP_DAILY" --keep-weekly "$KEEP_WEEKLY" --keep-monthly "$KEEP_MONTHLY" \
  --prune >/dev/null 2>&1 || echo "RESTIC_FORGET_WARN instance=$INSTANCE_ID" >&2

echo "RESTIC_BACKUP_OK instance=$INSTANCE_ID snapshot=${SNAP_ID:-unknown} ts=$BACKUP_TS workspace_ok=$WORKSPACE_OK repo=$REPO host=$(hostname)"

# The off-host snapshot is now authoritative. Keeping a full copy for every
# tenant on the PVE root disk grows without bound and eventually blocks every
# backup on that host. Remove only the exact, UUID-validated staging path after
# snapshot verification; a failed backup deliberately preserves it for diagnosis.
case "$SRC" in
  "$MIRROR_ROOT"/"$INSTANCE_ID")
    MIRROR_KB="$(du -sk "$SRC" 2>/dev/null | cut -f1)"; MIRROR_KB="${MIRROR_KB:-0}"
    if rm -rf -- "$SRC"; then
      echo "RESTIC_MIRROR_CLEANUP_OK instance=$INSTANCE_ID freed_mb=$((MIRROR_KB / 1024))"
    else
      echo "RESTIC_MIRROR_CLEANUP_FAILED instance=$INSTANCE_ID mirror=$SRC" >&2
    fi
    ;;
  *)
    echo "RESTIC_MIRROR_CLEANUP_REFUSED unsafe_mirror_path=$SRC instance=$INSTANCE_ID" >&2
    ;;
esac
