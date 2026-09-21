import { supabaseAdmin } from "@/lib/supabase";

type QueryError = { code?: string; message?: string } | null;

type SupabaseLike = {
  from: (table: string) => unknown;
};

type DbChain = {
  select: (...args: unknown[]) => DbChain;
  gte: (column: string, value: unknown) => DbChain;
  lt: (column: string, value: unknown) => DbChain;
  in: (column: string, values: unknown[]) => DbChain;
  order: (column: string, options?: { ascending?: boolean }) => DbChain;
  limit: (count: number) => DbChain;
  then: Promise<{ data?: unknown; error: QueryError }>["then"];
};

type UsageEventRow = {
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  actual_cost_micro_usd: number | string | null;
  charged_micro_usd: number | string | null;
  upstream_status: number | null;
  created_at: string | null;
};

function asInt(value: number | string | null | undefined): number {
  if (value == null) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function requireDb(db: SupabaseLike | null | undefined): SupabaseLike {
  if (!db) throw new Error("Database not configured");
  return db;
}

interface ManagedVeniceUsageBucket {
  model: string;
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  veniceCostMicroUsd: number;
  chargedMicroUsd: number;
  marginMicroUsd: number;
}

export interface ManagedVeniceUsageSummary {
  rangeStart: string;
  rangeEnd: string;
  generatedAt: string;
  totals: {
    requestCount: number;
    promptTokens: number;
    completionTokens: number;
    veniceCostMicroUsd: number;
    chargedMicroUsd: number;
    marginMicroUsd: number;
  };
  byModel: ManagedVeniceUsageBucket[];
  rangeDays: number;
}

export const MANAGED_VENICE_MAX_SUMMARY_RANGE_DAYS = 62;

export function parseSummaryRange(params: {
  from?: string | null;
  to?: string | null;
  now?: Date;
}): { from: Date; to: Date } {
  const now = params.now ?? new Date();
  const to = params.to ? new Date(params.to) : now;
  if (Number.isNaN(to.getTime())) {
    throw new Error("'to' is not a valid ISO timestamp");
  }
  const defaultFromMs = to.getTime() - 24 * 60 * 60 * 1_000;
  const from = params.from ? new Date(params.from) : new Date(defaultFromMs);
  if (Number.isNaN(from.getTime())) {
    throw new Error("'from' is not a valid ISO timestamp");
  }
  if (from.getTime() >= to.getTime()) {
    throw new Error("'from' must be earlier than 'to'");
  }
  const rangeDays = (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1_000);
  if (rangeDays > MANAGED_VENICE_MAX_SUMMARY_RANGE_DAYS) {
    throw new Error(
      `Range exceeds ${MANAGED_VENICE_MAX_SUMMARY_RANGE_DAYS} days; narrow the window`
    );
  }
  return { from, to };
}

export async function getManagedVeniceUsageSummary(
  params: { from: Date; to: Date },
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<ManagedVeniceUsageSummary> {
  const client = requireDb(db);
  const query = (client.from("managed_venice_usage_events") as DbChain)
    .select(
      "model, prompt_tokens, completion_tokens, actual_cost_micro_usd, " +
        "charged_micro_usd, upstream_status, created_at"
    )
    .gte("created_at", params.from.toISOString())
    .lt("created_at", params.to.toISOString());

  const { data, error } = await query;
  if (error) {
    throw new Error(error.message || "Failed to load managed Venice usage events");
  }

  const rows = (data as UsageEventRow[] | null) ?? [];
  const buckets = new Map<string, ManagedVeniceUsageBucket>();
  let totalRequests = 0;
  let totalPrompt = 0;
  let totalCompletion = 0;
  let totalVeniceCost = 0;
  let totalCharged = 0;

  for (const row of rows) {
    // Settle on "succeeded" Venice responses for invoice cross-check.
    // 4xx auth or 5xx upstream errors do not bill on Venice's side and
    // would only add noise when reconciling against their invoice.
    if (row.upstream_status != null && (row.upstream_status < 200 || row.upstream_status >= 300)) {
      continue;
    }
    const model = (row.model || "unknown").trim() || "unknown";
    const veniceCost = asInt(row.actual_cost_micro_usd);
    const charged = asInt(row.charged_micro_usd);
    const promptTokens = asInt(row.prompt_tokens);
    const completionTokens = asInt(row.completion_tokens);
    const bucket = buckets.get(model) || {
      model,
      requestCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      veniceCostMicroUsd: 0,
      chargedMicroUsd: 0,
      marginMicroUsd: 0,
    };
    bucket.requestCount += 1;
    bucket.promptTokens += promptTokens;
    bucket.completionTokens += completionTokens;
    bucket.veniceCostMicroUsd += veniceCost;
    bucket.chargedMicroUsd += charged;
    bucket.marginMicroUsd = bucket.chargedMicroUsd - bucket.veniceCostMicroUsd;
    buckets.set(model, bucket);
    totalRequests += 1;
    totalPrompt += promptTokens;
    totalCompletion += completionTokens;
    totalVeniceCost += veniceCost;
    totalCharged += charged;
  }

  const byModel = [...buckets.values()].sort(
    (left, right) => right.veniceCostMicroUsd - left.veniceCostMicroUsd
  );

  return {
    rangeStart: params.from.toISOString(),
    rangeEnd: params.to.toISOString(),
    generatedAt: new Date().toISOString(),
    rangeDays: (params.to.getTime() - params.from.getTime()) / (24 * 60 * 60 * 1_000),
    totals: {
      requestCount: totalRequests,
      promptTokens: totalPrompt,
      completionTokens: totalCompletion,
      veniceCostMicroUsd: totalVeniceCost,
      chargedMicroUsd: totalCharged,
      marginMicroUsd: totalCharged - totalVeniceCost,
    },
    byModel,
  };
}
