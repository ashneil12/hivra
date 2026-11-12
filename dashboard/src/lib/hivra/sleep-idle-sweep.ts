import "server-only";

import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { parseSleepMode, type SleepMode } from "./agent-sleep-policy";
import { shellQuote, resolveHivraProxmoxHost } from "./proxmox-target";
import {
  finishAgentSleep,
  finishAgentWake,
  logAgentSleepEvent,
  type AgentSleepFinishResult,
  type AgentWakeFinishResult,
} from "./agent-sleep-store";
import { type ObservedSleepState } from "./agent-sleep-scripts";
import {
  SCHEDULED_WAKE_LEAD_SECONDS,
  resolveSleepTimings,
  sleepHivraAgent,
  type SleepOutcome,
} from "./agent-sleep";
import {
  ensureHivraAgentAwake,
  pollPublicHealthz,
  resolveSleepTarget,
  type AgentRow,
  type EnsureAwakeResult,
} from "./agent-wake";

/**
 * The sleep sweep: the cron that puts idle agents to sleep and keeps the sleep
 * machinery honest. Every minute, in this order and inside one time budget:
 *
 *   1. Scheduled wakes: an agent whose next job is close is woken ahead of it.
 *   2. Stale lease recovery: a sleep or wake lease older than 10 minutes is
 *      finished to the state the host reports.
 *   3. Hibernate: agents that have napped long enough save their memory to disk.
 *   4. Nap: awake agents that pass the cheap database prefilter go to
 *      sleepHivraAgent, and its live idle probe makes the real decision.
 *
 * Dark by default: it does nothing unless HIVRA_SLEEP_MODE is `canary` or `on`,
 * and it only touches hosts whose own sleep_mode is `canary` or `on`. Fail
 * toward awake: anything unknown or unreadable leaves the agent alone, and none
 * of it writes hivra_agents.status. A sleep that was cut off by the budget
 * leaves its lease for step 2 to settle on a later run.
 */

const LOG_SOURCE = "sleep-idle-agents";

/** The budget for starting work. A nap is cut off at it; the route's maxDuration is far above it. */
export const SWEEP_BUDGET_MS = 50_000;
/**
 * A hibernate may run past the budget, up to this long from the start of the run:
 * its host script is allowed 240 s, and cutting the call off would leave the
 * agent hibernating with no one to finish the lease. The route's maxDuration is 300 s.
 */
export const HIBERNATE_HARD_LIMIT_MS = 285_000;
/** Scheduled wakes may use at most this much of the budget, so sleeping still gets a turn. */
const WAKE_STEP_BUDGET_MS = 22_000;
const WAKE_MAX_PER_RUN = 10;
const WAKE_CONCURRENCY = 4;
/** A wake that failed is retried by the schedule only after this long. */
const WAKE_RETRY_BACKOFF_MS = 5 * 60_000;

/**
 * A sleep or wake lease older than this is settled from the host. Longer than the
 * slowest legitimate hold (a hibernate script is allowed 280 s, plus its probe),
 * short enough that an agent whose caller died is not stuck for long.
 */
export const STALE_LEASE_MS = 6 * 60_000;
const LEASE_MAX_PER_RUN = 10;
/** More rows are read than settled, so leases that are left in place do not block the rest. */
const LEASE_SCAN_LIMIT = 40;
/** A lease the sweep had to leave is not looked at again for this long (best effort, per server instance). */
const LEASE_LEFT_COOLDOWN_MS = 5 * 60_000;
const LEASE_CONCURRENCY = 3;
const STATE_SCRIPT_TIMEOUT_MS = 30_000;
const LEASE_HEALTHZ_BUDGET_MS = 6_000;

/** Work per host per run: hibernates and naps together. */
export const HOST_WORK_CAP = 3;
/** Calls per host per run, including cheap refusals, so a long candidate list cannot eat the run. */
const HOST_CALL_CAP = 12;
const CANDIDATE_SCAN_LIMIT = 500;
const PREFILTER_CHUNK = 100;
const PREFILTER_ROWS = 1000;
/** Time that must be left before a sleep may start. */
const MIN_NAP_START_MS = 20_000;
const MIN_HIBERNATE_START_MS = 30_000;
/** An agent the live probe found busy is not probed again for this long (best effort, per server instance). */
export const NOT_IDLE_COOLDOWN_MS = 5 * 60_000;

/** Skips that never reached a host: they do not use up a host's work cap. */
const CHEAP_SKIPS = new Set([
  "sleep_mode_off",
  "observe_only",
  "agent_unreadable",
  "not_awake",
  "not_awake_or_napping",
  "generation_unknown",
  "claim_refused",
]);

const cooldowns = new Map<string, number>();
const leaseCooldowns = new Map<string, number>();
/** Test support: forgets which agents were found busy. */
export function resetSleepSweepCooldowns(): void {
  cooldowns.clear();
  leaseCooldowns.clear();
}

// ---------------------------------------------------------------------------
// Host state script (read only)
// ---------------------------------------------------------------------------

export const SLEEP_STATE_PREFIX = "HIVRA_SLEEP_STATE ";
const OBSERVED: readonly ObservedSleepState[] = ["awake", "napping", "hibernated", "cold", "unknown"];

/**
 * Reads where a computer is in its sleep, and whether a hibernate unit is still
 * running for it. Changes nothing. Starts like the other lifecycle scripts: the
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
// Sweep
// ---------------------------------------------------------------------------

export interface SweepStepCounts {
  candidates: number;
  attempted: number;
  slept: number;
  /** The live check found the agent in use, or the script aborted. */
  kept_awake: number;
  ineligible: number;
  skipped: number;
  failed: number;
}

export interface SleepIdleSweepSummary {
  mode: SleepMode;
  skipped: boolean;
  reason?: string;
  wakes: { due: number; awake: number; waking: number; failed: number; cold: number };
  leases: { stale: number; settled: number; left: number };
  hibernate: SweepStepCounts;
  nap: SweepStepCounts;
  timedOut: boolean;
  elapsedMs: number;
  errors: number;
}

function emptyCounts(): SweepStepCounts {
  return { candidates: 0, attempted: 0, slept: 0, kept_awake: 0, ineligible: 0, skipped: 0, failed: 0 };
}

function emptySummary(mode: SleepMode): SleepIdleSweepSummary {
  return {
    mode,
    skipped: false,
    wakes: { due: 0, awake: 0, waking: 0, failed: 0, cold: 0 },
    leases: { stale: 0, settled: 0, left: 0 },
    hibernate: emptyCounts(),
    nap: emptyCounts(),
    timedOut: false,
    elapsedMs: 0,
    errors: 0,
  };
}

export interface SleepIdleSweepOptions {
  env?: Record<string, string | undefined>;
  now?: () => number;
  budgetMs?: number;
}

type Db = NonNullable<typeof supabaseAdmin>;

interface HostInfo {
  status: string | null;
  sleep_mode: string | null;
}

interface Candidate {
  id: string;
  host: string;
}

interface Context {
  db: Db;
  mode: SleepMode;
  env: Record<string, string | undefined>;
  now: () => number;
  startedAt: number;
  deadline: number;
  summary: SleepIdleSweepSummary;
}

function fail(ctx: Context, message: string, error: unknown, failureType: string) {
  ctx.summary.errors += 1;
  log.error(message, error instanceof Error ? error : new Error(JSON.stringify(error)), {
    source: LOG_SOURCE,
    failureType,
  });
}

const remaining = (ctx: Context) => ctx.deadline - ctx.now();

/** Races work against the deadline. The work keeps running when it loses; its lease is settled by step 2 later. */
async function untilDeadline<T>(
  ctx: Context,
  work: Promise<T>,
  limitAt: number = ctx.deadline,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  const ms = Math.max(0, limitAt - ctx.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  // The work may lose the race and fail later; that must not become an unhandled rejection.
  const guarded = work.then(
    (value) => ({ timedOut: false as const, value }),
    (error) => {
      throw error;
    },
  );
  guarded.catch(() => undefined);
  try {
    return await Promise.race([guarded, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Runs `items` through `worker` with at most `limit` in flight. */
async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

const hostActs = (host: HostInfo | undefined): boolean =>
  !!host && host.status !== "maintenance" && (host.sleep_mode === "canary" || host.sleep_mode === "on");

// --- Step 1: scheduled wakes -------------------------------------------------

async function runScheduledWakes(ctx: Context): Promise<void> {
  const { db, summary } = ctx;
  const nowMs = ctx.now();
  const dueBefore = new Date(nowMs + SCHEDULED_WAKE_LEAD_SECONDS * 1000).toISOString();
  // A failed wake is retried on a back-off, so the rows still inside it are left out here,
  // not after the limit, where enough of them would hide every newer wake.
  const retryAfter = new Date(nowMs - WAKE_RETRY_BACKOFF_MS).toISOString();
  const { data, error } = await db
    .from("hivra_agents")
    .select("id, sleep_state, sleep_tier_changed_at, next_wake_at")
    .eq("status", "running")
    .in("sleep_state", ["napping", "hibernated", "wake_failed"])
    .not("next_wake_at", "is", null)
    .lte("next_wake_at", dueBefore)
    .or(`sleep_state.neq.wake_failed,sleep_tier_changed_at.lte.${retryAfter}`)
    .order("next_wake_at", { ascending: true })
    .limit(WAKE_MAX_PER_RUN * 3);
  if (error) {
    fail(ctx, "failed to load scheduled wakes", error, "sleep_sweep_wake_query_failed");
    return;
  }
  const rows = ((data ?? []) as Array<{ id: string; sleep_state: string; sleep_tier_changed_at: string | null }>).filter(
    (row) => {
      if (row.sleep_state !== "wake_failed") return true;
      // A failed wake is retried on a back-off, not every minute.
      const changed = row.sleep_tier_changed_at ? Date.parse(row.sleep_tier_changed_at) : Number.NaN;
      return Number.isFinite(changed) && nowMs - changed >= WAKE_RETRY_BACKOFF_MS;
    },
  );
  const due = rows.slice(0, WAKE_MAX_PER_RUN);
  summary.wakes.due = due.length;
  if (due.length === 0) return;

  const stepDeadline = Math.min(ctx.deadline, ctx.startedAt + WAKE_STEP_BUDGET_MS);
  const background: Promise<unknown>[] = [];
  await pool(due, WAKE_CONCURRENCY, async (row) => {
    const waitMs = Math.max(0, Math.min(30_000, stepDeadline - ctx.now() - 2_000));
    if (waitMs < 1_000) return;
    let result: EnsureAwakeResult;
    try {
      result = await ensureHivraAgentAwake(row.id, {
        trigger: "schedule",
        waitMs,
        onBackground: (work) => background.push(work),
      });
    } catch (error) {
      summary.wakes.failed += 1;
      fail(ctx, "scheduled wake threw", error, "sleep_sweep_wake_threw");
      return;
    }
    if (result.state === "awake") summary.wakes.awake += 1;
    else if (result.state === "waking") summary.wakes.waking += 1;
    else if (result.state === "cold") {
      summary.wakes.cold += 1;
      log.warn("scheduled wake found a computer that is off; the normal start path owns it", {
        source: LOG_SOURCE,
        failureType: "sleep_sweep_wake_cold",
        instanceId: row.id,
      });
    } else summary.wakes.failed += 1;
  });
  // Wakes still running after their wait get the rest of this step to finish.
  if (background.length > 0) await untilDeadline(ctx, Promise.allSettled(background), stepDeadline);
}

// --- Step 2: stale lease recovery ---------------------------------------------

async function settleStaleLease(ctx: Context, row: AgentRow): Promise<void> {
  const { summary } = ctx;
  const agentId = String(row.id);
  const operationId = String(row.operation_id);
  const kind = row.operation_kind === "wake" ? "wake" : "sleep";
  const leave = (why: string, extra: Record<string, unknown> = {}) => {
    summary.leases.left += 1;
    log.warn("stale sleep lease left in place", {
      source: LOG_SOURCE,
      failureType: "sleep_sweep_lease_left",
      instanceId: agentId,
      kind,
      why,
      ...extra,
    });
  };

  const resolved = await resolveSleepTarget(row, LOG_SOURCE);
  if (!resolved.ok) return leave(`target_${resolved.code}`);
  const target = resolved.target;
  if (!target.bindingTag) return leave("binding_not_enforced");

  const run = await runProxmoxHostScript(
    buildSleepStateHostScript({ vmid: target.vmid, bindingTag: target.bindingTag }),
    target.env,
    { timeoutMs: STATE_SCRIPT_TIMEOUT_MS },
  );
  const receipt = parseSleepStateReceipt(run?.stdout ?? "", target.vmid);
  if (!receipt) return leave("state_unreadable");
  // A hibernate that is still running on the host is not stale, only slow.
  if (receipt.unitActive) return leave("unit_active");
  if (!receipt.ok) return leave(receipt.reason);

  let healthzUp = false;
  if (kind === "wake" && receipt.observed === "awake") {
    healthzUp = (await pollPublicHealthz(row.cf_hostname, { budgetMs: LEASE_HEALTHZ_BUDGET_MS })).up;
  }
  const result = staleLeaseResult(kind, receipt.observed, healthzUp);
  if (!result) return leave("state_unknown");

  const finished =
    kind === "sleep"
      ? await finishAgentSleep({ agentId, operationId, result: result as AgentSleepFinishResult })
      : await finishAgentWake({ agentId, operationId, result: result as AgentWakeFinishResult });
  if (!finished) return leave("finish_not_recorded");

  summary.leases.settled += 1;
  const startedAt = Date.parse(String(row.operation_started_at));
  await logAgentSleepEvent({
    agentId,
    kind: "reconcile",
    trigger: "reconcile",
    fromState: String(row.sleep_state ?? ""),
    toState: result,
    reason: `stale_${kind}_lease`,
    detail: {
      host_state: receipt.observed,
      age_s: Number.isFinite(startedAt) ? Math.round((ctx.now() - startedAt) / 1000) : null,
    },
  });
}

async function recoverStaleLeases(ctx: Context): Promise<void> {
  const { db, summary } = ctx;
  const cutoff = new Date(ctx.now() - STALE_LEASE_MS).toISOString();
  const { data, error } = await db
    .from("hivra_agents")
    .select("*")
    .in("operation_kind", ["sleep", "wake"])
    .not("operation_id", "is", null)
    .lt("operation_started_at", cutoff)
    .order("operation_started_at", { ascending: true })
    .limit(LEASE_SCAN_LIMIT);
  if (error) {
    fail(ctx, "failed to load stale sleep leases", error, "sleep_sweep_lease_query_failed");
    return;
  }
  const nowMs = ctx.now();
  const rows = ((data ?? []) as AgentRow[])
    .filter((row) => (leaseCooldowns.get(String(row.operation_id)) ?? 0) <= nowMs)
    .slice(0, LEASE_MAX_PER_RUN);
  summary.leases.stale = rows.length;
  await pool(rows, LEASE_CONCURRENCY, async (row) => {
    if (remaining(ctx) < 5_000) {
      summary.leases.left += 1;
      return;
    }
    const leftBefore = summary.leases.left;
    try {
      const done = await untilDeadline(ctx, settleStaleLease(ctx, row));
      if (done.timedOut) summary.leases.left += 1;
    } catch (error) {
      summary.leases.left += 1;
      fail(ctx, "stale sleep lease recovery failed", error, "sleep_sweep_lease_failed");
    }
    // One that was left (unit still running, host unreadable) steps aside so the next ones get their turn.
    if (summary.leases.left > leftBefore) leaseCooldowns.set(String(row.operation_id), ctx.now() + LEASE_LEFT_COOLDOWN_MS);
  });
}

// --- Steps 3 and 4: hibernate and nap -----------------------------------------

async function loadHosts(ctx: Context): Promise<Map<string, HostInfo> | null> {
  const { data, error } = await ctx.db.from("proxmox_hosts").select("id, status, sleep_mode");
  if (error) {
    fail(ctx, "failed to load hosts for the sleep sweep", error, "sleep_sweep_hosts_query_failed");
    return null;
  }
  const hosts = new Map<string, HostInfo>();
  for (const row of (data ?? []) as Array<{ id: string; status: string | null; sleep_mode: string | null }>) {
    hosts.set(String(row.id), { status: row.status, sleep_mode: row.sleep_mode });
  }
  return hosts;
}

/** Policies a tier may run under. `on` mode has no policy prefilter: every eligible agent but always_on. */
function policyFilter(mode: SleepMode, tier: "nap" | "hibernate"): string[] | null {
  if (mode !== "canary") return null;
  return tier === "nap" ? ["t1", "full"] : ["t3", "full"];
}

function toCandidates(rows: Array<{ id: string; proxmox_host: string | null }>, hosts: Map<string, HostInfo>) {
  const out: Candidate[] = [];
  for (const row of rows) {
    const host = resolveHivraProxmoxHost(typeof row.proxmox_host === "string" ? row.proxmox_host : null);
    if (hostActs(hosts.get(host))) out.push({ id: String(row.id), host });
  }
  return out;
}

async function loadHibernateCandidates(ctx: Context, hosts: Map<string, HostInfo>): Promise<Candidate[]> {
  const timings = resolveSleepTimings(ctx.env);
  const cutoff = new Date(ctx.now() - timings.hibernateAfterSeconds * 1000).toISOString();
  let query = ctx.db
    .from("hivra_agents")
    .select("id, proxmox_host")
    .eq("status", "running")
    .eq("desired_state", "running")
    .eq("sleep_state", "napping")
    .is("operation_id", null)
    .eq("deployment_mode", "hivra-managed")
    .eq("computer_substrate", "proxmox-kvm")
    .is("deployment_target_id", null)
    .eq("always_on", false)
    .lte("sleep_tier_changed_at", cutoff);
  const policies = policyFilter(ctx.mode, "hibernate");
  if (policies) query = query.in("sleep_policy", policies);
  const { data, error } = await query
    .order("sleep_tier_changed_at", { ascending: true })
    .limit(CANDIDATE_SCAN_LIMIT);
  if (error) {
    fail(ctx, "failed to load hibernate candidates", error, "sleep_sweep_hibernate_query_failed");
    return [];
  }
  return toCandidates((data ?? []) as Array<{ id: string; proxmox_host: string | null }>, hosts);
}

function shuffle<T>(items: T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Agent ids with an event or a reported use inside the window. A chunk that cannot be read counts as busy. */
async function recentlyActive(ctx: Context, ids: string[], sinceIso: string): Promise<Set<string>> {
  const active = new Set<string>();
  for (let i = 0; i < ids.length; i += PREFILTER_CHUNK) {
    const chunk = ids.slice(i, i + PREFILTER_CHUNK);
    const { data: events, error: eventsError } = await ctx.db
      .from("hivra_agent_events")
      .select("agent_id")
      .in("agent_id", chunk)
      .gte("created_at", sinceIso)
      .limit(PREFILTER_ROWS);
    if (eventsError) {
      fail(ctx, "failed to read agent events for the nap prefilter", eventsError, "sleep_sweep_events_query_failed");
      for (const id of chunk) active.add(id);
      continue;
    }
    for (const row of (events ?? []) as Array<{ agent_id: string | null }>) {
      if (row.agent_id) active.add(row.agent_id);
    }
    const { data: activity, error: activityError } = await ctx.db
      .from("hivra_agent_activity")
      .select("agent_id, last_used_at")
      .in("agent_id", chunk);
    if (activityError) {
      fail(ctx, "failed to read agent use for the nap prefilter", activityError, "sleep_sweep_activity_query_failed");
      for (const id of chunk) active.add(id);
      continue;
    }
    for (const row of (activity ?? []) as Array<{ agent_id: string; last_used_at: string | null }>) {
      const used = row.last_used_at ? Date.parse(row.last_used_at) : Number.NaN;
      if (Number.isFinite(used) && used >= Date.parse(sinceIso)) active.add(row.agent_id);
    }
  }
  return active;
}

async function loadNapCandidates(ctx: Context, hosts: Map<string, HostInfo>): Promise<Candidate[]> {
  const timings = resolveSleepTimings(ctx.env);
  const nowMs = ctx.now();
  const windowStart = new Date(nowMs - timings.napAfterSeconds * 1000).toISOString();
  let query = ctx.db
    .from("hivra_agents")
    .select("id, proxmox_host")
    .eq("status", "running")
    .eq("desired_state", "running")
    .eq("sleep_state", "awake")
    .is("operation_id", null)
    .eq("deployment_mode", "hivra-managed")
    .eq("computer_substrate", "proxmox-kvm")
    .is("deployment_target_id", null)
    .eq("always_on", false)
    .not("cf_hostname", "is", null)
    .not("vmid", "is", null)
    .not("bootstrapped_at", "is", null)
    .not("type", "in", "(aeon,linux-desktop)")
    // No wake, abort or other change inside the nap window.
    .or(`sleep_tier_changed_at.is.null,sleep_tier_changed_at.lte.${windowStart}`);
  const policies = policyFilter(ctx.mode, "nap");
  if (policies) query = query.in("sleep_policy", policies);
  const { data, error } = await query
    .order("sleep_tier_changed_at", { ascending: true, nullsFirst: true })
    .limit(CANDIDATE_SCAN_LIMIT);
  if (error) {
    fail(ctx, "failed to load nap candidates", error, "sleep_sweep_nap_query_failed");
    return [];
  }
  const candidates = toCandidates((data ?? []) as Array<{ id: string; proxmox_host: string | null }>, hosts);
  if (candidates.length === 0) return [];
  const active = await recentlyActive(ctx, candidates.map((c) => c.id), windowStart);
  // Shuffled so the same busy agents do not take every run's slots.
  return shuffle(candidates.filter((c) => !active.has(c.id)));
}

function touchedHost(outcome: SleepOutcome): boolean {
  if (outcome.outcome === "ineligible") return false;
  if (outcome.outcome === "skipped" && CHEAP_SKIPS.has(outcome.reason ?? "")) return false;
  return true;
}

function tally(counts: SweepStepCounts, outcome: SleepOutcome) {
  switch (outcome.outcome) {
    case "slept":
      counts.slept += 1;
      break;
    case "aborted":
    case "not_idle":
      counts.kept_awake += 1;
      break;
    case "ineligible":
      counts.ineligible += 1;
      break;
    case "skipped":
      counts.skipped += 1;
      break;
    default:
      counts.failed += 1;
  }
}

async function runHostWork(
  ctx: Context,
  hibernates: Candidate[],
  naps: Candidate[],
): Promise<void> {
  const { summary } = ctx;
  let work = 0;
  let calls = 0;
  const queue: Array<{ candidate: Candidate; tier: "nap" | "hibernate" }> = [
    ...hibernates.map((candidate) => ({ candidate, tier: "hibernate" as const })),
    ...naps.map((candidate) => ({ candidate, tier: "nap" as const })),
  ];
  for (const { candidate, tier } of queue) {
    if (ctx.summary.timedOut) return;
    if (work >= HOST_WORK_CAP || calls >= HOST_CALL_CAP) return;
    const counts = tier === "nap" ? summary.nap : summary.hibernate;
    if (tier === "nap") {
      const until = cooldowns.get(candidate.id);
      if (until !== undefined && until > ctx.now()) continue;
    }
    if (remaining(ctx) < (tier === "nap" ? MIN_NAP_START_MS : MIN_HIBERNATE_START_MS)) {
      // Not enough time to finish another sleep safely; the next run takes it.
      return;
    }
    calls += 1;
    counts.attempted += 1;
    try {
      const done = await untilDeadline(
        ctx,
        sleepHivraAgent(candidate.id, { tier, trigger: "sweep", env: ctx.env, now: ctx.now }),
        tier === "hibernate" ? ctx.startedAt + HIBERNATE_HARD_LIMIT_MS : ctx.deadline,
      );
      if (done.timedOut) {
        ctx.summary.timedOut = true;
        counts.failed += 1;
        log.warn("agent sleep did not finish inside the sweep budget; its lease is settled later", {
          source: LOG_SOURCE,
          failureType: "sleep_sweep_budget_exhausted",
          instanceId: candidate.id,
          tier,
        });
        return;
      }
      const outcome = done.value;
      tally(counts, outcome);
      if (touchedHost(outcome)) work += 1;
      if (tier === "nap" && (outcome.outcome === "not_idle" || outcome.outcome === "aborted")) {
        cooldowns.set(candidate.id, ctx.now() + NOT_IDLE_COOLDOWN_MS);
      }
      if (outcome.outcome === "failed") {
        log.warn("sweep sleep failed", {
          source: LOG_SOURCE,
          failureType: "sleep_sweep_sleep_failed",
          instanceId: candidate.id,
          tier,
          reason: outcome.reason,
        });
      }
    } catch (error) {
      counts.failed += 1;
      fail(ctx, "sweep sleep threw", error, "sleep_sweep_sleep_threw");
    }
  }
}

async function runSleepSteps(ctx: Context): Promise<void> {
  const hosts = await loadHosts(ctx);
  if (!hosts) return;
  if (![...hosts.values()].some(hostActs)) return;

  const hibernates = await loadHibernateCandidates(ctx, hosts);
  const naps = remaining(ctx) > MIN_NAP_START_MS ? await loadNapCandidates(ctx, hosts) : [];
  ctx.summary.hibernate.candidates = hibernates.length;
  ctx.summary.nap.candidates = naps.length;

  const byHost = new Map<string, { hibernates: Candidate[]; naps: Candidate[] }>();
  const slot = (host: string) => {
    let entry = byHost.get(host);
    if (!entry) {
      entry = { hibernates: [], naps: [] };
      byHost.set(host, entry);
    }
    return entry;
  };
  for (const c of hibernates) slot(c.host).hibernates.push(c);
  for (const c of naps) slot(c.host).naps.push(c);

  // Hosts run in parallel; each host's own work is one at a time and capped.
  await Promise.all(
    [...byHost.values()].map((entry) =>
      runHostWork(ctx, entry.hibernates, entry.naps).catch((error) =>
        fail(ctx, "sleep sweep host work failed", error, "sleep_sweep_host_failed"),
      ),
    ),
  );
}

export async function runSleepIdleSweep(options: SleepIdleSweepOptions = {}): Promise<SleepIdleSweepSummary> {
  const env = options.env ?? process.env;
  const mode = parseSleepMode(env.HIVRA_SLEEP_MODE);
  // Off and observe never put an agent to sleep, but they must still bring one back:
  // turning the switch off with an agent asleep, or a lease open, would otherwise
  // strand it. Steps 1 and 2 only ever move an agent toward awake, and with nothing
  // asleep they find no rows.
  const actsOnSleep = mode === "canary" || mode === "on";

  const db = supabaseAdmin;
  if (!db) {
    log.error("supabase admin client unavailable; cannot run the sleep sweep", new Error("supabaseAdmin missing"), {
      source: LOG_SOURCE,
      failureType: "supabase_admin_unavailable",
    });
    return {
      ...emptySummary(mode),
      skipped: true,
      reason: "supabase_unavailable",
      errors: actsOnSleep ? 1 : 0,
    };
  }

  const now = options.now ?? Date.now;
  const startedAt = now();
  const summary = emptySummary(mode);
  const ctx: Context = {
    db,
    mode,
    env,
    now,
    startedAt,
    deadline: startedAt + (options.budgetMs ?? SWEEP_BUDGET_MS),
    summary,
  };

  const steps: Array<[string, (c: Context) => Promise<void>]> = [
    ["scheduled wakes", runScheduledWakes],
    ["stale lease recovery", recoverStaleLeases],
    ...(actsOnSleep ? ([["hibernate and nap", runSleepSteps]] as Array<[string, (c: Context) => Promise<void>]>) : []),
  ];
  for (const [name, step] of steps) {
    if (remaining(ctx) <= 0) {
      summary.timedOut = true;
      break;
    }
    try {
      await step(ctx);
    } catch (error) {
      fail(ctx, `sleep sweep step failed: ${name}`, error, "sleep_sweep_step_failed");
    }
  }

  summary.elapsedMs = now() - startedAt;
  if (!actsOnSleep) {
    summary.skipped = true;
    summary.reason = mode === "off" ? "sleep_mode_off" : "observe_mode_only";
  }
  const acted =
    summary.wakes.due + summary.leases.stale + summary.hibernate.attempted + summary.nap.attempted > 0;
  if (acted) {
    log.info("sleep sweep finished", {
      source: LOG_SOURCE,
      mode,
      wakes: summary.wakes,
      leases: summary.leases,
      hibernate: summary.hibernate,
      nap: summary.nap,
      timedOut: summary.timedOut,
      elapsedMs: summary.elapsedMs,
    });
  }
  return summary;
}
