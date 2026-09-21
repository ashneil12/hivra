/**
 * Cron: weekly cold-storage integrity audit.
 *
 * Samples cold_archived/pending_deletion rows and calls
 * verifyArchiveIntegrity() in "slice" mode against each. Surfaces failures
 * via log.warn for ops to page on. Per docs/cold-storage-orchestration.md §2 I7.
 */

import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import {
  verifyArchiveIntegrity,
  type ColdVerifyResult,
} from "@/lib/services/cold-storage-service";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";
import { resolveColdStorageAuditHost } from "./audit-config";

export const dynamic = "force-dynamic";
// Up to 50 SSH-backed slice verifications per run can exceed the default
// function budget on a slow host. Give it a real ceiling.
export const maxDuration = 800;

const LOG_SOURCE = "cron:cold-storage-audit";

function envInt(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envFloat(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

async function handle(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return apiError("Cron secret is not configured", 500);
  if (!verifyBearerHeader(req, cronSecret)) return apiError("Unauthorized", 401);
  if (!supabaseAdmin) return apiError("Database not configured", 500);

  const samplePct = Math.min(1, Math.max(0.01, envFloat("COLD_STORAGE_AUDIT_SAMPLE_PCT", 0.05)));
  const batchSize = Math.max(1, Math.min(200, envInt("COLD_STORAGE_AUDIT_BATCH_SIZE", 50)));
  const auditHost = resolveColdStorageAuditHost();
  if (!auditHost) {
    return apiError("COLD_STORAGE_AUDIT_HOST is not configured", 500);
  }

  const { count, error: countErr } = await supabaseAdmin
    .from("hermes_instances")
    .select("id", { count: "exact", head: true })
    .in("lifecycle_state", ["cold_archived", "pending_deletion"])
    .not("archive_uri", "is", null)
    .is("deleted_at", null);
  if (countErr) return apiError(`count query failed: ${countErr.message}`, 500);

  const total = count ?? 0;
  const sampleSize = Math.min(batchSize, Math.max(1, Math.ceil(total * samplePct)));

  // Rotate the audited window across runs. Previously `.limit(sampleSize)` had
  // NO `.order()`, so Postgres returned an effectively-stable set and the same
  // rows were re-audited every week while the long tail was never verified.
  // Order deterministically by id and slide a weekly-rotating offset across the
  // population so, over enough runs, every archive eventually gets checked.
  const auditWindows = Math.max(1, Math.ceil(total / sampleSize));
  const weekIndex = Math.floor(Date.now() / (7 * 86400_000));
  const windowOffset = (weekIndex % auditWindows) * sampleSize;

  const { data: rows, error: queryErr } = await supabaseAdmin
    .from("hermes_instances")
    .select("id, archive_uri, archive_sha256, archive_size_bytes")
    .in("lifecycle_state", ["cold_archived", "pending_deletion"])
    .not("archive_uri", "is", null)
    .is("deleted_at", null)
    .order("id", { ascending: true })
    .range(windowOffset, windowOffset + sampleSize - 1);
  if (queryErr) return apiError(`sample query failed: ${queryErr.message}`, 500);

  const candidates = rows ?? [];
  const results = {
    total,
    sampleSize,
    succeeded: 0,
    failed: 0,
    perInstance: [] as Array<{ id: string; ok: boolean; reason?: string; message?: string }>,
  };

  for (const row of candidates) {
    let result: ColdVerifyResult;
    try {
      result = await verifyArchiveIntegrity(
        supabaseAdmin,
        row.id,
        { mode: "slice", hostSlug: auditHost }
      );
    } catch (err) {
      results.failed += 1;
      results.perInstance.push({
        id: row.id,
        ok: false,
        reason: "exception",
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (result.ok) {
      results.succeeded += 1;
      results.perInstance.push({ id: row.id, ok: true });
    } else {
      results.failed += 1;
      results.perInstance.push({
        id: row.id,
        ok: false,
        reason: result.reason,
        message: result.message,
      });
      log.warn("cold-storage audit found a problem", {
        source: LOG_SOURCE,
        failureType: "cold_audit_failed",
        instanceId: row.id,
        reason: result.reason,
        message: result.message,
        archiveUri: result.archiveUri,
      });
    }
  }

  log.info("cold-storage audit complete", {
    source: LOG_SOURCE,
    total,
    sampleSize,
    succeeded: results.succeeded,
    failed: results.failed,
  });

  // A corrupted/missing archive is a real incident: the doc says failures are
  // "for ops to page on", but previously they only emitted log.warn. Surface an
  // ops event when any sampled archive failed integrity verification, and report
  // an honest ok flag in the body. Best-effort.
  if (results.failed > 0) {
    await reportOpsEvent({
      source: "cron.cold_storage_audit_failed",
      severity: "error",
      title: `Cold-storage audit: ${results.failed} of ${results.sampleSize} archive(s) failed integrity`,
      message:
        `cold-storage-audit verified ${results.succeeded} and FAILED ${results.failed} of ${results.sampleSize} ` +
        `sampled archive(s) (population ${results.total}). A corrupted or missing cold archive means a ` +
        `tenant's data is unrecoverable — investigate the failed instances on the Storage Box.`,
      route: "/api/cron/cold-storage-audit",
      metadata: {
        total: results.total,
        sample_size: results.sampleSize,
        succeeded: results.succeeded,
        failed: results.failed,
        failed_instances: results.perInstance
          .filter((r) => !r.ok)
          .map((r) => ({ id: r.id, reason: r.reason })),
      },
    });
  }

  return apiSuccess({ ok: results.failed === 0, ...results });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
