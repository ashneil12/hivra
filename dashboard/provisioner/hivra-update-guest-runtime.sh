#!/usr/bin/env bash
# Refresh the Hivra-owned guest gateway assets for one already-running Proxmox
# VM: the chat gateway, its detached-run supervisor and unit drop-in, and the
# agent terminal entrypoint. The caller owns the provider-operation lease and
# FD8 host lock; this helper never powers the VM on/off and never touches agent
# files, native CLI credentials, model credentials, or the box API token.
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
TERMINAL_ASSETS=(hivra-agent-shell bux-ttyd-base-path.conf bux-box-ttyd.service)
for asset in "${TERMINAL_ASSETS[@]}"; do
  [ -f "$SRC_DIR/$asset" ] && [ ! -L "$SRC_DIR/$asset" ] \
    || { echo "runtime source asset is missing or unsafe: $asset" >&2; exit 1; }
done
tar -czf "$ARCHIVE" -C "$SRC_DIR/hivra-chat" "${ASSETS[@]}" -C "$SRC_DIR" "${TERMINAL_ASSETS[@]}"
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
# Chat turns run in detached runners; a gateway restart must leave them alone.
DROPIN_DIR=/etc/systemd/system/bux-hivra-chat.service.d
DROPIN="$DROPIN_DIR/10-hivra-detached-runs.conf"
# Terminal tabs run in persistent tmux sessions; the ttyd units pass the tab's
# session slot and leave those sessions alone when ttyd restarts.
AGENT_TTYD_CONF=/etc/systemd/system/bux-ttyd.service.d/base-path.conf
BOX_TTYD_UNIT=/etc/systemd/system/bux-box-ttyd.service
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
[ -f "$WORK/hivra-agent-shell" ] && [ ! -L "$WORK/hivra-agent-shell" ] \
  || { echo "runtime update archive is incomplete or unsafe" >&2; exit 1; }
if [ -f "$AGENT_SHELL" ] && [ ! -L "$AGENT_SHELL" ]; then install -o root -g root -m 0600 "$AGENT_SHELL" "$BACKUP/hivra-agent-shell"
else : > "$BACKUP/hivra-agent-shell.absent"; fi
if [ -f "$DROPIN" ] && [ ! -L "$DROPIN" ]; then install -o root -g root -m 0600 "$DROPIN" "$BACKUP/detached-runs.conf"
else : > "$BACKUP/detached-runs.conf.absent"; fi
for asset in bux-ttyd-base-path.conf bux-box-ttyd.service; do
  [ -f "$WORK/$asset" ] && [ ! -L "$WORK/$asset" ] \
    || { echo "runtime update archive is incomplete or unsafe" >&2; exit 1; }
done
# Linux computers keep their terminals in the shared Hivra workspace.
if [ "$KIND_BEFORE" = linux-desktop ]; then
  sed -i 's#^WorkingDirectory=.*#WorkingDirectory=/home/bux/Hivra#' "$WORK/bux-ttyd-base-path.conf" "$WORK/bux-box-ttyd.service"
fi
if [ -f "$AGENT_TTYD_CONF" ] && [ ! -L "$AGENT_TTYD_CONF" ]; then install -o root -g root -m 0600 "$AGENT_TTYD_CONF" "$BACKUP/bux-ttyd-base-path.conf"
else : > "$BACKUP/bux-ttyd-base-path.conf.absent"; fi
if [ -f "$BOX_TTYD_UNIT" ] && [ ! -L "$BOX_TTYD_UNIT" ]; then install -o root -g root -m 0600 "$BOX_TTYD_UNIT" "$BACKUP/bux-box-ttyd.service"
else : > "$BACKUP/bux-box-ttyd.service.absent"; fi
# A ttyd restart ends every plain shell it serves, so restart a terminal only
# when nobody is connected to it; otherwise its new settings apply on its next
# start. Decide before the gateway restart below drops proxied connections.
terminal_idle() {
  local out
  out="$(ss -Htn state established "( sport = :$1 )" 2>/dev/null)" || return 1
  [ -z "$out" ]
}
RESTART_AGENT_TTYD=0; RESTART_BOX_TTYD=0; TTYD_RESTARTED=0
terminal_idle 7681 && RESTART_AGENT_TTYD=1
terminal_idle 7682 && RESTART_BOX_TTYD=1

node --check "$WORK/server.js" >/dev/null
node --check "$WORK/llm-application.js" >/dev/null
node --check "$WORK/guarded-files.cjs" >/dev/null
node --check "$WORK/agent-zero-editor.cjs" >/dev/null
node --check "$WORK/chat-runs.cjs" >/dev/null
bash -n "$WORK/hivra-agent-shell"
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
  rm -f -- "$AGENT_SHELL.next" "$DROPIN.next"
  if [ -f "$BACKUP/hivra-agent-shell" ]; then install -o root -g root -m 0755 "$BACKUP/hivra-agent-shell" "$AGENT_SHELL"
  elif [ -f "$BACKUP/hivra-agent-shell.absent" ]; then rm -f -- "$AGENT_SHELL"; fi
  if [ -f "$BACKUP/detached-runs.conf" ]; then install -o root -g root -m 0644 "$BACKUP/detached-runs.conf" "$DROPIN"
  elif [ -f "$BACKUP/detached-runs.conf.absent" ]; then rm -f -- "$DROPIN"; fi
  rm -f -- "$AGENT_TTYD_CONF.next" "$BOX_TTYD_UNIT.next"
  if [ -f "$BACKUP/bux-ttyd-base-path.conf" ]; then install -o root -g root -m 0644 "$BACKUP/bux-ttyd-base-path.conf" "$AGENT_TTYD_CONF"
  elif [ -f "$BACKUP/bux-ttyd-base-path.conf.absent" ]; then rm -f -- "$AGENT_TTYD_CONF"; fi
  if [ -f "$BACKUP/bux-box-ttyd.service" ]; then install -o root -g root -m 0644 "$BACKUP/bux-box-ttyd.service" "$BOX_TTYD_UNIT"
  elif [ -f "$BACKUP/bux-box-ttyd.service.absent" ]; then rm -f -- "$BOX_TTYD_UNIT"; fi
  systemctl daemon-reload >/dev/null 2>&1 || true
  if [ "$TTYD_RESTARTED" = 1 ]; then systemctl try-restart bux-ttyd.service bux-box-ttyd.service >/dev/null 2>&1 || true; fi
  systemctl restart bux-hivra-chat.service >/dev/null 2>&1 || true
}

for asset in "${ASSETS[@]}"; do
  install -o bux -g bux -m 0644 "$WORK/$asset" "$DEST/$asset.next"
done
for asset in "${ASSETS[@]}"; do mv -f -- "$DEST/$asset.next" "$DEST/$asset"; done
# ttyd starts the agent shell per connection, so the terminal needs no restart.
install -o root -g root -m 0755 "$WORK/hivra-agent-shell" "$AGENT_SHELL.next"
mv -f -- "$AGENT_SHELL.next" "$AGENT_SHELL"
case "$KIND_BEFORE" in
  claude|codex|generic)
    install -d -o root -g root -m 0755 "$DROPIN_DIR"
    printf '%s\n' '[Service]' 'KillMode=process' > "$DROPIN.next"
    chmod 0644 "$DROPIN.next"
    mv -f -- "$DROPIN.next" "$DROPIN"
    ;;
esac
install -d -o root -g root -m 0755 "$(dirname "$AGENT_TTYD_CONF")"
install -o root -g root -m 0644 "$WORK/bux-ttyd-base-path.conf" "$AGENT_TTYD_CONF.next"
install -o root -g root -m 0644 "$WORK/bux-box-ttyd.service" "$BOX_TTYD_UNIT.next"
mv -f -- "$AGENT_TTYD_CONF.next" "$AGENT_TTYD_CONF"
mv -f -- "$BOX_TTYD_UNIT.next" "$BOX_TTYD_UNIT"
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
for unit in bux-ttyd.service bux-box-ttyd.service; do
  if [ "$(systemctl show -p KillMode --value "$unit")" != process ] \
    || ! systemctl show -p ExecStart --value "$unit" | grep -Fq '/usr/local/bin/hivra-agent-shell --'; then
    rollback; echo "terminal $unit would not keep its sessions" >&2; exit 1
  fi
done
TTYD_RESTARTED=1
if [ "$RESTART_AGENT_TTYD" = 1 ] && ! systemctl try-restart bux-ttyd.service; then rollback; exit 1; fi
if [ "$RESTART_BOX_TTYD" = 1 ] && ! systemctl try-restart bux-box-ttyd.service; then rollback; exit 1; fi
[ "$RESTART_AGENT_TTYD" = 1 ] || printf 'HIVRA_TERMINAL_RESTART_DEFERRED bux-ttyd.service\n'
[ "$RESTART_BOX_TTYD" = 1 ] || printf 'HIVRA_TERMINAL_RESTART_DEFERRED bux-box-ttyd.service\n'

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
