import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";
import { evaluateManagedVeniceUsage } from "@/lib/venice/usage-flatline";

const SOURCE = "cron/monitor-managed-venice-usage";
const ROUTE = "/api/cron/monitor-managed-venice-usage";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;
const BASELINE_WINDOW_DAYS = 7;

// Statuses that count as "real usage flowed". Chat completions land as
// 'recorded'; multi-modal (image/video/audio/embeddings/search) intentionally
// lands as 'reconciliation_required' (offline settlement — see F176). Counting
// ONLY 'recorded' meant a media-only managed fleet read as flatlined (a false
// fatal page), so include reconciliation_required here: both prove the proxy is
// still taking live traffic, which is exactly what this monitor watches for.
const ACTIVE_USAGE_STATUSES = ["recorded", "reconciliation_required"];

async function countRecordedUsage(
  db: NonNullable<typeof supabaseAdmin>,
  fromIso: string,
  toIso?: string,
): Promise<number> {
  let query = db
    .from("managed_venice_usage_events")
    .select("*", { count: "exact", head: true })
    .in("status", ACTIVE_USAGE_STATUSES)
    .gte("created_at", fromIso);
  if (toIso) query = query.lt("created_at", toIso);
  const { count, error } = await query;
  if (error) {
    throw new Error(error.message || "usage count query failed");
  }
  return count ?? 0;
}

// Scheduled by Vercel cron (vercel.json). Watches the AGGREGATE managed-Venice
// usage stream for a silent collapse — the failure mode that hid the Jun-2026
// 301 cliff for 9 days. Pages an admin (once per fingerprint, via reportOpsEvent
// → ops-fatal transport) when a meaningful baseline drops ~to zero.
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }
  if (!supabaseAdmin) {
    return apiError("Database not configured", 500);
  }

  const now = Date.now();
  const recentFromIso = new Date(now - DAY_MS).toISOString();
  const baselineFromIso = new Date(now - (BASELINE_WINDOW_DAYS + 1) * DAY_MS).toISOString();

  let recent24hEvents: number;
  let baselineWindowEvents: number;
  let runningManagedBoxes: number;
  try {
    [recent24hEvents, baselineWindowEvents] = await Promise.all([
      countRecordedUsage(supabaseAdmin, recentFromIso),
      // Baseline window is the 7 days that PRECEDE the last 24h, so a fresh
      // collapse doesn't dilute its own baseline.
      countRecordedUsage(supabaseAdmin, baselineFromIso, recentFromIso),
    ]);
    const { count: boxes, error: boxErr } = await supabaseAdmin
      .from("hermes_instances")
      .select("*", { count: "exact", head: true })
      .eq("provider", "venice")
      .eq("status", "running");
    if (boxErr) throw new Error(boxErr.message || "box count query failed");
    runningManagedBoxes = boxes ?? 0;
  } catch (err) {
    log.error("managed-Venice usage monitor query failed", new Error("usage_monitor_query_failed"), {
      source: SOURCE,
      route: ROUTE,
      method: "GET",
      failureType: "managed_venice_usage_monitor_query_failed",
      errorName: err instanceof Error ? err.name : typeof err,
    });
    return apiError("Failed to query managed-Venice usage", 500);
  }

  const result = evaluateManagedVeniceUsage({
    recent24hEvents,
    baselineWindowEvents,
    baselineWindowDays: BASELINE_WINDOW_DAYS,
  });

  if (result.flatline) {
    // severity:'fatal' → first sighting of this fingerprint pages an admin once;
    // an ongoing outage re-reporting the same fingerprint does NOT re-page.
    // Wrap the page in its own try/catch: if the fatal-page transport throws,
    // the monitor must NOT 500 out (that loses the very alert it exists to
    // raise). Swallow + breadcrumb so the JSON still returns flatline:true for
    // whatever called the cron, and the failure is itself observable.
    try {
      await reportOpsEvent({
        source: SOURCE,
        title: "Managed-Venice usage collapsed to ~zero",
        // Message MUST be stable for an ongoing flatline: this fatal fingerprints
        // on (source,title,message,route) and pages only on first sighting, but it
        // fires every 6h. The 24h count, rolling baseline, and running-box count
        // drift run to run, so embedding them re-paged every tick. They live in
        // metadata (recent24hEvents/baselineDailyAvg/runningManagedBoxes), which is
        // NOT fingerprinted — so a sustained outage now pages exactly once.
        message:
          `Managed-Venice usage has collapsed to ~zero over the last 24h, far below the ` +
          `${BASELINE_WINDOW_DAYS}-day baseline. This is the signature of the silent baked-URL ` +
          `break (see the Jun-2026 hermesos.cloud 301 cliff): check that running managed boxes ` +
          `still POST to hivra.cloud/api/managed-venice and bill. The exact 24h count, baseline, ` +
          `and running-box count are in this event's metadata.`,
        severity: "fatal",
        route: ROUTE,
        metadata: {
          recent24hEvents,
          baselineWindowEvents,
          baselineDailyAvg: Math.round(result.baselineDailyAvg),
          collapseThreshold: Math.round(result.collapseThreshold),
          runningManagedBoxes,
          failureType: "managed_venice_usage_flatline",
        },
      });
    } catch (err) {
      log.error(
        "managed-Venice usage monitor detected flatline but failed to page",
        err instanceof Error ? err : new Error("flatline_page_failed"),
        {
          source: SOURCE,
          route: ROUTE,
          method: "GET",
          failureType: "managed_venice_usage_flatline_page_failed",
          recent24hEvents,
          baselineWindowEvents,
          runningManagedBoxes,
        },
      );
    }
  }

  return apiSuccess({
    flatline: result.flatline,
    recent24hEvents,
    baselineDailyAvg: Math.round(result.baselineDailyAvg),
    collapseThreshold: Math.round(result.collapseThreshold),
    runningManagedBoxes,
    reason: result.reason,
  });
}
