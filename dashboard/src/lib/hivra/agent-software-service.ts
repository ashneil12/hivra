import "server-only";

// Reads an agent's software state from its computer and keeps the stored
// observation current; builds the owner-facing answer the Manage Updates
// section, the agent header and the automatic-update sweep all share. The
// computer's address and bearer are used here and never leave the server.

import { AGENT_CLI_VERSIONS } from "@/lib/infrastructure/portable-provisioner-contract";
import { readAgentSoftwareFromBox } from "./agent-cli-meta";
import { saveAgentSoftwareObservation, type StoredAgentSoftware } from "./agent-cli-store";
import {
  agentCliAutoUpdateMode,
  agentSoftwareSubject,
  deriveAgentSoftware,
  effectiveAgentCliAutoUpdate,
  isAgentCliVersion,
  summarizeAgentSoftware,
  type AgentCliAutoUpdateMode,
  type AgentCliRequestResult,
  type AgentCliUpdateState,
  type AgentSoftwareRecord,
  type AgentSoftwareSubject,
  type AgentSoftwareSummary,
  type AgentSoftwareView,
} from "./agent-cli-status";

/** A stored observation older than this is read again when an owner looks. */
export const AGENT_SOFTWARE_STALE_MS = 10 * 60_000;

/** The hivra_agents fields this reads. */
export interface AgentSoftwareAgentRow {
  id: string;
  user_id: string;
  type: string;
  status: string;
  deployment_mode?: unknown;
  computer_profile?: unknown;
  computer_substrate?: unknown;
  chat_url?: unknown;
  cf_hostname?: unknown;
  api_token?: unknown;
}

export function testedVersionFor(subject: AgentSoftwareSubject): string | null {
  return subject.cli ? AGENT_CLI_VERSIONS[subject.cli] : null;
}

/** The rollout switch for automatic updates (unset means off). */
export function configuredAgentCliAutoUpdateMode(env: Record<string, string | undefined> = process.env): AgentCliAutoUpdateMode {
  return agentCliAutoUpdateMode(env.HIVRA_AGENT_CLI_AUTO_UPDATE);
}

export function isAgentSoftwareStale(record: AgentSoftwareRecord | null, now: number): boolean {
  const observed = record?.observed_at ? Date.parse(record.observed_at) : NaN;
  return !Number.isFinite(observed) || now - observed > AGENT_SOFTWARE_STALE_MS;
}

// One read of a computer at a time per server process: the header, the
// Updates section and a second tab asking together share it.
const inFlight = new Map<string, Promise<StoredAgentSoftware>>();

/**
 * Reads the agent's computer now and saves what it said. Only for a running
 * agent Hivra covers (agentSoftwareSubject); the caller checks both.
 */
export function observeAgentSoftware(agent: AgentSoftwareAgentRow, subject: AgentSoftwareSubject, previous: StoredAgentSoftware | null): Promise<StoredAgentSoftware> {
  const running = inFlight.get(agent.id);
  if (running) return running;
  const read = (async () => {
    const reading = await readAgentSoftwareFromBox({
      chatUrl: agent.chat_url,
      cfHostname: agent.cf_hostname,
      apiToken: agent.api_token,
      subject,
    });
    return saveAgentSoftwareObservation({
      agent: { id: agent.id, user_id: agent.user_id, type: agent.type },
      subject,
      tested: testedVersionFor(subject),
      reading,
      previous,
      now: new Date(),
    });
  })().finally(() => inFlight.delete(agent.id));
  inFlight.set(agent.id, read);
  return read;
}

export function agentSoftwareViewFor(agent: AgentSoftwareAgentRow, record: AgentSoftwareRecord | null, now: number): AgentSoftwareView | null {
  const subject = agentSoftwareSubject(agent);
  if (!subject) return null;
  return deriveAgentSoftware({ subject, status: agent.status, tested: testedVersionFor(subject), record, now });
}

/** The agents list's per-agent summary (no computer is read for it). */
export function agentSoftwareSummaryFor(agent: AgentSoftwareAgentRow, record: AgentSoftwareRecord | null, now: number): AgentSoftwareSummary | null {
  const subject = agentSoftwareSubject(agent);
  if (!subject) return null;
  const tested = testedVersionFor(subject);
  return summarizeAgentSoftware(deriveAgentSoftware({ subject, status: agent.status, tested, record, now }), subject, tested);
}

export type AgentSoftwareResponse =
  | { supported: false }
  | {
      supported: true;
      cli: AgentSoftwareSubject["cli"];
      view: AgentSoftwareView;
      tested: string | null;
      observedAt: string | null;
      update: { state: AgentCliUpdateState; target: string; reason: string | null; updatedAt: string | null } | null;
      lastRequest: { by: "owner" | "auto"; at: string; target: string; result: AgentCliRequestResult | null } | null;
      /** Absent for agents without a CLI Hivra updates. */
      autoUpdate: {
        mode: AgentCliAutoUpdateMode;
        enabled: boolean;
        source: "default" | "owner";
        pausedFor: { target: string; reason: "rolled_back" | "failed" } | null;
      } | null;
    };

/** What the owner API answers: public fields only, never the computer's address or bearer. */
export function agentSoftwareResponse(agent: AgentSoftwareAgentRow, record: AgentSoftwareRecord | null, mode: AgentCliAutoUpdateMode, now: number): AgentSoftwareResponse {
  const subject = agentSoftwareSubject(agent);
  if (!subject) return { supported: false };
  const tested = testedVersionFor(subject);
  const view = deriveAgentSoftware({ subject, status: agent.status, tested, record, now });
  const auto = effectiveAgentCliAutoUpdate(record, agent.deployment_mode);
  const updateState = record?.update_state as AgentCliUpdateState | null | undefined;
  return {
    supported: true,
    cli: subject.cli,
    view,
    tested,
    observedAt: record?.observed_at ?? null,
    update: updateState && isAgentCliVersion(record?.update_target)
      ? { state: updateState, target: record.update_target, reason: record.update_reason ?? null, updatedAt: record.update_updated_at ?? null }
      : null,
    lastRequest: record?.requested_at && isAgentCliVersion(record.requested_target) && (record.requested_by === "owner" || record.requested_by === "auto")
      ? { by: record.requested_by, at: record.requested_at, target: record.requested_target, result: (record.request_result ?? null) as AgentCliRequestResult | null }
      : null,
    autoUpdate: subject.cli
      ? {
          mode,
          enabled: auto.enabled,
          source: auto.source,
          pausedFor: isAgentCliVersion(record?.auto_paused_target) && (record.auto_paused_reason === "rolled_back" || record.auto_paused_reason === "failed")
            ? { target: record.auto_paused_target, reason: record.auto_paused_reason }
            : null,
        }
      : null,
  };
}
