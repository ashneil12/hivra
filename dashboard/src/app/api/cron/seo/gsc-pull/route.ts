import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import {
  GSC_SITES,
  GscApiError,
  getServiceAccountFromEnv,
  searchAnalyticsQuery,
} from "@/lib/seo/gsc-client";
import { supabaseAdmin } from "@/lib/supabase";

const SOURCE = "cron/seo-gsc-pull";
const ROUTE = "/api/cron/seo/gsc-pull";

/**
 * Daily Google Search Console ingestion. For each GSC property (both
 * sc-domain:hivra.cloud and sc-domain:hermesos.cloud) it pulls the
 * date+page+query performance rows for the target day and upserts them into
 * `public.seo_gsc_daily`.
 *
 * GSC finalizes data ~3 days behind, so the default target date is 3 days
 * ago (UTC). Backfill knobs:
 *   ?date=YYYY-MM-DD  anchor date (defaults to 3 days ago)
 *   ?days=N           pull the N-day window ending at the anchor (1–30)
 *
 * If the service account hasn't been granted on the property yet, GSC
 * returns 403. That's an expected pre-launch state, so the route responds
 * 200 with { ok: false, reason: "gsc_permission_pending" } instead of
 * failing the cron.
 */

// GSC lag: data for a date is not final until roughly 3 days later.
const DEFAULT_LAG_DAYS = 3;
const MAX_BACKFILL_DAYS = 30;
const UPSERT_CHUNK_SIZE = 500;

// A 30-day two-site backfill can page through a lot of rows; match the
// repo's standard long-cron budget.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function utcDateNDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function shiftDate(isoDate: string, deltaDays: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

interface GscDailyRow {
  date: string;
  site: string;
  page: string;
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

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
    log.error("Supabase admin client is not configured", new Error("missing supabase admin"), {
      source: SOURCE,
      route: ROUTE,
      method: "GET",
      failureType: "supabase_admin_missing",
    });
    return apiError("Supabase service role is not configured", 500);
  }

  // No SA key yet = the GSC integration hasn't been wired up. Like the 403
  // permission-pending case below, respond 200 so the cron doesn't alarm
  // daily while setup is in flight.
  let serviceAccount: ReturnType<typeof getServiceAccountFromEnv>;
  try {
    serviceAccount = getServiceAccountFromEnv();
  } catch (err) {
    log.error("GSC_SA_KEY is malformed", err instanceof Error ? err : new Error(String(err)), {
      source: SOURCE,
      route: ROUTE,
      method: "GET",
      failureType: "gsc_sa_key_malformed",
    });
    return apiError("GSC service account key is malformed", 500);
  }
  if (!serviceAccount) {
    log.warn("GSC_SA_KEY is not configured; skipping GSC pull", {
      source: SOURCE,
      route: ROUTE,
      failureType: "gsc_sa_key_missing",
    });
    return apiSuccess({ ok: false, reason: "gsc_key_missing" });
  }

  const params = new URL(req.url).searchParams;

  const dateParam = params.get("date");
  if (dateParam && !DATE_RE.test(dateParam)) {
    return apiError("Invalid date parameter; expected YYYY-MM-DD", 400);
  }
  const endDate = dateParam || utcDateNDaysAgo(DEFAULT_LAG_DAYS);

  const daysRaw = Number(params.get("days") ?? "1");
  const days = Number.isFinite(daysRaw)
    ? Math.min(Math.max(Math.floor(daysRaw), 1), MAX_BACKFILL_DAYS)
    : 1;
  const startDate = shiftDate(endDate, -(days - 1));

  const perSite: Record<string, { rows: number; upserted: number }> = {};
  let totalUpserted = 0;

  for (const site of GSC_SITES) {
    let rows;
    try {
      rows = await searchAnalyticsQuery(
        site,
        {
          startDate,
          endDate,
          dimensions: ["date", "page", "query"],
        },
        serviceAccount,
      );
    } catch (err) {
      if (err instanceof GscApiError && err.status === 403) {
        // The SA hasn't been added to this GSC property yet. Expected until
        // the one-time grant is done — succeed quietly so the cron is green.
        log.warn("GSC permission pending; service account not granted on property", {
          source: SOURCE,
          route: ROUTE,
          failureType: "gsc_permission_pending",
          site,
        });
        return apiSuccess({ ok: false, reason: "gsc_permission_pending", site });
      }
      log.error(
        "GSC search analytics pull failed",
        err instanceof Error ? err : new Error(String(err)),
        {
          source: SOURCE,
          route: ROUTE,
          failureType: "gsc_pull_failed",
          site,
          startDate,
          endDate,
        },
      );
      return apiError("GSC search analytics pull failed", 502, undefined, undefined, {
        source: SOURCE,
        route: ROUTE,
        failureType: "gsc_pull_failed",
        metadata: { site },
      });
    }

    const upsertRows: GscDailyRow[] = [];
    for (const row of rows) {
      const [date, page, query] = row.keys;
      if (!date || !page || typeof query !== "string") continue;
      upsertRows.push({
        date,
        site,
        page,
        query,
        clicks: Math.round(row.clicks),
        impressions: Math.round(row.impressions),
        ctr: row.ctr,
        position: row.position,
      });
    }

    let upserted = 0;
    for (let i = 0; i < upsertRows.length; i += UPSERT_CHUNK_SIZE) {
      const chunk = upsertRows.slice(i, i + UPSERT_CHUNK_SIZE);
      const { error } = await supabaseAdmin
        .from("seo_gsc_daily")
        .upsert(chunk, { onConflict: "date,site,page,query" });
      if (error) {
        log.error("seo_gsc_daily upsert failed", new Error(error.message), {
          source: SOURCE,
          route: ROUTE,
          failureType: "seo_gsc_daily_upsert_failed",
          site,
          chunkStart: i,
        });
        return apiError("Failed to write GSC rows", 500);
      }
      upserted += chunk.length;
    }

    perSite[site] = { rows: rows.length, upserted };
    totalUpserted += upserted;
  }

  log.info("GSC pull complete", {
    source: SOURCE,
    route: ROUTE,
    startDate,
    endDate,
    totalUpserted,
  });

  return apiSuccess({
    ok: true,
    startDate,
    endDate,
    days,
    totalUpserted,
    perSite,
  });
}
