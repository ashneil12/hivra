#!/usr/bin/env bash
# Refresh the Hivra-owned guest gateway assets for one already-running Proxmox
# VM: the chat gateway, its detached-run supervisor and unit drop-in, the agent
# terminal entrypoint, and the root-owned Telegram connect helper the gateway
# runs through its scoped sudoers rule. The caller owns the provider-operation
# lease and FD8 host lock; this helper never powers the VM on/off and never
# touches agent files, native CLI credentials, model credentials, the Telegram
# bot token, sudoers, or the box API token.
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

ASSETS=(server.js llm-application.js guarded-files.cjs agent-zero-editor.cjs chat-runs.cjs index.html app.js)
for asset in "${ASSETS[@]}"; do
  source="$SRC_DIR/hivra-chat/$asset"
  [ -f "$source" ] && [ ! -L "$source" ] \
    || { echo "runtime source asset is missing or unsafe: $asset" >&2; exit 1; }
done
for helper in hivra-agent-shell hivra-tg-apply; do
  [ -f "$SRC_DIR/$helper" ] && [ ! -L "$SRC_DIR/$helper" ] \
    || { echo "runtime source asset is missing or unsafe: $helper" >&2; exit 1; }
done
tar -czf "$ARCHIVE" -C "$SRC_DIR/hivra-chat" "${ASSETS[@]}" -C "$SRC_DIR" hivra-agent-shell hivra-tg-apply
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
AGENT_SHELL=/usr/local/bin/hivra-agent-shell
# Root-owned; bux may run it only through /etc/sudoers.d/hivra-tg (unchanged here).
TG_APPLY=/usr/local/bin/hivra-tg-apply
# Chat turns run in detached runners; a gateway restart must leave them alone.
DROPIN_DIR=/etc/systemd/system/bux-hivra-chat.service.d
DROPIN="$DROPIN_DIR/10-hivra-detached-runs.conf"
ASSETS=(server.js llm-application.js guarded-files.cjs agent-zero-editor.cjs chat-runs.cjs index.html app.js)
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
for helper in hivra-agent-shell hivra-tg-apply; do
  [ -f "$WORK/$helper" ] && [ ! -L "$WORK/$helper" ] \
    || { echo "runtime update archive is incomplete or unsafe" >&2; exit 1; }
done
if [ -f "$AGENT_SHELL" ] && [ ! -L "$AGENT_SHELL" ]; then install -o root -g root -m 0600 "$AGENT_SHELL" "$BACKUP/hivra-agent-shell"
else : > "$BACKUP/hivra-agent-shell.absent"; fi
if [ -f "$TG_APPLY" ] && [ ! -L "$TG_APPLY" ]; then install -o root -g root -m 0600 "$TG_APPLY" "$BACKUP/hivra-tg-apply"
else : > "$BACKUP/hivra-tg-apply.absent"; fi
if [ -f "$DROPIN" ] && [ ! -L "$DROPIN" ]; then install -o root -g root -m 0600 "$DROPIN" "$BACKUP/detached-runs.conf"
else : > "$BACKUP/detached-runs.conf.absent"; fi

node --check "$WORK/server.js" >/dev/null
node --check "$WORK/llm-application.js" >/dev/null
node --check "$WORK/guarded-files.cjs" >/dev/null
node --check "$WORK/agent-zero-editor.cjs" >/dev/null
node --check "$WORK/chat-runs.cjs" >/dev/null
bash -n "$WORK/hivra-agent-shell"
bash -n "$WORK/hivra-tg-apply"
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
  rm -f -- "$AGENT_SHELL.next" "$TG_APPLY.next" "$DROPIN.next"
  if [ -f "$BACKUP/hivra-agent-shell" ]; then install -o root -g root -m 0755 "$BACKUP/hivra-agent-shell" "$AGENT_SHELL"
  elif [ -f "$BACKUP/hivra-agent-shell.absent" ]; then rm -f -- "$AGENT_SHELL"; fi
  if [ -f "$BACKUP/hivra-tg-apply" ]; then install -o root -g root -m 0755 "$BACKUP/hivra-tg-apply" "$TG_APPLY"
  elif [ -f "$BACKUP/hivra-tg-apply.absent" ]; then rm -f -- "$TG_APPLY"; fi
  if [ -f "$BACKUP/detached-runs.conf" ]; then install -o root -g root -m 0644 "$BACKUP/detached-runs.conf" "$DROPIN"
  elif [ -f "$BACKUP/detached-runs.conf.absent" ]; then rm -f -- "$DROPIN"; fi
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl restart bux-hivra-chat.service >/dev/null 2>&1 || true
}

for asset in "${ASSETS[@]}"; do
  install -o bux -g bux -m 0644 "$WORK/$asset" "$DEST/$asset.next"
done
for asset in "${ASSETS[@]}"; do mv -f -- "$DEST/$asset.next" "$DEST/$asset"; done
# ttyd starts the agent shell per connection, so the terminal needs no restart.
install -o root -g root -m 0755 "$WORK/hivra-agent-shell" "$AGENT_SHELL.next"
mv -f -- "$AGENT_SHELL.next" "$AGENT_SHELL"
# The gateway runs this per Telegram connect, so no service needs a restart.
install -o root -g root -m 0755 "$WORK/hivra-tg-apply" "$TG_APPLY.next"
mv -f -- "$TG_APPLY.next" "$TG_APPLY"
case "$KIND_BEFORE" in
  claude|codex|generic)
    install -d -o root -g root -m 0755 "$DROPIN_DIR"
    printf '%s\n' '[Service]' 'KillMode=process' > "$DROPIN.next"
    chmod 0644 "$DROPIN.next"
    mv -f -- "$DROPIN.next" "$DROPIN"
    ;;
esac
if ! systemctl daemon-reload; then rollback; exit 1; fi

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
case "$KIND_BEFORE" in
  claude|codex|generic)
    if [ "$(systemctl show -p KillMode --value bux-hivra-chat.service)" != process ]; then
      rollback; echo "chat gateway would still end in-flight runs on restart" >&2; exit 1
    fi
    ;;
esac

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
