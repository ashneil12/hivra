#!/usr/bin/env bash
# Refresh the Hivra-owned guest gateway assets for one already-running Proxmox
# VM. The caller owns the provider-operation lease and FD8 host lock; this
# helper never powers the VM on/off and never touches agent files, native CLI
# credentials, model credentials, or the box API token.
set -euo pipefail
umask 077

VMID="${1:?usage: hivra-update-guest-runtime.sh VMID IP}"
IP="${2:?usage: hivra-update-guest-runtime.sh VMID IP}"
VM_KEY="${HIVRA_VM_SSH_KEY_PATH:-/etc/hivra/keys/vm-orchestrator}"
CHAT_PORT="${HIVRA_CHAT_PORT:-8080}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARCHIVE="$(mktemp "/tmp/hivra-runtime-${VMID}.XXXXXX.tar.gz")"
REMOTE_ARCHIVE="/tmp/hivra-runtime-update-${VMID}.tar.gz"
SSH_IDENTITY_HELPER="${HIVRA_GUEST_SSH_IDENTITY_HELPER:-${SRC_DIR}/hivra-guest-ssh-known-hosts}"
GUEST_SSH_IDENTITY_DIR=""
cleanup() {
  rm -f -- "$ARCHIVE"
  [ -z "$GUEST_SSH_IDENTITY_DIR" ] || rm -rf -- "$GUEST_SSH_IDENTITY_DIR"
}
trap cleanup EXIT

[[ "$VMID" =~ ^[0-9]+$ ]] && [ "$VMID" -ge 100 ] || { echo "invalid VMID" >&2; exit 1; }
[[ "$IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "invalid guest IP" >&2; exit 1; }
[[ "$CHAT_PORT" =~ ^[0-9]+$ ]] && [ "$CHAT_PORT" -ge 1 ] && [ "$CHAT_PORT" -le 65535 ] \
  || { echo "invalid chat port" >&2; exit 1; }
[ -f "$VM_KEY" ] || { echo "VM ssh key is missing" >&2; exit 1; }
[ -f "$SSH_IDENTITY_HELPER" ] && [ ! -L "$SSH_IDENTITY_HELPER" ] && [ -x "$SSH_IDENTITY_HELPER" ] \
  || { echo "guest SSH identity helper is missing or unsafe" >&2; exit 1; }
[ "$(qm status "$VMID" 2>/dev/null | awk '{print $2}')" = "running" ] \
  || { echo "VMID $VMID must be running before its runtime can be updated" >&2; exit 1; }

ASSETS=(server.js llm-application.js guarded-files.cjs agent-zero-editor.cjs index.html app.js)
for asset in "${ASSETS[@]}"; do
  source="$SRC_DIR/hivra-chat/$asset"
  [ -f "$source" ] && [ ! -L "$source" ] \
    || { echo "runtime source asset is missing or unsafe: $asset" >&2; exit 1; }
done
tar -C "$SRC_DIR/hivra-chat" -czf "$ARCHIVE" -- "${ASSETS[@]}"
ARCHIVE_SHA256="$(sha256sum "$ARCHIVE" | awk '{print $1}')"

GUEST_SSH_IDENTITY_DIR="$(mktemp -d "/run/hivra-guest-ssh-identity.${VMID}.XXXXXXXX")"
chmod 0700 "$GUEST_SSH_IDENTITY_DIR"
"$SSH_IDENTITY_HELPER" "$VMID" "$IP" "$GUEST_SSH_IDENTITY_DIR"
SSH_OPTIONS=(-i "$VM_KEY" -o BatchMode=yes -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes -o HostKeyAlgorithms=ssh-ed25519 -o UpdateHostKeys=no \
  -o GlobalKnownHostsFile=/dev/null -o UserKnownHostsFile="$GUEST_SSH_IDENTITY_DIR/known_hosts" \
  -o HostKeyAlias="hivra-vmid-$VMID" -o ConnectTimeout=10)
scp "${SSH_OPTIONS[@]}" "$ARCHIVE" "ubuntu@${IP}:${REMOTE_ARCHIVE}" >/dev/null

ssh "${SSH_OPTIONS[@]}" "ubuntu@${IP}" \
  "sudo HIVRA_RUNTIME_ARCHIVE='$REMOTE_ARCHIVE' HIVRA_RUNTIME_ARCHIVE_SHA256='$ARCHIVE_SHA256' HIVRA_CHAT_PORT='$CHAT_PORT' bash -s" <<'GUEST'
set -euo pipefail
umask 077

ARCHIVE="${HIVRA_RUNTIME_ARCHIVE:?}"
ARCHIVE_SHA256="${HIVRA_RUNTIME_ARCHIVE_SHA256:?}"
CHAT_PORT="${HIVRA_CHAT_PORT:?}"
DEST=/opt/bux/hivra-chat
TOKEN=/home/bux/.hivra/api-token
KIND=/home/bux/.hivra/agent-kind
ASSETS=(server.js llm-application.js guarded-files.cjs agent-zero-editor.cjs index.html app.js)
WORK="$(mktemp -d /opt/bux/.hivra-runtime-update.XXXXXX)"
ROOT_ARCHIVE="$WORK/runtime.tar.gz"
BACKUP_ROOT=/var/lib/hivra/runtime-backups
install -d -o root -g root -m 0700 "$BACKUP_ROOT"
BACKUP="$(mktemp -d "${BACKUP_ROOT}/pending.XXXXXX")"
TOKEN_HASH_BEFORE="$(sha256sum "$TOKEN" | awk '{print $1}')"
TOKEN_INODE_BEFORE="$(stat -c '%d:%i:%u:%g:%a' "$TOKEN")"
KIND_BEFORE="$(cat "$KIND")"
COMMITTED=0

cleanup() {
  rm -rf -- "$WORK"
  rm -f -- "$ARCHIVE"
  if [ "$COMMITTED" != 1 ]; then rm -rf -- "$BACKUP"; fi
}
trap cleanup EXIT

# The legacy gateway-only updater cannot replace the native adapter/service
# generation. Keep DeepSeek fenced until its complete owned updater exists.
[ "$KIND_BEFORE" != deepseek-harness ] || { echo "DeepSeek requires a complete owned runtime update" >&2; exit 1; }
[ -d "$DEST" ] && [ ! -L "$DEST" ] || { echo "guest runtime destination is unsafe" >&2; exit 1; }
[ -s "$TOKEN" ] && [ ! -L "$TOKEN" ] || { echo "box API token is missing or unsafe" >&2; exit 1; }
[ -s "$KIND" ] && [ ! -L "$KIND" ] || { echo "agent identity is missing or unsafe" >&2; exit 1; }
[[ "$ARCHIVE_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "runtime archive digest is invalid" >&2; exit 1; }
install -o root -g root -m 0600 "$ARCHIVE" "$ROOT_ARCHIVE"
rm -f -- "$ARCHIVE"
[ "$(sha256sum "$ROOT_ARCHIVE" | awk '{print $1}')" = "$ARCHIVE_SHA256" ] \
  || { echo "runtime archive integrity check failed" >&2; exit 1; }
tar -xzf "$ROOT_ARCHIVE" -C "$WORK" --no-same-owner --no-same-permissions

for asset in "${ASSETS[@]}"; do
  [ -f "$WORK/$asset" ] && [ ! -L "$WORK/$asset" ] \
    || { echo "runtime update archive is incomplete or unsafe" >&2; exit 1; }
  if [ -f "$DEST/$asset" ] && [ ! -L "$DEST/$asset" ]; then
    install -o root -g root -m 0600 "$DEST/$asset" "$BACKUP/$asset"
  else
    : > "$BACKUP/$asset.absent"
  fi
done

node --check "$WORK/server.js" >/dev/null
node --check "$WORK/llm-application.js" >/dev/null
node --check "$WORK/guarded-files.cjs" >/dev/null
node --check "$WORK/agent-zero-editor.cjs" >/dev/null
node --check "$WORK/app.js" >/dev/null

rollback() {
  local asset
  for asset in "${ASSETS[@]}"; do
    rm -f -- "$DEST/$asset.next"
    if [ -f "$BACKUP/$asset" ]; then
      install -o bux -g bux -m 0644 "$BACKUP/$asset" "$DEST/$asset"
    elif [ -f "$BACKUP/$asset.absent" ]; then
      rm -f -- "$DEST/$asset"
    fi
  done
  systemctl restart bux-hivra-chat.service >/dev/null 2>&1 || true
}

for asset in "${ASSETS[@]}"; do
  install -o bux -g bux -m 0644 "$WORK/$asset" "$DEST/$asset.next"
done
for asset in "${ASSETS[@]}"; do mv -f -- "$DEST/$asset.next" "$DEST/$asset"; done

if ! systemctl restart bux-hivra-chat.service; then rollback; exit 1; fi
READY=0
for _ in $(seq 1 30); do
  META="$(curl -fsS --max-time 5 "http://127.0.0.1:${CHAT_PORT}/api/meta" 2>/dev/null || true)"
  if printf '%s' "$META" | node -e '
    let value=""; process.stdin.on("data", chunk => value += chunk);
    process.stdin.on("end", () => {
      try { const meta=JSON.parse(value); process.exit(meta.surfaceAuth === "post-cookie-v1" ? 0 : 1); }
      catch { process.exit(1); }
    });
  '; then READY=1; break; fi
  sleep 1
done
if [ "$READY" != 1 ]; then rollback; echo "updated runtime did not advertise secure surface authentication" >&2; exit 1; fi

TOKEN_HASH_AFTER="$(sha256sum "$TOKEN" | awk '{print $1}')"
TOKEN_INODE_AFTER="$(stat -c '%d:%i:%u:%g:%a' "$TOKEN")"
KIND_AFTER="$(cat "$KIND")"
if [ "$TOKEN_HASH_BEFORE" != "$TOKEN_HASH_AFTER" ] \
  || [ "$TOKEN_INODE_BEFORE" != "$TOKEN_INODE_AFTER" ] \
  || [ "$KIND_BEFORE" != "$KIND_AFTER" ]; then
  rollback
  echo "guest identity or API credential changed during runtime update" >&2
  exit 1
fi

rm -rf -- "$BACKUP_ROOT/previous"
mv -- "$BACKUP" "$BACKUP_ROOT/previous"
COMMITTED=1
printf 'HIVRA_GUEST_RUNTIME_UPDATED\n'
GUEST

printf 'HIVRA_GUEST_RUNTIME_UPDATED vmid=%s\n' "$VMID"
