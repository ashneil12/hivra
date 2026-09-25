/**
 * Is an agent turn in flight on a Hermes "webfree" box?
 *
 * ONE probe, shared by the idle sampler (it gates the box's hourly idle-gated
 * roll, idle-gated-update-builder.ts) and the in-flight update gate (it gates
 * system-initiated live updates, inflight-update-gate.ts). Both of those
 * recreate the gateway AND official-dashboard containers, so both must see every
 * kind of turn, and sharing the code is what keeps them from drifting apart.
 *
 * Two kinds of turn, in two containers:
 *
 * 1. Gateway turns: messaging platforms (Telegram and the rest), cron jobs and
 *    scheduled tasks run in the gateway container. The gateway persists its
 *    in-flight count (foreground turns plus in-flight cron work) as
 *    `active_agents` in $HERMES_HOME/gateway_state.json at every turn boundary,
 *    and the gateway supervisor refreshes the file's `updated_at` every 10 s.
 *    While the gateway container runs, a file that is missing, unparseable or
 *    older than GATEWAY_STATE_STALE_SECONDS is unknown, never idle (fail safe).
 *    Only the default gateway's file counts: single-gateway mode runs no
 *    per-profile gateways, so legacy profile state files have no live owner.
 *
 * 2. Web-chat turns (/webchat -> Hermes Desktop Web -> /desktop/api/ws) run inside
 *    official-dashboard and never appear in gateway_state.json. The agent
 *    (tui_gateway/turn_marker.py, identical in the prod fork, the canary fork and
 *    upstream) writes a durable marker when a turn starts running and clears it
 *    once the turn concludes (success, handled error or interrupt):
 *
 *      $HERMES_HOME/desktop/interrupted_turns.json
 *      $HERMES_HOME/profiles/<name>/desktop/interrupted_turns.json
 *
 *    Each file is a JSON object `{session_key: {"started_at": <epoch s>,
 *    "attempts": n, "prompt": "..."}}`, written atomically and removed when it
 *    becomes empty. Only a process death leaves an entry behind, so an entry is
 *    evidence of a live turn only while it is:
 *      - fresh: younger than TURN_MARKER_FRESH_SECONDS (a crash-left marker must
 *        not pin a box busy forever), and
 *      - newer than the official-dashboard container's start: turns live in that
 *        process's memory, so a marker older than the process belongs to a turn
 *        that died with the previous process.
 *    A fresh marker file that cannot be parsed is unknown (fail safe).
 *
 * Verdicts:
 *   - busy: positive evidence of a running turn (a fresh gateway state with
 *     active_agents > 0, or a live web-chat marker);
 *   - unknown: no positive evidence, but something that should have answered did
 *     not (Docker timed out, the probe could not run, the gateway state is stale
 *     or unreadable, a fresh marker is unreadable);
 *   - idle: everything answered and nothing is running. A stopped or missing
 *     container runs no turns, so it adds nothing.
 * Callers decide what unknown means for them; the idle sampler and most gate
 * callers treat it as busy.
 *
 * The probe runs on the gateway container's Python (the one the idle sampler has
 * always used) and falls back to official-dashboard's: both mount the same
 * webui-state volume at WEBFREE_HERMES_HOME. Every Docker call is bounded, and
 * callers can bound the whole probe with HIVRA_ACTIVITY_DEADLINE. It prints
 * counts only: a marker holds the user's prompt, which never leaves the box
 * through this path.
 */

/**
 * Upper bound on how long one web-chat marker may count as a running turn.
 *
 * Six hours sits above every legitimate single-turn duration Hivra supports
 * (the pinned WS-orphan reap grace, WEBUI_WS_ORPHAN_REAP_GRACE_SECONDS, is
 * four hours, and the one-hour approval wait fits inside it), and matches the
 * agent's own six-hour idle-session TTL. A marker older than this was left by a
 * process that died mid-turn; counting it would stall updates for a box that is
 * doing nothing.
 */
export const TURN_MARKER_FRESH_SECONDS = 6 * 60 * 60;

/**
 * A gateway_state.json not refreshed for this long is stale. The gateway
 * supervisor rewrites `updated_at` every 10 s (and the gateway's own loop
 * heartbeat every 30 s), so 150 s is several missed beats. Same bound the idle
 * sampler has always used.
 */
export const GATEWAY_STATE_STALE_SECONDS = 150;

/** HERMES_HOME inside the gateway and official-dashboard containers (shared webui-state volume). */
export const WEBFREE_HERMES_HOME = "/home/hermes/.hermes";

/** The gateway container's Python: the agent-source venv relocated under HERMES_HOME. */
export const GATEWAY_PROBE_PYTHON = `${WEBFREE_HERMES_HOME}/hermes-agent/.venv/bin/python3`;

/** Official-dashboard's Python (the compose runs /opt/hermes/.venv/bin/hermes there). */
export const DASHBOARD_PROBE_PYTHON = "/opt/hermes/.venv/bin/python3";

/**
 * `docker inspect` format for a container's state, parsed by
 * hivra_container_state(). The probe also sends `absent` for a container Docker
 * says does not exist and `unknown` when Docker did not answer.
 */
export const CONTAINER_STATE_INSPECT_FORMAT = "{{.State.Running}} {{.State.StartedAt}}";

/**
 * Per-call bounds on the probe's Docker calls, in seconds. A caller's
 * HIVRA_ACTIVITY_DEADLINE can only shorten them. Worst case with no deadline:
 * four state calls plus two probe runs.
 */
export const AGENT_ACTIVITY_DOCKER_STATE_TIMEOUT_SECONDS = 5;
export const AGENT_ACTIVITY_DOCKER_EXEC_TIMEOUT_SECONDS = 10;

/** Heredoc delimiter for the embedded Python (never appears in it). */
const PROBE_HEREDOC = "HIVRA_AGENT_ACTIVITY_PY";

/**
 * The probe's Python; prints one line, `verdict=<idle|busy|unknown>
 * gateway_active=<n> gateway_unknown=<n> live=<n> unreadable=<n>`. Runs on the agent image's Python (3.13) on the box and on
 * the test runner's python3 (3.9+), so it sticks to the standard library. Written
 * without backslashes or `${` so it embeds verbatim in a TypeScript template.
 *
 * argv: <HERMES_HOME> <gateway state> <dashboard state> <marker fresh s> <gateway stale s>
 */
export const AGENT_ACTIVITY_PROBE_PYTHON = `import glob as _hivra_glob
import json as _hivra_json
import os as _hivra_os
import sys as _hivra_sys
import time as _hivra_time
from datetime import datetime as _hivra_datetime
from datetime import timezone as _hivra_timezone

# A marker stamped further in the future than this is not a turn start on this
# clock (ignoring it keeps a skewed entry from pinning busy until time catches up).
HIVRA_MARKER_CLOCK_SLOP_S = 300.0


def hivra_container_state(state):
    """(running, started_at) from the probe's container state string.

    state is docker inspect "{{.State.Running}} {{.State.StartedAt}}", or
    "absent" (Docker says the container does not exist) or anything else when
    Docker did not answer. running is True, False or None (unknown); started_at
    is an epoch, or None when unknown.
    """
    parts = (state or "").split()
    if parts == ["absent"]:
        return False, None
    if len(parts) != 2:
        return None, None
    running, started = parts
    if running == "false":
        return False, None
    if running != "true":
        return None, None
    try:
        started_at = _hivra_datetime.strptime(started[:19], "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        return True, None
    return True, started_at.replace(tzinfo=_hivra_timezone.utc).timestamp()


def hivra_dashboard_not_before(state):
    """Earliest started_at a still-running web-chat turn can carry.

    Unknown dashboard state returns None (count every fresh marker). A stopped or
    missing dashboard returns +inf: no web-chat turn can be running. A running
    one returns its start time: turns live in that process's memory, so an older
    marker belongs to a process that no longer exists.
    """
    running, started_at = hivra_container_state(state)
    if running is False:
        return float("inf")
    return started_at


def hivra_marker_time_live(ts, now, fresh_s, not_before):
    if ts <= 0:
        return False
    if now - ts > fresh_s:
        return False
    if ts - now > HIVRA_MARKER_CLOCK_SLOP_S:
        return False
    if not_before is not None and ts < not_before:
        return False
    return True


def hivra_live_turn_markers(root, now, fresh_s, not_before):
    """Return (live, unreadable) web-chat turn markers under a HERMES_HOME root.

    live counts entries for turns that may still be running. unreadable counts
    fresh marker files or entries that could not be parsed. A file is rewritten
    whenever a turn starts or ends, so one untouched for longer than the window,
    or since before the dashboard started, cannot describe a running turn and is
    skipped unread; that bound keeps a corrupt file from pinning a box busy
    forever. Prompts are never read out.
    """
    if not_before is not None and not_before == float("inf"):
        return 0, 0
    paths = [_hivra_os.path.join(root, "desktop", "interrupted_turns.json")]
    paths.extend(
        sorted(
            _hivra_glob.glob(
                _hivra_os.path.join(root, "profiles", "*", "desktop", "interrupted_turns.json")
            )
        )
    )
    live = 0
    unreadable = 0
    for path in paths:
        try:
            mtime = _hivra_os.stat(path).st_mtime
        except FileNotFoundError:
            continue
        except OSError:
            unreadable += 1
            continue
        if not hivra_marker_time_live(mtime, now, fresh_s, not_before):
            continue
        try:
            with open(path, encoding="utf-8") as handle:
                data = _hivra_json.load(handle)
        except FileNotFoundError:
            continue
        except Exception:
            unreadable += 1
            continue
        if not isinstance(data, dict):
            unreadable += 1
            continue
        for entry in data.values():
            if not isinstance(entry, dict) or entry.get("started_at") is None:
                unreadable += 1
                continue
            try:
                started = float(entry.get("started_at"))
            except (TypeError, ValueError):
                unreadable += 1
                continue
            if hivra_marker_time_live(started, now, fresh_s, not_before):
                live += 1
    return live, unreadable


def hivra_gateway_activity(root, now, stale_s, gateway_state):
    """Return (active, unknown) for gateway turns (messaging, cron, scheduled tasks).

    A stopped or missing gateway runs nothing. Otherwise the default gateway's
    gateway_state.json must be readable and fresh; if it is not, the answer is
    unknown rather than idle.
    """
    running, _started_at = hivra_container_state(gateway_state)
    if running is False:
        return 0, 0
    try:
        with open(_hivra_os.path.join(root, "gateway_state.json"), encoding="utf-8") as handle:
            data = _hivra_json.load(handle)
        updated = str(data["updated_at"])
        if updated.endswith("Z"):
            updated = updated[:-1] + "+00:00"
        updated_at = _hivra_datetime.fromisoformat(updated).timestamp()
        active = int(data.get("active_agents", 0) or 0)
    except Exception:
        return 0, 1
    if now - updated_at > stale_s:
        return 0, 1
    return max(active, 0), 0


def hivra_agent_activity(root, gateway_state, dashboard_state, fresh_s, stale_s, now):
    gateway_active, gateway_unknown = hivra_gateway_activity(root, now, stale_s, gateway_state)
    live, unreadable = hivra_live_turn_markers(
        root, now, fresh_s, hivra_dashboard_not_before(dashboard_state)
    )
    if gateway_active > 0 or live > 0:
        verdict = "busy"
    elif gateway_unknown > 0 or unreadable > 0:
        verdict = "unknown"
    else:
        verdict = "idle"
    return verdict, gateway_active, gateway_unknown, live, unreadable


if __name__ == "__main__":
    _hivra_result = hivra_agent_activity(
        _hivra_sys.argv[1],
        _hivra_sys.argv[2],
        _hivra_sys.argv[3],
        float(_hivra_sys.argv[4]),
        float(_hivra_sys.argv[5]),
        _hivra_time.time(),
    )
    print("verdict=%s gateway_active=%d gateway_unknown=%d live=%d unreadable=%d" % _hivra_result)
`;

export interface AgentActivityProbeShellOptions {
  /** Test override for the web-chat marker window. */
  markerFreshSeconds?: number;
  /** Test override for the gateway state staleness bound. */
  gatewayStaleSeconds?: number;
}

/**
 * Bash function definitions for the probe, embedded verbatim in the idle
 * sampler and the in-flight update gate. After
 *
 *   hivra_agent_activity <gateway container> <official-dashboard container>
 *
 * these globals are set:
 *   HIVRA_ACTIVITY_VERDICT   idle | busy | unknown
 *   HIVRA_ACTIVITY_REASON    no_turn_in_flight | agent_not_running |
 *                            in_flight_turn | turn_state_unknown
 *   HIVRA_GATEWAY_STATE, HIVRA_DASHBOARD_STATE
 *                            "true <start>" | "false <start>" | absent | unknown
 *   HIVRA_GATEWAY_ACTIVE, HIVRA_GATEWAY_UNKNOWN, HIVRA_LIVE_TURNS,
 *   HIVRA_UNREADABLE_MARKERS counts, or "-" when the probe could not run
 *
 * Set HIVRA_ACTIVITY_DEADLINE (epoch seconds) first to bound the whole probe.
 */
export function buildAgentActivityProbeShell(options: AgentActivityProbeShellOptions = {}): string {
  const freshSeconds = Math.floor(options.markerFreshSeconds ?? TURN_MARKER_FRESH_SECONDS);
  const staleSeconds = Math.floor(options.gatewayStaleSeconds ?? GATEWAY_STATE_STALE_SECONDS);
  return `# ---- Hivra agent activity probe (dashboard/src/lib/services/agent-activity-probe.ts) ----
# Run a command, bounded by its own cap and by HIVRA_ACTIVITY_DEADLINE. Returns
# 124 when it ran out of time (like coreutils timeout).
hivra_activity_bounded() {
  local cap="$1"
  local left
  shift
  if [ "\${HIVRA_ACTIVITY_DEADLINE:-0}" -gt 0 ]; then
    left=$(( HIVRA_ACTIVITY_DEADLINE - $(date +%s) ))
    if [ "$left" -lt "$cap" ]; then cap="$left"; fi
  fi
  if [ "$cap" -lt 1 ]; then return 124; fi
  if command -v timeout >/dev/null 2>&1; then
    timeout "$cap" "$@"
  else
    "$@"
  fi
}
# Print a container's state: "true <start>", "false <start>", absent, or unknown
# when Docker did not answer. A missing container runs nothing, but a Docker that
# did not answer proves nothing, so a failed inspect is told apart by a listing.
hivra_container_state() {
  local out rc names
  out="$(hivra_activity_bounded ${AGENT_ACTIVITY_DOCKER_STATE_TIMEOUT_SECONDS} docker inspect --type container -f '${CONTAINER_STATE_INSPECT_FORMAT}' "$1" 2>/dev/null)"
  rc=$?
  if [ "$rc" = 0 ]; then
    case "$out" in
      "true "*|"false "*) printf '%s' "$out" ;;
      *) printf unknown ;;
    esac
    return 0
  fi
  if [ "$rc" = 124 ]; then printf unknown; return 0; fi
  if ! names="$(hivra_activity_bounded ${AGENT_ACTIVITY_DOCKER_STATE_TIMEOUT_SECONDS} docker ps -a --format '{{.Names}}' 2>/dev/null)"; then
    printf unknown
    return 0
  fi
  # A here-string, not a pipe: under pipefail an early grep exit could fail the
  # writer and read as "absent".
  if grep -qxF -- "$1" <<<"$names"; then printf unknown; else printf absent; fi
}
hivra_agent_activity() {
  local gateway="$1" dashboard="$2" which target python out field verdict
  local active unknown live unreadable candidates=""
  HIVRA_GATEWAY_STATE="$(hivra_container_state "$gateway")"
  HIVRA_DASHBOARD_STATE="$(hivra_container_state "$dashboard")"
  HIVRA_ACTIVITY_VERDICT=unknown
  HIVRA_ACTIVITY_REASON=turn_state_unknown
  HIVRA_GATEWAY_ACTIVE=-
  HIVRA_GATEWAY_UNKNOWN=-
  HIVRA_LIVE_TURNS=-
  HIVRA_UNREADABLE_MARKERS=-
  case "$HIVRA_GATEWAY_STATE" in "true "*|unknown) candidates="gateway" ;; esac
  case "$HIVRA_DASHBOARD_STATE" in "true "*|unknown) candidates="$candidates dashboard" ;; esac
  if [ -z "$candidates" ]; then
    # Neither container is running, so no turn can be in flight.
    HIVRA_ACTIVITY_VERDICT=idle
    HIVRA_ACTIVITY_REASON=agent_not_running
    HIVRA_GATEWAY_ACTIVE=0
    HIVRA_GATEWAY_UNKNOWN=0
    HIVRA_LIVE_TURNS=0
    HIVRA_UNREADABLE_MARKERS=0
    return 0
  fi
  for which in $candidates; do
    if [ "$which" = gateway ]; then
      target="$gateway"
      python="${GATEWAY_PROBE_PYTHON}"
    else
      target="$dashboard"
      python="${DASHBOARD_PROBE_PYTHON}"
    fi
    out="$(hivra_activity_bounded ${AGENT_ACTIVITY_DOCKER_EXEC_TIMEOUT_SECONDS} docker exec -i "$target" "$python" - ${WEBFREE_HERMES_HOME} "$HIVRA_GATEWAY_STATE" "$HIVRA_DASHBOARD_STATE" ${freshSeconds} ${staleSeconds} <<'${PROBE_HEREDOC}' 2>/dev/null
${AGENT_ACTIVITY_PROBE_PYTHON}${PROBE_HEREDOC}
)" || continue
    verdict=""
    active=""
    unknown=""
    live=""
    unreadable=""
    for field in $out; do
      case "$field" in
        verdict=*) verdict="\${field#verdict=}" ;;
        gateway_active=*) active="\${field#gateway_active=}" ;;
        gateway_unknown=*) unknown="\${field#gateway_unknown=}" ;;
        live=*) live="\${field#live=}" ;;
        unreadable=*) unreadable="\${field#unreadable=}" ;;
      esac
    done
    case "$verdict" in idle|busy|unknown) ;; *) continue ;; esac
    case "$active$unknown$live$unreadable" in ''|*[!0-9]*) continue ;; esac
    [ -n "$active" ] && [ -n "$unknown" ] && [ -n "$live" ] && [ -n "$unreadable" ] || continue
    HIVRA_ACTIVITY_VERDICT="$verdict"
    HIVRA_GATEWAY_ACTIVE="$active"
    HIVRA_GATEWAY_UNKNOWN="$unknown"
    HIVRA_LIVE_TURNS="$live"
    HIVRA_UNREADABLE_MARKERS="$unreadable"
    case "$verdict" in
      idle) HIVRA_ACTIVITY_REASON=no_turn_in_flight ;;
      busy) HIVRA_ACTIVITY_REASON=in_flight_turn ;;
      *) HIVRA_ACTIVITY_REASON=turn_state_unknown ;;
    esac
    return 0
  done
  return 0
}
# ---- end Hivra agent activity probe ----
`;
}
