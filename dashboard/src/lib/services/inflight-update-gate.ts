/**
 * In-flight turn gate for SYSTEM-initiated live updates of a Hermes webfree box.
 *
 * applyLiveUpdate force-recreates the gateway and official-dashboard containers,
 * which ends any turn running in either: a web-chat turn in official-dashboard,
 * or a messaging, cron or scheduled-task turn in the gateway. Scheduled
 * automation (daily fleet sync, pending-resize sweep, unhealthy-box recovery)
 * used to do that with no check. Before such an update launches, this gate runs
 * on the box (inside the same remote script applyLiveUpdate already uses) and
 * asks the shared agent activity probe (agent-activity-probe.ts, the same code
 * the idle sampler runs) whether a turn is in flight:
 *
 *   - idle -> proceed, and end the caller's deferral streak;
 *   - busy (a live turn) -> defer: the update is not launched, applyLiveUpdate
 *     reports `deferred_busy`, and the caller's next run retries;
 *   - unknown (the probe could not tell) -> defer too (`deferred_unverified`,
 *     reported apart from a turn in flight: it can mean a failing gateway),
 *     except for unhealthy-box recovery: there a probe that cannot answer is
 *     part of the breakage being repaired, not evidence of a turn, so recovery
 *     proceeds;
 *   - but never forever: each caller has its own deferral cap
 *     (SYSTEM_UPDATE_DEFERRAL_POLICY). Once a streak reaches it, the update
 *     proceeds and the report says so (`deferral_cap`).
 *
 * Streaks are kept per caller on the box (updateDeferralStatePath(), one file per
 * trigger, "<first deferral> <last deferral> <count>"), so two 15-minute callers
 * cannot share a counter and reach a cap in half the time. A streak is over once
 * the caller has not deferred for longer than it takes to come back
 * (streakExpirySeconds): the next deferral then starts a new streak instead of
 * inheriting a first-deferral stamp from days ago, which would otherwise proceed
 * straight through a running turn. Any launched update (every initiator) clears
 * every caller's streak for the box.
 *
 * User- and operator-initiated updates skip the gate (the person asked for the
 * restart now) but still clear the streaks.
 *
 * The whole probe is bounded by the caller's budget (budgetSeconds), sized per
 * launch lane: the lane's SSH timeout is raised by gatedLaunchTimeoutMs, so a
 * slow Docker on the box can never push the launch past its timeout and turn a
 * system update into a failed launch.
 */

import { buildAgentActivityProbeShell } from "@/lib/services/agent-activity-probe";
import type { SystemLiveUpdateTrigger } from "@/lib/services/live-update-initiator";

export interface SystemUpdateDeferralPolicy {
  /** How often this caller comes back to a deferred box, for reference. */
  retryIntervalSeconds: number;
  /**
   * A streak whose last deferral is older than this is over: the next deferral
   * starts a new streak. A few of the caller's retry intervals, so one missed
   * run does not reset it, but a deferral from a past episode never counts.
   */
  streakExpirySeconds: number;
  /** Proceed once a streak holds this many deferrals. */
  maxDeferrals: number;
  /** Proceed once a streak's first deferral is this old. */
  maxDeferSeconds: number;
  /** What an unknown verdict (the probe could not tell) does. */
  onUnknown: "defer" | "proceed";
}

const HOUR = 60 * 60;

/**
 * Per-caller deferral policy.
 *
 * - fleet_sync runs once a day and requeues a deferred box at the head of the
 *   next day's queue. A busy box is deferred on two consecutive daily visits at
 *   most and updated on the third, whatever it is doing then.
 * - pending_resize_sweep runs every 15 minutes. It waits up to six hours (the
 *   same bound as a web-chat marker's freshness) or 24 deferrals for a turn to
 *   end, so back-to-back turns cannot starve a paid resize.
 * - unhealthy_recovery runs every 15 minutes on a box that is already broken.
 *   It proceeds when the probe cannot tell, and waits for a positively running
 *   turn at most one hour or four deferrals, so a hung turn cannot hold a repair
 *   for long.
 */
export const SYSTEM_UPDATE_DEFERRAL_POLICY: Readonly<
  Record<SystemLiveUpdateTrigger, Readonly<SystemUpdateDeferralPolicy>>
> = Object.freeze({
  fleet_sync: Object.freeze({
    retryIntervalSeconds: 24 * HOUR,
    streakExpirySeconds: 36 * HOUR,
    maxDeferrals: 2,
    maxDeferSeconds: 48 * HOUR,
    onUnknown: "defer" as const,
  }),
  pending_resize_sweep: Object.freeze({
    retryIntervalSeconds: 15 * 60,
    streakExpirySeconds: HOUR,
    maxDeferrals: 24,
    maxDeferSeconds: 6 * HOUR,
    onUnknown: "defer" as const,
  }),
  unhealthy_recovery: Object.freeze({
    retryIntervalSeconds: 15 * 60,
    streakExpirySeconds: HOUR,
    maxDeferrals: 4,
    maxDeferSeconds: HOUR,
    onUnknown: "proceed" as const,
  }),
});

/**
 * Whole-probe budget for the gate, in seconds. Covers the container state
 * checks and the probe run with room for a slow `docker exec`; a probe that runs
 * out of time answers unknown. The launch lane's SSH timeout grows by this plus
 * INFLIGHT_UPDATE_GATE_SLACK_SECONDS (gatedLaunchTimeoutMs).
 */
export const INFLIGHT_UPDATE_GATE_BUDGET_SECONDS = 15;

/**
 * Time the gate may take beyond its probe budget: the deadline is checked with
 * one-second clock granularity, and bash, the streak file and the report line
 * need a moment too.
 */
export const INFLIGHT_UPDATE_GATE_SLACK_SECONDS = 3;

/** A lane's launch timeout for a gated (system) update: its own timeout plus the gate's worst case. */
export function gatedLaunchTimeoutMs(baseTimeoutMs: number, budgetSeconds: number): number {
  return baseTimeoutMs + (Math.ceil(budgetSeconds) + INFLIGHT_UPDATE_GATE_SLACK_SECONDS) * 1000;
}

/** Marker line the gate prints; parseInFlightUpdateGateReport reads it back. */
export const INFLIGHT_UPDATE_GATE_MARKER = "HERMES_INFLIGHT_GATE";

export type InFlightUpdateGateReason =
  | "no_turn_in_flight"
  | "agent_not_running"
  | "in_flight_turn"
  | "turn_state_unknown"
  | "deferral_cap"
  | "deferral_state_unwritable"
  | "gate_report_missing";

export interface InFlightUpdateGateReport {
  action: "proceed" | "defer";
  verdict: "idle" | "busy" | "unknown";
  reason: InFlightUpdateGateReason;
  /** The caller the gate ran for, or null when there was no report. */
  trigger: SystemLiveUpdateTrigger | null;
  /** Live web-chat turn markers seen, or null when the probe did not run. */
  liveTurns: number | null;
  /** Fresh web-chat marker files/entries that could not be parsed. */
  unreadableMarkers: number | null;
  /** Gateway turns in flight (messaging, cron, scheduled tasks), or null. */
  gatewayActive: number | null;
  /** 1 when the gateway's state was stale or unreadable while it ran, or null. */
  gatewayUnknown: number | null;
  /** Deferrals in the current streak, including this one when deferring. */
  deferrals: number;
  /** Seconds since the streak's first deferral (0 when there was no streak). */
  streakSeconds: number;
}

/** Why a system update was deferred, as LiveUpdateResult and its callers report it. */
export type InFlightDeferralReason = "deferred_busy" | "deferred_unverified";

export interface InFlightDeferral {
  /**
   * "busy": the probe saw a turn in flight. "unverified": the computer could
   * not confirm that none was running (gateway state stale, missing or
   * unreadable while it runs, unreadable turn markers, a probe that ran out of
   * time), which can mean a gateway that is failing rather than working.
   */
  kind: "busy" | "unverified";
  reason: InFlightDeferralReason;
  /** Tail for a log message ("<caller> deferred: <summary>"). */
  summary: string;
  /** The same as a clause for a readable error ("Deferred: <clause> ..."). */
  clause: string;
}

/**
 * How to report a deferral. Every caller words it from the gate's verdict, so a
 * deferral on an unknown verdict is never logged as a turn in flight.
 */
export function describeInFlightDeferral(report: Pick<InFlightUpdateGateReport, "verdict">): InFlightDeferral {
  if (report.verdict === "busy") {
    return {
      kind: "busy",
      reason: "deferred_busy",
      summary: "agent turn in flight",
      clause: "an agent turn is in flight",
    };
  }
  return {
    kind: "unverified",
    reason: "deferred_unverified",
    summary: "could not confirm no agent turn is running",
    clause: "the computer could not confirm that no agent turn is running",
  };
}

/** The gate's findings for a caller's deferral log line. */
export function inFlightGateLogFields(report: InFlightUpdateGateReport) {
  return {
    verdict: report.verdict,
    gateReason: report.reason,
    liveTurns: report.liveTurns,
    unreadableMarkers: report.unreadableMarkers,
    gatewayActive: report.gatewayActive,
    gatewayUnknown: report.gatewayUnknown,
    deferrals: report.deferrals,
    streakSeconds: report.streakSeconds,
  };
}

const STATE_DIRECTORY_PREFIX = "/var/lib/hermes-update-deferrals-";

/** The prefix every trigger's streak file for this box starts with (clear with `<prefix>*`). */
export function updateDeferralStatePrefix(instanceId: string): string {
  return `${STATE_DIRECTORY_PREFIX}${instanceId}.`;
}

export function updateDeferralStatePath(instanceId: string, trigger: SystemLiveUpdateTrigger): string {
  return `${updateDeferralStatePrefix(instanceId)}${trigger}`;
}

function shQuote(value: string | number): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Shell line that ends every caller's deferral streak for the box. */
export function buildClearUpdateDeferralsCommand(instanceId: string): string {
  return `rm -f ${shQuote(updateDeferralStatePrefix(instanceId))}*`;
}

export interface InFlightUpdateGateScriptOptions {
  instanceId: string;
  trigger: SystemLiveUpdateTrigger;
  /** Whole-probe budget, sized by the launch lane (INFLIGHT_UPDATE_GATE_BUDGET_SECONDS). */
  budgetSeconds: number;
  /** Override for tests; defaults to updateDeferralStatePath(instanceId, trigger). */
  deferralStatePath?: string;
  /** Override for tests; defaults to SYSTEM_UPDATE_DEFERRAL_POLICY[trigger]. */
  policy?: Partial<SystemUpdateDeferralPolicy>;
  markerFreshSeconds?: number;
}

/**
 * The gate, as a standalone bash script run as root on the guest. It prints one
 * `HERMES_INFLIGHT_GATE action=... verdict=... reason=... trigger=... live=...
 * unreadable=... gateway_active=... gateway_unknown=... deferrals=... streak_s=...`
 * line and always exits 0; the caller decides from `action=` alone.
 */
export function buildInFlightUpdateGateScript(options: InFlightUpdateGateScriptOptions): string {
  const policy = { ...SYSTEM_UPDATE_DEFERRAL_POLICY[options.trigger], ...options.policy };
  const statePath = options.deferralStatePath ?? updateDeferralStatePath(options.instanceId, options.trigger);
  const budgetSeconds = Math.max(1, Math.ceil(options.budgetSeconds));
  return `#!/usr/bin/env bash
# Hivra in-flight turn gate for a system-initiated live update (see
# dashboard/src/lib/services/inflight-update-gate.ts). Prints one report line.
set -u
INST=${shQuote(options.instanceId)}
TRIGGER=${shQuote(options.trigger)}
STATE=${shQuote(statePath)}
MAX_DEFERRALS=${Math.floor(policy.maxDeferrals)}
MAX_DEFER_S=${Math.floor(policy.maxDeferSeconds)}
STREAK_EXPIRY_S=${Math.floor(policy.streakExpirySeconds)}
ON_UNKNOWN=${policy.onUnknown === "proceed" ? "proceed" : "defer"}
# The whole probe fits in ${budgetSeconds} s, so the launch that follows keeps its own SSH time.
HIVRA_ACTIVITY_DEADLINE=$(( $(date +%s) + ${budgetSeconds} ))
${buildAgentActivityProbeShell(
  options.markerFreshSeconds === undefined ? {} : { markerFreshSeconds: options.markerFreshSeconds },
)}
report() {
  printf '${INFLIGHT_UPDATE_GATE_MARKER} action=%s verdict=%s reason=%s trigger=%s live=%s unreadable=%s gateway_active=%s gateway_unknown=%s deferrals=%s streak_s=%s\\n' \\
    "$1" "$2" "$3" "$TRIGGER" "$HIVRA_LIVE_TURNS" "$HIVRA_UNREADABLE_MARKERS" "$HIVRA_GATEWAY_ACTIVE" "$HIVRA_GATEWAY_UNKNOWN" "$4" "$5"
}
hivra_agent_activity "agent-\${INST}-gateway" "agent-\${INST}-official-dashboard"
verdict="$HIVRA_ACTIVITY_VERDICT"
reason="$HIVRA_ACTIVITY_REASON"
now="$(date +%s)"
if [ "$verdict" = idle ]; then
  rm -f "$STATE"
  report proceed "$verdict" "$reason" 0 0
  exit 0
fi
if [ "$verdict" = unknown ] && [ "$ON_UNKNOWN" = proceed ]; then
  # This caller repairs broken boxes: a probe that cannot answer is part of the
  # breakage, not evidence of a turn. Only a positively running turn defers it.
  rm -f "$STATE"
  report proceed "$verdict" "$reason" 0 0
  exit 0
fi
first=""
last=""
count=""
if [ -f "$STATE" ]; then
  read -r first last count _rest < "$STATE" || true
fi
valid=1
for field in "$first" "$last" "$count"; do
  case "$field" in ''|*[!0-9]*) valid=0 ;; esac
done
if [ "$valid" != 1 ]; then
  # No streak, or one this gate cannot trust: start a new one.
  first="$now"
  last="$now"
  count=0
fi
# A stamp in the future (clock step) counts as now.
if [ "$first" -gt "$now" ]; then first="$now"; fi
if [ "$last" -gt "$now" ]; then last="$now"; fi
# A streak ends once this caller has not deferred for longer than it takes to
# come back; a deferral from a past episode must not count against this turn.
if [ "$count" -gt 0 ] && [ $(( now - last )) -gt "$STREAK_EXPIRY_S" ]; then
  first="$now"
  count=0
fi
streak=$(( now - first ))
if [ "$count" -ge "$MAX_DEFERRALS" ] || [ "$streak" -ge "$MAX_DEFER_S" ]; then
  rm -f "$STATE"
  report proceed "$verdict" deferral_cap "$count" "$streak"
  exit 0
fi
count=$(( count + 1 ))
tmp="\${STATE}.tmp.$$"
if printf '%s %s %s\\n' "$first" "$now" "$count" > "$tmp" 2>/dev/null && mv -f "$tmp" "$STATE" 2>/dev/null; then
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
const TRIGGERS = new Set<SystemLiveUpdateTrigger>(["fleet_sync", "pending_resize_sweep", "unhealthy_recovery"]);
const REASONS = new Set<InFlightUpdateGateReason>([
  "no_turn_in_flight",
  "agent_not_running",
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
  const trigger = fields.get("trigger") as SystemLiveUpdateTrigger | undefined;
  return {
    action,
    verdict: verdict as InFlightUpdateGateReport["verdict"],
    reason,
    trigger: trigger && TRIGGERS.has(trigger) ? trigger : null,
    liveTurns: parseCount(fields.get("live")),
    unreadableMarkers: parseCount(fields.get("unreadable")),
    gatewayActive: parseCount(fields.get("gateway_active")),
    gatewayUnknown: parseCount(fields.get("gateway_unknown")),
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
    trigger: null,
    liveTurns: null,
    unreadableMarkers: null,
    gatewayActive: null,
    gatewayUnknown: null,
    deferrals: 0,
    streakSeconds: 0,
  };
}
