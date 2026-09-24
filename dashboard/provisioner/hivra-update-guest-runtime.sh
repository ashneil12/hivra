#!/usr/bin/env bash
# Refresh the Hivra-owned guest gateway assets for one already-running Proxmox
# VM in place: the chat gateway, its detached-run supervisor and unit drop-in,
# and the agent terminal entrypoint. Only bux-hivra-chat restarts, so the
# computer, its desktop apps, agent services, tmux-backed agent terminals and
# detached chat runs keep running; proxied browser views reconnect. For a
# Claude Code / Codex computer it then re-credentials and reinstalls the
# agent-run reporter, the step the start helper performs on every boot. The
# caller owns the provider-operation lease and takes the FD8 host lock; this
# helper releases that lock once its host-side checks are done (see
# release_lifecycle_lock). It never powers the VM on/off and never touches agent
# files, native CLI credentials, model credentials, or the box API token.
#
# Stdout carries only host-authored lines: at most one HIVRA_ACTIVITY_COLLECTOR
# line, then the final `HIVRA_GUEST_RUNTIME_UPDATED vmid=<VMID>` receipt, which
# is printed only after the guest committed the update.
set -euo pipefail
umask 077

VMID="${1:?usage: hivra-update-guest-runtime.sh VMID IP}"
IP="${2:?usage: hivra-update-guest-runtime.sh VMID IP}"
VM_KEY="${HIVRA_VM_SSH_KEY_PATH:-/etc/hivra/keys/vm-orchestrator}"
CHAT_PORT="${HIVRA_CHAT_PORT:-8080}"
PROVISIONER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARCHIVE="$(mktemp "/tmp/hivra-runtime-${VMID}.XXXXXX.tar.gz")"
GUEST_RESULT="$(mktemp "/tmp/hivra-runtime-result-${VMID}.XXXXXX")"
REMOTE_ARCHIVE="/tmp/hivra-runtime-update-${VMID}.tar.gz"
SSH_IDENTITY_HELPER="${HIVRA_GUEST_SSH_IDENTITY_HELPER:-${PROVISIONER_DIR}/hivra-guest-ssh-known-hosts}"
GUEST_SSH_IDENTITY_DIR=""
cleanup() {
  rm -f -- "$ARCHIVE" "$GUEST_RESULT"
  [ -z "$GUEST_SSH_IDENTITY_DIR" ] || rm -rf -- "$GUEST_SSH_IDENTITY_DIR"
}
trap cleanup EXIT

[[ "$VMID" =~ ^[0-9]+$ ]] && [ "$VMID" -ge 100 ] || { echo "invalid VMID" >&2; exit 1; }
[[ "$IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "invalid guest IP" >&2; exit 1; }

# Agent-run reporter credential (docs/superpowers/specs/2026-09-22-agent-run-tracing-contract.md).
# A runtime update re-issues it exactly like a start, through the same root-only
# file slot bound to this VMID. This block and the reporter step below are the
# start helper's own code, kept identical by a drift test: consume and delete
# the file before any later exit path, keep the credential in memory only, and
# never let the reporter step fail the update.
ACTIVITY_TELEMETRY_FILE="${HIVRA_ACTIVITY_TELEMETRY_FILE:-}"
ACTIVITY_CREDENTIAL_JSON=""
ACTIVITY_COLLECTOR_STATUS=""
read_activity_credential() {
  local file="$1" size line encoded
  [ -f "$file" ] && [ ! -L "$file" ] || return 1
  [ "$(stat -c '%a:%U:%G' "$file" 2>/dev/null)" = "600:root:root" ] || return 1
  size="$(stat -c '%s' "$file" 2>/dev/null)"
  [[ "$size" =~ ^[0-9]+$ ]] && [ "$size" -le 16384 ] || return 1
  line="$(grep -m1 -E '^HIVRA_ACTIVITY_TELEMETRY_B64=' "$file" 2>/dev/null)" || return 1
  encoded="${line#*=}"
  [[ "$encoded" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || return 1
  printf '%s' "$encoded" | base64 -d 2>/dev/null | python3 -I -B -c '
import json, re, sys
raw = sys.stdin.buffer.read(8193)
if len(raw) > 8192:
    sys.exit(1)
try:
    doc = json.loads(raw.decode("utf-8"))
except ValueError:
    sys.exit(1)
keys = {"endpoint", "resourceId", "token", "expiresAt"}
if not isinstance(doc, dict) or set(doc) != keys or not all(isinstance(doc[k], str) for k in keys):
    sys.exit(1)
if (not re.fullmatch(r"https://[a-z0-9.-]+(:[0-9]{1,5})?/api/activity/ingest", doc["endpoint"])
        or not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", doc["resourceId"])
        or len(doc["token"]) > 4096
        or not re.fullmatch(r"hvra_otlp_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", doc["token"])
        or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z", doc["expiresAt"])):
    sys.exit(1)
sys.stdout.write(json.dumps(doc, separators=(",", ":")))
' 2>/dev/null
}
if [ -n "$ACTIVITY_TELEMETRY_FILE" ]; then
  ACTIVITY_COLLECTOR_STATUS="status=failed reason=invalid_input"
  # Never follow or delete a caller-chosen path outside the exact VMID slot.
  if [[ "$ACTIVITY_TELEMETRY_FILE" =~ ^/run/hivra-lifecycle/${VMID}\.activity\.env$ ]]; then
    if ACTIVITY_CREDENTIAL_JSON="$(read_activity_credential "$ACTIVITY_TELEMETRY_FILE")" \
      && [ -n "$ACTIVITY_CREDENTIAL_JSON" ]; then
      ACTIVITY_COLLECTOR_STATUS="status=failed reason=not_attempted"
    else
      ACTIVITY_CREDENTIAL_JSON=""
    fi
    rm -f -- "$ACTIVITY_TELEMETRY_FILE" 2>/dev/null || true
  fi
fi
# The caller's request deadline (epoch seconds on this host) and the FD8
# lifecycle lock it holds. Both are optional so the helper can also run by hand.
UPDATE_DEADLINE="${HIVRA_RUNTIME_UPDATE_DEADLINE:-}"
LIFECYCLE_LOCK_FD="${HIVRA_LIFECYCLE_LOCK_FD:-}"
[ -z "$UPDATE_DEADLINE" ] || [[ "$UPDATE_DEADLINE" =~ ^[0-9]{1,12}$ ]] \
  || { echo "invalid runtime update deadline" >&2; exit 1; }
case "$LIFECYCLE_LOCK_FD" in ''|8) ;; *) echo "invalid lifecycle lock descriptor" >&2; exit 1 ;; esac
# FD8 serializes host-level lifecycle work (allocation, start, stop, bundle
# sync). Everything after the host-side checks and the archive build happens in
# the guest and can wait minutes on it, so release the lock there, as the start
# helper does before it waits for a guest. The operation lease still fences
# this computer against any other lifecycle change until the update completes.
release_lifecycle_lock() {
  if [ "$LIFECYCLE_LOCK_FD" = 8 ]; then
    flock -u 8 2>/dev/null || true
    exec 8>&-
    LIFECYCLE_LOCK_FD=""
  fi
}
[[ "$CHAT_PORT" =~ ^[0-9]+$ ]] && [ "$CHAT_PORT" -ge 1 ] && [ "$CHAT_PORT" -le 65535 ] \
  || { echo "invalid chat port" >&2; exit 1; }
[ -f "$VM_KEY" ] || { echo "VM ssh key is missing" >&2; exit 1; }
[ -f "$SSH_IDENTITY_HELPER" ] && [ ! -L "$SSH_IDENTITY_HELPER" ] && [ -x "$SSH_IDENTITY_HELPER" ] \
  || { echo "guest SSH identity helper is missing or unsafe" >&2; exit 1; }
[ "$(qm status "$VMID" 2>/dev/null | awk '{print $2}')" = "running" ] \
  || { echo "VMID $VMID must be running before its runtime can be updated" >&2; exit 1; }

ASSETS=(server.js llm-application.js guarded-files.cjs agent-zero-editor.cjs chat-runs.cjs index.html app.js)
for asset in "${ASSETS[@]}"; do
  source="$PROVISIONER_DIR/hivra-chat/$asset"
  [ -f "$source" ] && [ ! -L "$source" ] \
    || { echo "runtime source asset is missing or unsafe: $asset" >&2; exit 1; }
done
TERMINAL_ASSETS=(hivra-agent-shell bux-ttyd-base-path.conf bux-box-ttyd.service)
for asset in "${TERMINAL_ASSETS[@]}"; do
  [ -f "$PROVISIONER_DIR/$asset" ] && [ ! -L "$PROVISIONER_DIR/$asset" ] \
    || { echo "runtime source asset is missing or unsafe: $asset" >&2; exit 1; }
done
tar -czf "$ARCHIVE" -C "$PROVISIONER_DIR/hivra-chat" "${ASSETS[@]}" -C "$PROVISIONER_DIR" "${TERMINAL_ASSETS[@]}"
ARCHIVE_SHA256="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
release_lifecycle_lock

GUEST_SSH_IDENTITY_DIR="$(mktemp -d "/run/hivra-guest-ssh-identity.${VMID}.XXXXXXXX")"
chmod 0700 "$GUEST_SSH_IDENTITY_DIR"
"$SSH_IDENTITY_HELPER" "$VMID" "$IP" "$GUEST_SSH_IDENTITY_DIR"
SSH_OPTIONS=(-i "$VM_KEY" -o BatchMode=yes -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes -o HostKeyAlgorithms=ssh-ed25519 -o UpdateHostKeys=no \
  -o GlobalKnownHostsFile=/dev/null -o UserKnownHostsFile="$GUEST_SSH_IDENTITY_DIR/known_hosts" \
  -o HostKeyAlias="hivra-vmid-$VMID" -o ConnectTimeout=10)
scp "${SSH_OPTIONS[@]}" "$ARCHIVE" "ubuntu@${IP}:${REMOTE_ARCHIVE}" >/dev/null

# Guest stdout goes to a private file, never to the caller: only the guest's
# own commit line below can lead to the host receipt.
ssh "${SSH_OPTIONS[@]}" "ubuntu@${IP}" \
  "sudo HIVRA_RUNTIME_ARCHIVE='$REMOTE_ARCHIVE' HIVRA_RUNTIME_ARCHIVE_SHA256='$ARCHIVE_SHA256' HIVRA_CHAT_PORT='$CHAT_PORT' bash -s" >"$GUEST_RESULT" <<'GUEST'
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
grep -Fxq HIVRA_GUEST_RUNTIME_UPDATED "$GUEST_RESULT" \
  || { echo "guest runtime update ended without its commit receipt" >&2; exit 1; }

# (Re)install the agent-run reporter with the fresh credential, as the start
# helper does after a boot. The gateway update above is already committed; every
# outcome here only changes ACTIVITY_COLLECTOR_STATUS.
GSSH=(ssh "${SSH_OPTIONS[@]}")
install_activity_collector() {
  local source guest_dir rc
  # Runs as root in the guest. The control plane stages a credential only for
  # Claude Code / Codex Proxmox computers, so the guest reads nothing the
  # monitored agent can write (no /home/bux selector). It unpacks the reviewed
  # reporter into a fresh root-only directory so no guest user can swap it
  # between staging and install.
  local stage='set -eu
umask 077
dir="$(mktemp -d /run/hivra-agent-trace-install.XXXXXXXX)"
if ! tar --no-same-owner --no-same-permissions -xf - -C "$dir" hivra-agent-trace.py hivra-agent-trace.service \
  || [ ! -f "$dir/hivra-agent-trace.py" ] || [ -L "$dir/hivra-agent-trace.py" ] \
  || [ ! -f "$dir/hivra-agent-trace.service" ] || [ -L "$dir/hivra-agent-trace.service" ]; then
  rm -rf -- "$dir"
  exit 4
fi
cat >/dev/null
printf "%s\n" "$dir"'
  for source in hivra-agent-trace.py hivra-agent-trace.service; do
    if [ ! -f "${PROVISIONER_DIR}/${source}" ] || [ -L "${PROVISIONER_DIR}/${source}" ]; then
      ACTIVITY_COLLECTOR_STATUS="status=failed reason=source_missing"
      return 0
    fi
  done
  guest_dir="$(tar -C "$PROVISIONER_DIR" -cf - hivra-agent-trace.py hivra-agent-trace.service \
    | timeout -k 5 20 "${GSSH[@]}" "ubuntu@${IP}" "sudo -n /bin/sh -c '${stage}'" 2>/dev/null)"
  rc=$?
  case "$rc" in
    0) ;;
    124|137) ACTIVITY_COLLECTOR_STATUS="status=failed reason=timeout"; return 0 ;;
    *) ACTIVITY_COLLECTOR_STATUS="status=failed reason=transfer_failed"; return 0 ;;
  esac
  if ! [[ "$guest_dir" =~ ^/run/hivra-agent-trace-install\.[A-Za-z0-9]{8}$ ]]; then
    ACTIVITY_COLLECTOR_STATUS="status=failed reason=transfer_failed"
    return 0
  fi
  # The credential travels only on stdin (printf is a builtin, so it never
  # appears in any argv); the guest installer validates it strictly.
  printf '%s' "$ACTIVITY_CREDENTIAL_JSON" | timeout -k 5 120 "${GSSH[@]}" "ubuntu@${IP}" \
    "sudo -n /usr/bin/python3 -I -B ${guest_dir}/hivra-agent-trace.py install --source-dir ${guest_dir}; rc=\$?; sudo -n /bin/rm -rf -- ${guest_dir}; exit \$rc" \
    >/dev/null 2>&1
  rc=$?
  if [ "$rc" = 0 ]; then
    ACTIVITY_COLLECTOR_STATUS="status=installed"
    return 0
  fi
  timeout -k 2 8 "${GSSH[@]}" "ubuntu@${IP}" "sudo -n /bin/rm -rf -- ${guest_dir}" </dev/null >/dev/null 2>&1 || true
  case "$rc" in
    124|137) ACTIVITY_COLLECTOR_STATUS="status=failed reason=timeout" ;;
    *) ACTIVITY_COLLECTOR_STATUS="status=failed reason=install_failed" ;;
  esac
  return 0
}
# The update runs inside one bounded dashboard request. The reporter step starts
# only when its whole bounded worst case (the 20 s, 120 s and 8 s guest calls
# above plus their kill grace) still fits before the caller's deadline, so it can
# never turn the committed update into an unverified one. Otherwise it stays
# "not attempted" and the next start installs the reporter.
REPORTER_WORST_CASE_SECONDS=165
if [ -n "$ACTIVITY_CREDENTIAL_JSON" ] && [ -n "$UPDATE_DEADLINE" ] \
  && [ "$(( UPDATE_DEADLINE - $(date +%s) ))" -lt "$REPORTER_WORST_CASE_SECONDS" ]; then
  ACTIVITY_CREDENTIAL_JSON=""
fi
if [ -n "$ACTIVITY_CREDENTIAL_JSON" ]; then
  install_activity_collector || true
  ACTIVITY_CREDENTIAL_JSON=""
fi
if [ -n "$ACTIVITY_COLLECTOR_STATUS" ]; then
  printf 'HIVRA_ACTIVITY_COLLECTOR %s\n' "$ACTIVITY_COLLECTOR_STATUS"
fi

printf 'HIVRA_GUEST_RUNTIME_UPDATED vmid=%s\n' "$VMID"
