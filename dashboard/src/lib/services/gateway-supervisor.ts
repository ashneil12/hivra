// Self-restarting supervisor for an agent-backend SUB-PROFILE messaging gateway.
//
// The agent container's Docker restart policy only supervises its PID-1
// default-profile gateway (`command: "gateway run"`). A sub-profile gateway is
// launched as a side-process, so if it exits (crash, OOM, transient provider
// error) nothing brings it back — that profile's cron + chat/Discord delivery
// silently stops until the next credential change re-launches it. This loop is
// the process-level "restart policy" for that side-process: it relaunches the
// gateway whenever it exits, and re-reads the profile `.env` each cycle so a
// credential update applies on the next restart.
//
// It is shipped base64-encoded because both call sites embed it inside deeply
// nested shells (`docker exec agent-<id> sh -c '…'`, itself inside an SSH
// payload). Decoding from base64 sidesteps every quoting/escaping hazard — the
// script body can contain quotes, `$`, heredocs, etc. without collisions.
//
// Killing the supervisor PID is sufficient teardown: the TERM trap forwards the
// signal to the gateway child, so the whole tree dies and the next launch starts
// clean. `gateway run --replace` is a belt-and-suspenders safety net that also
// evicts any pre-supervisor (legacy fire-and-forget) gateway during migration.
export const GATEWAY_SUBPROFILE_SUPERVISOR_SH = `#!/bin/sh
# Hermes sub-profile messaging-gateway supervisor (managed by the dashboard).
set -u

PROFILE_HOME="\${HERMES_HOME:-/root/.hermes}"
HERMES_BIN="\${HERMES_BIN:-}"
[ -n "$HERMES_BIN" ] && [ -x "$HERMES_BIN" ] || HERMES_BIN=/opt/venv/bin/hermes
[ -x "$HERMES_BIN" ] || HERMES_BIN=/opt/hermes/.venv/bin/hermes
[ -x "$HERMES_BIN" ] || HERMES_BIN="$(command -v hermes 2>/dev/null || echo hermes)"
LOG="$PROFILE_HOME/gateway.log"

gw_pid=""
_term() { [ -n "$gw_pid" ] && kill -TERM "$gw_pid" 2>/dev/null; exit 0; }
trap _term TERM INT

while :; do
  if [ -f "$PROFILE_HOME/.env" ]; then set -a; . "$PROFILE_HOME/.env"; set +a; fi
  HERMES_HOME="$PROFILE_HOME" "$HERMES_BIN" gateway run --replace < /dev/null >> "$LOG" 2>&1 &
  gw_pid=$!
  wait "$gw_pid"
  code=$?
  echo "[gateway-supervisor] profile gateway exited code=$code at $(date -u +%Y-%m-%dT%H:%M:%SZ); restarting in 3s" >> "$LOG"
  sleep 3
done
`;

export const GATEWAY_SUBPROFILE_SUPERVISOR_SH_B64 = Buffer.from(
  GATEWAY_SUBPROFILE_SUPERVISOR_SH,
  'utf8',
).toString('base64');
