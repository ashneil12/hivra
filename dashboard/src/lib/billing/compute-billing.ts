import { requireDb } from "@/lib/billing/db-utils";
import { supabaseAdmin } from "@/lib/supabase";

// SCRIPTURE_ANCHOR: just-weight | Proverbs 11:1 | Verse: A false balance is an abomination to Yahweh, but accurate weights are his delight.

type SupabaseLike = {
  from: (name: string) => unknown;
};

const DEFAULT_HOURLY_CREDITS = 100;
const DEFAULT_GRACE_PERIOD_HOURS = 24;

export function getBaseHourlyComputeCredits(
  env: Record<string, string | undefined> = process.env
) {
  const parsed = Number.parseInt(env.HERMES_COMPUTE_BASE_HOURLY_CREDITS?.trim() || "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_HOURLY_CREDITS;
  }

  return Math.min(100_000, Math.floor(parsed));
}

export function getComputeGracePeriodHours(
  env: Record<string, string | undefined> = process.env
) {
  const parsed = Number.parseInt(env.HERMES_COMPUTE_GRACE_HOURS?.trim() || "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_GRACE_PERIOD_HOURS;
  }

  return Math.min(168, Math.floor(parsed));
}

export async function billHourlyComputeUsage(params: {
  db?: SupabaseLike | null;
  limit?: number;
} = {}) {
  requireDb(params.db ?? supabaseAdmin);
  const hourlyCredits = getBaseHourlyComputeCredits();
  const gracePeriodHours = getComputeGracePeriodHours();
  // Compute credits as an entitlement gate are disabled: Hermes' compute model
  // is plan-based, and free-plan users were being wrongly suspended when their
  // credit balance hit zero. The credit_base bill/suspend/resume loops and their
  // helpers were removed, and the token_base loop went with the 1-token Starter
  // tier, so this run checks nothing today. The response shape is kept so the
  // hourly cron body does not change.
  return {
    checked: 0,
    billedInstances: 0,
    billedEvents: 0,
    skipped: 0,
    underfunded: 0,
    failed: 0,
    suspended: 0,
    pauseFailed: 0,
    resumed: 0,
    resumeWaiting: 0,
    resumeFailed: 0,
    creditsDebited: 0,
    hourlyCredits,
    gracePeriodHours,
    results: [],
  };
}
