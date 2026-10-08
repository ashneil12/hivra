import { NextResponse } from "next/server";

import { log } from "@/lib/logger";
import { checkDbHealth } from "@/lib/health/db";
import { checkClerkHealth } from "@/lib/health/clerk";
import { checkStripeHealth } from "@/lib/health/stripe";

export const dynamic = "force-dynamic";

/** Hard ceiling for the entire /api/health request (10 seconds per spec). */
const OVERALL_TIMEOUT_MS = 10_000;

/**
 * How long one run of the dependency checks answers every caller. The endpoint
 * is public and unauthenticated, and each run makes a real Clerk and a real
 * Stripe API call on the live keys, so without this anyone could spend those
 * rate limits (and with them checkout and sign-in) by looping on it. 30 seconds
 * is shorter than any uptime monitor's interval, so monitors still see a
 * change within one poll.
 */
const RESULT_TTL_MS = 30_000;

type CheckResult = { status: "up" | "down"; latency_ms: number };

interface HealthResult {
  body: {
    status: "healthy" | "degraded" | "unhealthy";
    /** When these checks ran. A cached answer keeps its original time. */
    timestamp: string;
    checks: { db: CheckResult; clerk: CheckResult; stripe: CheckResult };
  };
  httpStatus: number;
  checkedAt: number;
}

// Per server instance. Several instances may each hold one result, which is
// still at most one Clerk and one Stripe call per instance per TTL.
let lastResult: HealthResult | null = null;
let running: Promise<HealthResult> | null = null;

async function runChecks(): Promise<HealthResult> {
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

    let checks: HealthResult["body"]["checks"];

    try {
      const [db, clerk, stripe] = await Promise.race([
        Promise.all([
          checkDbHealth(),
          checkClerkHealth(),
          checkStripeHealth(),
        ]),
        overallTimeout,
      ]);

      checks = { db, clerk, stripe };
    } finally {
      if (overallTimer) clearTimeout(overallTimer);
    }

    // Aggregate: count how many checks are down.
    const downCount = Object.values(checks).filter(
      (c) => c.status === "down",
    ).length;

    let status: HealthResult["body"]["status"];
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

    const checkedAt = Date.now();
    return {
      body: { status, timestamp: new Date(checkedAt).toISOString(), checks },
      httpStatus,
      checkedAt,
    };
  } catch (err) {
    log.error("health endpoint failed", err as Error, {
      source: "api/health",
      route: "/api/health",
      method: "GET",
    });

    const checkedAt = Date.now();
    return {
      body: {
        status: "unhealthy",
        timestamp: new Date(checkedAt).toISOString(),
        checks: {
          db: { status: "down", latency_ms: 0 },
          clerk: { status: "down", latency_ms: 0 },
          stripe: { status: "down", latency_ms: 0 },
        },
      },
      httpStatus: 503,
      checkedAt,
    };
  }
}

/**
 * The latest result, running the checks only when the last result is older
 * than the TTL. Concurrent callers on a cold or expired cache share one run.
 */
async function currentResult(): Promise<{ result: HealthResult; cached: boolean }> {
  if (lastResult && Date.now() - lastResult.checkedAt < RESULT_TTL_MS) {
    return { result: lastResult, cached: true };
  }
  if (!running) {
    running = runChecks()
      .then((result) => {
        lastResult = result;
        return result;
      })
      .finally(() => {
        running = null;
      });
  }
  return { result: await running, cached: false };
}

/**
 * GET /api/health
 *
 * Lightweight health-check endpoint for uptime monitoring and load-balancer
 * probes. Runs three dependency checks in parallel (database, Clerk auth,
 * Stripe billing), aggregates the results, and returns a structured JSON
 * payload. The result is reused for RESULT_TTL_MS (see above); `cached` says
 * whether this answer was reused and `timestamp` says when the checks ran.
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
  const { result, cached } = await currentResult();
  return NextResponse.json(
    { ...result.body, cached },
    { status: result.httpStatus },
  );
}
