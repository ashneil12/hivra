import "server-only";

// Automatic Claude Code / Codex updates (the update-hivra-agent-clis cron).
//
// Rollout switch HIVRA_AGENT_CLI_AUTO_UPDATE: off (the default, also when
// unset) returns at once without reading anything; preview reads the agents
// and reports which it would update; on updates them.
//
// Each run reads up to 40 running Claude Code / Codex agents on Proxmox whose
// automatic updates are on (the ones read longest ago first; an agent whose
// owner turned them off, or on My server by default, is never read here). It
// then updates at most 5, one per host, and only when every one of these
// holds:
//   - the owner's choice, or Hivra's default (on for Hivra Cloud, off on the
//     owner's own server), is on;
//   - the computer reported its version (an older connection service waits
//     for its owner's first update), which is behind Hivra's tested version,
//     or ahead only because Hivra lowered its tested version after installing
//     it: an owner's own newer install is never touched;
//   - that target isn't paused after an automatic update to it failed;
//   - no reply is being written, no agent terminal is attached, and nothing
//     was used for 30 minutes (anything unreadable counts as in use);
//   - the claim for this target succeeds: one per target every 20 hours.
// The update is the owner's own path (runHivraAgentRuntimeUpdate): the same
// host checks, operation lease and receipt. On the computer the swap still
// waits for replies to finish and puts the previous version back if the new
// one doesn't install. Skips are counted here, never written as events.

import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import { AGENT_CLI_VERSIONS } from "@/lib/infrastructure/portable-provisioner-contract";
import {
  agentCliAutoUpdateGate,
  agentSoftwareSubject,
  deriveAgentSoftware,
  effectiveAgentCliAutoUpdate,
  type AgentCliAutoUpdateMode,
} from "./agent-cli-status";
import { readAgentIdleEvidence } from "./agent-cli-meta";
import {
  claimAutomaticAgentSoftwareUpdate,
  readAgentSoftwareRecordsForAgents,
  type StoredAgentSoftware,
} from "./agent-cli-store";
import { configuredAgentCliAutoUpdateMode, observeAgentSoftware, type AgentSoftwareAgentRow } from "./agent-software-service";
import { runHivraAgentRuntimeUpdate } from "./agent-runtime-update";

const SOURCE = "cron/update-hivra-agent-clis";
const CANDIDATE_SCAN_LIMIT = 500;
export const AUTO_UPDATE_READS_PER_RUN = 40;
export const AUTO_UPDATE_UPDATES_PER_RUN = 5;
const READ_CONCURRENCY = 4;
/** No new computer read after this. */
const READ_BUDGET_MS = 150_000;
/** No update starts after this, so its 240 s host deadline ends inside the function's 300 s. */
const UPDATE_START_BUDGET_MS = 45_000;
export const AUTO_UPDATE_IDLE_MS = 30 * 60_000;

type Row = AgentSoftwareAgentRow & Record<string, unknown>;

export type AutoUpdateSkip =
  | "not_supported"
  | "disabled"
  | "not_reported"
  | "not_behind"
  | "owner_version"
  | "updating"
  | "paused"
  | "busy"
  | "activity_unreadable"
  | "reply_in_progress"
  | "terminal_attached"
  | "recently_used"
  | "cooldown"
  | "run_limit"
  | "host_limit"
  | "out_of_time"
  | "host_not_ready";

export interface AgentCliAutoUpdateResult {
  agentId: string;
  action: "updated" | "would_update" | "skipped" | "failed";
  reason?: AutoUpdateSkip | string;
  target?: string;
}

export interface AgentCliAutoUpdateSummary {
  mode: AgentCliAutoUpdateMode;
  dryRun: boolean;
  scanned: number;
  observed: number;
  updated: number;
  wouldUpdate: number;
  failed: number;
  skipped: Partial<Record<AutoUpdateSkip, number>>;
  results: AgentCliAutoUpdateResult[];
}

export interface AgentCliAutoUpdateOptions {
  /** Report only, even when the switch is on (?dryRun=1). */
  dryRun?: boolean;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

function hostKey(row: Row): string {
  const target = typeof row.deployment_target_id === "string" && row.deployment_target_id ? row.deployment_target_id : null;
  return target ? `target:${target}` : `host:${String(row.proxmox_host ?? "")}`;
}

async function inPool<T>(items: T[], concurrency: number, work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item);
  }));
}

/** When the agent-run reporter last saw this agent work, per agent; null when unreadable. */
async function lastReportedActivity(agentIds: string[]): Promise<Map<string, number> | null> {
  const seen = new Map<string, number>();
  if (!supabaseAdmin || agentIds.length === 0) return seen;
  const { data, error } = await supabaseAdmin.from("hivra_activity_collectors").select("agent_id, last_event_at").in("agent_id", agentIds);
  if (error || !Array.isArray(data)) return null;
  for (const row of data as Array<{ agent_id?: unknown; last_event_at?: unknown }>) {
    const at = typeof row.last_event_at === "string" ? Date.parse(row.last_event_at) : NaN;
    if (typeof row.agent_id === "string" && Number.isFinite(at)) seen.set(row.agent_id, at);
  }
  return seen;
}

export async function runAgentCliAutoUpdateSweep(options: AgentCliAutoUpdateOptions = {}): Promise<AgentCliAutoUpdateSummary> {
  const mode = configuredAgentCliAutoUpdateMode(options.env ?? process.env);
  const now = options.now ?? Date.now;
  const started = now();
  const dryRun = mode !== "on" || options.dryRun === true;
  const summary: AgentCliAutoUpdateSummary = {
    mode, dryRun, scanned: 0, observed: 0, updated: 0, wouldUpdate: 0, failed: 0, skipped: {}, results: [],
  };
  const skip = (agentId: string, reason: AutoUpdateSkip, target?: string) => {
    summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1;
    summary.results.push({ agentId, action: "skipped", reason, ...(target ? { target } : {}) });
  };
  if (mode === "off") return summary;
  if (!supabaseAdmin) {
    log.error("supabase admin client unavailable; cannot update agent software", new Error("supabaseAdmin missing"), {
      source: SOURCE, failureType: "supabase_admin_unavailable",
    });
    return summary;
  }

  const { data, error } = await supabaseAdmin
    .from("hivra_agents")
    .select("*")
    .eq("status", "running")
    .in("type", ["claude-code", "codex"])
    .is("computer_profile", null)
    .is("operation_id", null)
    .not("chat_url", "is", null)
    .or("computer_substrate.is.null,computer_substrate.eq.proxmox-kvm")
    .order("created_at", { ascending: true })
    .limit(CANDIDATE_SCAN_LIMIT);
  if (error) {
    log.error("failed to load agent software update candidates", error, { source: SOURCE, failureType: "agent_cli_candidate_query_failed" });
    return summary;
  }
  const rows = ((data ?? []) as Row[]).filter((row) => agentSoftwareSubject(row)?.cli);
  const stored = await readAgentSoftwareRecordsForAgents(rows);
  // Only agents whose automatic updates are on are read; the others are just counted.
  const enabled = rows.filter((row) => effectiveAgentCliAutoUpdate(stored.get(row.id) ?? null, row.deployment_mode).enabled);
  const disabled = rows.length - enabled.length;
  if (disabled > 0) summary.skipped.disabled = disabled;
  // The ones read longest ago (or never) first.
  const observedAt = (row: Row) => {
    const at = Date.parse(stored.get(row.id)?.observed_at ?? "");
    return Number.isFinite(at) ? at : 0;
  };
  const candidates = enabled.sort((a, b) => observedAt(a) - observedAt(b)).slice(0, AUTO_UPDATE_READS_PER_RUN);
  summary.scanned = candidates.length;

  // Phase 1: read every candidate's computer and decide from what it said.
  const eligible: Array<{ row: Row; record: StoredAgentSoftware; target: string }> = [];
  await inPool(candidates, READ_CONCURRENCY, async (row) => {
    const subject = agentSoftwareSubject(row);
    if (!subject?.cli) { skip(row.id, "not_supported"); return; }
    if (now() - started > READ_BUDGET_MS) { skip(row.id, "out_of_time"); return; }
    const target = AGENT_CLI_VERSIONS[subject.cli];
    let record: StoredAgentSoftware;
    try {
      record = await observeAgentSoftware(row, subject, stored.get(row.id) ?? null);
      summary.observed += 1;
    } catch (readError) {
      summary.failed += 1;
      summary.results.push({ agentId: row.id, action: "failed", reason: "observe_failed" });
      log.warn("agent software could not be observed", { source: SOURCE, failureType: "agent_cli_observe_failed", agentId: row.id, error: readError instanceof Error ? readError.message : String(readError) });
      return;
    }
    if (!effectiveAgentCliAutoUpdate(record, row.deployment_mode).enabled) { skip(row.id, "disabled"); return; }
    const view = deriveAgentSoftware({ subject, status: row.status, tested: target, record, now: now() });
    const gate = agentCliAutoUpdateGate(view, record, target);
    if (!gate.ok) { skip(row.id, gate.skip, target); return; }
    eligible.push({ row, record, target });
  });

  // Phase 2: at most 5 updates, one per host, each only while its agent is idle.
  const recentActivity = await lastReportedActivity(eligible.map((entry) => entry.row.id));
  const hosts = new Set<string>();
  const chosen: typeof eligible = [];
  for (const entry of eligible) {
    if (chosen.length >= AUTO_UPDATE_UPDATES_PER_RUN) { skip(entry.row.id, "run_limit", entry.target); continue; }
    const host = hostKey(entry.row);
    if (hosts.has(host)) { skip(entry.row.id, "host_limit", entry.target); continue; }
    hosts.add(host);
    chosen.push(entry);
  }
  await Promise.all(chosen.map(async ({ row, target }) => {
    if (now() - started > UPDATE_START_BUDGET_MS) { skip(row.id, "out_of_time", target); return; }
    if (!recentActivity) { skip(row.id, "activity_unreadable", target); return; }
    const reported = recentActivity.get(row.id);
    if (reported !== undefined && now() - reported < AUTO_UPDATE_IDLE_MS) { skip(row.id, "recently_used", target); return; }
    const idle = await readAgentIdleEvidence({ chatUrl: row.chat_url, cfHostname: row.cf_hostname, apiToken: row.api_token });
    if (!idle) { skip(row.id, "activity_unreadable", target); return; }
    if (idle.runningReplies > 0) { skip(row.id, "reply_in_progress", target); return; }
    if (idle.terminalAttached) { skip(row.id, "terminal_attached", target); return; }
    if (idle.lastReplyActivityAt !== null && now() - idle.lastReplyActivityAt < AUTO_UPDATE_IDLE_MS) { skip(row.id, "recently_used", target); return; }
    if (dryRun) {
      summary.wouldUpdate += 1;
      summary.results.push({ agentId: row.id, action: "would_update", target });
      return;
    }
    const subject = agentSoftwareSubject(row);
    if (!subject?.cli) { skip(row.id, "not_supported"); return; }
    if (!await claimAutomaticAgentSoftwareUpdate({ id: row.id, user_id: row.user_id, type: row.type }, subject, target)) {
      skip(row.id, "cooldown", target);
      return;
    }
    try {
      const outcome = await runHivraAgentRuntimeUpdate({ userId: row.user_id, agent: row, trigger: "auto", source: SOURCE });
      if (outcome.ok) {
        summary.updated += 1;
        summary.results.push({ agentId: row.id, action: "updated", target, ...(outcome.agentCli ? { reason: outcome.agentCli.state } : {}) });
      } else if (outcome.code === "host_not_ready") {
        // The host hasn't taken this release yet; nothing changed and nothing pauses.
        skip(row.id, "host_not_ready", target);
      } else if (outcome.code === "busy") {
        skip(row.id, "busy", target);
      } else {
        summary.failed += 1;
        summary.results.push({ agentId: row.id, action: "failed", reason: outcome.code, target });
        log.warn("automatic agent software update did not run", { source: SOURCE, failureType: "agent_cli_auto_update_failed", agentId: row.id, code: outcome.code, status: outcome.status });
      }
    } catch (updateError) {
      summary.failed += 1;
      summary.results.push({ agentId: row.id, action: "failed", reason: "error", target });
      log.error("automatic agent software update threw", updateError instanceof Error ? updateError : new Error(String(updateError)), {
        source: SOURCE, failureType: "agent_cli_auto_update_threw", agentId: row.id,
      });
    }
  }));
  return summary;
}
