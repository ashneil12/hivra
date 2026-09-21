/**
 * Admin: STAGED warm-pool Pro campaign (owner-triggered, double-gated).
 *
 * POST /api/admin/warm-pool-campaign
 * Body: { dryRun?: boolean (DEFAULT TRUE), limit?: number }
 *
 * Selects the engaged-free cohort (free plan + running instance + activity
 * within 7 days — the same definition as the insights funnel's engaged
 * pool), excludes anyone already pitched Pro (lifecycle_email_sends key
 * 'day7_offer' or 'warm_pool_2026_06'), and either previews (dry run) or
 * sends the one warm-pool email. All selection/send logic lives in
 * @/lib/recovery/warm-pool-campaign-sweep.
 *
 * NOTHING SENDS WHEN THIS MERGES:
 *   - dryRun defaults TRUE; only an explicit `"dryRun": false` plans a send.
 *   - Even then, WARM_POOL_CAMPAIGN_ENABLED (env, default false) must be
 *     flipped or the run is inert and the response says which gate blocked.
 *
 * Auth — two accepted callers, both fail closed:
 *   1. Bearer CRON_SECRET (operator curl; same scheme as the other
 *      /api/admin/* routes, e.g. restore-batch).
 *   2. A Clerk session for the ops admin — the exact isOpsAdminUser /
 *      OPS_ADMIN_EMAILS check the /dashboard/insights surface uses.
 *      Unauthenticated → 401, authenticated non-admin → 403.
 */

import { NextRequest } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { isOpsAdminUser } from "@/lib/ops-access";
import { runWarmPoolCampaign } from "@/lib/recovery/warm-pool-campaign-sweep";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const LOG_SOURCE = "admin:warm-pool-campaign";

async function isAuthorized(req: NextRequest): Promise<{ ok: boolean; status: 401 | 403 }> {
  // Operator curl path: Bearer CRON_SECRET (constant-time compare).
  if (verifyBearerHeader(req, process.env.CRON_SECRET)) {
    return { ok: true, status: 401 };
  }

  // Dashboard path: the insights-page admin check (OPS_ADMIN_EMAILS).
  const { userId } = await auth();
  if (!userId) return { ok: false, status: 401 };
  const user = await currentUser();
  const userEmail =
    user?.primaryEmailAddress?.emailAddress ||
    user?.emailAddresses?.[0]?.emailAddress ||
    null;
  if (!isOpsAdminUser({ userId: userId || user?.id || null, email: userEmail })) {
    return { ok: false, status: 403 };
  }
  return { ok: true, status: 401 };
}

export async function POST(req: NextRequest) {
  const authz = await isAuthorized(req);
  if (!authz.ok) {
    return apiError(authz.status === 401 ? "Unauthorized" : "Forbidden", authz.status);
  }

  if (!supabaseAdmin) return apiError("Database not configured", 500);

  let body: { dryRun?: unknown; limit?: unknown } = {};
  try {
    const raw = await req.text();
    if (raw.trim().length > 0) body = JSON.parse(raw) as typeof body;
  } catch {
    return apiError("Invalid JSON body", 400);
  }

  // Belt and braces: ONLY the literal boolean false turns the dry run off.
  // Absent, true, "false", null — anything else stays a dry run.
  const dryRun = body.dryRun !== false;

  let limit: number | undefined;
  if (body.limit !== undefined) {
    if (typeof body.limit !== "number" || !Number.isFinite(body.limit) || body.limit < 1) {
      return apiError("limit must be a positive number", 400);
    }
    limit = Math.floor(body.limit);
  }

  try {
    const summary = await runWarmPoolCampaign({ dryRun, limit });
    log.info("warm-pool campaign run complete", { source: LOG_SOURCE, ...summary });
    if (summary.blockedBy) {
      return apiSuccess({
        ok: true,
        ...summary,
        message:
          "Real send requested but blocked: WARM_POOL_CAMPAIGN_ENABLED is not 'true' in this deployment. No email was sent.",
      });
    }
    return apiSuccess({ ok: true, ...summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("warm-pool campaign run failed", err, { source: LOG_SOURCE });
    return apiError(`warm-pool campaign failed: ${message}`, 500);
  }
}
