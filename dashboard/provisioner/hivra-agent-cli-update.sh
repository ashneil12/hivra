#!/usr/bin/env bash
# Move this computer's Claude Code or Codex CLI to the release's vetted version
# (agent-cli-versions.json). Vendor self-updaters are off on Hivra computers, so
# after provisioning this is the only way the CLI version changes.
#
#   hivra-agent-cli-update.sh claude|codex X.Y.Z
#
# hivra-update-guest-runtime.sh starts it as a transient systemd unit, so a slow
# download never holds the dashboard's update request. It downloads first, then
# waits until no chat run is in flight, holds new runs back while the package is
# swapped (the gateway refuses to start a run while the lock file exists),
# verifies the new version and restores the previous package on any failure.
# Progress goes to a root-owned, world-readable status file that the gateway
# reports on /api/meta. Runs as root; every file operation on the owner's Codex
# install runs as the owner, so nothing the agent controls steers a root write.
set -euo pipefail
umask 022

KIND="${1:-}"
TARGET="${2:-}"
[[ "$TARGET" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "invalid target version" >&2; exit 64; }

# Fixed guest paths; the overrides exist only for the offline test fixture.
AGENT_USER=bux
AGENT_HOME="${HIVRA_AGENT_HOME:-/home/bux}"
STATE_DIR="${HIVRA_AGENT_CLI_STATE_DIR:-/var/lib/hivra}"
LOCK="${HIVRA_AGENT_CLI_LOCK:-/run/hivra-agent-cli-update.lock}"
SYSTEM_PREFIX="${HIVRA_SYSTEM_NPM_PREFIX:-/usr}"
OWNER_PREFIX="$AGENT_HOME/.npm-global"
RUNS="$AGENT_HOME/.hivra/chat-runs"
STATUS="$STATE_DIR/agent-cli-update.json"
WAIT_LIMIT_SECONDS="${HIVRA_AGENT_CLI_WAIT_SECONDS:-21600}"
POLL_SECONDS="${HIVRA_AGENT_CLI_POLL_SECONDS:-30}"
# The gateway checks the lock and records a new run in one synchronous step, so
# a run admitted just before the lock appeared is on disk well within this.
LOCK_SETTLE_SECONDS="${HIVRA_AGENT_CLI_LOCK_SETTLE_SECONDS:-2}"
DOWNLOAD_TIMEOUT_SECONDS=900
INSTALL_TIMEOUT_SECONDS=600
ROOT_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
AGENT_PATH="$OWNER_PREFIX/bin:/usr/local/bin:/usr/bin:/bin"
if [ -n "${HIVRA_AGENT_CLI_TEST_BIN:-}" ]; then
  ROOT_PATH="$HIVRA_AGENT_CLI_TEST_BIN:$ROOT_PATH"
  AGENT_PATH="$HIVRA_AGENT_CLI_TEST_BIN:$AGENT_PATH"
fi

# Claude Code is a system package under root's npm prefix; Codex lives in the
# owner's prefix. Each installs where the provisioner put it, and the binary is
# the exact one the chat gateway and the agent terminal run.
case "$KIND" in
  claude)
    NAME=claude-code; PACKAGE=@anthropic-ai/claude-code; PREFIX="$SYSTEM_PREFIX"
    BIN="${CLAUDE_BIN:-$SYSTEM_PREFIX/bin/claude}"
    BACKUP="$STATE_DIR/agent-cli-backup"
    ;;
  codex)
    NAME=codex; PACKAGE=@openai/codex; PREFIX="$OWNER_PREFIX"
    BIN="${CODEX_BIN:-$OWNER_PREFIX/bin/codex}"
    BACKUP="$AGENT_HOME/.hivra/agent-cli-backup"
    ;;
  *) echo "usage: hivra-agent-cli-update.sh claude|codex X.Y.Z" >&2; exit 64 ;;
esac
PACKAGE_DIR="$PREFIX/lib/node_modules/$PACKAGE"

# Runs a command as the package's owner with a fixed, minimal environment.
as_package_owner() {
  if [ "$KIND" = claude ]; then
    env -i PATH="$ROOT_PATH" HOME=/root LANG=C.UTF-8 "$@"
  else
    runuser -u "$AGENT_USER" -- env -i PATH="$AGENT_PATH" HOME="$AGENT_HOME" LANG=C.UTF-8 "$@"
  fi
}
npm_bounded() {
  local seconds="$1"; shift
  as_package_owner timeout -k 10 "$seconds" npm --prefix "$PREFIX" "$@" >/dev/null 2>&1 </dev/null
}
# The version the gateway would run, asked as the owner exactly as it asks.
installed_version() {
  [ -f "$BIN" ] && [ -x "$BIN" ] || return 1
  runuser -u "$AGENT_USER" -- env -i PATH="$AGENT_PATH" HOME="$AGENT_HOME" LANG=C.UTF-8 DISABLE_AUTOUPDATER=1 \
    timeout -k 5 60 "$BIN" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1
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
# True while any chat run is still in flight: a live runner, or a run that was
# just admitted and has no runner yet.
chat_run_in_flight() {
  python3 -I -c '
import glob, json, os, sys, time
for status in glob.glob(os.path.join(sys.argv[1], "*", "status.json")):
    try:
        with open(status, encoding="utf-8") as handle:
            doc = json.load(handle)
        age = time.time() - os.stat(status).st_mtime
    except (OSError, ValueError):
        continue
    if not isinstance(doc, dict) or doc.get("state") not in ("starting", "running"):
        continue
    pid = doc.get("runnerPid")
    if isinstance(pid, int) and not isinstance(pid, bool) and pid > 0:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            continue
        except PermissionError:
            pass
        sys.exit(0)
    if age < 300:
        sys.exit(0)
sys.exit(1)
' "$RUNS"
}
# Backup and restore of the installed package, as its owner.
save_backup() {
  as_package_owner sh -c '
set -eu
rm -rf -- "$1"
mkdir -m 0700 -- "$1"
if [ -d "$2" ]; then cp -a -- "$2" "$1/package"; fi
if [ -L "$3" ]; then readlink -- "$3" > "$1/bin-link"; fi
' hivra-cli-backup "$BACKUP" "$PACKAGE_DIR" "$BIN"
}
restore_backup() {
  as_package_owner sh -c '
set -eu
[ -d "$1/package" ] || exit 1
rm -rf -- "$2"
mkdir -p -- "$(dirname -- "$2")"
cp -a -- "$1/package" "$2"
if [ -f "$1/bin-link" ]; then ln -sfn -- "$(cat -- "$1/bin-link")" "$3"; fi
' hivra-cli-restore "$BACKUP" "$PACKAGE_DIR" "$BIN"
}
drop_backup() { as_package_owner rm -rf -- "$BACKUP"; }
release_lock() { rm -f -- "$LOCK"; }
trap release_lock EXIT

FROM="$(installed_version || true)"
# A swap cut short (power loss, reboot) left its backup behind: put it back.
if as_package_owner test -d "$BACKUP/package"; then
  restore_backup || true
  drop_backup
  FROM="$(installed_version || true)"
fi
if [ "$FROM" = "$TARGET" ]; then write_status done; exit 0; fi

# Download while the agent may still be working; the swap below then installs
# from the local cache in seconds.
write_status downloading
if ! npm_bounded "$DOWNLOAD_TIMEOUT_SECONDS" cache add "$PACKAGE@$TARGET"; then
  write_status failed download_failed
  exit 1
fi

write_status waiting
deadline=$(( $(date +%s) + WAIT_LIMIT_SECONDS ))
while :; do
  : > "$LOCK"
  sleep "$LOCK_SETTLE_SECONDS"
  chat_run_in_flight || break
  release_lock
  if [ "$(date +%s)" -ge "$deadline" ]; then
    write_status deferred chat_run_in_flight
    exit 0
  fi
  sleep "$POLL_SECONDS"
done

write_status installing
save_backup
if npm_bounded "$INSTALL_TIMEOUT_SECONDS" install -g --prefer-offline --no-audit --no-fund "$PACKAGE@$TARGET" \
  && [ "$(installed_version || true)" = "$TARGET" ]; then
  drop_backup
  write_status done
  exit 0
fi

# The new version did not install or does not report itself: put the previous
# package back so the agent keeps working on the version it had.
if [ -n "$FROM" ] && restore_backup && [ "$(installed_version || true)" = "$FROM" ]; then
  drop_backup
  write_status rolled_back install_failed
else
  write_status failed install_failed
fi
exit 1
