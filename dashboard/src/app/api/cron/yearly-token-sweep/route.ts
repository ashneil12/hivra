/**
 * Yearly token-sweep cron.
 *
 * Two passes per tick:
 *
 *   1. Detect & activate — for every active yearly_token_quote, read
 *      the credit_deposit wallet's balance; if ≥ tokens_required,
 *      consume the quote and insert a yearly_token_subscriptions row
 *      with status=active, sweep_status=pending.
 *
 *   2. Sweep — for every yearly_token_subscriptions row with
 *      sweep_status=pending, send the wallet's full $HERMESOS balance
 *      to HERMES_TREASURY_ADDRESS via a single-recipient-scoped Bankr
 *      API key. On success → sweep_status=swept; on failure →
 *      sweep_status=failed (auto-retried next tick).
 *
 * Idempotent on every step. Safe to run as often as Vercel allows; the
 * unique partial index on (user_id, tier) where status in
 * ('active','grace') prevents duplicate activations even under
 * concurrent ticks.
 */

import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";
import {
  detectAndActivateYearlyDeposit,
  sweepActivatedSubscription,
  type DetectionResult,
  type SweepResult,
} from "@/lib/billing/yearly-sweep";

// A row that has been retried but last attempted within this window is left
// alone this tick — backoff so a persistently-failing sweep (e.g. bad treasury
// address) doesn't burn Bankr/gas calls every 5 minutes. Rows that have never
// been attempted (sweep_attempted_at null, i.e. fresh 'pending') are always
// eligible. Conservative: well under the activation cadence, so legitimate
// transient failures still retry promptly.
const SWEEP_RETRY_BACKOFF_MS = 30 * 60 * 1000; // 30 min
// A row still failing this long after its first failure is a stuck sweep worth
// an operator alert (a transient failure clears well inside this window).
const SWEEP_STUCK_ALERT_MS = 6 * 60 * 60 * 1000; // 6 h
import {
  getActiveYearlyTokenQuotes,
  type YearlyTokenQuote,
} from "@/lib/billing/yearly-token-quotes";

interface ActiveQuoteRow {
  id: string;
  user_id: string;
}

interface PendingSweepRow {
  id: string;
  user_id: string;
  amount_received_raw: string;
  sweep_status?: string | null;
  sweep_attempted_at?: string | null;
}

function parseLimit(url: URL, fallback = 50, max = 200): number {
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
  const limit = parseLimit(url);
  const now = new Date();

  // ─── Pass 1: detect deposits + activate subscriptions ──────────────
  const { data: activeRows, error: activeErr } = await supabaseAdmin
    .from("yearly_token_quotes")
    .select("user_id")
    .eq("status", "active")
    .gt("expires_at", now.toISOString())
    .limit(limit);

  if (activeErr) {
    log.error("yearly-token-sweep failed to load active quotes", new Error(activeErr.message), {
      source: "yearly-token-sweep",
      route: "/api/cron/yearly-token-sweep",
      method: "GET",
      failureType: "yearly_token_sweep_active_quotes_load_failed",
    });
    return apiError(`Failed to load active quotes: ${activeErr.message}`, 500);
  }

  const userIds = Array.from(
    new Set((activeRows as Pick<ActiveQuoteRow, "user_id">[] | null)?.map((r) => r.user_id) ?? [])
  );

  const detectionResults: DetectionResult[] = [];
  for (const userId of userIds) {
    const quotes = await getActiveYearlyTokenQuotes(userId, now);
    for (const quote of quotes) {
      const result = await detectAndActivateYearlyDeposit(quote as YearlyTokenQuote, { now });
      detectionResults.push(result);
    }
  }

  // ─── Pass 2: sweep activated subs to treasury ──────────────────────
  // Pull rows that are either still pending OR previously failed. The
  // sweep doc-string promises "auto-retried next tick" — without this,
  // rows flipped to `failed` (e.g. by a transient
  // HERMES_TREASURY_ADDRESS misconfig) were never re-examined and
  // required manual intervention.
  const { data: pendingRows, error: pendingErr } = await supabaseAdmin
    .from("yearly_token_subscriptions")
    .select("id, user_id, amount_received_raw::text, sweep_status, sweep_attempted_at")
    .in("sweep_status", ["pending", "failed"])
    .order("paid_at", { ascending: true })
    .limit(limit);

  if (pendingErr) {
    log.error("yearly-token-sweep failed to load pending sweeps", new Error(pendingErr.message), {
      source: "yearly-token-sweep",
      route: "/api/cron/yearly-token-sweep",
      method: "GET",
      failureType: "yearly_token_sweep_pending_load_failed",
    });
    return apiError(`Failed to load pending sweeps: ${pendingErr.message}`, 500);
  }

  const sweepResults: SweepResult[] = [];
  let sweepBackoffSkipped = 0;
  const stuckSweeps: Array<{ subscriptionId: string; userId: string; stuckMs: number }> = [];
  for (const row of (pendingRows as PendingSweepRow[] | null) ?? []) {
    const lastAttemptMs = row.sweep_attempted_at
      ? new Date(row.sweep_attempted_at).getTime()
      : null;
    const sinceLastAttempt =
      lastAttemptMs && Number.isFinite(lastAttemptMs) ? now.getTime() - lastAttemptMs : null;

    // A previously-failed row that was attempted very recently is held off this
    // tick (backoff). Fresh 'pending' rows (never attempted) are never skipped,
    // so first-time sweeps still settle immediately. This bounds wasted
    // Bankr/gas calls on a persistent misconfig without changing any amount or
    // the eventual retry behaviour.
    if (
      row.sweep_status === "failed" &&
      sinceLastAttempt !== null &&
      sinceLastAttempt < SWEEP_RETRY_BACKOFF_MS
    ) {
      sweepBackoffSkipped += 1;
      continue;
    }

    // Track rows that have been stuck failing for a long time so we can alert
    // once below — a persistent failure (e.g. bad HERMES_TREASURY_ADDRESS) was
    // previously only visible in the JSON counts.
    if (
      row.sweep_status === "failed" &&
      sinceLastAttempt !== null &&
      sinceLastAttempt >= SWEEP_STUCK_ALERT_MS
    ) {
      stuckSweeps.push({
        subscriptionId: row.id,
        userId: row.user_id,
        stuckMs: sinceLastAttempt,
      });
    }

    try {
      const result = await sweepActivatedSubscription(row);
      sweepResults.push(result);
    } catch (err) {
      // One bad sweep MUST NOT take out the whole cron — the loop has to
      // keep going so other users' subscriptions still settle. Mark the
      // outcome as transfer_failed and move on; the row stays in
      // sweep_status='pending'/'failed' and we'll retry next tick.
      log.error("sweep crashed unexpectedly; continuing", err, {
        source: "yearly-token-sweep",
        route: "/api/cron/yearly-token-sweep",
        method: "GET",
        subscriptionId: row.id,
        userId: row.user_id,
        failureType: "sweep_uncaught_error",
      });
      sweepResults.push({
        subscriptionId: row.id,
        userId: row.user_id,
        outcome: "transfer_failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // A row stuck failing past the alert window is a real funds-movement problem
  // (almost always a misconfig like a bad treasury address) — surface it once
  // on the ops feed so it's not silently retried forever. Deduped per-run.
  if (stuckSweeps.length > 0) {
    await reportOpsEvent({
      source: "cron.yearly-token-sweep",
      severity: "warn",
      title: `${stuckSweeps.length} yearly-token sweep(s) stuck failing`,
      message:
        `${stuckSweeps.length} yearly-token subscription sweep(s) have been failing for over ` +
        `${Math.round(SWEEP_STUCK_ALERT_MS / 3_600_000)}h. Their $HERMES balance is not reaching ` +
        `the treasury. This usually means a misconfig (e.g. HERMES_TREASURY_ADDRESS) — investigate ` +
        `rather than letting the cron retry indefinitely.`,
      route: "/api/cron/yearly-token-sweep",
      metadata: {
        failureType: "yearly_token_sweep_stuck",
        stuckCount: stuckSweeps.length,
        sample: stuckSweeps.slice(0, 25).map((s) => ({
          subscriptionId: s.subscriptionId,
          userId: s.userId,
          stuckHours: Math.round(s.stuckMs / 3_600_000),
        })),
      },
    });
  }

  return apiSuccess({
    ranAt: now.toISOString(),
    sweepBackoffSkipped,
    sweepStuck: stuckSweeps.length,
    detection: {
      examinedUsers: userIds.length,
      examinedQuotes: detectionResults.length,
      activated: detectionResults.filter((r) => r.outcome === "activated").length,
      alreadyActive: detectionResults.filter((r) => r.outcome === "already_active").length,
      noBalance: detectionResults.filter((r) => r.outcome === "no_balance").length,
      insufficient: detectionResults.filter((r) => r.outcome === "insufficient_balance").length,
      errors: detectionResults.filter((r) => r.outcome === "error").length,
      results: detectionResults,
    },
    sweep: {
      examined: sweepResults.length,
      swept: sweepResults.filter((r) => r.outcome === "swept").length,
      noBalance: sweepResults.filter((r) => r.outcome === "no_balance").length,
      treasuryNotConfigured: sweepResults.filter((r) => r.outcome === "no_treasury_configured").length,
      transferFailed: sweepResults.filter((r) => r.outcome === "transfer_failed").length,
      gasTopupFailed: sweepResults.filter((r) => r.outcome === "gas_topup_failed").length,
      results: sweepResults,
    },
  });
}
