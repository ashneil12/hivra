// Host-side reconcile of the per-instance restic rsync mirrors.
//
// Each daily backup rsyncs a guest's data into /var/lib/hermes-restic-src/<id>
// and that mirror PERSISTS between runs (so the next rsync is incremental). But
// nothing ever removed a mirror when its instance was deleted or migrated to
// another host, so orphan mirrors accumulate on the ~80G host ROOT forever. Once
// free space drops below the disk-headroom floor, the backup script's guard
// (REFUSING_BACKUP_LOW_HOST_DISK) starts refusing EVERY backup on that host — the
// fixturenodea incident (2026-07-17), where 49G of mirrors + stale vzdumps filled the
// root and 10/10 of that host's backups failed with host_script_failed.
//
// The daily-instance-backups route runs this at the top of each host lane, before
// the backups, so a disk-pressured host reclaims its dead mirrors first and the
// guard has room again.

/**
 * Build the bash that removes stale per-instance mirrors on a PVE host.
 *
 * @param keepIds instance ids whose mirrors must be KEPT — the instances still
 *   live on this host, plus node-ambiguous (mid-provision/migration) rows. MUST
 *   already be validated to the instance-id shape by the caller; every id is
 *   embedded verbatim in a quoted heredoc.
 *
 * The script removes only UUID-named dirs NOT in that set, skips any dir with an
 * in-flight backup lock, and refuses outright if the keep-set is empty or
 * garbage (a defensive guard against wiping every mirror on a query hiccup).
 */
export function buildReconcileMirrorsScript(keepIds: string[]): string {
  const keepList = keepIds.join("\n");
  return `set -euo pipefail
MIRROR_ROOT="\${HERMES_RESTIC_MIRROR_ROOT:-/var/lib/hermes-restic-src}"
[ -d "$MIRROR_ROOT" ] || { echo "RECONCILE_SKIP no_mirror_root"; exit 0; }
KEEP_FILE="$(mktemp)"
trap 'rm -f "$KEEP_FILE"' EXIT
cat > "$KEEP_FILE" <<'HERMES_RESTIC_KEEP_SET'
${keepList}
HERMES_RESTIC_KEEP_SET
# Fail safe: never reconcile against an empty/garbage keep-set — that would trim
# EVERY mirror on the host. Require at least one valid instance id to proceed.
if ! grep -Eq '^[0-9a-f-]{36}$' "$KEEP_FILE"; then
  echo "RECONCILE_ABORT empty_or_invalid_keep_set"; exit 0
fi
removed=0; freed_kb=0
for dir in "$MIRROR_ROOT"/*/; do
  [ -d "$dir" ] || continue
  id="$(basename "$dir")"
  printf '%s' "$id" | grep -Eq '^[0-9a-f-]{36}$' || continue   # only touch instance-id dirs
  grep -qxF "$id" "$KEEP_FILE" && continue                     # still live here -> keep
  lock="/var/lock/hermes-restic-$id.lock"                      # skip if a backup is mid-flight
  if [ -e "$lock" ] && ! flock -n "$lock" true 2>/dev/null; then
    echo "RECONCILE_SKIP_LOCKED id=$id"; continue
  fi
  kb="$(du -sk "$dir" 2>/dev/null | cut -f1)"; kb="\${kb:-0}"
  if rm -rf "$dir"; then
    removed=$((removed + 1)); freed_kb=$((freed_kb + kb))
    echo "RECONCILE_REMOVED id=$id kb=$kb"
  else
    echo "RECONCILE_REMOVE_FAILED id=$id" >&2
  fi
done
echo "RECONCILE_DONE host=$(hostname) removed=$removed freed_mb=$((freed_kb / 1024)) mirror_root=$MIRROR_ROOT"
`;
}
