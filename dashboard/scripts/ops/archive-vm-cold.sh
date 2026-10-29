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

# >>> VMID-bound guest SSH: identical in backup-vm-restic.sh, archive-vm-cold.sh and restore-vm-cold.sh >>>
# Bash mirror of buildHermesVmidBoundGuestSshPrelude (dashboard/src/lib/proxmox/hermes-guest-ssh.ts).
# A guest IP is not an identity: a stale neighbour entry or a recycled IP can route an SSH connection to
# another tenant. attest_guest_ssh_pin runs before the first connection. It checks that VMID is a running
# VM configured with GUEST_IP, that it is not a Hivra computer, and that it has a QEMU Guest Agent channel.
# It then reads the guest's Ed25519 SSH host key through the agent (the VMID's virtio channel, not the
# network) and pins every later connection to that key in a private known_hosts file.
# Inputs: VMID, GUEST_IP, VM_SSH_KEY. Output: GUEST_SSH_PIN_OPTS (ssh options, no timeout or log level).
# On failure it prints a "VMID-bound SSH refused:" line and returns 1; the caller exits before contacting the guest.
GUEST_SSH_IDENTITY_DIR=""
GUEST_SSH_PIN_OPTS=()
guest_ssh_refuse() {
  printf 'VMID-bound SSH refused: %s; nothing was sent to the guest\n' "$1" >&2
}
cleanup_hivra_guest_ssh_identity() {
  case "${GUEST_SSH_IDENTITY_DIR:-}" in
    /run/hivra-guest-ssh-identity.*) rm -rf -- "$GUEST_SSH_IDENTITY_DIR" ;;
    "") ;;
    *) printf 'refusing to remove unexpected guest identity directory\n' >&2; return 1 ;;
  esac
}
attest_guest_ssh_pin() {
  # errexit is suspended inside this function when it runs as an if/|| condition,
  # so every check returns explicitly.
  local attempts="$1" config conf_ip tags agent attempt up=0 key_json key_line
  case "${GUEST_IP:-}" in
    ""|*[!0-9.]*) guest_ssh_refuse "the guest ip is not an IPv4 address"; return 1 ;;
  esac
  [ -f "${VM_SSH_KEY:-}" ] || { guest_ssh_refuse "this host has no guest SSH key at ${VM_SSH_KEY:-(unset)}"; return 1; }
  case "${VMID:-}" in
    ""|*[!0-9]*) guest_ssh_refuse "the vmid is not a number"; return 1 ;;
  esac
  config="$(qm config "$VMID" </dev/null 2>/dev/null)" \
    || { guest_ssh_refuse "VM $VMID does not exist on this host"; return 1; }
  [ "$(qm status "$VMID" </dev/null 2>/dev/null | awk '{print $2}')" = running ] \
    || { guest_ssh_refuse "VM $VMID is not running"; return 1; }
  conf_ip="$(printf '%s\n' "$config" | awk '
    /^ipconfig0:/ && !seen {
      seen = 1
      line = $0
      sub(/^ipconfig0:[ \t]*/, "", line)
      n = split(line, parts, ",")
      for (i = 1; i <= n; i++) {
        if (substr(parts[i], 1, 3) == "ip=") {
          value = substr(parts[i], 4)
          if (value ~ /^[0-9.]+\/[0-9]+$/) { sub(/\/[0-9]+$/, "", value); print value }
        }
      }
    }')"
  [ "$conf_ip" = "$GUEST_IP" ] \
    || { guest_ssh_refuse "VM $VMID is configured with ip ${conf_ip:-none}, not $GUEST_IP"; return 1; }
  tags="$(printf '%s\n' "$config" | awk '/^tags:/ && !seen { seen = 1; line = $0; sub(/^tags:[ \t]*/, "", line); gsub(/[;, ]+/, ";", line); print line }')"
  case ";$tags;" in
    *";hivra-bind-"*) guest_ssh_refuse "VM $VMID is a Hivra computer, not a Hermes instance VM"; return 1 ;;
  esac
  agent="$(printf '%s\n' "$config" | awk '/^agent:/ && !seen { seen = 1; line = $0; sub(/^agent:[ \t]*/, "", line); print line }')"
  case ",$agent," in
    *,1,*|*,on,*|*,yes,*|*,true,*|*,enabled=1,*|*,enabled=on,*|*,enabled=yes,*|*,enabled=true,*) ;;
    *) guest_ssh_refuse "VM $VMID has no QEMU Guest Agent channel, so its SSH host key can't be attested"; return 1 ;;
  esac
  for attempt in $(seq 1 "$attempts"); do
    if timeout 5 qm guest cmd "$VMID" ping </dev/null >/dev/null 2>&1; then up=1; break; fi
    if [ "$attempt" -lt "$attempts" ]; then sleep 5; fi
  done
  [ "$up" = 1 ] || { guest_ssh_refuse "QEMU Guest Agent in VM $VMID did not answer, so its SSH host key can't be attested"; return 1; }
  key_json="$(qm guest exec "$VMID" -- /bin/cat /etc/ssh/ssh_host_ed25519_key.pub </dev/null 2>/dev/null)" \
    || { guest_ssh_refuse "VM $VMID SSH host key could not be read through QEMU Guest Agent"; return 1; }
  key_line="$(printf '%s' "$key_json" | /usr/bin/python3 -c '
import base64,binascii,json,sys
try:
    document=json.load(sys.stdin)
    fields=document.get("out-data", "").strip().split()
    raw=base64.b64decode(fields[1], validate=True)
    expected=b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20"
    if document.get("exited") != 1 or document.get("exitcode") != 0 or len(fields) < 2 or fields[0] != "ssh-ed25519" or len(raw) != 51 or not raw.startswith(expected):
        raise ValueError("invalid VMID-bound SSH host key")
except (AttributeError,IndexError,KeyError,TypeError,ValueError,binascii.Error,json.JSONDecodeError):
    raise SystemExit(1)
print("ssh-ed25519 "+fields[1])
')" || { guest_ssh_refuse "VM $VMID did not attest a valid Ed25519 SSH host key"; return 1; }
  GUEST_SSH_IDENTITY_DIR="$(mktemp -d /run/hivra-guest-ssh-identity.XXXXXXXX)" \
    || { guest_ssh_refuse "no private directory for the attested SSH host key"; return 1; }
  chmod 0700 "$GUEST_SSH_IDENTITY_DIR"
  GUEST_SSH_KNOWN_HOSTS="$GUEST_SSH_IDENTITY_DIR/known_hosts"
  GUEST_SSH_HOST_ALIAS="hivra-vmid-$VMID"
  printf '%s %s\n' "$GUEST_SSH_HOST_ALIAS" "$key_line" > "$GUEST_SSH_KNOWN_HOSTS"
  chmod 0600 "$GUEST_SSH_KNOWN_HOSTS"
  GUEST_SSH_PIN_OPTS=(-i "$VM_SSH_KEY" -o BatchMode=yes -o IdentitiesOnly=yes
    -o StrictHostKeyChecking=yes -o HostKeyAlgorithms=ssh-ed25519 -o UpdateHostKeys=no
    -o GlobalKnownHostsFile=/dev/null -o UserKnownHostsFile="$GUEST_SSH_KNOWN_HOSTS"
    -o HostKeyAlias="$GUEST_SSH_HOST_ALIAS")
  return 0
}
# <<< VMID-bound guest SSH <<<

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
  cleanup_hivra_guest_ssh_identity || true
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

GUEST_IP="$IP"
VM_SSH_KEY=/etc/hivra/keys/vm-orchestrator
attest_guest_ssh_pin 36 || { echo "  ✗ guest identity not attested; refusing before any connection" >&2; exit 3; }
SSH_OPTS=("${GUEST_SSH_PIN_OPTS[@]}" -o ConnectTimeout=5 -o LogLevel=ERROR)
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
