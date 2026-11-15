import "server-only";

import { log } from "@/lib/logger";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { shellQuote } from "./proxmox-target";
import {
  finishAgentSleep,
  finishAgentWake,
  logAgentSleepEvent,
  parseSleepGeneration,
  reconcileAgentSleepState,
  type AgentSleepFinishResult,
  type AgentSleepReconcileTarget,
  type AgentWakeFinishResult,
} from "./agent-sleep-store";
import { type ObservedSleepState } from "./agent-sleep-scripts";
import { STALE_SLEEP_LEASE_MS } from "./agent-sleep-policy";
import { ensureHivraAgentAwake, pollPublicHealthz, resolveSleepTarget, type AgentRow } from "./agent-wake";

/**
 * Reconcile: bring an agent's sleep record back in line with what its host
 * shows. The database and the host can drift apart when a sleep or wake is cut
 * off (a crash or a timeout between the host action and the record), and a
 * record that says the wrong thing strands an agent: a "napping" row that is
 * really running is never woken, an "awake" row whose computer is paused is
 * never reached.
 *
 * Three cases, all from one read-only host state script:
 *   1. A sleep or wake lease that has outlived any legitimate hold: finish it
 *      to the state the host reports (paused is napping, saved to disk is
 *      hibernated, running is awake).
 *   2. No lease, but a sleep state that is not awake: make the record say what
 *      the host shows.
 *   3. No lease and "awake", but the computer is paused or hibernated: record
 *      what the host shows, then wake it (fail toward awake).
 *
 * Fail toward awake, and never guess: an unreadable or unknown host state, a
 * sleep or wake script still running on the host, or another operation in
 * flight leaves the record alone. A record is only changed by a compare and
 * set that loses to anything that moved the agent in the meantime. Nothing here
 * touches hivra_agents.status.
 */

const LOG_SOURCE = "sleep-reconcile";

/** A sleep or wake lease older than this is settled from the host. */
export const STALE_LEASE_MS = STALE_SLEEP_LEASE_MS;
const STATE_SCRIPT_TIMEOUT_MS = 30_000;
const LEASE_HEALTHZ_BUDGET_MS = 6_000;
/** How long a repair that wakes a drifted agent waits for the wake. The rest finishes in the background. */
const DRIFT_WAKE_WAIT_MS = 20_000;

export const SLEEP_STATE_PREFIX = "HIVRA_SLEEP_STATE ";
const OBSERVED: readonly ObservedSleepState[] = ["awake", "napping", "hibernated", "cold", "unknown"];

/**
 * Reads where a computer is in its sleep, and whether a sleep or wake is still
 * running for it (the hibernate unit is active, or the per-VM script lock is
 * held; both come back as unit_active). Changes nothing. Starts like the other lifecycle scripts: the
 * exact binding tag is required (a missing tag refuses), `set -euo pipefail`,
 * every value quoted, and `qm` under `timeout`. Prints one HIVRA_SLEEP_STATE line.
 */
export function buildSleepStateHostScript(target: { vmid: number; bindingTag: string | null }): string {
  if (!Number.isSafeInteger(target.vmid) || target.vmid < 100 || target.vmid > 999_999_999) {
    throw new Error("Invalid sleep state script VMID.");
  }
  if (typeof target.bindingTag !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(target.bindingTag)) {
    throw new Error("Sleep state script needs the computer's exact binding tag.");
  }
  return `set -euo pipefail
VMID=${target.vmid}
EXPECTED_BINDING_TAG=${shellQuote(target.bindingTag)}
# The host script itself arrives on stdin, so no command may read it.
qm() { command timeout -k 5 25 qm "$@" </dev/null; }
emit() { printf '${SLEEP_STATE_PREFIX}{"ok":%s,"vmid":%s,"observed":"%s","reason":"%s","unit_active":%s}\\n' "$1" "$VMID" "$2" "$3" "$4"; exit 0; }
[ -n "$EXPECTED_BINDING_TAG" ] || emit false unknown binding_missing false
CONFIG="$(qm config "$VMID" 2>/dev/null)" || emit false unknown unreachable false
printf '%s\\n' "$CONFIG" | sed -n 's/^tags:[[:space:]]*//p' | tr ';' '\\n' | grep -Fx -- "$EXPECTED_BINDING_TAG" >/dev/null \\
  || emit false unknown binding_mismatch false
UNIT=false
if systemctl is-active --quiet "hivra-sleep-$VMID" 2>/dev/null; then UNIT=true; fi
# A sleep or wake script holds this lock while it works. If it is held, the computer is about to change.
install -d -m 0755 /run/lock
if { exec 9>"/run/lock/hivra-vm-$VMID.lock"; } 2>/dev/null && ! flock -x -n 9; then UNIT=true; fi
STATUS="$(qm status "$VMID" 2>/dev/null | awk '$1=="status:" {print $2; exit}')" || emit false unknown unreachable "$UNIT"
QMP="$(qm status "$VMID" --verbose 2>/dev/null | awk '$1=="qmpstatus:" {print $2; exit}')" || emit false unknown unreachable "$UNIT"
LOCK="$(printf '%s\\n' "$CONFIG" | awk '$1=="lock:" {print $2; exit}')"
case "$STATUS/\${QMP:-none}/\${LOCK:-none}" in
  running/running/none) emit true awake observed "$UNIT" ;;
  running/paused/none) emit true napping observed "$UNIT" ;;
  stopped/*/suspended) emit true hibernated observed "$UNIT" ;;
  stopped/*/none) emit true cold observed "$UNIT" ;;
  *) emit false unknown unexpected_state "$UNIT" ;;
esac
`;
}

export interface SleepStateReceipt {
  ok: boolean;
  vmid: number;
  observed: ObservedSleepState;
  reason: string;
  unitActive: boolean;
}

/** Strict read of the state script's one line. Anything else is null, and null means unknown. */
export function parseSleepStateReceipt(stdout: string, expectedVmid?: number): SleepStateReceipt | null {
  if (typeof stdout !== "string") return null;
  const lines = stdout
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.startsWith(SLEEP_STATE_PREFIX));
  if (lines.length !== 1) return null;
  let value: unknown;
  try {
    value = JSON.parse(lines[0].slice(SLEEP_STATE_PREFIX.length));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.ok !== "boolean" ||
    !Number.isSafeInteger(row.vmid) ||
    (row.vmid as number) < 100 ||
    (expectedVmid !== undefined && row.vmid !== expectedVmid) ||
    typeof row.observed !== "string" ||
    !OBSERVED.includes(row.observed as ObservedSleepState) ||
    typeof row.reason !== "string" ||
    !/^[a-z_]{1,40}$/.test(row.reason) ||
    typeof row.unit_active !== "boolean"
  ) {
    return null;
  }
  // A readable state is a success; an unreadable one says so.
  if (row.ok === (row.observed === "unknown")) return null;
  return {
    ok: row.ok,
    vmid: row.vmid as number,
    observed: row.observed as ObservedSleepState,
    reason: row.reason,
    unitActive: row.unit_active,
  };
}

/**
 * The state a stale lease is finished to, or null to leave it. Pure.
 *
 * A sleep lease follows the host: paused is napping, saved to disk is
 * hibernated, running is awake. A computer that is off is not asleep, so that
 * is awake too (the normal start path owns it). A wake lease that is not
 * finished is a failed wake, except when the computer is up and answering.
 * Unknown is never settled.
 */
export function staleLeaseResult(
  kind: "sleep" | "wake",
  observed: ObservedSleepState,
  healthzUp: boolean,
): AgentSleepFinishResult | AgentWakeFinishResult | null {
  if (observed === "unknown") return null;
  if (kind === "sleep") {
    if (observed === "napping") return "napping";
    if (observed === "hibernated") return "hibernated";
    return "awake";
  }
  if (observed === "cold") return "awake";
  if (observed === "awake") return healthzUp ? "awake" : "wake_failed";
  return "wake_failed";
}

// ---------------------------------------------------------------------------
// Reconcile one agent
// ---------------------------------------------------------------------------

export type ReconcileOutcome =
  | {
      outcome: "settled";
      /** The state the record was set to. */
      to: AgentSleepFinishResult | AgentWakeFinishResult | AgentSleepReconcileTarget;
      hostState: ObservedSleepState;
      /** Which case settled: a stale lease, a drifted record, or an awake record on a sleeping computer. */
      why: "stale_lease" | "record_drift" | "awake_but_asleep";
      /** For an awake record on a sleeping computer: whether the wake that followed finished inside its wait. */
      woke?: boolean;
    }
  | { outcome: "consistent"; hostState: ObservedSleepState }
  | { outcome: "left"; reason: string };

export interface ReconcileOptions {
  now?: () => number;
  /** Test seam: how long the wake after a repair waits. */
  wakeWaitMs?: number;
  /** Gets wake work that is still running when its wait ends. */
  onBackground?: (work: Promise<unknown>) => void;
}

const TRANSIENT_STATES: readonly string[] = ["draining", "hibernating", "waking"];

/** Whether the row holds a sleep or wake lease, and which. */
export function sleepLeaseKind(row: AgentRow): "sleep" | "wake" | null {
  if (typeof row.operation_id !== "string" || !row.operation_id) return null;
  if (row.operation_kind === "sleep") return "sleep";
  if (row.operation_kind === "wake") return "wake";
  return null;
}

/** How old the row's sleep or wake lease is, in ms, or null when it has none or no usable start time. */
export function sleepLeaseAgeMs(row: AgentRow, nowMs: number): number | null {
  if (!sleepLeaseKind(row)) return null;
  const startedAt = Date.parse(String(row.operation_started_at));
  return Number.isFinite(startedAt) ? Math.max(0, nowMs - startedAt) : null;
}

/** Reads the host state for one agent's computer. A reason string means it could not be read or must not be acted on. */
async function readHostState(row: AgentRow): Promise<{ receipt: SleepStateReceipt } | { left: string }> {
  const resolved = await resolveSleepTarget(row, LOG_SOURCE);
  if (!resolved.ok) return { left: `target_${resolved.code}` };
  const target = resolved.target;
  if (!target.bindingTag) return { left: "binding_not_enforced" };
  const run = await runProxmoxHostScript(
    buildSleepStateHostScript({ vmid: target.vmid, bindingTag: target.bindingTag }),
    target.env,
    { timeoutMs: STATE_SCRIPT_TIMEOUT_MS },
  );
  const receipt = parseSleepStateReceipt(run?.stdout ?? "", target.vmid);
  if (!receipt) return { left: "state_unreadable" };
  // A hibernate unit or another sleep or wake script is still working: not stale, only slow.
  if (receipt.unitActive) return { left: "unit_active" };
  if (!receipt.ok) return { left: receipt.reason };
  return { receipt };
}

/**
 * The state a record without a lease is set to, or null to leave it as it is.
 * Pure. `healthzUp` only matters when the host shows the computer running.
 *
 * A computer that is off is not asleep (the normal start path owns it), so the
 * record goes to awake. A running computer is awake only when its public check
 * answers; otherwise the record says wake_failed, so the next wake runs the
 * guest fixups again. Unknown is never settled.
 */
export function leaselessReconcileTarget(
  dbState: string,
  observed: ObservedSleepState,
  healthzUp: boolean,
): AgentSleepReconcileTarget | null {
  if (observed === "unknown") return null;
  if (dbState === "awake") return null;
  if (observed === "cold") return "awake";
  if (observed === "awake") {
    if (healthzUp) return "awake";
    return dbState === "wake_failed" ? null : "wake_failed";
  }
  // The computer is asleep on the host.
  if (dbState === "wake_failed") return null;
  if (observed === "napping") return dbState === "napping" ? null : "napping";
  return dbState === "hibernated" ? null : "hibernated";
}

/**
 * Reconciles one agent's record with its host. `row` is the full agent row, as
 * read just now. Never throws.
 */
export async function reconcileAgentSleep(row: AgentRow, options: ReconcileOptions = {}): Promise<ReconcileOutcome> {
  const now = options.now ?? Date.now;
  const agentId = String(row.id);
  const dbState = String(row.sleep_state ?? "awake");
  const leaseKind = sleepLeaseKind(row);
  const left = (reason: string): ReconcileOutcome => {
    log.warn("sleep record left as it is", {
      source: LOG_SOURCE,
      failureType: "sleep_reconcile_left",
      instanceId: agentId,
      reason,
      dbState,
    });
    return { outcome: "left", reason };
  };

  try {
    // Another kind of operation is moving this computer: not ours to touch.
    if (row.operation_id != null && !leaseKind) return left("other_operation");
    // A lease is settled whatever the agent's status; a record without one only while the agent runs.
    if (!leaseKind) {
      if (row.status !== "running") return left("not_running");
      if (row.desired_state !== "running") return left("not_desired_running");
    }

    const read = await readHostState(row);
    if ("left" in read) return left(read.left);
    const observed = read.receipt.observed;

    let healthzUp = false;
    const needsHealthz = observed === "awake" && (leaseKind === "wake" || (!leaseKind && dbState !== "awake"));
    if (needsHealthz) {
      healthzUp = (await pollPublicHealthz(row.cf_hostname, { budgetMs: LEASE_HEALTHZ_BUDGET_MS })).up;
    }

    // 1. A lease that outlived its holder.
    if (leaseKind) {
      const kind = leaseKind;
      const result = staleLeaseResult(kind, observed, healthzUp);
      if (!result) return left("state_unknown");
      const operationId = String(row.operation_id);
      const finished =
        kind === "sleep"
          ? await finishAgentSleep({ agentId, operationId, result: result as AgentSleepFinishResult })
          : await finishAgentWake({ agentId, operationId, result: result as AgentWakeFinishResult });
      if (!finished) return left("finish_not_recorded");
      const startedAt = Date.parse(String(row.operation_started_at));
      await logAgentSleepEvent({
        agentId,
        kind: "reconcile",
        trigger: "reconcile",
        fromState: dbState,
        toState: result,
        reason: `stale_${kind}_lease`,
        detail: {
          host_state: observed,
          age_s: Number.isFinite(startedAt) ? Math.round((now() - startedAt) / 1000) : null,
        },
      });
      return { outcome: "settled", to: result, hostState: observed, why: "stale_lease" };
    }

    const generation = parseSleepGeneration(row.sleep_generation);
    if (generation === null) return left("generation_unknown");

    // 3. The record says awake. All is well unless the computer is paused or saved to disk.
    if (dbState === "awake") {
      if (observed === "awake" || observed === "cold") return { outcome: "consistent", hostState: observed };
      const to: AgentSleepReconcileTarget = observed === "napping" ? "napping" : "hibernated";
      if (!(await reconcileAgentSleepState({ agentId, expectedGeneration: generation, to }))) {
        return left("changed_meanwhile");
      }
      await logAgentSleepEvent({
        agentId,
        kind: "reconcile",
        trigger: "reconcile",
        fromState: "awake",
        toState: to,
        reason: "awake_record_on_sleeping_computer",
        detail: { host_state: observed },
      });
      // Nothing asked for this agent to sleep: bring it back. The record is truthful now, so
      // the normal wake path (lease, host script, health check) does the work.
      let woke = false;
      try {
        const wake = await ensureHivraAgentAwake(agentId, {
          trigger: "reconcile",
          waitMs: options.wakeWaitMs ?? DRIFT_WAKE_WAIT_MS,
          onBackground: options.onBackground,
        });
        woke = wake.state === "awake";
      } catch {
        // The record is right; the next use or sweep wakes it.
      }
      return { outcome: "settled", to, hostState: observed, why: "awake_but_asleep", woke };
    }

    // 2. The record says asleep or mid-way, with no lease holding it.
    const to = leaselessReconcileTarget(dbState, observed, healthzUp);
    if (!to) return { outcome: "consistent", hostState: observed };
    if (!(await reconcileAgentSleepState({ agentId, expectedGeneration: generation, to }))) {
      return left("changed_meanwhile");
    }
    await logAgentSleepEvent({
      agentId,
      kind: "reconcile",
      trigger: "reconcile",
      fromState: dbState,
      toState: to,
      reason: TRANSIENT_STATES.includes(dbState) ? "leaseless_transient_state" : "record_differs_from_host",
      detail: { host_state: observed },
    });
    return { outcome: "settled", to, hostState: observed, why: "record_drift" };
  } catch (error) {
    log.warn("sleep reconcile failed", {
      source: LOG_SOURCE,
      failureType: "sleep_reconcile_failed",
      instanceId: agentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { outcome: "left", reason: "reconcile_error" };
  }
}
