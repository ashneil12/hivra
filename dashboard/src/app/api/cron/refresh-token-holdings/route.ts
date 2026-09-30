import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import {
  refreshVerifiedHermesTokenHoldings,
  type TokenHoldingJudgePage,
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
import { fetchVvvPriceUsd, type HermesPriceQuote } from "@/lib/billing/price-feed";
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

// Reads, evaluations and emails all happen inside the refresh run, page by
// page. The run stops starting reads after the budget; the page in hand is
// still judged, then the run closes, well inside maxDuration.
export const maxDuration = 300;
const REFRESH_TIME_BUDGET_MS = 180_000;
// Eligibility writes are independent per user and email is best-effort, so
// each page is evaluated in bounded-concurrency batches. Sequential processing
// had email sends (~200-500ms each via Resend) dominating wall time.
const BATCH_SIZE = 10;

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

interface VeniceBoostSummary {
  userId: string;
  transition: VeniceBoostTransition;
}

/**
 * Judges each page of reads the refresh run hands over: Pro/Power eligibility
 * and the Venice compute boost, for every account whose read gave a balance.
 * An account counts as judged only when its eligibility evaluation ran and its
 * boost evaluation did not fail; the run records exactly those, and the next
 * run reads the rest ahead of every account judged since.
 */
function createHoldingsJudge() {
  const eligibility = {
    evaluated: 0,
    evaluationFailures: 0,
    transitions: [] as EligibilitySummary[],
    warnings: [] as string[],
  };
  const veniceBoost = {
    evaluated: 0,
    eligible: 0,
    failures: 0,
    transitions: [] as VeniceBoostSummary[],
    warning: undefined as string | undefined,
  };

  // The VVV/USD price is fetched once per run. If the feed is down the boost
  // step is skipped for the whole run, so a transient oracle outage never flips
  // existing holders off: their qualification rows are untouched and the next
  // run re-evaluates. That skip does not stop an account being judged.
  let vvvPrice: Promise<HermesPriceQuote | null> | null = null;
  const loadVvvPrice = () => {
    vvvPrice ??= fetchVvvPriceUsd().catch((err: unknown) => {
      veniceBoost.warning = `VVV price feed unavailable; compute-boost evaluation skipped: ${
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
      return null;
    });
    return vvvPrice;
  };

  const judgePage: TokenHoldingJudgePage = async (reads) => {
    // Accounts whose read succeeded are judged on their latest snapshot.
    // Accounts with standing but no verification wallet are judged at a zero
    // balance. Accounts whose read failed (transient RPC error) are not judged
    // at all: a failed read is not a zero balance, and the next run reads
    // them again.
    const refreshedUserIds = reads.filter((r) => r.status === "refreshed").map((r) => r.userId);
    const unbackedUserIds = reads.filter((r) => r.status === "no_verified_wallet").map((r) => r.userId);
    const evaluatedUserIds = [...refreshedUserIds, ...unbackedUserIds];
    if (evaluatedUserIds.length === 0) return [];

    // A failure loading balances or token access throws: the page is not
    // recorded as judged and the run fails loudly.
    const balancesByUser = await fetchLatestPlatformTokenBalancesByUser(refreshedUserIds);
    for (const userId of unbackedUserIds) balancesByUser.set(userId, zeroPlatformTokenBalances());
    const accessByUser = await resolveTokenAccessForUsers(evaluatedUserIds);

    const eligibilityJudged = new Set<string>();
    const emailPromises: Promise<unknown>[] = [];
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
          eligibility.evaluationFailures += 1;
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
        eligibility.evaluated += 1;
        eligibilityJudged.add(userId);
        // Surface each distinct warning (e.g. a price outage that skipped new
        // thresholds) once per cron run rather than once per user.
        for (const warning of evaluation.warnings) {
          if (warning.startsWith("Live ") && !eligibility.warnings.includes(warning)) {
            eligibility.warnings.push(warning);
          }
        }
        const userTransitions = summariseEligibility(userId, evaluation);
        eligibility.transitions.push(...userTransitions);

        // Fire emails as background promises and await them all at the end of
        // the page with allSettled. Errors are logged per email so one Resend
        // hiccup doesn't block the cron.
        for (const t of userTransitions) {
          emailPromises.push(
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
    await Promise.allSettled(emailPromises);

    // Venice compute boost: value each account's VVV holding against the $199
    // threshold and persist eligibility.
    const boostFailed = new Set<string>();
    const priceQuote = await loadVvvPrice();
    if (priceQuote) {
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
        for (let j = 0; j < boostResults.length; j++) {
          const r = boostResults[j];
          if (r.status === "rejected") {
            veniceBoost.failures += 1;
            boostFailed.add(batch[j]);
            log.warn(
              "venice compute boost evaluation failed",
              {
                source: "refresh-token-holdings",
                route: "/api/cron/refresh-token-holdings",
                method: "GET",
                userId: batch[j],
                failureType: "venice_boost_evaluation_failed",
              },
              r.reason
            );
            continue;
          }
          if (!r.value) continue;
          veniceBoost.evaluated += 1;
          if (r.value.result.eligible) veniceBoost.eligible += 1;
          if (r.value.result.transition !== "unchanged") {
            veniceBoost.transitions.push({
              userId: r.value.userId,
              transition: r.value.result.transition,
            });
          }
        }
      }
    }

    return evaluatedUserIds.filter((userId) => eligibilityJudged.has(userId) && !boostFailed.has(userId));
  };

  return { judgePage, eligibility, veniceBoost };
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
    const judge = createHoldingsJudge();
    // Accounts with Pro/Power, Venice boost or lock-wallet standing are all
    // read and judged on every run; plain verified wallets get what capacity
    // is left (at most `limit`). Only accounts actually judged are recorded,
    // so the next run retries a failed read or evaluation ahead of every
    // account judged since.
    const refreshResult = await refreshVerifiedHermesTokenHoldings({
      lane: "token_holdings",
      limit: parseLimit(req),
      timeBudgetMs: REFRESH_TIME_BUDGET_MS,
      judgePage: judge.judgePage,
    });
    const { eligibility, veniceBoost } = judge;

    // Surface systemic eligibility / boost write failures on the ops feed.
    // Per-user failures are isolated + counted, but a count buried in the JSON
    // is invisible — a wholesale eligibility-write or email outage should page.
    // Fire only when something was attempted AND everything failed (systemic),
    // so the odd flaky user doesn't spam the feed.
    if (
      (eligibility.evaluated === 0 && eligibility.evaluationFailures > 0) ||
      (veniceBoost.evaluated === 0 && veniceBoost.failures > 0)
    ) {
      await reportOpsEvent({
        source: "cron.refresh-token-holdings",
        severity: "warn",
        title: "Token-holding eligibility/boost evaluation failing systemically",
        message:
          `refresh-token-holdings recorded ${eligibility.evaluationFailures} eligibility failure(s) ` +
          `(0 succeeded) and ${veniceBoost.failures} venice-boost failure(s) this tick. ` +
          `Token holders may not be getting the entitlements their balance earns until this clears.`,
        route: "/api/cron/refresh-token-holdings",
        metadata: {
          failureType: "token_holding_eligibility_systemic_failure",
          evaluated: eligibility.evaluated,
          evaluationFailures: eligibility.evaluationFailures,
          veniceBoostEvaluated: veniceBoost.evaluated,
          veniceBoostFailures: veniceBoost.failures,
        },
      });
    }

    return apiSuccess({
      ...refreshResult,
      eligibility: {
        evaluated: eligibility.evaluated,
        evaluationFailures: eligibility.evaluationFailures,
        transitions: eligibility.transitions,
        warnings: eligibility.warnings,
      },
      veniceBoost: {
        evaluated: veniceBoost.evaluated,
        eligible: veniceBoost.eligible,
        failures: veniceBoost.failures,
        transitions: veniceBoost.transitions,
        ...(veniceBoost.warning ? { warning: veniceBoost.warning } : {}),
      },
    });
  } catch (error) {
    return apiError("Failed to refresh token holdings", 500, {
      failureType: "token_holding_cron_refresh_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
