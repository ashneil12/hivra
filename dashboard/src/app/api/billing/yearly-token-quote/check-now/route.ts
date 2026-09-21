/**
 * POST /api/billing/yearly-token-quote/check-now   body: { tier?: 'pro' | 'power' }
 *
 * On-demand version of the yearly-token-sweep cron's per-user pass.
 * The cron runs every 5 min — for the user staring at the modal after
 * sending tokens, that's a long silent wait. This endpoint lets the
 * dashboard banner ask "did my tokens land yet?" right now.
 *
 * Behaviour mirrors the cron exactly:
 *   1. Find the user's active yearly_token_quote(s).
 *   2. For each, run detectAndActivateYearlyDeposit (read on-chain
 *      balance; if ≥ tokens_required, consume quote + insert sub row).
 *   3. For any newly activated sub with sweep_status='pending', run
 *      sweepActivatedSubscription (mint Bankr API key, transfer to
 *      treasury, mark swept).
 *
 * Idempotent — re-runs are safe. Heavy on-chain RPC + Bankr calls so
 * frontend-side rate limiting via a debounced button is recommended.
 */

import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import {
  BILLING_V2_UNAVAILABLE_MESSAGE,
  isBillingV2ServerEnabled,
} from "@/lib/billing/billing-v2-availability";
import {
  detectAndActivateYearlyDeposit,
  sweepActivatedSubscription,
  type DetectionResult,
  type SweepResult,
} from "@/lib/billing/yearly-sweep";
import {
  getActiveYearlyTokenQuote,
  getActiveYearlyTokenQuotes,
} from "@/lib/billing/yearly-token-quotes";
import { supabaseAdmin } from "@/lib/supabase";
import type { TierKey } from "@/lib/billing/tier-thresholds";

function isValidTier(value: unknown): value is TierKey {
  return value === "pro" || value === "power";
}

interface PostBody {
  tier?: unknown;
}

interface PendingSweepRow {
  id: string;
  user_id: string;
  amount_received_raw: string;
}

export async function POST(req: NextRequest) {
  let userIdForLog: string | null = null;
  try {
    if (!isBillingV2ServerEnabled()) {
      return apiError(BILLING_V2_UNAVAILABLE_MESSAGE, 404);
    }
    const { userId } = await auth();
    userIdForLog = userId ?? null;
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    let body: PostBody = {};
    try {
      body = (await req.json().catch(() => ({}))) as PostBody;
    } catch {
      body = {};
    }
    const tier = isValidTier(body.tier) ? body.tier : null;

    // Pass 1 — detect deposits + activate.
    const detectionResults: DetectionResult[] = [];
    const quotes = tier
      ? await (async () => {
          const q = await getActiveYearlyTokenQuote({ userId, tier });
          return q ? [q] : [];
        })()
      : await getActiveYearlyTokenQuotes(userId);
    for (const quote of quotes) {
      const result = await detectAndActivateYearlyDeposit(quote);
      detectionResults.push(result);
    }

    // Pass 2 — sweep any pending subs (the just-activated ones plus
    // anything from a previous tick that didn't sweep cleanly).
    const { data: pendingRows } = await supabaseAdmin
      .from("yearly_token_subscriptions")
      .select("id, user_id, amount_received_raw::text")
      .eq("user_id", userId)
      .eq("sweep_status", "pending")
      .order("paid_at", { ascending: true })
      .limit(10);

    const sweepResults: SweepResult[] = [];
    for (const row of (pendingRows as PendingSweepRow[] | null) ?? []) {
      const result = await sweepActivatedSubscription(row);
      sweepResults.push(result);
    }

    return apiSuccess({
      detection: detectionResults,
      sweep: sweepResults,
      summary: {
        examined: detectionResults.length,
        activated: detectionResults.filter((r) => r.outcome === "activated").length,
        alreadyActive: detectionResults.filter((r) => r.outcome === "already_active").length,
        noBalance: detectionResults.filter((r) => r.outcome === "no_balance").length,
        insufficient: detectionResults.filter((r) => r.outcome === "insufficient_balance").length,
        swept: sweepResults.filter((r) => r.outcome === "swept").length,
      },
    });
  } catch (error) {
    return apiError("On-demand check failed.", 500, {
      failureType: "yearly_token_check_now_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    }, undefined, {
      source: "billing/yearly-token-quote-check-now",
      route: "/api/billing/yearly-token-quote/check-now",
      method: "POST",
      userId: userIdForLog,
      failureType: "yearly_token_check_now_failed",
      cause: error,
    });
  }
}
