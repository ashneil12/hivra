import "server-only";

import { randomUUID } from "node:crypto";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import { ssrfSafeFetch } from "@/lib/ssrf-safe-fetch";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { resolveProxmoxHostCapacityPolicy } from "@/lib/infrastructure/host-capacity-policy";
import { acquireHostWakeSlot, normalizeWakeRamMb, releaseHostWakeSlot } from "@/lib/proxmox/wake-admission";
import { resolveHivraLifecycleTarget, type HivraLifecycleTarget } from "./agent-lifecycle-host";
import { STALE_SLEEP_LEASE_MS } from "./agent-sleep-policy";
import { isStartBlockedForLapse } from "./lapse-gate";
import {
  claimAgentWake,
  finishAgentWake,
  isAgentAwake,
  logAgentSleepEvent,
  parseSleepGeneration,
  type AgentSleepEventTrigger,
} from "./agent-sleep-store";
import { buildWakeHostScript, parseWakeReceipt, WAKE_RESULT_PREFIX, type WakeAdmission, type WakeReceipt } from "./agent-sleep-scripts";
import { isFastWakeEnabled } from "./fast-wake-flags";
import {
  disarmChannelsForWake,
  rearmChannelsAfterFailedWake,
  settleChannelsAfterWake,
  type ChannelDisarms,
} from "./channel-wake/lifecycle";

/**
 * Wake an agent that is asleep, and say when it can be used.
 *
 * Fail toward awake: every path that takes the wake lease also gives it back,
 * as `awake` when the computer is confirmed up and as `wake_failed` for
 * anything else, so the next try can run again. None of it touches
 * hivra_agents.status. A lapsed owner is never woken.
 *
 * The wake script (agent-sleep-scripts.ts) does the host work: resume a nap,
 * restore a hibernation under host capacity admission, then, in one guest
 * exec over the guest agent socket, set the guest's clock from the host and
 * hard-restart its tunnel. This file claims the lease, runs the script,
 * waits for the public health check, and records the result.
 */

const LOG_SOURCE = "agent-wake";

export const DEFAULT_WAKE_WAIT_MS = 45_000;
const MAX_WAKE_WAIT_MS = 120_000;
/** How long the public health check is given after the host says the computer is up. */
export const WAKE_HEALTHZ_BUDGET_MS = 30_000;
const HEALTHZ_REQUEST_TIMEOUT_MS = 5_000;
const HEALTHZ_INTERVAL_MS = 1_000;
/** With fast_healthz: the quicker polls right after the host says the computer is up, and how long they last. */
const HEALTHZ_FAST_INTERVAL_MS = 150;
const HEALTHZ_FAST_WINDOW_MS = 3_000;
/** The host script's own bounds: up to 15 s for a sleep that holds the computer, 8 s of guest-agent wait, and for a restore the start itself. A nap wake normally takes about one second. */
const WAKE_SCRIPT_TIMEOUT_MS = 60_000;
const RESTORE_SCRIPT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 1_000;

/** States an operation is still moving through. The row settles by itself. */
const TRANSIENT_STATES: readonly string[] = ["draining", "hibernating", "waking"];

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/i;

/**
 * Whether a row in a transient sleep state has no one working on it: no lease at all (a
 * delete finished the lease and left the state), or a sleep or wake lease that has outlived
 * any legitimate hold. Such a row never settles by itself, so waiting on it is pointless.
 */
export function isStuckTransient(row: AgentRow, nowMs: number): boolean {
  if (!TRANSIENT_STATES.includes(String(row.sleep_state))) return false;
  if (row.operation_id === null) return true;
  if (row.operation_kind !== "sleep" && row.operation_kind !== "wake") return false;
  const startedAt = Date.parse(String(row.operation_started_at));
  return Number.isFinite(startedAt) && nowMs - startedAt >= STALE_SLEEP_LEASE_MS;
}

export type EnsureAwakeState = "awake" | "waking" | "failed" | "cold";

export interface EnsureAwakeResult {
  state: EnsureAwakeState;
  /** Milliseconds from the start of the wake to a healthy computer. Only when this call woke it. */
  wakeMs?: number;
  /** A short code: why it is not awake, or how it woke. */
  reason?: string;
}

export interface EnsureAwakeOptions {
  trigger: AgentSleepEventTrigger;
  /** How long this call may wait for a wake, its own or another's. Default 45 s. */
  waitMs?: number;
  /** How often the row is re-read while waiting. Default 1 s. */
  pollIntervalMs?: number;
  /**
   * Gets the wake work when it is still running as the wait ends, so a route can
   * hand it to `after()` and keep the function alive until the wake finishes.
   */
  onBackground?: (work: Promise<unknown>) => void;
}

export type AgentRow = Record<string, unknown>;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** The full agent row, or null when there is none. Throws when the read itself fails. */
export async function readHivraAgentRow(agentId: string): Promise<AgentRow | null> {
  if (!supabaseAdmin) throw new Error("database_unavailable");
  const { data, error } = await supabaseAdmin.from("hivra_agents").select("*").eq("id", agentId).maybeSingle();
  if (error) throw new Error("agent_read_failed");
  return (data as AgentRow | null) ?? null;
}

async function tryReadRow(agentId: string): Promise<AgentRow | null> {
  try {
    return await readHivraAgentRow(agentId);
  } catch {
    return null;
  }
}

/** The capacity policy a restore is admitted under: the same inputs the start action uses. */
export function buildWakeAdmissionFor(target: HivraLifecycleTarget): WakeAdmission {
  const policy = resolveProxmoxHostCapacityPolicy(target.executionContext.capacityPolicy);
  return {
    provisionerDirectory: target.executionContext.paths.provisionerDirectory,
    hostReserveMb: policy.hostMemoryReserveMb,
    enforceCeilings: policy.mode === "enforce",
    cpuDensityMilli: Math.round(policy.cpuCeilingDensity * 1000),
    memoryDensityMilli: Math.round(policy.memoryCeilingDensity * 1000),
  };
}

/**
 * The host and VM for a sleep or wake. Stop and force_stop skip the managed
 * host's provisioner readiness check, which is right here: these scripts are
 * inline and never call the start helper.
 */
export async function resolveSleepTarget(row: AgentRow, source: string) {
  return resolveHivraLifecycleTarget({
    userId: String(row.user_id),
    agent: row,
    action: "stop",
    source,
  });
}

export interface WakeScriptRun {
  /** The parsed receipt, or null when the script printed none that parses. */
  receipt: WakeReceipt | null;
  /** The host's own error text when the script could not run, with no secrets. */
  runError: string | null;
  ms: number;
  /** With the timing switch on: when the SSH session to the host was ready. */
  sshReadyMs?: number;
}

/** Runs the wake script once. Never throws: a script that cannot be built or run is a null receipt. */
export async function runWakeHostScript(
  row: AgentRow,
  target: HivraLifecycleTarget,
  options: { restore: boolean; killStaleSockets?: boolean },
): Promise<WakeScriptRun> {
  const startedAt = Date.now();
  let script: string;
  try {
    script = buildWakeHostScript({
      vmid: target.vmid,
      bindingTag: target.bindingTag,
      admission: buildWakeAdmissionFor(target),
      ...(isFastWakeEnabled("fast_qm") ? { fastConfigRead: true } : {}),
      // A wake that took a Telegram wake row back also drops the guest's dead long polls, so the bot polls again at once.
      ...(options.killStaleSockets === true ? { killStaleSockets: true } : {}),
    });
  } catch {
    return { receipt: null, runError: "script_invalid", ms: Date.now() - startedAt };
  }
  try {
    const result = await runProxmoxHostScript(script, target.env, {
      timeoutMs: options.restore ? RESTORE_SCRIPT_TIMEOUT_MS : WAKE_SCRIPT_TIMEOUT_MS,
      // The receipt is the script's last word, so the answer can come back as
      // soon as its line is complete, without waiting for the session to close.
      ...(isFastWakeEnabled("early_finish") ? { earlyFinishMarker: WAKE_RESULT_PREFIX.trim(), earlyFinishOnLine: true } : {}),
      ...(isFastWakeEnabled("timing") ? { reportTimings: true } : {}),
    });
    // The receipt is read even when the run reports an error: a script that
    // finished its work and then lost its connection still told us the answer.
    const receipt = parseWakeReceipt(result?.stdout ?? "", target.vmid);
    return {
      receipt,
      runError: receipt || result?.ok ? null : "host_script_failed",
      ms: Date.now() - startedAt,
      ...(typeof result?.sshReadyMs === "number" ? { sshReadyMs: result.sshReadyMs } : {}),
    };
  } catch {
    return { receipt: null, runError: "host_script_threw", ms: Date.now() - startedAt };
  }
}

/**
 * Polls https://<hostname>/healthz until it answers. Any code below 500 counts
 * as up, because the gateway may answer 401 and the edge answers 5xx while the
 * tunnel is down.
 */
export async function pollPublicHealthz(
  hostname: unknown,
  options: {
    budgetMs?: number;
    intervalMs?: number;
    /** Poll every 150 ms for the first 3 s, then at the normal interval. */
    fastStart?: boolean;
    fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  } = {},
): Promise<{ up: boolean; ms: number; attempts: number }> {
  const startedAt = Date.now();
  if (typeof hostname !== "string" || !HOSTNAME.test(hostname)) return { up: false, ms: 0, attempts: 0 };
  const budgetMs = options.budgetMs ?? WAKE_HEALTHZ_BUDGET_MS;
  const intervalMs = options.intervalMs ?? HEALTHZ_INTERVAL_MS;
  const fetchImpl = options.fetchImpl ?? ssrfSafeFetch;
  const url = `https://${hostname.toLowerCase()}/healthz`;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.timeout(HEALTHZ_REQUEST_TIMEOUT_MS),
      });
      if (response.status >= 100 && response.status < 500) return { up: true, ms: Date.now() - startedAt, attempts };
    } catch {
      // Not answering yet.
    }
    const elapsed = Date.now() - startedAt;
    const wait = options.fastStart && elapsed < HEALTHZ_FAST_WINDOW_MS ? Math.min(intervalMs, HEALTHZ_FAST_INTERVAL_MS) : intervalMs;
    if (elapsed + wait >= budgetMs) return { up: false, ms: Date.now() - startedAt, attempts };
    await delay(wait);
  }
}

type WakeDetail = Record<string, number | string | boolean | null>;

interface WakeOutcome {
  result: "awake" | "wake_failed";
  reason: string;
  cold: boolean;
  detail: WakeDetail;
}

/** Runs the wake, and puts channel arms it took down (a Telegram webhook, say) back in line when the wake fails. */
async function performWake(row: AgentRow, agentId: string): Promise<WakeOutcome> {
  const channels: { disarm: ChannelDisarms | null } = { disarm: null };
  const outcome = await performWakeSteps(row, agentId, channels);
  if (outcome.result === "wake_failed" && channels.disarm) {
    await rearmChannelsAfterFailedWake(agentId, channels.disarm).catch(() => undefined);
  } else if (outcome.result === "awake" && channels.disarm) {
    await settleChannelsAfterWake(agentId, channels.disarm).catch(() => undefined);
  }
  return outcome;
}

async function performWakeSteps(
  row: AgentRow,
  agentId: string,
  channels: { disarm: ChannelDisarms | null },
): Promise<WakeOutcome> {
  const fromState = String(row.sleep_state);
  // Only a nap is known to be a quick resume. A hibernation, and a wake that
  // failed before (the host may hold either), get the restore protections: a host
  // slot, and the longer script limit a start from saved memory needs.
  const restore = fromState !== "napping";
  const detail: WakeDetail = { from: fromState };
  const failed = (reason: string): WakeOutcome => ({ result: "wake_failed", reason, cold: false, detail });

  let slotTarget: HivraLifecycleTarget | null = null;
  try {
    const resolved = await resolveSleepTarget(row, LOG_SOURCE);
    if (!resolved.ok) return failed(`target_${resolved.code}`);
    const target = resolved.target;

    if (restore) {
      // A restore claims host RAM all at once. Take a slot first, so a crowd of
      // wakes cannot start together. A host that cannot be asked admits the wake.
      const decision = await acquireHostWakeSlot(
        { vmid: target.vmid },
        {
          instanceId: agentId,
          neededRamMb: normalizeWakeRamMb(row.ram),
          runHostScript: (script) => runProxmoxHostScript(script, target.env),
        },
      );
      slotTarget = target;
      if (!decision.admitted) {
        detail.deferred = decision.reason;
        return failed(`capacity_${decision.reason}`);
      }
    }

    // Admitted: take every channel's wake arm down before the computer runs
    // again (a Telegram webhook, so Hermes polls cleanly and finds every queued
    // message). In parallel, each time-boxed; none can stop the wake. A refused
    // wake returned above, and leaves the arms as they are.
    channels.disarm = await disarmChannelsForWake(agentId);
    const tgDisarm = channels.disarm.telegram;
    if (tgDisarm) {
      detail.tg_disarm_ms = tgDisarm.ms;
      detail.tg_disarm_ok = tgDisarm.ok;
    }
    if (channels.disarm.generic.length > 0) {
      detail.ch_disarm_ms = channels.disarm.ms;
      detail.ch_disarm_ok = channels.disarm.generic.every((d) => d.ok);
    }

    // Any socket-based channel that was armed (Telegram's long poll included)
    // means the guest holds dead sockets: drop them, so it reconnects at once.
    const run = await runWakeHostScript(row, target, { restore, ...(channels.disarm.killStaleSockets ? { killStaleSockets: true } : {}) });
    detail.script_ms = run.ms;
    if (run.sshReadyMs !== undefined) detail.ssh_ready_ms = run.sshReadyMs;
    if (!run.receipt) return failed(run.runError ?? "no_receipt");
    for (const [name, ms] of Object.entries(run.receipt.steps)) detail[`${name}_ms`] = ms;
    detail.host_from = run.receipt.from;
    detail.fixup_via = run.receipt.via;
    detail.fixup_tries = run.receipt.tries;
    // The host's own time, so the rest of script_ms reads as transport.
    if (isFastWakeEnabled("timing")) detail.host_ms = run.receipt.ms;

    if (run.receipt.to === "cold") {
      // Nothing saved and the computer is off. The normal start path owns that.
      return { result: "awake", reason: "cold", cold: true, detail };
    }
    if (!run.receipt.ok) return failed(run.receipt.reason);

    const health = await pollPublicHealthz(row.cf_hostname, isFastWakeEnabled("fast_healthz") ? { fastStart: true } : {});
    detail.healthz_ms = health.ms;
    detail.healthz_attempts = health.attempts;
    if (!health.up) return failed("public_healthz_timeout");
    return { result: "awake", reason: run.receipt.reason, cold: false, detail };
  } catch (error) {
    log.error("agent wake failed unexpectedly", error instanceof Error ? error : new Error(String(error)), {
      source: LOG_SOURCE,
      failureType: "agent_wake_unexpected",
      agentId,
    });
    return failed("wake_error");
  } finally {
    if (slotTarget) {
      await releaseHostWakeSlot(
        { vmid: slotTarget.vmid },
        { instanceId: agentId, runHostScript: (script) => runProxmoxHostScript(script, slotTarget!.env) },
      ).catch(() => undefined);
    }
  }
}

/**
 * Hands work to the route's after(), so it runs once the answer is sent.
 * Returns false when it cannot, and the caller then awaits the work itself.
 */
type DeferWork = (work: Promise<unknown>) => boolean;

/** Writes the wake event, with the generation the row has once the lease is given back. */
async function recordWakeEvent(input: {
  agentId: string;
  trigger: AgentSleepEventTrigger;
  fromState: string;
  outcome: WakeOutcome;
  wakeMs: number;
  after?: AgentRow | null;
}): Promise<void> {
  const after = input.after === undefined ? await tryReadRow(input.agentId) : input.after;
  await logAgentSleepEvent({
    agentId: input.agentId,
    kind: input.outcome.result === "awake" ? "wake" : "fail",
    trigger: input.trigger,
    fromState: input.fromState,
    toState: input.outcome.result,
    generation: parseSleepGeneration(after?.sleep_generation),
    durationMs: input.wakeMs,
    reason: input.outcome.reason,
    detail: { ...input.outcome.detail, total_ms: input.wakeMs },
  });
}

/** Runs the wake under a lease this call already holds, and always gives the lease back. */
async function wakeUnderLease(
  row: AgentRow,
  agentId: string,
  operationId: string,
  trigger: AgentSleepEventTrigger,
  deferWork?: DeferWork,
): Promise<EnsureAwakeResult> {
  const startedAt = Date.now();
  const fromState = String(row.sleep_state);
  const outcome = await performWake(row, agentId);
  const wakeMs = Date.now() - startedAt;

  // The lease is always given back before the answer.
  const finished = await finishAgentWake({ agentId, operationId, result: outcome.result });
  let after: AgentRow | null = null;
  if (finished && deferWork) {
    // Only the event still needs the row. Both can wait until the answer is sent.
    const record = recordWakeEvent({ agentId, trigger, fromState, outcome, wakeMs }).catch(() => undefined);
    if (!deferWork(record)) await record;
  } else {
    after = await tryReadRow(agentId);
    await recordWakeEvent({ agentId, trigger, fromState, outcome, wakeMs, after });
  }

  if (!finished) {
    // The lease was not ours any more (the agent was deleted, or a newer
    // operation took over). Report what the row says now, not what we saw.
    log.warn("wake finished but the lease was not released", {
      source: LOG_SOURCE,
      failureType: "agent_wake_finish_not_recorded",
      instanceId: agentId,
    });
    if (after && isAgentAwake(after)) return { state: "awake", wakeMs, reason: outcome.reason };
    return { state: "failed", reason: "finish_not_recorded" };
  }
  if (outcome.result === "wake_failed") return { state: "failed", reason: outcome.reason };
  if (outcome.cold) return { state: "cold", reason: "cold" };
  return { state: "awake", wakeMs, reason: outcome.reason };
}

/**
 * Makes sure this agent is awake. Returns at once when it is, waits when
 * another operation is moving it, and otherwise takes the wake lease and wakes
 * it. `waking` means it is not up yet inside the wait; ask again.
 */
export async function ensureHivraAgentAwake(
  agentId: string,
  options: EnsureAwakeOptions,
): Promise<EnsureAwakeResult> {
  const startedAt = Date.now();
  const waitMs = Math.min(MAX_WAKE_WAIT_MS, Math.max(0, options.waitMs ?? DEFAULT_WAKE_WAIT_MS));
  const deadline = startedAt + waitMs;
  const pollMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;

  let row: AgentRow | null;
  try {
    row = await readHivraAgentRow(agentId);
  } catch {
    return { state: "failed", reason: "agent_unreadable" };
  }
  if (!row) return { state: "failed", reason: "not_found" };
  if (isAgentAwake(row)) return { state: "awake" };

  // A lapsed owner is never woken: the lapse sweep owns that computer now.
  if (await isStartBlockedForLapse(row as { user_id?: unknown }, "start")) {
    return { state: "failed", reason: "lapsed" };
  }

  let operationId = "";
  let settledStuck = false;
  for (;;) {
    if (!row) return { state: "failed", reason: "agent_unreadable" };
    if (isAgentAwake(row)) return { state: "awake" };

    if (TRANSIENT_STATES.includes(String(row.sleep_state))) {
      if (!settledStuck && isStuckTransient(row, Date.now())) {
        // Nobody is working on this row: settle it from the host now rather than waiting for the sweep.
        settledStuck = true;
        try {
          const { reconcileAgentSleep } = await import("./sleep-reconcile");
          await reconcileAgentSleep(row);
        } catch {
          // The sweep settles it; this call falls through to the wait below.
        }
        row = await tryReadRow(agentId);
        continue;
      }
      if (Date.now() >= deadline) return { state: "waking", reason: "still_settling" };
      await delay(pollMs);
      row = await tryReadRow(agentId);
      continue;
    }

    operationId = randomUUID();
    const claim = await claimAgentWake({ agentId, operationId });
    if (claim === "awake") return { state: "awake" };
    if (claim === "refused") return { state: "failed", reason: "wake_refused" };
    if (claim === "claimed") break;
    // busy: another operation holds the agent. Wait for it to let go.
    if (Date.now() >= deadline) return { state: "waking", reason: "busy" };
    await delay(pollMs);
    row = await tryReadRow(agentId);
  }

  // With deferred_log, the wake event is written through the route's after(),
  // but only while this call still answers: once the wait is over the whole
  // wake already runs there, and it simply awaits its own event.
  let answered = false;
  const onBackground = options.onBackground;
  const deferWork: DeferWork | undefined = onBackground && isFastWakeEnabled("deferred_log")
    ? (task) => {
        if (answered) return false;
        onBackground(task);
        return true;
      }
    : undefined;
  const work = wakeUnderLease(row, agentId, operationId, options.trigger, deferWork).catch((error): EnsureAwakeResult => {
    log.error("agent wake threw after its lease was taken", error instanceof Error ? error : new Error(String(error)), {
      source: LOG_SOURCE,
      failureType: "agent_wake_lease_error",
      agentId,
    });
    return { state: "failed", reason: "wake_error" };
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      answered = true;
      resolve("timeout");
    }, Math.max(0, deadline - Date.now()));
  });
  const winner = await Promise.race([work, timedOut]);
  if (timer) clearTimeout(timer);
  if (winner === "timeout") {
    options.onBackground?.(work);
    return { state: "waking", reason: "in_progress" };
  }
  return winner;
}
