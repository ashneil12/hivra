import { NextRequest, NextResponse } from "next/server";

import { getAgentsDeployedStats } from "@/lib/agents-deployed-stats";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const includeSeries = request.nextUrl.searchParams.get("series") === "1";

  try {
    const stats = await getAgentsDeployedStats({ series: includeSeries });
    return NextResponse.json(stats, {
      headers: {
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
      },
    });
  } catch (err) {
    log.error("agents-deployed stats fetch failed", err as Error, {
      source: "stats/agents-deployed",
      route: "/api/stats/agents-deployed",
      method: "GET",
    });
    return NextResponse.json({ error: "stats unavailable" }, { status: 503 });
  }
}
