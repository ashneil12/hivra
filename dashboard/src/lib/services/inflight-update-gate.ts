/**
 * In-flight turn gate for SYSTEM-initiated live updates of a Hermes webfree box.
 *
 * applyLiveUpdate force-recreates the gateway and official-dashboard containers,
 * which ends a web-chat turn running in official-dashboard. Scheduled automation
 * (daily fleet sync, pending-resize sweep, unhealthy-box recovery) used to do
 * that with no check. Before such an update launches, this gate runs on the box
 * (inside the same remote script applyLiveUpdate already uses) and reads the
 * agent's durable turn markers (agent-activity-probe.ts):
 *
 *   - no live turn            -> proceed, and end any deferral streak;
 *   - a live turn, or a marker it cannot read (fail safe) -> defer. The update
 *     is not launched, applyLiveUpdate reports `deferred_busy`, and the caller's
 *     next tick retries;
 *   - but never forever: once a streak reaches SYSTEM_UPDATE_MAX_DEFERRALS
 *     deferrals or SYSTEM_UPDATE_MAX_DEFER_SECONDS since its first deferral, the
 *     update proceeds and the report says so (`deferral_cap`).
 *
 * The streak lives on the box (updateDeferralStatePath()): "<first deferral
 * epoch> <count>". It ends when an update launches (any initiator clears it) or
 * the gate sees no live turn. Measuring from the first deferral, not the last,
 * is what makes the cap real for a daily caller: the fleet sync defers a busy box
 * once, and proceeds on its next visit if the box is still busy.
 *
 * User- and operator-initiated updates skip the gate (the person asked for the
 * restart now) but still clear the streak.
 */

import {
  DASHBOARD_STATE_INSPECT_FORMAT,
  TURN_MARKER_FRESH_SECONDS,
  WEBFREE_HERMES_HOME,
  buildTurnMarkerProbePython,
} from "@/lib/services/agent-activity-probe";

/**
 * Deferral cap by count. With the 15-minute pending-resize and recovery sweeps
 * this equals the time cap below; it is the backstop if the box clock steps.
 */
export const SYSTEM_UPDATE_MAX_DEFERRALS = 24;

/**
 * Deferral cap by elapsed time since the streak's first deferral. Same bound as
 * a marker's freshness: a system update waits at most as long as one turn may
 * count as running, so back-to-back turns cannot starve updates.
 */
export const SYSTEM_UPDATE_MAX_DEFER_SECONDS = 6 * 60 * 60;

/** Marker line the gate prints; parseInFlightUpdateGateReport reads it back. */
export const INFLIGHT_UPDATE_GATE_MARKER = "HERMES_INFLIGHT_GATE";

/** Official-dashboard venv interpreter (the compose runs /opt/hermes/.venv/bin/hermes). */
const DASHBOARD_PYTHON = "/opt/hermes/.venv/bin/python3";

export type InFlightUpdateGateReason =
  | "no_turn_in_flight"
  | "dashboard_not_running"
  | "in_flight_turn"
  | "turn_state_unknown"
  | "deferral_cap"
  | "deferral_state_unwritable"
  | "gate_report_missing";

export interface InFlightUpdateGateReport {
  action: "proceed" | "defer";
  verdict: "idle" | "busy" | "unknown";
  reason: InFlightUpdateGateReason;
  /** Live turn markers seen, or null when the probe did not run or failed. */
  liveTurns: number | null;
  /** Fresh marker files/entries that could not be parsed (counted as busy). */
  unreadableMarkers: number | null;
  /** Deferrals in the current streak, including this one when deferring. */
  deferrals: number;
  /** Seconds since the streak's first deferral (0 when there was no streak). */
  streakSeconds: number;
}

export function updateDeferralStatePath(instanceId: string): string {
  return `/var/lib/hermes-update-deferrals-${instanceId}`;
}

function shQuote(value: string | number): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export interface InFlightUpdateGateScriptOptions {
  instanceId: string;
  /** Override for tests; defaults to updateDeferralStatePath(instanceId). */
  deferralStatePath?: string;
  maxDeferrals?: number;
  maxDeferSeconds?: number;
  markerFreshSeconds?: number;
}

/**
 * The gate, as a standalone bash script run as root on the guest. It prints one
 * `HERMES_INFLIGHT_GATE action=... verdict=... reason=... live=... unreadable=...
 * deferrals=... streak_s=...` line and always exits 0; the caller decides from
 * `action=` alone.
 */
export function buildInFlightUpdateGateScript(options: InFlightUpdateGateScriptOptions): string {
  const statePath = options.deferralStatePath ?? updateDeferralStatePath(options.instanceId);
  const maxDeferrals = options.maxDeferrals ?? SYSTEM_UPDATE_MAX_DEFERRALS;
  const maxDeferSeconds = options.maxDeferSeconds ?? SYSTEM_UPDATE_MAX_DEFER_SECONDS;
  const freshSeconds = options.markerFreshSeconds ?? TURN_MARKER_FRESH_SECONDS;
  return `#!/usr/bin/env bash
# Hivra in-flight turn gate for a system-initiated live update (see
# dashboard/src/lib/services/inflight-update-gate.ts). Prints one report line.
set -u
INST=${shQuote(options.instanceId)}
D="agent-\${INST}-official-dashboard"
STATE=${shQuote(statePath)}
FRESH_S=${Math.floor(freshSeconds)}
MAX_DEFERRALS=${Math.floor(maxDeferrals)}
MAX_DEFER_S=${Math.floor(maxDeferSeconds)}
now="$(date +%s)"
live="-"
unreadable="-"
report() {
  printf '${INFLIGHT_UPDATE_GATE_MARKER} action=%s verdict=%s reason=%s live=%s unreadable=%s deferrals=%s streak_s=%s\\n' \\
    "$1" "$2" "$3" "$live" "$unreadable" "$4" "$5"
}
# Bound every Docker call: a wedged daemon or dashboard must not hold the launch
# until the caller's SSH timeout, which would record the update as failed.
bounded() {
  if command -v timeout >/dev/null 2>&1; then timeout "$@"; else shift; "$@"; fi
}
# Web-chat turns run in the official-dashboard process. No container, or a
# stopped one, means no turn can be in flight.
dash="$(bounded 15 docker inspect "$D" -f ${shQuote(DASHBOARD_STATE_INSPECT_FORMAT)} 2>/dev/null)"
dash_rc=$?
if [ "$dash_rc" = 124 ]; then
  dash="unknown"
elif [ "$dash_rc" != 0 ]; then
  dash=""
fi
case "$dash" in
  unknown)
    # Docker did not answer in time: fail safe.
    verdict=unknown; reason=turn_state_unknown ;;
  "true "*)
    probe="$(bounded 30 docker exec -i "$D" ${DASHBOARD_PYTHON} - ${WEBFREE_HERMES_HOME} "$dash" "$FRESH_S" <<'HERMES_TURN_MARKER_PY' 2>/dev/null
${buildTurnMarkerProbePython()}HERMES_TURN_MARKER_PY
)" || probe=""
    case "$probe" in
      "live=0 unreadable=0")
        live=0; unreadable=0; verdict=idle; reason=no_turn_in_flight ;;
      live=*" unreadable="*)
        live="\${probe#live=}"; live="\${live%% *}"
        unreadable="\${probe##*unreadable=}"
        verdict=busy; reason=in_flight_turn ;;
      *)
        # The dashboard is up but its markers could not be read: fail safe.
        verdict=unknown; reason=turn_state_unknown ;;
    esac
    ;;
  *)
    verdict=idle; reason=dashboard_not_running ;;
esac
if [ "$verdict" = idle ]; then
  rm -f "$STATE"
  report proceed "$verdict" "$reason" 0 0
  exit 0
fi
first=""
count=""
if [ -f "$STATE" ]; then
  read -r first count < "$STATE" || true
fi
case "$first" in ''|*[!0-9]*) first="$now"; count=0 ;; esac
case "$count" in ''|*[!0-9]*) count=0 ;; esac
# A first-deferral stamp in the future (clock step) restarts the streak clock.
if [ "$first" -gt "$now" ]; then first="$now"; fi
streak=$(( now - first ))
if [ "$count" -ge "$MAX_DEFERRALS" ] || [ "$streak" -ge "$MAX_DEFER_S" ]; then
  rm -f "$STATE"
  report proceed "$verdict" deferral_cap "$count" "$streak"
  exit 0
fi
count=$(( count + 1 ))
tmp="\${STATE}.tmp.$$"
if printf '%s %s\\n' "$first" "$count" > "$tmp" 2>/dev/null && mv -f "$tmp" "$STATE" 2>/dev/null; then
  report defer "$verdict" "$reason" "$count" "$streak"
else
  rm -f "$tmp" 2>/dev/null
  # Deferring without a counter could starve updates forever: proceed instead.
  report proceed "$verdict" deferral_state_unwritable "$count" "$streak"
fi
exit 0
`;
}

const VERDICTS = new Set(["idle", "busy", "unknown"]);
const REASONS = new Set<InFlightUpdateGateReason>([
  "no_turn_in_flight",
  "dashboard_not_running",
  "in_flight_turn",
  "turn_state_unknown",
  "deferral_cap",
  "deferral_state_unwritable",
  "gate_report_missing",
]);

function parseCount(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  return Number(value);
}

/**
 * Read the gate's report line back out of the launch output. Returns null when
 * there is no well-formed line (the gate never ran or crashed).
 */
export function parseInFlightUpdateGateReport(stdout: string): InFlightUpdateGateReport | null {
  const line = stdout
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.startsWith(`${INFLIGHT_UPDATE_GATE_MARKER} `));
  if (!line) return null;
  const fields = new Map<string, string>();
  for (const token of line.slice(INFLIGHT_UPDATE_GATE_MARKER.length + 1).split(/\s+/)) {
    const eq = token.indexOf("=");
    if (eq > 0) fields.set(token.slice(0, eq), token.slice(eq + 1));
  }
  const action = fields.get("action");
  const verdict = fields.get("verdict");
  const reason = fields.get("reason") as InFlightUpdateGateReason | undefined;
  if ((action !== "proceed" && action !== "defer") || !verdict || !VERDICTS.has(verdict)) {
    return null;
  }
  if (!reason || !REASONS.has(reason)) return null;
  return {
    action,
    verdict: verdict as InFlightUpdateGateReport["verdict"],
    reason,
    liveTurns: parseCount(fields.get("live")),
    unreadableMarkers: parseCount(fields.get("unreadable")),
    deferrals: parseCount(fields.get("deferrals")) ?? 0,
    streakSeconds: parseCount(fields.get("streak_s")) ?? 0,
  };
}

/** Report used when a gated launch printed no report line (the update did launch). */
export function missingInFlightUpdateGateReport(): InFlightUpdateGateReport {
  return {
    action: "proceed",
    verdict: "unknown",
    reason: "gate_report_missing",
    liveTurns: null,
    unreadableMarkers: null,
    deferrals: 0,
    streakSeconds: 0,
  };
}
