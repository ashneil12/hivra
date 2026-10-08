import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { runServerEnrollmentRetention } from "@/lib/ops/server-enrollment-retention";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * Daily sweep of server setup commands: expiry, key wiping and retention.
 * See src/lib/ops/server-enrollment-retention.ts. Schedule: vercel.json.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("CRON_SECRET missing"), {
      source: "sweep-server-enrollments",
      route: "/api/cron/sweep-server-enrollments",
      method: "GET",
      failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) return apiError("Unauthorized", 401);
  if (!supabaseAdmin) return apiError("Database is not configured", 500);
  try {
    const summary = await runServerEnrollmentRetention();
    log.info("sweep-server-enrollments run", { source: "sweep-server-enrollments", ...summary });
    return apiSuccess(summary);
  } catch (error) {
    log.error("sweep-server-enrollments failed", error instanceof Error ? error : new Error(String(error)), {
      source: "sweep-server-enrollments",
      route: "/api/cron/sweep-server-enrollments",
      method: "GET",
      failureType: "server_enrollment_sweep_failed",
    });
    return apiError("Server enrollment sweep failed", 500);
  }
}
