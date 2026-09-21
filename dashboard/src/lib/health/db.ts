import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";

const LOG_SOURCE = "health.db";

export interface HealthCheckResult {
  status: "up" | "down";
  latency_ms: number;
}

/** Hard ceiling for the database probe (3 seconds per spec). */
const DB_HEALTH_TIMEOUT_MS = 3_000;

/**
 * Reusable database connectivity probe.
 *
 * Executes a lightweight head-count query against hermes_instances using
 * the shared supabaseAdmin client (service-role). No rows are transferred.
 * Enforces a 3-second hard timeout.
 *
 * NEVER throws — resolves to `{ status: "down", latency_ms: 0 }` on any error.
 */
export async function checkDbHealth(): Promise<HealthCheckResult> {
  const start = Date.now();

  if (!supabaseAdmin) {
    log.warn("DB health check skipped: supabaseAdmin not configured", {
      source: LOG_SOURCE,
    });
    return { status: "down", latency_ms: 0 };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `DB health check timed out after ${DB_HEALTH_TIMEOUT_MS}ms`,
          ),
        ),
      DB_HEALTH_TIMEOUT_MS,
    );
  });

  try {
    await Promise.race([
      supabaseAdmin
        .from("hermes_instances")
        .select("*", { count: "exact", head: true })
        .limit(1),
      timeoutPromise,
    ]);

    const latency_ms = Date.now() - start;

    return { status: "up", latency_ms };
  } catch (error) {
    const latency_ms = Date.now() - start;
    log.warn("DB health check failed", {
      source: LOG_SOURCE,
      error: error instanceof Error ? error.message : String(error),
    });

    return { status: "down", latency_ms };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
