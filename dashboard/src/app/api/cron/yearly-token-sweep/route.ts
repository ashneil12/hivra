/**
 * Yearly token-payment cron.
 *
 * Passes per tick:
 *
 *   1. Reconcile — for every yearly quote whose attribution range is still
 *      open (newest first; see lib/billing/yearly-token-settlement): bind the
 *      on-chain Transfer log that paid an open quote and activate or renew
 *      the subscription; surface under-paid, over-paid, late and extra
 *      transfers for manual review — including transfers that reach a quote
 *      after it settled or went to review, which stays watched until its
 *      range is fully confirmed; retire quotes nobody paid.
 *
 *   1b. Flag yearly payments that a managed-Venice review recorded (canary's
 *      pre-attribution Venice flow), so they are not credited twice.
 *
 *   2. Sweep — move each activated subscription's own payment from the
 *      deposit wallet the quote used to HERMES_TREASURY_ADDRESS via a
 *      single-recipient-scoped Bankr API key (lib/billing/yearly-sweep).
 *
 * Every step is idempotent and compare-and-set, so overlapping ticks and a
 * user's check-now can run concurrently.
 */

import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import {
  flagYearlyPaymentsInManagedVeniceReviews,
  reconcilePendingYearlyTokenQuotes,
} from "@/lib/billing/yearly-token-settlement";
import { sweepPendingYearlyTokenSubscriptions } from "@/lib/billing/yearly-sweep";

// Each open quote costs a handful of Base RPC calls (block search, one
// eth_getLogs per 2,000 blocks); each RPC call times out after 10 s and is
// retried. Stop starting new quotes well before the platform limit so the
// sweep pass always runs; leftovers are picked up next tick.
export const maxDuration = 300;
const RECONCILE_BUDGET_MS = 120_000;

function parseLimit(url: URL, fallback: number, max: number): number {
  const raw = url.searchParams.get("limit");
  const n = raw ? Number(raw) : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("missing CRON_SECRET"), {
      source: "yearly-token-sweep",
      route: "/api/cron/yearly-token-sweep",
      method: "GET",
    });
    return apiError("Cron secret not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }
  if (!supabaseAdmin) {
    return apiError("Database not configured", 500);
  }

  const url = new URL(req.url);
  const now = new Date();

  // ─── Pass 1: bind payments to quotes ────────────────────────────────
  let reconciliation;
  try {
    reconciliation = await reconcilePendingYearlyTokenQuotes({
      db: supabaseAdmin,
      limit: parseLimit(url, 25, 100),
      now,
      deadlineMs: now.getTime() + RECONCILE_BUDGET_MS,
    });
  } catch (error) {
    log.error("yearly-token-sweep failed to load reconcilable quotes", error, {
      source: "yearly-token-sweep",
      route: "/api/cron/yearly-token-sweep",
      method: "GET",
      failureType: "yearly_token_sweep_quotes_load_failed",
    });
    return apiError("Failed to load yearly quotes", 500);
  }

  // ─── Pass 1b: flag yearly payments a managed-Venice review recorded ──
  // Best-effort operator signal; never blocks the sweep.
  let veniceReviewConflicts: { flagged: number } | { error: string };
  try {
    veniceReviewConflicts = await flagYearlyPaymentsInManagedVeniceReviews({ db: supabaseAdmin });
  } catch (error) {
    log.error("yearly-token-sweep failed to cross-check managed Venice reviews", error, {
      source: "yearly-token-sweep",
      route: "/api/cron/yearly-token-sweep",
      method: "GET",
      failureType: "yearly_token_venice_review_cross_check_failed",
    });
    veniceReviewConflicts = { error: error instanceof Error ? error.message : String(error) };
  }

  // ─── Pass 2: sweep activated subscriptions to treasury ──────────────
  let sweep;
  try {
    sweep = await sweepPendingYearlyTokenSubscriptions({
      db: supabaseAdmin,
      limit: parseLimit(url, 50, 200),
      now,
    });
  } catch (error) {
    log.error("yearly-token-sweep failed to load the sweep queue", error, {
      source: "yearly-token-sweep",
      route: "/api/cron/yearly-token-sweep",
      method: "GET",
      failureType: "yearly_token_sweep_pending_load_failed",
    });
    return apiError("Failed to load pending sweeps", 500);
  }

  return apiSuccess({
    ranAt: now.toISOString(),
    reconciliation,
    veniceReviewConflicts,
    sweep,
  });
}
