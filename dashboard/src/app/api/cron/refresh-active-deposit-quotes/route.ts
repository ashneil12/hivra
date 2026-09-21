/**
 * GET /api/cron/refresh-active-deposit-quotes
 *
 * Tight-loop chain refresh for users who are mid-deposit. The general
 * `refresh-token-holdings` cron only runs every 6 hours, which means
 * a user who deposits during their 20-minute quote window can sit on
 * the wallet page seeing the explorer credit before the dashboard
 * does — for hours. This cron narrows that window to ~1 minute by
 * re-reading the on-chain balance against the user's hermesos_lock
 * wallet for every user with an active (non-expired) deposit_quotes
 * row, then re-evaluating tier eligibility.
 *
 * Scoping is what makes the every-minute cadence cheap: the active
 * quote set is bounded by user demand, expires automatically after
 * 20 min, and only fires one Base RPC read + one snapshot insert per
 * affected user per tick.
 */
import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import {
  normalizeNumericToBigIntString,
  refreshPrimaryHermesTokenHolding,
} from "@/lib/billing/token-holdings";
import { evaluateAndRecordTokenTierEligibility } from "@/lib/billing/token-tier-eligibility";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";

interface ActiveQuoteUserRow {
  user_id: string;
}

const LOG_CONTEXT = {
  source: "cron/refresh-active-deposit-quotes",
  route: "/api/cron/refresh-active-deposit-quotes",
  method: "GET",
};

async function fetchUsersWithActiveQuotes(now: Date): Promise<string[]> {
  if (!supabaseAdmin) return [];
  const { data, error } = await supabaseAdmin
    .from("deposit_quotes")
    .select("user_id")
    .eq("status", "active")
    .gt("expires_at", now.toISOString());

  // Do NOT swallow a query error as []. Returning [] makes the every-minute
  // cron silently report checked:0 — indistinguishable from "nobody is
  // depositing" — so a Supabase outage during a live deposit would delay user
  // credits with no signal. Throw so the caller's catch reports it (500 + ops
  // event) instead of reporting a falsely-clean run.
  if (error) {
    throw new Error(
      `deposit_quotes query failed: ${error.message || error.code || "unknown"}`,
    );
  }
  if (!Array.isArray(data)) return [];

  const seen = new Set<string>();
  for (const row of data as ActiveQuoteUserRow[]) {
    if (row.user_id) seen.add(row.user_id);
  }
  return Array.from(seen);
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return apiError("Cron secret is not configured", 500, undefined, undefined, {
      ...LOG_CONTEXT,
      failureType: "cron_secret_missing",
    });
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401, undefined, undefined, LOG_CONTEXT);
  }

  try {
    const now = new Date();
    const userIds = await fetchUsersWithActiveQuotes(now);

    let refreshed = 0;
    let noWallet = 0;
    let failed = 0;
    let evaluated = 0;
    let evaluationFailures = 0;

    // Cron runs every minute. Sequential per-user RPC was the dominant
    // cost (2 Base RPC calls per user, sequentially) — at 20+ active
    // depositors a slow Base tick could blow past the 60s function
    // ceiling. Process users in bounded-concurrency batches so the wall
    // time scales with batch size, not user count. Per-user errors are
    // isolated so one slow / failing wallet doesn't block the rest.
    const BATCH_SIZE = 8;
    for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
      const batch = userIds.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (userId) => {
          const result = await refreshPrimaryHermesTokenHolding({ userId });
          if (result.status !== "refreshed" || !result.snapshot) {
            return { userId, kind: "no_wallet" as const };
          }
          try {
            await evaluateAndRecordTokenTierEligibility({
              userId,
              currentBalance: BigInt(
                normalizeNumericToBigIntString(result.snapshot.balanceRaw)
              ),
            });
            return { userId, kind: "ok" as const };
          } catch (eligErr) {
            log.warn("active deposit quote eligibility evaluation failed", {
              ...LOG_CONTEXT,
              userId,
              failureType: "active_deposit_quote_eligibility_failed",
            }, eligErr);
            return { userId, kind: "eval_failed" as const };
          }
        })
      );
      for (const r of results) {
        if (r.status === "rejected") {
          failed += 1;
          log.error("active deposit quote holding refresh failed", r.reason, {
            ...LOG_CONTEXT,
            failureType: "active_deposit_quote_holding_refresh_failed",
          });
          continue;
        }
        switch (r.value.kind) {
          case "no_wallet":
            noWallet += 1;
            break;
          case "ok":
            refreshed += 1;
            evaluated += 1;
            break;
          case "eval_failed":
            refreshed += 1;
            evaluationFailures += 1;
            break;
        }
      }
    }

    // A burst of failed per-user refreshes while users are mid-deposit directly
    // delays their credits — a persistent Base-RPC outage is exactly the case
    // worth an ops alert. Only fire when every checked user failed (a systemic
    // outage), so the odd flaky wallet doesn't spam the feed. Best-effort.
    if (userIds.length > 0 && failed === userIds.length) {
      await reportOpsEvent({
        source: "cron.refresh-active-deposit-quotes",
        severity: "warn",
        title: "Active deposit-quote refresh failing for all users",
        message:
          `All ${userIds.length} user(s) with an active deposit quote failed to refresh ` +
          `their on-chain balance this tick (likely a Base RPC outage). Mid-deposit users ` +
          `will see credits delayed up to ~6h until this clears.`,
        route: "/api/cron/refresh-active-deposit-quotes",
        metadata: {
          failureType: "active_deposit_quote_refresh_all_failed",
          checked: userIds.length,
          failed,
        },
      });
    }

    return apiSuccess({
      checked: userIds.length,
      refreshed,
      noWallet,
      failed,
      evaluated,
      evaluationFailures,
    });
  } catch (error) {
    // The DB-query failure (fetchUsersWithActiveQuotes throwing) and any other
    // top-level failure land here. Surface it on the ops feed so a Supabase
    // outage that blinds the every-minute cron isn't invisible.
    await reportOpsEvent({
      source: "cron.refresh-active-deposit-quotes",
      severity: "warn",
      title: "Active deposit-quote refresh cron failed",
      message:
        `refresh-active-deposit-quotes failed before completing this tick. While it is down, ` +
        `mid-deposit users' credits and tier eligibility are not updated on the ~1-minute ` +
        `cadence (they fall back to the 6h refresh-token-holdings cron).`,
      route: "/api/cron/refresh-active-deposit-quotes",
      metadata: {
        failureType: "active_deposit_quote_refresh_failed",
        errorName: error instanceof Error ? error.name : typeof error,
      },
    });
    return apiError("Failed to refresh active deposit quotes", 500, {
      failureType: "active_deposit_quote_refresh_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    }, undefined, {
      ...LOG_CONTEXT,
      failureType: "active_deposit_quote_refresh_failed",
      cause: error,
    });
  }
}
