import { NextResponse } from "next/server";

import { log } from "@/lib/logger";
import { checkDbHealth } from "@/lib/health/db";
import { checkClerkHealth } from "@/lib/health/clerk";
import { checkStripeHealth } from "@/lib/health/stripe";

export const dynamic = "force-dynamic";

/** Hard ceiling for the entire /api/health request (10 seconds per spec). */
const OVERALL_TIMEOUT_MS = 10_000;

/**
 * GET /api/health
 *
 * Lightweight health-check endpoint for uptime monitoring and load-balancer
 * probes. Runs three dependency checks in parallel (database, Clerk auth,
 * Stripe billing), aggregates the results, and returns a structured JSON
 * payload.
 *
 * Status aggregation:
 *   - "healthy"   — all three checks report "up"
 *   - "degraded"  — one or two checks report "down"
 *   - "unhealthy" — all three checks report "down"
 *
 * HTTP status codes:
 *   - 200 for "healthy" and "degraded"
 *   - 503 for "unhealthy"
 *
 * A 10-second overall timeout wraps the parallel checks so the endpoint
 * never hangs longer than that regardless of individual check behaviour.
 */
export async function GET(): Promise<NextResponse> {
  try {
    // Race the parallel health checks against a 10-second overall timeout.
    let overallTimer: ReturnType<typeof setTimeout> | undefined;
    const overallTimeout = new Promise<never>((_, reject) => {
      overallTimer = setTimeout(
        () =>
          reject(
            new Error(
              `Health endpoint timed out after ${OVERALL_TIMEOUT_MS}ms`,
            ),
          ),
        OVERALL_TIMEOUT_MS,
      );
    });

    let results: {
      db: { status: "up" | "down"; latency_ms: number };
      clerk: { status: "up" | "down"; latency_ms: number };
      stripe: { status: "up" | "down"; latency_ms: number };
    };

    try {
      const [db, clerk, stripe] = await Promise.race([
        Promise.all([
          checkDbHealth(),
          checkClerkHealth(),
          checkStripeHealth(),
        ]),
        overallTimeout,
      ]);

      results = { db, clerk, stripe };
    } finally {
      if (overallTimer) clearTimeout(overallTimer);
    }

    const checks = results;

    // Aggregate: count how many checks are down.
    const downCount = Object.values(checks).filter(
      (c) => c.status === "down",
    ).length;

    let status: "healthy" | "degraded" | "unhealthy";
    let httpStatus: number;

    if (downCount === 0) {
      status = "healthy";
      httpStatus = 200;
    } else if (downCount < 3) {
      status = "degraded";
      httpStatus = 200;
    } else {
      status = "unhealthy";
      httpStatus = 503;
    }

    return NextResponse.json(
      {
        status,
        timestamp: new Date().toISOString(),
        checks,
      },
      { status: httpStatus },
    );
  } catch (err) {
    log.error("health endpoint failed", err as Error, {
      source: "api/health",
      route: "/api/health",
      method: "GET",
    });

    return NextResponse.json(
      {
        status: "unhealthy" as const,
        timestamp: new Date().toISOString(),
        checks: {
          db: { status: "down" as const, latency_ms: 0 },
          clerk: { status: "down" as const, latency_ms: 0 },
          stripe: { status: "down" as const, latency_ms: 0 },
        },
      },
      { status: 503 },
    );
  }
}
