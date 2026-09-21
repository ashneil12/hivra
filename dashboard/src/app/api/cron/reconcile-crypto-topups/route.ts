import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { reconcilePendingCryptoTopUps } from "@/lib/billing/crypto-reconciliation";
import { sweepPendingCreditDepositReceipts } from "@/lib/billing/credit-deposit-sweep";
import { sweepPendingManagedVeniceTokenQuotes } from "@/lib/billing/managed-venice-token-sweep";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";

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
    return apiError("Failed to reconcile crypto top-ups", 500, {
      failureType: "crypto_topup_reconciliation_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
