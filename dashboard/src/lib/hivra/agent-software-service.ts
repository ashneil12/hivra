import "server-only";

// Reads an agent's software state from its computer and keeps the stored
// observation current; builds the owner-facing answer the Manage Updates
// section, the agent header and the automatic-update sweep all share. The
// computer's address and bearer are used here and never leave the server.

import { readAgentSoftwareFromBox } from "./agent-cli-meta";
import { saveAgentSoftwareObservation, type StoredAgentSoftware } from "./agent-cli-store";
import {
  agentSoftwareSubject,
  deriveAgentSoftware,
  isAgentSoftwareTarget,
  summarizeAgentSoftware,
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
      reading,
      previous,
      now: new Date(),
    });
  })().finally(() => inFlight.delete(agent.id));
  inFlight.set(agent.id, read);
  return read;
}

/** The agents list's per-agent summary (no computer is read for it). */
export function agentSoftwareSummaryFor(agent: AgentSoftwareAgentRow, record: AgentSoftwareRecord | null, now: number): AgentSoftwareSummary | null {
  const subject = agentSoftwareSubject(agent);
  if (!subject) return null;
  return summarizeAgentSoftware(deriveAgentSoftware({ subject, status: agent.status, record, now }), subject);
}

export type AgentSoftwareResponse =
  | { supported: false }
  | {
      supported: true;
      cli: AgentSoftwareSubject["cli"];
      app: AgentSoftwareSubject["app"];
      view: AgentSoftwareView;
      observedAt: string | null;
      update: { state: AgentCliUpdateState; target: string; reason: string | null; updatedAt: string | null } | null;
      lastRequest: { by: "owner" | "auto"; at: string; target: string; result: AgentCliRequestResult | null } | null;
    };

/** What the owner API answers: public fields only, never the computer's address or bearer. */
export function agentSoftwareResponse(agent: AgentSoftwareAgentRow, record: AgentSoftwareRecord | null, now: number): AgentSoftwareResponse {
  const subject = agentSoftwareSubject(agent);
  if (!subject) return { supported: false };
  const view = deriveAgentSoftware({ subject, status: agent.status, record, now });
  const updateState = record?.update_state as AgentCliUpdateState | null | undefined;
  // Every update's target is the word "latest": Hivra pins no version.
  const isTarget = (value: unknown): value is string => isAgentSoftwareTarget(subject.software, value);
  return {
    supported: true,
    cli: subject.cli,
    app: subject.app,
    view,
    observedAt: record?.observed_at ?? null,
    update: updateState && isTarget(record?.update_target)
      ? { state: updateState, target: record.update_target, reason: record.update_reason ?? null, updatedAt: record.update_updated_at ?? null }
      : null,
    lastRequest: record?.requested_at && isTarget(record.requested_target) && (record.requested_by === "owner" || record.requested_by === "auto")
      ? { by: record.requested_by, at: record.requested_at, target: record.requested_target, result: (record.request_result ?? null) as AgentCliRequestResult | null }
      : null,
  };
}
