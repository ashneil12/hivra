import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";

/**
 * Daily platform-stats rollup. Aggregates one UTC day of platform-wide
 * analytics (growth, usage, model/provider mix, tiers, geo, fleet
 * footprint) into `public.platform_stats_daily` via the
 * `compute_platform_stats_snapshot(date)` RPC. The admin insights
 * dashboard reads the resulting rows — this is the permanent historical
 * record.
 *
 * Scheduled at 23:50 UTC so "today" is captured ~complete. Each run also
 * recomputes the trailing day(s) (default 2 = today + yesterday) so a
 * missed tick self-heals and yesterday lands finalized.
 *
 * Backfill / gap recovery: hit with `?days=N` (capped at 90) to recompute
 * the last N UTC days. Day-delta and cumulative columns backfill
 * accurately from immutable event rows; point-in-time columns
 * (active_agents, tier/fleet mix) record current values for past dates —
 * see the migration header.
 *
 * Read-only against the live event tables; only writes platform_stats_daily.
 */

const MAX_BACKFILL_DAYS = 90;
const DEFAULT_DAYS = 2;

// Each snapshot scans a 30-day activity window; a deep backfill can run a
// while on a busy prod DB. 300s is the Pro-plan cap — ample headroom.
export const maxDuration = 300;

function utcDateNDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("missing CRON_SECRET"), {
      source: "rollup-platform-stats",
      route: "/api/cron/rollup-platform-stats",
      method: "GET",
      failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }

  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  if (!supabaseAdmin) {
    log.error("Supabase admin client is not configured", new Error("missing supabase admin"), {
      source: "rollup-platform-stats",
      route: "/api/cron/rollup-platform-stats",
      method: "GET",
      failureType: "supabase_admin_missing",
    });
    return apiError("Supabase service role is not configured", 500);
  }

  const daysRaw = Number(new URL(req.url).searchParams.get("days") ?? String(DEFAULT_DAYS));
  const days = Number.isFinite(daysRaw)
    ? Math.min(Math.max(Math.trunc(daysRaw), 1), MAX_BACKFILL_DAYS)
    : DEFAULT_DAYS;

  let computed = 0;
  let errors = 0;

  for (let i = 0; i < days; i++) {
    const statDate = utcDateNDaysAgo(i);
    const { error } = await supabaseAdmin.rpc("compute_platform_stats_snapshot", {
      p_date: statDate,
    });

    if (error) {
      errors++;
      log.error("platform stats snapshot failed", new Error(error.message || "rpc returned error"), {
        source: "rollup-platform-stats",
        route: "/api/cron/rollup-platform-stats",
        method: "GET",
        failureType: "platform_stats_snapshot_failed",
        statDate,
      });
      continue;
    }

    computed++;
  }

  if (errors > 0 && computed === 0) {
    return apiError("All platform stats snapshots failed", 500, {
      failureType: "platform_stats_rollup_failed",
      errorName: "PlatformStatsRollupError",
    });
  }

  // Partial failure (some days computed, some errored) previously returned 200
  // with errors>0 buried in the body — a consistently-failing "today" rollup
  // was invisible. Surface a single warn breadcrumb so it's caught on the feed.
  if (errors > 0) {
    await reportOpsEvent({
      source: "cron.rollup-platform-stats",
      severity: "warn",
      title: `Platform stats rollup partially failed (${errors}/${days} day(s))`,
      message:
        `${errors} of ${days} platform_stats_daily snapshot(s) failed this run ` +
        `(${computed} succeeded). If the same day keeps failing, the admin insights ` +
        `dashboard and public /stats odometer drift from reality for that date.`,
      route: "/api/cron/rollup-platform-stats",
      metadata: {
        failureType: "platform_stats_snapshot_partial_failure",
        days,
        computed,
        errors,
      },
    });
  }

  // Roll the hourly token-velocity checkpoint (shifts at most once per clock
  // hour) so the public /stats odometer always has a fresh anchor to count
  // toward. Non-fatal — the odometer holds its last good value if this is late.
  const { error: anchorError } = await supabaseAdmin.rpc("roll_token_anchor");
  if (anchorError) {
    log.warn("roll_token_anchor failed", {
      source: "rollup-platform-stats",
      failureType: "token_anchor_roll_failed",
      message: anchorError.message,
    });
    // A persistently broken anchor silently freezes the public /stats odometer.
    // Non-fatal to the rollup, but worth a feed breadcrumb so it doesn't sit
    // frozen unnoticed. Deduped by fingerprint so a stuck anchor pages once.
    await reportOpsEvent({
      source: "cron.rollup-platform-stats",
      severity: "warn",
      title: "roll_token_anchor failed; public stats odometer may be frozen",
      message:
        "roll_token_anchor RPC errored. The platform stats rollup still succeeded, but the " +
        "public /stats odometer anchor was not refreshed — if this persists the odometer " +
        "freezes on its last good value.",
      route: "/api/cron/rollup-platform-stats",
      metadata: {
        failureType: "token_anchor_roll_failed",
        message: anchorError.message,
      },
    });
  }

  return apiSuccess({ computed, errors, days, tokenAnchorRolled: !anchorError });
}
