#!/usr/bin/env bash
# Move this computer's agent app (the Aeon dashboard, OpenClaw or Agent Zero)
# to the release's tested version (agent-app-versions.json). Their own
# self-updaters are not how Hivra computers change version, so after
# provisioning this is the only way Hivra changes it.
#
#   hivra-agent-app-update.sh aeon <40-hex commit>
#   hivra-agent-app-update.sh openclaw <x.y.z>
#   hivra-agent-app-update.sh agent-zero sha256:<64 hex>
#   hivra-agent-app-update.sh hermes latest
#   hivra-agent-app-update.sh openbot latest
#   hivra-agent-app-update.sh nuphos latest
#
# Hermes is the exception: it has no Hivra pin and is never rebuilt or
# rolled back by Hivra. "hermes latest" waits for the same idle moment, holds
# the same surface lock, and runs Hermes's own `hermes update --yes` as the
# agent's user (exactly what the owner would type in Terminal), then restarts
# the dashboard, makes sure Hermes's gateway serves its Webapp and reports the
# version it finds.
#
# OpenBot has no Hivra pin either: "openbot latest" pulls upstream's latest
# image, and only if it is a new one waits for the same idle moment, copies
# OpenBot's database aside, restarts on the new image and checks it answers
# with the new release; on failure the previous image and database go back.
#
# Nuphos works the same way: "nuphos latest" pulls the latest Claude Code
# runtime image Nuphos publishes, and only if it is a new one waits until no
# Nuphos conversation has been active, copies the runtime's home volume (its
# console password, team connections and the agent's sign-in) aside, restarts
# on the new image and checks the console answers with the new release; on
# failure the previous image and home go back.
#
# hivra-update-guest-runtime.sh starts it as a transient systemd unit, so a slow
# download or build never holds the dashboard's update request. It first
# prepares the new version next to the running one (npm download, image pull,
# or a separate dashboard build), then waits until nobody has used the app
# through Hivra for a while and the app itself has no work in flight, holds the
# app's Hivra surface (the gateway answers "being updated" while the lock file
# exists), swaps, restarts only the app's own service, checks that it answers
# on its loopback port with the new version, and puts the previous version back
# on any failure. Progress goes to a root-owned, world-readable status file and
# the installed version to a root-owned record; the gateway reports both on its
# authenticated /api/meta. Runs as root; every step on files the agent owns
# (the OpenClaw npm prefix, the Aeon build) runs as the agent's user.
set -euo pipefail
umask 022

NAME="${1:-}"
TARGET="${2:-}"
case "$NAME" in
  aeon) [[ "$TARGET" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid Aeon commit" >&2; exit 64; } ;;
  openclaw) [[ "$TARGET" =~ ^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$ ]] || { echo "invalid OpenClaw version" >&2; exit 64; } ;;
  agent-zero) [[ "$TARGET" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "invalid Agent Zero image digest" >&2; exit 64; } ;;
  hermes) [ "$TARGET" = latest ] || { echo "Hermes updates to latest only" >&2; exit 64; } ;;
  openbot) [ "$TARGET" = latest ] || { echo "OpenBot updates to latest only" >&2; exit 64; } ;;
  nuphos) [ "$TARGET" = latest ] || { echo "Nuphos updates to latest only" >&2; exit 64; } ;;
  *) echo "usage: hivra-agent-app-update.sh aeon|openclaw|agent-zero VERSION | hermes|openbot|nuphos latest" >&2; exit 64 ;;
esac

# Fixed guest paths; the overrides exist only for the offline test fixture.
AGENT_USER=bux
AGENT_HOME="${HIVRA_AGENT_HOME:-/home/bux}"
STATE_DIR="${HIVRA_AGENT_APP_STATE_DIR:-/var/lib/hivra}"
SYSTEMD_DIR="${HIVRA_SYSTEMD_DIR:-/etc/systemd/system}"
LOCK="${HIVRA_AGENT_APP_LOCK:-/run/hivra-agent-app-update.lock}"
STATUS="$STATE_DIR/agent-app-update.json"
RECORD="$STATE_DIR/agent-app.json"
JOURNAL="$STATE_DIR/agent-app-swap"
TOKEN_FILE="$AGENT_HOME/.hivra/api-token"
CHAT_PORT="${HIVRA_CHAT_PORT:-8080}"
WAIT_LIMIT_SECONDS="${HIVRA_AGENT_APP_WAIT_SECONDS:-21600}"
POLL_SECONDS="${HIVRA_AGENT_APP_POLL_SECONDS:-30}"
# Nobody used the app through Hivra, and the app wrote no work, for this long.
IDLE_SECONDS="${HIVRA_AGENT_APP_IDLE_SECONDS:-300}"
# The gateway counts a request and checks the lock in one synchronous step, so
# a request admitted just before the lock appeared has been counted by then.
LOCK_SETTLE_SECONDS="${HIVRA_AGENT_APP_LOCK_SETTLE_SECONDS:-2}"
HEALTH_SECONDS="${HIVRA_AGENT_APP_HEALTH_SECONDS:-180}"
HEALTH_POLL_SECONDS="${HIVRA_AGENT_APP_HEALTH_POLL_SECONDS:-3}"
ROOT_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
AGENT_PATH="$AGENT_HOME/.local/bin:$AGENT_HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin"
if [ -n "${HIVRA_AGENT_APP_TEST_BIN:-}" ]; then
  ROOT_PATH="$HIVRA_AGENT_APP_TEST_BIN:$ROOT_PATH"
  AGENT_PATH="$HIVRA_AGENT_APP_TEST_BIN:$AGENT_PATH"
  PATH="$ROOT_PATH"
fi

case "$NAME" in
  aeon)
    UNIT=bux-aeon.service
    AEON_REPO_URL=https://github.com/aaronjmars/aeon.git
    AEON_DIR="$AGENT_HOME/aeon"
    BUILD_ROOT="$AGENT_HOME/.hivra/aeon-dashboard"
    DROPIN_DIR="$SYSTEMD_DIR/$UNIT.d"
    DROPIN="$DROPIN_DIR/20-hivra-dashboard.conf"
    NEED_FREE_MB=3072
    ;;
  openclaw)
    UNIT=bux-openclaw.service
    PREFIX="$AGENT_HOME/.npm-global"
    PACKAGE_DIR="$PREFIX/lib/node_modules/openclaw"
    BIN="$PREFIX/bin/openclaw"
    BACKUP="$AGENT_HOME/.hivra/agent-app-backup"
    NEED_FREE_MB=2048
    ;;
  agent-zero)
    UNIT=hivra-agent-zero.service
    IMAGE_REPO=agent0ai/agent-zero
    CONTAINER=hivra-agent-zero
    A0_ROOT="${HIVRA_A0_ROOT:-/opt/a0}"
    DATA="$A0_ROOT/usr"
    DATA_BACKUP="$A0_ROOT/usr.hivra-update-backup"
    NEED_FREE_MB=12288
    ;;
  hermes)
    UNIT=bux-hermes.service
    BIN="$AGENT_HOME/.local/bin/hermes"
    HERMES_HOME_DIR="$AGENT_HOME/.hermes"
    # `hermes update` fetches code and rebuilds its environment in place.
    HERMES_UPDATE_SECONDS="${HIVRA_HERMES_UPDATE_SECONDS:-1800}"
    NEED_FREE_MB=3072
    ;;
  openbot)
    UNIT=hivra-openbot.service
    IMAGE_REPO=ghcr.io/copilotkit/openbot
    OB_ROOT="${HIVRA_OPENBOT_ROOT:-/opt/openbot}"
    OB_PORT="${HIVRA_OPENBOT_PORT:-3101}"
    OB_KEY_FILE="$AGENT_HOME/.hivra/openbot-intelligence-key"
    OB_VOLUME_DIR="${HIVRA_OPENBOT_VOLUME_DIR:-/var/lib/docker/volumes/hivra-openbot-data/_data}"
    OB_DATA_BACKUP="$OB_ROOT/data.hivra-update-backup"
    NEED_FREE_MB=4096
    ;;
  nuphos)
    UNIT=hivra-nuphos.service
    IMAGE_REPO=ghcr.io/nuphos/runtime
    NU_TAG=latest-claude-code
    NU_ROOT="${HIVRA_NUPHOS_ROOT:-/opt/nuphos}"
    NU_PORT="${HIVRA_NUPHOS_PORT:-3102}"
    NU_VOLUME_DIR="${HIVRA_NUPHOS_VOLUME_DIR:-/var/lib/docker/volumes/hivra-nuphos-home/_data}"
    NU_HOME_BACKUP="$NU_ROOT/home.hivra-update-backup"
    NEED_FREE_MB=4096
    ;;
esac
UNIT_FILE="$SYSTEMD_DIR/$UNIT"

# ── helpers ─────────────────────────────────────────────────────────────────

# Runs a command as the agent's user with a fixed, minimal environment.
as_agent() {
  runuser -u "$AGENT_USER" -- env -i PATH="$AGENT_PATH" HOME="$AGENT_HOME" LANG=C.UTF-8 \
    NEXT_TELEMETRY_DISABLED=1 npm_config_update_notifier=false "$@"
}
bounded() {
  local seconds="$1"; shift
  timeout -k 10 "$seconds" "$@"
}
free_mb() {
  local path="$1"
  while [ ! -e "$path" ]; do path="$(dirname -- "$path")"; done
  df -Pm -- "$path" | awk 'NR == 2 { print $4 }'
}
FROM=""
write_status() {
  local state="$1" reason="${2:-}"
  mkdir -p -m 0755 -- "$STATE_DIR"
  python3 -I -c '
import json, os, sys, time
path, name, state, source, target, reason = sys.argv[1:7]
doc = {"name": name, "state": state, "from": source or None, "to": target,
       "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
if reason:
    doc["reason"] = reason
staged = path + ".next"
with open(staged, "w", encoding="utf-8") as handle:
    json.dump(doc, handle)
os.chmod(staged, 0o644)
os.replace(staged, path)
' "$STATUS" "$NAME" "$state" "$FROM" "$TARGET" "$reason"
}
# The installed version, as Hivra last put it there (the gateway reports it).
write_record() {
  local version="$1"
  mkdir -p -m 0755 -- "$STATE_DIR"
  python3 -I -c '
import json, os, sys, time
path, name, version = sys.argv[1:4]
staged = path + ".next"
with open(staged, "w", encoding="utf-8") as handle:
    json.dump({"name": name, "version": version or None,
               "recordedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, handle)
os.chmod(staged, 0o644)
os.replace(staged, path)
' "$RECORD" "$NAME" "$version"
}
recorded_version() {
  python3 -I -c '
import json, re, sys
try:
    doc = json.load(open(sys.argv[1], encoding="utf-8"))
except (OSError, ValueError):
    sys.exit(1)
value = doc.get("version") if isinstance(doc, dict) and doc.get("name") == sys.argv[2] else None
if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{40}", value):
    sys.exit(1)
print(value)
' "$RECORD" "$NAME" 2>/dev/null
}
# The loopback port the app's unit serves on (its ExecStart names it).
unit_port() {
  local default="$1" pattern="$2" port
  port="$(grep -m1 -E '^ExecStart=' "$UNIT_FILE" 2>/dev/null | grep -oE -e "$pattern" | grep -oE '[0-9]+$' | head -n 1 || true)"
  [[ "$port" =~ ^[0-9]{1,5}$ ]] && printf '%s\n' "$port" || printf '%s\n' "$default"
}
http_code() {
  curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || true
}

# ── per app: installed version ──────────────────────────────────────────────

installed_version() {
  case "$NAME" in
    openclaw)
      [ -e "$BIN" ] || return 1
      as_agent timeout -k 5 60 "$BIN" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1
      ;;
    hermes)
      [ -e "$BIN" ] || return 1
      as_agent timeout -k 5 60 "$BIN" --version 2>/dev/null | head -n 1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1
      ;;
    openbot)
      openbot_image_version "$(head -n 1 "$OB_ROOT/image" 2>/dev/null || true)"
      ;;
    nuphos)
      nuphos_image_version "$(head -n 1 "$NU_ROOT/image" 2>/dev/null || true)"
      ;;
    agent-zero)
      local ref
      ref="$(docker inspect --format '{{.Config.Image}}' "$CONTAINER" 2>/dev/null || true)"
      [ -n "$ref" ] || ref="$(grep -m1 -E '^ExecStart=' "$UNIT_FILE" 2>/dev/null || true)"
      printf '%s\n' "$ref" | grep -oE "$IMAGE_REPO@sha256:[0-9a-f]{64}" | head -n 1 | sed "s#^$IMAGE_REPO@##"
      ;;
    aeon)
      local dir
      if [ -f "$DROPIN" ]; then
        dir="$(grep -m1 -E '^WorkingDirectory=' "$DROPIN" | sed 's/^WorkingDirectory=//')"
        dir="${dir#"$BUILD_ROOT/"}"
        [[ "$dir" =~ ^([0-9a-f]{40})/apps/dashboard$ ]] || return 1
        printf '%s\n' "${BASH_REMATCH[1]}"
      else
        # Built in the clone at provisioning, from the commit the record names.
        recorded_version
      fi
      ;;
  esac
}

# The x.y.z release an OpenBot image names (its OPENBOT_BUILD_VERSION).
openbot_image_version() {
  local image="$1"
  [[ "$image" =~ ^ghcr\.io/copilotkit/openbot@sha256:[0-9a-f]{64}$ ]] || return 1
  docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image" 2>/dev/null \
    | sed -n 's/^OPENBOT_BUILD_VERSION=v\{0,1\}\([0-9]\{1,6\}\.[0-9]\{1,6\}\.[0-9]\{1,6\}\)$/\1/p' | head -n 1
}

# The x.y.z release a Nuphos runtime image names (its OPENAB_RUNTIME_VERSION).
nuphos_image_version() {
  local image="$1"
  [[ "$image" =~ ^ghcr\.io/nuphos/runtime@sha256:[0-9a-f]{64}$ ]] || return 1
  docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image" 2>/dev/null \
    | sed -n 's/^OPENAB_RUNTIME_VERSION=v\{0,1\}\([0-9]\{1,6\}\.[0-9]\{1,6\}\.[0-9]\{1,6\}\)$/\1/p' | head -n 1
}

# ── per app: is anything using it? ──────────────────────────────────────────

# True while someone used the app through Hivra within IDLE_SECONDS, has it
# open (a live WebSocket), or the gateway can't say.
used_through_hivra() {
  local header token
  # The token file is the agent's own: read it as the agent, so a link it
  # planted can never make root read (and send) another file.
  token="$(as_agent head -c 200 -- "$TOKEN_FILE" 2>/dev/null | tr -d '\r\n')" || token=""
  [[ "$token" =~ ^[A-Za-z0-9_.-]{16,200}$ ]] || return 0
  header="$(mktemp)"
  printf 'Authorization: Bearer %s\n' "$token" > "$header"
  local meta
  meta="$(curl -fsS --max-time 5 -H @"$header" "http://127.0.0.1:${CHAT_PORT}/api/meta" 2>/dev/null || true)"
  rm -f -- "$header"
  printf '%s' "$meta" | python3 -I -c '
import json, sys, time, calendar
try:
    activity = json.load(sys.stdin)["agentApp"]["activity"]
    at = calendar.timegm(time.strptime(activity["lastUsedAt"][:19], "%Y-%m-%dT%H:%M:%S"))
    open_connections = int(activity["openConnections"])
except Exception:
    sys.exit(0)
sys.exit(0 if open_connections > 0 or time.time() - at < int(sys.argv[1]) else 1)
' "$IDLE_SECONDS"
}
# Exits 0 when a file under argv[1] whose path matches the glob argv[2]
# changed since argv[3] (epoch seconds). Never follows a symlink.
CHANGED_SINCE_PY='
import fnmatch, os, sys
root, pattern, since = sys.argv[1], sys.argv[2], float(sys.argv[3])
for folder, dirs, files in os.walk(root, followlinks=False):
    for name in files:
        path = os.path.join(folder, name)
        try:
            if fnmatch.fnmatch(path, pattern) and os.lstat(path).st_mtime >= since:
                sys.exit(0)
        except OSError:
            pass
sys.exit(1)
'
# True while the app itself has work in flight.
app_working() {
  local since=$(( $(date +%s) - IDLE_SECONDS ))
  case "$NAME" in
    aeon)
      # A dashboard save (git commit/push) or any other git operation in the clone.
      local git_dir="$AEON_DIR/.git" name
      for name in index.lock rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD; do
        [ ! -e "$git_dir/$name" ] || return 0
      done
      return 1
      ;;
    openclaw)
      # An agent turn appends to its session transcript as it runs. Read as
      # the agent's user: the folder is the agent's own.
      [ -d "$AGENT_HOME/.openclaw" ] || return 1
      as_agent python3 -I -c "$CHANGED_SINCE_PY" "$AGENT_HOME/.openclaw" '*/sessions/*' "$since"
      ;;
    hermes)
      # A chat turn appends to its session as it runs; read as the agent.
      [ -d "$HERMES_HOME_DIR/sessions" ] || return 1
      as_agent python3 -I -c "$CHANGED_SINCE_PY" "$HERMES_HOME_DIR/sessions" '*' "$since"
      ;;
    openbot)
      # OpenBot keeps its work in its database; use through Hivra is the signal.
      return 1
      ;;
    nuphos)
      # People chat from the Nuphos apps, not through Hivra: a conversation
      # writes to its own home under the runtime's volume while a turn runs.
      [ -d "$NU_VOLUME_DIR/.nuphos/session-homes" ] || return 1
      python3 -I -c "$CHANGED_SINCE_PY" "$NU_VOLUME_DIR/.nuphos/session-homes" '*' "$since"
      ;;
    agent-zero)
      # A scheduled task marked running, or a chat that saved a step recently.
      # The container writes this folder: never follow a link, never block on
      # a FIFO, never read more than a megabyte.
      if python3 -I -c '
import json, os, stat, sys
try:
    fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
except OSError:
    sys.exit(1)
try:
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        sys.exit(1)
    raw = os.read(fd, 1024 * 1024 + 1)
finally:
    os.close(fd)
try:
    tasks = json.loads(raw.decode("utf-8")).get("tasks", []) if len(raw) <= 1024 * 1024 else []
except (ValueError, AttributeError, UnicodeDecodeError):
    sys.exit(1)
sys.exit(0 if any(isinstance(t, dict) and t.get("state") == "running" for t in tasks) else 1)
' "$DATA/scheduler/tasks.json"; then
        return 0
      fi
      [ -d "$DATA/chats" ] || return 1
      python3 -I -c "$CHANGED_SINCE_PY" "$DATA/chats" '*' "$since"
      ;;
  esac
}
in_use() { used_through_hivra || app_working; }

# ── per app: prepare the new version next to the running one ───────────────

prepare() {
  case "$NAME" in
    openclaw)
      bounded 900 runuser -u "$AGENT_USER" -- env -i PATH="$AGENT_PATH" HOME="$AGENT_HOME" LANG=C.UTF-8 \
        npm --prefix "$PREFIX" cache add "openclaw@$TARGET" >/dev/null 2>&1 </dev/null
      ;;
    agent-zero)
      bounded 3600 docker pull "$IMAGE_REPO@$TARGET" >/dev/null 2>&1 </dev/null \
        && docker image inspect "$IMAGE_REPO@$TARGET" >/dev/null 2>&1
      ;;
    aeon)
      local dir="$BUILD_ROOT/$TARGET"
      if as_agent test -f "$dir/.hivra-built"; then return 0; fi
      # Built as the agent's user, in a fresh folder, from the exact upstream
      # commit; only a complete build is moved to its final name.
      if ! aeon_build "$dir"; then
        as_agent rm -rf -- "$dir.partial" || true
        return 1
      fi
      ;;
  esac
}
aeon_build() {
  local dir="$1"
  as_agent sh -c '
set -eu
umask 022
mkdir -p -- "$1"
rm -rf -- "$2.partial"
mkdir -- "$2.partial"
cd -- "$2.partial"
git init -q
git remote add origin "$3"
timeout -k 10 600 git fetch -q --depth 1 origin "$4"
git checkout -q --detach FETCH_HEAD
[ "$(git rev-parse HEAD)" = "$4" ]
# Skill runs commit their outputs into the fork, and the dashboard reads them
# from its own folder: point that folder at the owner'"'"'s clone.
rm -rf -- apps/dashboard/outputs
ln -s -- "$5/apps/dashboard/outputs" apps/dashboard/outputs
' hivra-aeon-fetch "$BUILD_ROOT" "$dir" "$AEON_REPO_URL" "$TARGET" "$AEON_DIR" >/dev/null 2>&1 </dev/null || return 1
      # The same basePath config the provisioner writes, so it serves under /aeon.
      as_agent sh -c 'cat > "$1"' hivra-aeon-config "$dir.partial/apps/dashboard/next.config.ts" <<'NEXTCFG' || return 1
import type { NextConfig } from 'next'
// Hivra hosts this dashboard behind a token-proxy mounted at /aeon.
const basePath = process.env.AEON_BASE_PATH || undefined
const nextConfig: NextConfig = basePath ? { basePath, assetPrefix: basePath } : {}
export default nextConfig
NEXTCFG
      as_agent sh -c '
set -eu
cd -- "$1/apps/dashboard"
timeout -k 10 1800 nice -n 10 npm ci --no-audit --no-fund
AEON_BASE_PATH=/aeon timeout -k 10 1800 nice -n 10 npm run build
touch -- "$1/.hivra-built"
mv -- "$1" "$2"
' hivra-aeon-build "$dir.partial" "$dir" >/dev/null 2>&1 </dev/null
}

# ── per app: swap, verify, put back ─────────────────────────────────────────

# Answers on its loopback port with the target version, within HEALTH_SECONDS.
healthy() {
  local version="$1" deadline=$(( $(date +%s) + HEALTH_SECONDS )) url
  case "$NAME" in
    openclaw) url="http://127.0.0.1:$(unit_port 18789 '--port[ =][0-9]+')/healthz" ;;
    agent-zero) url="http://127.0.0.1:$(unit_port 50080 '127\.0\.0\.1:[0-9]+')/" ;;
    aeon) url="http://127.0.0.1:$(unit_port 5555 '-p[ =][0-9]+')/aeon" ;;
    hermes) url="http://127.0.0.1:$(unit_port 9119 '--port[ =][0-9]+')/" ;;
  esac
  while :; do
    if systemctl is-active --quiet "$UNIT"; then
      case "$(http_code "$url")" in
        200|301|302|303|307|308|401)
          # Still up a moment later (not a start that crashes on first use).
          sleep "$HEALTH_POLL_SECONDS"
          if systemctl is-active --quiet "$UNIT" && [ "$(installed_version || true)" = "$version" ]; then return 0; fi
          ;;
      esac
    fi
    [ "$(date +%s)" -lt "$deadline" ] || return 1
    sleep "$HEALTH_POLL_SECONDS"
  done
}

# The swap journal records what to put back; it exists only while a swap is in
# progress, so a swap cut short (power loss, reboot) is undone on the next run.
journal_begin() {
  rm -rf -- "$JOURNAL"
  install -d -o root -g root -m 0700 "$JOURNAL"
  printf '%s\n' "$NAME" > "$JOURNAL/name"
  printf '%s\n' "$FROM" > "$JOURNAL/from"
  printf '%s\n' "$TARGET" > "$JOURNAL/to"
}
journal_end() { rm -rf -- "$JOURNAL"; }

swap() {
  case "$NAME" in
    openclaw)
      as_agent sh -c '
set -eu
rm -rf -- "$1"
mkdir -m 0700 -- "$1"
if [ -d "$2" ]; then cp -a -- "$2" "$1/package"; fi
if [ -L "$3" ]; then readlink -- "$3" > "$1/bin-link"; fi
' hivra-app-backup "$BACKUP" "$PACKAGE_DIR" "$BIN" || return 1
      : > "$JOURNAL/openclaw-backup"
      bounded 900 runuser -u "$AGENT_USER" -- env -i PATH="$AGENT_PATH" HOME="$AGENT_HOME" LANG=C.UTF-8 \
        npm --prefix "$PREFIX" install -g --prefer-offline --no-audit --no-fund "openclaw@$TARGET" >/dev/null 2>&1 </dev/null || return 1
      [ "$(installed_version || true)" = "$TARGET" ] || return 1
      systemctl restart "$UNIT"
      ;;
    agent-zero)
      local count
      count="$(grep -c -E "$IMAGE_REPO@sha256:[0-9a-f]{64}" "$UNIT_FILE" || true)"
      [ "$count" = 1 ] || return 1
      install -o root -g root -m 0600 "$UNIT_FILE" "$JOURNAL/unit"
      systemctl stop "$UNIT" || true
      # Agent Zero may migrate its settings and chats on first start; keep the
      # data as it was so a rollback starts the old version on its own data.
      rm -rf -- "$DATA_BACKUP"
      if [ -d "$DATA" ]; then cp -a -- "$DATA" "$DATA_BACKUP" || return 1; : > "$JOURNAL/a0-data"; fi
      sed -E "s#$IMAGE_REPO@sha256:[0-9a-f]{64}#$IMAGE_REPO@$TARGET#" "$JOURNAL/unit" > "$UNIT_FILE.next"
      chmod 0644 "$UNIT_FILE.next"
      mv -f -- "$UNIT_FILE.next" "$UNIT_FILE"
      systemctl daemon-reload
      systemctl start "$UNIT"
      ;;
    aeon)
      if [ -f "$DROPIN" ]; then install -o root -g root -m 0600 "$DROPIN" "$JOURNAL/dropin"; else : > "$JOURNAL/dropin.absent"; fi
      install -d -o root -g root -m 0755 "$DROPIN_DIR"
      printf '%s\n' '[Service]' \
        "WorkingDirectory=$BUILD_ROOT/$TARGET/apps/dashboard" \
        "Environment=AEON_REPO_ROOT=$AEON_DIR" > "$DROPIN.next"
      chmod 0644 "$DROPIN.next"
      mv -f -- "$DROPIN.next" "$DROPIN"
      systemctl daemon-reload
      systemctl restart "$UNIT"
      ;;
  esac
}

# Puts back what the journal recorded and restarts the app on it.
put_back() {
  [ -d "$JOURNAL" ] || return 1
  case "$NAME" in
    openclaw)
      if [ -f "$JOURNAL/openclaw-backup" ]; then
        as_agent sh -c '
set -eu
[ -d "$1/package" ] || exit 1
rm -rf -- "$2"
mkdir -p -- "$(dirname -- "$2")"
cp -a -- "$1/package" "$2"
if [ -f "$1/bin-link" ]; then ln -sfn -- "$(cat -- "$1/bin-link")" "$3"; fi
' hivra-app-restore "$BACKUP" "$PACKAGE_DIR" "$BIN" || return 1
      fi
      systemctl restart "$UNIT" || return 1
      ;;
    agent-zero)
      systemctl stop "$UNIT" || true
      if [ -f "$JOURNAL/unit" ]; then install -o root -g root -m 0644 "$JOURNAL/unit" "$UNIT_FILE"; fi
      systemctl daemon-reload
      if [ -f "$JOURNAL/a0-data" ]; then
        # The copy finished before the swap began (the marker follows it).
        # What the new version wrote is moved aside, never deleted: a swap
        # undone after a reboot may have run for a while.
        [ -d "$DATA_BACKUP" ] || return 1
        if [ -d "$DATA" ]; then mv -- "$DATA" "$DATA.hivra-replaced-$(date +%Y%m%d%H%M%S)"; fi
        mv -- "$DATA_BACKUP" "$DATA"
      fi
      systemctl start "$UNIT" || return 1
      ;;
    aeon)
      if [ -f "$JOURNAL/dropin" ]; then install -o root -g root -m 0644 "$JOURNAL/dropin" "$DROPIN"
      elif [ -f "$JOURNAL/dropin.absent" ]; then rm -f -- "$DROPIN"; fi
      systemctl daemon-reload
      systemctl restart "$UNIT" || return 1
      ;;
  esac
}

# After a confirmed swap: drop what only a rollback needed.
tidy() {
  case "$NAME" in
    openclaw) as_agent rm -rf -- "$BACKUP" || true ;;
    agent-zero)
      rm -rf -- "$DATA_BACKUP"
      # The previous image is about 6 GB; a computer keeps only the one it runs.
      if [[ "$FROM" =~ ^sha256:[0-9a-f]{64}$ ]] && [ "$FROM" != "$TARGET" ]; then
        docker image rm "$IMAGE_REPO@$FROM" >/dev/null 2>&1 || true
      fi
      ;;
    aeon)
      # Keep this build and the one it replaced (the next update's way back).
      as_agent sh -c '
set -eu
cd -- "$1"
for entry in * .[!.]*; do
  [ -e "$entry" ] || continue
  case "$entry" in "$2"|"$3") ;; *) rm -rf -- "$entry" ;; esac
done
' hivra-aeon-tidy "$BUILD_ROOT" "$TARGET" "${FROM:-none}" || true
      ;;
  esac
}

# The lock holds the app's surface. A swap can outlast the gateway's 30-minute
# staleness limit (a large Agent Zero data copy), so it is kept fresh meanwhile.
LOCK_KEEPER=""
hold_lock() {
  : > "$LOCK"
  ( while sleep 60; do touch -- "$LOCK" 2>/dev/null || exit 0; done ) >/dev/null 2>&1 </dev/null &
  LOCK_KEEPER=$!
}
release_lock() {
  if [ -n "$LOCK_KEEPER" ]; then kill "$LOCK_KEEPER" 2>/dev/null || true; LOCK_KEEPER=""; fi
  rm -f -- "$LOCK"
}
# Stopped mid-swap (the unit stopped, SIGTERM): put the previous version back
# before exiting, so the app is never left stopped or half swapped.
on_exit() {
  local rc=$?
  if [ -d "$JOURNAL" ] && [ "${SWAPPING:-0}" = 1 ]; then
    put_back || true
    journal_end
    write_record "$(installed_version || true)" || true
    write_status rolled_back interrupted || true
  fi
  release_lock
  exit "$rc"
}
SWAPPING=0
trap on_exit EXIT
trap 'exit 143' TERM INT HUP

# ── run ─────────────────────────────────────────────────────────────────────

# Waits for a quiet moment and holds the app's surface (release_lock lets it
# go). Past the wait limit the update is deferred, not forced.
wait_until_idle() {
  local deadline=$(( $(date +%s) + WAIT_LIMIT_SECONDS ))
  while :; do
    # Only an app that looks idle is held, then checked again: someone who
    # arrived meanwhile is counted and the hold is let go at once.
    if ! in_use; then
      hold_lock
      sleep "$LOCK_SETTLE_SECONDS"
      in_use || break
      release_lock
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      write_status deferred app_in_use
      exit 0
    fi
    sleep "$POLL_SECONDS"
  done
}

# The agent page shows Hermes's Webapp (its Desktop workspace in a browser),
# which Hermes's gateway serves on loopback once webapp.enabled is on. A
# computer set up before that gets it here, with Hermes's own commands: the
# setting goes on before `hermes update` (which then builds the Webapp with the
# rest of Hermes), the bundle is built if it is still missing, and the gateway,
# which reads the setting when it starts, is restarted once if it does not
# serve the Webapp yet. None of this fails the update: until the Webapp is
# served, the agent page shows the dashboard.
HERMES_WEBAPP_URL="http://127.0.0.1:${HIVRA_HERMES_WEBAPP_PORT:-9120}/"
as_agent_session() {
  local uid; uid="$(id -u "$AGENT_USER")" || return 1
  runuser -u "$AGENT_USER" -- env -i PATH="$AGENT_PATH" HOME="$AGENT_HOME" LANG=C.UTF-8 \
    XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" "$@"
}
hermes_webapp_on() {
  as_agent timeout -k 10 120 "$BIN" config set webapp.enabled true >/dev/null 2>&1 </dev/null
}
hermes_webapp_ready() {
  local i
  as_agent timeout -k 30 "$HERMES_UPDATE_SECONDS" "$BIN" webapp --build-only >/dev/null 2>&1 </dev/null || return 1
  [ "$(http_code "$HERMES_WEBAPP_URL")" = 200 ] && return 0
  as_agent_session timeout -k 10 240 "$BIN" gateway restart >/dev/null 2>&1 </dev/null || return 1
  for i in $(seq 1 40); do
    [ "$(http_code "$HERMES_WEBAPP_URL")" = 200 ] && return 0
    sleep "$HEALTH_POLL_SECONDS"
  done
  return 1
}

# Hermes: no pin, no staged copy, no rollback. Hermes's own updater does the
# work as the agent's user; this only waits for a quiet moment, holds the
# surface, restarts the dashboard, makes sure the Webapp is served and reports
# what it finds.
run_hermes() {
  local rc=0 now
  [ -f "$UNIT_FILE" ] || { write_status failed not_installed; exit 1; }
  FROM="$(installed_version || true)"
  if [ "$(free_mb "$AGENT_HOME")" -lt "$NEED_FREE_MB" ]; then
    write_status failed no_space
    exit 1
  fi
  write_status waiting
  wait_until_idle
  write_status installing
  hermes_webapp_on || echo "WARNING: could not turn on Hermes's Webapp (hermes config set webapp.enabled true)" >&2
  as_agent timeout -k 30 "$HERMES_UPDATE_SECONDS" "$BIN" update --yes >/dev/null 2>&1 </dev/null || rc=$?
  if [ "$rc" -ne 0 ]; then
    # Exit 2 is Hermes saying it would not touch local changes (or another
    # update holds its lock); anything else did not complete.
    systemctl is-active --quiet "$UNIT" || systemctl start "$UNIT" || true
    release_lock
    write_record "$(installed_version || true)"
    if [ "$rc" -eq 2 ]; then write_status failed local_changes; else write_status failed install_failed; fi
    exit 1
  fi
  systemctl restart "$UNIT" || true
  now="$(installed_version || true)"
  if [ -z "$now" ] || ! healthy "$now"; then
    release_lock
    write_record "$now"
    write_status failed install_failed
    exit 1
  fi
  hermes_webapp_ready || echo "WARNING: Hermes's Webapp is not served; the agent page shows the dashboard until it is (hermes webapp --build-only, then hermes gateway restart)" >&2
  release_lock
  write_record "$now"
  write_status done
  exit 0
}

# OpenBot: pull upstream's latest; nothing to do when it is the image running.
# Otherwise wait for a quiet moment, hold the surface, copy the database aside
# (OpenBot migrates it on start), restart on the new image and check it answers
# with the new release. Before the owner has given OpenBot its Intelligence
# key the service only waits, so then the new image is simply recorded.
openbot_write_image() {
  printf '%s\n' "$1" > "$OB_ROOT/image.next"
  chmod 0600 "$OB_ROOT/image.next"
  mv -f -- "$OB_ROOT/image.next" "$OB_ROOT/image"
}
openbot_running() { [ -s "$OB_KEY_FILE" ] && [ ! -L "$OB_KEY_FILE" ]; }
openbot_healthy() {
  local version="$1" deadline=$(( $(date +%s) + HEALTH_SECONDS ))
  openbot_running || { systemctl is-active --quiet "$UNIT"; return; }
  while :; do
    if systemctl is-active --quiet "$UNIT" && [ "$(http_code "http://127.0.0.1:$OB_PORT/")" = 200 ]; then
      sleep "$HEALTH_POLL_SECONDS"
      if systemctl is-active --quiet "$UNIT" && [ "$(installed_version || true)" = "$version" ]; then return 0; fi
    fi
    [ "$(date +%s)" -lt "$deadline" ] || return 1
    sleep "$HEALTH_POLL_SECONDS"
  done
}
run_openbot() {
  local old_image new_image new_version
  [ -f "$UNIT_FILE" ] || { write_status failed not_installed; exit 1; }
  old_image="$(head -n 1 "$OB_ROOT/image" 2>/dev/null || true)"
  FROM="$(installed_version || true)"
  if [ "$(free_mb "$OB_ROOT")" -lt "$NEED_FREE_MB" ]; then write_status failed no_space; exit 1; fi
  write_status downloading
  if ! bounded 3600 docker pull "$IMAGE_REPO:latest" >/dev/null 2>&1 </dev/null; then
    write_status failed download_failed; exit 1
  fi
  new_image="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$IMAGE_REPO:latest" 2>/dev/null \
    | grep -m1 -E "^$IMAGE_REPO@sha256:[0-9a-f]{64}$" || true)"
  new_version="$(openbot_image_version "$new_image" || true)"
  if [ -z "$new_image" ] || [ -z "$new_version" ]; then write_status failed download_failed; exit 1; fi
  if [ "$new_image" = "$old_image" ]; then
    write_record "$FROM"
    write_status done
    exit 0
  fi
  if ! openbot_running; then
    openbot_write_image "$new_image"
    write_record "$new_version"
    write_status done
    exit 0
  fi
  write_status waiting
  wait_until_idle
  write_status installing
  systemctl stop "$UNIT" || true
  rm -rf -- "$OB_DATA_BACKUP"
  if [ -d "$OB_VOLUME_DIR" ] && ! cp -a -- "$OB_VOLUME_DIR" "$OB_DATA_BACKUP"; then
    rm -rf -- "$OB_DATA_BACKUP"
    systemctl start "$UNIT" || true
    release_lock
    write_status failed no_space
    exit 1
  fi
  openbot_write_image "$new_image"
  systemctl start "$UNIT" || true
  if openbot_healthy "$new_version"; then
    release_lock
    rm -rf -- "$OB_DATA_BACKUP"
    if [ -n "$old_image" ] && [ "$old_image" != "$new_image" ]; then docker image rm "$old_image" >/dev/null 2>&1 || true; fi
    write_record "$new_version"
    write_status done
    exit 0
  fi
  # The new release did not come up: the previous image on its own database.
  systemctl stop "$UNIT" || true
  if [ -d "$OB_DATA_BACKUP" ]; then
    rm -rf -- "$OB_VOLUME_DIR.hivra-replaced"
    if [ -d "$OB_VOLUME_DIR" ]; then mv -- "$OB_VOLUME_DIR" "$OB_VOLUME_DIR.hivra-replaced"; fi
    mv -- "$OB_DATA_BACKUP" "$OB_VOLUME_DIR"
  fi
  [ -z "$old_image" ] || openbot_write_image "$old_image"
  systemctl start "$UNIT" || true
  release_lock
  if [ -n "$FROM" ] && openbot_healthy "$FROM"; then
    write_record "$FROM"
    write_status rolled_back install_failed
  else
    write_record "$(installed_version || true)"
    write_status failed install_failed
  fi
  exit 1
}

# Nuphos: pull the latest Claude Code runtime; nothing to do when it is the
# image running. Otherwise wait until no conversation is active, hold the
# surface, copy the runtime's home aside, restart on the new image and check
# the console answers with the new release; on failure put both back.
nuphos_write_image() {
  printf '%s\n' "$1" > "$NU_ROOT/image.next"
  chmod 0600 "$NU_ROOT/image.next"
  mv -f -- "$NU_ROOT/image.next" "$NU_ROOT/image"
}
nuphos_healthy() {
  local version="$1" deadline=$(( $(date +%s) + HEALTH_SECONDS ))
  while :; do
    if systemctl is-active --quiet "$UNIT" && [ "$(http_code "http://127.0.0.1:$NU_PORT/")" = 200 ]; then
      sleep "$HEALTH_POLL_SECONDS"
      if systemctl is-active --quiet "$UNIT" && [ "$(installed_version || true)" = "$version" ]; then return 0; fi
    fi
    [ "$(date +%s)" -lt "$deadline" ] || return 1
    sleep "$HEALTH_POLL_SECONDS"
  done
}
run_nuphos() {
  local old_image new_image new_version
  [ -f "$UNIT_FILE" ] || { write_status failed not_installed; exit 1; }
  old_image="$(head -n 1 "$NU_ROOT/image" 2>/dev/null || true)"
  FROM="$(installed_version || true)"
  if [ "$(free_mb "$NU_ROOT")" -lt "$NEED_FREE_MB" ]; then write_status failed no_space; exit 1; fi
  write_status downloading
  if ! bounded 3600 docker pull "$IMAGE_REPO:$NU_TAG" >/dev/null 2>&1 </dev/null; then
    write_status failed download_failed; exit 1
  fi
  new_image="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$IMAGE_REPO:$NU_TAG" 2>/dev/null \
    | grep -m1 -E "^$IMAGE_REPO@sha256:[0-9a-f]{64}$" || true)"
  new_version="$(nuphos_image_version "$new_image" || true)"
  if [ -z "$new_image" ] || [ -z "$new_version" ]; then write_status failed download_failed; exit 1; fi
  if [ "$new_image" = "$old_image" ]; then
    write_record "$FROM"
    write_status done
    exit 0
  fi
  write_status waiting
  wait_until_idle
  write_status installing
  systemctl stop "$UNIT" || true
  rm -rf -- "$NU_HOME_BACKUP"
  if [ -d "$NU_VOLUME_DIR" ] && ! cp -a -- "$NU_VOLUME_DIR" "$NU_HOME_BACKUP"; then
    rm -rf -- "$NU_HOME_BACKUP"
    systemctl start "$UNIT" || true
    release_lock
    write_status failed no_space
    exit 1
  fi
  nuphos_write_image "$new_image"
  systemctl start "$UNIT" || true
  if nuphos_healthy "$new_version"; then
    release_lock
    rm -rf -- "$NU_HOME_BACKUP"
    if [ -n "$old_image" ] && [ "$old_image" != "$new_image" ]; then docker image rm "$old_image" >/dev/null 2>&1 || true; fi
    write_record "$new_version"
    write_status done
    exit 0
  fi
  # The new release did not come up: the previous image on its own home.
  systemctl stop "$UNIT" || true
  if [ -d "$NU_HOME_BACKUP" ]; then
    rm -rf -- "$NU_VOLUME_DIR.hivra-replaced"
    if [ -d "$NU_VOLUME_DIR" ]; then mv -- "$NU_VOLUME_DIR" "$NU_VOLUME_DIR.hivra-replaced"; fi
    mv -- "$NU_HOME_BACKUP" "$NU_VOLUME_DIR"
  fi
  [ -z "$old_image" ] || nuphos_write_image "$old_image"
  systemctl start "$UNIT" || true
  release_lock
  if [ -n "$FROM" ] && nuphos_healthy "$FROM"; then
    write_record "$FROM"
    write_status rolled_back install_failed
  else
    write_record "$(installed_version || true)"
    write_status failed install_failed
  fi
  exit 1
}

[ "$NAME" != hermes ] || run_hermes
[ "$NAME" != openbot ] || run_openbot
[ "$NAME" != nuphos ] || run_nuphos

# A swap cut short (a reboot) left its journal behind. If the new version is
# the one running and it answers, the swap finished in all but name: keep it.
# Otherwise put the previous version back.
if [ -d "$JOURNAL" ]; then
  if [ "$(cat "$JOURNAL/name" 2>/dev/null || true)" = "$NAME" ]; then
    FROM="$(cat "$JOURNAL/from" 2>/dev/null || true)"
    swapped_to="$(cat "$JOURNAL/to" 2>/dev/null || true)"
    if [ -n "$swapped_to" ] && [ "$(installed_version || true)" = "$swapped_to" ] && healthy "$swapped_to"; then
      FROM_BEFORE="$FROM"; FROM="$swapped_to"
      journal_end
      [ "$NAME" != agent-zero ] || rm -rf -- "$DATA_BACKUP"
      write_record "$swapped_to"
      FROM="$FROM_BEFORE"
    else
      put_back || true
      journal_end
      write_record "$(installed_version || true)"
    fi
  else
    journal_end
  fi
fi

[ -f "$UNIT_FILE" ] || { write_status failed not_installed; exit 1; }
FROM="$(installed_version || true)"
if [ "$FROM" = "$TARGET" ]; then
  write_record "$TARGET"
  write_status done
  exit 0
fi
if [ "$(free_mb "$STATE_DIR")" -lt "$NEED_FREE_MB" ] \
  || { [ "$NAME" = agent-zero ] && [ "$(free_mb "$A0_ROOT")" -lt "$NEED_FREE_MB" ]; }; then
  write_status failed no_space
  exit 1
fi

# Prepare while the app keeps working; the swap below then takes seconds
# (OpenClaw, Aeon) or about a minute (Agent Zero starting its container).
write_status downloading
if ! prepare; then
  write_status failed download_failed
  exit 1
fi

write_status waiting
wait_until_idle

# Agent Zero copies its data aside first; that must fit next to it.
if [ "$NAME" = agent-zero ] && [ -d "$DATA" ]; then
  data_mb="$(du -sm -- "$DATA" | awk '{print $1}')"
  if [ "$(free_mb "$A0_ROOT")" -lt $(( data_mb + 1024 )) ]; then
    write_status failed no_space
    exit 1
  fi
fi

write_status installing
journal_begin
SWAPPING=1
if swap && healthy "$TARGET"; then
  journal_end
  SWAPPING=0
  release_lock
  tidy
  write_record "$TARGET"
  write_status done
  exit 0
fi

# The new version didn't install or didn't come up: put the previous one back
# so the agent keeps working on the version it had (an Aeon computer whose
# version was never recorded goes back to the dashboard built in its clone).
if put_back && healthy "$FROM"; then
  journal_end
  SWAPPING=0
  release_lock
  write_record "$FROM"
  write_status rolled_back install_failed
else
  journal_end
  SWAPPING=0
  # Record what the computer runs now, so the dashboard and the next update agree.
  write_record "$(installed_version || true)"
  write_status failed install_failed
fi
exit 1
