import { NextRequest } from "next/server";

import { apiSuccess, apiError } from "@/lib/api-response";
import { supabaseAdmin } from "@/lib/supabase";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import type { HermesInstanceRow } from "@/app/api/instances/[id]/route";
import { syncComposioToInstance } from "@/lib/composio/sync-connectors";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const maxDuration = 300;

const ROUTE = "/api/cron/sync-connectors";
const SOURCE = "cron.sync-connectors";
const MAX_INSTANCE_IDS = 50;
// The scheduled GET sweep converges config across the fleet. Bounded per run so
// one invocation stays inside the function window; coverage accretes across runs
// and via the live per-user sync. Config-only (restart: "never") so a broad
// sweep never ripple-restarts boxes / drops live agent sessions.
const RECONCILE_DEFAULT_LIMIT = 40;
const RECONCILE_MAX_LIMIT = 100;

function parseInstanceIds(body: unknown): string[] | null {
  const raw = (body as { instanceIds?: unknown } | null)?.instanceIds;
  if (!Array.isArray(raw)) return null;
  const ids = raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  return ids.length ? ids : null;
}

type SyncResult = {
  id: string;
  applied: boolean;
  backend?: string;
  reason?: string;
  error?: string;
  changed?: boolean;
  restarted?: boolean;
};

/**
 * POST /api/cron/sync-connectors
 *
 * Ops backfill: writes each box's single `composio` MCP entry so a user's
 * already-connected apps reach the agent WITHOUT them reopening the dashboard.
 * The per-box bearer is computed server-side from each instance's OWNER user id
 * (never a Clerk session), via the same shared helper the per-user
 * connectors-sync route uses. Config-only (restart: "never") so a batch backfill
 * never bounces boxes or drops live agent sessions. CRON_SECRET-gated. Per-box
 * failures are recorded and don't abort the batch.
 *
 * Trigger: manual/ops backfill. The scheduled fleet convergence is the GET
 * handler below (Vercel cron sends a bodyless GET); this POST form is for
 * targeting an explicit set of boxes (with optional dryRun). Ongoing per-user
 * syncs run live via /api/instances/[id]/connectors-sync when a user connects.
 *
 * Body: { instanceIds: string[], dryRun?: boolean }.
 */
export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return apiError("Cron secret is not configured", 500);
  if (!verifyBearerHeader(req, cronSecret)) return apiError("Unauthorized", 401);
  if (!supabaseAdmin) return apiError("Database not configured", 500);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError("Invalid JSON body", 400);
  }

  const instanceIds = parseInstanceIds(body);
  if (!instanceIds) return apiError("Pass instanceIds as a non-empty array", 400);
  if (instanceIds.length > MAX_INSTANCE_IDS) {
    return apiError(`At most ${MAX_INSTANCE_IDS} instances can be synced at once`, 400);
  }
  // dryRun: compute + return the entry that WOULD be written, without touching
  // the box — so ops can apply it directly when the box-write transport is down.
  const dryRun = (body as { dryRun?: boolean } | null)?.dryRun === true;

  const { data, error } = await supabaseAdmin
    .from("hermes_instances")
    .select("*")
    .in("id", instanceIds);
  if (error) return apiError("Failed to query instances", 500);

  const rowsById = new Map(
    ((data || []) as unknown as HermesInstanceRow[]).map((row) => [row.id, row]),
  );

  const results: SyncResult[] = [];
  for (const id of instanceIds) {
    const instance = rowsById.get(id);
    if (!instance) {
      results.push({ id, applied: false, reason: "not_found" });
      continue;
    }
    const userId = (instance as { user_id?: string | null }).user_id;
    if (!userId) {
      results.push({ id, applied: false, reason: "no_owner" });
      continue;
    }
    if (dryRun) {
      results.push({ id, applied: false, reason: "dry_run" });
      continue;
    }
    try {
      const result = await syncComposioToInstance({ instanceId: id, userId, instance, restart: "never" });
      results.push({ id, ...result });
    } catch (err) {
      log.error(
        "connectors-sync backfill failed for instance",
        err instanceof Error ? err : new Error(String(err)),
        { source: SOURCE, route: ROUTE, method: "POST", instanceId: id, failureType: "connectors_sync_failed" },
      );
      results.push({ id, applied: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const appliedCount = results.filter((r) => r.applied).length;

  // A batch where every box hit a real error (not a benign skip / dry run) would
  // otherwise return 200 with applied:0 and no operator signal. Surface it so an
  // all-failed backfill is visible. erroredCount counts only real errors, so a
  // dryRun or a batch of benign skips never trips this.
  const erroredCount = results.filter((r) => r.error).length;
  if (!dryRun && erroredCount > 0 && appliedCount === 0) {
    await reportOpsEvent({
      source: SOURCE,
      severity: "warn",
      title: `Connectors backfill failed for all ${erroredCount} box(es)`,
      message:
        `sync-connectors applied to 0 of ${instanceIds.length} requested instance(s); ` +
        `${erroredCount} hit a real error. Users' already-connected accounts won't reach ` +
        `their agent until this clears. Check SSH / agent-API reachability for the targeted boxes.`,
      route: ROUTE,
      metadata: {
        failureType: "connectors_sync_all_failed",
        requested: instanceIds.length,
        applied: appliedCount,
        errored: erroredCount,
      },
    });
  }

  return apiSuccess({ total: instanceIds.length, applied: appliedCount, results });
}

/**
 * GET /api/cron/sync-connectors
 *
 * Scheduled fleet convergence: ensure every active box carries its per-user
 * `composio` MCP entry, so a user who connected apps but never reopened the
 * dashboard (and whose connect predated the post-connect callback) still reaches
 * their agent. CRON_SECRET-gated (Vercel cron sends the bearer). Config-only
 * (restart: "never") — a broad sweep must never ripple-restart the fleet or drop
 * live agent sessions; newly-registered boxes surface the tools on their next
 * natural roll. Bounded per run; coverage accretes across runs + live syncs.
 * No-op for a user with no Composio key / no connected apps (syncComposioToInstance
 * returns applied:false, reason:"composio_disabled").
 */
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return apiError("Cron secret is not configured", 500);
  if (!verifyBearerHeader(req, cronSecret)) return apiError("Unauthorized", 401);
  if (!supabaseAdmin) return apiError("Database not configured", 500);

  const limitRaw = Number(new URL(req.url).searchParams.get("limit") ?? String(RECONCILE_DEFAULT_LIMIT));
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(Math.trunc(limitRaw), 1), RECONCILE_MAX_LIMIT)
    : RECONCILE_DEFAULT_LIMIT;

  // Rotate a limit-sized window across the WHOLE eligible fleet over successive
  // runs. A fixed newest-N (order + limit) would re-touch the same head forever
  // and never reach the tail; instead we count the fleet and advance the window
  // each run so every active box is reconciled within ceil(total/limit) runs.
  const { count } = await supabaseAdmin
    .from("hermes_instances")
    .select("id", { count: "exact", head: true })
    .eq("lifecycle_state", "active")
    .eq("infrastructure_provider", "proxmox");
  const total = count ?? 0;
  const windows = Math.max(1, Math.ceil(total / limit));
  // One step per 12h run (the cron cadence); wraps around the fleet.
  const runIndex = Math.floor(Date.now() / (12 * 60 * 60 * 1000));
  const from = (runIndex % windows) * limit;

  const { data, error } = await supabaseAdmin
    .from("hermes_instances")
    .select("*")
    .eq("lifecycle_state", "active")
    .eq("infrastructure_provider", "proxmox")
    .order("created_at", { ascending: true })
    .range(from, from + limit - 1);
  if (error) return apiError("Failed to query instances", 500);

  const rows = ((data || []) as unknown as HermesInstanceRow[]).filter(
    (row) => typeof (row as { user_id?: string | null }).user_id === "string",
  );

  let applied = 0;
  let changed = 0;
  let errored = 0;
  for (const instance of rows) {
    const userId = (instance as { user_id?: string | null }).user_id as string;
    try {
      const result = await syncComposioToInstance({
        instanceId: instance.id,
        userId,
        instance,
        restart: "never",
      });
      if (result.applied) {
        applied += 1;
        if (result.changed) changed += 1;
      }
    } catch (err) {
      errored += 1;
      // Per-box reachability failures are expected background noise on a fleet
      // sweep (booting / mid-roll boxes); log at info, don't raise an ops event.
      log.info("connectors-sync reconcile skipped a box", {
        source: SOURCE,
        route: ROUTE,
        method: "GET",
        instanceId: instance.id,
        failureType: "connectors_sync_reconcile_skip",
        errorName: err instanceof Error ? err.name : typeof err,
      });
    }
  }

  return apiSuccess({ scanned: rows.length, applied, changed, errored, limit, total, window: { from, windows } });
}
