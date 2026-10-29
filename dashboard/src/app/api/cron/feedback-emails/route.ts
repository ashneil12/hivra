/**
 * Cron: feedback emails (paying-customer check-in + cancellation question).
 *
 * Daily sweep; selection, send and idempotency live in
 * @/lib/recovery/feedback-email-sweep. Default-OFF: deploys inert until
 * FEEDBACK_EMAILS_ENABLED=true is set in the Vercel env.
 *
 * Auth: Bearer CRON_SECRET. Env knobs:
 *   FEEDBACK_EMAILS_ENABLED      (default false — gate)
 *   FEEDBACK_EMAILS_BATCH_SIZE   (default 25 — max sends per run)
 */

import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { runFeedbackEmailSweep } from "@/lib/recovery/feedback-email-sweep";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const LOG_SOURCE = "cron:feedback-emails";

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return v === "true" || v === "1" || v === "yes";
}

async function handle(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return apiError("Cron secret is not configured", 500);
  if (!verifyBearerHeader(req, cronSecret)) return apiError("Unauthorized", 401);

  const enabled = envBool("FEEDBACK_EMAILS_ENABLED", false);
  if (!enabled) {
    return apiSuccess({ ok: true, enabled: false, skipped: "FEEDBACK_EMAILS_ENABLED is off" });
  }

  if (!supabaseAdmin) return apiError("Database not configured", 500);

  try {
    const summary = await runFeedbackEmailSweep();
    log.info("feedback-emails cron complete", { source: LOG_SOURCE, ...summary });
    return apiSuccess({ ok: true, enabled: true, ...summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("feedback-emails cron failed", err, { source: LOG_SOURCE });
    return apiError(`feedback email sweep failed: ${message}`, 500);
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
