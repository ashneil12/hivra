// What the billing page needs to show the plan ladder: the plans (names,
// prices, limits; no Stripe IDs), whether this person may buy them, and, for
// a ladder subscriber, how many agents they keep awake. `enabled: false`
// whenever the ladder is switched off or not configured.

export const runtime = "nodejs";

import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { supabaseAdmin } from "@/lib/supabase";
import { holdsPaidPlan } from "@/lib/billing/subscription-status";
import { PLAN_LADDER_ID, activePlanLadder, publicPlanLadder, sellsLadderTo } from "@/lib/subscription/plan-ladder";
import { countAlwaysOnAgents } from "@/lib/billing/plan-ladder-entitlement";

export async function GET() {
  const { userId } = await auth();
  if (!userId) return apiError("Unauthorized", 401);

  const config = activePlanLadder();
  if (!config || !supabaseAdmin) {
    const off = apiSuccess({ enabled: false });
    off.headers.set("Cache-Control", "no-store");
    return off;
  }

  const { data: sub } = await supabaseAdmin
    .from("hermes_subscriptions")
    .select("plan, status, stripe_subscription_id, plan_ladder, always_on_limit, always_on_extra, ai_allowance_micro_usd, trial_ends_at")
    .eq("user_id", userId)
    .maybeSingle();

  const holdsPaid = holdsPaidPlan(sub);
  const onLadder = holdsPaid && sub?.plan_ladder === PLAN_LADDER_ID;
  let alwaysOnInUse: number | null = null;
  if (onLadder) {
    try {
      alwaysOnInUse = await countAlwaysOnAgents(userId);
    } catch {
      alwaysOnInUse = null;
    }
  }

  const response = apiSuccess({
    enabled: true,
    ladder: publicPlanLadder(config),
    // A paid plan from before the ladder keeps its price and limits; the
    // ladder is shown to everyone else.
    offered: sellsLadderTo(sub, holdsPaid),
    current: onLadder
      ? {
          plan: sub?.plan ?? null,
          inCardTrial: Boolean(sub?.trial_ends_at),
          alwaysOnLimit: sub?.always_on_limit ?? null,
          alwaysOnExtra: sub?.always_on_extra ?? 0,
          alwaysOnInUse,
          aiAllowanceCents: Math.round(Number(sub?.ai_allowance_micro_usd ?? 0) / 10_000),
        }
      : null,
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
