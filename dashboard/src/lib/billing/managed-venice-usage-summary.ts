// Managed-Venice usage breakdown — read-only aggregation over
// managed_venice_usage_events for the customer spend view. Pure aggregation of
// existing audit rows; never writes or charges.

import { requireDb } from "@/lib/billing/db-utils";
import { supabaseAdmin } from "@/lib/supabase";

type QueryError = { code?: string; message?: string } | null;

type DbSelectChain = {
  select: (...args: unknown[]) => DbSelectChain;
  eq: (...args: unknown[]) => DbSelectChain;
  gte: (...args: unknown[]) => DbSelectChain;
  then: Promise<{ data?: unknown; error: QueryError }>["then"];
};

type SupabaseLike = { from: (table: string) => unknown };

export interface UsageEventRow {
  endpoint?: string | null;
  model?: string | null;
  charged_micro_usd?: number | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  created_at?: string | null;
}

export interface ManagedVeniceUsageSummary {
  monthStart: string;
  totalChargedMicroUsd: number;
  totalRequests: number;
  /** Per chat model: charged + tokens. */
  byModel: Array<{ model: string; chargedMicroUsd: number; requests: number; promptTokens: number; completionTokens: number }>;
  /** Per modality (chat / image / video / audio / embeddings / other). */
  byModality: Array<{ modality: string; chargedMicroUsd: number; requests: number }>;
  /** Naive linear projection: spend so far / days elapsed × days in month. */
  projectedMonthEndMicroUsd: number;
}

// Map an endpoint path to a coarse modality bucket for the spend view.
export function modalityFromEndpoint(endpoint: string | null | undefined): string {
  const e = (endpoint || "").toLowerCase();
  if (e.includes("/chat/completions") || e === "/api/v1/chat/completions") return "chat";
  if (e.includes("/image")) return "image";
  if (e.includes("/video")) return "video";
  if (e.includes("/audio")) return "audio";
  if (e.includes("/embed")) return "embeddings";
  if (e.includes("/augment")) return "search";
  return "other";
}

function monthStartIso(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function daysInUtcMonth(now: Date): number {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function aggregateManagedVeniceUsage(rows: UsageEventRow[], now: Date): ManagedVeniceUsageSummary {
  const byModelMap = new Map<string, { chargedMicroUsd: number; requests: number; promptTokens: number; completionTokens: number }>();
  const byModalityMap = new Map<string, { chargedMicroUsd: number; requests: number }>();
  let totalChargedMicroUsd = 0;

  for (const row of rows) {
    const charged = num(row.charged_micro_usd);
    totalChargedMicroUsd += charged;

    const model = (row.model || "unknown").trim() || "unknown";
    const m = byModelMap.get(model) ?? { chargedMicroUsd: 0, requests: 0, promptTokens: 0, completionTokens: 0 };
    m.chargedMicroUsd += charged;
    m.requests += 1;
    m.promptTokens += num(row.prompt_tokens);
    m.completionTokens += num(row.completion_tokens);
    byModelMap.set(model, m);

    const modality = modalityFromEndpoint(row.endpoint);
    const md = byModalityMap.get(modality) ?? { chargedMicroUsd: 0, requests: 0 };
    md.chargedMicroUsd += charged;
    md.requests += 1;
    byModalityMap.set(modality, md);
  }

  const dayOfMonth = now.getUTCDate();
  // Naive linear projection: spend so far / days elapsed × days in month.
  // On the 1st of the month (dayOfMonth === 1) only a fraction of a single day
  // has elapsed, so multiplying by ~28-31 wildly inflates the projection for new
  // spenders. With <2 full days of data there isn't enough signal to project
  // linearly, so fall back to the actual month-to-date total instead.
  const projectedMonthEndMicroUsd =
    dayOfMonth > 1
      ? Math.round((totalChargedMicroUsd / dayOfMonth) * daysInUtcMonth(now))
      : totalChargedMicroUsd;

  return {
    monthStart: monthStartIso(now),
    totalChargedMicroUsd,
    totalRequests: rows.length,
    byModel: Array.from(byModelMap.entries())
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => b.chargedMicroUsd - a.chargedMicroUsd),
    byModality: Array.from(byModalityMap.entries())
      .map(([modality, v]) => ({ modality, ...v }))
      .sort((a, b) => b.chargedMicroUsd - a.chargedMicroUsd),
    projectedMonthEndMicroUsd,
  };
}

export async function getManagedVeniceUsageSummary(
  userId: string,
  now: Date = new Date(),
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<ManagedVeniceUsageSummary> {
  const client = requireDb(db) as SupabaseLike;
  const { data, error } = await (client.from("managed_venice_usage_events") as DbSelectChain)
    .select("endpoint, model, charged_micro_usd, prompt_tokens, completion_tokens, created_at")
    .eq("user_id", userId)
    .gte("created_at", monthStartIso(now));
  if (error) {
    throw new Error(error.message || "Failed to load managed Venice usage summary");
  }
  return aggregateManagedVeniceUsage((Array.isArray(data) ? data : []) as UsageEventRow[], now);
}
