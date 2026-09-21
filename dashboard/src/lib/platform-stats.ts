import "server-only";

import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";

/** A {requests, tokens} pair used for model/provider usage breakdowns. */
export interface UsageBreakdown {
  requests: number;
  tokens: number;
}

/** One day's rollup row from platform_stats_daily, numbers coerced. */
export interface PlatformStatsDay {
  stat_date: string;
  generated_at: string | null;
  // cumulative
  total_agents_deployed: number;
  total_users: number;
  // day deltas
  new_agents: number;
  new_signups: number;
  deleted_agents: number;
  active_users: number;
  conversations_started: number;
  messages: number;
  inference_requests: number;
  tokens_in: number;
  tokens_out: number;
  tokens_total: number;
  inference_cost_micro_usd: number;
  chat_seconds: number;
  // point-in-time
  active_agents: number;
  paid_users: number;
  wau: number;
  mau: number;
  fleet_ram_bytes: number;
  fleet_disk_bytes: number;
  // distributions
  model_distribution: Record<string, UsageBreakdown>;
  provider_distribution: Record<string, UsageBreakdown>;
  tier_distribution: Record<string, number>;
  country_distribution: Record<string, number>;
  product_surface_distribution: Record<string, number>;
  backend_distribution: Record<string, number>;
  // Phase 2 runtime harvest (null until the harvest rollup runs)
  agent_sessions: number | null;
  api_calls: number | null;
  tool_calls: number | null;
  skills_distribution: Record<string, number> | null;
  byo_model_distribution: Record<string, UsageBreakdown> | null;
}

interface PlatformLiveTotals {
  total_agents_deployed: number;
  active_agents: number;
  live_instances: number;
  total_users: number;
}

export interface PlatformStats {
  generatedAt: string;
  rangeDays: number;
  series: PlatformStatsDay[];
  latest: PlatformStatsDay | null;
  liveTotals: PlatformLiveTotals;
}

function num(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function usageDict(value: unknown): Record<string, UsageBreakdown> {
  const out: Record<string, UsageBreakdown> = {};
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
      out[k] = { requests: num(o.requests), tokens: num(o.tokens) };
    }
  }
  return out;
}

function countDict(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = num(v);
    }
  }
  return out;
}

function nullableCountDict(value: unknown): Record<string, number> | null {
  if (value == null) return null;
  return countDict(value);
}

function nullableUsageDict(value: unknown): Record<string, UsageBreakdown> | null {
  if (value == null) return null;
  return usageDict(value);
}

function nullableNum(value: unknown): number | null {
  if (value == null) return null;
  return num(value);
}

function normalizeDay(raw: unknown): PlatformStatsDay | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.stat_date !== "string") return null;
  return {
    stat_date: r.stat_date,
    generated_at: typeof r.generated_at === "string" ? r.generated_at : null,
    total_agents_deployed: num(r.total_agents_deployed),
    total_users: num(r.total_users),
    new_agents: num(r.new_agents),
    new_signups: num(r.new_signups),
    deleted_agents: num(r.deleted_agents),
    active_users: num(r.active_users),
    conversations_started: num(r.conversations_started),
    messages: num(r.messages),
    inference_requests: num(r.inference_requests),
    tokens_in: num(r.tokens_in),
    tokens_out: num(r.tokens_out),
    tokens_total: num(r.tokens_total),
    inference_cost_micro_usd: num(r.inference_cost_micro_usd),
    chat_seconds: num(r.chat_seconds),
    active_agents: num(r.active_agents),
    paid_users: num(r.paid_users),
    wau: num(r.wau),
    mau: num(r.mau),
    fleet_ram_bytes: num(r.fleet_ram_bytes),
    fleet_disk_bytes: num(r.fleet_disk_bytes),
    model_distribution: usageDict(r.model_distribution),
    provider_distribution: usageDict(r.provider_distribution),
    tier_distribution: countDict(r.tier_distribution),
    country_distribution: countDict(r.country_distribution),
    product_surface_distribution: countDict(r.product_surface_distribution),
    backend_distribution: countDict(r.backend_distribution),
    agent_sessions: nullableNum(r.agent_sessions),
    api_calls: nullableNum(r.api_calls),
    tool_calls: nullableNum(r.tool_calls),
    skills_distribution: nullableCountDict(r.skills_distribution),
    byo_model_distribution: nullableUsageDict(r.byo_model_distribution),
  };
}

function emptyStats(days: number): PlatformStats {
  return {
    generatedAt: new Date().toISOString(),
    rangeDays: days,
    series: [],
    latest: null,
    liveTotals: {
      total_agents_deployed: 0,
      active_agents: 0,
      live_instances: 0,
      total_users: 0,
    },
  };
}

/**
 * Read the platform analytics for the admin insights dashboard in one
 * round trip. Returns the daily series for the window, the latest
 * snapshot, and always-fresh live cumulative totals. Never throws —
 * returns zeroed stats if the admin client or RPC is unavailable.
 */
export async function getPlatformStats(days = 30): Promise<PlatformStats> {
  const clampedDays = Math.min(Math.max(Math.trunc(days) || 30, 1), 365);

  if (!supabaseAdmin) {
    log.warn("platform-stats: supabaseAdmin is null (env vars missing)", {
      source: "platform-stats",
    });
    return emptyStats(clampedDays);
  }

  const { data, error } = await supabaseAdmin.rpc("get_platform_stats", {
    p_days: clampedDays,
  });

  if (error) {
    log.error("platform-stats: rpc failed", new Error(error.message || "rpc returned error"), {
      source: "platform-stats",
      code: error.code ?? null,
      details: error.details ?? null,
      hint: error.hint ?? null,
    });
    return emptyStats(clampedDays);
  }

  if (!data || typeof data !== "object") {
    return emptyStats(clampedDays);
  }

  const payload = data as Record<string, unknown>;
  const seriesRaw = Array.isArray(payload.series) ? payload.series : [];
  const live = (payload.liveTotals && typeof payload.liveTotals === "object"
    ? payload.liveTotals
    : {}) as Record<string, unknown>;

  return {
    generatedAt:
      typeof payload.generatedAt === "string" ? payload.generatedAt : new Date().toISOString(),
    rangeDays: num(payload.rangeDays) || clampedDays,
    series: seriesRaw
      .map((row) => normalizeDay(row))
      .filter((d): d is PlatformStatsDay => d !== null),
    latest: normalizeDay(payload.latest),
    liveTotals: {
      total_agents_deployed: num(live.total_agents_deployed),
      active_agents: num(live.active_agents),
      live_instances: num(live.live_instances),
      total_users: num(live.total_users),
    },
  };
}
