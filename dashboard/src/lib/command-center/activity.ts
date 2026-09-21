import type { WebUISession } from "@/lib/webui/types";

// NOTE: there is deliberately no "needs_approval"/"needs_clarification" state.
// Approvals and clarifications never travel over HTTP — the agent pushes an
// `approval.request` / `clarify.request` JSON-RPC event down the workspace
// iframe's /api/ws socket and blocks a worker thread on the reply. There is no
// pollable pending-approval surface on the agent image (tui_gateway exposes
// only `approval.respond` / `clarify.respond`, no list/query method), so the
// dashboard cannot know an approval is outstanding. The iframe owns that UX.
// Surfacing it on the card needs a push channel, not a digest state.
export type InstanceActivityState =
  | "idle"
  | "responding"
  | "unreachable"
  | "not_running";

export type InstanceActivitySource = "webui" | "dashboard" | "degraded";

export interface InstanceActivityDigest {
  state: InstanceActivityState;
  headline: string;
  detail?: string;
  lastActiveAt: string | null;
  activeStreams: number | null;
  recentSessions: Array<{
    id: string;
    title: string;
    updatedAt: string | null;
    messageCount: number | null;
    model: string | null;
    estimatedCostUsd: number | null;
  }>;
  attentionItems: Array<{
    type: "failure" | "credits" | "runtime";
    label: string;
    severity: "info" | "warning" | "critical";
    href?: string;
  }>;
  source: InstanceActivitySource;
}

export interface ActivityDigestInstance {
  id: string;
  name?: string | null;
  status: string;
  backend?: string | null;
}

export interface WebUIHealthSummary {
  status?: string;
  sessions?: number;
  active_streams?: number;
  uptime_seconds?: number;
}

export interface BuildInstanceActivityDigestInput {
  instance: ActivityDigestInstance;
  health: WebUIHealthSummary | null;
  sessions: Array<Partial<WebUISession>>;
  unreachable?: boolean;
}

function normalizeDate(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  return null;
}

function normalizeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeSession(session: Partial<WebUISession>) {
  const id = typeof session.session_id === "string" ? session.session_id : "";
  if (!id) return null;

  return {
    id,
    title:
      typeof session.title === "string" && session.title.trim()
        ? session.title.trim()
        : "Untitled session",
    updatedAt: normalizeDate(session.updated_at),
    messageCount: normalizeNumber(session.message_count),
    model: typeof session.model === "string" && session.model.trim() ? session.model : null,
    estimatedCostUsd: normalizeNumber(session.estimated_cost),
  };
}

function recentSessionsFrom(sessions: Array<Partial<WebUISession>>) {
  return sessions
    .map(normalizeSession)
    .filter((session): session is NonNullable<typeof session> => Boolean(session))
    .sort((left, right) => {
      const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : 0;
      const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : 0;
      return rightTime - leftTime;
    })
    .slice(0, 3);
}

function stoppedHeadline(status: string) {
  const normalized = status.toLowerCase();
  if (normalized === "failed" || normalized === "error") return "Agent needs attention";
  if (normalized === "provisioning") return "Agent is provisioning";
  return "Agent is stopped";
}

export function buildInstanceActivityDigest({
  instance,
  health,
  sessions,
  unreachable = false,
}: BuildInstanceActivityDigestInput): InstanceActivityDigest {
  const recentSessions = recentSessionsFrom(sessions);
  const lastActiveAt = recentSessions[0]?.updatedAt ?? null;
  const activeStreams = typeof health?.active_streams === "number" ? health.active_streams : null;
  const instanceRunning = instance.status.toLowerCase() === "running";

  if (!instanceRunning) {
    return {
      state: "not_running",
      headline: stoppedHeadline(instance.status),
      detail: "Start the agent to resume runtime activity.",
      lastActiveAt,
      activeStreams: null,
      recentSessions,
      attentionItems: [
        {
          type: "runtime",
          label: "Agent not running",
          severity: instance.status.toLowerCase() === "failed" ? "critical" : "info",
        },
      ],
      source: "dashboard",
    };
  }

  if (unreachable || !health) {
    // The legacy live-activity surface is being retired, so on a current box we
    // often can't read a live work signal. That is NORMAL — it is not an error
    // the user should see. Return a calm, neutral idle-style state (no red
    // banner, no "unreachable"/"WebUI" wording, no attention item). The chat
    // itself is the source of truth for what the agent is doing.
    return {
      state: "idle",
      headline: "Ready when you are",
      detail: "Send a message in the chat to put your agent to work.",
      lastActiveAt,
      activeStreams: null,
      recentSessions,
      attentionItems: [],
      source: "dashboard",
    };
  }

  if ((activeStreams ?? 0) > 0) {
    return {
      state: "responding",
      headline: "Responding now",
      detail: "Your agent is actively working.",
      lastActiveAt,
      activeStreams,
      recentSessions,
      attentionItems: [],
      source: "webui",
    };
  }

  return {
    state: "idle",
    headline: "Waiting for your next message",
    detail: recentSessions.length > 0 ? "Recent session activity is available." : "No recent session activity yet.",
    lastActiveAt,
    activeStreams,
    recentSessions,
    attentionItems: [],
    source: "webui",
  };
}
