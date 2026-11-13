import "server-only";

import { randomUUID } from "node:crypto";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { ACTIVE_STATES } from "@/lib/hermes-move/orchestrator";
import { bankrSkillsDirForType } from "./bankr-skills-seed";
import { coerceSkillIds } from "./template-skills";
import { resolveHivraProxmoxHost } from "./proxmox-target";
import { isStartBlockedForLapse } from "./lapse-gate";
import { isFastWakeEnabled } from "./fast-wake-flags";
import {
  AUTONOMOUS_KINDS,
  DESKTOP_KINDS,
  parseSleepMode,
  type SleepMode,
} from "./agent-sleep-policy";
import {
  claimAgentSleep,
  finishAgentSleep,
  logAgentSleepEvent,
  parseSleepGeneration,
  type AgentSleepEventKind,
  type AgentSleepFinishResult,
  type AgentSleepState,
  type AgentSleepTier,
  type AgentSleepEventTrigger,
} from "./agent-sleep-store";
import {
  buildIdleProbeHostScript,
  buildSleepHostScript,
  idleVerdict,
  parseIdleProbeOutput,
  parseIdleProbeRefusal,
  parseSleepReceipt,
  type IdleVerdict,
  type ObservedSleepState,
  type SleepReceipt,
} from "./agent-sleep-scripts";
import {
  markTelegramPendingArm,
  readTelegramSleepContext,
  telegramCoverageFor,
  telegramWebhookIsClear,
  type TelegramSleepContext,
} from "./telegram-wake/lifecycle";
import {
  readHivraAgentRow,
  resolveSleepTarget,
  runWakeHostScript,
  type AgentRow,
} from "./agent-wake";

/**
 * Put an agent to sleep: nap (pause, RAM stays) or hibernate (RAM saved to
 * disk). Everything here is dark by default: HIVRA_SLEEP_MODE (off unless set),
 * the host's own sleep_mode, and for the sweep the agent's own policy.
 *
 * Fail toward awake. Anything unknown or unreadable means the agent does not
 * sleep, and anything that goes wrong after the lease is taken ends with the
 * lease given back at the state the host reports, or, when the host cannot be
 * read, with the lease left for the sweep to settle from the host. None of it
 * touches hivra_agents.status.
 */

const LOG_SOURCE = "agent-sleep";

export const DEFAULT_NAP_AFTER_SECONDS = 300;
export const DEFAULT_HIBERNATE_AFTER_SECONDS = 900;
/** A job due inside this keeps the agent awake. */
export const SLEEP_JOB_HORIZON_SECONDS = 20 * 60;
/** A scheduled wake is set this long before the job. */
export const SCHEDULED_WAKE_LEAD_SECONDS = 2 * 60;

const PROBE_TIMEOUT_MS = 45_000;
const NAP_SCRIPT_TIMEOUT_MS = 60_000;
const HIBERNATE_SCRIPT_TIMEOUT_MS = 280_000;

function envSeconds(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 30 || parsed > 86_400) return fallback;
  return parsed;
}

export interface SleepTimings {
  /** Idle time before a nap. */
  napAfterSeconds: number;
  /** Time spent napping before a hibernate. */
  hibernateAfterSeconds: number;
  horizonSeconds: number;
}

export function resolveSleepTimings(env: Record<string, string | undefined> = process.env): SleepTimings {
  return {
    napAfterSeconds: envSeconds(env.HIVRA_SLEEP_NAP_AFTER_SECONDS, DEFAULT_NAP_AFTER_SECONDS),
    hibernateAfterSeconds: envSeconds(env.HIVRA_SLEEP_HIBERNATE_AFTER_SECONDS, DEFAULT_HIBERNATE_AFTER_SECONDS),
    horizonSeconds: SLEEP_JOB_HORIZON_SECONDS,
  };
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/** The host row facts eligibility needs. null means the row could not be read. */
export interface SleepHostRow {
  status?: string | null;
  sleep_mode?: string | null;
}

/** Facts read from other tables. null means unknown, and unknown is not eligible. */
export interface SleepFacts {
  activeMove: boolean | null;
  openAttachment: boolean | null;
  ownerLapsed: boolean | null;
}

export interface SleepEligibilityOptions {
  /** A manual test sleep: it skips the owner's policy, but never the server or host switch. */
  manual?: boolean;
  serverMode?: SleepMode;
  tier?: AgentSleepTier;
}

export interface SleepEligibility {
  eligible: boolean;
  reasons: string[];
}

/** What the policy column allows: `off` nothing, t1 naps only, t3 hibernates only, full both. */
function policyAllowsTier(policy: unknown, tier: AgentSleepTier): boolean {
  if (policy === "full") return true;
  if (policy === "t1") return tier === "nap";
  if (policy === "t3") return tier === "hibernate";
  return false;
}

/** Whether the first-boot seeds that need a running guest are done. Pure. */
function seedsPending(row: AgentRow): string[] {
  const reasons: string[] = [];
  if (!row.bootstrapped_at) reasons.push("not_bootstrapped");
  const supportsBoxSkills = Boolean(bankrSkillsDirForType(row.type as string | null));
  if (supportsBoxSkills && !row.bankr_skills_seeded_at) reasons.push("bankr_seed_pending");
  if (supportsBoxSkills && !row.template_skills_seeded_at && coerceSkillIds(row.template_skills).length > 0) {
    reasons.push("template_seed_pending");
  }
  return reasons;
}

/**
 * Whether this agent may be put to sleep at all, and every reason it may not.
 * Pure. The agent's current sleep state and the live idle probe are checked
 * elsewhere; this is only the standing rules.
 */
export function sleepEligibility(
  row: AgentRow,
  host: SleepHostRow | null,
  facts: SleepFacts,
  options: SleepEligibilityOptions = {},
): SleepEligibility {
  const reasons: string[] = [];
  const manual = options.manual === true;

  if (row.status !== "running") reasons.push("not_running");
  if (row.desired_state !== "running") reasons.push("desired_state_not_running");
  if (row.operation_id != null) reasons.push("operation_in_flight");

  if (row.deployment_mode !== "hivra-managed") reasons.push("not_hivra_managed");
  if (row.computer_substrate !== "proxmox-kvm") reasons.push("not_proxmox_kvm");
  if (row.deployment_target_id != null) reasons.push("own_server");
  if (!row.cf_hostname) reasons.push("no_named_tunnel");
  if (!row.vmid) reasons.push("no_computer");
  if (row.infrastructure_binding_token_enforced !== true) reasons.push("binding_not_enforced");

  const kind = typeof row.type === "string" ? row.type : "";
  if (AUTONOMOUS_KINDS.includes(kind) || DESKTOP_KINDS.includes(kind)) reasons.push(`kind_${kind}`);

  if (row.always_on !== false) reasons.push("always_on");
  reasons.push(...seedsPending(row));

  if (facts.activeMove === null) reasons.push("move_unknown");
  else if (facts.activeMove) reasons.push("move_active");
  if (facts.openAttachment === null) reasons.push("attachment_unknown");
  else if (facts.openAttachment) reasons.push("attachment_open");
  if (facts.ownerLapsed === null) reasons.push("lapse_unknown");
  else if (facts.ownerLapsed) reasons.push("owner_lapsed");

  if (!host) reasons.push("host_unknown");
  else {
    if (host.status === "maintenance") reasons.push("host_maintenance");
    else if (host.status !== "active" && host.status !== "draining") reasons.push("host_status_unknown");
    const hostActs = host.sleep_mode === "canary" || host.sleep_mode === "on";
    // The host switch is a hard stop for everything, a manual test sleep included.
    if (!hostActs) reasons.push("host_sleep_mode_off");
  }

  if (!manual) {
    const policy = row.sleep_policy ?? "off";
    if (options.serverMode === "canary" && policy === "off") reasons.push("policy_off");
    else if (policy !== "off" && options.tier && !policyAllowsTier(policy, options.tier)) {
      reasons.push("policy_tier_not_allowed");
    }
  }

  return { eligible: reasons.length === 0, reasons };
}

/** Reads the facts eligibility needs from other tables. A read that fails is unknown. */
export async function readSleepFacts(row: AgentRow): Promise<SleepFacts> {
  const agentId = String(row.id);
  const db = supabaseAdmin;
  const facts: SleepFacts = { activeMove: null, openAttachment: null, ownerLapsed: null };
  if (!db) return facts;
  try {
    const { data, error } = await db
      .from("hermes_computer_moves")
      .select("id")
      .eq("agent_id", agentId)
      .in("state", [...ACTIVE_STATES])
      .limit(1);
    if (!error && Array.isArray(data)) facts.activeMove = data.length > 0;
  } catch {
    // unknown
  }
  // An attachment is open while its row is claimed, and a detach or access change
  // step on it (claimed or dispatched) is open too. Either one keeps the agent
  // awake; if either read fails and neither shows one, it is unknown.
  let attachmentOpen: boolean | null = false;
  try {
    const { data, error } = await db
      .from("hivra_agent_attachments")
      .select("id")
      .eq("source_id", agentId)
      .eq("phase", "claimed")
      .limit(1);
    if (!error && Array.isArray(data)) { if (data.length > 0) attachmentOpen = true; }
    else attachmentOpen = null;
  } catch {
    attachmentOpen = null;
  }
  if (attachmentOpen !== true) {
    try {
      const { data, error } = await db
        .from("hivra_agent_attachment_operations")
        .select("id")
        .eq("source_id", agentId)
        .in("phase", ["claimed", "dispatched"])
        .limit(1);
      if (!error && Array.isArray(data)) { if (data.length > 0) attachmentOpen = true; }
      else attachmentOpen = null;
    } catch {
      attachmentOpen = null;
    }
  }
  facts.openAttachment = attachmentOpen;
  try {
    facts.ownerLapsed = await isStartBlockedForLapse(row as { user_id?: unknown }, "start");
  } catch {
    // unknown
  }
  return facts;
}

/** The host row for this agent, or null when it cannot be read. */
export async function readSleepHostRow(row: AgentRow): Promise<SleepHostRow | null> {
  if (!supabaseAdmin) return null;
  try {
    const hostId = resolveHivraProxmoxHost(typeof row.proxmox_host === "string" ? row.proxmox_host : null);
    const { data, error } = await supabaseAdmin
      .from("proxmox_hosts")
      .select("status, sleep_mode")
      .eq("id", hostId)
      .maybeSingle();
    if (error || !data) return null;
    return data as SleepHostRow;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sleep
// ---------------------------------------------------------------------------

export type SleepOutcomeKind = "slept" | "aborted" | "not_idle" | "ineligible" | "skipped" | "failed";

export interface SleepOutcome {
  outcome: SleepOutcomeKind;
  /** The sleep state the agent is left in, when this call knows it. */
  state?: AgentSleepState;
  reason?: string;
  reasons?: string[];
  /** When the next scheduled job runs, on our clock, when the probe saw one. */
  nextJobAt?: string | null;
  ms?: number;
}

export interface SleepOptions {
  tier: AgentSleepTier;
  trigger: AgentSleepEventTrigger;
  /** A manual test sleep: ignores the open page's own connections. */
  manual?: boolean;
  /** Overrides process.env (tests). */
  env?: Record<string, string | undefined>;
  now?: () => number;
}

/** Reasons a sleep script gives up that are the computer being busy or unsuitable, not a fault. */
const ABORT_REASONS = new Set(["busy", "active", "not_sleepable", "pool_full", "pool_headroom"]);

function stateFromObserved(observed: ObservedSleepState): AgentSleepFinishResult | null {
  if (observed === "awake") return "awake";
  if (observed === "napping") return "napping";
  if (observed === "hibernated") return "hibernated";
  return null;
}

function receiptDetail(receipt: SleepReceipt | null, extra: Record<string, number | string | boolean | null> = {}) {
  const detail: Record<string, number | string | boolean | null> = { ...extra };
  if (receipt) {
    detail.script_ms = receipt.ms;
    for (const [name, ms] of Object.entries(receipt.steps)) detail[`${name}_ms`] = ms;
    detail.host_from = receipt.from;
    detail.host_to = receipt.to;
  }
  return detail;
}

export async function sleepHivraAgent(agentId: string, options: SleepOptions): Promise<SleepOutcome> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const manual = options.manual === true;
  const { tier, trigger } = options;
  const serverMode = parseSleepMode(env.HIVRA_SLEEP_MODE);

  if (serverMode === "off") return { outcome: "skipped", reason: "sleep_mode_off" };
  if (serverMode === "observe") {
    log.info("agent sleep skipped: observe mode only logs", { source: LOG_SOURCE, instanceId: agentId, tier, trigger });
    return { outcome: "skipped", reason: "observe_only" };
  }

  let row: AgentRow | null;
  try {
    row = await readHivraAgentRow(agentId);
  } catch {
    return { outcome: "skipped", reason: "agent_unreadable" };
  }
  if (!row) return { outcome: "ineligible", reason: "not_found", reasons: ["not_found"] };

  const timings = resolveSleepTimings(env);
  const [facts, host] = await Promise.all([readSleepFacts(row), readSleepHostRow(row)]);
  const eligibility = sleepEligibility(row, host, facts, { manual, serverMode, tier });
  if (!eligibility.eligible) {
    return { outcome: "ineligible", reason: eligibility.reasons[0], reasons: eligibility.reasons };
  }

  const state = String(row.sleep_state ?? "awake");
  if (tier === "nap" && state !== "awake") return { outcome: "skipped", reason: "not_awake" };
  if (tier === "hibernate" && state !== "awake" && state !== "napping") return { outcome: "skipped", reason: "not_awake_or_napping" };
  const expectedGeneration = parseSleepGeneration(row.sleep_generation);
  if (expectedGeneration === null) return { outcome: "skipped", reason: "generation_unknown" };

  // A hibernate from a nap would be woken again inside the job horizon: not worth it.
  if (state === "napping" && row.next_wake_at) {
    const wakeAt = Date.parse(String(row.next_wake_at));
    if (!Number.isFinite(wakeAt) || wakeAt - now() <= timings.horizonSeconds * 1000) {
      return { outcome: "not_idle", reason: "job_soon", reasons: ["job_soon"] };
    }
  }

  let target;
  try {
    const resolved = await resolveSleepTarget(row, LOG_SOURCE);
    if (!resolved.ok) return { outcome: "skipped", reason: `target_${resolved.code}` };
    target = resolved.target;
  } catch {
    return { outcome: "skipped", reason: "target_error" };
  }
  if (!target.bindingTag) return { outcome: "ineligible", reason: "binding_not_enforced", reasons: ["binding_not_enforced"] };

  // Telegram wake: read only when the server switch is fully on and the owner
  // opted in. Without it every live channel keeps the agent awake, as before.
  let telegram: TelegramSleepContext | null = null;
  if (state === "awake") {
    try {
      telegram = await readTelegramSleepContext(agentId, host?.sleep_mode ?? null, env);
    } catch {
      telegram = null;
    }
  }
  const verdictOptions = (cores: number, coveredChannels: string[] = []) => ({
    manual,
    nowMs: now(),
    idleWindowS: timings.napAfterSeconds,
    horizonS: timings.horizonSeconds,
    cores,
    ...(coveredChannels.length > 0 ? { coveredChannels } : {}),
  });

  // The live check comes first, before any lease: an agent that is in use is
  // left alone without a trace. A napping agent cannot be probed (its guest is
  // paused); it was idle when it napped and its next job is guarded above.
  let verdict: IdleVerdict | null = null;
  let covered: string[] = [];
  if (state === "awake") {
    try {
      const run = await runProxmoxHostScript(
        buildIdleProbeHostScript({ vmid: target.vmid, bindingTag: target.bindingTag }, telegram ? { telegram: true } : {}),
        target.env,
        { timeoutMs: PROBE_TIMEOUT_MS },
      );
      const probe = parseIdleProbeOutput(run?.stdout ?? "");
      if (!probe) {
        return { outcome: "skipped", reason: parseIdleProbeRefusal(run?.stdout ?? "") ?? "probe_unavailable" };
      }
      covered = telegramCoverageFor(telegram, probe, now());
      verdict = idleVerdict(probe, verdictOptions(probe.cpus, covered));
      if (!verdict.idle) {
        return { outcome: "not_idle", reason: verdict.reasons[0], reasons: verdict.reasons, nextJobAt: verdict.nextJobAt };
      }
    } catch {
      return { outcome: "skipped", reason: "probe_unavailable" };
    }
    // A covered bot must have no webhook before it sleeps: a webhook set by
    // someone else would never be ours to replace, and the agent stays awake.
    if (telegram && covered.length > 0 && !(await telegramWebhookIsClear(telegram).catch(() => false))) {
      return { outcome: "not_idle", reason: "telegram_webhook_set", reasons: ["telegram_webhook_set"] };
    }
  }

  const operationId = randomUUID();
  const generation = await claimAgentSleep({ agentId, operationId, tier, expectedGeneration });
  if (generation === null) return { outcome: "skipped", reason: "claim_refused" };

  // From here the lease is ours. Every path below gives it back.
  const finish = async (result: AgentSleepFinishResult): Promise<boolean> =>
    finishAgentSleep({ agentId, operationId, result });
  const record = async (kind: AgentSleepEventKind, toState: string, reason: string, detail: Record<string, number | string | boolean | null>) => {
    await logAgentSleepEvent({
      agentId,
      kind,
      trigger,
      fromState: state,
      toState,
      generation,
      durationMs: now() - startedAt,
      reason,
      detail: { tier, manual, ...detail },
    });
  };

  // The host's own answer when the script could not tell us: wake it, so it
  // ends up awake, and read the state the wake reports.
  // A script that is still running on the host (the wake script says busy then)
  // will move the computer after this call returns, so no state observed now can
  // be recorded. The lease stays and the sweep settles it from the host once the
  // computer has stopped changing.
  const leaveLease = async (reason: string, recovered: boolean): Promise<SleepOutcome> => {
    await record("fail", "unknown", reason, { recovered });
    log.warn("agent sleep left its lease for the sweep: state unknown", {
      source: LOG_SOURCE,
      failureType: "agent_sleep_state_unknown",
      instanceId: agentId,
      reason,
    });
    return { outcome: "failed", reason, ms: now() - startedAt };
  };
  const recoverByWaking = async (reason: string): Promise<SleepOutcome> => {
    // A hibernation that lost its receipt may be saved to disk: that wake is a restore.
    const run = await runWakeHostScript(row, target, { restore: tier === "hibernate" });
    const busy = run.receipt?.reason === "busy";
    const observed = run.receipt && !busy ? stateFromObserved(run.receipt.to === "cold" ? "awake" : run.receipt.to) : null;
    if (!observed) return leaveLease(reason, false);
    const finished = await finish(observed);
    if (!finished) return leaveLease(reason, false);
    await record("fail", observed, reason, { recovered: true });
    return { outcome: "failed", state: observed, reason, ms: now() - startedAt };
  };

  let receipt: SleepReceipt | null = null;
  try {
    const script = buildSleepHostScript({
      vmid: target.vmid,
      bindingTag: target.bindingTag,
      tier,
      manual,
      ...(isFastWakeEnabled("fast_qm") ? { fastConfigRead: true } : {}),
      ...(telegram && covered.length > 0 && telegram.row.token_fp
        ? { telegramCoverage: { channels: covered, fingerprint: telegram.row.token_fp } }
        : {}),
    });
    const run = await runProxmoxHostScript(script, target.env, {
      timeoutMs: tier === "hibernate" ? HIBERNATE_SCRIPT_TIMEOUT_MS : NAP_SCRIPT_TIMEOUT_MS,
    });
    receipt = parseSleepReceipt(run?.stdout ?? "", target.vmid);
  } catch {
    receipt = null;
  }

  if (!receipt) return recoverByWaking("no_receipt");

  if (!receipt.ok) {
    // Another script holds this computer. What the host shows now is not where it will end up.
    if (receipt.reason === "busy") {
      await record("abort", "unknown", "busy", { ...receiptDetail(receipt), lease_left: true });
      return { outcome: "aborted", reason: "busy", ms: now() - startedAt };
    }
    const observed = stateFromObserved(receipt.to);
    if (!observed) return recoverByWaking(receipt.reason);
    const finishedAbort = await finish(observed);
    if (!finishedAbort) return leaveLease(receipt.reason, false);
    await record(ABORT_REASONS.has(receipt.reason) ? "abort" : "fail", observed, receipt.reason, receiptDetail(receipt));
    return {
      outcome: ABORT_REASONS.has(receipt.reason) ? "aborted" : "failed",
      state: observed,
      reason: receipt.reason,
      ms: now() - startedAt,
    };
  }

  // The script says it slept. Check the probe it carried against the full
  // rules (idle window, load, job horizon); a computer that should not have
  // slept is woken at once.
  // The same Telegram rules as the host gate, on the probe the script itself ran.
  const finalCovered = receipt.probe && covered.length > 0 ? telegramCoverageFor(telegram, receipt.probe, now()) : [];
  const finalVerdict = receipt.probe ? idleVerdict(receipt.probe, verdictOptions(receipt.probe.cpus, finalCovered)) : verdict;
  if (receipt.probe && finalVerdict && !finalVerdict.idle) {
    const woke = await runWakeHostScript(row, target, { restore: tier === "hibernate" });
    const observed = woke.receipt && woke.receipt.reason !== "busy"
      ? stateFromObserved(woke.receipt.to === "cold" ? "awake" : woke.receipt.to)
      : null;
    if (observed === "awake") {
      if (!(await finish("awake"))) return leaveLease("recheck_finish_not_recorded", false);
      await record("abort", "awake", "recheck_not_idle", receiptDetail(receipt, { blockers: finalVerdict.reasons.join(",") }));
      return { outcome: "aborted", state: "awake", reason: "recheck_not_idle", reasons: finalVerdict.reasons, ms: now() - startedAt };
    }
    // It could not be woken. It is asleep as the script said, or unreadable.
    if (!observed) return recoverByWaking("recheck_wake_failed");
  }

  const slept: AgentSleepFinishResult = tier === "nap" ? "napping" : "hibernated";
  const finished = await finish(slept);
  if (!finished) {
    log.warn("agent slept but the lease was not released", {
      source: LOG_SOURCE,
      failureType: "agent_sleep_finish_not_recorded",
      instanceId: agentId,
    });
    await record("fail", slept, "finish_not_recorded", receiptDetail(receipt));
    return { outcome: "failed", reason: "finish_not_recorded", ms: now() - startedAt };
  }
  await record(tier, slept, tier === "nap" ? "napped" : "hibernated", receiptDetail(receipt, finalCovered.length > 0 ? { tg_covered: true } : {}));
  // Asleep with Telegram covered: the sweep sets the wake webhook once the nap is old enough.
  if (finalCovered.length > 0) await markTelegramPendingArm(agentId).catch(() => false);

  // Wake it ahead of its next job.
  let nextJobAt: string | null | undefined;
  if (finalVerdict) {
    nextJobAt = finalVerdict.nextJobAt;
    const wakeAt = nextJobAt ? new Date(Date.parse(nextJobAt) - SCHEDULED_WAKE_LEAD_SECONDS * 1000).toISOString() : null;
    try {
      await supabaseAdmin?.from("hivra_agents").update({ next_wake_at: wakeAt }).eq("id", agentId).eq("sleep_state", slept);
    } catch {
      // The sweep still wakes it on demand; a missed schedule only delays a job.
    }
  }
  return { outcome: "slept", state: slept, nextJobAt, ms: now() - startedAt };
}
