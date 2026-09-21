/**
 * Cron: auto-seed one "Daily brief" scheduled job per running agent.
 *
 * Selection, idempotency stamping, the existing-brief guard, and box create all
 * live in @/lib/daily-brief (runDailyBriefSeedSweep). DEFAULT-OFF: the deploy is
 * inert until DAILY_BRIEF_SEED_ENABLED=true is set in the Vercel env — exactly
 * like the seed-standing-tasks gate.
 *
 * Auth: Bearer CRON_SECRET. Env knobs:
 *   DAILY_BRIEF_SEED_ENABLED     (default false — kill flag)
 *   DAILY_BRIEF_SEED_BATCH_SIZE  (default 25 — max seeds per run)
 */

import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { resolveBriefSeedEnabled, runDailyBriefSeedSweep } from "@/lib/daily-brief";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const LOG_SOURCE = "cron:seed-daily-brief";

async function handle(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return apiError("Cron secret is not configured", 500);
  if (!verifyBearerHeader(req, cronSecret)) return apiError("Unauthorized", 401);

  if (!resolveBriefSeedEnabled()) {
    return apiSuccess({ ok: true, enabled: false, skipped: "DAILY_BRIEF_SEED_ENABLED is off" });
  }

  if (!supabaseAdmin) return apiError("Database not configured", 500);

  try {
    const summary = await runDailyBriefSeedSweep();
    log.info("seed-daily-brief cron complete", { source: LOG_SOURCE, ...summary });
    return apiSuccess({ ok: true, enabled: true, ...summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("seed-daily-brief cron failed", err, { source: LOG_SOURCE });
    return apiError(`daily-brief seed sweep failed: ${message}`, 500);
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
