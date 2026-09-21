import { getStripe } from "@/lib/stripe";
import { log } from "@/lib/logger";

const LOG_SOURCE = "health.stripe";

export interface HealthCheckResult {
  status: "up" | "down";
  latency_ms: number;
}

/** Hard ceiling for the Stripe API probe (3 seconds per spec). */
const STRIPE_HEALTH_TIMEOUT_MS = 3_000;

/**
 * Reusable Stripe connectivity probe.
 *
 * Makes a single lightweight authenticated call (balance.retrieve) to verify
 * that the Stripe API is reachable and the configured secret key is valid.
 * Measures round-trip latency and enforces a 3-second hard timeout.
 *
 * NEVER throws — on any error (missing key, 401, network failure, timeout)
 * it resolves to `{ status: "down", latency_ms: 0 }`.
 */
export async function checkStripeHealth(): Promise<HealthCheckResult> {
  const start = Date.now();

  if (process.env.HIVRA_AUTH_MODE?.trim().toLowerCase() === "local") {
    return { status: "up", latency_ms: 0 };
  }

  try {
    const stripe = getStripe();

    // Race the Stripe call against a hard timeout. If the timeout wins we
    // resolve "down" rather than letting the request hang the health endpoint.
    // The timer is always cleared after the race so it can't leak.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `Stripe health check timed out after ${STRIPE_HEALTH_TIMEOUT_MS}ms`,
            ),
          ),
        STRIPE_HEALTH_TIMEOUT_MS,
      );
    });

    try {
      await Promise.race([stripe.balance.retrieve(), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    return {
      status: "up",
      latency_ms: Date.now() - start,
    };
  } catch (error) {
    log.warn("Stripe health check failed", {
      source: LOG_SOURCE,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      status: "down",
      latency_ms: 0,
    };
  }
}
