// Weekly Venice promo report.
//
// Definitions (also returned in `definitions` so a reader of the JSON sees them):
//  * window: [from, to), default the 7 days before `to`.
//  * per campaign, all time: grants = rows in venice_promo_grants; granted = sum
//    of grant amounts; spent = card spend since each grant, capped at the grant
//    (closed grants: the spent part recorded at expiry); expired = unspent money
//    removed from wallets at expiry; budgetLeft = budget - granted (expired money
//    is NOT returned to the budget, so the budget is a commitment ceiling).
//  * grantsInWindow: grants whose granted_at is inside the window.
//  * creditsModeLaunchUsers: distinct users with a hivra_agents row created in
//    the window whose llm_config.mode is "managed" (launched in credits mode).
//  * active after N days (7 and 30): of the promo users whose grant is at least N
//    days old, those with a recorded managed Venice request at or after
//    granted_at + N days.
//  * paid top-up after grant: promo users with a stripe_topup card ledger entry
//    after their grant.
//  * spend by model: recorded managed Venice usage events in the window, summed
//    charged_micro_usd per model (all users, plus the promo users' share).

import type { PromoCampaign } from "./core";

export interface GrantStat {
  grantId: string;
  campaignId: string;
  userId: string;
  amountMicroUsd: number;
  status: "active" | "spent" | "expired";
  grantedAt: string;
  expiresAt: string;
  expiredMicroUsd: number;
  spentMicroUsd: number;
  active7: boolean | null;
  active30: boolean | null;
  toppedUpAfter: boolean;
}

export interface WindowStats {
  modelSpend: Array<{
    model: string;
    requests: number;
    chargedMicroUsd: number;
    veniceCostMicroUsd: number;
    promoUserRequests: number;
    promoUserChargedMicroUsd: number;
  }>;
  creditsModeLaunchUsers: number;
  creditsModeLaunches: number;
}

export interface PromoReport {
  window: { from: string; to: string };
  generatedAt: string;
  campaigns: Array<{
    slug: string;
    kind: string;
    enabled: boolean;
    grants: number;
    grantsInWindow: number;
    grantedMicroUsd: number;
    spentMicroUsd: number;
    expiredMicroUsd: number;
    budgetMicroUsd: number;
    budgetLeftMicroUsd: number;
    maxGrants: number;
    grantsLeft: number;
  }>;
  creditsModeLaunchUsers: number;
  creditsModeLaunches: number;
  promoUsers: {
    total: number;
    active7: { eligible: number; active: number };
    active30: { eligible: number; active: number };
    paidTopupAfterGrant: number;
  };
  spendByModel: WindowStats["modelSpend"];
  definitions: Record<string, string>;
}

export const PROMO_REPORT_DEFINITIONS: Record<string, string> = {
  window: "[from, to), default the 7 days before to",
  granted: "sum of grant amounts, all time",
  spent: "card spend since the grant, capped at the grant (closed grants: recorded at expiry)",
  expired: "unspent promo money removed from wallets at expiry",
  budgetLeft: "budget minus granted; expired money does not return to the budget",
  creditsModeLaunchUsers: "distinct users who created an agent in the window with llm_config.mode = managed",
  active: "a recorded managed Venice request at or after granted_at + N days, among promo users whose grant is at least N days old",
  paidTopupAfterGrant: "promo users with a card top-up after their grant",
  spendByModel: "recorded managed Venice usage in the window, charged micro-USD per model",
};

const N = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0)) || 0;

export function shapePromoReport(input: {
  now: Date;
  from: Date;
  to: Date;
  campaigns: PromoCampaign[];
  grants: GrantStat[];
  windowStats: WindowStats;
}): PromoReport {
  const fromMs = input.from.getTime();
  const toMs = input.to.getTime();

  const campaigns = input.campaigns.map((c) => {
    const mine = input.grants.filter((g) => g.campaignId === c.id);
    const granted = mine.reduce((s, g) => s + N(g.amountMicroUsd), 0);
    return {
      slug: c.slug,
      kind: c.kind,
      enabled: c.enabled,
      grants: mine.length,
      grantsInWindow: mine.filter((g) => {
        const t = Date.parse(g.grantedAt);
        return t >= fromMs && t < toMs;
      }).length,
      grantedMicroUsd: granted,
      spentMicroUsd: mine.reduce((s, g) => s + N(g.spentMicroUsd), 0),
      expiredMicroUsd: mine.reduce((s, g) => s + N(g.expiredMicroUsd), 0),
      budgetMicroUsd: c.budgetMicroUsd,
      budgetLeftMicroUsd: Math.max(0, c.budgetMicroUsd - granted),
      maxGrants: c.maxGrants,
      grantsLeft: Math.max(0, c.maxGrants - mine.length),
    };
  });

  const users = new Set(input.grants.map((g) => g.userId));
  const count = (key: "active7" | "active30") => ({
    eligible: input.grants.filter((g) => g[key] !== null).length,
    active: input.grants.filter((g) => g[key] === true).length,
  });

  return {
    window: { from: input.from.toISOString(), to: input.to.toISOString() },
    generatedAt: input.now.toISOString(),
    campaigns,
    creditsModeLaunchUsers: N(input.windowStats.creditsModeLaunchUsers),
    creditsModeLaunches: N(input.windowStats.creditsModeLaunches),
    promoUsers: {
      total: users.size,
      active7: count("active7"),
      active30: count("active30"),
      paidTopupAfterGrant: new Set(input.grants.filter((g) => g.toppedUpAfter).map((g) => g.userId)).size,
    },
    spendByModel: input.windowStats.modelSpend,
    definitions: PROMO_REPORT_DEFINITIONS,
  };
}

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;

export async function loadPromoReport(
  db: { from: (t: string) => unknown; rpc: Rpc },
  params: { now?: Date; windowDays?: number; to?: Date }
): Promise<PromoReport> {
  const now = params.now ?? new Date();
  const to = params.to ?? now;
  const from = new Date(to.getTime() - (params.windowDays ?? 7) * 24 * 60 * 60 * 1000);

  const { mapCampaign } = await import("./service");
  const campaignsQuery = db.from("venice_promo_campaigns") as {
    select: (c: string) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
  };
  const { data: campaignRows, error: campaignError } = await campaignsQuery.select(
    "id, slug, kind, code, enabled, starts_at, ends_at, grant_cutoff_at, budget_micro_usd, per_user_cap_micro_usd, bonus_bps, max_grants, grant_expiry_days"
  );
  if (campaignError) throw new Error(campaignError.message || "Failed to read campaigns");
  const campaigns = (Array.isArray(campaignRows) ? campaignRows : []).map((r) =>
    mapCampaign(r as Parameters<typeof mapCampaign>[0])
  );

  const [grantStats, windowStats] = await Promise.all([
    db.rpc("venice_promo_grant_stats", { p_now: now.toISOString() }),
    db.rpc("venice_promo_window_stats", { p_from: from.toISOString(), p_to: to.toISOString() }),
  ]);
  if (grantStats.error) throw new Error(grantStats.error.message || "venice_promo_grant_stats failed");
  if (windowStats.error) throw new Error(windowStats.error.message || "venice_promo_window_stats failed");

  return shapePromoReport({
    now,
    from,
    to,
    campaigns,
    grants: (Array.isArray(grantStats.data) ? grantStats.data : []) as GrantStat[],
    windowStats: (windowStats.data ?? { modelSpend: [], creditsModeLaunchUsers: 0, creditsModeLaunches: 0 }) as WindowStats,
  });
}
