/**
 * Auto-heal LLM transport failures.
 *
 * Blind spot this closes: the existing recovery crons
 * (recover-stuck-instances, recover-unhealthy-active-instances) all key off
 * the gateway `/health` probe. But a box can be perfectly healthy at the
 * HTTP layer while every LLM call inside it hard-fails — the agent's
 * conversation loop retries an upstream provider (Venice/OpenAI/etc.) 3x and
 * surfaces `API call failed after 3 retries: [Errno 32] Broken pipe` to the
 * user. `/health` returns 200 the whole time, so nothing restarts it and the
 * user just sees a dead agent until they complain.
 *
 * Observed 2026-07-07 (instance "Skodari", fixturenodea): Venice's kimi-k2 endpoint
 * transiently overloaded (429 "model is currently overloaded") and dropped
 * streaming connections (ReadError → broken pipe). The literal broken pipe is
 * a write to a keep-alive socket the provider already closed; a gateway
 * restart flushes the stale pool and clears wedged in-flight state (the same
 * remedy the user found by hand, and what the /instances "restart" button
 * does). Venice recovered on its own, but the agent stayed wedged with a dead
 * connection until manually bounced.
 *
 * What this sweep does, every 15 min:
 *   1. Only look at recently-active boxes (last_activity_at within
 *      ACTIVE_WINDOW) — no point SSHing idle agents. Bounded per run.
 *   2. Grep the gateway container's errors.log for a *burst* of
 *      TRANSPORT-class `API call failed after N retries` (broken pipe /
 *      ReadError / connection reset / overloaded / timeout). Billing / auth /
 *      content-policy / rate-limit failures are deliberately excluded — a
 *      restart can't fix those and would just interrupt the user.
 *   3. If a fresh burst is found and we're not in cooldown / haven't already
 *      exhausted our attempts, restart the gateway container and record an
 *      ops_events alert. Cooldown + attempt cap are tracked via ops_events
 *      rows (no migration needed) so a genuine provider outage — where restart
 *      won't help — gets a bounded number of bounces then an "exhausted"
 *      alert for a human, instead of a restart loop.
 *
 * Scoped to the webfree/gateway topology (`agent-<id>-gateway`), whose agent
 * log path is known. Bare `agent-<id>` (legacy webui) boxes are skipped — the
 * DB `backend` column is unreliable (drifts), so we detect topology by which
 * container actually exists rather than trusting the row.
 */

import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { sshExec } from "@/lib/hetzner/ssh";
import { supabaseAdmin } from "@/lib/supabase";
import { getHermesGuestSshTarget } from "@/lib/services/proxmox-infrastructure";

const AUTOHEAL_LLM_LOG_SOURCE = "autoheal-llm-transport-failures";
const RESTART_OPS_SOURCE = "cron.autoheal_llm_transport_restart";
const EXHAUSTED_OPS_SOURCE = "cron.autoheal_llm_transport_exhausted";

// Only scan boxes a user actually touched recently — an idle agent that
// logged a broken pipe an hour ago and hasn't been used since doesn't need a
// restart (nobody's waiting on it, and it'll reconnect fine on next use).
const ACTIVE_WINDOW_MS = 45 * 60 * 1000;
// A failure only counts toward a "burst" if it's this fresh. Matches the
// window a waiting user would still be sitting in front of.
const DETECT_WINDOW_MS = 20 * 60 * 1000;
// Require a real burst, not a single transient blip that the retry loop or a
// user re-send would already have shrugged off.
const BURST_THRESHOLD = 2;
// Never restart the same box more than once per cooldown — a bounce needs time
// to boot (~40s) and for the user to retry before we'd consider bouncing again.
const RESTART_COOLDOWN_MS = 30 * 60 * 1000;
// Rolling window for the attempt cap. If restarts keep being needed across
// this window the provider is likely down (restart can't fix that) — stop and
// page a human instead of looping.
const ATTEMPT_WINDOW_MS = 6 * 60 * 60 * 1000;
const MAX_RESTARTS_PER_WINDOW = 3;
// Per-run caps so a fleet-wide provider wobble can't turn one sweep into
// hundreds of SSH sessions / restarts.
const MAX_SCANS_PER_RUN = 40;
const MAX_RESTARTS_PER_RUN = 6;
// Wall-clock guard: probes are sequential and each can block up to the SSH
// timeout, so stop scanning well before the serverless function ceiling
// (maxDuration) rather than getting SIGTERM'd mid-restart.
const SOFT_BUDGET_MS = 10 * 60 * 1000;

const DETECT_SSH_TIMEOUT_MS = 15_000;
const RESTART_SSH_TIMEOUT_MS = 45_000;

// UUID guard — the id is interpolated into the remote shell command, so we
// require the canonical hermes_instances uuid shape before it ever gets there.
const INSTANCE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Transport-class error signatures (what a restart CAN help). Lowercased.
const TRANSPORT_SIGNATURE_RE =
  "broken pipe|errno 32|readerror|connection reset|connection error|serverdisconnected|peer closed|streaming failed before delivery|timed out|overloaded";
// Signatures a restart CANNOT help — exclude so we never bounce a box for a
// billing / auth / content-policy / quota failure.
const NON_TRANSPORT_EXCLUDE_RE =
  "insufficient|credit|quota|payment|unauthorized|invalid api key|content_filter|usage policies";

interface ActiveInstanceRow {
  id: string;
  user_id: string;
  ipv4_address: string | null;
  proxmox_vmid: number | null;
  proxmox_node: string | null;
  config?: unknown;
  host_id?: string | null;
  gateway_url?: string | null;
  last_activity_at: string | null;
}

export interface AutohealLlmSummary {
  scanned: number;
  burstsDetected: number;
  restartAttempted: number;
  restartFailed: number;
  cooldownSkipped: number;
  exhausted: number;
  probeErrors: number;
}

function emptySummary(): AutohealLlmSummary {
  return {
    scanned: 0,
    burstsDetected: 0,
    restartAttempted: 0,
    restartFailed: 0,
    cooldownSkipped: 0,
    exhausted: 0,
    probeErrors: 0,
  };
}

/**
 * Parse the leading `YYYY-MM-DD HH:MM:SS` of a hermes log line into epoch ms
 * (logs are UTC). Returns null for lines without a parseable prefix.
 */
export function parseLogLineTimestampMs(line: string): number | null {
  const prefix = line.slice(0, 19);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(prefix)) return null;
  const ms = Date.parse(`${prefix.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Count how many of the (already transport-filtered) log lines fall inside the
 * freshness window ending at nowMs. Pure — the SSH grep does the pattern
 * filtering; this only does the time window so it's trivially testable.
 */
export function countRecentTransportFailures(
  logLines: string[],
  nowMs: number,
  windowMs: number = DETECT_WINDOW_MS,
): number {
  const cutoff = nowMs - windowMs;
  let n = 0;
  for (const line of logLines) {
    const ts = parseLogLineTimestampMs(line);
    if (ts != null && ts >= cutoff) n += 1;
  }
  return n;
}

export type RestartDecision = "restart" | "cooldown" | "exhausted";

/**
 * Decide whether to restart given the timestamps (ms) of prior auto-restart
 * ops_events for this instance. Pure so the cooldown/attempt math is testable
 * without a DB.
 */
export function decideRestart(
  priorRestartTimesMs: number[],
  nowMs: number,
): RestartDecision {
  const inCooldown = priorRestartTimesMs.some(
    (t) => nowMs - t < RESTART_COOLDOWN_MS,
  );
  if (inCooldown) return "cooldown";
  const inWindow = priorRestartTimesMs.filter(
    (t) => nowMs - t < ATTEMPT_WINDOW_MS,
  ).length;
  if (inWindow >= MAX_RESTARTS_PER_WINDOW) return "exhausted";
  return "restart";
}

function buildDetectCommand(id: string): string {
  // Only the webfree/gateway topology (agent-<id>-gateway) has this log path.
  // `grep -x` anchors the exact container so we never touch a sibling tenant.
  const container = `agent-${id}-gateway`;
  return [
    `C=$(docker ps --format '{{.Names}}' | grep -xE 'agent-${id}-gateway' | head -n1)`,
    `[ -z "$C" ] && { echo __SKIP__; exit 0; }`,
    `docker exec ${JSON.stringify(container)} sh -c 'grep -aE "API call failed after" ` +
      `/home/hermes/.hermes/logs/errors.log 2>/dev/null ` +
      `| grep -aiE "${TRANSPORT_SIGNATURE_RE}" ` +
      `| grep -aivE "${NON_TRANSPORT_EXCLUDE_RE}" | tail -n 40'`,
  ].join("\n");
}

function buildRestartCommand(id: string): string {
  return `docker restart ${JSON.stringify(`agent-${id}-gateway`)}`;
}

/** Fetch epoch-ms of prior auto-restart alerts for this instance, newest first. */
async function fetchPriorRestartTimesMs(instanceId: string): Promise<number[]> {
  const db = supabaseAdmin;
  if (!db) return [];
  const since = new Date(Date.now() - ATTEMPT_WINDOW_MS).toISOString();
  const { data, error } = await db
    .from("ops_events")
    .select("last_seen_at")
    .eq("source", RESTART_OPS_SOURCE)
    .eq("instance_id", instanceId)
    .gte("last_seen_at", since);
  if (error || !data) return [];
  return data
    .map((r: { last_seen_at: string | null }) =>
      r.last_seen_at ? Date.parse(r.last_seen_at) : NaN,
    )
    .filter((n) => Number.isFinite(n)) as number[];
}

async function probeAndMaybeRestart(
  row: ActiveInstanceRow,
  summary: AutohealLlmSummary,
): Promise<"restarted" | "skipped"> {
  const ip = row.ipv4_address;
  if (!ip || !INSTANCE_ID_RE.test(row.id)) return "skipped";
  const guestTarget = getHermesGuestSshTarget(row);

  // 1. Detect a fresh burst of transport-class LLM failures.
  let detect;
  try {
    detect = await sshExec(ip, buildDetectCommand(row.id), {
      timeoutMs: DETECT_SSH_TIMEOUT_MS,
      ...(guestTarget ? { proxmoxHostConfig: guestTarget } : {}),
    });
  } catch (err) {
    summary.probeErrors += 1;
    log.warn("autoheal-llm detect probe threw", {
      source: AUTOHEAL_LLM_LOG_SOURCE,
      failureType: "autoheal_llm_probe_threw",
      instanceId: row.id,
      userId: row.user_id,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return "skipped";
  }

  if (!detect.ok) {
    summary.probeErrors += 1;
    return "skipped";
  }
  const stdout = detect.stdout ?? "";
  if (stdout.includes("__SKIP__")) return "skipped"; // not a gateway-topology box

  const logLines = stdout.split("\n").filter((l) => l.trim().length > 0);
  const now = Date.now();
  const recent = countRecentTransportFailures(logLines, now);
  if (recent < BURST_THRESHOLD) return "skipped";

  summary.burstsDetected += 1;

  // 2. Cooldown / attempt gate.
  const priorRestarts = await fetchPriorRestartTimesMs(row.id);
  const decision = decideRestart(priorRestarts, now);

  if (decision === "cooldown") {
    summary.cooldownSkipped += 1;
    return "skipped";
  }

  if (decision === "exhausted") {
    summary.exhausted += 1;
    // Page once per attempt-window: restart isn't fixing this (the provider is
    // probably down). Timestamped title → distinct fingerprint per window bucket.
    const bucket = new Date(now).toISOString().slice(0, 13); // hour bucket
    await reportOpsEvent({
      source: EXHAUSTED_OPS_SOURCE,
      severity: "warn",
      title: `autoheal-llm exhausted for ${row.id} @ ${bucket}`,
      message:
        `Gateway ${row.id} still bursting transport-class LLM failures (${recent} in ` +
        `${Math.round(DETECT_WINDOW_MS / 60000)}m) after ${priorRestarts.length} restart(s) in ` +
        `${Math.round(ATTEMPT_WINDOW_MS / 3600000)}h. Auto-restart is not helping — likely an ` +
        `upstream provider outage. Needs eyes.`,
      route: "/api/cron/autoheal-llm-transport-failures",
      userId: row.user_id,
      instanceId: row.id,
      metadata: {
        recent_failures: recent,
        restarts_in_window: priorRestarts.length,
        proxmox_node: row.proxmox_node,
        proxmox_vmid: row.proxmox_vmid,
      },
    });
    return "skipped";
  }

  // 3. Restart the gateway container.
  let restart;
  try {
    restart = await sshExec(ip, buildRestartCommand(row.id), {
      timeoutMs: RESTART_SSH_TIMEOUT_MS,
      ...(guestTarget ? { proxmoxHostConfig: guestTarget } : {}),
    });
  } catch (err) {
    summary.restartFailed += 1;
    log.error("autoheal-llm gateway restart threw", err, {
      source: AUTOHEAL_LLM_LOG_SOURCE,
      failureType: "autoheal_llm_restart_threw",
      instanceId: row.id,
      userId: row.user_id,
    });
    return "skipped";
  }

  if (!restart.ok) {
    summary.restartFailed += 1;
    log.warn("autoheal-llm gateway restart failed", {
      source: AUTOHEAL_LLM_LOG_SOURCE,
      failureType: "autoheal_llm_restart_failed",
      instanceId: row.id,
      userId: row.user_id,
      errorMessage: restart.stderr?.trim() || restart.error?.trim() || null,
    });
    return "skipped";
  }

  summary.restartAttempted += 1;
  // One distinct alert row per restart (timestamped title) so the attempt
  // counter (row count in window) is accurate and the audit trail is legible.
  const stamp = new Date(now).toISOString().slice(0, 16); // minute resolution
  await reportOpsEvent({
    source: RESTART_OPS_SOURCE,
    severity: "warn",
    title: `autoheal-llm restarted gateway ${row.id} @ ${stamp}`,
    message:
      `Restarted gateway container for instance ${row.id} after ${recent} transport-class ` +
      `LLM failures (broken pipe / ReadError / overloaded) in the last ` +
      `${Math.round(DETECT_WINDOW_MS / 60000)}m. Flushes the stale provider connection pool.`,
    route: "/api/cron/autoheal-llm-transport-failures",
    userId: row.user_id,
    instanceId: row.id,
    metadata: {
      recent_failures: recent,
      prior_restarts_in_window: priorRestarts.length,
      proxmox_node: row.proxmox_node,
      proxmox_vmid: row.proxmox_vmid,
    },
  });
  log.info("autoheal-llm restarted gateway", {
    source: AUTOHEAL_LLM_LOG_SOURCE,
    instanceId: row.id,
    userId: row.user_id,
    recentFailures: recent,
    priorRestartsInWindow: priorRestarts.length,
  });
  return "restarted";
}

export async function runAutohealLlmTransportFailuresSweep(): Promise<AutohealLlmSummary> {
  const summary = emptySummary();
  const db = supabaseAdmin;
  if (!db) {
    log.error(
      "supabaseAdmin not configured; skipping autoheal-llm sweep",
      new Error("supabaseAdmin missing"),
      { source: AUTOHEAL_LLM_LOG_SOURCE },
    );
    return summary;
  }

  const activeSince = new Date(Date.now() - ACTIVE_WINDOW_MS).toISOString();
  const { data, error } = await db
    .from("hermes_instances")
    .select(
      "id, user_id, ipv4_address, proxmox_vmid, proxmox_node, config, host_id, gateway_url, last_activity_at",
    )
    .eq("lifecycle_state", "active")
    .eq("status", "running")
    .is("deleted_at", null)
    .is("scheduled_deletion_at", null)
    .not("ipv4_address", "is", null)
    .not("proxmox_vmid", "is", null)
    .gte("last_activity_at", activeSince)
    .order("last_activity_at", { ascending: false })
    .limit(MAX_SCANS_PER_RUN);

  if (error) {
    log.error("autoheal-llm active-instance query failed", error, {
      source: AUTOHEAL_LLM_LOG_SOURCE,
      failureType: "autoheal_llm_query_failed",
    });
    summary.probeErrors += 1;
    return summary;
  }

  const rows = (data as ActiveInstanceRow[] | null) ?? [];
  const startedAt = Date.now();

  for (const row of rows) {
    if (summary.restartAttempted >= MAX_RESTARTS_PER_RUN) break;
    if (Date.now() - startedAt > SOFT_BUDGET_MS) {
      log.warn("autoheal-llm hit soft time budget; ending scan early", {
        source: AUTOHEAL_LLM_LOG_SOURCE,
        scanned: summary.scanned,
        totalCandidates: rows.length,
      });
      break;
    }
    summary.scanned += 1;
    try {
      await probeAndMaybeRestart(row, summary);
    } catch (err) {
      summary.probeErrors += 1;
      log.error("autoheal-llm row failed", err, {
        source: AUTOHEAL_LLM_LOG_SOURCE,
        failureType: "autoheal_llm_row_failed",
        instanceId: row.id,
        userId: row.user_id,
      });
    }
  }

  if (
    summary.burstsDetected > 0 ||
    summary.restartAttempted > 0 ||
    summary.exhausted > 0 ||
    summary.probeErrors > 0
  ) {
    log.info("autoheal-llm sweep complete", {
      source: AUTOHEAL_LLM_LOG_SOURCE,
      ...summary,
    });
  }

  return summary;
}
