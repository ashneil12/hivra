interface UsageBreakdown {
  tokens: number;
  requests: number;
}

export interface ParsedUsageDay {
  stat_date: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_tokens: number;
  reasoning_tokens: number;
  estimated_cost_usd: number;
  sessions: number;
  api_calls: number;
  by_model: Record<string, UsageBreakdown>;
  by_provider: Record<string, UsageBreakdown>;
}

function num(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }
  return 0;
}

export interface ParsedAgentProbe {
  ok: boolean;
  lastActivityAt: string | null;
}

export function parseAgentProbe(raw: string): ParsedAgentProbe {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, lastActivityAt: null };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, lastActivityAt: null };
  const object = parsed as Record<string, unknown>;
  if (object._error !== undefined || object.ok !== true) {
    return { ok: false, lastActivityAt: null };
  }

  const epoch = object.last_activity;
  if (typeof epoch !== "number" || !Number.isFinite(epoch) || epoch <= 0) {
    return { ok: true, lastActivityAt: null };
  }
  const milliseconds = epoch * 1000;
  if (milliseconds > Date.now() + 24 * 60 * 60 * 1000) {
    return { ok: true, lastActivityAt: null };
  }
  return { ok: true, lastActivityAt: new Date(milliseconds).toISOString() };
}

export function parseAgentUsage(raw: string): ParsedUsageDay[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const object = parsed as Record<string, unknown>;

  const byDay = new Map<string, ParsedUsageDay>();
  const dayKey = (value: unknown): string | null =>
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;

  for (const entry of Array.isArray(object.daily) ? object.daily : []) {
    if (!entry || typeof entry !== "object") continue;
    const dayEntry = entry as Record<string, unknown>;
    const day = dayKey(dayEntry.day);
    if (!day) continue;
    const input = num(dayEntry.input_tokens);
    const output = num(dayEntry.output_tokens);
    byDay.set(day, {
      stat_date: day,
      input_tokens: input,
      output_tokens: output,
      total_tokens: input + output,
      cache_read_tokens: num(dayEntry.cache_read_tokens),
      reasoning_tokens: num(dayEntry.reasoning_tokens),
      estimated_cost_usd: num(dayEntry.estimated_cost),
      sessions: num(dayEntry.sessions),
      api_calls: num(dayEntry.api_calls),
      by_model: {},
      by_provider: {},
    });
  }

  for (const entry of Array.isArray(object.models) ? object.models : []) {
    if (!entry || typeof entry !== "object") continue;
    const modelEntry = entry as Record<string, unknown>;
    const day = dayKey(modelEntry.day);
    const model = typeof modelEntry.model === "string" && modelEntry.model.trim()
      ? modelEntry.model.trim()
      : null;
    if (!day || !model || !byDay.has(day)) continue;
    byDay.get(day)!.by_model[model] = {
      tokens: num(modelEntry.tokens),
      requests: num(modelEntry.requests),
    };
  }

  for (const entry of Array.isArray(object.providers) ? object.providers : []) {
    if (!entry || typeof entry !== "object") continue;
    const providerEntry = entry as Record<string, unknown>;
    const day = dayKey(providerEntry.day);
    const provider = typeof providerEntry.provider === "string" && providerEntry.provider.trim()
      ? providerEntry.provider.trim()
      : null;
    if (!day || !provider || !byDay.has(day)) continue;
    byDay.get(day)!.by_provider[provider] = {
      tokens: num(providerEntry.tokens),
      requests: num(providerEntry.requests),
    };
  }

  return Array.from(byDay.values());
}

const HARVESTED_GOAL_MAX_LEN = 700;

export function parseHarvestedGoal(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const blobs = (parsed as Record<string, unknown>).goals;
  if (!Array.isArray(blobs)) return null;

  const statusRank = (status: unknown): number =>
    status === "active" ? 0 : status === "paused" ? 1 : 2;

  let best: { text: string; rank: number; recency: number } | null = null;
  for (const blob of blobs) {
    if (typeof blob !== "string") continue;
    let goal: Record<string, unknown>;
    try {
      const object = JSON.parse(blob);
      if (!object || typeof object !== "object") continue;
      goal = object as Record<string, unknown>;
    } catch {
      continue;
    }
    const text = typeof goal.goal === "string" ? goal.goal.trim() : "";
    if (!text) continue;
    const rank = statusRank(goal.status);
    const recency = Math.max(num(goal.last_turn_at), num(goal.created_at));
    if (!best || rank < best.rank || (rank === best.rank && recency > best.recency)) {
      best = { text, rank, recency };
    }
  }
  return best ? best.text.slice(0, HARVESTED_GOAL_MAX_LEN) : null;
}
