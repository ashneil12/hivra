const MAX_DAYS = 90;
const SAFE_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface UsageBreakdown {
  tokens: number;
  requests: number;
}

export interface NormalizedUsageRow {
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

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function nonNegativeInt(value: unknown, fallback = 0): number | null {
  if (value === undefined || value === null || value === "") return fallback;
  const number = finiteNumber(value);
  if (number === null || number < 0 || !Number.isSafeInteger(Math.trunc(number))) return null;
  return Math.trunc(number);
}

function nonNegativeNumber(value: unknown, fallback = 0): number | null {
  if (value === undefined || value === null || value === "") return fallback;
  const number = finiteNumber(value);
  if (number === null || number < 0) return null;
  return number;
}

function normalizeBreakdown(value: unknown): Record<string, UsageBreakdown> | null {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const out: Record<string, UsageBreakdown> = {};
  for (const [rawKey, rawEntry] of Object.entries(value as Record<string, unknown>)) {
    const key = rawKey.trim();
    if (!key || !rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) return null;
    const entry = rawEntry as Record<string, unknown>;
    const tokens = nonNegativeInt(entry.tokens);
    const requests = nonNegativeInt(entry.requests);
    if (tokens === null || requests === null) return null;
    out[key] = { tokens, requests };
  }
  return out;
}

export function normalizeUsageRows(rows: unknown[]): NormalizedUsageRow[] | null {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_DAYS) return null;

  const normalized: NormalizedUsageRow[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const row = raw as Record<string, unknown>;
    const statDate = typeof row.stat_date === "string" ? row.stat_date : row.day;
    if (typeof statDate !== "string" || !SAFE_DATE.test(statDate)) return null;

    const input = nonNegativeInt(row.input_tokens);
    const output = nonNegativeInt(row.output_tokens);
    const cacheRead = nonNegativeInt(row.cache_read_tokens, 0);
    const reasoning = nonNegativeInt(row.reasoning_tokens, 0);
    const sessions = nonNegativeInt(row.sessions, 0);
    const apiCalls = nonNegativeInt(row.api_calls, 0);
    const estimatedCost = nonNegativeNumber(row.estimated_cost_usd ?? row.estimated_cost, 0);
    const byModel = normalizeBreakdown(row.by_model);
    const byProvider = normalizeBreakdown(row.by_provider);

    if (
      input === null || output === null || cacheRead === null || reasoning === null
      || sessions === null || apiCalls === null || estimatedCost === null
      || byModel === null || byProvider === null
    ) return null;

    normalized.push({
      stat_date: statDate,
      input_tokens: input,
      output_tokens: output,
      total_tokens: input + output,
      cache_read_tokens: cacheRead,
      reasoning_tokens: reasoning,
      estimated_cost_usd: estimatedCost,
      sessions,
      api_calls: apiCalls,
      by_model: byModel,
      by_provider: byProvider,
    });
  }
  return normalized;
}
