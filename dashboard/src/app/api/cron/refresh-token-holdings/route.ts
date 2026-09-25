import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import {
  refreshVerifiedHermesTokenHoldings,
} from "@/lib/billing/token-holdings";
import {
  fetchLatestPlatformTokenBalancesByUser,
  fetchLatestVvvSnapshotsByUser,
} from "@/lib/billing/token-holding-snapshots";
import { resolveTokenAccessForUsers } from "@/lib/billing/token-access";
import { PLATFORM_TOKEN_KEYS, type PlatformTokenKey } from "@/lib/billing/token-registry";
import {
  evaluateAndRecordTokenTierEligibility,
  type EligibilityResult,
  type EligibilityTransition,
  type TierKey,
} from "@/lib/billing/token-tier-eligibility";
import { fetchVvvPriceUsd } from "@/lib/billing/price-feed";
import {
  evaluateAndRecordVeniceComputeBoost,
  type VeniceBoostTransition,
} from "@/lib/billing/venice-compute-boost";
import { sendTierEligibilityNotification } from "@/lib/email/tier-eligibility-notifications";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";

/**
 * The balance of an account whose token standing has no verification wallet
 * behind it: zero in every platform token. Judging it (rather than skipping
 * it) is what breaches a qualification whose wallet is gone; skipping it left
 * `currently_eligible` true forever.
 */
function zeroPlatformTokenBalances(): Partial<Record<PlatformTokenKey, bigint>> {
  return Object.fromEntries(PLATFORM_TOKEN_KEYS.map((key) => [key, 0n]));
}

function parseLimit(req: NextRequest) {
  const raw = new URL(req.url).searchParams.get("limit");
  const value = raw ? Number(raw) : 100;
  if (!Number.isFinite(value)) return 100;
  return Math.max(1, Math.min(100, Math.floor(value)));
}

interface EligibilitySummary {
  userId: string;
  tier: TierKey;
  transition: EligibilityTransition;
}

function summariseEligibility(userId: string, evaluation: EligibilityResult): EligibilitySummary[] {
  const out: EligibilitySummary[] = [];
  if (evaluation.pro && evaluation.pro.transition !== "unchanged") {
    out.push({ userId, tier: "pro", transition: evaluation.pro.transition });
  }
  if (evaluation.power && evaluation.power.transition !== "unchanged") {
    out.push({ userId, tier: "power", transition: evaluation.power.transition });
  }
  return out;
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("missing CRON_SECRET"), {
      source: "refresh-token-holdings",
      route: "/api/cron/refresh-token-holdings",
      method: "GET",
      failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }

  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  try {
    const refreshResult = await refreshVerifiedHermesTokenHoldings({
      lane: "token_holdings",
      limit: parseLimit(req),
    });

    // Refresh has run; now drive eligibility evaluation off the freshest
    // balance per user. Users whose refresh succeeded are judged on their
    // latest snapshot. Users with standing but no verification wallet are
    // judged at a zero balance. Users whose read failed (transient RPC error)
    // are left for the next run: a failed read is not a zero balance.
    const refreshedUserIds = (refreshResult.results ?? [])
      .filter((r) => r.status === "refreshed")
      .map((r) => r.userId);
    const unbackedUserIds = (refreshResult.results ?? [])
      .filter((r) => r.status === "no_verified_wallet")
      .map((r) => r.userId);
    const evaluatedUserIds = [...refreshedUserIds, ...unbackedUserIds];

    const balancesByUser = await fetchLatestPlatformTokenBalancesByUser(refreshedUserIds);
    for (const userId of unbackedUserIds) balancesByUser.set(userId, zeroPlatformTokenBalances());
    const accessByUser = await resolveTokenAccessForUsers(evaluatedUserIds);

    const transitions: EligibilitySummary[] = [];
    const eligibilityWarnings: string[] = [];
    let evaluated = 0;
    let evaluationFailures = 0;

    // Process users in bounded-concurrency batches. Sequential processing
    // had email-send (~200-500ms each via Resend) dominating wall time; at
    // limit=100 users that's potentially 10-50s just on emails. Eligibility
    // writes are independent per user, and email send is best-effort, so
    // batching is safe.
    const BATCH_SIZE = 10;
    const allEmailPromises: Promise<unknown>[] = [];
    for (let i = 0; i < evaluatedUserIds.length; i += BATCH_SIZE) {
      const batch = evaluatedUserIds.slice(i, i + BATCH_SIZE);
      const evalResults = await Promise.allSettled(
        batch.map(async (userId) => {
          const balances = balancesByUser.get(userId);
          if (!balances) return null;
          const evaluation = await evaluateAndRecordTokenTierEligibility({
            userId,
            balances,
            access: accessByUser.get(userId),
          });
          return { userId, balances, evaluation };
        })
      );

      for (let j = 0; j < evalResults.length; j++) {
        const r = evalResults[j];
        const userId = batch[j];
        if (r.status === "rejected") {
          evaluationFailures += 1;
          log.warn("token holding eligibility evaluation failed", {
            source: "refresh-token-holdings",
            route: "/api/cron/refresh-token-holdings",
            method: "GET",
            userId,
            failureType: "token_holding_eligibility_evaluation_failed",
          }, r.reason);
          continue;
        }
        if (!r.value) continue;
        const { evaluation } = r.value;
        evaluated += 1;
        // Surface each distinct warning (e.g. a price outage that skipped new
        // thresholds) once per cron tick rather than once per user.
        for (const warning of evaluation.warnings) {
          if (warning.startsWith("Live ") && !eligibilityWarnings.includes(warning)) {
            eligibilityWarnings.push(warning);
          }
        }
        const userTransitions = summariseEligibility(userId, evaluation);
        transitions.push(...userTransitions);

        // Fire emails as background promises and collect them; we'll await
        // them all at the end with allSettled. Errors are logged per email
        // so one Resend hiccup doesn't block the cron.
        for (const t of userTransitions) {
          allEmailPromises.push(
            sendTierEligibilityNotification({
              userId: t.userId,
              tier: t.tier,
              transition: t.transition,
              // The balance of the token this tier is held in.
              currentBalance: (t.tier === "pro" ? evaluation.pro : evaluation.power)?.balance ?? 0n,
              evaluation,
            }).catch((err) => {
              log.warn("token holding eligibility email dispatch failed", {
                source: "refresh-token-holdings",
                route: "/api/cron/refresh-token-holdings",
                method: "GET",
                userId: t.userId,
                tier: t.tier,
                transition: t.transition,
                failureType: "token_holding_eligibility_email_failed",
              }, err);
            })
          );
        }
      }
    }

    // Await all email dispatches (best-effort) so they actually run before
    // the function returns. If a few are slow they finish in parallel, not
    // serially.
    await Promise.allSettled(allEmailPromises);

    // Venice compute boost: value each refreshed user's VVV holding against
    // the $199 threshold and persist eligibility. The DEX price is fetched
    // once per tick; if the feed is down we skip the whole step so a
    // transient oracle outage never flips existing holders off — their
    // qualification rows are untouched and the next tick re-evaluates.
    const veniceBoostTransitions: Array<{
      userId: string;
      transition: VeniceBoostTransition;
    }> = [];
    let veniceBoostEvaluated = 0;
    let veniceBoostEligible = 0;
    let veniceBoostFailures = 0;
    let veniceBoostWarning: string | undefined;
    try {
      const priceQuote = await fetchVvvPriceUsd();
      const vvvByUser = await fetchLatestVvvSnapshotsByUser(refreshedUserIds);
      // No verification wallet: the boost's VVV holding is zero too.
      for (const userId of unbackedUserIds) vvvByUser.set(userId, 0n);
      for (let i = 0; i < evaluatedUserIds.length; i += BATCH_SIZE) {
        const batch = evaluatedUserIds.slice(i, i + BATCH_SIZE);
        const boostResults = await Promise.allSettled(
          batch.map(async (userId) => {
            const balance = vvvByUser.get(userId);
            if (balance === undefined) return null;
            const result = await evaluateAndRecordVeniceComputeBoost({
              userId,
              vvvBalanceRaw: balance,
              vvvPriceUsd: priceQuote.priceUsd,
            });
            return { userId, result };
          })
        );
        for (const r of boostResults) {
          if (r.status === "rejected") {
            veniceBoostFailures += 1;
            log.warn(
              "venice compute boost evaluation failed",
              {
                source: "refresh-token-holdings",
                route: "/api/cron/refresh-token-holdings",
                method: "GET",
                failureType: "venice_boost_evaluation_failed",
              },
              r.reason
            );
            continue;
          }
          if (!r.value) continue;
          veniceBoostEvaluated += 1;
          if (r.value.result.eligible) veniceBoostEligible += 1;
          if (r.value.result.transition !== "unchanged") {
            veniceBoostTransitions.push({
              userId: r.value.userId,
              transition: r.value.result.transition,
            });
          }
        }
      }
    } catch (err) {
      veniceBoostWarning = `VVV price feed unavailable; compute-boost evaluation skipped: ${
        err instanceof Error ? err.message : String(err)
      }`;
      log.warn(
        "venice compute boost step skipped",
        {
          source: "refresh-token-holdings",
          route: "/api/cron/refresh-token-holdings",
          method: "GET",
          failureType: "venice_boost_step_skipped",
        },
        err
      );
    }

    // Surface systemic eligibility / boost write failures on the ops feed.
    // Per-user failures are isolated + counted, but a count buried in the JSON
    // is invisible — a wholesale eligibility-write or email outage should page.
    // Fire only when something was attempted AND everything failed (systemic),
    // so the odd flaky user doesn't spam the feed.
    if (
      (evaluated === 0 && evaluationFailures > 0) ||
      (veniceBoostEvaluated === 0 && veniceBoostFailures > 0)
    ) {
      await reportOpsEvent({
        source: "cron.refresh-token-holdings",
        severity: "warn",
        title: "Token-holding eligibility/boost evaluation failing systemically",
        message:
          `refresh-token-holdings recorded ${evaluationFailures} eligibility failure(s) ` +
          `(0 succeeded) and ${veniceBoostFailures} venice-boost failure(s) this tick. ` +
          `Token holders may not be getting the entitlements their balance earns until this clears.`,
        route: "/api/cron/refresh-token-holdings",
        metadata: {
          failureType: "token_holding_eligibility_systemic_failure",
          evaluated,
          evaluationFailures,
          veniceBoostEvaluated,
          veniceBoostFailures,
        },
      });
    }

    return apiSuccess({
      ...refreshResult,
      eligibility: {
        evaluated,
        evaluationFailures,
        transitions,
        warnings: eligibilityWarnings,
      },
      veniceBoost: {
        evaluated: veniceBoostEvaluated,
        eligible: veniceBoostEligible,
        failures: veniceBoostFailures,
        transitions: veniceBoostTransitions,
        ...(veniceBoostWarning ? { warning: veniceBoostWarning } : {}),
      },
    });
  } catch (error) {
    return apiError("Failed to refresh token holdings", 500, {
      failureType: "token_holding_cron_refresh_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
