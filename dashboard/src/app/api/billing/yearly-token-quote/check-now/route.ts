/**
 * POST /api/billing/yearly-token-quote/check-now   body: { tier?: 'pro' | 'power' }
 *
 * On-demand version of the yearly-token-sweep cron, scoped to the signed-in
 * user. The cron runs every 5 min — for the user watching the banner after
 * sending tokens, that's a long silent wait. This lets the dashboard ask
 * "did my payment land?" right now.
 *
 * Behaviour mirrors the cron exactly:
 *   1. Reconcile the user's yearly quotes whose attribution range is still
 *      open: bind the on-chain Transfer log that paid an open quote and
 *      activate or renew the subscription, and surface transfers that need an
 *      operator (including ones reaching an already settled or reviewed
 *      quote's range).
 *   2. Sweep the user's newly activated subscriptions to the treasury.
 *
 * Idempotent and compare-and-set — safe to race the cron. Heavy on-chain RPC
 * + Bankr calls, so the dashboard debounces the button.
 */

import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import {
  BILLING_V2_UNAVAILABLE_MESSAGE,
  isBillingV2ServerEnabled,
} from "@/lib/billing/billing-v2-availability";
import { reconcilePendingYearlyTokenQuotes } from "@/lib/billing/yearly-token-settlement";
import { sweepYearlyTokenSubscription, type SweepResult } from "@/lib/billing/yearly-sweep";
import { supabaseAdmin } from "@/lib/supabase";
import type { TierKey } from "@/lib/billing/tier-thresholds";

// User-facing: keep the button responsive. Quotes not reached in time are
// reconciled by the cron.
export const maxDuration = 60;
const RECONCILE_BUDGET_MS = 25_000;

function isValidTier(value: unknown): value is TierKey {
  return value === "pro" || value === "power";
}

interface PostBody {
  tier?: unknown;
}

interface PendingSweepRow {
  id: string;
  user_id: string;
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

    const body = (await req.json().catch(() => ({}))) as PostBody;
    const tier = isValidTier(body?.tier) ? body.tier : undefined;

    // Pass 1 — bind payments to this user's open quotes.
    const reconciliation = await reconcilePendingYearlyTokenQuotes({
      db: supabaseAdmin,
      userId,
      tier,
      limit: 10,
      deadlineMs: Date.now() + RECONCILE_BUDGET_MS,
    });

    // Pass 2 — sweep this user's fresh activations (the cron retries failures).
    const { data: pendingRows, error: pendingError } = await supabaseAdmin
      .from("yearly_token_subscriptions")
      .select("id, user_id")
      .eq("user_id", userId)
      .eq("sweep_status", "pending")
      .order("paid_at", { ascending: true })
      .limit(10);
    if (pendingError) throw new Error(`Failed to load pending sweeps: ${pendingError.message}`);

    const sweepResults: SweepResult[] = [];
    for (const row of (pendingRows as PendingSweepRow[] | null) ?? []) {
      sweepResults.push(await sweepYearlyTokenSubscription(row, { db: supabaseAdmin }));
    }

    return apiSuccess({
      detection: reconciliation.results,
      sweep: sweepResults,
      summary: {
        examined: reconciliation.checked,
        activated: reconciliation.activated + reconciliation.renewed,
        renewed: reconciliation.renewed,
        underconfirmed: reconciliation.underconfirmed,
        noMatch: reconciliation.noMatch,
        manualReview: reconciliation.manualReview,
        failed: reconciliation.failed,
        swept: sweepResults.filter((result) => result.outcome === "swept").length,
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
