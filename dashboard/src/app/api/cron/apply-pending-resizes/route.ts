/**
 * Cron: apply pending per-instance cap changes by redeploying the container.
 *
 * applyTierChange flags `tier_change_pending = true` on instances whose caps
 * changed (tier or Venice boost). The caps are baked into the container's
 * compose limits, so the new compute only reaches the agent after a
 * volume-safe container recreate. The instant wallet-unlock flow handles a
 * user's own instances immediately; this background sweep covers everything
 * else (card upgrades, the $HERMESOS refresh-token-tiers cron, etc.).
 *
 * Idle-first ordering (last_activity_at ASC, NULLs first) so the least
 * disruptive instances are recreated first; bounded per tick to stay inside
 * the function time budget. Reuses applyLiveUpdate (keeps named volumes — no
 * data loss) and clears the flag on success; failures are simply retried next
 * tick (idempotent). This sweep is a system update: a box with an agent turn in
 * flight is deferred (flag kept, retried next tick) until the turn ends or the
 * in-flight gate's cap is reached.
 */

import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { supabaseAdmin } from "@/lib/supabase";
import {
  redeployPendingResizes,
  PENDING_RESIZE_SELECT,
  type PendingResizeRow,
} from "@/lib/services/pending-resize";
import { systemLiveUpdate } from "@/lib/services/live-update-initiator";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { WEBFREE_BACKENDS } from "@/lib/types/instance";

const SOURCE = "cron/apply-pending-resizes";
const ROUTE = "/api/cron/apply-pending-resizes";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Bounded per tick — each recreate is ~30-90s; at concurrency 5 this stays
// well inside maxDuration. Leftovers are picked up next tick.
const BATCH_LIMIT = 20;

async function handle(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("CRON_SECRET missing"), {
      source: SOURCE,
      route: ROUTE,
      failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }
  if (!supabaseAdmin) {
    return apiError("Database not configured", 500);
  }

  const { data, error } = await supabaseAdmin
    .from("hermes_instances")
    .select(PENDING_RESIZE_SELECT)
    .in("backend", WEBFREE_BACKENDS)
    .eq("tier_change_pending", true)
    .not("status", "in", '("deleted","scheduled_for_deletion")')
    .order("last_activity_at", { ascending: true, nullsFirst: true })
    .limit(BATCH_LIMIT);

  if (error) {
    log.error("apply-pending-resizes query failed", new Error("supabase_query_failed"), {
      source: SOURCE,
      route: ROUTE,
      failureType: "apply_pending_resizes_query_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return apiError("Failed to query pending resizes", 500);
  }

  const rows = (data ?? []) as unknown as PendingResizeRow[];
  if (rows.length === 0) {
    return apiSuccess({ pending: 0, redeployed: 0, failed: 0, skipped: 0, deferred: 0 });
  }

  const summary = await redeployPendingResizes(rows, {
    concurrency: 5,
    initiator: systemLiveUpdate("pending_resize_sweep"),
  });

  log.info("apply-pending-resizes sweep complete", {
    source: SOURCE,
    route: ROUTE,
    pending: rows.length,
    redeployed: summary.redeployed,
    failed: summary.failed,
    skipped: summary.skipped,
    deferred: summary.deferred,
  });

  // Backlog + failure observability. BATCH_LIMIT=20/tick is a deliberate
  // throttle (kept), but a persistent per-instance redeploy failure just retries
  // forever (the flag never clears) with no escalation, and a large backlog
  // (e.g. after a fleet-wide refresh-token-tiers run) drains slowly with no
  // signal. Count the total pending population and emit a warn event when any
  // redeploy failed OR the backlog exceeds one batch. Best-effort.
  let totalPending: number | null = null;
  if (summary.failed > 0 || rows.length >= BATCH_LIMIT) {
    const { count } = await supabaseAdmin
      .from("hermes_instances")
      .select("id", { count: "exact", head: true })
      .in("backend", WEBFREE_BACKENDS)
      .eq("tier_change_pending", true)
      .not("status", "in", '("deleted","scheduled_for_deletion")');
    totalPending = count ?? null;
  }
  if (summary.failed > 0 || (totalPending !== null && totalPending > BATCH_LIMIT)) {
    await reportOpsEvent({
      source: "cron.apply_pending_resizes_backlog",
      severity: "warn",
      title: `apply-pending-resizes: ${summary.failed} failed, ${totalPending ?? rows.length} pending`,
      message:
        `apply-pending-resizes redeployed ${summary.redeployed} and failed ${summary.failed} this tick ` +
        `(batch ${rows.length}/${BATCH_LIMIT}; total pending=${totalPending ?? "unknown"}). ` +
        `A persistent redeploy failure retries forever with the flag stuck; a large backlog drains only ` +
        `${BATCH_LIMIT}/15min so the slowest upgrades lag hours. Check the failed instances + ghcr/SSH health.`,
      route: ROUTE,
      metadata: {
        batch: rows.length,
        batch_limit: BATCH_LIMIT,
        redeployed: summary.redeployed,
        failed: summary.failed,
        skipped: summary.skipped,
        deferred: summary.deferred,
        total_pending: totalPending,
      },
    });
  }

  return apiSuccess({ pending: rows.length, totalPending, ...summary });
}

export const GET = handle;
export const POST = handle;
