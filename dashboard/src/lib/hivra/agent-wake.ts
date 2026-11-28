import "server-only";

import { randomUUID } from "node:crypto";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import { ssrfSafeFetch } from "@/lib/ssrf-safe-fetch";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { resolveProxmoxHostCapacityPolicy } from "@/lib/infrastructure/host-capacity-policy";
import canaryMemoryOvercommitRelease from "../../../provisioner-releases/2026.11.28.2.json";
import { readCanaryMemoryOvercommit } from "./canary-memory-overcommit";
import { acquireHostWakeSlot, normalizeWakeRamMb, releaseHostWakeSlot } from "@/lib/proxmox/wake-admission";
import { resolveHivraLifecycleTarget, type HivraLifecycleTarget } from "./agent-lifecycle-host";
import { sleepMemoryDropAfterDays, STALE_SLEEP_LEASE_MS } from "./agent-sleep-policy";
import { isStartBlockedForLapse } from "./lapse-gate";
import { isCanaryQaHolderSeat, type CanaryQaHolderRow } from "./canary-qa-holder";
import { isCanonicalGitCanaryDeployment } from "./canonical-git-canary";
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
import { isAgentStored, requestAgentUnstore } from "./sleep-storage-state";
import { runAfterResponse } from "./after-response";
import { isWakeMakesRoomEnabled, makeRoomForWake } from "./sleep/wake-make-room";
import {
  disarmChannelsForWake,
  rearmChannelsAfterFailedWake,
  settleChannelsAfterWake,
  type ChannelDisarms,
} from "./channel-wake/lifecycle";
import { loadAgentIngressState, wakeViaIngress, type LoadedIngressState } from "./ingress/wake-client";

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
const HEALTHZ_FAST_REQUEST_TIMEOUT_MS = 1_000;
/** The host script's own bounds: up to 15 s for a sleep that holds the computer, 8 s of guest-agent wait, and for a restore the start itself. A nap wake normally takes about one second. */
const WAKE_SCRIPT_TIMEOUT_MS = 60_000;
const RESTORE_SCRIPT_TIMEOUT_MS = 120_000;
/** A computer booted from its disk (its saved memory was dropped): the script may wait longer for the guest, and so does the health check. */
const COLD_START_SCRIPT_TIMEOUT_MS = 170_000;
export const COLD_START_HEALTHZ_BUDGET_MS = 120_000;
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
  portableOwnerId?: string;
  /** How long this call may wait for a wake, its own or another's. Default 45 s. */
  waitMs?: number;
  /** How often the row is re-read while waiting. Default 1 s. */
  pollIntervalMs?: number;
  /**
   * Gets the wake work when it is still running as the wait ends, so a route can
   * hand it to `after()` and keep the function alive until the wake finishes.
   */
  onBackground?: (work: Promise<unknown>) => void;
  /** Absolute deadline provided by a caller that keeps work alive after its response. */
  workDeadlineMs?: number;
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
const STORAGE_KICK_EVERY_MS = 8_000;
const storageKickAt = new Map<string, number>();
export function resetStorageKicks(): void {
  storageKickAt.clear();
}

/**
 * Someone is waiting for a stored agent. The sleep sweep would start bringing it
 * back, and notice when its disks are back, within a minute each; this does the
 * same piece of work right after the response, so a person watching the page
 * (which asks again every few seconds) waits for the copy and the boot, not for
 * the clock. It packs nothing, and every step it takes is the sweep's own,
 * guarded against running twice.
 */
function kickStorageReturn(agentId: string): void {
  const nowMs = Date.now();
  if ((storageKickAt.get(agentId) ?? 0) > nowMs) return;
  storageKickAt.set(agentId, nowMs + STORAGE_KICK_EVERY_MS);
  if (storageKickAt.size > 500) storageKickAt.clear();
  try {
    runAfterResponse(async () => {
      if (!supabaseAdmin) return;
      const { runSleepStorage } = await import("./sleep-storage");
      await runSleepStorage({
        db: supabaseAdmin,
        // Bringing back only: with the packing setting left out, nothing new is packed.
        env: { ...process.env, HIVRA_SLEEP_STORE_AFTER_DAYS: undefined },
        now: Date.now,
        startBy: nowMs + 20_000,
        deadline: nowMs + 100_000,
        hostActs: async () => false,
        resolveTarget: resolveSleepTarget,
        wake: (id) => ensureHivraAgentAwake(id, { trigger: "schedule", waitMs: 120_000 }),
      });
    }, { source: LOG_SOURCE, failureType: "sleep_storage_kick_failed", instanceId: agentId });
  } catch {
    // Not inside a request (a scheduled run): the sweep itself does this work.
  }
}

export const WAKE_TURN_WAIT_SECONDS = 75;
const WAKE_ADMISSION_TRANSPORT_ALLOWANCE_MS = 5_000;
export const MANAGED_WAKE_WORK_BUDGET_MS = 330_000;
const DEFAULT_RETAINED_WAKE_BUDGET_MS = 180_000;
const WAKE_PHASE_HEADROOM_MS = 15_000;
const WAKE_SETTLE_HEADROOM_MS = 8_000;
/**
 * Deep-sleep wakes a server starts at once. Measured on Canary with two: one wake every 6-7 s and no
 * strain on the server, so ten together did not all fit the wait. The memory check still guards each
 * one. HIVRA_WAKE_MAX_CONCURRENT_PER_HOST sets it; the older shared setting is honoured after it.
 */
export const DEFAULT_WAKES_AT_ONCE_PER_HOST = 4;
export function wakesAtOncePerHost(env: Record<string, string | undefined> = process.env): string {
  for (const raw of [env.HIVRA_WAKE_MAX_CONCURRENT_PER_HOST, env.HERMES_WAKE_MAX_CONCURRENT_PER_HOST]) {
    const n = Number(raw?.trim());
    if (raw?.trim() && Number.isInteger(n) && n >= 1 && n <= 32) return String(n);
  }
  return String(DEFAULT_WAKES_AT_ONCE_PER_HOST);
}

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

/** How many more times a host call is tried when its SSH connection was never made. */
export const HOST_CONNECT_RETRIES = 2;
const HOST_CONNECT_RETRY_MS = 400;

/**
 * Runs a host script, trying again when the connection itself was refused. A server lets only so
 * many SSH logins be in progress at once and drops the rest, which a crowd of wakes can reach (seen
 * on Canary with twelve at once: one wake failed in under a second without reaching the server).
 * Nothing ran in that case, so asking again is safe; the scripts are also safe to repeat.
 */
async function runHostScriptForWake(
  script: string,
  env: HivraLifecycleTarget["env"],
  options?: Parameters<typeof runProxmoxHostScript>[2],
  deadline?: number,
): ReturnType<typeof runProxmoxHostScript> {
  for (let attempt = 0; ; attempt += 1) {
    const remaining = deadline === undefined ? undefined : Math.max(1, Math.floor(deadline - performance.now()));
    const budget = remaining === undefined ? options : typeof options === "object" ? { ...options, timeoutMs: remaining } : remaining;
    const result = budget === undefined ? await runProxmoxHostScript(script, env) : await runProxmoxHostScript(script, env, budget);
    const refused = !!result && !result.ok && result.stage === "connect" && !result.stdout && /^SSH connect/.test(result.error ?? "");
    if (!refused || attempt >= HOST_CONNECT_RETRIES) return result;
    const retryDelay = HOST_CONNECT_RETRY_MS * (attempt + 1) + Math.floor(Math.random() * HOST_CONNECT_RETRY_MS);
    if (deadline !== undefined && performance.now() + retryDelay >= deadline) return result;
    log.warn("host connection for a wake was refused; trying again", {
      source: LOG_SOURCE,
      failureType: "agent_wake_host_connect_refused",
      attempt: attempt + 1,
      reason: (result.error ?? "").slice(0, 160),
    });
    await delay(retryDelay);
    if (deadline !== undefined && performance.now() >= deadline) return result;
  }
}

/** Runs the wake script once. Never throws: a script that cannot be built or run is a null receipt. */
export async function runWakeHostScript(
  row: AgentRow,
  target: HivraLifecycleTarget,
  options: { restore: boolean; killStaleSockets?: boolean; hostIngress?: boolean; deadlineMs?: number },
): Promise<WakeScriptRun> {
  const startedAt = Date.now();
  // With memory drops switched on, a restore may meet a computer whose saved memory was dropped. The host's mark decides.
  const coldStart = options.restore && sleepMemoryDropAfterDays() !== null;
  let script: string;
  try {
    const context = target.executionContext;
    const grant = options.restore && target.vmid !== 9302 && target.bindingTag && context?.kind === "managed"
      && (row.type === "hermes" || row.type === "claude-code")
      && row.seat_funding === "paid" && row.computer_substrate === "proxmox-kvm" && row.deployment_target_id == null
      ? await readCanaryMemoryOvercommit({ host: context.host, ownerId: String(row.user_id), channel: context.provisionerChannel })
      : null;
    const admission = buildWakeAdmissionFor(target);
    if (grant) {
      const helper = canaryMemoryOvercommitRelease.files.find((file) => file.path === "hivra-host-capacity-admission");
      if (!helper) throw new Error("Canary admission helper is not sealed.");
      admission.overcommit = { grant, helperSha256: helper.sha256 };
    }
    const fastQm = isFastWakeEnabled("fast_qm");
    const batchQemuAdmission = !grant && fastQm && options.restore && row.sleep_state === "hibernated"
      && context.kind === "managed" && context.provisionerChannel === "canary"
      && isCanonicalGitCanaryDeployment();
    script = buildWakeHostScript({
      vmid: target.vmid,
      bindingTag: target.bindingTag,
      admission,
      ...(fastQm ? { fastConfigRead: true } : {}),
      ...(batchQemuAdmission ? { batchQemuAdmission: true } : {}),
      // A wake that took a Telegram wake row back also drops the guest's dead long polls, so the bot polls again at once.
      ...(options.killStaleSockets === true ? { killStaleSockets: true } : {}),
      // The host runs this computer's public connector: drop the proxy's nap marker, and never touch the guest's tunnel.
      ...(options.hostIngress === true ? { hostIngress: true } : {}),
      ...(coldStart ? { coldStart: true } : {}),
    });
  } catch {
    return { receipt: null, runError: "script_invalid", ms: Date.now() - startedAt };
  }
  try {
    const timeoutMs = coldStart ? COLD_START_SCRIPT_TIMEOUT_MS : options.restore ? RESTORE_SCRIPT_TIMEOUT_MS : WAKE_SCRIPT_TIMEOUT_MS;
    const remaining = options.deadlineMs === undefined ? timeoutMs : Math.min(timeoutMs, options.deadlineMs - Date.now());
    if (remaining <= 0) return { receipt: null, runError: "wake_deadline", ms: Date.now() - startedAt };
    const result = await runHostScriptForWake(script, target.env, {
      timeoutMs,
      // The receipt is the script's last word, so the answer can come back as
      // soon as its line is complete, without waiting for the session to close.
      ...(isFastWakeEnabled("early_finish") ? { earlyFinishMarker: WAKE_RESULT_PREFIX.trim(), earlyFinishOnLine: true } : {}),
      ...(isFastWakeEnabled("timing") ? { reportTimings: true } : {}),
    }, options.deadlineMs === undefined ? undefined : performance.now() + remaining);
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
    deadlineMs?: number;
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
    const remaining = options.deadlineMs === undefined ? HEALTHZ_REQUEST_TIMEOUT_MS : options.deadlineMs - Date.now();
    if (remaining <= 0) return { up: false, ms: Date.now() - startedAt, attempts };
    const attemptTimeout = options.fastStart && Date.now() - startedAt < HEALTHZ_FAST_WINDOW_MS
      ? HEALTHZ_FAST_REQUEST_TIMEOUT_MS : HEALTHZ_REQUEST_TIMEOUT_MS;
    attempts += 1;
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.timeout(Math.min(remaining, attemptTimeout)),
      });
      if (response.status >= 100 && response.status < 500) return { up: true, ms: Date.now() - startedAt, attempts };
    } catch {
      // Not answering yet.
    }
    const elapsed = Date.now() - startedAt;
    const wait = options.fastStart && elapsed < HEALTHZ_FAST_WINDOW_MS ? Math.min(intervalMs, HEALTHZ_FAST_INTERVAL_MS) : intervalMs;
    if (elapsed + wait >= budgetMs || (options.deadlineMs !== undefined && Date.now() + wait >= options.deadlineMs)) {
      return { up: false, ms: Date.now() - startedAt, attempts };
    }
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
async function performWake(row: AgentRow, agentId: string, workDeadlineMs: number): Promise<WakeOutcome> {
  const channels: { disarm: ChannelDisarms | null } = { disarm: null };
  const outcome = await performWakeSteps(row, agentId, channels, workDeadlineMs);
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
  workDeadlineMs: number,
): Promise<WakeOutcome> {
  const fromState = String(row.sleep_state);
  // Only a nap is known to be a quick resume. A hibernation, and a wake that
  // failed before (the host may hold either), get the restore protections: a host
  // slot, and the longer script limit a start from saved memory needs.
  const restore = fromState !== "napping";
  const mayColdStart = restore && sleepMemoryDropAfterDays() !== null;
  const restoreBudgetMs = mayColdStart ? COLD_START_SCRIPT_TIMEOUT_MS : RESTORE_SCRIPT_TIMEOUT_MS;
  const restoreHealthBudgetMs = mayColdStart ? COLD_START_HEALTHZ_BUDGET_MS : WAKE_HEALTHZ_BUDGET_MS;
  const detail: WakeDetail = { from: fromState };
  const failed = (reason: string): WakeOutcome => ({ result: "wake_failed", reason, cold: false, detail });

  let slotTarget: HivraLifecycleTarget | null = null;
  let slotRelease: Promise<void> | undefined;
  let boundedRestore = false;
  let waitedForConcurrency = false;
  const releaseSlot = (target: HivraLifecycleTarget) => releaseHostWakeSlot(
    { vmid: target.vmid },
    { instanceId: agentId, runHostScript: (script) => runProxmoxHostScript(script, target.env, WAKE_ADMISSION_TRANSPORT_ALLOWANCE_MS) },
  ).catch(() => undefined);
  try {
    const resolved = await resolveSleepTarget(row, LOG_SOURCE);
    if (!resolved.ok) return failed(`target_${resolved.code}`);
    const target = resolved.target;
    // Host ingress (only read when it was ever configured here). A row that
    // cannot be read, or a cutover left half done, gets the ingress wake: it
    // removes the proxy's nap marker (harmless when there is none) and leaves
    // the guest's tunnel alone (it may be the host's, or off); the public
    // health check below says whether the agent answers.
    const ingress: LoadedIngressState = await loadAgentIngressState(agentId, {
      vmid: target.vmid,
      hostId: String(target.executionContext?.host ?? ""),
    });
    const hostIngress = ingress.kind === "error"
      || (ingress.kind === "row" && (ingress.state.hostIngress || ingress.state.interrupted));
    if (hostIngress) detail.host_ingress = true;

    if (restore) {
      // Reserve the existing restore and readiness budgets before waiting for a slot.
      slotTarget = target;
      const waitUntil = Math.min(Date.now() + WAKE_TURN_WAIT_SECONDS * 1000,
        workDeadlineMs - restoreBudgetMs - restoreHealthBudgetMs - WAKE_PHASE_HEADROOM_MS - WAKE_ADMISSION_TRANSPORT_ALLOWANCE_MS);
      const takeTurn = async () => {
        const start = performance.now();
        const waitForConcurrencySeconds = Math.max(0, Math.floor((waitUntil - Date.now()) / 1000));
        boundedRestore ||= waitForConcurrencySeconds > 0;
        const answer = await acquireHostWakeSlot(
          { vmid: target.vmid },
          {
            instanceId: agentId,
            neededRamMb: normalizeWakeRamMb(row.ram),
            env: { ...process.env, HERMES_WAKE_MAX_CONCURRENT_PER_HOST: wakesAtOncePerHost() },
            waitForConcurrencySeconds,
            runHostScript: (script) => waitForConcurrencySeconds > 0
              ? runHostScriptForWake(script, target.env, undefined,
                start + waitForConcurrencySeconds * 1000 + WAKE_ADMISSION_TRANSPORT_ALLOWANCE_MS)
              : runHostScriptForWake(script, target.env),
          },
        );
        waitedForConcurrency ||= answer.waitedForConcurrency === true;
        detail.slot_admission_ms = Number(detail.slot_admission_ms ?? 0) + Math.round(performance.now() - start);
        return answer;
      };
      let decision = await takeTurn();
      // A server short of memory does not clear by waiting. With making room switched on, its
      // longest-idle nappers go into deep sleep until this wake fits; otherwise it is refused at once.
      if (!waitedForConcurrency && !decision.admitted && decision.reason === "host_ram" && isWakeMakesRoomEnabled()) {
        const room = await makeRoomForWake({
          agentId,
          hostId: String(target.executionContext?.host ?? ""),
          fits: async () => {
            decision = await takeTurn();
            return decision.admitted || decision.reason !== "host_ram";
          },
        });
        detail.room_deepened = room.deepened;
        detail.room_ms = room.ms;
      }
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

    // The ticket fast path: a napping computer behind the host's wake proxy is
    // resumed by the proxy itself, which answers once the guest is healthy, so
    // neither SSH nor the public health check is needed. Anything but a good
    // receipt falls back to the SSH wake below. The channel arms are down first.
    if (!restore && ingress.kind === "row" && ingress.state.acts && isFastWakeEnabled("ingress_ticket")) {
      const ticket = await wakeViaIngress({
        agentId,
        vmid: target.vmid,
        hostname: row.cf_hostname,
        tunnelId: row.cf_tunnel_id,
        generation: ingress.state.row.generation,
      });
      detail.ticket_ms = ticket.ms;
      if (ticket.ok) {
        detail.via = "ingress";
        detail.proxy_ms = ticket.receipt.ms;
        detail.cont_ms = ticket.receipt.contMs;
        detail.guest_ms = ticket.receipt.guestMs;
        return { result: "awake", reason: ticket.receipt.woke === "nap" ? "resumed" : "already", cold: false, detail };
      }
      detail.ticket_failed = ticket.reason;
      if (ticket.ok === false && ticket.status !== undefined) detail.ticket_status = ticket.status;
    }

    // Any socket-based channel that was armed (Telegram's long poll included)
    // means the guest holds dead sockets: drop them, so it reconnects at once.
    const runScript = () => runWakeHostScript(row, target, {
      restore,
      ...(boundedRestore ? { deadlineMs: workDeadlineMs - restoreHealthBudgetMs - WAKE_SETTLE_HEADROOM_MS } : {}),
      ...(channels.disarm?.killStaleSockets ? { killStaleSockets: true } : {}),
      ...(hostIngress ? { hostIngress: true } : {}),
    });
    let run = await runScript();
    // The server's own capacity check refused the start (it counts what running and napping
    // computers are promised): make room the same way, and ask the server again after each one.
    if (!waitedForConcurrency && restore && run.receipt && !run.receipt.ok && run.receipt.reason === "capacity" && isWakeMakesRoomEnabled()) {
      const room = await makeRoomForWake({
        agentId,
        hostId: String(target.executionContext?.host ?? ""),
        fits: async () => {
          run = await runScript();
          return !(run.receipt && !run.receipt.ok && run.receipt.reason === "capacity");
        },
      });
      detail.room_deepened = Number(detail.room_deepened ?? 0) + room.deepened;
      detail.room_ms = Number(detail.room_ms ?? 0) + room.ms;
    }
    if (hostIngress) detail.via = "ssh";
    detail.script_ms = run.ms;
    if (run.sshReadyMs !== undefined) detail.ssh_ready_ms = run.sshReadyMs;
    if (!run.receipt) return failed(run.runError ?? "no_receipt");
    for (const [name, ms] of Object.entries(run.receipt.steps)) detail[`${name}_ms`] = ms;
    detail.host_from = run.receipt.from;
    detail.fixup_via = run.receipt.via;
    detail.fixup_tries = run.receipt.tries;
    // The host's own time, so the rest of script_ms reads as transport.
    if (isFastWakeEnabled("timing")) detail.host_ms = run.receipt.ms;

    if (run.receipt.reason === "stored") {
      // Its disks are in the storage box (the record had not caught up). Ask for it back; the sweep wakes it then.
      if (supabaseAdmin) await requestAgentUnstore(supabaseAdmin, agentId).catch(() => false);
      kickStorageReturn(agentId);
      return failed("stored");
    }
    if (!run.receipt.ok && (run.receipt.reason === "capacity_pilot" || run.receipt.reason === "pilot_start_unconfirmed")) {
      return failed(run.receipt.reason);
    }
    if (run.receipt.to === "cold") {
      // Nothing saved and the computer is off. The normal start path owns that.
      return { result: "awake", reason: "cold", cold: true, detail };
    }
    if (!run.receipt.ok) return failed(run.receipt.reason);

    if (slotTarget) slotRelease = releaseSlot(slotTarget);
    const healthBudgetMs = run.receipt.reason === "cold_started" ? COLD_START_HEALTHZ_BUDGET_MS : WAKE_HEALTHZ_BUDGET_MS;
    const health = await pollPublicHealthz(row.cf_hostname, {
      ...(boundedRestore ? { deadlineMs: Math.min(workDeadlineMs - WAKE_SETTLE_HEADROOM_MS, Date.now() + healthBudgetMs) } : {}),
      ...(isFastWakeEnabled("fast_healthz") ? { fastStart: true } : {}),
      // A boot from disk brings the agent's own services up from nothing.
      budgetMs: healthBudgetMs,
    });
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
      await (slotRelease ?? releaseSlot(slotTarget));
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
  workDeadlineMs: number,
  deferWork?: DeferWork,
): Promise<EnsureAwakeResult> {
  const startedAt = Date.now();
  const fromState = String(row.sleep_state);
  const outcome = await performWake(row, agentId, workDeadlineMs);
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
  const workDeadlineMs = Math.min(
    options.workDeadlineMs ?? (options.onBackground ? startedAt + DEFAULT_RETAINED_WAKE_BUDGET_MS : deadline),
    startedAt + MANAGED_WAKE_WORK_BUDGET_MS,
  );
  const pollMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;

  let row: AgentRow | null;
  try {
    row = await readHivraAgentRow(agentId);
  } catch {
    return { state: "failed", reason: "agent_unreadable" };
  }
  if (!row) return { state: "failed", reason: "not_found" };
  const qaSeat = isCanaryQaHolderSeat(row as CanaryQaHolderRow);
  if (!qaSeat && isAgentAwake(row)) return { state: "awake" };

  // A lapsed owner is never woken: the lapse sweep owns that computer now.
  if (await isStartBlockedForLapse(row as { user_id?: unknown }, "start")) {
    return { state: "failed", reason: "lapsed" };
  }
  if (qaSeat && isAgentAwake(row)) return { state: "awake" };

  // Packed into the storage box: its disks come back first, which takes minutes.
  // The request is noted and the sleep sweep does the rest, then wakes it.
  if (isAgentStored(row)) {
    if (supabaseAdmin) await requestAgentUnstore(supabaseAdmin, agentId).catch(() => false);
    kickStorageReturn(agentId);
    return { state: "waking", reason: "restoring_from_storage" };
  }

  let operationId = "";
  let settledStuck = false;
  for (;;) {
    if (!row) return { state: "failed", reason: "agent_unreadable" };
    if (isAgentAwake(row)) return { state: "awake" };
    if (row.operation_kind === "wake" && (await import("./portable-kvm/pilot")).isPortableKvmWakeClaimed(row)) {
      if (!options.portableOwnerId || options.portableOwnerId !== row.user_id) {
        return { state: "waking", reason: "portable_kvm_owner_wake_required" };
      }
      try {
        const { requestManagedPortableKvmOwnerWake, resumeManagedPortableKvmOwnerWake } = await import("./portable-kvm/managed-wake");
        const result = await requestManagedPortableKvmOwnerWake(options.portableOwnerId, row);
        if (result?.state === "waking" && options.onBackground) {
          options.onBackground(resumeManagedPortableKvmOwnerWake({ ownerId: options.portableOwnerId, deadline: workDeadlineMs })
            .catch(() => undefined));
        }
        return result ?? { state: "failed", reason: "portable_kvm_lease_refused" };
      } catch {
        log.error("portable KVM wake request refused", new Error("Portable KVM wake request failed"), {
          source: LOG_SOURCE, failureType: "portable_kvm_wake_request_failed", agentId,
        });
        return { state: "failed", reason: "portable_kvm_step_failed" };
      }
    }

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
  const work = wakeUnderLease(row, agentId, operationId, options.trigger, workDeadlineMs, deferWork).catch((error): EnsureAwakeResult => {
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
