/**
 * Detects a web-chat turn that is still running on a Hermes "webfree" box.
 *
 * Web chat (/webchat -> Hermes Desktop Web -> /desktop/api/ws) runs its turns
 * inside the official-dashboard container, not the gateway. The gateway's
 * gateway_state.json `active_agents` therefore never counts them, so anything
 * that decides "is the agent busy?" from that file alone will recreate the
 * dashboard in the middle of a web-chat turn.
 *
 * The agent (tui_gateway/turn_marker.py, identical in the prod fork, the canary
 * fork and upstream) writes a durable marker when a turn starts running and
 * clears it once the turn concludes (success, handled error or interrupt):
 *
 *   $HERMES_HOME/desktop/interrupted_turns.json
 *   $HERMES_HOME/profiles/<name>/desktop/interrupted_turns.json
 *
 * Each file is a JSON object `{session_key: {"started_at": <epoch s>,
 * "attempts": n, "prompt": "..."}}`, written atomically and removed when it
 * becomes empty. Only a process death leaves an entry behind, so an entry is
 * evidence of a live turn only while it is:
 *   - fresh: younger than TURN_MARKER_FRESH_SECONDS (a crash-left marker must
 *     not pin a box BUSY forever), and
 *   - newer than the official-dashboard container's start: turns live in that
 *     process's memory, so a marker older than the process belongs to a turn
 *     that died with the previous process.
 *
 * The probe prints counts only. The marker holds the user's prompt, which must
 * never leave the box through this path.
 */

/**
 * Upper bound on how long one marker may count as a running turn.
 *
 * Six hours sits above every legitimate single-turn duration Hivra supports
 * (the pinned WS-orphan reap grace, WEBUI_WS_ORPHAN_REAP_GRACE_SECONDS, is
 * four hours, and the one-hour approval wait fits inside it), and matches the
 * agent's own six-hour idle-session TTL. A marker older than this was left by a
 * process that died mid-turn; counting it would stall updates for a box that is
 * doing nothing.
 */
export const TURN_MARKER_FRESH_SECONDS = 6 * 60 * 60;

/** HERMES_HOME inside the gateway and official-dashboard containers (shared webui-state volume). */
export const WEBFREE_HERMES_HOME = "/home/hermes/.hermes";

/**
 * `docker inspect` format for the official-dashboard container, parsed by
 * hivra_dashboard_not_before(). Kept here so the sampler and the update gate
 * always ask Docker the same question.
 */
export const DASHBOARD_STATE_INSPECT_FORMAT = "{{.State.Running}} {{.State.StartedAt}}";

/**
 * Python shared by the idle sampler and the update gate. Runs on the agent
 * image's Python (3.13) on the box and on the test runner's python3 (3.9+), so
 * it sticks to the standard library. Written without backslashes or `${` so it
 * embeds verbatim in a TypeScript template.
 */
export const TURN_MARKER_PROBE_PYTHON_FUNCTIONS = `
import glob as _hivra_glob
import json as _hivra_json
import os as _hivra_os
from datetime import datetime as _hivra_datetime
from datetime import timezone as _hivra_timezone

# A marker stamped further in the future than this is not a turn start on this
# clock (ignoring it keeps a skewed entry from pinning BUSY until time catches up).
HIVRA_MARKER_CLOCK_SLOP_S = 300.0


def hivra_dashboard_not_before(state):
    """Earliest started_at a still-running web-chat turn can carry.

    state is docker inspect "{{.State.Running}} {{.State.StartedAt}}" for the
    official-dashboard container. Unknown state returns None (count every fresh
    marker). A stopped dashboard returns +inf: no web-chat turn can be running.
    A running one returns its start time: turns live in that process's memory,
    so an older marker belongs to a process that no longer exists.
    """
    parts = (state or "").split()
    if len(parts) != 2:
        return None
    running, started = parts
    if running != "true":
        return float("inf")
    try:
        started_at = _hivra_datetime.strptime(started[:19], "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        return None
    return started_at.replace(tzinfo=_hivra_timezone.utc).timestamp()


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
    fresh marker files or entries that could not be parsed; callers treat them
    as busy (fail safe). A file is rewritten whenever a turn starts or ends, so
    one untouched for longer than the window, or since before the dashboard
    started, cannot describe a running turn and is skipped unread; that bound
    keeps a corrupt file from pinning a box busy forever. Prompts are never read
    out.
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
`;

/**
 * Standalone probe for the update gate. Invoked as
 * `python3 - <HERMES_HOME> "<dashboard inspect state>" <fresh seconds>` and
 * prints exactly `live=<n> unreadable=<m>`.
 */
export function buildTurnMarkerProbePython(): string {
  return `import sys
import time
${TURN_MARKER_PROBE_PYTHON_FUNCTIONS}

hivra_live, hivra_unreadable = hivra_live_turn_markers(
    sys.argv[1],
    time.time(),
    float(sys.argv[3]),
    hivra_dashboard_not_before(sys.argv[2]),
)
print("live=%d unreadable=%d" % (hivra_live, hivra_unreadable))
`;
}
