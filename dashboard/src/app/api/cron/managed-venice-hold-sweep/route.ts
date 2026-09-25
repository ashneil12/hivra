import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import { sweepStaleManagedVeniceReservations } from "@/lib/venice/reservation-sweep";

const ROUTE = "/api/cron/managed-venice-hold-sweep";
const SOURCE = "managed-venice-hold-sweep";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Hourly: settle managed-Venice wallet holds the request path could not
 * (lib/venice/reservation-sweep.ts). A capture is charged the number the
 * request recorded, a refused request's hold is released, and an unknown
 * outcome is released once its hold expires. It used to run inside the daily
 * reconciliation cron, so one failed settlement held a user's balance for up
 * to two days (security review 2026-09).
 */
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("CRON_SECRET missing"), {
      source: SOURCE,
      route: ROUTE,
      method: "GET",
      failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }
  if (!supabaseAdmin) {
    return apiError("Database not configured", 500);
  }

  try {
    const summary = await sweepStaleManagedVeniceReservations({}, supabaseAdmin);
    if (summary.scanned > 0) {
      log.info("managed-venice hold sweep settled stale holds", {
        source: SOURCE,
        route: ROUTE,
        scanned: summary.scanned,
        closed: summary.closed,
        capturedReservations: summary.capturedReservations,
        totalCapturedMicroUsd: summary.totalCapturedMicroUsd,
        releasedReservations: summary.releasedReservations,
        totalReleasedMicroUsd: summary.totalReleasedMicroUsd,
        heldForOpenItem: summary.heldForOpenItem,
        failed: summary.failed,
      });
    }
    const { results, ...totals } = summary;
    // Keep the response small for ad-hoc ops curls.
    return apiSuccess({ ...totals, sampleResults: results.slice(0, 25) });
  } catch (error) {
    log.error("managed-venice hold sweep failed", error as Error, {
      source: SOURCE,
      route: ROUTE,
      failureType: "reservation_sweep_failed",
    });
    return apiError("Managed Venice hold sweep failed", 500);
  }
}
