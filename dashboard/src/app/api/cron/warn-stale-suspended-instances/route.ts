import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import {
  runFinalReminderSweep,
  runStaleSuspendedSweep,
} from "@/lib/recovery/stale-suspended-sweep";

/**
 * Cron-triggered sweeper that:
 *   1. Warns owners of long-idle suspended Proxmox instances and arms their
 *      auto-deletion (sets scheduled_deletion_at + status=scheduled_for_deletion).
 *   2. Sends a one-shot "last chance" final reminder for rows whose deletion
 *      is within the next 24 hours.
 * See `src/lib/recovery/stale-suspended-sweep.ts` for the why and the safety guards.
 *
 * Schedule: daily at 02:30 UTC via vercel.json. Pairs with the existing
 * `purge-expired` cron (which actually deletes once `scheduled_deletion_at`
 * passes).
 */
export const dynamic = "force-dynamic";
// Email + DB writes for a large suspended cohort could exceed the default
// function budget, leaving the tail un-warned. Give it a real ceiling.
export const maxDuration = 800;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(
      "CRON_SECRET is not configured; refusing to run",
      new Error("CRON_SECRET missing"),
      {
        source: "warn-stale-suspended-instances",
        route: "/api/cron/warn-stale-suspended-instances",
        method: "GET",
        failureType: "cron_secret_missing",
      },
    );
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  try {
    // Run both sweeps. A failure in one shouldn't drop the other — in the
    // worst case the operator can re-trigger the cron and the idempotency
    // keys will dedupe successful sends.
    const warnSummary = await runStaleSuspendedSweep();
    let finalReminderSummary;
    try {
      finalReminderSummary = await runFinalReminderSweep();
    } catch (reminderErr) {
      log.error("final-reminder sweep failed (warn sweep already succeeded)", reminderErr, {
        source: "warn-stale-suspended-instances",
        route: "/api/cron/warn-stale-suspended-instances",
        method: "GET",
        failureType: "final_reminder_sweep_failed",
      });
      finalReminderSummary = { error: reminderErr instanceof Error ? reminderErr.message : "unknown" };
      // The final-reminder error is intentionally swallowed to a logged {error}
      // 200 so it never drops the warn sweep above. But a persistently-broken
      // final-reminder pass means users get ARMED for deletion yet never receive
      // the 24h last-chance email — silent at the HTTP level. Surface it so it
      // can be paged on. Best-effort; fingerprint-deduped pages once.
      await reportOpsEvent({
        source: "cron.stale_suspended_final_reminder_failed",
        severity: "warn",
        title: "warn-stale-suspended: final-reminder (24h last-chance) pass failed",
        message:
          "The final-reminder pass (runFinalReminderSweep) threw. Instances armed for auto-deletion " +
          "may not be getting their 24h last-chance email before purge-expired deletes them — investigate " +
          "Resend/Clerk + the route logs.",
        route: "/api/cron/warn-stale-suspended-instances",
        metadata: {
          failureType: "final_reminder_sweep_failed",
          errorMessage: reminderErr instanceof Error ? reminderErr.message : String(reminderErr),
        },
      });
    }

    // Destructive audit trail: surface when instances are newly armed for
    // auto-deletion so an over-aggressive threshold (or a wrongly-armed paying
    // customer) is visible before purge-expired acts. The eligibility/active-sub
    // guards are by-design in the lib and untouched.
    if (warnSummary.warnedAndScheduled > 0 || warnSummary.emailFailed > 0 || warnSummary.errors > 0) {
      await reportOpsEvent({
        source: "cron.stale_suspended_armed",
        severity: "warn",
        title: `warn-stale-suspended armed ${warnSummary.warnedAndScheduled} for deletion`,
        message:
          `warn-stale-suspended-instances armed ${warnSummary.warnedAndScheduled} of ${warnSummary.candidates} ` +
          `suspended instance(s) for auto-deletion (emailFailed=${warnSummary.emailFailed}, errors=${warnSummary.errors}, ` +
          `capHit=${warnSummary.capHit}). purge-expired deletes once the grace window passes — restore any ` +
          `wrongly-armed paying customer before then.`,
        route: "/api/cron/warn-stale-suspended-instances",
        metadata: {
          candidates: warnSummary.candidates,
          warned_and_scheduled: warnSummary.warnedAndScheduled,
          email_failed: warnSummary.emailFailed,
          errors: warnSummary.errors,
          cap_hit: warnSummary.capHit,
          by_tier: warnSummary.byTier,
        },
      });
    }

    return apiSuccess({ warn: warnSummary, finalReminder: finalReminderSummary });
  } catch (err) {
    log.error("stale-suspended sweep failed", err, {
      source: "warn-stale-suspended-instances",
      route: "/api/cron/warn-stale-suspended-instances",
      method: "GET",
      failureType: "stale_suspended_sweep_failed",
    });
    const message = err instanceof Error ? err.message : "Stale-suspended sweep failed";
    return apiError(message, 500);
  }
}
