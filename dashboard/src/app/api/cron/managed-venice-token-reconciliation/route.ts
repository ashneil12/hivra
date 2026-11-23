import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { recordCronHeartbeat } from "@/lib/cron-heartbeat";
import { reconcilePendingManagedVeniceTokenQuotes } from "@/lib/billing/managed-venice-token-reconciliation";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";

const ROUTE = "/api/cron/managed-venice-token-reconciliation";
const SOURCE = "cron:managed-venice-token-reconciliation";

// Bound an operator-supplied ?limit the same way sibling billing crons do, so a
// huge value can't be forwarded straight to the reconciler and stampede the
// Base RPC / DB.
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;
// Open quotes reconciled per scheduled tick (vercel.json calls this route
// without ?limit). The reconciler adds up to 25 settled / in-review quotes
// that still owe a surface-only pass; see its RPC budget comment.
const DEFAULT_LIMIT = 50;

export const dynamic = "force-dynamic";
// Same ceiling as the sibling Base-scanning billing cron
// (reconcile-crypto-topups). The reconciler stops starting scans well inside
// it (its time budget) and reports what it deferred, so a slow tick still
// reaches the summary log below instead of being killed mid-batch.
export const maxDuration = 300;

function readLimit(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("limit");
  if (!raw) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, parsed));
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(
      "CRON_SECRET is not configured; refusing managed Venice token reconciliation",
      new Error("CRON_SECRET missing"),
      {
        source: SOURCE,
        route: ROUTE,
        method: "GET",
        failureType: "cron_secret_missing",
      }
    );
    return apiError("Cron secret is not configured", 500);
  }

  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  // Guard the DB client presence explicitly (like sibling billing crons) so a
  // missing client returns a clear 500 rather than a generic thrown error deep
  // in the reconciler.
  if (!supabaseAdmin) {
    return apiError("Database not configured", 500);
  }

  try {
    const summary = await reconcilePendingManagedVeniceTokenQuotes({
      limit: readLimit(req),
    });

    // Read defensively: a summary is plain data and older shapes lack these.
    const deferred = {
      open: summary.deferred?.open ?? 0,
      surfacing: summary.deferred?.surfacing ?? 0,
    };
    const deferredCount = deferred.open + deferred.surfacing;
    // The once-a-day stale pass failing to LOAD produces no per-quote
    // failure, so it rides its own flag — like the crypto reconciler's
    // staleRetryLoadFailed — or the day's one pass would read as a clean
    // tick that simply found nothing.
    const staleScanLoadFailed = summary.staleScanLoadFailed === true;

    if (summary.failed > 0 || summary.manualReview > 0 || deferredCount > 0 || staleScanLoadFailed) {
      const failedQuotes = summary.results
        .filter((result) => result.status === "failed")
        .map((result) => ({
          quoteId: result.quoteId,
          userId: result.userId,
          errorName: result.errorName,
          errorMessage: result.errorMessage,
        }));

      log.warn("managed Venice token reconciliation completed with quote failures", {
        source: SOURCE,
        route: ROUTE,
        method: "GET",
        failureType: "managed_venice_token_reconciliation_partial_failure",
        checked: summary.checked,
        settled: summary.settled,
        underconfirmed: summary.underconfirmed,
        noMatch: summary.noMatch,
        manualReview: summary.manualReview,
        cancelled: summary.cancelled,
        skipped: summary.skipped,
        failed: summary.failed,
        transferSurfacing: summary.transferSurfacing,
        // Quotes the tick's time budget left for a later tick.
        deferred,
        staleScanLoadFailed,
        failedQuotes,
      });

      // log.warn alone never reaches the ops feed — a stream of failing or
      // manual-review token deposits (real money awaiting credit) would stay
      // silent, and so would a stale pass that never ran. File an ops event
      // too. Wrapped so a transport failure can't 500 the cron or mask the
      // (otherwise successful) reconciliation. A deferral alone is a delay
      // (a later tick picks those quotes up), so it is logged above, not
      // filed.
      if (summary.failed > 0 || summary.manualReview > 0 || staleScanLoadFailed) {
        try {
          await reportOpsEvent({
            source: SOURCE,
            severity: summary.failed > 0 ? "error" : "warn",
            title:
              `Managed Venice token reconciliation: ${summary.failed} failed, ` +
              `${summary.manualReview} need manual review` +
              (staleScanLoadFailed ? ", stale pass could not load" : ""),
            message:
              `Checked ${summary.checked} pending token deposit quote(s): ` +
              `${summary.settled} settled, ${summary.failed} failed, ` +
              `${summary.manualReview} flagged for manual review, ` +
              `${summary.noMatch} no on-chain match, ${summary.underconfirmed} underconfirmed. ` +
              (staleScanLoadFailed
                ? `The once-a-day stale quote pass failed to load its candidates and ` +
                  `produced no scans; it retries on the next day's first tick. ` +
                  `Failed/manual-review quotes represent real deposits awaiting credit — ` +
                  `inspect the per-quote details in logs and settle manually if needed.`
                : `Failed/manual-review quotes represent real deposits awaiting credit — ` +
                  `inspect the per-quote details in logs and settle manually if needed.`),
            route: ROUTE,
            metadata: {
              failureType: "managed_venice_token_reconciliation_partial_failure",
              recoveryAction: "inspect_failed_quotes_and_settle_manually",
              checked: summary.checked,
              settled: summary.settled,
              failed: summary.failed,
              manualReview: summary.manualReview,
              noMatch: summary.noMatch,
              underconfirmed: summary.underconfirmed,
                    skipped: summary.skipped,
              deferred,
              staleScanLoadFailed,
              failedQuotes: failedQuotes.slice(0, 25),
            },
          });
        } catch (opsError) {
          log.warn("managed Venice token reconciliation could not report ops event", {
            source: SOURCE,
            route: ROUTE,
            error: opsError instanceof Error ? opsError.message : String(opsError),
          });
        }
      }
    }

    // Honest heartbeat: failed/manual-review quotes are real deposits awaiting
    // credit — the same condition that files the ops event above must not
    // record a clean run. Deferred quotes are a delay, not a failure; a stale
    // pass that never loaded is a missed day, not a clean skip.
    await recordCronHeartbeat(
      "managed-venice-token-reconciliation",
      summary.failed > 0 || summary.manualReview > 0 || staleScanLoadFailed
        ? {
            ok: false,
            detail:
              `failed=${summary.failed} manualReview=${summary.manualReview} ` +
              `deferred=${deferredCount}` +
              (staleScanLoadFailed ? " stale_scan=load_failed" : ""),
          }
        : undefined,
    );

    return apiSuccess(summary);
  } catch (error) {
    log.error("managed Venice token reconciliation cron failed", error, {
      source: SOURCE,
      route: ROUTE,
      method: "GET",
      failureType: "managed_venice_token_reconciliation_cron_failed",
    });
    // The run threw — record the failure on the heartbeat so cron_unhealthy
    // sees it now instead of after the staleness window. Auth failures return
    // above and never reach this branch.
    await recordCronHeartbeat("managed-venice-token-reconciliation", {
      ok: false,
      detail: `exception: ${error instanceof Error ? error.name : typeof error}`,
    });
    return apiError("Failed to reconcile managed Venice token deposits", 500);
  }
}
