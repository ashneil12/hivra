import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";
import { isVenicePromoEnabled } from "@/lib/venice/promo/core";
import { loadPromoReport } from "@/lib/venice/promo/report";
import { summarizePromoReport } from "@/lib/venice/promo/report-summary";

export const dynamic = "force-dynamic";

const ROUTE = "/api/cron/venice-promo-weekly-report";
const SOURCE = "venice-promo-report";

/** Weekly: write the Venice promo summary to ops_events (one row per week). */
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing venice promo report", new Error("CRON_SECRET missing"), {
      source: SOURCE,
      route: ROUTE,
    });
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) return apiError("Unauthorized", 401);
  if (!isVenicePromoEnabled()) return apiSuccess({ skipped: "flag_off" });
  if (!supabaseAdmin) return apiError("Database not configured", 500);

  try {
    const report = await loadPromoReport(supabaseAdmin as never, {});
    const week = report.window.to.slice(0, 10);
    await reportOpsEvent({
      source: SOURCE,
      severity: "info",
      // The date in the title gives each week its own row.
      title: `Venice promo weekly report ${week}`,
      message: summarizePromoReport(report),
      route: ROUTE,
      metadata: { report },
    });
    return apiSuccess({ written: true, week });
  } catch (error) {
    log.error("venice promo weekly report failed", error, { source: SOURCE, route: ROUTE });
    return apiError("Venice promo weekly report failed", 500);
  }
}
