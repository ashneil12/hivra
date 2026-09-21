/**
 * Cron: lifecycle emails (day1/day3/day7 + stalled).
 *
 * Daily sweep over recent signups + stalled instances; selection, send and
 * idempotency live in @/lib/recovery/lifecycle-email-sweep. Default-OFF: deploys
 * inert until LIFECYCLE_EMAILS_ENABLED=true is set in the Vercel env.
 *
 * Auth: Bearer CRON_SECRET. Env knobs:
 *   LIFECYCLE_EMAILS_ENABLED      (default false — gate)
 *   LIFECYCLE_EMAILS_BATCH_SIZE   (default 50 — max sends per run)
 */

import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { runLifecycleEmailSweep } from "@/lib/recovery/lifecycle-email-sweep";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const LOG_SOURCE = "cron:lifecycle-emails";

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return v === "true" || v === "1" || v === "yes";
}

async function handle(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return apiError("Cron secret is not configured", 500);
  if (!verifyBearerHeader(req, cronSecret)) return apiError("Unauthorized", 401);

  const enabled = envBool("LIFECYCLE_EMAILS_ENABLED", false);
  if (!enabled) {
    return apiSuccess({ ok: true, enabled: false, skipped: "LIFECYCLE_EMAILS_ENABLED is off" });
  }

  if (!supabaseAdmin) return apiError("Database not configured", 500);

  try {
    const summary = await runLifecycleEmailSweep();
    log.info("lifecycle-emails cron complete", { source: LOG_SOURCE, ...summary });
    return apiSuccess({ ok: true, enabled: true, ...summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("lifecycle-emails cron failed", err, { source: LOG_SOURCE });
    return apiError(`lifecycle email sweep failed: ${message}`, 500);
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
