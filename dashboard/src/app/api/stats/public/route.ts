import { NextResponse } from "next/server";

import { getPublicStats } from "@/lib/public-stats";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * Public, unauthenticated polling endpoint for the /stats page's "platform
 * at a glance" counters. Runs server-side via the service-role client and
 * returns only the vetted public-safe aggregates. Edge-cached for 60s with a
 * 300s stale-while-revalidate window (matching the agents-deployed counter) so
 * the page stays near-realtime while a spike of viewers doesn't hammer the DB.
 * Live counts (runningNow) reflect within a poll;
 * harvested/synced aggregates (tokens, users, countries) refresh on their crons.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const stats = await getPublicStats();
    if (!stats) {
      return NextResponse.json({ error: "stats unavailable" }, { status: 503 });
    }
    return NextResponse.json(stats, {
      headers: {
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
      },
    });
  } catch (err) {
    log.error("public stats fetch failed", err as Error, {
      source: "stats/public",
      route: "/api/stats/public",
      method: "GET",
    });
    return NextResponse.json({ error: "stats unavailable" }, { status: 503 });
  }
}
