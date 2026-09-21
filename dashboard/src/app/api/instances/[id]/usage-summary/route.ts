import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import {
  summarizeInstanceUsage,
  type UsageSnapshotRow,
} from "@/lib/usage-summary";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;

function resolveDays(raw: string | null): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, Math.trunc(parsed));
}

/**
 * GET /api/instances/[id]/usage-summary?days=7
 *
 * The "what your agent did" rollup. instance_usage_snapshots is service_role-
 * only, so we read it with supabaseAdmin AFTER gating on the caller owning the
 * instance (user_id = Clerk userId). Side-effect-free: no gateway/API-key work.
 */
export async function GET(req: NextRequest, { params }: RouteParams) {
  const { userId } = await auth();
  if (!userId) return apiError("Unauthorized", 401);

  const { id } = await params;
  const days = resolveDays(new URL(req.url).searchParams.get("days"));

  if (!supabaseAdmin) return apiError("Database not configured", 500);

  // Ownership gate: the caller must own this (non-deleted) instance.
  const { data: owned, error: ownErr } = await supabaseAdmin
    .from("hermes_instances")
    .select("id")
    .eq("id", id)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .maybeSingle();
  if (ownErr) {
    log.warn("usage-summary ownership lookup failed", {
      source: "instance-usage-summary",
      route: "/api/instances/[id]/usage-summary",
      instanceId: id,
      failureType: "usage_summary_owner_lookup_failed",
    });
    return apiError("Failed to load instance", 500);
  }
  if (!owned) return apiError("Instance not found or unauthorized", 404);

  // stat_date is a UTC DATE; bound the query to the window's calendar floor.
  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const { data: rows, error } = await supabaseAdmin
    .from("instance_usage_snapshots")
    .select(
      "stat_date, total_tokens, sessions, api_calls, tool_calls, estimated_cost_usd, by_model"
    )
    .eq("instance_id", id)
    .gte("stat_date", sinceIso);
  if (error) {
    log.warn("usage-summary snapshot query failed", {
      source: "instance-usage-summary",
      route: "/api/instances/[id]/usage-summary",
      instanceId: id,
      failureType: "usage_summary_snapshot_query_failed",
    });
    return apiError("Failed to load usage", 500);
  }

  const summary = summarizeInstanceUsage((rows ?? []) as UsageSnapshotRow[], days);
  return apiSuccess(summary);
}
