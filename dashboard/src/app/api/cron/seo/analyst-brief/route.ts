/**
 * Cron: SEO analyst brief.
 *
 * Loads the last 21 days of Search Console data (seo_gsc_daily), the
 * open keyword backlog (seo_targets), and the latest page inventory
 * (seo_page_inventory), runs the pure decision engine over them, and
 * returns a ranked brief: week-over-week metrics plus the top 20
 * actions. All ranking logic lives in src/lib/seo/decision-engine.ts;
 * this route is purely load + dispatch.
 *
 * Auth: Bearer CRON_SECRET (same contract as every other cron route).
 */

import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { recordCronHeartbeat } from "@/lib/cron-heartbeat";
import { log } from "@/lib/logger";
import {
  computeWowMetrics,
  rankActions,
  suppressActiveActions,
  type SeoPriorActionRow,
  type SeoGscDailyRow,
  type SeoPageInventoryRow,
  type SeoTargetRow,
} from "@/lib/seo/decision-engine";
import { buildPageTitleIndex } from "@/lib/seo/page-title-index";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const LOG_SOURCE = "cron:seo-analyst-brief";
const WINDOW_DAYS = 21;
const TOP_ACTIONS = 20;
// Supabase caps a single select at 1000 rows; page through explicitly so
// a healthy GSC dataset (days * pages * queries) doesn't get silently
// truncated.
const PAGE_SIZE = 1000;

type AdminClient = NonNullable<typeof supabaseAdmin>;

async function fetchAllPages<T>(
  // PromiseLike because supabase-js query builders are thenables, not Promises.
  fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  label: string,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await fetchPage(from, from + PAGE_SIZE - 1);
    if (error) {
      throw new Error(`Failed to load ${label}: ${error.message}`);
    }
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  return rows;
}

function windowStartIso(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - WINDOW_DAYS);
  return d.toISOString().slice(0, 10);
}

async function loadInputs(db: AdminClient, windowStart: string) {
  const gscDaily = await fetchAllPages<SeoGscDailyRow>(
    (from, to) =>
      db
        .from("seo_gsc_daily")
        .select("date,site,page,query,clicks,impressions,ctr,position")
        .gte("date", windowStart)
        .order("date", { ascending: true })
        .order("page", { ascending: true })
        .order("query", { ascending: true })
        .range(from, to),
    "seo_gsc_daily",
  );

  const targets = await fetchAllPages<SeoTargetRow>(
    (from, to) =>
      db
        .from("seo_targets")
        .select("keyword,cluster,intent,target_url,status,priority")
        .eq("status", "open")
        .order("keyword", { ascending: true })
        .range(from, to),
    "seo_targets",
  );

  const pageInventory = await fetchAllPages<SeoPageInventoryRow>(
    (from, to) =>
      db
        .from("seo_page_inventory")
        .select("url,last_status,canonical_ok")
        .order("url", { ascending: true })
        .range(from, to),
    "seo_page_inventory",
  );

  const activeActions = await fetchAllPages<SeoPriorActionRow>(
    (from, to) =>
      db
        .from("seo_actions")
        .select("action_type,target,status")
        .in("status", ["proposed", "pr_open", "merged", "live"])
        .order("created_at", { ascending: false })
        .range(from, to),
    "active seo_actions",
  );

  // Titles are compiled in, not crawled, so this adds no round trips.
  return {
    gscDaily,
    targets,
    pageInventory,
    activeActions,
    livePageTitles: buildPageTitleIndex(),
  };
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("CRON_SECRET missing"), {
      source: LOG_SOURCE,
      route: "/api/cron/seo/analyst-brief",
      method: "GET",
      failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  const db = supabaseAdmin;
  if (!db) {
    return apiError("Supabase admin client is not configured", 500);
  }

  const windowStart = windowStartIso();
  try {
    const inputs = await loadInputs(db, windowStart);
    const rankedActions = rankActions(inputs);
    const actions = suppressActiveActions(rankedActions, inputs.activeActions);
    const metrics = computeWowMetrics(inputs.gscDaily);

    await recordCronHeartbeat("seo-analyst-brief");

    return apiSuccess({
      generated_at: new Date().toISOString(),
      window: { days: WINDOW_DAYS, start: windowStart },
      metrics,
      actions: actions.slice(0, TOP_ACTIONS),
      counts: {
        gsc_rows: inputs.gscDaily.length,
        open_targets: inputs.targets.length,
        inventory_pages: inputs.pageInventory.length,
        active_actions: inputs.activeActions.length,
        suppressed_actions: rankedActions.length - actions.length,
        total_actions: actions.length,
      },
    });
  } catch (err) {
    log.error("seo-analyst-brief failed", err, {
      source: LOG_SOURCE,
      route: "/api/cron/seo/analyst-brief",
      method: "GET",
      failureType: "seo_analyst_brief_failed",
    });
    const message = err instanceof Error ? err.message : "SEO analyst brief failed";
    return apiError(message, 500);
  }
}
