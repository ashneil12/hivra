#!/usr/bin/env bash
# The guest half of the in-place runtime update, run as root inside one
# computer with the reviewed archive the host half staged
# (HIVRA_RUNTIME_ARCHIVE, checked against HIVRA_RUNTIME_ARCHIVE_SHA256). It
# prints HIVRA_GUEST_RUNTIME_UPDATED last, only once the update committed;
# every failure before that restores what it replaced.
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
# Optional Claude app on Ubuntu Desktop computers: the root helper, its inert
# supervisor unit, the vetted package pin and the four exact sudo commands the
# gateway may run. Installing them starts nothing; a running app is never
# restarted by this update.
CLAUDE_APP=/usr/local/bin/hivra-claude-app
CLAUDE_APP_UNIT=/etc/systemd/system/hivra-claude-app.service
CLAUDE_APP_PIN_DIR=/usr/local/share/hivra
CLAUDE_APP_PIN=$CLAUDE_APP_PIN_DIR/claude-desktop-pin.json
CLAUDE_APP_SUDOERS=/etc/sudoers.d/hivra-claude-app
# Chat turns run in detached runners; a gateway restart must leave them alone.
DROPIN_DIR=/etc/systemd/system/bux-hivra-chat.service.d
DROPIN="$DROPIN_DIR/10-hivra-detached-runs.conf"
# Terminal tabs run in persistent tmux sessions; the ttyd units pass the tab's
# session slot and leave those sessions alone when ttyd restarts.
AGENT_TTYD_CONF=/etc/systemd/system/bux-ttyd.service.d/base-path.conf
BOX_TTYD_UNIT=/etc/systemd/system/bux-box-ttyd.service
ASSETS=(server.js llm-application.js guarded-files.cjs agent-zero-editor.cjs chat-runs.cjs index.html app.js)

# A DeepSeek computer runs its own gateway generation and pinned package under
# its own service checks, so its owned updater replaces those instead of the
# generic gateway below. It refuses a computer that is not exactly what Hivra
# installed, and rolls back on any failure.
if [ "$(cat "$KIND" 2>/dev/null || true)" = deepseek-harness ]; then
  [[ "$ARCHIVE_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "runtime archive digest is invalid" >&2; exit 1; }
  [ -d /var/lib/hivra ] || install -d -o root -g root -m 0711 /var/lib/hivra
  install -d -o root -g root -m 0700 /var/lib/hivra/runtime-update
  NATIVE_WORK="$(mktemp -d /var/lib/hivra/runtime-update/deepseek.XXXXXX)"
  trap 'rm -rf -- "$NATIVE_WORK"; rm -f -- "$ARCHIVE"' EXIT
  install -o root -g root -m 0600 "$ARCHIVE" "$NATIVE_WORK/runtime.tar.gz"
  rm -f -- "$ARCHIVE"
  [ "$(sha256sum "$NATIVE_WORK/runtime.tar.gz" | awk '{print $1}')" = "$ARCHIVE_SHA256" ] \
    || { echo "runtime archive integrity check failed" >&2; exit 1; }
  install -d -o root -g root -m 0700 "$NATIVE_WORK/source"
  tar -xzf "$NATIVE_WORK/runtime.tar.gz" -C "$NATIVE_WORK/source" --no-same-owner --no-same-permissions
  rm -f -- "$NATIVE_WORK/runtime.tar.gz"
  # The gateway in its bundle layout, as separate files (the updater refuses links).
  install -d -o root -g root -m 0700 "$NATIVE_WORK/source/hivra-chat"
  for asset in "${ASSETS[@]}"; do
    [ -f "$NATIVE_WORK/source/$asset" ] && [ ! -L "$NATIVE_WORK/source/$asset" ] \
      || { echo "runtime update archive is incomplete or unsafe" >&2; exit 1; }
    install -o root -g root -m 0600 "$NATIVE_WORK/source/$asset" "$NATIVE_WORK/source/hivra-chat/$asset"
  done
  # The bundle the computer was installed from: Proxmox computers keep it at
  # the top level, My cloud computers in its current/ release directory.
  INSTALLED=/opt/hivra/provider-bundle
  [ ! -d "$INSTALLED/current" ] || INSTALLED="$INSTALLED/current"
  # The host half's remaining request budget, when it set one.
  [ -z "${HIVRA_RUNTIME_UPDATE_SECONDS:-}" ] || [[ "$HIVRA_RUNTIME_UPDATE_SECONDS" =~ ^[0-9]{1,6}$ ]] \
    || { echo "invalid update budget" >&2; exit 1; }
  HIVRA_RUNTIME_UPDATE_SECONDS="${HIVRA_RUNTIME_UPDATE_SECONDS:-}" \
    python3 -I -B "$NATIVE_WORK/source/deepseek-harness/update-guest.py" "$NATIVE_WORK/source" "$INSTALLED" \
    >"$NATIVE_WORK/result"
  grep -qE '^HIVRA_DEEPSEEK_UPDATE_V1 [{]' "$NATIVE_WORK/result" \
    || { echo "DeepSeek update ended without its receipt" >&2; exit 1; }
  printf 'HIVRA_GUEST_RUNTIME_UPDATED\n'
  exit 0
fi

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
for asset in bux-ttyd-base-path.conf bux-box-ttyd.service agent-cli-versions.json hivra-agent-cli-update.sh hivra-codex-config-pin.py; do
  [ -f "$WORK/$asset" ] && [ ! -L "$WORK/$asset" ] \
    || { echo "runtime update archive is incomplete or unsafe" >&2; exit 1; }
done
for asset in hivra-claude-app.py hivra-claude-app.service claude-desktop-pin.json agent-app-versions.json hivra-agent-app-update.sh; do
  [ -f "$WORK/$asset" ] && [ ! -L "$WORK/$asset" ] \
    || { echo "runtime update archive is incomplete or unsafe" >&2; exit 1; }
done
if [ "$KIND_BEFORE" = linux-desktop ]; then
  for pair in "$CLAUDE_APP:hivra-claude-app" "$CLAUDE_APP_UNIT:hivra-claude-app.service" "$CLAUDE_APP_PIN:claude-desktop-pin.json" "$CLAUDE_APP_SUDOERS:hivra-claude-app.sudoers"; do
    target="${pair%%:*}"; name="${pair##*:}"
    if [ -f "$target" ] && [ ! -L "$target" ]; then install -o root -g root -m 0600 "$target" "$BACKUP/$name"
    else : > "$BACKUP/$name.absent"; fi
  done
fi
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
# The running terminal is either an older unit on its loopback port or a unit
# from the socket release on its owner-only unix socket (the gateway connects
# to whichever is live), so a client on either counts. A check that cannot run
# counts as busy.
terminal_idle() {
  local port="$1" socket="$2" out
  out="$(ss -Htn state established "( sport = :$port )" 2>/dev/null)" || return 1
  [ -z "$out" ] || return 1
  if [ -e "$socket" ]; then
    out="$(ss -Hx state established src "$socket" 2>/dev/null)" || return 1
    [ -z "$out" ] || return 1
  fi
  return 0
}
RESTART_AGENT_TTYD=0; RESTART_BOX_TTYD=0; TTYD_RESTARTED=0
terminal_idle 7681 /run/hivra-terminal/ttyd.sock && RESTART_AGENT_TTYD=1
terminal_idle 7682 /run/hivra-box-terminal/ttyd.sock && RESTART_BOX_TTYD=1

node --check "$WORK/server.js" >/dev/null
node --check "$WORK/llm-application.js" >/dev/null
node --check "$WORK/guarded-files.cjs" >/dev/null
node --check "$WORK/agent-zero-editor.cjs" >/dev/null
node --check "$WORK/chat-runs.cjs" >/dev/null
bash -n "$WORK/hivra-agent-shell"
bash -n "$WORK/hivra-agent-cli-update.sh"
bash -n "$WORK/hivra-agent-app-update.sh"
bash -n "$WORK/hivra-tg-apply"
python3 -I -B -c 'import ast, sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())' "$WORK/hivra-claude-app.py"
python3 -I -B -c 'import json, sys; json.load(open(sys.argv[1], encoding="utf-8"))' "$WORK/claude-desktop-pin.json"
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
  if [ "$KIND_BEFORE" = linux-desktop ]; then
    for pair in "$CLAUDE_APP:hivra-claude-app:0755" "$CLAUDE_APP_UNIT:hivra-claude-app.service:0644" "$CLAUDE_APP_PIN:claude-desktop-pin.json:0644" "$CLAUDE_APP_SUDOERS:hivra-claude-app.sudoers:0440"; do
      target="${pair%%:*}"; rest="${pair#*:}"; name="${rest%%:*}"; mode="${rest##*:}"
      rm -f -- "$target.next"
      if [ -f "$BACKUP/$name" ]; then install -o root -g root -m "$mode" "$BACKUP/$name" "$target"
      elif [ -f "$BACKUP/$name.absent" ]; then rm -f -- "$target"; fi
    done
  fi
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
# The gateway runs this per Telegram connect, so no service needs a restart.
install -o root -g root -m 0755 "$WORK/hivra-tg-apply" "$TG_APPLY.next"
mv -f -- "$TG_APPLY.next" "$TG_APPLY"
if [ "$KIND_BEFORE" = linux-desktop ]; then
  install -d -o root -g root -m 0755 "$CLAUDE_APP_PIN_DIR"
  install -o root -g root -m 0755 "$WORK/hivra-claude-app.py" "$CLAUDE_APP.next"
  install -o root -g root -m 0644 "$WORK/hivra-claude-app.service" "$CLAUDE_APP_UNIT.next"
  install -o root -g root -m 0644 "$WORK/claude-desktop-pin.json" "$CLAUDE_APP_PIN.next"
  printf '%s\n' \
    'bux ALL=(root) NOPASSWD: /usr/local/bin/hivra-claude-app status, /usr/local/bin/hivra-claude-app install, /usr/local/bin/hivra-claude-app mode app, /usr/local/bin/hivra-claude-app mode desktop, /usr/local/bin/hivra-claude-app remove' \
    > "$CLAUDE_APP_SUDOERS.next"
  chmod 0440 "$CLAUDE_APP_SUDOERS.next"
  if ! visudo -cf "$CLAUDE_APP_SUDOERS.next" >/dev/null 2>&1; then rollback; echo "the Claude app sudoers rule is invalid" >&2; exit 1; fi
  mv -f -- "$CLAUDE_APP_PIN.next" "$CLAUDE_APP_PIN"
  mv -f -- "$CLAUDE_APP_UNIT.next" "$CLAUDE_APP_UNIT"
  mv -f -- "$CLAUDE_APP.next" "$CLAUDE_APP"
  mv -f -- "$CLAUDE_APP_SUDOERS.next" "$CLAUDE_APP_SUDOERS"
fi
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
  if ! systemctl show -p Environment --value "$unit" | tr ' ' '\n' | grep -Fxq DISABLE_AUTOUPDATER=1; then
    rollback; echo "terminal $unit would let a vendor self-update replace the agent CLI" >&2; exit 1
  fi
done
TTYD_RESTARTED=1
if [ "$RESTART_AGENT_TTYD" = 1 ] && ! systemctl try-restart bux-ttyd.service; then rollback; exit 1; fi
if [ "$RESTART_BOX_TTYD" = 1 ] && ! systemctl try-restart bux-box-ttyd.service; then rollback; exit 1; fi
[ "$RESTART_AGENT_TTYD" = 1 ] || printf 'HIVRA_TERMINAL_RESTART_DEFERRED bux-ttyd.service\n'
[ "$RESTART_BOX_TTYD" = 1 ] || printf 'HIVRA_TERMINAL_RESTART_DEFERRED bux-box-ttyd.service\n'

# Check the terminals the way the owner reaches them: through the gateway. A
# terminal restarted above now listens on its owner-only socket, and the gateway
# must report it there (its own owner and mode checks); a terminal whose restart
# was deferred keeps its loopback port until its next start, and the gateway
# falls back to that port meanwhile. A proxied request to each must answer 200:
# a check made around the gateway would pass while the gateway refused the
# socket and Terminal stayed broken.
AUTH_HEADER="$WORK/gateway-auth.header"
printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN")" > "$AUTH_HEADER"
TERMINALS=0
for _ in $(seq 1 30); do
  META="$(curl -fsS --max-time 5 -H @"$AUTH_HEADER" "http://127.0.0.1:${CHAT_PORT}/api/meta" 2>/dev/null || true)"
  if printf '%s' "$META" | HIVRA_AGENT_SOCKET="$RESTART_AGENT_TTYD" HIVRA_BOX_SOCKET="$RESTART_BOX_TTYD" node -e '
    let value=""; process.stdin.on("data", chunk => value += chunk);
    process.stdin.on("end", () => {
      try {
        const t=JSON.parse(value).terminals || {};
        const ok=(transport, restarted) => restarted === "1" ? transport === "socket" : transport === "socket" || transport === "port";
        process.exit(ok(t.terminal, process.env.HIVRA_AGENT_SOCKET) && ok(t.boxTerminal, process.env.HIVRA_BOX_SOCKET) ? 0 : 1);
      } catch { process.exit(1); }
    });
  ' && [ "$(curl -sS --max-time 5 -H @"$AUTH_HEADER" -o /dev/null -w '%{http_code}' "http://127.0.0.1:${CHAT_PORT}/terminal/" 2>/dev/null || true)" = 200 ] \
    && [ "$(curl -sS --max-time 5 -H @"$AUTH_HEADER" -o /dev/null -w '%{http_code}' "http://127.0.0.1:${CHAT_PORT}/box-terminal/" 2>/dev/null || true)" = 200 ]; then
    TERMINALS=1; break
  fi
  sleep 1
done
rm -f -- "$AUTH_HEADER"
if [ "$TERMINALS" != 1 ]; then rollback; echo "terminals did not answer through the gateway on their owner-only sockets" >&2; exit 1; fi

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

# Agent CLI (Claude Code / Codex computers). Vendor self-updaters stay off, so
# Hivra moves the CLI to this release's vetted version (agent-cli-versions.json):
# hivra-agent-cli-update.sh runs as a transient unit that downloads, waits for
# in-flight chat runs to finish, swaps and verifies, so a slow download never
# holds this request. Nothing here can fail the committed update above.
AGENT_CLI_HELPER=/usr/local/sbin/hivra-agent-cli-update
agent_cli_report() {
  local name bin target version state
  case "$KIND_BEFORE" in
    claude) name=claude-code; bin=/usr/bin/claude ;;
    codex) name=codex; bin=/home/bux/.npm-global/bin/codex ;;
    *) return 0 ;;
  esac
  if [ "$KIND_BEFORE" = codex ]; then
    runuser -u bux -- env -i HOME=/home/bux PATH=/usr/bin:/bin python3 -I - <"$WORK/hivra-codex-config-pin.py" >/dev/null 2>&1 \
      || echo "the Codex startup update check could not be turned off" >&2
  fi
  target="$(python3 -I -c 'import json, re, sys
value = json.load(open(sys.argv[1])).get(sys.argv[2])
if not isinstance(value, str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", value): sys.exit(1)
print(value)' "$WORK/agent-cli-versions.json" "$name")" || return 0
  install -o root -g root -m 0700 "$WORK/hivra-agent-cli-update.sh" "$AGENT_CLI_HELPER"
  version="$(runuser -u bux -- env -i HOME=/home/bux PATH=/home/bux/.npm-global/bin:/usr/local/bin:/usr/bin:/bin DISABLE_AUTOUPDATER=1 \
    timeout -k 5 30 "$bin" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1)" || version=""
  [ -n "$version" ] || version=unknown
  if [ "$version" = "$target" ]; then
    state=current
  elif systemctl is-active --quiet hivra-agent-cli-update.service; then
    state=running
  else
    systemctl reset-failed hivra-agent-cli-update.service >/dev/null 2>&1 || true
    if systemd-run --unit=hivra-agent-cli-update --collect --no-block --quiet -p Nice=10 \
      "$AGENT_CLI_HELPER" "$KIND_BEFORE" "$target" >/dev/null 2>&1; then
      state=scheduled
    else
      state=failed
    fi
  fi
  printf 'HIVRA_AGENT_CLI name=%s version=%s target=%s state=%s\n' "$name" "$version" "$target" "$state"
}
agent_cli_report || true

# Agent app (Aeon dashboard, OpenClaw, Agent Zero computers). Hivra moves the
# app to this release's tested version (agent-app-versions.json) the same way:
# hivra-agent-app-update.sh runs as a transient unit that prepares the new
# version next to the running one, waits until nobody is using the app, swaps,
# checks it and puts the previous version back on failure. Nothing here can
# fail the committed update above.
AGENT_APP_HELPER=/usr/local/sbin/hivra-agent-app-update
AGENT_APP_RECORD=/var/lib/hivra/agent-app.json
agent_app_report() {
  local name="$KIND_BEFORE" target version state
  case "$name" in aeon|openclaw|agent-zero) ;; *) return 0 ;; esac
  target="$(python3 -I -c 'import json, re, sys
pins = {"aeon": r"[0-9a-f]{40}", "openclaw": r"[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}", "agent-zero": r"sha256:[0-9a-f]{64}"}
entry = json.load(open(sys.argv[1])).get(sys.argv[2])
value = entry.get("version") if isinstance(entry, dict) else None
if not isinstance(value, str) or not re.fullmatch(pins[sys.argv[2]], value): sys.exit(1)
print(value)' "$WORK/agent-app-versions.json" "$name")" || return 0
  install -o root -g root -m 0700 "$WORK/hivra-agent-app-update.sh" "$AGENT_APP_HELPER"
  case "$name" in
    openclaw)
      version="$(runuser -u bux -- env -i HOME=/home/bux PATH=/home/bux/.npm-global/bin:/usr/local/bin:/usr/bin:/bin \
        timeout -k 5 30 /home/bux/.npm-global/bin/openclaw --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1)" || version=""
      ;;
    agent-zero)
      version="$(docker inspect --format '{{.Config.Image}}' hivra-agent-zero 2>/dev/null | grep -oE 'sha256:[0-9a-f]{64}' | head -n 1)" || version=""
      ;;
    aeon)
      version="$(python3 -I -c 'import json, re, sys
doc = json.load(open(sys.argv[1]))
value = doc.get("version") if doc.get("name") == "aeon" else None
if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{40}", value): sys.exit(1)
print(value)' "$AGENT_APP_RECORD" 2>/dev/null)" || version=""
      if [ -f /etc/systemd/system/bux-aeon.service.d/20-hivra-dashboard.conf ]; then
        version="$(sed -n 's#^WorkingDirectory=/home/bux/.hivra/aeon-dashboard/\([0-9a-f]\{40\}\)/apps/dashboard$#\1#p' \
          /etc/systemd/system/bux-aeon.service.d/20-hivra-dashboard.conf | head -n 1)"
      fi
      ;;
  esac
  # Record what runs now whenever no update is moving it, so the gateway (which
  # can't ask Docker itself) and the next update agree: computers provisioned
  # before the record existed, and any swap that ended without recording.
  if [ -n "$version" ] && ! systemctl is-active --quiet hivra-agent-app-update.service \
    && { [ "$name" = agent-zero ] || [ -f /etc/systemd/system/bux-aeon.service.d/20-hivra-dashboard.conf ]; }; then
    install -d -o root -g root -m 0755 /var/lib/hivra
    printf '{"name":"%s","version":"%s"}\n' "$name" "$version" > "$AGENT_APP_RECORD.next"
    chmod 0644 "$AGENT_APP_RECORD.next"
    mv -f -- "$AGENT_APP_RECORD.next" "$AGENT_APP_RECORD"
  fi
  [ -n "$version" ] || version=unknown
  if [ "$version" = "$target" ]; then
    state=current
  elif systemctl is-active --quiet hivra-agent-app-update.service; then
    state=running
  else
    systemctl reset-failed hivra-agent-app-update.service >/dev/null 2>&1 || true
    if systemd-run --unit=hivra-agent-app-update --collect --no-block --quiet -p Nice=10 \
      "$AGENT_APP_HELPER" "$name" "$target" >/dev/null 2>&1; then
      state=scheduled
    else
      state=failed
    fi
  fi
  printf 'HIVRA_AGENT_APP name=%s version=%s target=%s state=%s\n' "$name" "$version" "$target" "$state"
}
agent_app_report || true
printf 'HIVRA_GUEST_RUNTIME_UPDATED\n'
