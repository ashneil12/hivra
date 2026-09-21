/**
 * Cron: waitlist claim-window expiry + top-up.
 *
 * Runs every couple of hours. Two steps:
 *   1. expireStaleInvites() — any `invited` reservation whose claim window has
 *      passed is re-queued to the BACK of the line (its held slot is released),
 *      so the spot passes to the next person.
 *   2. promoteNext() — fill any now-available free capacity by inviting the next
 *      queued reservations with a fresh claim window.
 *
 * No-op unless RESERVATION_AUTO_INVITE_ENABLED=true and MAX_FREE_INSTANCES>0
 * (both checked inside the helpers), so this is safe to schedule before the
 * feature is turned on.
 *
 * Auth: Bearer CRON_SECRET (Vercel Cron sends it; manual curl must too).
 */

import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { recordCronHeartbeat } from "@/lib/cron-heartbeat";
import { log } from "@/lib/logger";
import { expireStaleInvites, promoteNext } from "@/lib/reservations/promote-next";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const LOG_SOURCE = "cron:reservation-claim-expiry";

async function handle(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET not configured; refusing to run", new Error("CRON_SECRET missing"), {
      source: LOG_SOURCE,
      route: "/api/cron/reservation-claim-expiry",
      failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  const expired = await expireStaleInvites();
  const promo = await promoteNext();
  await recordCronHeartbeat("reservation-claim-expiry");

  log.info("reservation-claim-expiry complete", {
    source: LOG_SOURCE,
    expired: expired.expired,
    promoted: promo.promoted,
    available: promo.available,
    enabled: promo.enabled,
  });

  return apiSuccess({
    ok: expired.ok && promo.ok,
    expired: expired.expired,
    promoted: promo.promoted,
    available: promo.available,
    enabled: promo.enabled,
  });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
