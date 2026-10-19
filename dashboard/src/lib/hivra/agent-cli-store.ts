import "server-only";

// public.hivra_agent_cli_updates: what Hivra last read about an agent's
// Claude Code / Codex version, its update requests and the owner's
// automatic-update choice (migration 20261020120000). Service role only.
//
// Every write here is best effort: a failed write is logged and the caller
// carries on with what it read, so the owner still sees the computer's current
// state even if it couldn't be saved.

import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { logHivraAgentEvent } from "./agent-events";
import {
  isAgentCliUpdateInProgress,
  type AgentCliRequestResult,
  type AgentCliUpdateReport,
  type AgentSoftwareObservation,
  type AgentSoftwareRecord,
  type AgentSoftwareSubject,
} from "./agent-cli-status";
import type { AgentSoftwareReading } from "./agent-cli-meta";

const TABLE = "hivra_agent_cli_updates";
const SOURCE = "hivra/agent-cli-store";
export const AGENT_SOFTWARE_COLUMNS = [
  "agent_id", "user_id", "cli_name", "observation", "installed_version", "tested_version", "hivra_installed_version",
  "update_state", "update_target", "update_reason", "update_updated_at", "observed_at",
  "requested_at", "requested_target", "requested_by", "request_result",
  "auto_update", "auto_update_changed_at", "auto_paused_target", "auto_paused_reason", "updated_at",
].join(",");

export type StoredAgentSoftware = AgentSoftwareRecord & { agent_id: string; user_id: string };

export interface AgentSoftwareAgentRef {
  id: string;
  user_id: string;
  type: string;
}

const TERMINAL = new Set(["done", "rolled_back", "failed", "deferred"]);

function warn(message: string, fields: Record<string, unknown>) {
  log.warn(message, { source: SOURCE, ...fields });
}

/** The stored row for one of the owner's agents, or null (none yet, or unreadable). */
export async function readAgentSoftwareRecord(agentId: string, userId: string): Promise<StoredAgentSoftware | null> {
  if (!supabaseAdmin) return null;
  try {
    const { data, error } = await supabaseAdmin.from(TABLE).select(AGENT_SOFTWARE_COLUMNS)
      .eq("agent_id", agentId).eq("user_id", userId).maybeSingle();
    if (error) {
      warn("agent software record could not be read", { failureType: "hivra_agent_cli_record_read_failed", agentId, error: error.message });
      return null;
    }
    return (data as StoredAgentSoftware | null) ?? null;
  } catch (error) {
    warn("agent software record could not be read", { failureType: "hivra_agent_cli_record_read_failed", agentId, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** Stored rows for many of one owner's agents, keyed by agent id. Empty when unreadable. */
export async function readAgentSoftwareRecords(userId: string, agentIds: string[]): Promise<Map<string, StoredAgentSoftware>> {
  const rows = new Map<string, StoredAgentSoftware>();
  if (!supabaseAdmin || agentIds.length === 0) return rows;
  try {
    const { data, error } = await supabaseAdmin.from(TABLE).select(AGENT_SOFTWARE_COLUMNS)
      .eq("user_id", userId).in("agent_id", agentIds);
    if (error || !Array.isArray(data)) return rows;
    for (const row of data as unknown as StoredAgentSoftware[]) rows.set(row.agent_id, row);
  } catch {
    /* the list shows no tags rather than failing */
  }
  return rows;
}

/**
 * Stored rows for agents the caller already loaded (the automatic-update
 * sweep, across owners), keyed by agent id. A row is used only when it belongs
 * to the agent's own owner. null when the rows couldn't be read: they hold the
 * owners' automatic-update choices, so the sweep must not guess them.
 */
export async function readAgentSoftwareRecordsForAgents(agents: Array<{ id: string; user_id: string }>): Promise<Map<string, StoredAgentSoftware> | null> {
  const rows = new Map<string, StoredAgentSoftware>();
  if (agents.length === 0) return rows;
  if (!supabaseAdmin) return null;
  const owners = new Map(agents.map((agent) => [agent.id, agent.user_id]));
  try {
    const { data, error } = await supabaseAdmin.from(TABLE).select(AGENT_SOFTWARE_COLUMNS).in("agent_id", [...owners.keys()]);
    if (error || !Array.isArray(data)) {
      warn("agent software records could not be read", { failureType: "hivra_agent_cli_records_read_failed", count: owners.size, error: error?.message ?? "no rows" });
      return null;
    }
    for (const row of data as unknown as StoredAgentSoftware[]) {
      if (owners.get(row.agent_id) === row.user_id) rows.set(row.agent_id, row);
    }
  } catch (error) {
    warn("agent software records could not be read", { failureType: "hivra_agent_cli_records_read_failed", count: owners.size, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
  return rows;
}

function observationOf(reading: AgentSoftwareReading): AgentSoftwareObservation {
  if (reading.observation === "reported" && reading.report.version === null) return "version_unreadable";
  return reading.observation;
}

/**
 * Saves what was just read from the computer and returns the record as it now
 * stands. When a Hivra update this row was following has just ended (done,
 * rolled back, failed or deferred for the target it asked for), it records one
 * event for it, and after an automatic update that didn't install it pauses
 * automatic updates for that target. Written with a compare on updated_at, so
 * two readers seeing the same ending record it once.
 *
 * When `previous` is null but another reader saved the first row meanwhile,
 * that row is read and this reading saved over it, so what is returned always
 * carries the owner's stored choices. Throws if that row can't be read.
 */
export async function saveAgentSoftwareObservation(input: {
  agent: AgentSoftwareAgentRef;
  subject: AgentSoftwareSubject;
  tested: string | null;
  reading: AgentSoftwareReading;
  previous: StoredAgentSoftware | null;
  now: Date;
}, attempt = 0): Promise<StoredAgentSoftware> {
  const { agent, subject, tested, reading, previous, now } = input;
  const at = now.toISOString();
  const patch: Record<string, unknown> = {
    cli_name: subject.cli,
    observation: observationOf(reading),
    tested_version: tested,
    observed_at: at,
    updated_at: at,
  };
  let ending: { state: string; target: string; reason: string | null } | null = null;
  if (reading.observation === "reported") {
    const { version, update } = reading.report;
    patch.installed_version = version;
    patch.update_state = update?.state ?? null;
    patch.update_target = update?.target ?? null;
    patch.update_reason = update?.reason ?? null;
    patch.update_updated_at = update?.updatedAt ?? null;
    // A version Hivra put there: its tested version, or the target of its own finished update.
    if (version !== null && (version === tested || (update?.state === "done" && update.target === version))) {
      patch.hivra_installed_version = version;
    }
    const followed = update && previous
      && (previous.requested_target === update.target
        || (previous.update_target === update.target && isAgentCliUpdateInProgress(previous.update_state)));
    const changed = update && !(previous?.update_state === update.state && previous?.update_target === update.target);
    if (update && TERMINAL.has(update.state) && followed && changed) {
      ending = { state: update.state, target: update.target, reason: update.reason };
      const automatic = previous?.requested_by === "auto" && previous.requested_target === update.target;
      if (automatic && (update.state === "rolled_back" || update.state === "failed")) {
        patch.auto_paused_target = update.target;
        patch.auto_paused_reason = update.state;
      }
    }
  }
  const merged = { ...(previous ?? { agent_id: agent.id, user_id: agent.user_id }), ...patch } as StoredAgentSoftware;
  if (!supabaseAdmin) return merged;

  let written = false;
  let duplicate = false;
  try {
    if (previous) {
      let query = supabaseAdmin.from(TABLE).update(patch).eq("agent_id", agent.id).eq("user_id", agent.user_id);
      query = previous.updated_at ? query.eq("updated_at", previous.updated_at) : query;
      const { data, error } = await query.select("agent_id");
      if (error) warn("agent software observation could not be saved", { failureType: "hivra_agent_cli_observation_save_failed", agentId: agent.id, error: error.message });
      written = !error && Array.isArray(data) && data.length === 1;
    } else {
      const { error } = await supabaseAdmin.from(TABLE).insert({ agent_id: agent.id, user_id: agent.user_id, ...patch }).select("agent_id");
      // 23505: the row exists after all (another reader, the owner's choice or
      // an update request saved it first). Save over that row instead of
      // answering without the owner's choices.
      if (error?.code === "23505") duplicate = true;
      else if (error) warn("agent software observation could not be saved", { failureType: "hivra_agent_cli_observation_save_failed", agentId: agent.id, error: error.message });
      written = !error;
    }
  } catch (error) {
    warn("agent software observation could not be saved", { failureType: "hivra_agent_cli_observation_save_failed", agentId: agent.id, error: error instanceof Error ? error.message : String(error) });
  }
  if (duplicate) {
    const current = attempt === 0 ? await readAgentSoftwareRecord(agent.id, agent.user_id) : null;
    if (!current) throw new Error("The agent's stored software record exists but could not be read.");
    return saveAgentSoftwareObservation({ ...input, previous: current }, attempt + 1);
  }

  // Only the writer that saved the change records the update's end.
  if (written && ending) {
    const trigger = previous?.requested_target === ending.target ? previous.requested_by ?? null : null;
    await logHivraAgentEvent({
      userId: agent.user_id,
      event: ending.state === "done" ? "agent_cli_updated" : "agent_cli_update_failed",
      agentId: agent.id,
      agentType: agent.type,
      detail: {
        cli: subject.cli,
        target: ending.target,
        ...(ending.state === "done" ? { from: previous?.installed_version ?? null } : { state: ending.state, reason: ending.reason }),
        trigger,
      },
    });
  }
  return merged;
}

/**
 * How the update_runtime outcome is recorded against the request. An update
 * that ran but whose CLI step can't be confirmed (no report, or a completion
 * another request superseded) counts as unverified, and any other refusal as
 * refused; both hold the 20-hour cooldown, so the sweep never repeats them
 * every run. Only host_not_ready and busy, which clear by themselves, leave it
 * open (claim_hivra_agent_cli_update_request).
 */
export function requestResultOf(outcome: { ok: true; agentCli: AgentCliUpdateReport | null } | { ok: false; code: string }): AgentCliRequestResult {
  if (outcome.ok) return outcome.agentCli ? outcome.agentCli.state : "unverified";
  if (outcome.code === "host_not_ready" || outcome.code === "busy" || outcome.code === "unverified") return outcome.code;
  if (outcome.code === "superseded") return "unverified";
  return "refused";
}

/**
 * Records an update the owner asked for (Update in Manage, or the connection
 * service update, which also moves the CLI), once the lifecycle route has its
 * outcome. Pressing Update is also how an owner resumes automatic updates for
 * a target that failed, so the pause for that target ends. A "current" report
 * is recorded as observed right away.
 */
export async function recordOwnerAgentSoftwareRequest(input: {
  agent: AgentSoftwareAgentRef;
  subject: AgentSoftwareSubject;
  target: string;
  requestedAt: Date;
  result: AgentCliRequestResult;
  report: AgentCliUpdateReport | null;
  previous: StoredAgentSoftware | null;
}): Promise<void> {
  const { agent, subject, target, requestedAt, result, report, previous } = input;
  if (!supabaseAdmin) return;
  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    agent_id: agent.id,
    user_id: agent.user_id,
    cli_name: subject.cli,
    requested_at: requestedAt.toISOString(),
    requested_target: target,
    requested_by: "owner",
    request_result: result,
    updated_at: now,
  };
  if (previous?.auto_paused_target === target && (result === "scheduled" || result === "running" || result === "current")) {
    row.auto_paused_target = null;
    row.auto_paused_reason = null;
  }
  if (report?.state === "current" && report.version === report.target) {
    Object.assign(row, {
      observation: "reported",
      installed_version: report.version,
      hivra_installed_version: report.version,
      tested_version: report.target,
      observed_at: now,
    });
  }
  try {
    const { error } = await supabaseAdmin.from(TABLE).upsert(row, { onConflict: "agent_id" });
    if (error) warn("agent software update request could not be recorded", { failureType: "hivra_agent_cli_request_record_failed", agentId: agent.id, error: error.message });
  } catch (error) {
    warn("agent software update request could not be recorded", { failureType: "hivra_agent_cli_request_record_failed", agentId: agent.id, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Claims the automatic update of this agent to `target`: one claim per target
 * every 20 hours (claim_hivra_agent_cli_update_request). False when another
 * sweep, or an owner, already asked for it.
 */
export async function claimAutomaticAgentSoftwareUpdate(agent: AgentSoftwareAgentRef, subject: AgentSoftwareSubject, target: string): Promise<boolean> {
  if (!supabaseAdmin || !subject.cli) return false;
  const { data, error } = await supabaseAdmin.rpc("claim_hivra_agent_cli_update_request", {
    p_agent_id: agent.id,
    p_user_id: agent.user_id,
    p_cli_name: subject.cli,
    p_target: target,
    p_requested_by: "auto",
  });
  if (error) {
    warn("automatic agent software update could not be claimed", { failureType: "hivra_agent_cli_auto_claim_failed", agentId: agent.id, error: error.message });
    return false;
  }
  return data === true;
}

/** The result of an automatic update this sweep claimed. */
export async function recordAutomaticAgentSoftwareResult(agent: AgentSoftwareAgentRef, target: string, result: AgentCliRequestResult | null, report: AgentCliUpdateReport | null): Promise<void> {
  if (!supabaseAdmin) return;
  const patch: Record<string, unknown> = { request_result: result, updated_at: new Date().toISOString() };
  if (report?.state === "current" && report.version === report.target) {
    Object.assign(patch, { observation: "reported", installed_version: report.version, hivra_installed_version: report.version, tested_version: report.target, observed_at: patch.updated_at });
  }
  try {
    const { error } = await supabaseAdmin.from(TABLE).update(patch)
      .eq("agent_id", agent.id).eq("user_id", agent.user_id).eq("requested_by", "auto").eq("requested_target", target);
    if (error) warn("automatic agent software update result could not be recorded", { failureType: "hivra_agent_cli_auto_result_failed", agentId: agent.id, error: error.message });
  } catch (error) {
    warn("automatic agent software update result could not be recorded", { failureType: "hivra_agent_cli_auto_result_failed", agentId: agent.id, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * The owner's automatic-update choice for this agent. Turning it on also ends
 * a pause after a failed automatic update. Returns false when not saved.
 */
export async function saveAgentSoftwareAutoUpdate(agent: AgentSoftwareAgentRef, subject: AgentSoftwareSubject, enabled: boolean): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const now = new Date().toISOString();
  try {
    const { error } = await supabaseAdmin.from(TABLE).upsert({
      agent_id: agent.id,
      user_id: agent.user_id,
      cli_name: subject.cli,
      auto_update: enabled,
      auto_update_changed_at: now,
      ...(enabled ? { auto_paused_target: null, auto_paused_reason: null } : {}),
      updated_at: now,
    }, { onConflict: "agent_id" });
    if (error) {
      warn("automatic update choice could not be saved", { failureType: "hivra_agent_cli_auto_choice_failed", agentId: agent.id, error: error.message });
      return false;
    }
    return true;
  } catch (error) {
    warn("automatic update choice could not be saved", { failureType: "hivra_agent_cli_auto_choice_failed", agentId: agent.id, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}
