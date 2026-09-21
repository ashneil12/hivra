/**
 * Cron: auto-seed one daily standing task for newly-running, goal-having agents.
 *
 * Selection, the 0-existing-jobs guard, idempotency stamping, and box create all
 * live in @/lib/seed-standing-tasks (runStandingTaskSeedSweep). DEFAULT-OFF: the
 * deploy is inert until AUTO_SEED_STANDING_TASKS_ENABLED=true is set in the
 * Vercel env — exactly like lifecycle-emails' default-off gate.
 *
 * Auth: Bearer CRON_SECRET. Env knobs:
 *   AUTO_SEED_STANDING_TASKS_ENABLED      (default false — kill flag)
 *   AUTO_SEED_STANDING_TASKS_BATCH_SIZE   (default 25 — max seeds per run)
 *
 * nodejs runtime + a long maxDuration: the sweep makes per-instance signed box
 * calls (list + create) over the gateway, which use node crypto + insecure-TLS
 * fetch — mirrors the other box-touching crons.
 */

import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { runStandingTaskSeedSweep } from "@/lib/seed-standing-tasks";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const LOG_SOURCE = "cron:seed-standing-tasks";

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return v === "true" || v === "1" || v === "yes";
}

async function handle(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return apiError("Cron secret is not configured", 500);
  if (!verifyBearerHeader(req, cronSecret)) return apiError("Unauthorized", 401);

  const enabled = envBool("AUTO_SEED_STANDING_TASKS_ENABLED", false);
  if (!enabled) {
    return apiSuccess({
      ok: true,
      enabled: false,
      skipped: "AUTO_SEED_STANDING_TASKS_ENABLED is off",
    });
  }

  if (!supabaseAdmin) return apiError("Database not configured", 500);

  try {
    const summary = await runStandingTaskSeedSweep();
    log.info("seed-standing-tasks cron complete", { source: LOG_SOURCE, ...summary });
    return apiSuccess({ ok: true, enabled: true, ...summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("seed-standing-tasks cron failed", err, { source: LOG_SOURCE });
    return apiError(`standing-task seed sweep failed: ${message}`, 500);
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
