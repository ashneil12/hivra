#!/bin/bash
# archive-vm-cold.sh — autonomous cold archive of one Hermes free-tier tenant VM.
#
# Run from a PVE host. Args: <vmid> <expected-instance-id>.
# Outputs:
#   cold:free/<instance-id>/data-<ts>.tar.zst
#   cold:meta/<instance-id>/<ts>.json
#
# Quiesce: stops the agent containers before tarring, restarts after.
# Restores VM's original power state (running/stopped) at the end.

set -euo pipefail

VMID="${1:-}"
EXPECTED_INSTANCE_ID="${2:-}"
if [ -z "$VMID" ] || [ -z "$EXPECTED_INSTANCE_ID" ]; then
  echo "usage: $0 <vmid> <expected-instance-id>" >&2; exit 1
fi

if ! qm config "$VMID" >/dev/null 2>&1; then
  echo "[$VMID] no such VM on $(hostname)" >&2; exit 1
fi

IP=$(qm config "$VMID" 2>/dev/null | grep -oE 'ip=10\.70\.[0-9]+\.[0-9]+' | head -1 | sed 's/ip=//')
[ -z "$IP" ] && { echo "[$VMID] no IP in qm config" >&2; exit 1; }

START_STATE=$(qm status "$VMID" | awk '{print $2}')
PVE_HOST=$(hostname)
TS=$(date -u +%Y%m%dT%H%M%SZ)
SCRATCH=""

# The caller has a hard serverless deadline and can close SSH while tar/upload is
# still running. Always restore the original stopped state on normal exit or a
# signal so an interrupted archive cannot leave a paused tenant VM powered on.
cleanup() {
  STATUS=$?
  trap - EXIT HUP INT TERM
  if [ -n "$SCRATCH" ]; then
    rm -rf "$SCRATCH"
  fi
  if [ "$START_STATE" != "running" ] && qm config "$VMID" >/dev/null 2>&1; then
    if [ "$(qm status "$VMID" | awk '{print $2}')" = "running" ]; then
      echo "  restoring original power state after exit/interruption (stopped)" >&2
      qm shutdown "$VMID" --timeout 60 >/dev/null 2>&1 || true
      if [ "$(qm status "$VMID" | awk '{print $2}')" = "running" ]; then
        qm stop "$VMID" >/dev/null 2>&1 || true
      fi
    fi
  fi
  exit "$STATUS"
}
trap cleanup EXIT HUP INT TERM

echo "═══ archive-vm-cold VMID=$VMID PVE=$PVE_HOST IP=$IP ts=$TS ═══"

if [ "$START_STATE" != "running" ]; then
  echo "  starting (was $START_STATE) ..."
  qm start "$VMID" >/dev/null
fi

SSH_OPTS=(-i /etc/hivra/keys/vm-orchestrator -o BatchMode=yes -o ConnectTimeout=5 \
          -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)
for _ in $(seq 1 30); do
  if ssh "${SSH_OPTS[@]}" "hermes@$IP" true 2>/dev/null; then break; fi
  sleep 5
done
ssh "${SSH_OPTS[@]}" "hermes@$IP" true 2>/dev/null || { echo "  ✗ guest SSH never came up" >&2; exit 2; }
echo "  guest SSH up"

INSTANCE_ID=$(ssh "${SSH_OPTS[@]}" "hermes@$IP" "sudo ls /opt/hermes/instances 2>/dev/null | head -1")
[ -z "$INSTANCE_ID" ] && { echo "  ✗ no /opt/hermes/instances/<id>" >&2; exit 2; }
if [ "$INSTANCE_ID" != "$EXPECTED_INSTANCE_ID" ]; then
  echo "  ✗ guest identity mismatch: expected $EXPECTED_INSTANCE_ID, reached $INSTANCE_ID at $IP; refusing before reading data or stopping containers" >&2
  exit 3
fi
echo "  instance id: $INSTANCE_ID"

# space-separated single-line paths (heredoc-safe)
TAR_PATHS="./opt/hermes/instances/$INSTANCE_ID ./var/lib/docker/volumes/agent-${INSTANCE_ID}_agent-source ./var/lib/docker/volumes/agent-${INSTANCE_ID}_webui-state ./var/lib/docker/volumes/agent-${INSTANCE_ID}_webui-workspace"

echo "  archiving:"
ssh "${SSH_OPTS[@]}" "hermes@$IP" "sudo du -sh /opt/hermes/instances/$INSTANCE_ID /var/lib/docker/volumes/agent-${INSTANCE_ID}_agent-source /var/lib/docker/volumes/agent-${INSTANCE_ID}_webui-state /var/lib/docker/volumes/agent-${INSTANCE_ID}_webui-workspace 2>/dev/null" | sed 's/^/    /'

SCRATCH=$(mktemp -d /tmp/hermes-archive-$VMID-XXXX)
LOCAL_ARCHIVE="$SCRATCH/data-$TS.tar.zst"

# ─── stop agent containers, tar+zstd, best-effort restart — one ssh session ───
# Important: the archive is valid if tar/zstd succeeds. Legacy paused VMs often
# contain stale container IDs or CPU limits that make `docker start` fail after
# capture. That must not invalidate the archive or block cold storage cleanup.
echo "  stopping containers, tarring, best-effort restarting (single remote session) ..."
START_TS=$(date +%s)
ssh "${SSH_OPTS[@]}" "hermes@$IP" \
  "set -e; \
   NAMES=\$(sudo docker ps --filter name=agent-$INSTANCE_ID --format '{{.Names}}' | tr '\n' ' '); \
   if [ -n \"\$NAMES\" ]; then sudo docker stop \$NAMES >/dev/null || true; fi; \
   sudo tar -C / -cf - --warning=no-file-changed $TAR_PATHS 2>/dev/null | zstd -3 -q; \
   STATUS=\${PIPESTATUS[0]}; \
   if [ \"$START_STATE\" = \"running\" ] && [ -n \"\$NAMES\" ]; then sudo docker start \$NAMES >/tmp/archive-restart.log 2>&1 || true; fi; \
   if [ \"\$STATUS\" -le 1 ]; then exit 0; fi; \
   exit \$STATUS" \
  > "$LOCAL_ARCHIVE"

ARCHIVE_SIZE=$(stat -c %s "$LOCAL_ARCHIVE" 2>/dev/null || stat -f %z "$LOCAL_ARCHIVE")
LOCAL_SHA=$(sha256sum "$LOCAL_ARCHIVE" | awk '{print $1}')
TAR_SEC=$(( $(date +%s) - START_TS ))
echo "    archive: $(numfmt --to=iec "$ARCHIVE_SIZE")  sha256:${LOCAL_SHA:0:16}…  ${TAR_SEC}s"

echo "  uploading PVE → Storage Box ..."
START_TS=$(date +%s)
ssh cold "mkdir -p free/$INSTANCE_ID meta/$INSTANCE_ID" >/dev/null
rsync -a --inplace --partial -e ssh \
  "$LOCAL_ARCHIVE" "cold:free/$INSTANCE_ID/data-$TS.tar.zst"
UP_SEC=$(( $(date +%s) - START_TS ))
echo "    uploaded in ${UP_SEC}s"

MANIFEST="$SCRATCH/manifest-$TS.json"
cat > "$MANIFEST" <<JSON
{
  "schema_version": 1,
  "archived_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "vmid": $VMID,
  "pve_host": "$PVE_HOST",
  "instance_id": "$INSTANCE_ID",
  "archive_path": "free/$INSTANCE_ID/data-$TS.tar.zst",
  "archive_size_bytes": $ARCHIVE_SIZE,
  "archive_sha256": "$LOCAL_SHA",
  "tier": "free",
  "contents": [
    "/opt/hermes/instances/$INSTANCE_ID",
    "/var/lib/docker/volumes/agent-${INSTANCE_ID}_agent-source",
    "/var/lib/docker/volumes/agent-${INSTANCE_ID}_webui-state",
    "/var/lib/docker/volumes/agent-${INSTANCE_ID}_webui-workspace"
  ]
}
JSON

rsync -a -e ssh "$MANIFEST" "cold:meta/$INSTANCE_ID/$TS.json"
echo "    manifest: meta/$INSTANCE_ID/$TS.json"

if [ "$START_STATE" != "running" ]; then
  echo "  restoring original power state (stopped)"
  qm shutdown "$VMID" --timeout 60 >/dev/null 2>&1 || true
fi

echo "═══ done: $INSTANCE_ID → cold:free/$INSTANCE_ID/data-$TS.tar.zst ═══"
# Final line is machine-parseable by the orchestrating bash on the laptop.
echo "MANIFEST sha256=$LOCAL_SHA size=$ARCHIVE_SIZE iid=$INSTANCE_ID ts=$TS vmid=$VMID host=$PVE_HOST"
