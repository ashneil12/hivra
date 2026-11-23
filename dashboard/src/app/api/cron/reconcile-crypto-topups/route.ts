import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { recordCronHeartbeat } from "@/lib/cron-heartbeat";
import { reconcilePendingCryptoTopUps } from "@/lib/billing/crypto-reconciliation";
import { sweepPendingCreditDepositReceipts } from "@/lib/billing/credit-deposit-sweep";
import { sweepPendingManagedVeniceTokenQuotes } from "@/lib/billing/managed-venice-token-sweep";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";

// Each open intent is scanned over its own window on Base (a few chunked
// eth_getLogs calls), then both treasury sweeps run.
export const maxDuration = 300;

function parseLimit(req: NextRequest) {
  const raw = new URL(req.url).searchParams.get("limit");
  const value = raw ? Number(raw) : 50;
  if (!Number.isFinite(value)) return 50;
  return Math.max(1, Math.min(100, Math.floor(value)));
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("missing CRON_SECRET"), {
      source: "reconcile-crypto-topups",
      route: "/api/cron/reconcile-crypto-topups",
      method: "GET",
      failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }

  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  try {
    const limit = parseLimit(req);
    const reconciliation = await reconcilePendingCryptoTopUps({ limit });
    const staleRetryLoadFailed = reconciliation.staleRetryLoadFailed === true;
    if (reconciliation.failed > 0 || staleRetryLoadFailed) {
      // Per-intent failures (an RPC rejecting the scan, a DB error) used to
      // vanish into a 200 while paid top-ups went uncredited. Surface them —
      // and the once-a-day stale pass failing to LOAD, which produces no
      // per-intent failures at all while leaving the day's retry unrun.
      const failures = reconciliation.results.filter(
        (result) =>
          result.status === "failed" ||
          (result.status === "settlement_skipped" && result.settlementStatus !== "intent_closed")
      );
      log.error("crypto top-up reconciliation failed for some intents", new Error("crypto top-up reconciliation failures"), {
        source: "reconcile-crypto-topups",
        route: "/api/cron/reconcile-crypto-topups",
        method: "GET",
        failureType: "crypto_topup_reconciliation_intent_failed",
        failed: reconciliation.failed,
        // Open intents past the stale cutoff this run skipped on purpose —
        // context so a nonzero count is not mistaken for missing work.
        staleExcluded: reconciliation.staleExcluded,
        staleRetried: reconciliation.staleRetried,
        staleRetryLoadFailed,
      });
      await reportOpsEvent({
        source: "cron.reconcile-crypto-topups",
        severity: "error",
        title: "USDC top-up reconciliation failed",
        message:
          "Some open USDC top-up intents could not be reconciled this tick. A paid intent is not " +
          "credited until this clears; each intent is retried on the next tick.",
        route: "/api/cron/reconcile-crypto-topups",
        metadata: {
          failureType: "crypto_topup_reconciliation_intent_failed",
          failed: reconciliation.failed,
          staleExcluded: reconciliation.staleExcluded,
          staleRetried: reconciliation.staleRetried,
          staleRetryLoadFailed,
          sample: failures.slice(0, 5).map((result) => ({
            referenceId: result.referenceId,
            errorName: "errorName" in result ? result.errorName : undefined,
            errorMessage: "errorMessage" in result ? result.errorMessage : undefined,
            settlementStatus: "settlementStatus" in result ? result.settlementStatus : undefined,
          })),
        },
      });
    }
    // Sweep happens after reconciliation so any newly-settled receipts
    // from this tick are eligible for sweep on the same cron run.
    // A sweep-side failure must NOT bubble up and mask reconciliation
    // results, so we catch and surface as a separate field.
    let sweep: Awaited<ReturnType<typeof sweepPendingCreditDepositReceipts>> | { error: string };
    let creditSweepFailed = false;
    try {
      sweep = await sweepPendingCreditDepositReceipts({ limit });
    } catch (sweepError) {
      creditSweepFailed = true;
      log.error("credit-deposit treasury sweep failed after reconciliation", sweepError, {
        source: "reconcile-crypto-topups",
        route: "/api/cron/reconcile-crypto-topups",
        method: "GET",
        failureType: "credit_deposit_sweep_failed",
      });
      // Funds-movement failure: surface on the ops feed so a repeated
      // treasury-sweep outage isn't hidden behind a soft {error} field + 200.
      await reportOpsEvent({
        source: "cron.reconcile-crypto-topups",
        severity: "warn",
        title: "Credit-deposit treasury sweep failed",
        message:
          "sweepPendingCreditDepositReceipts threw after reconciliation. Settled on-chain " +
          "deposits are reconciled but their funds are NOT reaching the treasury until this " +
          "clears. Reconciliation results were preserved; only the sweep failed.",
        route: "/api/cron/reconcile-crypto-topups",
        metadata: {
          failureType: "credit_deposit_sweep_failed",
          errorName: sweepError instanceof Error ? sweepError.name : typeof sweepError,
        },
      });
      sweep = {
        error: sweepError instanceof Error ? sweepError.message : String(sweepError),
      };
    }

    let managedVeniceSweep:
      | Awaited<ReturnType<typeof sweepPendingManagedVeniceTokenQuotes>>
      | { error: string };
    let managedVeniceSweepFailed = false;
    try {
      managedVeniceSweep = await sweepPendingManagedVeniceTokenQuotes({ limit });
    } catch (managedVeniceSweepError) {
      managedVeniceSweepFailed = true;
      log.error("managed Venice treasury sweep failed after reconciliation", managedVeniceSweepError, {
        source: "reconcile-crypto-topups",
        route: "/api/cron/reconcile-crypto-topups",
        method: "GET",
        failureType: "managed_venice_sweep_failed",
      });
      await reportOpsEvent({
        source: "cron.reconcile-crypto-topups",
        severity: "warn",
        title: "Managed-Venice treasury sweep failed",
        message:
          "sweepPendingManagedVeniceTokenQuotes threw after reconciliation. Managed-Venice " +
          "token quote funds are NOT reaching the treasury until this clears. Reconciliation " +
          "results were preserved; only the sweep failed.",
        route: "/api/cron/reconcile-crypto-topups",
        metadata: {
          failureType: "managed_venice_sweep_failed",
          errorName:
            managedVeniceSweepError instanceof Error
              ? managedVeniceSweepError.name
              : typeof managedVeniceSweepError,
        },
      });
      managedVeniceSweep = {
        error:
          managedVeniceSweepError instanceof Error
            ? managedVeniceSweepError.message
            : String(managedVeniceSweepError),
      };
    }

    // Honest heartbeat: per-intent failures and sweep failures used to leave
    // the run looking 100% ok. in_doubt sweeps count only when they need an
    // operator — the rest resolve themselves from chain evidence. noTreasury
    // items count too: a reconciled deposit the sweep could not move because
    // no treasury is configured is stuck funds, not a clean run — and unlike
    // a thrown sweep it produces no error field anywhere else.
    const creditSweepNeedsOperator =
      "needsOperator" in sweep && typeof sweep.needsOperator === "number"
        ? sweep.needsOperator
        : 0;
    const creditSweepItemFailures =
      "failed" in sweep && typeof sweep.failed === "number"
        ? sweep.failed + creditSweepNeedsOperator
        : 0;
    const creditSweepNoTreasury =
      "noTreasury" in sweep && typeof sweep.noTreasury === "number"
        ? sweep.noTreasury
        : 0;
    const managedVeniceItemFailures =
      !("error" in managedVeniceSweep) && typeof managedVeniceSweep.failed === "number"
        ? managedVeniceSweep.failed + (managedVeniceSweep.needsOperator ?? 0)
        : 0;
    const managedVeniceNoTreasury =
      !("error" in managedVeniceSweep) && typeof managedVeniceSweep.noTreasury === "number"
        ? managedVeniceSweep.noTreasury
        : 0;
    const heartbeatFailed =
      reconciliation.failed > 0 ||
      staleRetryLoadFailed ||
      creditSweepFailed ||
      creditSweepItemFailures > 0 ||
      creditSweepNoTreasury > 0 ||
      managedVeniceSweepFailed ||
      managedVeniceItemFailures > 0 ||
      managedVeniceNoTreasury > 0;
    await recordCronHeartbeat(
      "reconcile-crypto-topups",
      heartbeatFailed
        ? {
            ok: false,
            detail:
              `recon_failed=${reconciliation.failed} ` +
              `stale_retry=${staleRetryLoadFailed ? "load_failed" : (reconciliation.staleRetried ?? 0)} ` +
              `credit_sweep=${creditSweepFailed ? "threw" : creditSweepItemFailures} ` +
              `credit_sweep_op_review=${creditSweepNeedsOperator} ` +
              `credit_sweep_no_treasury=${creditSweepNoTreasury} ` +
              `mv_sweep=${managedVeniceSweepFailed ? "threw" : managedVeniceItemFailures} ` +
              `mv_sweep_no_treasury=${managedVeniceNoTreasury}`,
          }
        : undefined,
    );

    // Honest top-level flag: an operator polling only HTTP status (200) won't
    // see the soft per-sweep {error} fields; expose a single boolean so a
    // treasury-sweep failure is visible at a glance.
    return apiSuccess({
      reconciliation,
      sweep,
      managedVeniceSweep,
      sweepFailed: creditSweepFailed || managedVeniceSweepFailed,
    });
  } catch (error) {
    // Outer reconciliation failure: the only prior signal was the 500. Add a
    // structured log breadcrumb so it's greppable like the missing-secret path.
    log.error("crypto top-up reconciliation failed", error, {
      source: "reconcile-crypto-topups",
      route: "/api/cron/reconcile-crypto-topups",
      method: "GET",
      failureType: "crypto_topup_reconciliation_failed",
    });
    // The run threw — record the failure on the heartbeat so cron_unhealthy
    // sees it now instead of after the staleness window. Auth failures return
    // above and never reach this branch.
    await recordCronHeartbeat("reconcile-crypto-topups", {
      ok: false,
      detail: `exception: ${error instanceof Error ? error.name : typeof error}`,
    });
    return apiError("Failed to reconcile crypto top-ups", 500, {
      failureType: "crypto_topup_reconciliation_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
