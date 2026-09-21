import type {
  InstanceActivityDigest,
  InstanceActivitySource,
  InstanceActivityState,
} from "./activity";

type ApiResult =
  | { ok: true; digest: InstanceActivityDigest }
  | { ok: false; message: string };

const ACTIVITY_STATES = new Set<InstanceActivityState>([
  "idle",
  "responding",
  "unreachable",
  "not_running",
]);

const ACTIVITY_SOURCES = new Set<InstanceActivitySource>([
  "webui",
  "dashboard",
  "degraded",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function readRecentSessions(value: unknown): InstanceActivityDigest["recentSessions"] | null {
  if (!Array.isArray(value)) return null;
  const sessions: InstanceActivityDigest["recentSessions"] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.title !== "string") {
      return null;
    }
    if (!isNullableString(entry.updatedAt) || !isNullableString(entry.model)) return null;
    if (entry.messageCount !== null && !isFiniteNumber(entry.messageCount)) return null;
    if (entry.estimatedCostUsd !== null && !isFiniteNumber(entry.estimatedCostUsd)) return null;
    sessions.push({
      id: entry.id,
      title: entry.title,
      updatedAt: entry.updatedAt,
      messageCount: entry.messageCount,
      model: entry.model,
      estimatedCostUsd: entry.estimatedCostUsd,
    });
  }
  return sessions;
}

function readAttentionItems(value: unknown): InstanceActivityDigest["attentionItems"] | null {
  if (!Array.isArray(value)) return null;
  const items: InstanceActivityDigest["attentionItems"] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.type !== "string" ||
      typeof entry.label !== "string" ||
      (entry.severity !== "info" && entry.severity !== "warning" && entry.severity !== "critical")
    ) {
      return null;
    }
    items.push({
      type: entry.type as InstanceActivityDigest["attentionItems"][number]["type"],
      label: entry.label,
      severity: entry.severity,
      href: typeof entry.href === "string" ? entry.href : undefined,
    });
  }
  return items;
}

export function readInstanceActivityDigest(value: unknown): InstanceActivityDigest | null {
  if (!isRecord(value)) return null;
  if (
    !ACTIVITY_STATES.has(value.state as InstanceActivityState) ||
    !ACTIVITY_SOURCES.has(value.source as InstanceActivitySource) ||
    typeof value.headline !== "string" ||
    !isNullableString(value.lastActiveAt)
  ) {
    return null;
  }
  if (value.activeStreams !== null && !isFiniteNumber(value.activeStreams)) return null;
  if (value.detail !== undefined && typeof value.detail !== "string") return null;

  const recentSessions = readRecentSessions(value.recentSessions);
  const attentionItems = readAttentionItems(value.attentionItems);
  if (!recentSessions || !attentionItems) return null;

  return {
    state: value.state as InstanceActivityState,
    headline: value.headline,
    detail: typeof value.detail === "string" ? value.detail : undefined,
    lastActiveAt: value.lastActiveAt,
    activeStreams: value.activeStreams,
    recentSessions,
    attentionItems,
    source: value.source as InstanceActivitySource,
  };
}

async function readApiPayload(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const payload = await response.json();
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

function apiPayloadError(payload: Record<string, unknown> | null, fallback: string) {
  return typeof payload?.error === "string" ? payload.error : fallback;
}

function apiPayloadData(payload: Record<string, unknown> | null): unknown {
  return payload?.success === true ? payload.data : null;
}

export async function requestInstanceActivityDigest(instanceId: string): Promise<ApiResult> {
  try {
    const response = await fetch(`/api/instances/${encodeURIComponent(instanceId)}/activity`);
    const payload = await readApiPayload(response);
    if (!response.ok) {
      return { ok: false, message: apiPayloadError(payload, "Runtime activity is unavailable.") };
    }

    const digest = readInstanceActivityDigest(apiPayloadData(payload));
    if (!digest) {
      return { ok: false, message: "Runtime activity response was incomplete." };
    }

    return { ok: true, digest };
  } catch {
    return { ok: false, message: "Runtime activity is unavailable." };
  }
}
