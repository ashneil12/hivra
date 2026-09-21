/**
 * Per-instance usage summary — the "what your agent did while you were away"
 * rollup. Pure aggregation over harvested `instance_usage_snapshots` rows so it
 * is trivially testable; the route does the auth + fetch and hands rows here.
 */

export interface UsageSnapshotRow {
  stat_date: string;
  total_tokens: number | null;
  sessions: number | null;
  api_calls: number | null;
  tool_calls: number | null;
  estimated_cost_usd: number | null;
  /** { "<model>": { tokens, requests } } — harvested per day. */
  by_model: Record<string, { tokens?: number | null; requests?: number | null }> | null;
}

export interface InstanceUsageSummary {
  /** Window length in days the caller asked for. */
  days: number;
  sessions: number;
  apiCalls: number;
  toolCalls: number;
  totalTokens: number;
  estimatedCostUsd: number;
  /** Distinct UTC days within the window that had any recorded activity. */
  activeDays: number;
  /** Most-recent stat_date with activity, or null. */
  lastActiveDate: string | null;
  /** Model with the most tokens across the window, or null. */
  topModel: string | null;
  /** True when the agent recorded zero activity in the window. */
  isEmpty: boolean;
}

function num(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Aggregate harvested snapshot rows into a single window summary. Rows may span
 * more than `days` (the route bounds the query); callers pass the intended
 * window for display. A row counts as "active" if it recorded any sessions,
 * api_calls, tool_calls, or tokens.
 */
export function summarizeInstanceUsage(
  rows: UsageSnapshotRow[],
  days: number,
): InstanceUsageSummary {
  let sessions = 0;
  let apiCalls = 0;
  let toolCalls = 0;
  let totalTokens = 0;
  let estimatedCostUsd = 0;
  let activeDays = 0;
  let lastActiveDate: string | null = null;
  const modelTokens = new Map<string, number>();

  for (const row of rows) {
    const s = num(row.sessions);
    const a = num(row.api_calls);
    const t = num(row.tool_calls);
    const tok = num(row.total_tokens);
    sessions += s;
    apiCalls += a;
    toolCalls += t;
    totalTokens += tok;
    estimatedCostUsd += num(row.estimated_cost_usd);

    const hadActivity = s > 0 || a > 0 || t > 0 || tok > 0;
    if (hadActivity) {
      activeDays += 1;
      if (!lastActiveDate || row.stat_date > lastActiveDate) {
        lastActiveDate = row.stat_date;
      }
    }

    if (row.by_model && typeof row.by_model === "object") {
      for (const [model, stats] of Object.entries(row.by_model)) {
        if (!model) continue;
        const mt = num(stats?.tokens);
        if (mt <= 0) continue;
        modelTokens.set(model, (modelTokens.get(model) ?? 0) + mt);
      }
    }
  }

  let topModel: string | null = null;
  let topModelTokens = -1;
  for (const [model, tok] of modelTokens) {
    if (tok > topModelTokens) {
      topModel = model;
      topModelTokens = tok;
    }
  }

  const isEmpty = sessions === 0 && apiCalls === 0 && toolCalls === 0 && totalTokens === 0;

  return {
    days,
    sessions,
    apiCalls,
    toolCalls,
    totalTokens,
    estimatedCostUsd,
    activeDays,
    lastActiveDate,
    topModel,
    isEmpty,
  };
}
