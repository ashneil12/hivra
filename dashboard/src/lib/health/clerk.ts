import { clerkClient } from "@clerk/nextjs/server";
import { log } from "@/lib/logger";

const LOG_SOURCE = "health.clerk";

export interface HealthCheckResult {
  status: "up" | "down";
  latency_ms: number;
}

/** Hard ceiling for the Clerk Backend API probe (3 seconds per spec). */
const CLERK_HEALTH_TIMEOUT_MS = 3_000;

/**
 * Reusable Clerk connectivity probe.
 *
 * Makes a single lightweight authenticated call (users.getUserList with
 * limit=1) to verify that the Clerk Backend API is reachable and the
 * configured secret key is valid. Measures round-trip latency and enforces
 * a 3-second hard timeout.
 *
 * NEVER throws — on any error (missing key, 401, network failure, timeout)
 * it resolves to `{ status: "down", latency_ms: 0 }`.
 */
export async function checkClerkHealth(): Promise<HealthCheckResult> {
  const start = Date.now();

  if (process.env.HIVRA_AUTH_MODE?.trim().toLowerCase() === "local") {
    return { status: "up", latency_ms: 0 };
  }

  if (!process.env.CLERK_SECRET_KEY) {
    log.warn("Clerk health check skipped: CLERK_SECRET_KEY not configured", {
      source: LOG_SOURCE,
    });
    return { status: "down", latency_ms: 0 };
  }

  try {
    const clerk = await clerkClient();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `Clerk health check timed out after ${CLERK_HEALTH_TIMEOUT_MS}ms`,
            ),
          ),
        CLERK_HEALTH_TIMEOUT_MS,
      );
    });

    try {
      await Promise.race([
        clerk.users.getUserList({ limit: 1 }),
        timeoutPromise,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    return {
      status: "up",
      latency_ms: Date.now() - start,
    };
  } catch (error) {
    log.warn("Clerk health check failed", {
      source: LOG_SOURCE,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      status: "down",
      latency_ms: 0,
    };
  }
}
