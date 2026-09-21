import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { runResourceWatchdog } from "@/lib/recovery/resource-watchdog";

/**
 * Cron-triggered resource watchdog. See src/lib/recovery/resource-watchdog.ts.
 *
 * Reads instance_metering_events that the existing sample-instance-metrics
 * cron already populates and applies two heuristics:
 *
 *   1. Free-tier RAM cap pinned (≥95% of ram_limit averaged over the last
 *      ~60 min of available samples; not proof of an OOM crash): graceful
 *      qm shutdown, lifecycle_state='paused' /
 *      paused_reason='ram_cap_hit', auto-resolved instance_flags row, plus a
 *      customer email explaining the pause and how to review resources. The
 *      dashboard surfaces the same reason on next load; the email is what
 *      reaches Telegram/Discord users who never open it.
 *   2. Paid-tier sustained CPU (≥95% of cpu_limit over the last 24h):
 *      open instance_flags row, friendly customer email, admin email to
 *      HERMES_ADMIN_ALERT_EMAIL. No auto-suspend — operator decides.
 *
 * Schedule: every 15 minutes via vercel.json. The instance_flags
 * (instance_id, flag_type) partial unique index keeps cron retries
 * idempotent — re-firing on an already-flagged instance is a no-op.
 */
export const dynamic = "force-dynamic";
// Graceful qm shutdowns + customer emails across the free-tier cohort can take
// real wall-time; give it a ceiling above the default so a busy run isn't
// truncated mid-shutdown.
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(
      "CRON_SECRET is not configured; refusing to run",
      new Error("CRON_SECRET missing"),
      {
        source: "resource-watchdog",
        route: "/api/cron/resource-watchdog",
        method: "GET",
        failureType: "cron_secret_missing",
      },
    );
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  // Operator kill-switch. This cron has real destructive side effects (graceful
  // qm shutdown of free-tier VMs + customer emails) but previously had NO way to
  // disable it short of removing the cron entry — so a faulty heuristic or a
  // stale ram_limit could mass-pause free agents with no off-ramp. Gate on a NEW
  // env flag that DEFAULTS OFF (i.e. the watchdog runs exactly as before unless
  // someone explicitly sets RESOURCE_WATCHDOG_DISABLED=true). When disabled the
  // route is an auditable no-op rather than silently doing nothing.
  const disabledRaw = process.env.RESOURCE_WATCHDOG_DISABLED?.trim().toLowerCase();
  const disabled = disabledRaw === "true" || disabledRaw === "1" || disabledRaw === "yes";
  if (disabled) {
    log.warn("resource watchdog disabled via RESOURCE_WATCHDOG_DISABLED; skipping run", {
      source: "resource-watchdog",
      route: "/api/cron/resource-watchdog",
      method: "GET",
    });
    return apiSuccess({ ok: true, disabled: true, mode: "disabled" });
  }

  try {
    const summary = await runResourceWatchdog();
    return apiSuccess(summary);
  } catch (err) {
    log.error("resource watchdog failed", err, {
      source: "resource-watchdog",
      route: "/api/cron/resource-watchdog",
      method: "GET",
      failureType: "resource_watchdog_failed",
    });
    const message = err instanceof Error ? err.message : "Resource watchdog failed";
    return apiError(message, 500);
  }
}
