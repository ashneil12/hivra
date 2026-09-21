/**
 * Cron: cold-storage retention sweep.
 *
 * Two passes per run (per docs/cold-storage-orchestration.md §5):
 *
 *   A) Mark eligible cold_archived rows as pending_deletion, setting
 *      scheduled_deletion_at = archived_at + retention.
 *
 *   B) Purge rows whose scheduled_deletion_at has passed via purgeArchive()
 *      (moves to trash/<id>-<ts>/ on the Storage Box, flags row deleted).
 *
 * Free-tier retention: 60d. Paid (entitlement_state in cancelled/past_due): 30d.
 * Grace window before pending_deletion fires: 7d for both.
 *
 * Auth: Bearer CRON_SECRET.
 *
 * Env knobs:
 *   COLD_STORAGE_RETENTION_ENABLED            "true" to mutate; default false
 *   COLD_STORAGE_RETENTION_FREE_DAYS          default 60
 *   COLD_STORAGE_RETENTION_PAID_DAYS          default 30
 *   COLD_STORAGE_RETENTION_GRACE_DAYS         default 7
 *   COLD_STORAGE_RETENTION_BATCH_SIZE         default 100
 *   COLD_STORAGE_PURGE_HOST                   required when purging due archives
 */

import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { purgeArchive, type ColdPurgeResult } from "@/lib/services/cold-storage-service";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";
// Pass B makes one SSH-backed purgeArchive() per due row up to batchSize=100; a
// backlog could exceed the default function budget and be SIGTERM'd mid-loop
// with no signal. Give it a real ceiling.
export const maxDuration = 800;

const LOG_SOURCE = "cron:cold-retention-sweep";

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return v === "true" || v === "1" || v === "yes";
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

type RetentionRow = {
  id: string;
  resource_tier: string | null;
  archived_at: string | null;
  scheduled_deletion_at: string | null;
  entitlement_state: string | null;
  lifecycle_state: string | null;
};

async function handle(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return apiError("Cron secret is not configured", 500);
  if (!verifyBearerHeader(req, cronSecret)) return apiError("Unauthorized", 401);
  if (!supabaseAdmin) return apiError("Database not configured", 500);

  const enabled = envBool("COLD_STORAGE_RETENTION_ENABLED", false);
  const freeDays = Math.max(7, envInt("COLD_STORAGE_RETENTION_FREE_DAYS", 60));
  const paidDays = Math.max(7, envInt("COLD_STORAGE_RETENTION_PAID_DAYS", 30));
  const graceDays = Math.max(1, envInt("COLD_STORAGE_RETENTION_GRACE_DAYS", 7));
  const batchSize = Math.max(1, Math.min(500, envInt("COLD_STORAGE_RETENTION_BATCH_SIZE", 100)));

  const nowMs = Date.now();
  const day = 86400_000;
  const freeMarkBefore = new Date(nowMs - (freeDays - graceDays) * day).toISOString();
  const paidMarkBefore = new Date(nowMs - (paidDays - graceDays) * day).toISOString();

  const markResults = { free_marked: 0, paid_marked: 0 };

  if (enabled) {
    const { data: freeCandidates, error: freeErr } = await supabaseAdmin
      .from("hermes_instances")
      .select("id, archived_at")
      .eq("lifecycle_state", "cold_archived")
      .eq("resource_tier", "credit_base")
      .lt("archived_at", freeMarkBefore)
      .is("scheduled_deletion_at", null)
      .is("deleted_at", null)
      .limit(batchSize);
    if (freeErr) return apiError(`free-tier candidate query failed: ${freeErr.message}`, 500);

    for (const row of (freeCandidates ?? []) as Array<{ id: string; archived_at: string | null }>) {
      if (!row.archived_at) continue;
      const scheduled = new Date(new Date(row.archived_at).getTime() + freeDays * day).toISOString();
      const upd = await supabaseAdmin
        .from("hermes_instances")
        .update({
          lifecycle_state: "pending_deletion",
          scheduled_deletion_at: scheduled,
          last_lifecycle_transition_at: new Date().toISOString(),
        })
        .eq("id", row.id)
        .eq("lifecycle_state", "cold_archived")
        .select("id")
        .maybeSingle();
      if (!upd.error && upd.data) markResults.free_marked += 1;
    }

    const { data: paidCandidates, error: paidErr } = await supabaseAdmin
      .from("hermes_instances")
      .select("id, archived_at, resource_tier, entitlement_state")
      .eq("lifecycle_state", "cold_archived")
      .neq("resource_tier", "credit_base")
      .in("entitlement_state", ["cancelled", "past_due"])
      .lt("archived_at", paidMarkBefore)
      .is("scheduled_deletion_at", null)
      .is("deleted_at", null)
      .limit(batchSize);
    if (paidErr) return apiError(`paid-tier candidate query failed: ${paidErr.message}`, 500);

    for (const row of (paidCandidates ?? []) as Array<{ id: string; archived_at: string | null }>) {
      if (!row.archived_at) continue;
      const scheduled = new Date(new Date(row.archived_at).getTime() + paidDays * day).toISOString();
      const upd = await supabaseAdmin
        .from("hermes_instances")
        .update({
          lifecycle_state: "pending_deletion",
          scheduled_deletion_at: scheduled,
          last_lifecycle_transition_at: new Date().toISOString(),
        })
        .eq("id", row.id)
        .eq("lifecycle_state", "cold_archived")
        .select("id")
        .maybeSingle();
      if (!upd.error && upd.data) markResults.paid_marked += 1;
    }
  }

  // Pass B: purge expired rows
  const purgeResults = {
    purged: 0,
    failed: 0,
    perInstance: [] as Array<{ id: string; ok: boolean; reason?: string }>,
  };

  const { data: dueRows, error: dueErr } = await supabaseAdmin
    .from("hermes_instances")
    .select("id, resource_tier, archived_at, scheduled_deletion_at, entitlement_state, lifecycle_state")
    .eq("lifecycle_state", "pending_deletion")
    .lt("scheduled_deletion_at", new Date().toISOString())
    .is("deleted_at", null)
    .limit(batchSize);
  if (dueErr) return apiError(`due-rows query failed: ${dueErr.message}`, 500);

  const dueCandidates = (dueRows ?? []) as RetentionRow[];
  const purgeHost = process.env.COLD_STORAGE_PURGE_HOST?.trim();

  if (enabled) {
    if (dueCandidates.length > 0 && !purgeHost) {
      return apiError("COLD_STORAGE_PURGE_HOST is required when archive purging is enabled", 500);
    }
    for (const row of dueCandidates) {
      let result: ColdPurgeResult;
      try {
        result = await purgeArchive(supabaseAdmin, row.id, { hostSlug: purgeHost! });
      } catch (err) {
        purgeResults.failed += 1;
        purgeResults.perInstance.push({
          id: row.id,
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      if (result.ok) {
        purgeResults.purged += 1;
        purgeResults.perInstance.push({ id: row.id, ok: true });
        log.info("purged cold archive", {
          source: LOG_SOURCE,
          instanceId: row.id,
          trashUri: result.trashUri,
        });
      } else {
        purgeResults.failed += 1;
        purgeResults.perInstance.push({ id: row.id, ok: false, reason: result.reason });
        log.warn("purge failed", {
          source: LOG_SOURCE,
          instanceId: row.id,
          failureType: "cold_purge_failed",
          reason: result.reason,
          message: result.message,
        });
      }
    }
  }

  log.info("cold-retention sweep complete", {
    source: LOG_SOURCE,
    enabled,
    markedFree: markResults.free_marked,
    markedPaid: markResults.paid_marked,
    purged: purgeResults.purged,
    purgeFailed: purgeResults.failed,
    dueCandidates: dueCandidates.length,
  });

  // Surface purge failures: previously per-row purge failures were only
  // log.warn'd and counted while the route returned 200 with ok:true, so silent
  // purge failures accumulated invisibly. Emit a warn event when any purge
  // failed and report an honest ok flag. Best-effort.
  if (purgeResults.failed > 0) {
    await reportOpsEvent({
      source: "cron.cold_retention_purge_failed",
      severity: "warn",
      title: `Cold-retention sweep: ${purgeResults.failed} of ${dueCandidates.length} purges failed`,
      message:
        `cold-retention-sweep purged ${purgeResults.purged} and failed ${purgeResults.failed} of ` +
        `${dueCandidates.length} due archive(s). Storage-Box purges may be stuck — check the ` +
        `configured purge host (${purgeHost}) and SSH health.`,
      route: "/api/cron/cold-retention-sweep",
      metadata: {
        enabled,
        candidates: dueCandidates.length,
        purged: purgeResults.purged,
        failed: purgeResults.failed,
        failed_instances: purgeResults.perInstance
          .filter((r) => !r.ok)
          .map((r) => ({ id: r.id, reason: r.reason })),
      },
    });
  }

  return apiSuccess({
    ok: purgeResults.failed === 0,
    mode: enabled ? "applied" : "dry_run",
    freeDays,
    paidDays,
    graceDays,
    marked: markResults,
    purge: {
      candidates: dueCandidates.length,
      purged: purgeResults.purged,
      failed: purgeResults.failed,
    },
    perInstance: purgeResults.perInstance,
  });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
