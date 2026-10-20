"use client";

// Client for GET/PATCH /api/hivra/agents/[id]/agent-software: an agent's
// Claude Code / Codex version, or Aeon / OpenClaw / Agent Zero app version,
// next to Hivra's tested version, its update state, and the owner's
// automatic-update choice (CLIs only). The server reads the
// computer; nothing here talks to it directly.

import type {
  AgentAppName,
  AgentCliAutoUpdateMode,
  AgentCliName,
  AgentCliRequestResult,
  AgentCliUpdateState,
  AgentSoftwareView,
} from "./agent-cli-status";

export interface AgentSoftwareAutoUpdate {
  mode: AgentCliAutoUpdateMode;
  enabled: boolean;
  source: "default" | "owner";
  pausedFor: { target: string; reason: "rolled_back" | "failed" } | null;
}

export type AgentSoftwareState =
  | { supported: false }
  | {
      supported: true;
      cli: AgentCliName | null;
      app: AgentAppName | null;
      view: AgentSoftwareView;
      tested: string | null;
      observedAt: string | null;
      update: { state: AgentCliUpdateState; target: string; reason: string | null; updatedAt: string | null } | null;
      lastRequest: { by: "owner" | "auto"; at: string; target: string; result: AgentCliRequestResult | null } | null;
      autoUpdate: AgentSoftwareAutoUpdate | null;
    };

export class AgentSoftwareApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "AgentSoftwareApiError";
  }
}

function isState(value: unknown): value is AgentSoftwareState {
  if (!value || typeof value !== "object") return false;
  const state = value as { supported?: unknown; view?: unknown };
  if (state.supported === false) return true;
  return state.supported === true && Boolean(state.view) && typeof (state.view as { kind?: unknown }).kind === "string";
}

async function stateFrom(response: Response): Promise<AgentSoftwareState> {
  let body: { success?: unknown; data?: unknown; error?: unknown } | null = null;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok || !body || body.success !== true || !isState(body.data)) {
    throw new AgentSoftwareApiError(typeof body?.error === "string" ? body.error : "Couldn't check this agent's software.", response.status);
  }
  return body.data;
}

/** The stored reading, or (live) a fresh read of the agent's computer. */
export async function getAgentSoftware(id: string, options: { live?: boolean; signal?: AbortSignal } = {}): Promise<AgentSoftwareState> {
  const response = await fetch(`/api/hivra/agents/${encodeURIComponent(id)}/agent-software${options.live ? "?live=1" : ""}`, {
    cache: "no-store",
    credentials: "same-origin",
    signal: options.signal,
  });
  return stateFrom(response);
}

export async function setAgentSoftwareAutoUpdate(id: string, enabled: boolean): Promise<AgentSoftwareState> {
  const response = await fetch(`/api/hivra/agents/${encodeURIComponent(id)}/agent-software`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ autoUpdate: enabled }),
    cache: "no-store",
    credentials: "same-origin",
  });
  return stateFrom(response);
}
