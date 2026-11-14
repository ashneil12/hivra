import "server-only";

import { unstable_cache } from "next/cache";

import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";

/** Public-safe marketing counters for the /stats page. Counts only. */
export interface PublicStats {
  generatedAt: string;
  agentsDeployed: number;
  runningNow: number;
  builders: number;
  tokensProcessed: number;
  /** Two hourly cumulative-token checkpoints for the smooth client-side odometer. */
  tokensAnchorPrev: number | null;
  tokensAnchorPrevAt: string | null;
  tokensAnchorCurr: number | null;
  tokensAnchorCurrAt: string | null;
  countries: number;
  models: number;
  providers: number;
  last7dDeployed: number;
}

function num(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function nullableNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = num(value);
  return Number.isFinite(n) ? n : null;
}

function nullableStr(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Read the public marketing stats (via the service-role RPC). Returns null
 * if the admin client or RPC is unavailable — callers render a graceful
 * fallback. Never throws.
 */
// The marketing counters move slowly and /stats reads them on every view, so the
// RPC is cached for five minutes. A failed read throws inside the cache callback,
// so it is never stored; the caller still gets null.
const readPublicStatsRpc = unstable_cache(
  async (): Promise<Record<string, unknown>> => {
    const { data, error } = await supabaseAdmin!.rpc("get_public_stats");

    if (error) {
      log.error("public-stats: rpc failed", new Error(error.message || "rpc returned error"), {
        source: "public-stats",
        code: error.code ?? null,
      });
      throw new Error(error.message || "rpc returned error");
    }

    if (!data || typeof data !== "object") throw new Error("rpc returned no data");

    return data as Record<string, unknown>;
  },
  ["public-stats-rpc"],
  { revalidate: 300 },
);

export async function getPublicStats(): Promise<PublicStats | null> {
  if (!supabaseAdmin) {
    log.warn("public-stats: supabaseAdmin is null (env vars missing)", { source: "public-stats" });
    return null;
  }

  let p: Record<string, unknown>;
  try {
    p = await readPublicStatsRpc();
  } catch {
    return null;
  }

  return {
    generatedAt: typeof p.generatedAt === "string" ? p.generatedAt : new Date().toISOString(),
    agentsDeployed: num(p.agentsDeployed),
    runningNow: num(p.runningNow),
    builders: num(p.builders),
    tokensProcessed: num(p.tokensProcessed),
    tokensAnchorPrev: nullableNum(p.tokensAnchorPrev),
    tokensAnchorPrevAt: nullableStr(p.tokensAnchorPrevAt),
    tokensAnchorCurr: nullableNum(p.tokensAnchorCurr),
    tokensAnchorCurrAt: nullableStr(p.tokensAnchorCurrAt),
    countries: num(p.countries),
    models: num(p.models),
    providers: num(p.providers),
    last7dDeployed: num(p.last7dDeployed),
  };
}
